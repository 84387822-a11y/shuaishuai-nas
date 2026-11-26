'use strict';

/**
 * 运行状态：从 /proc 与 /sys 采集 CPU、内存、网络、磁盘 IO 与磁盘信息。
 *
 * 设计要点：
 * - 两次请求之间做差分算速率，前端每 3 秒轮询一次即可；
 * - 只读采集，不需要 root，也不依赖 smartctl（磁盘温度读不到时显示空）；
 * - 非 Linux 平台返回降级数据，方便本地开发与排错。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findBin, run, DATA_DIR, str, HttpError } = require('../lib/util');

const SYS_BLOCK = '/sys/block';
const SKIP_PREFIX = ['loop', 'ram', 'dm-', 'md', 'sr', 'zram', 'nbd'];

let previous = null;

function readFile(file, max = 65536) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.length > max ? text.slice(0, max) : text;
  } catch {
    return '';
  }
}

function now() {
  return Date.now();
}

/* ------------------------------------------------------------------ */
/* 采集                                                                */
/* ------------------------------------------------------------------ */

function cpuSnapshot() {
  const stat = readFile('/proc/stat', 4096);
  if (stat) {
    const line = stat.split('\n').find((l) => l.startsWith('cpu '));
    if (line) {
      const parts = line.trim().split(/\s+/).slice(1).map(Number);
      const idle = (parts[3] || 0) + (parts[4] || 0);
      const total = parts.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
      return { idle, total };
    }
  }

  // 非 Linux：用 os.cpus() 的累计时间做同样的差分
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function memSnapshot() {
  const meminfo = readFile('/proc/meminfo', 8192);
  if (meminfo) {
    const map = {};
    for (const line of meminfo.split('\n')) {
      const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
      if (m) map[m[1]] = Number(m[2]) * 1024;
    }
    const total = map.MemTotal || 0;
    const available = map.MemAvailable !== undefined ? map.MemAvailable : map.MemFree || 0;
    return {
      total,
      available,
      used: Math.max(0, total - available),
      percent: total > 0 ? Math.round(((total - available) / total) * 100) : 0,
      swapTotal: map.SwapTotal || 0,
      swapUsed: Math.max(0, (map.SwapTotal || 0) - (map.SwapFree || 0)),
    };
  }

  const total = os.totalmem();
  const free = os.freemem();
  return {
    total,
    available: free,
    used: total - free,
    percent: total > 0 ? Math.round(((total - free) / total) * 100) : 0,
    swapTotal: 0,
    swapUsed: 0,
  };
}

function netSnapshot() {
  const dev = readFile('/proc/net/dev', 16384);
  const result = {};
  if (!dev) return result;

  for (const line of dev.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    const fields = line.slice(idx + 1).trim().split(/\s+/).map(Number);
    if (fields.length < 16) continue;
    result[name] = { rx: fields[0] || 0, tx: fields[8] || 0 };
  }
  return result;
}

function diskSnapshot() {
  const stats = readFile('/proc/diskstats', 32768);
  const result = {};
  if (!stats) return result;

  for (const line of stats.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 14) continue;
    const name = fields[2];
    if (!/^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|hd[a-z]+)$/.test(name)) continue;
    result[name] = {
      readBytes: (Number(fields[5]) || 0) * 512,
      writeBytes: (Number(fields[9]) || 0) * 512,
      ioMs: Number(fields[12]) || 0,
    };
  }
  return result;
}

function blockDevices() {
  let names = [];
  try {
    names = fs.readdirSync(SYS_BLOCK);
  } catch {
    return [];
  }
  return names.filter((name) => !SKIP_PREFIX.some((p) => name.startsWith(p)));
}

function readText(file) {
  return readFile(file, 512).trim();
}

/** 磁盘温度：只走 sysfs，读不到就返回 null（不调用 smartctl，避免拖慢轮询）。 */
function diskTemperature(name) {
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
      const milli = Number(readText(path.join(base, entry, 'temp1_input')));
      if (Number.isFinite(milli) && milli > 0) return Math.round(milli / 1000);
    }
  }
  return null;
}

/** CPU 温度：coretemp / k10temp / zenpower / thermal_zone 都试一遍。 */
function cpuTemperature() {
  let candidates = [];
  try {
    candidates = fs.readdirSync('/sys/class/hwmon');
  } catch {
    /* ignore */
  }
  for (const hw of candidates) {
    const name = readText(`/sys/class/hwmon/${hw}/name`).toLowerCase();
    if (!/coretemp|k10temp|zenpower|cpu|soc|package/.test(name)) continue;
    const milli = Number(readText(`/sys/class/hwmon/${hw}/temp1_input`));
    if (Number.isFinite(milli) && milli > 0 && milli < 150000) return Math.round(milli / 1000);
  }

  let zones = [];
  try {
    zones = fs.readdirSync('/sys/class/thermal');
  } catch {
    /* ignore */
  }
  for (const zone of zones) {
    if (!/^thermal_zone/.test(zone)) continue;
    const type = readText(`/sys/class/thermal/${zone}/type`).toLowerCase();
    if (!/x86_pkg_temp|cpu|soc/.test(type)) continue;
    const milli = Number(readText(`/sys/class/thermal/${zone}/temp`));
    if (Number.isFinite(milli) && milli > 0 && milli < 150000) return Math.round(milli / 1000);
  }
  return null;
}

/** CPU 型号：/proc/cpuinfo 的 model name。 */
function cpuModel() {
  const info = readFile('/proc/cpuinfo', 65536);
  const hit = /model name\s*:\s*(.+)/.exec(info);
  return hit ? hit[1].trim() : '';
}

/** 风扇转速：/sys/class/hwmon 下各 hwmon 的 fanN_input。 */
function fans() {
  const out = [];
  let hwmons = [];
  try {
    hwmons = fs.readdirSync('/sys/class/hwmon');
  } catch {
    return out;
  }
  for (const hw of hwmons) {
    const base = `/sys/class/hwmon/${hw}`;
    let entries = [];
    try {
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    const chip = readText(`${base}/name`) || hw;
    for (const name of entries) {
      if (!/^fan\d+_input$/.test(name)) continue;
      const rpm = Number(readText(`${base}/${name}`));
      if (!Number.isFinite(rpm) || rpm <= 0) continue;
      const label = readText(`${base}/${name.replace('_input', '_label')}`) || `${chip} 风扇`;
      out.push({ label, rpm });
    }
  }
  return out;
}

/** 存储池：按挂载点汇总容量（排除系统目录）。 */
function storagePools(mountList) {
  const seen = new Set();
  const out = [];
  for (const m of mountList) {
    if (/^\/(boot|var|tmp|run|sys|proc|dev|etc|snap)/.test(m.mountpoint)) continue;
    if (seen.has(m.device)) continue;
    let stat;
    try {
      stat = fs.statfsSync(m.mountpoint);
    } catch {
      continue;
    }
    const total = stat.blocks * stat.bsize;
    if (!Number.isFinite(total) || total <= 0) continue;
    const free = stat.bavail * stat.bsize;
    const used = Math.max(0, total - free);
    seen.add(m.device);
    out.push({
      device: m.device,
      mountpoint: m.mountpoint,
      fstype: m.fstype,
      size: total,
      used,
      free,
      percent: Math.min(100, Math.round((used / total) * 100)),
    });
  }
  return out;
}

/** Docker 容器状态（单独接口，避免拖慢 2 秒轮询）。 */
async function dockerContainers() {
  const bin = findBin('docker');
  if (!bin) return { available: false, total: 0, running: 0, items: [], error: '未找到 docker 命令' };

  const result = await run(bin, ['ps', '-a', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}'], { timeout: 5000 });
  if (result.code !== 0) {
    return {
      available: false,
      total: 0,
      running: 0,
      items: [],
      error: (result.stderr || result.stdout || '无法连接 Docker').trim().split('\n')[0],
    };
  }

  const items = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = '', image = '', status = ''] = line.split('\t');
      return { name, image, status, running: /up/i.test(status) };
    });

  return { available: true, total: items.length, running: items.filter((i) => i.running).length, items };
}

function mounts() {
  const text = readFile('/proc/mounts', 65536);
  const out = [];
  if (!text) return out;
  for (const line of text.split('\n')) {
    const fields = line.split(/\s+/);
    if (fields.length < 3) continue;
    if (!fields[0].startsWith('/dev/')) continue;
    out.push({ device: fields[0], mountpoint: fields[1], fstype: fields[2] });
  }
  return out;
}

function usageFor(device, mountList) {
  const hit =
    mountList.find((m) => m.device === device) ||
    mountList.find((m) => m.device.startsWith(device));
  if (!hit) return null;
  try {
    const st = fs.statfsSync(hit.mountpoint);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    if (total <= 0) return null;
    const used = Math.max(0, total - free);
    return {
      mountpoint: hit.mountpoint,
      fstype: hit.fstype,
      size: total,
      used,
      percent: Math.min(100, Math.round((used / total) * 100)),
    };
  } catch {
    return null;
  }
}

function diskList(mountList) {
  return blockDevices().map((name) => {
    const dir = path.join(SYS_BLOCK, name);
    const sectors = Number(readText(path.join(dir, 'size')));
    const rotational = readText(path.join(dir, 'queue', 'rotational'));
    const usage = usageFor(`/dev/${name}`, mountList);
    return {
      device: `/dev/${name}`,
      model: readText(path.join(dir, 'device', 'model')) || readText(path.join(dir, 'device', 'vendor')),
      size: Number.isFinite(sectors) ? sectors * 512 : 0,
      rotational: rotational === '' ? null : rotational === '1',
      temperature: diskTemperature(name),
      usage,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 差分与接口                                                          */
/* ------------------------------------------------------------------ */

function diffRate(current, prior, key, dt) {
  if (!prior || !current[key] || !prior[key]) return null;
  const delta = current[key] - prior[key];
  if (!Number.isFinite(delta) || delta < 0) return null;
  return Math.round(delta / dt);
}

async function status() {
  const ts = now();
  const cpu = cpuSnapshot();
  const mem = memSnapshot();
  const net = netSnapshot();
  const disk = diskSnapshot();
  const mountList = mounts();
  const disks = diskList(mountList);

  const dt = previous ? Math.max(0.2, (ts - previous.ts) / 1000) : 0;
  const rates = {
    sampleMs: previous ? ts - previous.ts : 0,
    cpu: null,
    net: null,
    netInterfaces: [],
    diskIo: null,
    diskDevices: [],
  };

  if (previous && dt > 0) {
    const totalDelta = cpu.total - previous.cpu.total;
    const idleDelta = cpu.idle - previous.cpu.idle;
    if (totalDelta > 0) {
      rates.cpu = Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
    }

    let rx = 0;
    let tx = 0;
    for (const [name, value] of Object.entries(net)) {
      const prior = previous.net[name];
      if (!prior) continue;
      const r = diffRate(value, prior, 'rx', dt);
      const t = diffRate(value, prior, 'tx', dt);
      if (r !== null) rx += r;
      if (t !== null) tx += t;
      if (name !== 'lo' && (r !== null || t !== null)) {
        rates.netInterfaces.push({ name, rx: r || 0, tx: t || 0 });
      }
    }
    rates.net = { rx, tx };
    rates.netInterfaces.sort((a, b) => b.rx - a.rx);

    let readRate = 0;
    let writeRate = 0;
    for (const [name, value] of Object.entries(disk)) {
      const prior = previous.disk[name];
      if (!prior) continue;
      const r = diffRate(value, prior, 'readBytes', dt);
      const w = diffRate(value, prior, 'writeBytes', dt);
      const busy = prior.ioMs !== undefined
        ? Math.max(0, Math.min(100, Math.round(((value.ioMs - prior.ioMs) / (dt * 1000)) * 100)))
        : null;
      if (r !== null) readRate += r;
      if (w !== null) writeRate += w;
      rates.diskDevices.push({ name: `/dev/${name}`, read: r || 0, write: w || 0, busy });
    }
    rates.diskIo = { read: readRate, write: writeRate };
  }

  previous = { ts, cpu, net, disk };

  // 主 IP：第一个非内网回环的 IPv4
  let primaryIp = '';
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const item of list || []) {
        if (item.family === 'IPv4' && !item.internal) {
          primaryIp = item.address;
          break;
        }
      }
      if (primaryIp) break;
    }
  } catch {
    /* ignore */
  }

  return {
    supported: process.platform === 'linux',
    platform: process.platform,
    hostname: os.hostname(),
    uptime: os.uptime(),
    load: os.loadavg(),
    cores: os.cpus().length,
    cpuModel: cpuModel(),
    primaryIp,
    memory: mem,
    cpuTemp: process.platform === 'linux' ? cpuTemperature() : null,
    fans: process.platform === 'linux' ? fans() : [],
    pools: storagePools(mountList),
    cpu: rates.cpu,
    net: rates.net,
    netInterfaces: rates.netInterfaces,
    diskIo: rates.diskIo,
    diskDevices: rates.diskDevices,
    disks,
    sampleMs: rates.sampleMs,
    ts,
    hint:
      process.platform === 'linux'
        ? ''
        : '当前不是 Linux，网络与磁盘速率不可用；请以 fnOS 上的实际数据为准。',
  };
}

async function docker() {
  return dockerContainers();
}

/* ------------------------------------------------------------------ */
/* 天气（Open-Meteo，免费无 key）                                       */
/* ------------------------------------------------------------------ */

const WEATHER_CONFIG = path.join(DATA_DIR, 'weather.json');
const WEATHER_TTL = 10 * 60 * 1000; // 缓存 10 分钟，避免高频调外部接口
const WEATHER_TIMEOUT = 12000; // 外网接口连接较慢时也能容忍
const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
let weatherCache = { ts: 0, data: null };

/** WMO 天气码 → 中文天气描述。 */
function wmoText(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return '未知';
  if (n === 0 || n === 1) return '晴';
  if (n === 2) return '多云';
  if (n === 3) return '阴';
  if (n === 45 || n === 48) return '雾';
  if (n === 51 || n === 53 || n === 55) return '毛毛雨';
  if (n === 56 || n === 57) return '冻毛毛雨';
  if (n === 61) return '小雨';
  if (n === 63) return '中雨';
  if (n === 65) return '大雨';
  if (n === 66 || n === 67) return '冻雨';
  if (n === 71) return '小雪';
  if (n === 73) return '中雪';
  if (n === 75) return '大雪';
  if (n === 77) return '雪粒';
  if (n >= 80 && n <= 82) return '阵雨';
  if (n === 85 || n === 86) return '阵雪';
  if (n === 95) return '雷暴';
  if (n === 96 || n === 99) return '雷暴伴冰雹';
  return '其他';
}

function loadWeatherConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(WEATHER_CONFIG, 'utf8'));
    if (cfg && Number.isFinite(cfg.latitude) && Number.isFinite(cfg.longitude)) return cfg;
    return null;
  } catch {
    return null;
  }
}

function saveWeatherConfig(cfg) {
  try {
    fs.writeFileSync(WEATHER_CONFIG, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {
    /* 写失败只影响持久化，本次运行仍可用 */
  }
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'ShuaiShuaiNAS-Monitor/1.0' },
    });
    if (!res.ok) throw new Error(`天气服务返回 HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    throw new Error('天气服务请求失败');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * wttr.in（WorldWeatherOnline 码）→ 我们前端使用的 WMO 码 + 中文描述。
 * 国内网络常无法访问 api.open-meteo.com，但 wttr.in 通常可用，作为备用源。
 */
const WWO_WMO = {
  113: [0, '晴'], 116: [2, '多云'], 119: [3, '阴'], 122: [3, '阴'], 143: [45, '薄雾'],
  149: [45, '烟霾'], 176: [51, '可能有阵雨'], 179: [71, '可能有阵雪'], 182: [66, '可能有雨夹雪'],
  185: [56, '可能有冻毛毛雨'], 200: [95, '可能有雷暴'], 227: [71, '扬雪'], 230: [75, '暴风雪'],
  248: [45, '雾'], 260: [48, '冻雾'], 263: [51, '零星小雨'], 266: [53, '小雨'], 281: [56, '冻毛毛雨'],
  284: [57, '强冻毛毛雨'], 293: [61, '零星小雨'], 296: [61, '小雨'], 299: [63, '间歇中雨'],
  302: [63, '中雨'], 305: [65, '间歇大雨'], 308: [65, '大雨'], 311: [66, '小冻雨'], 314: [67, '冻雨'],
  317: [66, '小雨夹雪'], 320: [67, '雨夹雪'], 323: [71, '零星小雪'], 326: [71, '小雪'],
  329: [73, '零星中雪'], 332: [73, '中雪'], 335: [75, '零星大雪'], 338: [75, '大雪'],
  350: [77, '冰粒'], 353: [80, '小阵雨'], 356: [81, '中到大阵雨'], 359: [82, '暴雨'],
  362: [85, '小阵雨夹雪'], 365: [86, '中到大雨夹雪'], 368: [85, '小阵雪'], 371: [86, '中到大阵雪'],
  374: [77, '小冰粒'], 377: [77, '中到大冰粒'], 386: [95, '雷阵雨'], 389: [95, '强雷阵雨'],
  392: [95, '雷阵雪'], 395: [95, '强雷阵雪'],
};

function wwoInfo(code) {
  const hit = WWO_WMO[Number(code)];
  return hit ? { wmo: hit[0], text: hit[1] } : { wmo: 3, text: '阴' };
}

/** 备用源：wttr.in（按经纬度取，避免城市名歧义）。 */
async function fetchWttr(config) {
  const url = `https://wttr.in/${config.latitude},${config.longitude}?format=j1`;
  const j = await fetchJson(url, WEATHER_TIMEOUT);
  const c = (j.current_condition && j.current_condition[0]) || {};
  const cur = wwoInfo(c.weatherCode);

  const days = (Array.isArray(j.weather) ? j.weather : []).slice(0, 3).map((d) => {
    const hourly = Array.isArray(d.hourly) ? d.hourly : [];
    const pick = hourly[4] || hourly[0] || {};
    const info = wwoInfo(pick.weatherCode);
    return {
      date: d.date || '',
      condition: info.text,
      code: info.wmo,
      tempMax: Number.isFinite(Number(d.maxtempC)) ? Math.round(Number(d.maxtempC)) : null,
      tempMin: Number.isFinite(Number(d.mintempC)) ? Math.round(Number(d.mintempC)) : null,
    };
  });

  return {
    city: config.city,
    condition: cur.text,
    code: cur.wmo,
    temperature: Number.isFinite(Number(c.temp_C)) ? Number(c.temp_C) : null,
    feelsLike: Number.isFinite(Number(c.FeelsLikeC)) ? Number(c.FeelsLikeC) : null,
    humidity: Number.isFinite(Number(c.humidity)) ? Number(c.humidity) : null,
    windSpeed: Number.isFinite(Number(c.windspeedKmph)) ? Number(c.windspeedKmph) : null,
    unit: '°C',
    days,
    updatedAt: new Date().toISOString(),
  };
}

/** 只取当前天气 + 未来 3 天预报，字段精简。 */
function toWeatherOut(forecast, city) {
  const c = (forecast && forecast.current) || {};
  const code = c.weather_code;
  const temperature = Number.isFinite(Number(c.temperature_2m)) ? Number(c.temperature_2m) : null;
  const feelsLike = Number.isFinite(Number(c.apparent_temperature)) ? Number(c.apparent_temperature) : null;

  // 3 天预报：今天 / 明天 / 后天
  const d = (forecast && forecast.daily) || {};
  const dates = Array.isArray(d.time) ? d.time : [];
  const maxT = Array.isArray(d.temperature_2m_max) ? d.temperature_2m_max : [];
  const minT = Array.isArray(d.temperature_2m_min) ? d.temperature_2m_min : [];
  const wcodes = Array.isArray(d.weather_code) ? d.weather_code : [];
  const days = [];
  for (let i = 0; i < Math.min(3, dates.length); i += 1) {
    days.push({
      date: dates[i] || '',
      condition: wmoText(wcodes[i]),
      code: Number(wcodes[i]),
      tempMax: Number.isFinite(Number(maxT[i])) ? Math.round(Number(maxT[i])) : null,
      tempMin: Number.isFinite(Number(minT[i])) ? Math.round(Number(minT[i])) : null,
    });
  }

  return {
    city,
    condition: wmoText(code),
    code: Number(code),
    temperature,
    feelsLike,
    humidity: Number.isFinite(Number(c.relative_humidity_2m)) ? Number(c.relative_humidity_2m) : null,
    windSpeed: Number.isFinite(Number(c.wind_speed_10m)) ? Number(c.wind_speed_10m) : null,
    unit: (forecast && forecast.current_units && forecast.current_units.temperature_2m) || '°C',
    days,
    updatedAt: new Date().toISOString(),
  };
}

async function weatherStatus(ctx, saveCity) {
  // 保存城市：先地理编码得到经纬度，再立即拉一次天气
  if (saveCity !== undefined && saveCity !== null && saveCity !== '') {
    const city = str(saveCity, '城市', { max: 64 });
    const geo = await fetchJson(
      `${GEO_URL}?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`,
      WEATHER_TIMEOUT
    );
    const hit = geo && geo.results && geo.results[0];
    if (!hit) throw new HttpError(404, `找不到城市：${city}，请换个更常见的城市名`);
    const cfg = {
      city: hit.name,
      country: hit.country_code || '',
      latitude: hit.latitude,
      longitude: hit.longitude,
    };
    saveWeatherConfig(cfg);
    weatherCache = { ts: 0, data: null }; // 强制重新拉取
    return { enabled: true, set: true, message: `已设置为 ${cfg.city}`, ...(await loadWeather()) };
  }

  const cfg = loadWeatherConfig();
  if (!cfg) {
    return { enabled: false, error: '未配置天气城市', hint: '在监控页填城市名并保存即可', cached: 0 };
  }

  const now = Date.now();
  if (weatherCache.data && weatherCache.ts && now - weatherCache.ts < WEATHER_TTL) {
    return { enabled: true, ...weatherCache.data, source: 'cache' };
  }

  return { enabled: true, ...(await loadWeather(cfg)) };
}

async function loadWeather(cfg) {
  const config = cfg || loadWeatherConfig();
  if (!config) return { error: '未配置天气城市', cached: 0 };

  // 允许强制指定数据源：SS_WEATHER_PROVIDER=wttr 时跳过 Open-Meteo
  if (String(process.env.SS_WEATHER_PROVIDER || '').toLowerCase() === 'wttr') {
    try {
      const out = await fetchWttr(config);
      weatherCache = { ts: Date.now(), data: out };
      return { ...out, source: 'wttr' };
    } catch {
      return { error: '天气获取失败（wttr.in 不可达，请检查外网）', cached: Date.now() - weatherCache.ts };
    }
  }

  // 主源：Open-Meteo（海外/可访问环境）
  try {
    const url =
      `${FORECAST_URL}?latitude=${config.latitude}&longitude=${config.longitude}` +
      `&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m,apparent_temperature` +
      `&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=3`;
    const forecast = await fetchJson(url, WEATHER_TIMEOUT);
    const out = toWeatherOut(forecast, config.city);
    weatherCache = { ts: Date.now(), data: out };
    return { ...out, source: 'fresh' };
  } catch (err) {
    // 备用源：wttr.in（国内网络通常可访问）
    try {
      const out = await fetchWttr(config);
      weatherCache = { ts: Date.now(), data: out };
      return { ...out, source: 'wttr' };
    } catch (err2) {
      return {
        error: '天气获取失败（Open-Meteo 与备用源 wttr.in 均不可达，请检查外网）',
        cached: Date.now() - weatherCache.ts,
      };
    }
  }
}

module.exports = [
  ['GET', '/api/monitor', status],
  ['GET', '/api/monitor/docker', docker],
  ['GET', '/api/monitor/weather', weatherStatus],
  ['POST', '/api/monitor/weather', (ctx) => weatherStatus(ctx, ctx.body && ctx.body.city)],
];
