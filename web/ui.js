/**
 * 前端 UI 基础组件（零依赖）。
 * 约定：所有模块都从 '../ui.js' 引入这些函数，返回真实 DOM 节点。
 */

export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  props = props || {};
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : value);
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

/* ------------------------------------------------------------------ */
/* 布局                                                                */
/* ------------------------------------------------------------------ */

export function card(title, desc, ...children) {
  const head = title
    ? el('div', { class: 'card-head' },
        el('div', {},
          el('h3', { text: title }),
          desc ? el('p', { class: 'card-desc', text: desc }) : null))
    : null;
  return el('section', { class: 'card' }, head, ...children);
}

export function grid(...children) {
  return el('div', { class: 'grid' }, ...children);
}

export function row(...children) {
  return el('div', { class: 'row' }, ...children);
}

export function field(label, control, hint) {
  return el('label', { class: 'field' },
    el('span', { class: 'field-label', text: label }),
    control,
    hint ? el('span', { class: 'field-hint', text: hint }) : null);
}

export function note(text, kind = 'info') {
  return el('div', { class: `note note-${kind}` }, el('span', { class: 'note-dot' }), el('span', { text }));
}

export function hint(text) {
  return el('p', { class: 'hint', text });
}

export function badge(text, kind = 'default') {
  return el('span', { class: `badge badge-${kind}`, text });
}

export function segmented(options, value, onChange) {
  const wrap = el('div', { class: 'segmented' });
  let current = value;
  for (const opt of options) {
    const btn = el('button', {
      type: 'button',
      class: 'seg' + (opt.value === current ? ' active' : ''),
      text: opt.label,
      onclick: () => {
        current = opt.value;
        for (const child of wrap.children) child.classList.toggle('active', child.dataset.value === current);
        onChange(current);
      },
    });
    btn.dataset.value = opt.value;
    wrap.appendChild(btn);
  }
  return wrap;
}

export function tabs(items) {
  // items: [{ label, render }]
  const body = el('div', { class: 'tab-body' });
  const bar = el('div', { class: 'tabs' });
  let active = 0;
  const buttons = items.map((item, i) =>
    el('button', {
      type: 'button',
      class: 'tab' + (i === 0 ? ' active' : ''),
      text: item.label,
      onclick: () => select(i),
    })
  );
  function select(i) {
    active = i;
    buttons.forEach((b, idx) => b.classList.toggle('active', idx === i));
    body.replaceChildren(items[i].render());
  }
  bar.append(...buttons);
  body.appendChild(items[0].render());
  return el('div', { class: 'tabbed' }, bar, body);
}

/* ------------------------------------------------------------------ */
/* 表单控件                                                            */
/* ------------------------------------------------------------------ */

export function input(opts = {}) {
  return el('input', {
    class: 'input',
    type: opts.type || 'text',
    value: opts.value ?? '',
    placeholder: opts.placeholder || '',
    min: opts.min,
    max: opts.max,
    step: opts.step,
    spellcheck: 'false',
    oninput: opts.oninput,
  });
}

export function textarea(opts = {}) {
  const node = el('textarea', {
    class: 'input textarea',
    rows: opts.rows || 4,
    placeholder: opts.placeholder || '',
    spellcheck: 'false',
  });
  if (opts.value) node.value = opts.value;
  if (opts.oninput) node.addEventListener('input', opts.oninput);
  return node;
}

export function select(opts, value, onChange) {
  const list = opts.map((o) => (Array.isArray(o) ? { value: o[0], label: o[1] } : o));
  const node = el('select', { class: 'input select', onchange: (e) => onChange && onChange(e.target.value) });
  for (const o of list) {
    const option = el('option', { value: o.value, text: o.label });
    if (o.value === value) option.selected = true;
    node.appendChild(option);
  }
  return node;
}

export function checkbox(label, checked, onChange) {
  const box = el('input', { type: 'checkbox', class: 'checkbox' });
  box.checked = Boolean(checked);
  if (onChange) box.addEventListener('change', () => onChange(box.checked));
  return el('label', { class: 'check' }, box, el('span', { text: label }));
}

export function button(label, onClick, opts = {}) {
  const btn = el('button', {
    type: 'button',
    class: `btn ${opts.variant ? 'btn-' + opts.variant : 'btn-primary'}${opts.block ? ' btn-block' : ''}`,
    onclick: onClick,
    disabled: opts.disabled,
  }, el('span', { text: label }));
  if (opts.icon) btn.prepend(el('span', { class: 'btn-icon', text: opts.icon }));
  return btn;
}

/* ------------------------------------------------------------------ */
/* 数据展示                                                            */
/* ------------------------------------------------------------------ */

export function table(columns, rows, opts = {}) {
  const thead = el('thead', {}, el('tr', {}, ...columns.map((c) =>
    el('th', { text: c.label, style: c.width ? { width: c.width } : undefined })
  )));
  const tbody = el('tbody');
  if (!rows.length) {
    tbody.appendChild(el('tr', {}, el('td', { class: 'empty-cell', colspan: columns.length, text: opts.empty || '暂无数据' })));
  }
  for (const row of rows) {
    const tr = el('tr');
    for (const c of columns) {
      const td = el('td');
      const value = c.render ? c.render(row) : row[c.key];
      if (value instanceof Node) td.appendChild(value);
      else td.textContent = value === null || value === undefined ? '' : String(value);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  return el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, thead, tbody));
}

export function codeBlock(text, opts = {}) {
  const actions = el('div', { class: 'code-actions' });
  actions.appendChild(el('button', { class: 'mini', text: '复制', onclick: (e) => copyText(text, e.target) }));
  if (opts.filename) {
    actions.appendChild(el('button', {
      class: 'mini',
      text: '下载',
      onclick: () => downloadText(opts.filename, text, 'text/plain;charset=utf-8'),
    }));
  }
  return el('div', { class: 'code' },
    el('div', { class: 'code-head' },
      el('span', { class: 'code-title', text: opts.title || opts.filename || (opts.lang ? opts.lang.toUpperCase() : '输出') }),
      actions),
    el('pre', { class: 'code-body' }, el('code', { text })));
}

export function jsonView(data) {
  return el('pre', { class: 'json' }, el('code', { text: JSON.stringify(data, null, 2) }));
}

export function stat(label, value, sub) {
  return el('div', { class: 'stat' },
    el('div', { class: 'stat-value', text: String(value) }),
    el('div', { class: 'stat-label', text: label }),
    sub ? el('div', { class: 'stat-sub', text: sub }) : null);
}

export function stats(items) {
  return el('div', { class: 'stats' }, ...items.map((i) => stat(i.label, i.value, i.sub)));
}

export function list(items, opts = {}) {
  return el('ul', { class: 'list ' + (opts.class || '') }, ...items.map((i) =>
    el('li', {}, typeof i === 'string' ? i : i)
  ));
}

export function spinner(label = '处理中...') {
  return el('div', { class: 'loading' }, el('span', { class: 'spinner' }), el('span', { text: label }));
}

export function empty(text) {
  return el('div', { class: 'empty', text });
}

/* ------------------------------------------------------------------ */
/* 交互                                                                */
/* ------------------------------------------------------------------ */

/**
 * 桌面网关基址：后端在 HTML 里注入 <meta name="app-base">。
 * TCP/Docker 直连时是空（走绝对路径）；网关前缀下是 /app/xxx。API 都要带上它。
 */
const APP_BASE = (() => {
  let meta = null;
  try { meta = document.head && document.head.querySelector('meta[name="app-base"]'); } catch { /* ignore */ }
  const v = meta && meta.getAttribute('content');
  return v ? v.replace(/[\/]+$/g, '') : '';
})();

/** 把以 / 开头的路径解析到当前基址下（网关前缀或根）。 */
export function resolveApp(path) {
  return APP_BASE + path;
}

export async function api(path, body) {
  const init = body === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(resolveApp(path), init);
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    throw new Error(`服务返回异常（HTTP ${res.status}）`);
  }
  if (res.status === 401 && payload && payload.needLogin) {
    location.href = resolveApp('/login');
    throw new Error('需要登录');
  }
  if (!res.ok || payload.ok === false) {
    // 保留 detail：后端把 docker compose 真实报错放在这里，前端要透传而不是丢掉
    const err = new Error(payload.error || `请求失败（HTTP ${res.status}）`);
    if (typeof payload.detail === 'string' && payload.detail.trim()) err.detail = payload.detail.trim();
    throw err;
  }
  return payload.data;
}

/** POST 并直接触发浏览器下载（用于生成 HTML / 脚本 / CSV 等）。 */
export async function apiDownload(path, body, fallbackName = 'download.txt') {
  const res = await fetch(resolveApp(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    let message = `下载失败（HTTP ${res.status}）`;
    try {
      const data = await res.json();
      message = data.error || message;
    } catch { /* ignore */ }
    throw new Error(message);
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  let filename = fallbackName;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const plain = /filename="([^"]+)"/i.exec(cd);
  if (star) filename = decodeURIComponent(star[1]);
  else if (plain) filename = plain[1];
  saveBlob(blob, filename);
  return filename;
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  saveBlob(new Blob([text], { type: mime }), filename);
}

export function split(left, right) {
  return el('div', { class: 'split' }, left, right);
}

export function kv(pairs) {
  const dl = el('dl', { class: 'kv' });
  for (const [k, v] of Object.entries(pairs)) {
    if (v === null || v === undefined || v === '') continue;
    dl.appendChild(el('dt', { text: k }));
    dl.appendChild(el('dd', {}, v instanceof Node ? v : String(v)));
  }
  return dl;
}

export async function copyText(text, trigger) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'ok');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('已复制', 'ok');
  }
  if (trigger) {
    const old = trigger.textContent;
    trigger.textContent = '已复制';
    setTimeout(() => (trigger.textContent = old), 1200);
  }
}

export function toast(message, kind = 'info', timeout = 3200) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = el('div', { id: 'toasts', class: 'toasts' });
    document.body.appendChild(box);
  }
  const item = el('div', { class: `toast toast-${kind}` }, el('span', { text: message }));
  box.appendChild(item);
  requestAnimationFrame(() => item.classList.add('show'));
  setTimeout(() => {
    item.classList.remove('show');
    setTimeout(() => item.remove(), 260);
  }, timeout);
}

export function bytes(n) {
  if (!Number.isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function duration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

/** 包装一次异步操作：自动禁用按钮 + 错误 toast。 */
export async function action(buttonNode, fn, { loadingText } = {}) {
  const original = buttonNode.textContent;
  buttonNode.disabled = true;
  if (loadingText) buttonNode.textContent = loadingText;
  try {
    return await fn();
  } catch (err) {
    toast(err.message || '操作失败', 'error');
    return undefined;
  } finally {
    buttonNode.disabled = false;
    buttonNode.textContent = original;
  }
}
