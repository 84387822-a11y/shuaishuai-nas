/**
 * 应用外壳：侧边导航、hash 路由、主题切换、系统状态。
 * 每个模块位于 ./modules/<id>.js，导出 render(container)。
 */

import { api, el } from './ui.js';

const ICONS = {
  apps: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  rename: '<path d="M4 7h9M4 12h6M4 17h9"/><path d="m16 8 4 4-4 4"/><path d="M20 12h-7"/>',
  monitor: '<path d="M3 12h3l2.5-7 4 14 2.5-7H21"/>',
  smart: '<rect x="3" y="6" width="18" height="7" rx="2"/><rect x="3" y="15" width="18" height="5" rx="2"/><path d="M7 9.5h.01M7 17.5h.01"/>',
  tools: '<path d="M14.5 5.5a3.5 3.5 0 0 0 4.6 4.6L21 12l-9 9-2.5-2.5"/> <path d="m11 4 2 2-6 6-2-2z"/><path d="M3 21h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/>',
  about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  checkup: '<path d="M9 3h6v3H9z"/><path d="M5 6h14v15H5z"/><path d="m8.5 13 2.2 2.2L16 10"/>',
  cleanup: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  procs: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>',
  docker: '<path d="M3 13h13a5 5 0 0 0 5-5V7"/><path d="M3 13v3a3 3 0 0 0 3 3h7a6 6 0 0 0 6-6"/><path d="M6 10h2v3H6zM10 10h2v3h-2zM14 10h2v3h-2z"/>',
  netdiag: '<path d="M3 12h4l2-5 3 10 2-5h7"/>',
  security: '<path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  storage: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  filemgr: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
};

const MODULES = [
  { id: 'checkup', name: '一键体检', desc: '磁盘、内存、负载、SMART 与 Docker 一次查完', tag: '新', group: '运维' },
  { id: 'cleanup', name: '系统清理', desc: 'Docker 悬空镜像、构建缓存、旧日志与临时文件', tag: '新', group: '运维' },
  { id: 'netdiag', name: '网络诊断', desc: '连通性、带宽测速、流量、路由追踪、局域网设备', tag: '新', group: '运维' },
  { id: 'security', name: '安全防护', desc: 'SSH、账号、对外端口、防火墙与失败登录检查', tag: '新', group: '运维' },
  { id: 'procs', name: '服务进程', desc: '进程占用、失败服务、监听端口', tag: '新', group: '运维' },
  { id: 'docker', name: 'Docker', desc: '容器启停、镜像清单、容器日志', tag: '新', group: '运维' },
  { id: 'storage', name: '硬盘存储', desc: '磁盘型号、温度、SMART 与分区占用', tag: '新', group: '运维' },
  { id: 'filemgr', name: '文件管理', desc: '卷用量、空间构成、目录浏览与大文件排行', tag: '新', group: '运维' },
  { id: 'apps', name: '应用中心', desc: '不用懂 Docker，一键部署常用应用', tag: '', group: '运维' },

  { id: 'monitor', name: '监控仪表盘', desc: 'CPU、内存、网络、磁盘与健康状态', tag: '监控', group: '系统' },
  { id: 'smart', name: '硬盘 SMART', desc: '磁盘健康、温度与容量总览', tag: '监控', hidden: true, group: '系统' },
  { id: 'tools', name: '小工具', desc: '编码、哈希、JSON、Cron、密码等', tag: '常用', group: '系统' },
  { id: 'settings', name: '设置', desc: '授权目录、访问模式与偏好', tag: '', group: '系统' },
  { id: 'about', name: '关于', desc: '版本、安全边界与免责声明', tag: '', group: '系统' },
];

const view = document.getElementById('view');
const nav = document.getElementById('nav');
const pageTitle = document.getElementById('page-title');
const pageDesc = document.getElementById('page-desc');

let systemInfo = null;

function renderNav(activeId) {
  // 按 group 分组渲染（运维 / 系统），保持同一分组内顺序
  const groups = [];
  for (const m of MODULES.filter((x) => !x.hidden)) {
    const g = m.group || '功能';
    let bucket = groups.find((x) => x.name === g);
    if (!bucket) {
      bucket = { name: g, items: [] };
      groups.push(bucket);
    }
    bucket.items.push(m);
  }

  nav.replaceChildren(
    ...groups.flatMap((group) => [
      el('div', { class: 'nav-group', text: group.name }),
      ...group.items.map((m) =>
        el('a', {
          class: 'nav-item' + (m.id === activeId ? ' active' : ''),
          href: `#/${m.id}`,
        },
          el('span', { class: 'nav-icon', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[m.id]}</svg>` }),
          el('span', { class: 'nav-label', text: m.name }),
          m.tag ? el('span', { class: 'nav-tag', text: m.tag }) : null
        )),
    ])
  );
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('ss-theme', theme);
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = theme === 'dark' ? '🌙' : '☀️';
}

async function bootSystem() {
  try {
    systemInfo = await api('/api/system');
    const roots = systemInfo.roots || [];
    const ok = roots.filter((r) => r.exists).length;
    document.getElementById('sysline').textContent =
      `${systemInfo.host.hostname} · 授权目录 ${ok}/${roots.length}`;
    document.getElementById('ver-line').textContent = 'v' + systemInfo.app.version;
    const pill = document.getElementById('auth-pill');
    pill.textContent = systemInfo.authEnabled ? '已启用访问密码' : '内网模式';
    pill.classList.add(systemInfo.authEnabled ? 'pill-ok' : 'pill-warn');
    pill.title = systemInfo.authEnabled
      ? '已通过 SS_PASSWORD 启用登录保护'
      : '未设置 SS_PASSWORD，请勿直接暴露到公网';
  } catch (err) {
    document.getElementById('sysline').textContent = '系统信息读取失败：' + err.message;
  }
}

async function route() {
  const id = (location.hash.replace(/^#\/?/, '') || localStorage.getItem('ss-home') || 'apps').split('?')[0];
  const mod = MODULES.find((m) => m.id === id) || MODULES[0];  renderNav(mod.id);
  pageTitle.textContent = mod.name;
  pageDesc.textContent = mod.desc;
  document.title = `${mod.name} · NAS助手`;

  view.replaceChildren(el('div', { class: 'loading' }, el('span', { class: 'spinner' }), el('span', { text: '加载中…' })));

  try {
    const module = await import(`./modules/${mod.id}.js`);
    view.replaceChildren();
    const scrollTop = view.scrollTop;
    await module.render(view, { system: systemInfo });
    view.scrollTop = scrollTop;
  } catch (err) {
    console.error(err);
    view.replaceChildren(
      el('div', { class: 'card' },
        el('h3', { text: '模块加载失败' }),
        el('p', { class: 'hint', text: err.message }),
        el('button', { class: 'btn btn-primary', text: '重新加载', onclick: () => location.reload() })
      )
    );
  }
}

document.getElementById('theme-btn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(next);
});

window.addEventListener('hashchange', route);

// 使用偏好：紧凑模式 + 二次确认开关
document.documentElement.dataset.density = localStorage.getItem('ss-density') === 'compact' ? 'compact' : '';
const nativeConfirm = window.confirm.bind(window);
window.confirm = (message) => (localStorage.getItem('ss-confirm') === 'off' ? true : nativeConfirm(message));

const savedTheme = localStorage.getItem('ss-theme') || 'light';
setTheme(savedTheme === 'auto'
  ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  : savedTheme);
bootSystem();
route();

// 暴露给模块的轻量上下文（只读）
window.__SS__ = { getSystem: () => systemInfo };
