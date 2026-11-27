/**
 * 文件管理：卷用量、按类型空间构成、目录浏览、大文件排行。
 * 只读；不做删除/移动，避免误操作。
 */

import {
  action, api, badge, button, card, el, note, select, spinner, stats, table, tabs, toast,
} from '../ui.js';

function fmtSize(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 4) return (v / 1024 ** 4).toFixed(2) + ' TB';
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(1) + ' GB';
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(1) + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function usageBar(pct, extraClass = '') {
  const level = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : '';
  return el('div', { class: 'meter ' + level + ' ' + extraClass }, el('i', { style: { width: Math.min(100, pct) + '%' } }));
}

export async function render(root) {
  let volumes = [];
  let roots = [];

  const volBox = el('div', { class: 'vol-grid' });
  const tabBox = el('div');

  try {
    const v = await api('/api/filemgr/volumes');
    volumes = v.items || [];
  } catch { /* 忽略 */ }

  try {
    const first = await api('/api/filemgr/list');
    roots = first.roots || [];
  } catch (err) {
    root.append(note('没有可浏览的目录：未检测到授权目录，也没有可用的存储卷。', 'warn'));
    return;
  }

  if (!roots.length) {
    root.append(note('没有可浏览的目录：未检测到授权目录，也没有可用的存储卷。', 'warn'));
    return;
  }

  const supported = volumes.filter((v) => !v.notSupported);
  volBox.replaceChildren(
    ...supported.slice(0, 6).map((v) => el('div', { class: 'vol-card' },
      el('div', { class: 'vol-mount', text: v.mount }),
      el('div', { class: 'vol-size', text: `${fmtSize(v.used)} / ${fmtSize(v.size)}` }),
      usageBar(v.usedPct, 'vol-meter'),
      el('div', { class: 'vol-meta', text: `已用 ${v.usedPct}% · 可用 ${fmtSize(v.avail)}` })))
  );

  root.append(
    card('文件管理', '查看各存储卷用量、按类型统计空间构成、浏览目录与大文件排行',
      note('本页只读：只做浏览与统计，不会删除或移动文件。', 'info')),
    supported.length ? card('存储卷', `${supported.length} 个分区`, volBox) : null,
    tabBox
  );

  /* ---------------- 分类统计 ---------------- */
  function analyzeTab() {
    const box = el('div', { style: { display: 'grid', gap: '14px' } });
    const pathSelect = select(roots.map((r) => ({ value: r, label: r })), roots[0], () => {});
    const out = el('div', { style: { display: 'grid', gap: '14px' } });
    const runBtn = button('开始统计', () => action(runBtn, run), { variant: 'primary' });

    box.append(el('div', { class: 'set-row' }, pathSelect, runBtn,
      el('span', { class: 'hint', text: '统计有数量/时长上限，超大目录会显示「部分结果」。' })), out);

    async function run() {
      out.replaceChildren(spinner('正在统计…'));
      let d;
      try {
        d = await api('/api/filemgr/analyze?path=' + encodeURIComponent(pathSelect.value));
      } catch (err) {
        out.replaceChildren(note('统计失败：' + (err.message || err), 'error'));
        return;
      }
      const cats = d.categories || [];
      const biggest = cats.length ? cats[0].size : 0;
      out.replaceChildren(
        stats([
          { label: '文件总数', value: String(d.files), sub: '个' },
          { label: '总占用', value: fmtSize(d.totalSize), sub: '已扫描部分' },
          { label: '分类', value: String(cats.length), sub: '类' },
          { label: '耗时', value: (d.elapsedMs / 1000).toFixed(1) + ' s', sub: d.truncated ? '结果不完整' : '完整' },
        ]),
        el('div', { class: 'two-col' },
          card('空间构成', '按文件类型',
            el('div', { class: 'type-list' },
              ...cats.map((c) => el('div', { class: 'type-row' },
                el('div', { class: 'type-main' },
                  el('span', { class: 'type-label', text: c.label }),
                  el('span', { class: 'type-count', text: `${c.count} 个文件` })),
                el('div', { class: 'type-bar' },
                  el('div', { class: 'meter' }, el('i', { style: { width: (biggest ? Math.round((c.size / biggest) * 100) : 0) + '%' } }))),
                el('span', { class: 'type-size', text: fmtSize(c.size) }))))),
          card('最大的文件', `Top ${(d.largest || []).length}`,
            table(
              [
                { label: '文件', render: (row) => el('span', { text: row.name, title: row.path }) },
                { label: '大小', width: '96px', render: (row) => fmtSize(row.size) },
              ],
              d.largest || [],
              { empty: '没有文件' }
            )))
      );
    }
    return box;
  }

  /* ---------------- 目录浏览 ---------------- */
  function browseTab() {
    const box = el('div', { style: { display: 'grid', gap: '12px' } });
    const crumb = el('div', { class: 'crumb' });
    const out = el('div');
    let current = roots[0];

    box.append(crumb, out);

    async function open(p) {
      out.replaceChildren(spinner('读取目录…'));
      let d;
      try {
        d = await api('/api/filemgr/list' + (p ? '?path=' + encodeURIComponent(p) : ''));
      } catch (err) {
        out.replaceChildren(note('读取失败：' + (err.message || err), 'error'));
        return;
      }
      current = d.path;
      crumb.replaceChildren(
        d.parent ? button('↑ 上一级', () => open(d.parent), { variant: 'ghost' }) : null,
        el('span', { class: 'crumb-path mono', text: current }));

      const rows = (d.entries || []).map((e) => ({
        ...e,
        sizeText: e.isDir ? '—' : fmtSize(e.size),
        timeText: fmtTime(e.mtime),
        open: () => (e.isDir ? open(e.path) : toast('只读模式，不打开文件', 'warn')),
      }));

      out.replaceChildren(table(
        [
          { label: '名称', render: (row) => el('button', { class: 'link-btn', text: (row.isDir ? '📁 ' : '📄 ') + row.name, onclick: row.open }) },
          { label: '大小', width: '110px', render: (row) => row.sizeText },
          { label: '修改时间', width: '160px', render: (row) => row.timeText },
        ],
        rows,
        { empty: '空目录' }
      ));
    }

    open(current);
    return box;
  }

  /* ---------------- 大文件 ---------------- */
  function largeTab() {
    const box = el('div', { style: { display: 'grid', gap: '14px' } });
    const pathSelect = select(roots.map((r) => ({ value: r, label: r })), roots[0], () => {});
    const out = el('div');
    const runBtn = button('扫描大文件', () => action(runBtn, run), { variant: 'primary' });

    box.append(el('div', { class: 'set-row' }, pathSelect, runBtn), out);

    async function run() {
      out.replaceChildren(spinner('正在扫描…'));
      try {
        const d = await api('/api/filemgr/analyze?path=' + encodeURIComponent(pathSelect.value));
        out.replaceChildren(table(
          [
            { label: '文件', render: (row) => el('span', { text: row.name, title: row.path }) },
            { label: '路径', render: (row) => el('span', { class: 'mono muted path-wrap', text: row.path }) },
            { label: '大小', width: '96px', render: (row) => fmtSize(row.size) },
          ],
          d.largest || [],
          { empty: '没有文件' }
        ));
      } catch (err) {
        out.replaceChildren(note('扫描失败：' + (err.message || err), 'error'));
      }
    }
    return box;
  }

  tabBox.append(tabs([
    { label: '分类统计', render: analyzeTab },
    { label: '目录浏览', render: browseTab },
    { label: '大文件', render: largeTab },
  ]));
}
