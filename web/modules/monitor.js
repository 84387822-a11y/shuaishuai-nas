/**
 * 监控仪表盘（NasPulse 风格）：时间、设备、性能、CPU/内存、网络曲线、
 * 存储池、硬盘温度健康、Docker 容器。
 *
 * 数据来自本机 /proc 与 /sys，Docker 状态单独接口、低频刷新。
 */

import { api, badge, button, bytes, duration, el, input, note, spinner, toast } from '../ui.js';

const REFRESH_MS = 2000;
const DOCKER_REFRESH_MS = 15000;
const HISTORY = 40;

const COLOR = {
  cpu: '#4dabf7',
  mem: '#a78bfa',
  netRx: '#34d399',
  netTx: '#f472b6',
};

const history = { rx: [], tx: [] };
let gradientSeq = 0;

function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function rateText(v) {
  if (v === null || v === undefined) return '—';
  return bytes(v) + '/s';
}

function tempText(v) {
  return Number.isFinite(v) ? `${v} °C` : '—';
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function clockParts(date) {
  const week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  return {
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    date: `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`,
    week: week[date.getDay()],
  };
}

/* ------------------------------------------------------------------ */
/* 图表                                                                */
/* ------------------------------------------------------------------ */

function spark(values, color, opts = {}) {
  const width = 260;
  const height = 56;
  const list = values.length ? values : [];
  if (list.length < 2) return el('div', { class: 'spark spark-empty' });

  const max = Math.max(opts.max || 0, ...list, 1);
  const step = width / (HISTORY - 1);
  const offset = HISTORY - list.length;
  const points = list.map((value, i) => {
    const x = (offset + i) * step;
    const y = height - 5 - (value / max) * (height - 12);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const id = `pulse-spark-${gradientSeq++}`;

  return el('div', {
    class: 'spark',
    html: `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity=".35"></stop>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"></stop>
      </linearGradient></defs>
      <path d="M${points[0].split(',')[0]},${height} L${points.join(' L')} L${width},${height} Z" fill="url(#${id})"></path>
      <polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2"
        vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"></polyline>
    </svg>`,
  });
}

/** 双线网络曲线（上传/下载），自动按峰值归一。 */
function netChart(rx, tx) {
  const width = 640;
  const height = 150;
  const all = [...rx, ...tx];
  if (all.length < 2) return el('div', { class: 'net-chart empty' }, el('span', { text: '正在采样…' }));

  const max = Math.max(...all, 1);
  const step = (width - 2) / (HISTORY - 1);

  const line = (values, color) => {
    const offset = HISTORY - values.length;
    const points = values.map((v, i) => {
      const x = 1 + (offset + i) * step;
      const y = height - 10 - (v / max) * (height - 24);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2"
      vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"></polyline>`;
  };

  const grid = [0, 33, 66, 100]
    .map((t) => {
      const y = height - 10 - (t / 100) * (height - 24);
      return `<line x1="0" y1="${y.toFixed(1)}" x2="${width}" y2="${y.toFixed(1)}"
        stroke="currentColor" stroke-opacity=".08" stroke-dasharray="3 5"></line>`;
    })
    .join('');

  return el('div', {
    class: 'net-chart',
    html: `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      ${grid}${line(tx, COLOR.netTx)}${line(rx, COLOR.netRx)}
    </svg>`,
  });
}

/* ------------------------------------------------------------------ */
/* 卡片                                                                */
/* ------------------------------------------------------------------ */

function pulseCard(title, extra, ...body) {
  return el('section', { class: 'pulse-card' },
    el('div', { class: 'pulse-head' },
      el('span', { class: 'pulse-title', text: title }),
      extra || null),
    el('div', { class: 'pulse-body' }, ...body));
}

function metric(label, value, sub) {
  return el('div', { class: 'pulse-metric' },
    el('span', { class: 'pm-label', text: label }),
    el('b', { class: 'pm-value', text: value }),
    sub ? el('span', { class: 'pm-sub', text: sub }) : null);
}

function bar(percent, tone) {
  return el('div', { class: 'meter' + (tone ? ' ' + tone : '') },
    el('i', { style: { width: `${pct(percent)}%` } }));
}

/* ---------------- 时间 / 天气 ---------------- */
/* ---------------- 天气 / 农历 小组件 ---------------- */

/** WMO 天气码 → 图标（前端展示用）。 */
function weatherIcon(code) {
  const n = Number(code);
  if (n === 0 || n === 1) return '☀️';
  if (n === 2) return '⛅';
  if (n === 3) return '☁️';
  if (n === 45 || n === 48) return '🌫️';
  if (n >= 51 && n <= 57) return '🌦️';
  if (n >= 61 && n <= 67) return '🌧️';
  if (n >= 71 && n <= 77) return '🌨️';
  if (n >= 80 && n <= 82) return '🌧️';
  if (n >= 85 && n <= 86) return '🌨️';
  if (n >= 95) return '⛈️';
  return '🌡️';
}

/** 用 Intl 中文农历日历，本地算农历（不塞数据表）。 */
function lunarText(date) {
  try {
    const f = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' });
    return String(f.format(date) || '').trim();
  } catch {
    return '';
  }
}

function weatherCell(weather) {
  if (!weather || !weather.enabled) {
    return el('div', { class: 'weather-box' },
      el('div', { class: 'cb-label', text: '天气' }),
      el('div', { class: 'cb-big', text: '离线' }),
      el('div', { class: 'cb-sub', text: '填城市名后显示' }));
  }
  if (weather.error) {
    return el('div', { class: 'weather-box' },
      el('div', { class: 'cb-label', text: '天气' }),
      el('div', { class: 'cb-big', text: '—' }),
      el('div', { class: 'cb-sub', text: weather.error }));
  }
  const temp = weather.temperature === null ? '—' : `${Math.round(weather.temperature)}°`;
  const feels = weather.feelsLike === null ? '' : `体感 ${Math.round(weather.feelsLike)}°`;
  return el('div', { class: 'weather-box' },
    el('div', { class: 'cb-label', text: weather.city || '天气' }),
    el('div', { class: 'cb-big', text: `${weatherIcon(weather.code)} ${temp}` }),
    el('div', { class: 'cb-sub', text: `${weather.condition || ''} · ${feels}` }));
}

function forecastStrip(days, includeLabel) {
  const labels = ['今天', '明天', '后天'];
  const list = Array.isArray(days) ? days.slice(0, 3) : [];
  if (!list.length) return null;
  return el('div', { class: 'forecast' },
    ...list.map((d, i) => el('div', { class: 'forecast-day' },
      el('span', { class: 'fd-label', text: labels[i] || '' }),
      el('span', { class: 'fd-icon', text: weatherIcon(d.code) }),
      el('span', { class: 'fd-temp', text: `${d.tempMax === null ? '—' : d.tempMax + '°'} / ${d.tempMin === null ? '—' : d.tempMin + '°'}` }),
      el('span', { class: 'fd-cond', text: d.condition || '' }))));
}

function clockCard(data, date, status, weather) {
  const parts = clockParts(date);
  const lunar = lunarText(date);
  let wx;
  if (weather && weather.enabled && !weather.error && weather.temperature !== null) {
    wx = `${weather.city || ''} ${Math.round(weather.temperature)}° ${weather.condition || ''}`.trim();
  } else if (weather && weather.error) {
    wx = '天气：' + weather.error;
  } else {
    wx = '天气：离线（填城市名）';
  }
  return el('section', { class: 'pulse-card clock-card' },
    el('div', { class: 'clock-top' },
      el('div', { class: 'clock-date', text: `${parts.date} ${parts.week}` }),
      status),
    el('div', { class: 'clock-time', text: parts.time }),
    el('div', { class: 'clock-sub' },
      lunar ? el('span', { class: 'clock-lunar', text: '农历 ' + lunar }) : null,
      el('span', { class: 'clock-wx', text: wx })),
    el('div', { class: 'clock-meta' },
      el('span', { class: 'live-dot' }),
      el('span', { text: `${data.hostname || 'NAS'} · 运行 ${duration(data.uptime)}` })),
    forecastStrip(weather && weather.days));
}


/* ---------------- 设备信息 ---------------- */
function deviceCard(data) {
  return pulseCard('设备信息',
    el('span', { class: 'pulse-chip', text: data.platform || 'linux' }),
    el('div', { class: 'kv compact' },
      el('span', { text: '节点' }), el('b', { text: data.hostname || '—' }),
      el('span', { text: 'CPU' }), el('b', { text: data.cpuModel || '—' }),
      el('span', { text: '核心' }), el('b', { text: `${data.cores || '—'} 核` }),
      el('span', { text: '内存' }), el('b', { text: bytes((data.memory || {}).total) }),
      el('span', { text: 'IP' }), el('b', { text: data.primaryIp || '—' }),
      el('span', { text: '运行' }), el('b', { text: duration(data.uptime) })));
}

/* ---------------- 性能（温度/风扇/负载） ---------------- */
function perfCard(data) {
  const fans = Array.isArray(data.fans) ? data.fans : [];
  const load = data.load || [];
  return pulseCard('性能',
    el('span', { class: 'pulse-chip', text: 'RPM' }),
    el('div', { class: 'perf-row' },
      metric('温度', tempText(data.cpuTemp), 'CPU'),
      metric('负载 1m', Number.isFinite(load[0]) ? load[0].toFixed(2) : '—', 'loadavg')),
    el('div', { class: 'fan-list' },
      fans.length
        ? fans.slice(0, 3).map((f) => el('div', { class: 'fan-row' },
            el('span', { text: f.label }),
            el('b', { text: `${f.rpm} RPM` })))
        : el('div', { class: 'fan-empty', text: '未读到风扇传感器' })));
}

/* ---------------- CPU / 内存 ---------------- */
function cpuMemCard(data) {
  const mem = data.memory || {};
  const load = data.load || [];
  return pulseCard('性能负载', el('span', { class: 'pulse-chip', text: '实时' }),
    el('div', { class: 'cm-row' },
      el('div', { class: 'cm-block' },
        el('div', { class: 'cm-top' }, el('span', { text: 'CPU' }), el('b', { text: `${pct(data.cpu)}%` })),
        bar(data.cpu),
        el('div', { class: 'cm-sub', text: `负载 ${Number.isFinite(load[0]) ? load[0].toFixed(2) : '—'} / ${Number.isFinite(load[1]) ? load[1].toFixed(2) : '—'} / ${Number.isFinite(load[2]) ? load[2].toFixed(2) : '—'}` })),
      el('div', { class: 'cm-block' },
        el('div', { class: 'cm-top' }, el('span', { text: '内存' }), el('b', { text: `${pct(mem.percent)}%` })),
        bar(mem.percent),
        el('div', { class: 'cm-sub', text: `${bytes(mem.used)} / ${bytes(mem.total)}` })),
      el('div', { class: 'cm-block' },
        el('div', { class: 'cm-top' }, el('span', { text: '交换' }), el('b', { text: mem.swapTotal ? `${pct((mem.swapUsed / mem.swapTotal) * 100)}%` : '未启用' })),
        bar(mem.swapTotal ? (mem.swapUsed / mem.swapTotal) * 100 : 0),
        el('div', { class: 'cm-sub', text: mem.swapTotal ? `${bytes(mem.swapUsed)} / ${bytes(mem.swapTotal)}` : '—' }))));
}

/* ---------------- 网络 ---------------- */
function netCard(data) {
  const net = data.net;
  const card = pulseCard('网络流量',
    el('span', { class: 'pulse-chip', text: `每 ${REFRESH_MS / 1000}s` }),
    el('div', { class: 'net-rates' },
      el('div', { class: 'net-rate' },
        el('span', { class: 'nr-dot down' }),
        el('div', {}, el('b', { text: rateText(net ? net.rx : null) }), el('span', { text: '下载' }))),
      el('div', { class: 'net-rate' },
        el('span', { class: 'nr-dot up' }),
        el('div', {}, el('b', { text: rateText(net ? net.tx : null) }), el('span', { text: '上传' })))),
    netChart(history.rx, history.tx));
  card.classList.add('pulse-net');
  return card;
}

/* ---------------- 存储池 ---------------- */
function poolsCard(data) {
  const pools = Array.isArray(data.pools) ? data.pools : [];
  const card = pulseCard('存储池', el('span', { class: 'pulse-chip', text: `${pools.length} 个` }),
    pools.length
      ? el('div', { class: 'pool-list' }, ...pools.map((p) => el('div', { class: 'pool-row' },
          el('div', { class: 'pool-head' },
            el('span', { class: 'pool-name', text: p.mountpoint }),
            el('span', { class: 'pool-fs', text: p.fstype }),
            el('b', { text: `${bytes(p.used)} / ${bytes(p.size)}` })),
          bar(p.percent, p.percent >= 90 ? 'danger' : p.percent >= 80 ? 'warn' : ''))))
      : el('div', { class: 'empty', text: '没有可读取的存储池' }));
  card.classList.add('pulse-wide');
  return card;
}

/* ---------------- 硬盘 ---------------- */
function disksCard(data) {
  const ioByName = new Map((data.diskDevices || []).map((d) => [d.name, d]));
  const disks = Array.isArray(data.disks) ? data.disks : [];
  const card = pulseCard('硬盘', el('span', { class: 'pulse-chip', text: `${disks.length} 块` }),
    disks.length
      ? el('div', { class: 'drive-grid' }, ...disks.map((d) => {
          const io = ioByName.get(d.device);
          return el('div', { class: 'drive' },
            el('div', { class: 'drive-size', text: bytes(d.size) }),
            el('div', { class: 'drive-type', text: d.rotational === true ? 'HDD' : d.rotational === false ? 'SSD' : '磁盘' }),
            el('div', { class: 'drive-meta' },
              el('span', { text: d.model || d.device }),
              el('span', { text: tempText(d.temperature) })),
            el('div', { class: 'drive-health' },
              el('span', { class: `temp-tag ${tempToneClass(d.temperature)}`, text: tempTone(d.temperature) }),
              el('span', { class: 'drive-io', text: io ? `读 ${rateText(io.read)} · 写 ${rateText(io.write)}` : '—' })));
        }))
      : el('div', { class: 'empty', text: data.supported ? '没有发现内置磁盘' : '当前平台无法读取磁盘' }));
  card.classList.add('pulse-wide');
  return card;
}

function tempTone(t) {
  if (!Number.isFinite(t)) return '未知';
  if (t >= 55) return '高温';
  if (t >= 45) return '偏热';
  return '正常';
}

function tempToneClass(t) {
  if (!Number.isFinite(t)) return 'muted';
  if (t >= 55) return 'danger';
  if (t >= 45) return 'warn';
  return 'ok';
}

/* ---------------- Docker ---------------- */
function dockerCard(state) {
  const ok = state && state.available;
  return pulseCard('Docker 容器',
    el('span', { class: 'pulse-chip', text: ok ? `${state.running} 运行 / ${state.total} 总数` : '不可用' }),
    ok
      ? (state.items.length
          ? el('div', { class: 'container-list' }, ...state.items.slice(0, 8).map((c) =>
              el('div', { class: 'container-row' },
                el('span', { class: `container-dot ${c.running ? 'on' : 'off'}` }),
                el('div', { class: 'container-main' },
                  el('b', { text: c.name }),
                  el('span', { text: c.image })),
                el('span', { class: 'container-status', text: c.running ? '运行中' : '已停止' }))))
          : el('div', { class: 'empty', text: '没有 Docker 容器' }))
      : el('div', { class: 'docker-offline' },
          el('div', { text: state && state.error ? state.error : '未检测到 Docker' }),
          el('div', { class: 'hint', text: '安装 Docker 并让应用用户加入 docker 组后，这里会显示容器状态。' })));
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

export async function render(root) {
  const content = el('div', { class: 'pulse-grid' });
  const dockerSlot = el('div', { class: 'pulse-docker-slot' });
  const status = el('span', { class: 'pill pill-ok', text: '实时' });
  const weatherInput = input({ placeholder: '城市名，如 上海、北京、广州', class: 'input pulse-weather-input' });
  const weatherBar = el('span', { class: 'muted small', text: '天气：离线（未配置）' });
  let timer = null;
  let dockerTimer = null;
  let dockerState = null;
  let weatherState = null;
  let lastData = null;

  function paint(data) {
    lastData = data;
    const mem = data.memory || {};
    history.rx.push(data.net ? data.net.rx : 0);
    history.tx.push(data.net ? data.net.tx : 0);
    if (history.rx.length > HISTORY) history.rx.shift();
    if (history.tx.length > HISTORY) history.tx.shift();

    const now = new Date();
    const nodes = [
      clockCard(data, now, status, weatherState),
      deviceCard(data),
      perfCard(data),
      cpuMemCard(data),
      netCard(data),
      poolsCard(data),
      disksCard(data),
    ];
    if (data.hint) nodes.unshift(note(data.hint, 'warn'));
    content.replaceChildren(...nodes);
    dockerSlot.replaceChildren(dockerCard(dockerState));
    content.appendChild(dockerSlot);
    status.textContent = data.cpu === null ? '采样中' : '实时';
    status.className = 'pill ' + (data.cpu === null ? 'pill-warn' : 'pill-ok');
  }

  function applyWeather(w) {
    weatherState = w;
    if (weatherInput && w && w.city) weatherInput.value = w.city;
    if (!weatherState || !weatherState.enabled) {
      weatherBar.textContent = '天气：离线（未配置，填城市名保存）';
    } else if (weatherState.error) {
      weatherBar.textContent = `天气：${weatherState.city || ''} · ${weatherState.error}`;
    } else {
      const temp = weatherState.temperature === null ? '—' : `${Math.round(weatherState.temperature)}°`;
      weatherBar.textContent = `天气：${weatherState.city || ''} ${temp} ${weatherState.condition || ''}`;
    }
    if (lastData) paint(lastData);
  }

  async function loadWeather() {
    try {
      const w = await api('/api/monitor/weather');
      applyWeather(w);
    } catch {
      weatherBar.textContent = '天气：获取失败';
    }
  }

  async function saveWeather() {
    try {
      const w = await api('/api/monitor/weather', { city: weatherInput.value.trim() });
      toast(w.set ? w.message : '天气已更新', 'ok');
      applyWeather(w);
    } catch (err) {
      toast(err.message, 'warn');
    }
  }

  async function load(silent) {
    if (!silent) content.replaceChildren(spinner('正在读取运行状态…'));
    try {
      const data = await api('/api/monitor');
      paint(data);
    } catch (err) {
      if (!silent) content.replaceChildren(note('读取运行状态失败：' + err.message, 'error'));
      else toast('运行状态刷新失败：' + err.message, 'error');
    }
  }

  async function loadDocker() {
    try {
      const data = await api('/api/monitor/docker');
      dockerState = data;
      dockerSlot.replaceChildren(dockerCard(data));
    } catch {
      /* Docker 不可用时保持原样 */
    }
  }

  root.appendChild(el('div', { class: 'pulse-toolbar' },
    button('刷新', () => { load(false); loadDocker(); loadWeather(); }, { variant: 'ghost' })));
  root.appendChild(el('div', { class: 'pulse-weather-bar' },
    el('span', { class: 'field-label', text: '天气城市' }),
    weatherInput,
    button('保存并刷新', () => saveWeather(), { variant: 'ghost' }),
    button('更新天气', () => loadWeather(), { variant: 'ghost' }),
    weatherBar));
  root.appendChild(content);

  await load(false);
  loadDocker();
  loadWeather();

  timer = setInterval(() => load(true), REFRESH_MS);
  dockerTimer = setInterval(loadDocker, DOCKER_REFRESH_MS);
  window.addEventListener('hashchange', () => {
    clearInterval(timer);
    clearInterval(dockerTimer);
  }, { once: true });
}
