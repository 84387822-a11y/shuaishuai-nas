/**
 * 系统清理：扫描（只读）→ 按类别勾选 → 执行安全清理。
 * 版式：顶部可清理总量 + 占比条 + 分类卡片 + 结果条 + 风险说明。
 */

import { action, api, badge, button, card, el, note, spinner, toast } from '../ui.js';

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

export async function render(root) {
  let targets = [];
  let categories = [];
  let total = 0;
  const selected = new Set();

  const summary = el('div');
  const cardsBox = el('div', { class: 'clean-grid' });
  const resultBox = el('div');

  const scanBtn = button('重新扫描', () => action(scanBtn, scan), { variant: 'ghost' });
  const runBtn = button('清理选中', () => action(runBtn, runClean), { variant: 'primary' });

  root.append(
    card('系统清理', '只清理安全项：Docker 悬空镜像 / 构建缓存 / 已停止容器、7 天前的系统日志与临时文件',
      el('div', { class: 'set-row' }, scanBtn, runBtn,
        el('span', { class: 'hint', text: '点卡片即可勾选；标「需确认」的默认不勾选，执行前会再确认一次。' }))),
    summary,
    cardsBox,
    resultBox,
    el('details', { class: 'clean-note' },
      el('summary', { text: '清理边界与风险说明' }),
      el('ul', { class: 'clean-list' },
        el('li', { text: '只删除「安全清理」项：Docker 悬空镜像、构建缓存、已停止容器、7 天前的临时文件与系统日志归档。' }),
        el('li', { text: '标「需确认」的条目默认不勾选，需要你手动选中才会清理。' }),
        el('li', { text: '不会删除任何应用数据目录、共享目录或正在运行容器使用中的文件。' })))
  );

  function ratio(value) {
    return total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  }

  function pickedSize() {
    return targets.filter((t) => selected.has(t.id)).reduce((s, t) => s + (t.size || 0), 0);
  }

  function paintSummary() {
    const count = selected.size;
    const size = pickedSize();
    const label = runBtn.querySelector('span');
    if (label) label.textContent = count ? `清理选中 ${count} 项 · ${fmtSize(size)}` : '清理选中';

    summary.replaceChildren(
      card('可清理', `${targets.length} 项`,
        el('div', { class: 'clean-head' },
          el('div', { class: 'clean-big', text: fmtSize(total) }),
          el('div', { class: 'clean-sub', text: `可释放 · 已勾选 ${count} 项 ${fmtSize(size)}` }),
          el('span', { style: { flex: '1' } }),
          button('全选', () => { targets.forEach((t) => selected.add(t.id)); paintSummary(); paintCards(); }, { variant: 'ghost' }),
          button('清空', () => { selected.clear(); paintSummary(); paintCards(); }, { variant: 'ghost' })),
        el('div', { class: 'meter', style: { marginTop: '12px' } }, el('i', { style: { width: ratio(size) + '%' } })),
        el('div', { class: 'clean-legend' },
          ...categories.map((c) => el('span', { class: 'clean-legend-item' },
            el('i', { class: 'dot' }), `${c.name} ${fmtSize(c.size)}`))))
    );
  }

  function cardEl(t) {
    const box = el('input', { type: 'checkbox', class: 'checkbox' });
    box.checked = selected.has(t.id);
    const node = el('label', { class: 'clean-card' + (box.checked ? ' is-on' : '') },
      el('div', { class: 'clean-card-top' },
        box,
        t.safe ? badge('安全', 'ok') : badge('需确认', 'warn')),
      el('div', { class: 'clean-card-title', text: t.title }),
      el('div', { class: 'clean-card-size', text: fmtSize(t.size) }),
      el('div', { class: 'clean-card-meta', text: `${t.count || 1} 项` }));

    box.addEventListener('change', () => {
      if (box.checked) selected.add(t.id);
      else selected.delete(t.id);
      node.classList.toggle('is-on', box.checked);
      paintSummary();
    });
    return node;
  }

  function paintCards() {
    if (!targets.length) {
      cardsBox.replaceChildren(note('没有发现值得清理的内容。', 'ok'));
      return;
    }
    cardsBox.replaceChildren(...targets.map(cardEl));
  }

  async function scan() {
    summary.replaceChildren();
    cardsBox.replaceChildren(spinner('正在扫描…'));
    resultBox.replaceChildren();
    selected.clear();
    try {
      const d = await api('/api/cleanup/scan');
      targets = d.targets || [];
      categories = d.categories || [];
      total = d.total || 0;
      // 安全项默认勾选，用户点一下就能清理；「需确认」保持不勾选
      for (const t of targets) if (t.safe) selected.add(t.id);
      paintSummary();
      paintCards();
    } catch (err) {
      cardsBox.replaceChildren(note('扫描失败：' + (err.message || err), 'error'));
    }
  }

  async function runClean() {
    if (!selected.size) {
      toast('还没有勾选任何项：点一下卡片即可选中（「需确认」项需手动勾选）', 'warn');
      return;
    }
    const size = pickedSize();
    if (!window.confirm(`确认清理所选 ${selected.size} 项（约 ${fmtSize(size)}）？此操作不可撤销。`)) return;

    resultBox.replaceChildren(spinner('正在清理…'));
    try {
      const r = await api('/api/cleanup/run', { ids: [...selected] });
      const okCount = (r.results || []).filter((x) => x.ok).length;
      const failed = (r.results || []).filter((x) => !x.ok);
      resultBox.replaceChildren(
        note(`已清理 ${okCount} 项${failed.length ? `，${failed.length} 项失败` : ''}，约释放 ${fmtSize(size)}。`, failed.length ? 'warn' : 'ok'),
        failed.length
          ? el('ul', { class: 'clean-list' }, ...failed.map((x) => el('li', { text: `${x.id}：${x.detail || '失败'}` })))
          : null
      );
      await scan();
    } catch (err) {
      resultBox.replaceChildren(note('清理失败：' + (err.message || err), 'error'));
    }
  }

  await scan();
}
