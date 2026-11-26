/**
 * 硬盘 SMART：磁盘健康、温度、通电时间与挂载点使用率。
 */

import {
  api, action, badge, button, card, codeBlock, el, jsonView, note, spinner, stats, table, bytes,
} from '../ui.js';

const HEALTH_BADGE = {
  ok: { text: '健康', kind: 'ok' },
  fail: { text: '告警', kind: 'error' },
  unknown: { text: '未知', kind: 'default' },
};

function isAlert(disk) {
  return (
    disk.health === 'fail' ||
    (disk.reallocated !== null && Number(disk.reallocated) > 0) ||
    (disk.pending !== null && Number(disk.pending) > 0)
  );
}

function healthBadge(disk) {
  // 健康状态通过但已有重映射 / 待映射扇区时，同样按告警展示
  const key = isAlert(disk) ? 'fail' : (HEALTH_BADGE[disk.health] ? disk.health : 'unknown');
  return badge(HEALTH_BADGE[key].text, HEALTH_BADGE[key].kind);
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function diskRow(label, value, tone) {
  return el('div', { class: 'disk-row' },
    el('span', { text: label }),
    el('b', { text: value, style: tone ? { color: `var(--${tone})` } : undefined }));
}

function counterRow(label, value, tone) {
  const known = value !== null && value !== undefined && Number.isFinite(Number(value));
  return diskRow(label, known ? String(value) : '未知', known && Number(value) > 0 ? tone : undefined);
}

function formatHours(hours) {
  if (!Number.isFinite(hours)) return '未知';
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

function formatTemperature(temperature) {
  if (!Number.isFinite(temperature)) return '未知';
  return `${temperature} °C`;
}

function meterBar(percent, opts = {}) {
  const pct = clampPercent(percent);
  const tone = pct >= 90 ? ' danger' : pct >= 80 ? ' warn' : '';
  return el('div', {
    class: 'meter' + tone,
    style: opts.flex ? { flex: '1 1 80px' } : undefined,
  }, el('i', { style: { width: `${pct}%` } }));
}

/** 磁盘可能被分成多个分区挂载，优先匹配完全一致的设备，再按前缀匹配分区。 */
function mountFor(disk, mounts) {
  const device = String(disk.device || '');
  if (!device) return null;
  return (
    mounts.find((m) => m.device === device) ||
    mounts.find((m) => typeof m.device === 'string' && m.device.startsWith(device)) ||
    null
  );
}

function usageCell(percent) {
  const pct = clampPercent(percent);
  return el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
    meterBar(pct, { flex: true }),
    el('span', { class: 'small muted', text: `${pct}%` }));
}

/* ------------------------------------------------------------------ */
/* 磁盘卡片                                                            */
/* ------------------------------------------------------------------ */

function diskCard(disk, mounts) {
  const detail = el('div');
  const detailBtn = button('查看原始 SMART', () => action(detailBtn, async () => {
    detail.replaceChildren(spinner('正在读取详细 SMART 信息…'));
    try {
      const data = await api('/api/smart/detail', { device: disk.device });
      detail.replaceChildren(codeBlock(data.raw || '', {
        title: `${data.device} · smartctl -x`,
        filename: String(data.device).replace(/\//g, '_') + '-smart.txt',
      }));
    } catch (err) {
      detail.replaceChildren(note('读取详细 SMART 失败：' + err.message, 'error'));
      throw err;
    }
  }), { variant: 'ghost' });

  const hasSmart =
    disk.health !== 'unknown' ||
    Number.isFinite(disk.temperature) ||
    (Array.isArray(disk.attributes) && disk.attributes.length > 0);

  const children = [
    el('div', { class: 'disk-head' },
      el('div', {},
        el('div', { class: 'disk-name', text: disk.model ? `${disk.device} · ${disk.model}` : disk.device }),
        el('div', { class: 'disk-meta', text: disk.serial ? `序列号 ${disk.serial}` : '序列号未知' })),
      healthBadge(disk)),
    diskRow('容量', bytes(disk.size)),
    diskRow('温度', formatTemperature(disk.temperature),
      Number.isFinite(disk.temperature) && disk.temperature >= 55 ? 'danger'
        : Number.isFinite(disk.temperature) && disk.temperature >= 50 ? 'warn' : undefined),
    diskRow('通电时间', formatHours(disk.powerOnHours)),
    diskRow('类型', disk.rotational === true ? '机械硬盘（HDD）'
      : disk.rotational === false ? '固态硬盘（SSD）' : '未知'),
    disk.wearLevel !== null && disk.wearLevel !== undefined
      ? diskRow('磨损指标', String(disk.wearLevel))
      : null,
    counterRow('重映射扇区', disk.reallocated, 'danger'),
    counterRow('待映射扇区', disk.pending, 'danger'),
    counterRow('CRC 错误数', disk.crcErrors, 'warn'),
  ];

  // 磁盘本身容量无法反映使用情况，改为展示匹配到的挂载点使用率；匹配不到就不显示
  const mount = mountFor(disk, mounts);
  if (mount) {
    const pct = clampPercent(mount.usePercent);
    children.push(
      el('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
        el('div', { class: 'disk-row' },
          el('span', { text: `挂载点 ${mount.mountpoint}` }),
          el('b', { text: `${pct}%` })),
        meterBar(pct)));
  }

  // 读不到 SMART 时不再放一个必然报错的按钮，改成一句可执行的提示
  if (hasSmart) {
    children.push(detailBtn, detail);
  } else {
    children.push(el('div', {
      class: 'hint',
      text: disk.smartMessage
        || (disk.smartError === 'permission'
          ? '应用用户无权读取该磁盘的 SMART 详情'
          : '安装 smartmontools，并把应用用户加入 disk 组后可读取'),
    }));
  }
  return el('div', { class: 'disk' }, ...children);
}

function smartGuide(data) {
  if (!data.supported) return null;

  if (data.smartError === 'permission') {
    return card('开启 SMART 读取：权限不足', '已找到 smartctl，但应用用户读不了磁盘设备',
      note(data.hint, 'warn'),
      data.smartMessage ? el('p', { class: 'hint', text: 'smartctl 返回：' + data.smartMessage }) : null,
      codeBlock('sudo usermod -aG disk shuaishuainas\n# 然后在应用中心：停用 → 启用', { title: 'SSH 命令' }),
      el('p', { class: 'hint', text: '1.0.3 安装时已自动申请 disk 组；如果刚升级完还不行，多半是组权限未生效，重启应用即可。' })
    );
  }

  if (!data.smartctl) {
    return card('开启 SMART 读取：缺少 smartmontools', '安装后即可读取温度、通电时间与健康状态',
      note(data.hint, 'warn'),
      codeBlock('sudo apt update\nsudo apt install -y smartmontools\nsudo smartctl -H /dev/sda', { title: 'SSH 命令' }),
      el('p', { class: 'hint', text: '安装后无需重装应用，点「刷新」即可。Docker 部署请改用 --privileged 并挂载 /dev。' })
    );
  }

  if (data.smartError === 'other') {
    return card('部分磁盘无法读取 SMART', '常见于 USB 硬盘盒或 RAID 卡后面的磁盘',
      note('smartctl 能运行，但没有返回健康数据。', 'warn'),
      data.smartMessage ? codeBlock(data.smartMessage, { title: 'smartctl 返回信息' }) : null,
      el('p', { class: 'hint', text: '这通常是硬件/桥接芯片限制，不影响容量、序列号与挂载点信息。' })
    );
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* 页面内容                                                            */
/* ------------------------------------------------------------------ */

function overviewNodes(data) {
  const nodes = [];
  const disks = Array.isArray(data.disks) ? data.disks : [];
  const mounts = Array.isArray(data.mounts) ? data.mounts : [];

  if (!data.supported) {
    nodes.push(note(data.hint || `SMART 读取仅支持 Linux / fnOS，当前为 ${data.platform}。`, 'warn'));
    nodes.push(note('当前平台无法读取磁盘与挂载点信息，功能在 fnOS / Linux 上可用。'));
    return nodes;
  }

  const guide = smartGuide(data);
  if (guide) nodes.push(guide);

  if (disks.length === 0) {
    nodes.push(note(data.hint || '未发现可读取的磁盘设备。Docker 部署请确认已挂载 /dev 与 /sys。'));
  } else {
    const alerts = disks.filter(isAlert).length;
    const temps = disks.map((d) => d.temperature).filter((t) => Number.isFinite(t));
    const totalSize = disks.reduce((sum, d) => sum + (Number.isFinite(d.size) ? d.size : 0), 0);
    const hdd = disks.filter((d) => d.rotational === true).length;
    const ssd = disks.filter((d) => d.rotational === false).length;

    nodes.push(stats([
      { label: '磁盘数量', value: disks.length, sub: `${hdd} 机械 / ${ssd} 固态` },
      { label: '告警磁盘', value: alerts, sub: alerts > 0 ? '需要关注' : '暂无异常' },
      {
        label: '最高温度',
        value: temps.length ? `${Math.max(...temps)} °C` : '-',
        sub: temps.length ? '当前温度' : '未读取到温度',
      },
      { label: '总容量', value: bytes(totalSize), sub: '所有磁盘合计' },
    ]));

    nodes.push(card('磁盘健康', '健康状态、温度与关键 SMART 指标',
      el('div', { class: 'disk-grid' }, ...disks.map((disk) => diskCard(disk, mounts)))));
  }

  if (mounts.length === 0) {
    nodes.push(note('未读取到真实块设备的挂载点信息。'));
  } else {
    nodes.push(card('挂载点', `共 ${mounts.length} 个真实块设备挂载`,
      table(
        [
          { key: 'device', label: '设备', render: (m) => el('span', { class: 'mono small', text: m.device }) },
          { key: 'mountpoint', label: '挂载点', render: (m) => el('span', { class: 'mono small', text: m.mountpoint }) },
          { key: 'fstype', label: '文件系统', width: '110px', render: (m) => m.fstype || '未知' },
          { key: 'usage', label: '已用 / 总量', render: (m) => `${bytes(m.used)} / ${bytes(m.size)}` },
          { key: 'usePercent', label: '使用率', width: '180px', render: (m) => usageCell(m.usePercent) },
        ],
        mounts
      )));
  }

  return nodes;
}

export async function render(root) {
  const body = el('div');
  const diagOut = el('div');
  const refreshBtn = button('刷新', () => action(refreshBtn, load));
  const diagBtn = button('运行 SMART 诊断', () => action(diagBtn, async () => {
    diagOut.replaceChildren(spinner('正在收集诊断信息…'));
    const data = await api('/api/smart/diagnose');
    diagOut.replaceChildren(
      card('SMART 诊断结果', '把这段内容发给开发者，可以精确定位是权限、版本还是设备问题',
        jsonView(data))
    );
  }), { variant: 'ghost' });

  async function load() {
    body.replaceChildren(spinner('正在读取磁盘信息…'));
    try {
      const data = await api('/api/smart/overview');
      body.replaceChildren(...overviewNodes(data));
    } catch (err) {
      body.replaceChildren(note('读取磁盘信息失败：' + err.message, 'error'));
      throw err;
    }
  }

  root.appendChild(note(
    'SMART 需要读取宿主机硬盘设备：fnOS 原生安装需装 smartmontools 并让应用用户加入 disk 组；Docker 部署请加 --privileged 并挂载 /dev。'
  ));
  root.appendChild(note('温度与健康状态仅供参考，重要数据请做备份。', 'warn'));
  root.appendChild(el('div', { class: 'form-actions' }, refreshBtn, diagBtn));
  root.appendChild(body);
  root.appendChild(diagOut);

  // 首次进入自动加载；错误已经渲染在页面内，这里不再重复 toast
  await load().catch(() => {});
}
