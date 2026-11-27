/**
 * 一键体检：汇总磁盘/内存/负载/SMART/Docker，列出问题项。
 */

import { action, api, badge, button, card, el, note, spinner, stats } from '../ui.js';

const LEVEL = {
  ok: { text: '正常', kind: 'ok' },
  warn: { text: '注意', kind: 'warn' },
  bad: { text: '异常', kind: 'error' },
};

export async function render(root) {
  const out = el('div', { style: { display: 'grid', gap: '16px' } });
  let scanning = false;

  const btn = button('开始体检', () => action(btn, run), { variant: 'primary' });

  root.append(
    card('一键体检', '检查磁盘空间、内存、负载、硬盘 SMART 与 Docker 容器，只读不改动系统',
      el('div', { class: 'form-actions' }, btn)),
    out
  );

  async function run() {
    if (scanning) return;
    scanning = true;
    out.replaceChildren(spinner('正在体检，可能需要十几秒…'));
    try {
      const d = await api('/api/checkup/scan');
      const s = d.summary || { ok: 0, warn: 0, bad: 0 };
      out.replaceChildren(
        stats([
          { label: '正常', value: s.ok, sub: '项' },
          { label: '注意', value: s.warn, sub: '项' },
          { label: '异常', value: s.bad, sub: '项' },
        ]),
        el('div', { class: 'list' },
          ...(d.items || []).map((it) => {
            const lv = LEVEL[it.level] || LEVEL.ok;
            return el('div', { class: 'row', style: { alignItems: 'flex-start', gap: '12px', padding: '10px 0' } },
              el('div', { style: { display: 'grid', gap: '4px', flex: '1' } },
                el('strong', { text: it.title }),
                el('span', { class: 'muted', text: it.summary }),
                it.detail ? el('span', { class: 'muted', style: { fontSize: '12px' }, text: it.detail }) : null),
              badge(lv.text, lv.kind));
          })),
        note(`检测时间 ${d.scanned_at || ''} · 主机 ${(d.host && d.host.hostname) || ''}`, 'info')
      );
    } catch (err) {
      out.replaceChildren(note('体检失败：' + (err.message || err), 'error'));
    } finally {
      scanning = false;
    }
  }
}
