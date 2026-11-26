'use strict';

/**
 * 硬盘 SMART：从 Linux sysfs 读取磁盘基础信息，再用 smartctl 补充健康数据。
 *
 * 只做只读查询，不执行自检、不修改磁盘状态。
 * Docker 部署需要 --privileged 并挂载 /dev、/sys，否则只能拿到空结果。
 */

const fs = require('node:fs');
const path = require('node:path');

const { str, badRequest, run, findBin, HttpError } = require('../lib/util');

const SYS_BLOCK = '/sys/block';
const SMARTCTL_TIMEOUT = 8000;
const DETAIL_TIMEOUT = 20000;
const ATTRIBUTE_LIMIT = 12;
const MOUNT_LIMIT = 20;
const DETAIL_LIMIT = 100 * 1024;

// 虚拟 / 特殊块设备对硬盘健康没有参考价值，统一排除
const SKIP_PREFIX = ['loop', 'ram', 'dm-', 'md', 'sr', 'zram', 'nbd'];

const NO_SMARTCTL_HINT =
  '未找到 smartctl：磁盘基础信息仍可读取，但无法获取健康状态与 SMART 指标。' +
  'fnOS / Debian 可执行 sudo apt update && sudo apt install -y smartmontools 安装；' +
  'Docker 部署需加 --privileged 并挂载 /dev 与 /sys。';

const PERMISSION_HINT =
  '已找到 smartctl，但应用用户无权读取磁盘设备（/dev/sd* 通常只允许 root 或 disk 组）。' +
  '本版本安装时已申请加入 disk 组；若仍无权限，请 SSH 执行 sudo usermod -aG disk shuaishuainas，' +
  '然后在应用中心「停用 → 启用」一次。';

const NO_DEVICE_HINT =
  '未发现可读取的磁盘设备。Docker 部署请确认已挂载 /dev 与 /sys（-v /dev:/dev -v /sys:/sys）或使用 --privileged。';

/* ------------------------------------------------------------------ */
/* 基础读取                                                            */
/* ------------------------------------------------------------------ */

function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readSys(file, max) {
  const raw = readTextFile(file).trim();
  return raw.length > max ? raw.slice(0, max) : raw;
}

/** 统一转数字，非法值一律返回 null，方便前端显示「未知」。 */
function num(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function listBlockDevices() {
  let names;
  try {
    names = fs.readdirSync(SYS_BLOCK);
  } catch {
    // 未挂载 /sys 或权限不足时按「没有磁盘」处理
    return [];
  }
  return names.filter((name) => !SKIP_PREFIX.some((prefix) => name.startsWith(prefix)));
}

/** 温度兜底：部分设备在 hwmon 下暴露 temp1_input（毫摄氏度），不需要 smartctl。 */
function readTemperature(name) {
  const bases = [
    path.join(SYS_BLOCK, name, 'device', 'hwmon'),
    path.join(SYS_BLOCK, name, 'device', 'device', 'hwmon'),
  ];
  for (const base of bases) {
    let entries;
    try {
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const milli = num(readSys(path.join(base, entry, 'temp1_input'), 32));
      if (milli !== null) return Math.round(milli / 1000);
    }
  }
  return null;
}

/** 序列号兜底：ATA 在 device/serial，USB 桥接可能只有 wwid / vpd_pg80。 */
function readSerial(name) {
  const dir = path.join(SYS_BLOCK, name);
  const candidates = [
    path.join(dir, 'device', 'serial'),
    path.join(dir, 'serial'),
    path.join(dir, 'device', 'wwid'),
    path.join(dir, 'device', 'device', 'serial'),
  ];
  for (const file of candidates) {
    const value = readSys(file, 128).replace(/^t10\./i, '').replace(/\s+/g, ' ').trim();
    if (value) return value;
  }
  return null;
}

function baseDisk(name) {
  const dir = path.join(SYS_BLOCK, name);
  const deviceDir = path.join(dir, 'device');

  // sysfs 里的型号 / 序列号可能缺失（尤其是 USB 桥接），读不到就给空字符串
  const vendor = readSys(path.join(deviceDir, 'vendor'), 128);
  const model = readSys(path.join(deviceDir, 'model'), 128);
  const serial = readSerial(name);

  // /sys/block/<dev>/size 的单位固定是 512 字节扇区，与磁盘真实扇区大小无关
  const sectors = num(readSys(path.join(dir, 'size'), 32));
  const rotationalRaw = readSys(path.join(dir, 'queue', 'rotational'), 8);

  return {
    device: `/dev/${name}`,
    model: model || vendor,
    serial,
    size: sectors === null ? 0 : sectors * 512,
    // 1 为机械盘，0 为固态盘；部分设备没有该文件，返回 null 表示未知
    rotational: rotationalRaw === '' ? null : rotationalRaw === '1',
    health: 'unknown',
    temperature: readTemperature(name),
    powerOnHours: null,
    reallocated: null,
    pending: null,
    uncorrectable: null,
    crcErrors: null,
    wearLevel: null,
    attributes: [],
  };
}

/* ------------------------------------------------------------------ */
/* smartctl 解析                                                       */
/* ------------------------------------------------------------------ */

function parseSmartJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // 少数版本会在 JSON 前后混入提示文本，再尝试截取花括号区间
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function findAttribute(table, names, ids) {
  for (const attr of table) {
    if (!attr || typeof attr !== 'object') continue;
    if (names.includes(String(attr.name || ''))) return attr;
    if (ids.includes(num(attr.id))) return attr;
  }
  return null;
}

/** 取 SMART 属性的 raw.value（计数类指标都以 raw 为准）。 */
function rawOf(attr) {
  const value = attr?.raw?.value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function rawDisplay(attr) {
  const raw = attr?.raw;
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.value === 'number' && Number.isFinite(raw.value)) return raw.value;
  if (typeof raw.value === 'string' && raw.value.trim() !== '') return raw.value.trim();
  if (typeof raw.string === 'string' && raw.string.trim() !== '') return raw.string.trim();
  return null;
}

/** 把 smartctl JSON 归一化成固定字段，任何字段缺失都不抛错。 */
function smartFields(json) {
  const out = {
    health: 'unknown',
    temperature: null,
    powerOnHours: null,
    reallocated: null,
    pending: null,
    uncorrectable: null,
    crcErrors: null,
    wearLevel: null,
    attributes: [],
  };
  if (!json || typeof json !== 'object') return out;

  if (typeof json.smart_status?.passed === 'boolean') {
    out.health = json.smart_status.passed ? 'ok' : 'fail';
  }
  out.temperature = num(json.temperature?.current);
  out.powerOnHours = num(json.power_on_time?.hours);

  // NVMe 没有 ATA 属性表，相关字段可能整体缺失，只能逐项安全取值
  const nvme = json.nvme_smart_health_information_log;
  if (nvme && typeof nvme === 'object') {
    if (out.temperature === null) out.temperature = num(nvme?.temperature);
    if (out.powerOnHours === null) out.powerOnHours = num(nvme?.power_on_hours);
    if (out.wearLevel === null) out.wearLevel = num(nvme?.percentage_used);
    // NVMe 的 media_errors 语义最接近 ATA 的不可纠正错误
    if (out.uncorrectable === null) out.uncorrectable = num(nvme?.media_errors);
  }

  const table = json.ata_smart_attributes?.table;
  if (Array.isArray(table)) {
    out.attributes = table.slice(0, ATTRIBUTE_LIMIT).map((attr) => ({
      id: num(attr?.id),
      name: String(attr?.name || ''),
      value: num(attr?.value),
      worst: num(attr?.worst),
      threshold: num(attr?.thresh),
      raw: rawDisplay(attr),
    }));

    const reallocated = findAttribute(table, ['Reallocated_Sector_Ct'], [5]);
    const pending = findAttribute(table, ['Current_Pending_Sector'], [197]);
    const uncorrectable = findAttribute(table, ['Offline_Uncorrectable'], [198]);
    const crc = findAttribute(table, ['UDMA_CRC_Error_Count'], [199]);
    const wear = findAttribute(table, ['Media_Wearout_Indicators', 'Wear_Leveling_Count'], [233, 177]);

    if (reallocated) out.reallocated = rawOf(reallocated);
    if (pending) out.pending = rawOf(pending);
    if (uncorrectable) out.uncorrectable = rawOf(uncorrectable);
    if (crc) out.crcErrors = rawOf(crc);
    if (wear && out.wearLevel === null) {
      const rawWear = rawOf(wear);
      out.wearLevel = rawWear === null ? num(wear.value) : rawWear;
    }
  }

  return out;
}

/** 根据 stderr 判断失败原因，前端据此给出不同指引（缺工具 / 缺权限 / 其它）。 */
function classifySmartError(result) {
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  if (/permission denied|operation not permitted|access denied|must be root|requires root|i\/o error/i.test(text)) {
    return 'permission';
  }
  if (/not found|no such file|command not found/i.test(text) || result.code === -1) return 'missing';
  return 'other';
}

function smartMessages(json) {
  return (Array.isArray(json?.messages) ? json.messages : [])
    .map((item) => (item && typeof item.string === 'string' ? item.string.trim() : ''))
    .filter(Boolean)
    .slice(0, 3);
}

function hasSmartData(json) {
  return Boolean(
    json &&
      (json.smart_status !== undefined ||
        json.ata_smart_attributes !== undefined ||
        json.nvme_smart_health_information_log !== undefined ||
        (json.temperature && typeof json.temperature === 'object'))
  );
}

/** 取 SMART 文本表里某个属性 ID 的 raw 值（行末最后一个数字）。 */
function textAttribute(text, id) {
  const re = new RegExp(`^\\s*${id}\\s+\\S+.*?(-?\\d+)\\s*$`, 'm');
  const hit = re.exec(text);
  return hit ? Number(hit[1]) : null;
}

/**
 * 文本模式兜底：部分 fnOS / 老版本 smartctl 不支持 -j，
 * 或设备类型不返回 JSON，此时解析 `smartctl -a` 的纯文本。
 */
function parseSmartText(text) {
  if (!text || !/SMART|smartctl/i.test(text)) return null;
  if (/SMART support is:\s*Unavailable/i.test(text)) return null;

  const out = smartFields(null);
  let found = false;

  const health = /overall-health self-assessment test result:\s*(\w+)/i.exec(text);
  if (health) {
    out.health = /PASSED/i.test(health[1]) ? 'ok' : 'fail';
    found = true;
  }

  const temp = /(?:Current Drive Temperature|Temperature):\s*(\d+)\s*(?:Celsius|C\b)/i.exec(text);
  if (temp) {
    out.temperature = Number(temp[1]);
    found = true;
  }

  const hours = textAttribute(text, 9);
  if (hours !== null) {
    out.powerOnHours = hours;
    found = true;
  }

  const reallocated = textAttribute(text, 5);
  if (reallocated !== null) out.reallocated = reallocated;
  const pending = textAttribute(text, 197);
  if (pending !== null) out.pending = pending;
  const uncorrectable = textAttribute(text, 198);
  if (uncorrectable !== null) out.uncorrectable = uncorrectable;
  const crc = textAttribute(text, 199);
  if (crc !== null) out.crcErrors = crc;

  if (!found) return null;
  return out;
}

/**
 * smartctl -j 在有错误时仍会输出合法 JSON（例如 messages 里写 Permission denied），
 * 不能只凭「能解析 JSON」判断成功，否则页面会全是「未知」。
 */
function smartFailure(json) {
  if (!json || typeof json !== 'object') return null;

  if (hasSmartData(json)) return null;

  const messages = smartMessages(json);
  const exitStatus = num(json.smartctl?.exit_status);

  if (messages.some((m) => /permission|denied|operation not permitted|must be root/i.test(m))) {
    return 'permission';
  }
  // smartctl 退出码是位掩码：bit1(2) = 设备打开失败，通常是权限或设备不存在
  if (exitStatus !== null && (exitStatus & 2) === 2) return 'permission';
  return 'other';
}

async function readSmart(bin, device) {
  // 1) 优先 JSON（字段最全）
  const jsonRun = await run(bin, ['-a', '-j', device], { timeout: SMARTCTL_TIMEOUT });
  const parsed = parseSmartJson(jsonRun.stdout);
  if (parsed && hasSmartData(parsed)) {
    return { fields: smartFields(parsed), error: null, messages: smartMessages(parsed) };
  }

  // 2) 文本兜底：兼容不支持 -j 或只输出文本的设备
  const textRun = await run(bin, ['-a', device], { timeout: SMARTCTL_TIMEOUT });
  const textFields = parseSmartText(textRun.stdout);
  if (textFields) {
    return { fields: textFields, error: null, messages: [] };
  }

  // 3) 都失败：归类原因，并把 stderr 首行带给前端，避免只显示「未知」
  const stderr = `${jsonRun.stderr || ''}\n${textRun.stderr || ''}`;
  const messages = smartMessages(parsed);
  if (messages.length === 0) {
    const line = stderr.split('\n').map((s) => s.trim()).find(Boolean);
    if (line) messages.push(line.slice(0, 200));
  }

  const error =
    classifySmartError({ stderr, stdout: jsonRun.stdout, code: jsonRun.code }) ||
    (parsed ? smartFailure(parsed) : null) ||
    'other';

  return { fields: smartFields(null), error, messages };
}

/* ------------------------------------------------------------------ */
/* 挂载点                                                              */
/* ------------------------------------------------------------------ */

/** /proc/mounts 用八进制转义表示空格、制表符等字符。 */
function decodeMountField(value) {
  return value.replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
}

function isRealDevice(device) {
  if (!device.startsWith('/dev/')) return false;
  const name = device.slice('/dev/'.length);
  // 挂载点只排除明显不是存储的伪设备；md / dm 等 RAID、LVM 设备要保留，否则 NAS 上整块存储会消失
  return !['loop', 'ram', 'zram'].some((prefix) => name.startsWith(prefix));
}

async function readDfMounts() {
  const rows = [];
  const df = findBin('df');
  if (!df) return rows;

  const result = await run(df, ['-kP'], { timeout: 5000 });
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6) continue;
    const device = fields[0];
    if (!isRealDevice(device)) continue;
    // 挂载点可能包含空格，把第 6 列之后的内容整体还原
    rows.push({ device, mountpoint: decodeMountField(fields.slice(5).join(' ')), fstype: '' });
  }
  return rows;
}

async function readMounts() {
  let rows = [];
  const proc = readTextFile('/proc/mounts');

  if (proc) {
    for (const line of proc.split('\n')) {
      if (!line.trim()) continue;
      const fields = line.split(/\s+/);
      if (fields.length < 3) continue;
      const device = decodeMountField(fields[0]);
      if (!isRealDevice(device)) continue;
      rows.push({
        device,
        mountpoint: decodeMountField(fields[1]),
        fstype: decodeMountField(fields[2]),
      });
    }
  } else {
    rows = await readDfMounts();
  }

  // /proc/mounts 不带容量，统一用 statfs 计算，过滤掉容量为 0 的伪挂载
  const mounts = [];
  for (const row of rows) {
    let st;
    try {
      st = fs.statfsSync(row.mountpoint);
    } catch {
      continue;
    }
    const bsize = num(st.bsize);
    const blocks = num(st.blocks);
    const bfree = num(st.bfree);
    const bavail = num(st.bavail);
    if (bsize === null || blocks === null || bfree === null || bavail === null) continue;

    const size = blocks * bsize;
    if (size <= 0) continue;

    const used = Math.max(0, (blocks - bfree) * bsize);
    const available = Math.max(0, bavail * bsize);
    const total = used + available;
    const usePercent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;

    mounts.push({
      device: row.device,
      mountpoint: row.mountpoint,
      fstype: row.fstype,
      size,
      used,
      available,
      usePercent,
    });
    if (mounts.length >= MOUNT_LIMIT) break;
  }
  return mounts;
}

/* ------------------------------------------------------------------ */
/* 接口                                                                */
/* ------------------------------------------------------------------ */

async function overview() {
  const platform = process.platform;
  const smartctlBin = findBin('smartctl');

  if (platform !== 'linux') {
    return {
      supported: false,
      platform,
      smartctl: Boolean(smartctlBin),
      hint: `SMART 读取仅支持 Linux / fnOS，当前为 ${platform}。请在 fnOS 或挂载了 /dev 的 Linux 容器中使用。`,
      disks: [],
      mounts: [],
    };
  }

  const disks = [];
  const smartErrors = new Set();
  const smartMessagesAll = [];
  // 逐块读取，避免同时唤醒多块休眠中的机械盘
  for (const name of listBlockDevices()) {
    try {
      const disk = baseDisk(name);
      if (smartctlBin) {
        const result = await readSmart(smartctlBin, disk.device);
        Object.assign(disk, result.fields);
        if (result.error) {
          disk.smartError = result.error;
          smartErrors.add(result.error);
        }
        if (result.messages.length) {
          disk.smartMessage = result.messages.join('；');
          smartMessagesAll.push(disk.smartMessage);
        }
      } else {
        disk.smartError = 'missing';
      }
      disks.push(disk);
    } catch {
      // 单块磁盘读取失败时跳过，不影响其它磁盘
    }
  }

  const mounts = await readMounts();

  let smartError = null;
  if (!smartctlBin) smartError = 'missing';
  else if (smartErrors.has('permission')) smartError = 'permission';
  else if (smartErrors.has('other')) smartError = 'other';

  const hints = [];
  if (!smartctlBin) hints.push(NO_SMARTCTL_HINT);
  else if (smartError === 'permission') hints.push(PERMISSION_HINT);
  if (disks.length === 0) hints.push(NO_DEVICE_HINT);

  return {
    supported: true,
    platform,
    smartctl: Boolean(smartctlBin),
    smartError,
    smartMessage: smartMessagesAll.slice(0, 2).join('；'),
    hint: hints.join(' '),
    disks,
    mounts,
  };
}

async function detail(ctx) {
  const device = str(ctx.body.device, '设备名', { max: 64 });
  if (!/^\/dev\/[a-zA-Z0-9]+$/.test(device)) {
    throw badRequest('设备名不合法，应形如 /dev/sda 或 /dev/nvme0n1');
  }

  const bin = findBin('smartctl');
  if (!bin) throw badRequest('未安装 smartctl，无法读取详细 SMART 信息');

  const result = await run(bin, ['-x', device], {
    timeout: DETAIL_TIMEOUT,
    maxBuffer: 1024 * 1024,
  });

  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (!String(result.stdout || '').trim() && /permission denied|operation not permitted/i.test(combined)) {
    throw new HttpError(403, '应用用户无权读取该磁盘，请把应用用户加入 disk 组后重启应用');
  }

  // stdout 为空时用 stderr，方便用户看到权限不足等真实原因
  const raw = String(result.stdout || result.stderr || '').slice(0, DETAIL_LIMIT);
  if (!raw.trim()) {
    throw badRequest('smartctl 未返回内容，请检查设备是否存在，或容器是否挂载了 /dev');
  }

  return { device, raw };
}

/**
 * 诊断接口：把 smartctl 的版本、进程身份、设备权限和原始输出一次性给出来。
 * 用户不需要会 SSH，把页面上的结果发过来就能定位。
 */
async function diagnose() {
  const bin = findBin('smartctl');
  const result = {
    smartctl: bin,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    groups: typeof process.getgroups === 'function' ? process.getgroups() : [],
    version: '',
    disks: [],
  };

  if (bin) {
    const ver = await run(bin, ['--version'], { timeout: 5000 });
    result.version = (ver.stdout || ver.stderr).split('\n').slice(0, 3).join('\n');
  }

  for (const name of listBlockDevices()) {
    const device = `/dev/${name}`;
    const item = { device, mode: '', uid: null, gid: null, json: null, text: null };
    try {
      const st = fs.statSync(device);
      item.mode = '0' + (st.mode & 0o777).toString(8);
      item.uid = st.uid;
      item.gid = st.gid;
    } catch {
      /* 设备可能已移除 */
    }
    if (bin) {
      const jsonRun = await run(bin, ['-a', '-j', device], { timeout: 8000 });
      item.json = {
        code: jsonRun.code,
        stdout: jsonRun.stdout.slice(0, 1200),
        stderr: jsonRun.stderr.slice(0, 1200),
      };
      const textRun = await run(bin, ['-a', device], { timeout: 8000 });
      item.text = {
        code: textRun.code,
        stdout: textRun.stdout.slice(0, 1200),
        stderr: textRun.stderr.slice(0, 1200),
      };
    }
    result.disks.push(item);
  }

  return result;
}

module.exports = [
  ['GET', '/api/smart/overview', overview],
  ['POST', '/api/smart/detail', detail],
  ['GET', '/api/smart/diagnose', diagnose],
];
