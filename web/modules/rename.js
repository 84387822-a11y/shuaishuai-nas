/**
 * 文件规范化：批量重命名（先预览、再执行、可撤销），以及导出脚本离线执行。
 * 安全约定：默认全选、冲突项不可选；执行前二次确认，执行后自动刷新预览。
 */

import {
  action, api, apiDownload, badge, button, card, checkbox, el, field,
  hint, input, list, note, select, split, stats, table, toast,
} from '../ui.js';

const PROFILE_OPTIONS = [
  { value: 'auto', label: '自动识别' },
  { value: 'movie', label: '电影' },
  { value: 'tv', label: '剧集' },
];

const MAX_ITEMS = 1000;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function clip(text, max) {
  const s = String(text === null || text === undefined ? '' : text);
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/** 长路径统一用 mono + 截断 + title 悬停查看完整值。 */
function pathCell(text, title, max = 38) {
  const full = title || String(text === null || text === undefined ? '' : text);
  return el('span', { class: 'mono small', text: clip(text, max), title: full });
}

function basename(p) {
  return String(p === null || p === undefined ? '' : p).split(/[\\/]/).filter(Boolean).pop() || '';
}

function typeBadge(type) {
  return type === 'tv' ? badge('剧集', 'accent') : badge('电影');
}

function confidenceCell(value) {
  const score = Number(value) || 0;
  const kind = score >= 80 ? 'ok' : score >= 50 ? 'warn' : 'error';
  return badge(String(score), kind);
}

function reasonCell(item) {
  const wrap = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } });
  if (item.conflict) wrap.appendChild(badge('目标已存在', 'error'));
  for (const issue of item.issues || []) wrap.appendChild(badge(issue, 'warn'));
  wrap.appendChild(el('span', { class: 'small muted', text: item.reason || '' }));
  return wrap;
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

export async function render(root) {
  const dirInput = input({ placeholder: '/vol1/media/电影' });
  const limitInput = input({ type: 'number', value: '800', min: 1, max: 3000, step: 1 });
  let profile = 'auto';
  let recursive = true;
  let organize = false;

  /** 最近一次扫描结果；null 表示还没扫描过。 */
  let last = null;
  /** 已勾选的条目（用原路径做键，路径在一次扫描结果里唯一）。 */
  const selected = new Set();
  /** 执行 / 撤销后要展示的结果提示。 */
  let flash = null;
  let countLabel = null;

  const out = el(
    'div',
    { class: 'result-area', style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
    note('填写目录后开始。')
  );

  function selectedItems() {
    if (!last) return [];
    return last.items.filter((item) => !item.conflict && selected.has(item.from));
  }

  function updateCount() {
    if (countLabel) countLabel.textContent = `已选 ${selectedItems().length} 项`;
  }

  function selectCell(item) {
    const box = el('input', { type: 'checkbox', class: 'checkbox' });
    box.checked = !item.conflict && selected.has(item.from);
    box.disabled = Boolean(item.conflict);
    box.addEventListener('change', () => {
      if (box.checked) selected.add(item.from);
      else selected.delete(item.from);
      updateCount();
    });
    return box;
  }

  const COLUMNS = [
    { label: '选择', width: '52px', render: (item) => selectCell(item) },
    { label: '原路径', render: (item) => pathCell(item.fromRel, item.from) },
    { label: '新路径', render: (item) => pathCell(item.toRel, item.to) },
    { label: '类型', width: '68px', render: (item) => typeBadge(item.type) },
    { label: '置信度', width: '78px', render: (item) => confidenceCell(item.confidence) },
    { label: '原因 / 问题', render: (item) => reasonCell(item) },
  ];

  /* -------------------------- 扫描 -------------------------- */

  async function scan() {
    const data = await api('/api/files/scan', {
      dir: dirInput.value.trim(),
      profile,
      recursive,
      organize,
      limit: Number(limitInput.value) || 800,
    });
    last = data;
    selected.clear();
    for (const item of data.items) {
      if (!item.conflict) selected.add(item.from);
    }
    renderResult();
    return data;
  }

  /** 执行后刷新预览，同时保留一条结果提示。 */
  async function refresh(message, kind = 'info') {
    flash = { text: message, kind };
    if (!last) {
      renderResult();
      return;
    }
    try {
      await scan();
    } catch (err) {
      toast('预览刷新失败：' + err.message, 'warn');
      renderResult();
    }
  }

  /* ------------------------- 重命名 ------------------------- */

  async function doRename() {
    const items = selectedItems();
    if (items.length === 0) {
      toast('请先勾选要重命名的文件', 'warn');
      return;
    }
    if (items.length > MAX_ITEMS) {
      toast(`单次最多处理 ${MAX_ITEMS} 个文件，请分批勾选或缩小目录范围`, 'warn');
      return;
    }
    if (!confirm(`确定要重命名 ${items.length} 个文件吗？\n\n这会真实修改文件名，执行前会自动记录撤销日志。`)) return;

    const data = await api('/api/files/rename', {
      items: items.map((i) => ({ from: i.from, to: i.to })),
      dryRun: false,
    });

    const failedSample = (data.results || [])
      .filter((r) => !r.ok)
      .slice(0, 3)
      .map((r) => `${basename(r.from)}：${r.error}`)
      .join('；');
    const message = data.failed > 0
      ? `重命名完成：成功 ${data.renamed} 个，失败 ${data.failed} 个。${failedSample ? '失败示例：' + failedSample : ''}`
      : `重命名完成：成功 ${data.renamed} 个文件。`;

    await refresh(message, data.failed > 0 ? 'warn' : 'ok');
  }

  /* -------------------------- 撤销 -------------------------- */

  async function doUndo() {
    if (!confirm('确定撤销上一次重命名吗？\n\n会尝试把文件改回原名，原文件名被占用时无法恢复。')) return;

    const data = await api('/api/files/undo', {});
    const suffix = data.failed > 0
      ? `，${data.failed} 个未能恢复。${data.hint || ''}`
      : `。${data.hint || ''}`;

    await refresh(`已恢复 ${data.restored} 个文件` + suffix, data.failed > 0 ? 'warn' : 'ok');
  }

  /* ------------------------- 导出脚本 ------------------------- */

  async function exportScript(format) {
    const items = selectedItems();
    if (items.length === 0) {
      toast('请先勾选要导出的条目', 'warn');
      return;
    }
    const fallback = format === 'bash' ? 'rename-media.sh' : 'rename-media.ps1';
    await apiDownload('/api/files/script', {
      items: items.map((i) => ({ from: i.from, to: i.to })),
      format,
    }, fallback);
    toast(format === 'bash' ? 'Bash 脚本已导出' : 'PowerShell 脚本已导出', 'ok');
  }

  /* -------------------------- 渲染 -------------------------- */

  function renderResult() {
    if (!last) {
      out.replaceChildren(note(flash ? flash.text : '填写目录后开始。', flash ? flash.kind : 'info'));
      return;
    }

    const pending = last.items.filter((item) => !item.conflict);
    const noPending = pending.length === 0;

    const runBtn = button('执行重命名', () => action(runBtn, doRename), {
      variant: 'danger',
      disabled: noPending,
    });
    const bashBtn = button('导出 Bash 脚本', () => action(bashBtn, () => exportScript('bash')), {
      variant: 'ghost',
      disabled: noPending,
    });
    const psBtn = button('导出 PowerShell 脚本', () => action(psBtn, () => exportScript('powershell')), {
      variant: 'ghost',
      disabled: noPending,
    });
    const undoBtn = button('撤销上次操作', () => action(undoBtn, doUndo), { variant: 'ghost' });

    countLabel = el('span', { class: 'muted small', text: `已选 ${selectedItems().length} 项` });

    const bar = el('div', { class: 'row', style: { marginBottom: '12px' } },
      runBtn, bashBtn, psBtn, undoBtn, countLabel);

    const blocks = [
      stats([
        { label: '扫描文件', value: last.total },
        { label: '已规范', value: last.compliant },
        { label: '待修改', value: last.changed },
        { label: '冲突', value: last.conflicts },
      ]),
      last.truncated
        ? note('已达到数量上限，建议缩小目录范围后重新扫描。', 'warn')
        : null,
      flash ? note(flash.text, flash.kind) : null,
      noPending && last.changed === 0
        ? note('未发现需要修改的文件，当前命名已符合规范。', 'ok')
        : null,
      noPending && last.changed > 0
        ? note('所有待修改项目都存在目标冲突，请先手动处理冲突文件后再扫描。', 'warn')
        : null,
      card(
        '重命名预览',
        '勾选要执行的项目；冲突项默认不选且无法勾选',
        el('div', {
          class: 'mono small muted',
          text: '目录：' + last.dir,
          style: { wordBreak: 'break-all', marginBottom: '10px' },
        }),
        bar,
        table(COLUMNS, last.items, { empty: '没有需要重命名的文件' })
      ),
    ];

    out.replaceChildren(...blocks.filter(Boolean));
  }

  const scanBtn = button('扫描并预览', () => action(scanBtn, async () => {
    flash = null;
    const data = await scan();
    toast(
      data.items.length ? `预览已生成：${data.items.length} 个文件待修改` : '没有需要修改的文件',
      data.items.length ? 'info' : 'ok'
    );
  }));

  const left = card(
    '扫描参数',
    '先预览，确认无误后再执行',
    field('目录', dirInput, '例如 /vol1/media/电影；相对路径按第一个授权目录解析'),
    field('整理模式', select(PROFILE_OPTIONS, profile, (v) => { profile = v; }), '自动识别会按文件名判断电影或剧集'),
    el('div', { class: 'row', style: { marginBottom: '12px' } },
      checkbox('递归子目录', recursive, (v) => { recursive = v; }),
      checkbox('按「剧名 (年份)/」建目录', organize, (v) => { organize = v; })),
    field('数量上限', limitInput, '1 ~ 3000，默认 800'),
    el('div', { class: 'form-actions' }, scanBtn),
    hint('扫描只读取文件名；真正执行前还需要在右侧二次确认。')
  );

  const bottom = card(
    '安全说明',
    '执行前请知悉以下边界',
    list([
      '重命名只改文件名，不会删除文件，也不会改动文件内容。',
      '勾选「按剧名 (年份)/建目录」时，文件会被移动到对应子目录（后端会自动创建目录）。',
      '目标文件已存在时视为冲突，默认不勾选、不覆盖，需要你手动处理。',
      '想先在命令行确认？导出 Bash / PowerShell 脚本，逐行检查后再在 NAS 上执行；脚本同样不覆盖已有文件。',
      '撤销只针对本工具最近一次执行的重命名；原文件名已被占用时无法恢复。',
    ], { class: 'list-check' })
  );

  root.appendChild(
    note('先预览、确认后再执行；执行前会自动记录撤销日志，可在本页一键撤销。', 'warn')
  );
  root.appendChild(split(left, out));
  root.appendChild(bottom);
}
