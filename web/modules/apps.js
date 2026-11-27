/**
 * 应用中心：预置常用自托管应用，面向新手的一键部署。
 *
 * 新手只需要做三件事：选目录 → 确认端口 → 点「一键部署」。
 * 没有 Docker 权限时，页面会直接给出下一步，而不是甩一段命令。
 */

import {
  api, action, badge, button, card, codeBlock, el, field, input, note, spinner, toast,
} from '../ui.js';

let catalog = null;
let keyword = '';
let activeCategory = '全部';
const versionNodes = new Map();

function guessDataRoot(roots) {
  const usable = (roots || []).filter((r) => r.exists);
  const first = (usable[0] && usable[0].path) || '/vol1/media';
  // 放在已授权目录内部，否则会被路径沙箱拒绝
  return `${first.replace(/\/+$/, '')}/docker`;
}

function appUrl(app) {
  if (!app.web) return '';
  const path = (app.web && app.web.path) || '/';
  return `http://${location.hostname}:${app.web.port}${path}`;
}

function randomPassword(length = 14) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const buf = new Uint32Array(length);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join('');
}

/** GitHub 的 tag 格式很杂：v1.2.3、release-5.3.0、1.2，统一成紧凑展示。 */
function versionLabel(app) {
  const raw = String(app.version || app.fallbackVersion || '');
  const clean = raw.replace(/^release[-_]?/i, '').replace(/^v/i, '');
  return /^\d/.test(clean) ? `v${clean}` : clean;
}

/* ------------------------------------------------------------------ */
/* 卡片                                                                */
/* ------------------------------------------------------------------ */

function appCard(app) {
  // FPK 应用：只跳到 GitHub 下载/安装，不涉及 Docker 部署
  if (app && app.link) {
    const primary = button(app.linkText || '前往 GitHub 下载安装', () => window.open(app.linkUrl, '_blank', 'noopener'));
    return el('article', { class: 'app-card' },
      el('div', { class: 'app-card-head' },
        el('div', {
          class: 'app-icon',
          style: { background: `linear-gradient(135deg, ${app.color}, color-mix(in srgb, ${app.color} 55%, #7c3aed))` },
          text: app.icon,
        }),
        el('div', { class: 'app-title' },
          el('h3', { text: app.name }),
          el('span', { class: 'app-cat', text: app.category })),
        el('div', { class: 'app-status' }, badge('GitHub 安装', 'accent'))),
      el('p', { class: 'app-desc', text: app.desc }),
      el('div', { class: 'app-meta' },
        el('span', { class: 'app-version', text: app.pkg || 'FPK' }),
        el('span', { class: 'app-source', text: 'GitHub Releases 手动安装' })),
      el('div', { class: 'app-actions' },
        primary,
        button('查看仓库', () => window.open(app.githubUrl, '_blank', 'noopener'), { variant: 'ghost' })));
  }

  const version = el('span', {
    class: 'app-version',
    text: versionLabel(app),
  });
  versionNodes.set(app.id, version);

  const status = app.running
    ? badge('运行中', 'ok')
    : app.installed
      ? badge('已停止', 'warn')
      : badge('未部署', 'default');

  let primary;
  if (app.running) {
    primary = app.web
      ? button('打开', () => window.open(appUrl(app), '_blank', 'noopener'))
      : button('管理台', () => window.open(app.consoleUrl || 'https://login.tailscale.com/admin/machines', '_blank', 'noopener'));
  } else if (app.installed) {
    primary = button('启动', () => action(primary, async () => {
      await api('/api/apps/action', { id: app.id, action: 'start' });
      toast(`${app.name} 已启动`, 'ok');
      await loadCatalog();
    }));
  } else {
    primary = button('一键部署', () => openDeploy(app));
  }

  return el('article', { class: 'app-card' },
    el('div', { class: 'app-card-head' },
      el('div', {
        class: 'app-icon',
        style: { background: `linear-gradient(135deg, ${app.color}, color-mix(in srgb, ${app.color} 55%, #7c3aed))` },
        text: app.icon,
      }),
      el('div', { class: 'app-title' },
        el('h3', { text: app.name }),
        el('span', { class: 'app-cat', text: app.category })),
      el('div', { class: 'app-status' }, status)),
    el('p', { class: 'app-desc', text: app.desc }),
    el('div', { class: 'app-meta' },
      version,
      el('span', { class: 'app-source', text: app.running ? '容器运行中' : '官方镜像' })),
    el('div', { class: 'app-actions' },
      primary,
      button('配置', () => openDeploy(app), { variant: 'ghost' })));
}

function renderGrid(container) {
  if (!catalog) return;
  const kw = keyword.trim().toLowerCase();
  const list = catalog.apps.filter((app) => {
    const hitCat = activeCategory === '全部' || app.category === activeCategory;
    const hitKw = !kw || `${app.name} ${app.desc} ${app.category}`.toLowerCase().includes(kw);
    return hitCat && hitKw;
  });

  container.replaceChildren(
    list.length
      ? el('div', { class: 'app-grid' }, ...list.map(appCard))
      : el('div', { class: 'empty', text: '没有匹配的应用，换个关键词试试。' })
  );
}

/* ------------------------------------------------------------------ */
/* 部署弹窗                                                            */
/* ------------------------------------------------------------------ */

function closeOnEsc(handler) {
  window.addEventListener('keydown', handler, { once: true });
  return handler;
}

function openDeploy(app) {
  if (!catalog) return;
  const roots = (catalog._roots || []).filter((r) => r.exists).map((r) => r.path);
  const dockerReady = Boolean(catalog.docker && catalog.docker.available);

  const overlay = el('div', { class: 'modal-overlay' });
  const statusBox = el('div', { class: 'deploy-status' });
  const preview = el('div');

  const dataInput = input({
    value: roots.length ? guessDataRoot(catalog._roots) : '',
    placeholder: '留空 = 使用应用私有目录（不占用媒体授权）',
  });
  const mediaInput = app.needsMedia
    ? input({ value: roots[0] || '', placeholder: '/vol1/media' })
    : null;
  const portInput = app.web
    ? input({ type: 'number', value: String(app.web.port), min: 1, max: 65535 })
    : null;

  // 目录里声明的额外参数（管理员密码、Tailscale 密钥等），只允许这些 key
  const envItems = (app.envParams || []).map((param) => {
    const generated = param.secret && !param.default ? randomPassword() : '';
    const value = generated || param.default || '';
    const box = input({ value, type: param.secret && !generated ? 'password' : 'text' });
    return { param, input: box, generated };
  });

  function buildParams() {
    const params = { id: app.id, dataDir: dataInput.value.trim() };
    if (portInput) params.port = Number(portInput.value) || app.web.port;
    if (mediaInput) params.mediaDir = mediaInput.value.trim();
    if (envItems.length) {
      const extraEnv = {};
      for (const item of envItems) {
        const value = item.input.value.trim();
        if (value) extraEnv[item.param.key] = value;
      }
      params.extraEnv = extraEnv;
    }
    return params;
  }

  const close = () => {
    overlay.remove();
    document.body.classList.remove('modal-open');
  };

  const suggestBtn = el('button', {
    class: 'mini',
    text: '自动选端口',
    onclick: () => action(suggestBtn, async () => {
      const res = await api('/api/apps/suggest-port', { port: Number(portInput.value) || app.web.port });
      portInput.value = String(res.port);
      if (res.original && res.original !== res.port) toast(`端口 ${res.original} 被占用，已换成 ${res.port}`, 'warn');
    }),
  });

  const deployBtn = button('一键部署', () => action(deployBtn, async () => {
    if (!dockerReady) {
      toast('Docker 还没准备好，请先看页面上的三步说明', 'warn');
      return;
    }
    const params = buildParams();

    statusBox.replaceChildren(spinner('正在拉取镜像并启动，首次可能需要 1~3 分钟…'));
    deployBtn.disabled = true;
    try {
      const res = await api('/api/apps/deploy', params);
      const links = [];
      if (res.url) {
        links.push(el('a', { class: 'btn btn-primary', href: res.url, target: '_blank', rel: 'noopener', text: '打开 ' + app.name }));
      } else if (res.consoleUrl) {
        links.push(el('a', { class: 'btn btn-primary', href: res.consoleUrl, target: '_blank', rel: 'noopener', text: '打开管理台' }));
      }
      statusBox.replaceChildren(
        note('部署成功，容器已经启动。', 'ok'),
        ...links,
        res.url ? null : note('该应用没有 Web 界面，请在管理台确认设备或运行状态。', 'info')
      );
      toast(`${app.name} 部署成功`, 'ok');
      // 通知页面刷新列表 —— 弹窗作用域不直接调用页面的 loadCatalog，避免作用域问题
      window.dispatchEvent(new CustomEvent('apps:refresh'));
    } catch (err) {
      // 把后端真实报错（err.detail）也显示出来（可能是镜像拉取记录，或 docker compose 输出），而不是只留一句「部署失败」
      statusBox.replaceChildren(
        note('部署失败：' + err.message, 'error'),
        err.detail ? codeBlock(err.detail, { title: '详细输出', lang: 'text' }) : null
      );
    } finally {
      deployBtn.disabled = false;
    }
  }), { block: true });

  const previewBtn = el('button', {
    class: 'mini',
    text: '生成并预览配置',
    onclick: () => action(previewBtn, async () => {
      const res = await api('/api/apps/compose', buildParams());
      preview.replaceChildren(codeBlock(res.compose, { title: 'docker-compose.yml' }));
    }),
  });

  overlay.appendChild(el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
    el('div', { class: 'modal-head' },
      el('div', { class: 'app-icon', style: { background: `linear-gradient(135deg, ${app.color}, color-mix(in srgb, ${app.color} 55%, #7c3aed))` }, text: app.icon }),
      el('div', { class: 'app-title' },
        el('h3', { text: `部署 ${app.name}` }),
        el('span', { class: 'app-cat', text: app.desc })),
      el('button', { class: 'icon-btn', text: '✕', title: '关闭', onclick: close })),
    el('div', { class: 'modal-body' },
      el('div', { class: 'modal-steps' },
        el('span', { class: 'step' }, el('b', { text: '1' }), '选数据目录'),
        el('span', { class: 'step' }, el('b', { text: '2' }), '确认端口'),
        el('span', { class: 'step' }, el('b', { text: '3' }), '点部署，等它跑完')),
      field('应用数据目录（可留空）', dataInput, '留空会用应用私有目录，新手不用先去授权；填路径则必须在授权目录内'),
      app.needsMedia ? field(app.mediaLabel || '媒体目录', mediaInput, '选择你已有的媒体文件夹，容器只读挂载') : null,
      ...envItems.map(({ param, input: box, generated }) =>
        field(param.label, box, (generated ? `已生成随机密码：${generated}，请复制保存。` : '') + (param.hint || ''))),
      app.web
        ? field('访问端口', el('div', { class: 'port-row' }, portInput, suggestBtn), '被占用就点「自动选端口」')
        : note('该应用没有 Web 界面，部署后在管理台查看状态。', 'info'),
      el('details', { class: 'modal-advanced' },
        el('summary', { text: '高级：查看生成的 docker-compose.yml' }),
        previewBtn,
        preview),
      statusBox),
    el('div', { class: 'modal-foot' },
      el('button', { class: 'btn btn-ghost', text: '取消', onclick: close }),
      deployBtn)));

  // 只允许点右上角 ✕ 或「取消」关闭；点击弹窗外的背景一律不关闭，避免误触丢掉已填内容。
  // Esc 也停用：只有右上角 ✕ 或「取消」按钮能关闭弹窗，避免误触关闭丢内容。
  // closeOnEsc((e) => { if (e.key === 'Escape') close(); });

  document.body.appendChild(overlay);
  document.body.classList.add('modal-open');
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

function dockerGuide() {
  return card('Docker 还没准备好，按这三步来', '不需要命令行，装完回来点一下就行',
    el('ol', { class: 'guide-steps' },
      el('li', {}, '打开飞牛「应用中心」，搜索并安装「Docker」；如果已经装了，跳到第 2 步。'),
      el('li', {}, '回到本页，点下面的「重新检测」。'),
      el('li', {}, '仍提示无权限：到「应用中心 → NAS助手 → 应用设置」停用再启用（本版本已申请 docker 组）；Docker 部署的 NAS助手 需要挂载 /var/run/docker.sock。')),
    el('div', { class: 'form-actions' },
      button('重新检测', () => loadCatalog())),
    note('安全提示：能操作 Docker 就等于拥有 NAS 的 root 权限，建议先设置访问密码，且不要把这个端口暴露到公网。', 'warn'));
}

export async function render(root, ctx = {}) {
  const head = el('div');
  const grid = el('div');
  const guide = el('div');
  const tools = el('div');

  catalog = null;
  root.replaceChildren(spinner('正在读取应用目录…'));

  async function loadCatalog() {
    const data = await api('/api/apps/catalog');
    data._roots = (ctx.system && ctx.system.roots) || [];
    catalog = data;
    paint();
    refreshReleases();
  }

  async function refreshReleases() {
    try {
      const res = await api('/api/apps/releases', {});
      for (const [id, info] of Object.entries(res.versions || {})) {
        const node = versionNodes.get(id);
        if (node && info && info.version) node.textContent = versionLabel({ version: info.version });
      }
    } catch {
      /* 离线时保留默认版本，不影响部署 */
    }
  }

  function paint() {
    const dockerReady = Boolean(catalog.docker && catalog.docker.available);
    head.replaceChildren(
      el('section', { class: 'apps-hero' },
        el('div', {},
          el('h2', { text: '不用懂 Docker，点一下就能装' }),
          el('p', { text: '常用自托管应用已经配好镜像、端口和数据目录，选好位置点「一键部署」即可。' })),
        el('div', { class: 'apps-hero-side' },
          dockerReady ? badge(`Docker ${catalog.docker.version || ''} 已就绪`, 'ok') : badge('Docker 未就绪', 'warn'),
          button('刷新', () => loadCatalog(), { variant: 'ghost' }))));

    guide.replaceChildren(dockerReady ? el('div') : dockerGuide());

    tools.replaceChildren(
      el('div', { class: 'app-toolbar' },
        el('div', { class: 'search-box' },
          el('span', { class: 'search-icon', text: '⌕' }),
          input({
            placeholder: '搜索应用，例如 音乐、下载、密码',
            oninput: (e) => {
              keyword = e.target.value;
              renderGrid(grid);
            },
          })),
        el('div', { class: 'cat-chips' },
          ...['全部', ...catalog.categories].map((cat) =>
            el('button', {
              class: 'chip' + (cat === activeCategory ? ' active' : ''),
              text: cat,
              onclick: (e) => {
                activeCategory = cat;
                for (const chip of e.target.parentElement.children) chip.classList.remove('active');
                e.target.classList.add('active');
                renderGrid(grid);
              },
            })))));

    renderGrid(grid);
  }

  try {
    await loadCatalog();
  } catch (err) {
    root.replaceChildren(note('读取应用目录失败：' + err.message, 'error'));
    return;
  }

  root.replaceChildren(head, guide, tools, grid);

  // 部署完成后由弹窗派发 apps:refresh，页面统一刷新列表（修正 loadCatalog 作用域 bug）
  const onRefresh = () => { loadCatalog(); };
  window.addEventListener('apps:refresh', onRefresh);
  window.addEventListener('hashchange', () => {
    window.removeEventListener('apps:refresh', onRefresh);
  }, { once: true });
}
