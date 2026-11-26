/**
 * 设置页：把分散的配置集中到一处，重点是「文件路径（授权目录）」管理。
 *
 * - 访问模式：全盘访问开关（与「关于」页联动，改这里 /api/settings 生效）。
 * - 授权目录：查看当前已授权路径，应用内新增 / 移除（roots.json）；
 *   fnOS 环境变量 / paths.env 授予的「系统目录」只读展示、不可在应用内删除。
 */

import {
  action, api, badge, button, card, el, field, grid, hint, input, kv, list,
  note, stats, table, toast,
} from '../ui.js';

const BROWSE_VOLUMES = [
  '/vol1', '/vol2', '/vol3', '/vol4', '/vol5', '/vol6', '/vol7', '/vol8', '/vol9',
  '/home', '/mnt', '/media', '/data',
];

/** 刷新完整配置：系统信息 + 授权目录。 */
async function loadSettings() {
  const [system, roots] = await Promise.all([
    api('/api/system'),
    api('/api/roots'),
  ]);
  return { system, roots };
}

export async function render(root) {
  let state;
  try {
    state = await loadSettings();
  } catch (err) {
    root.appendChild(note('读取设置失败：' + err.message, 'error'));
    return;
  }

  const curUnrestricted = Boolean(state.roots.unrestricted);

  /* ---------------- 基础信息 ---------------- */
  root.appendChild(
    stats([
      { label: '版本', value: 'v' + state.system.app.version },
      { label: '数据目录', value: state.system.dataDir },
      { label: '授权目录', value: state.system.roots.length },
      { label: '访问密码', value: state.system.authEnabled ? '已启用' : '未启用' },
    ])
  );

  /* ---------------- 访问模式 ---------------- */
  const modeBtn = button(
    curUnrestricted ? '关闭全盘访问' : '开启全盘访问（不逐目录授权）',
    () => action(modeBtn, async () => {
      const res = await api('/api/settings', { unrestricted: !curUnrestricted });
      toast(res.hint || '已切换访问模式', 'ok');
      setTimeout(() => location.reload(), 700);
    }),
    { variant: curUnrestricted ? 'ghost' : 'primary' }
  );

  root.appendChild(
    card('访问模式', '默认只访问你授权的目录；可切换为全盘访问',
      note(curUnrestricted
        ? '当前为「全盘访问」：应用不再要求逐目录授权，但仍受 fnOS 系统读权限约束（系统不给读权限时照样报无权限）。'
        : '当前为「授权目录」模式：只能访问下方授权目录。',
        curUnrestricted ? 'warn' : 'info'),
      el('div', { class: 'row', style: { marginTop: '10px' } },
        modeBtn,
        el('span', { class: 'hint', text: '开启前请确认已设置访问密码，避免把可读文件暴露给局域网。' })))
  );

  /* ---------------- 授权目录管理 ---------------- */
  const listBox = el('div');
  const manualInput = input({ placeholder: '/vol1/...（从文件管理地址栏复制）' });
  const addBtn = button('按路径添加', () => action(addBtn, async () => {
    await api('/api/roots', { path: manualInput.value.trim() });
    toast('已授权：' + manualInput.value.trim(), 'ok');
    manualInput.value = '';
    refreshList();
  }), { variant: 'ghost' });

  function paintList(roots, savedSet) {
    const sysRoots = roots.filter((p) => !savedSet.has(p));
    const appRoots = roots.filter((p) => savedSet.has(p));

    const sections = [];
    if (appRoots.length) {
      sections.push(el('h4', { text: '应用内授权（可移除）' }));
      sections.push(table(
        [
          { key: 'path', label: '路径', render: (r) => el('span', { class: 'mono', text: r.path }) },
          { key: 'op', label: '操作', width: '120px', render: (r) => removeBtn(r.path) },
        ],
        appRoots
      ));
    }
    sections.push(el('h4', { text: '系统授权（fnOS 应用设置管理，只读）' }));
    sections.push(sysRoots.length
      ? table(
          [
            { key: 'path', label: '路径', render: (r) => el('span', { class: 'mono', text: r.path }) },
            { key: 'src', label: '说明', width: '160px', render: () => badge('系统目录', 'ok') },
          ],
          sysRoots
        )
      : note('没有来自系统的授权目录。可点击下方「浏览」或手动输入路径。', 'info'));

    listBox.replaceChildren(...sections);
  }

  function removeBtn(path) {
    return button('移除', () => action(removeBtn, async () => {
      const res = await api('/api/roots/remove', { path });
      if (res.removed) {
        toast('已移除授权目录：' + path, 'ok');
        refreshList();
      } else {
        toast('该目录不是应用内授权，无需移除', 'warn');
      }
    }), { variant: 'ghost' });
  }

  async function refreshList() {
    try {
      const roots = await api('/api/roots');
      paintList(roots.roots, new Set(roots.saved));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------------- 简易目录浏览器 ---------------- */
  const browseBox = el('div');
  const browseHint = el('span', { class: 'hint', text: '点目录进入，找不到就「授权当前目录」。' });
  let currentPath = '';

  function paintBrowse(paths, parent) {
    const goBtn = button('↑ 上一级', () => browse(parent), { variant: 'ghost' });
    const authBtn = button('授权当前目录', () => action(authBtn, async () => {
      await api('/api/roots', { path: currentPath });
      toast('已授权：' + currentPath, 'ok');
      refreshList();
    }), { disabled: !currentPath });
    const gridItems = el('div', { class: 'browse-grid' },
      ...paths.map((d) =>
        el('button', { class: 'browse-item', title: d.path, onclick: () => browse(d.path) },
          el('span', { class: 'browse-icon', text: d.volumes ? '💾' : '📁' }),
          el('span', { class: 'browse-name', text: d.name }))));
    browseBox.replaceChildren(
      el('div', { class: 'row', style: { marginBottom: '8px' } }, goBtn, authBtn),
      el('div', { class: 'hint', text: currentPath || '选择要授权的卷或目录：' }),
      gridItems
    );
  }

  async function browse(p) {
    try {
      const data = await api('/api/roots/browse' + (p ? '?path=' + encodeURIComponent(p) : ''));
      currentPath = data.path || '';
      paintBrowse(data.volumes ? (data.roots || []) : (data.dirs || []), data.parent);
      refreshList();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const openBrowseBtn = button('浏览选择目录', () => browse(), { variant: 'ghost' });

  root.appendChild(
    card('授权目录', '文件功能只作用于这里列出的路径，统一在此维护',
      note('没有可用授权目录时，其他页面会显示授权引导；这里管理目录后无需重启，自动生效。', 'info'),
      el('div', { class: 'row', style: { marginBottom: '10px' } }, openBrowseBtn, browseHint),
      browseBox,
      el('label', { class: 'field', style: { marginTop: '12px' } },
        el('span', { class: 'field-label', text: '或手动输入完整路径' }),
        manualInput,
        el('span', { class: 'field-hint', text: '从文件管理地址栏复制真实路径；OS 层仍要求应用用户对该目录有读取权限。' })),
      el('div', { class: 'form-actions' }, addBtn),
      el('h4', { text: '当前授权目录' }),
      listBox)
  );

  /* ---------------- 一次初始化 ---------------- */
  paintList(state.roots.roots, new Set(state.roots.saved));

  root.appendChild(
    card('关于这些目录', '路径授权是怎么生效的',
      list([
        '系统授权：由 fnOS「应用设置 → 可访问的文件」或 Docker 的 SS_ROOTS 环境变量提供，改动会自动生效。',
        '应用内授权：在设置页新增/移除的目录保存在数据目录 roots.json，重启后保留。',
        '全盘访问开启后，路径沙箱不再检查授权目录，但仍受系统读权限约束。',
      ], { class: 'list-check' })
    )
  );
}
