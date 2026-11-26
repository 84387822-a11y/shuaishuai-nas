/**
 * 应用外壳：侧边导航、hash 路由、主题切换、系统状态。
 * 每个模块位于 ./modules/<id>.js，导出 render(container)。
 */

import { api, el, input, toast } from './ui.js';

const ICONS = {
  apps: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  rename: '<path d="M4 7h9M4 12h6M4 17h9"/><path d="m16 8 4 4-4 4"/><path d="M20 12h-7"/>',
  network: '<circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17"/><path d="M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18"/>',
  monitor: '<path d="M3 12h3l2.5-7 4 14 2.5-7H21"/>',
  smart: '<rect x="3" y="6" width="18" height="7" rx="2"/><rect x="3" y="15" width="18" height="5" rx="2"/><path d="M7 9.5h.01M7 17.5h.01"/>',
  wallpaper: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="m5 17 5-5 3 3 3-2 2 2"/>',
  tools: '<path d="M14.5 5.5a3.5 3.5 0 0 0 4.6 4.6L21 12l-9 9-2.5-2.5"/> <path d="m11 4 2 2-6 6-2-2z"/><path d="M3 21h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/>',
  about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
};

const MODULES = [
  { id: 'apps', name: '应用中心', desc: '不用懂 Docker，一键部署常用应用', tag: '新' },
  { id: 'rename', name: '文件规范化', desc: '批量重命名预览、执行与撤销', tag: '整理' },
  { id: 'network', name: '网络工具', desc: 'Ping、端口、DNS、HTTP、子网计算', tag: '诊断' },
  { id: 'monitor', name: '监控仪表盘', desc: 'CPU、内存、网络、磁盘与健康状态', tag: '监控' },
  { id: 'smart', name: '硬盘 SMART', desc: '磁盘健康、温度与容量总览', tag: '监控', hidden: true },
  { id: 'wallpaper', name: '桌面壁纸', desc: '挑选壁纸并生成切换脚本', tag: '美化' },
  { id: 'tools', name: '小工具', desc: '编码、哈希、JSON、Cron、密码等', tag: '常用' },
  { id: 'settings', name: '设置', desc: '授权目录、访问模式与偏好', tag: '' },
  { id: 'about', name: '关于', desc: '版本、安全边界与免责声明', tag: '' },
];

const view = document.getElementById('view');
const nav = document.getElementById('nav');
const pageTitle = document.getElementById('page-title');
const pageDesc = document.getElementById('page-desc');

let systemInfo = null;

function renderNav(activeId) {
  nav.replaceChildren(
    ...MODULES.filter((m) => !m.hidden).map((m) =>
      el('a', {
        class: 'nav-item' + (m.id === activeId ? ' active' : ''),
        href: `#/${m.id}`,
      },
        el('span', { class: 'nav-icon', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[m.id]}</svg>` }),
        el('span', { class: 'nav-label', text: m.name }),
        m.tag ? el('span', { class: 'nav-tag', text: m.tag }) : null
      )
    )
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
    renderAuthBanner(systemInfo);
  } catch (err) {
    document.getElementById('sysline').textContent = '系统信息读取失败：' + err.message;
  }
}

/** 没有可用授权目录时给出引导：直接浏览目录点选授权，免去手填路径。 */
function renderAuthBanner(system) {
  const roots = system.roots || [];
  if (roots.some((r) => r.exists)) return;
  if (sessionStorage.getItem('ss-auth-banner') === 'dismissed') return;
  const view = document.getElementById('view');
  if (!view || document.getElementById('auth-banner')) return;

  let currentPath = '';
  let parentPath = null;
  let poll = null;

  const pathLine = el('div', { class: 'browse-path mono small', text: '正在读取可浏览的目录…' });
  const listed = el('div', { class: 'browse-list' });
  const upBtn = el('button', { class: 'mini', text: '↑ 上一级', onclick: () => navigate(parentPath), disabled: true });
  const authBtn = el('button', { class: 'mini', text: '授权当前目录', onclick: () => addRoot(currentPath), disabled: true });

  async function addRoot(p) {
    if (!p) { toast('请先进入一个目录', 'warn'); return; }
    authBtn.disabled = true;
    try {
      await api('/api/roots', { path: p });
      toast('已授权：' + p + '，正在刷新…', 'ok');
      if (poll) clearInterval(poll);
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      toast(err.message, 'error');
      authBtn.disabled = false;
    }
  }

  async function enableUnrestricted() {
    try {
      await api('/api/settings', { unrestricted: true });
      toast('已开启全盘访问，正在刷新…', 'ok');
      if (poll) clearInterval(poll);
      setTimeout(() => location.reload(), 700);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function navigate(p) {
    try {
      const data = await api('/api/roots/browse' + (p ? '?path=' + encodeURIComponent(p) : ''));
      currentPath = data.path || '';
      parentPath = data.parent;
      pathLine.textContent = currentPath || '选择要授权的卷或目录：';
      upBtn.disabled = !parentPath;
      authBtn.disabled = !currentPath;
      const items = data.volumes ? (data.roots || []) : (data.dirs || []);
      listed.replaceChildren(
        items.length
          ? el('div', { class: 'browse-grid' }, ...items.map((d) =>
              el('button', { class: 'browse-item', title: d.path, onclick: () => navigate(d.path) },
                el('span', { class: 'browse-icon', text: data.volumes ? '💾' : '📁' }),
                el('span', { class: 'browse-name', text: d.name }))))
          : el('div', { class: 'empty', text: '该目录下没有子文件夹，可直接「授权当前目录」' }));
    } catch (err) {
      pathLine.textContent = '读取失败：' + err.message;
      listed.replaceChildren();
      toast(err.message, 'error');
    }
  }

  const pathInput = input({ placeholder: '/vol1/...（从文件管理地址栏复制）' });
  const addBtn = el('button', {
    class: 'mini',
    text: '按路径添加',
    onclick: () => addRoot(pathInput.value.trim()),
  });

  const banner = el('div', { id: 'auth-banner', class: 'auth-banner' },
    el('div', { class: 'auth-banner-main' },
      el('div', { class: 'auth-banner-title', text: '还没有可用的授权文件夹' }),
      el('p', { class: 'auth-banner-desc', text: '直接在下面点选目录授权即可，不用再去应用设置里手填路径。' })),
    el('div', { class: 'browse-toolbar' }, upBtn, authBtn),
    pathLine,
    listed,
    el('div', { class: 'browse-shortcut' },
      el('span', { class: 'hint', text: '不想逐个目录授权？' }),
      el('button', { class: 'mini', text: '开启全盘访问', onclick: enableUnrestricted })),
    el('details', { class: 'auth-banner-manual' },
      el('summary', { text: '或者，手动输入完整路径' }),
      el('div', { class: 'row', style: { marginTop: '8px' } }, pathInput, addBtn),
      el('p', { class: 'hint', text: '从文件管理地址栏复制真实路径；OS 层仍要求应用用户对该目录有读取权限。' })),
    el('div', { class: 'auth-banner-actions' },
      el('button', {
        class: 'mini',
        text: '暂时忽略',
        onclick: () => {
          sessionStorage.setItem('ss-auth-banner', 'dismissed');
          if (poll) clearInterval(poll);
          banner.remove();
        },
      })));

  view.before(banner);
  navigate('');

  // 授权保存在别的进程里完成，这里轮询系统状态，一旦出现可用目录就自动刷新
  poll = setInterval(async () => {
    try {
      const info = await api('/api/system');
      if ((info.roots || []).some((r) => r.exists)) {
        clearInterval(poll);
        location.reload();
      }
    } catch {
      /* 服务重启期间忽略 */
    }
  }, 3000);
}

async function route() {
  const id = (location.hash.replace(/^#\/?/, '') || 'apps').split('?')[0];
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
setTheme(localStorage.getItem('ss-theme') || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
bootSystem();
route();

// 暴露给模块的轻量上下文（只读）
window.__SS__ = { getSystem: () => systemInfo };
