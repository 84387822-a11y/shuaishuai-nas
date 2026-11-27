/**
 * 硬盘存储：磁盘健康与容量、分区占用。
 * 版式：顶部汇总数字 → 磁盘表 → 分区表（带占用条）。
 */

import { api, badge, card, el, note, spinner, stats, table } from '../ui.js';

function fmtSize(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 4) return (v / 1024 ** 4).toFixed(2) + ' TB';
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(1) + ' GB';
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(0) + ' MB';
  return Math.round(v / 1024) + ' KB';
}

function healthBadge(row) {
  if (row.health === 'PASSED') return badge('正常', 'ok');
  if (row.health === 'FAILED') return badge('异常', 'error');
  return badge('未知', 'default');
}

function usageBar(pct) {
  const level = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : '';
  return el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '150px' } },
    el('div', { class: 'meter ' + level, style: { flex: '1' } }, el('i', { style: { width: Math.min(100, pct) + '%' } })),
    el('span', { class: 'muted', style: { fontSize: '11.5px', width: '34px', textAlign: 'right' }, text: pct + '%' }));
}

export async function render(root) {
  const out = el('div', { style: { display: 'grid', gap: '16px' } });
  root.append(out);
  out.append(spinner('正在读取磁盘信息…'));

  let d;
  try {
    d = await api('/api/storage/overview');
  } catch (err) {
    out.replaceChildren(note('读取失败：' + (err.message || err), 'error'));
    return;
  }

  const s = d.summary || {};
  const disks = d.disks || [];
  const parts = d.partitions || [];

  out.replaceChildren(
    stats([
      { label: '磁盘数量', value: String(s.diskCount ?? disks.length), sub: '块' },
      { label: '磁盘总容量', value: fmtSize(s.totalSize), sub: '物理容量' },
      { label: '已用 / 可用', value: `${fmtSize(s.totalUsed)} / ${fmtSize(s.totalAvail)}`, sub: '按分区统计' },
      { label: '整体占用', value: `${s.usedPct ?? 0}%`, sub: '分区加权' },
    ]),

    card('磁盘', '型号、类型、温度与 SMART 健康状态',
      table(
        [
          { label: '设备', key: 'name', width: '88px' },
          { label: '型号', render: (row) => row.model || '—' },
          { label: '类型', render: (row) => badge(row.type || '—', 'default'), width: '72px' },
          { label: '容量', render: (row) => fmtSize(row.size), width: '96px' },
          { label: '温度', render: (row) => (row.temp ? `${row.temp} °C` : '—'), width: '80px' },
          { label: '健康', render: healthBadge, width: '80px' },
        ],
        disks,
        { empty: '没有读到磁盘（非 Linux 环境或权限不足）' }
      )),

    card('分区占用', `${parts.length} 个已挂载分区`,
      table(
        [
          { label: '挂载点', key: 'mount' },
          { label: '设备', key: 'dev' },
          { label: '容量', render: (row) => fmtSize(row.size), width: '100px' },
          { label: '已用', render: (row) => fmtSize(row.used), width: '100px' },
          { label: '可用', render: (row) => fmtSize(row.avail), width: '100px' },
          { label: '占用', render: (row) => usageBar(row.usedPct), width: '190px' },
        ],
        parts,
        { empty: '没有分区信息' }
      ))
  );
}
