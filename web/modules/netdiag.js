/**
 * 网络诊断：连通性、带宽测速、流量统计、路由追踪、局域网设备。
 * 全部为本机探测，不抓包、不改网络配置。
 */

import {
  action, api, badge, button, card, codeBlock, el, input, note, segmented, spinner, stats, table, tabs, toast,
} from '../ui.js';

const MAX_GAUGE = 1000; // 仪表盘满量程 Mbps

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(2) + ' GB';
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(1) + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}

/* ---------------- SVG 小部件 ---------------- */

function svgEl(name, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** 圆环仪表：0~MAX_GAUGE，返回 { node, set(pct) } */
function ringGauge(label) {
  const size = 220;
  const r = 92;
  const c = 2 * Math.PI * r;
  const svg = svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` });
  const bg = svgEl('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--border)', 'stroke-width': 14 });
  const fg = svgEl('circle', {
    cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 14,
    'stroke-linecap': 'round', transform: `rotate(-90 ${size / 2} ${size / 2})`,
    'stroke-dasharray': `0 ${c}`,
  });
  const text = svgEl('text', {
    x: size / 2, y: size / 2 + 6, 'text-anchor': 'middle', fill: 'var(--text)',
    style: 'font-size:26px;font-weight:700',
  });
  text.textContent = '—';
  const sub = svgEl('text', {
    x: size / 2, y: size / 2 + 30, 'text-anchor': 'middle', fill: 'var(--muted)',
    style: 'font-size:12px',
  });
  sub.textContent = label || 'Mbps';
  svg.append(bg, fg, text, sub);

  return {
    node: svg,
    set(mbps) {
      const v = Math.max(0, Number(mbps) || 0);
      const pct = Math.min(1, v / MAX_GAUGE);
      fg.setAttribute('stroke-dasharray', `${(c * pct).toFixed(2)} ${c}`);
      text.textContent = v ? v.toFixed(1) : '0';
    },
  };
}

/** 实时曲线：下行蓝、上行绿 */
function curveChart() {
  const w = 560;
  const h = 160;
  const svg = svgEl('svg', { width: '100%', height: h, viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none' });
  const grid = svgEl('g', { stroke: 'var(--border)', 'stroke-width': 1 });
  for (let i = 1; i <= 3; i += 1) {
    const y = (h / 4) * i;
    grid.appendChild(svgEl('line', { x1: 0, y1: y, x2: w, y2: y }));
  }
  const down = svgEl('polyline', { fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2 });
  const up = svgEl('polyline', { fill: 'none', stroke: 'var(--ok)', 'stroke-width': 2 });
  svg.append(grid, down, up);

  return {
    node: svg,
    set(samples) {
      const list = Array.isArray(samples) ? samples : [];
      if (list.length < 2) return;
      const yMax = Math.max(MAX_GAUGE / 10, ...list.map((s) => Math.max(s.down || 0, s.up || 0)));
      const px = (i) => (i / (list.length - 1)) * w;
      const py = (v) => h - (Math.min(yMax, v) / yMax) * (h - 8) - 4;
      down.setAttribute('points', list.map((s, i) => `${px(i).toFixed(1)},${py(s.down || 0).toFixed(1)}`).join(' '));
      up.setAttribute('points', list.map((s, i) => `${px(i).toFixed(1)},${py(s.up || 0).toFixed(1)}`).join(' '));
    },
  };
}

/* ---------------- 各标签页 ---------------- */

function connTab() {
  const box = el('div', { style: { display: 'grid', gap: '16px' } });
  const btn = button('开始检测', () => action(btn, run), { variant: 'primary' });
  const out = el('div', { style: { display: 'grid', gap: '12px' } });
  box.append(el('div', { class: 'form-actions' }, btn), note('检测常用站点：DNS 解析 + TCP 443 连接时延。', 'info'), out);

  async function run() {
    out.replaceChildren(spinner('正在检测…'));
    try {
      const d = await api('/api/netdiag/ping');
      out.replaceChildren(
        stats([
          { label: '可达', value: `${d.ok_count}/${d.total}`, sub: '个站点' },
          { label: '平均延迟', value: `${d.avg_ms} ms`, sub: '仅统计可达' },
        ]),
        table(
          [
            { label: '站点', key: 'name' },
            { label: '地址', key: 'host' },
            { label: 'IP', key: 'ip' },
            { label: '结果', render: (row) => (row.ok ? badge(row.ms + ' ms', 'ok') : badge(row.error || '不通', 'error')) },
          ],
          d.items || [],
          { empty: '没有数据' }
        )
      );
    } catch (err) {
      out.replaceChildren(note('检测失败：' + (err.message || err), 'error'));
    }
  }
  return box;
}

function speedTab() {
  const gauge = ringGauge('下行 Mbps');
  const curve = curveChart();
  const mode = { value: 'both' };
  const peek = el('div');
  const latencyRow = el('div', { class: 'row', style: { gap: '18px', flexWrap: 'wrap' } });

  const startBtn = button('开始测速', () => action(startBtn, start), { variant: 'primary' });
  const stopBtn = button('停止', () => action(stopBtn, stop), { variant: 'ghost' });

  const box = el('div', { style: { display: 'grid', gap: '16px' } },
    note('测速会消耗流量（约 100~200MB），使用公共测速端点，结果受线路影响。', 'warn'),
    el('div', { class: 'speed-panel' },
      el('div', { class: 'speed-left' },
        gauge.node,
        el('div', { class: 'speed-actions' }, startBtn, stopBtn),
        el('div', { class: 'speed-modes' },
          segmented(
            [{ value: 'both', label: '双向' }, { value: 'down', label: '仅下行' }, { value: 'up', label: '仅上行' }],
            mode.value,
            (v) => { mode.value = v; }
          ))),
      el('div', { class: 'speed-right' }, peek, latencyRow)),
    card('实时曲线', '蓝色为下行，绿色为上行', curve.node)
  );

  let timer = null;
  let taskId = null;

  function render(d) {
    gauge.set(d.downMbps || d.upMbps);
    curve.set(d.samples || []);
    peek.replaceChildren(stats([
      { label: '下行峰值', value: `${(d.downPeak || 0).toFixed(1)}`, sub: 'Mbps' },
      { label: '上行峰值', value: `${(d.upPeak || 0).toFixed(1)}`, sub: 'Mbps' },
      { label: '平均下行', value: `${(d.avgDown || 0).toFixed(1)}`, sub: 'Mbps' },
      { label: '本次已传', value: fmtBytes(d.totalBytes), sub: '累计' },
    ]));
  }

  async function poll() {
    try {
      const d = await api('/api/speedtest/status?taskId=' + encodeURIComponent(taskId));
      render(d);
      if (d.state === 'done' || d.state === 'error' || d.state === 'cancelled') {
        clearInterval(timer);
        timer = null;
        if (d.state === 'error') toast('测速失败：' + (d.error || ''), 'error');
        if (d.state === 'done') toast('测速完成', 'ok');
      }
    } catch (err) {
      clearInterval(timer);
      timer = null;
      toast('获取测速进度失败：' + (err.message || err), 'error');
    }
  }

  async function start() {
    try {
      const r = await api('/api/speedtest/start', { mode: mode.value, seconds: 10 });
      taskId = r.taskId;
      gauge.set(0);
      curve.set([]);
      clearInterval(timer);
      timer = setInterval(poll, 300);
      // 同时测一次延迟/抖动/丢包
      api('/api/speedtest/ping?count=10')
        .then((p) => {
          latencyRow.replaceChildren(
            el('span', { class: 'muted', text: `延迟 ${p.latency ?? '—'} ms` }),
            el('span', { class: 'muted', text: `抖动 ${p.jitter ?? '—'} ms` }),
            el('span', { class: 'muted', text: `丢包 ${p.loss}%` })
          );
        })
        .catch(() => { /* 忽略 */ });
    } catch (err) {
      toast('启动测速失败：' + (err.message || err), 'error');
    }
  }

  async function stop() {
    if (!taskId) return;
    try {
      await api('/api/speedtest/cancel', { taskId });
    } catch { /* 忽略 */ }
  }

  return box;
}

function trafficTab() {
  const box = el('div', { style: { display: 'grid', gap: '12px' } });
  const btn = button('刷新流量', () => action(btn, run), { variant: 'primary' });
  const out = el('div');
  box.append(el('div', { class: 'form-actions' }, btn), note('速率为两次采样差分，点两次即可看到变化。', 'info'), out);

  async function run() {
    out.replaceChildren(spinner('正在采样…'));
    try {
      const d = await api('/api/netdiag/traffic');
      const items = (d.items || []).filter((i) => i.rx > 0 || i.tx > 0 || i.rx_rate > 0).slice(0, 12);
      out.replaceChildren(table(
        [
          { label: '接口', key: 'name' },
          { label: '接收累计', render: (row) => fmtBytes(row.rx) },
          { label: '发送累计', render: (row) => fmtBytes(row.tx) },
          { label: '接收速率', render: (row) => fmtBytes(row.rx_rate) + '/s' },
          { label: '发送速率', render: (row) => fmtBytes(row.tx_rate) + '/s' },
        ],
        items,
        { empty: d.available === false ? (d.note || '非 Linux 环境') : '没有接口数据' }
      ));
    } catch (err) {
      out.replaceChildren(note('采样失败：' + (err.message || err), 'error'));
    }
  }
  return box;
}

function traceTab() {
  const hostInput = input({ placeholder: 'github.com', value: 'github.com' });
  const out = el('div');
  const btn = button('开始追踪', () => action(btn, run), { variant: 'ghost' });
  const box = el('div', { style: { display: 'grid', gap: '12px' } },
    el('div', { class: 'form-actions' }, hostInput, btn),
    note('需要本机安装 traceroute；最多 16 跳。', 'info'), out);

  async function run() {
    out.replaceChildren(spinner('正在追踪…'));
    try {
      const d = await api('/api/netdiag/traceroute?host=' + encodeURIComponent(hostInput.value.trim() || 'github.com'));
      out.replaceChildren(d.available ? codeBlock(d.text || '（无输出）') : note(d.note || '不可用', 'warn'));
    } catch (err) {
      out.replaceChildren(note('追踪失败：' + (err.message || err), 'error'));
    }
  }
  return box;
}

function lanTab() {
  const out = el('div');
  const btn = button('读取局域网设备', () => action(btn, run), { variant: 'primary' });
  const box = el('div', { style: { display: 'grid', gap: '12px' } },
    el('div', { class: 'form-actions' }, btn),
    note('来自系统邻居表（ARP），不做主动扫描。', 'info'), out);

  async function run() {
    out.replaceChildren(spinner('正在读取…'));
    try {
      const d = await api('/api/netdiag/lan');
      out.replaceChildren(table(
        [
          { label: 'IP', key: 'ip' },
          { label: '接口', key: 'dev' },
          { label: 'MAC', key: 'mac' },
          { label: '状态', key: 'state' },
        ],
        d.items || [],
        { empty: '没有邻居记录（可能已过期）' }
      ));
    } catch (err) {
      out.replaceChildren(note('读取失败：' + (err.message || err), 'error'));
    }
  }
  return box;
}

export async function render(root) {
  root.append(tabs([
    { label: '连通性', render: connTab },
    { label: '带宽测速', render: speedTab },
    { label: '流量统计', render: trafficTab },
    { label: '路由追踪', render: traceTab },
    { label: '局域网设备', render: lanTab },
  ]));
}
