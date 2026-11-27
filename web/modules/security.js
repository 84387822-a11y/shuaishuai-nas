/**
 * 安全防护：只读安全检查（SSH、账号、对外端口、防火墙、失败登录），给出评分与建议。
 * 不修改任何系统配置，也不做扫描/隔离。
 */

import { action, api, badge, button, card, el, note, spinner, table } from '../ui.js';

const LEVEL = {
  high: { text: '高危', kind: 'error', order: 0 },
  medium: { text: '中危', kind: 'warn', order: 1 },
  low: { text: '提示', kind: 'default', order: 2 },
  ok: { text: '正常', kind: 'ok', order: 3 },
  unknown: { text: '未知', kind: 'default', order: 4 },
};

const SCORE_HINT = {
  good: '整体状态良好，保持定期检查即可。',
  warn: '存在需要关注的项目，建议按提示逐项处理。',
  bad: '存在较高风险项，建议优先处理高危问题。',
};

export async function render(root) {
  const out = el('div', { style: { display: 'grid', gap: '16px' } });
  const scanBtn = button('重新检查', () => action(scanBtn, run), { variant: 'primary' });

  root.append(
    card('安全防护', '检查 SSH 配置、账号安全、对外端口、防火墙与失败登录；只读，不修改系统',
      el('div', { class: 'set-row' }, scanBtn,
        el('span', { class: 'hint', text: '检查结果仅代表当前配置状态，不替代专业安全审计。' }))),
    out
  );

  async function run() {
    out.replaceChildren(spinner('正在检查…'));
    let d;
    try {
      d = await api('/api/security/overview');
    } catch (err) {
      out.replaceChildren(note('检查失败：' + (err.message || err), 'error'));
      return;
    }

    const c = d.counts || {};
    const items = [...(d.items || [])].sort((a, b) => (LEVEL[a.level]?.order ?? 9) - (LEVEL[b.level]?.order ?? 9));
    const unscored = d.score === null || d.score === undefined;
    const meterClass = d.level === 'bad' ? 'danger' : d.level === 'warn' ? 'warn' : '';

    out.replaceChildren(
      // 评分卡
      el('section', { class: 'card' },
        el('div', { class: 'score-row' },
          el('div', { class: `score-num score-${d.level}`, text: String(d.score) }),
          el('div', { class: 'score-meta' },
            el('div', { class: 'score-title' },
              el('strong', { text: d.level_text || '' }),
              badge(`${c.high || 0} 高危`, (c.high || 0) ? 'error' : 'ok'),
              badge(`${c.medium || 0} 中危`, (c.medium || 0) ? 'warn' : 'ok'),
              badge(`${c.low || 0} 提示`, 'default')),
            el('div', { class: 'meter ' + meterClass, style: { marginTop: '10px' } }, el('i', { style: { width: (unscored ? 0 : d.score) + '%' } })),
            el('div', { class: 'hint', style: { marginTop: '8px' }, text: unscored ? '当前环境读不到系统配置（非 Linux 或权限不足），无法给出评分。' : (SCORE_HINT[d.level] || '') })))),

      // 检查项
      card('检查项', `${items.length} 项`,
        table(
          [
            { label: '检查项', render: (row) => el('span', { text: row.title }) },
            { label: '结果', width: '84px', render: (row) => badge(LEVEL[row.level]?.text || '未知', LEVEL[row.level]?.kind || 'default') },
            { label: '说明', render: (row) => el('span', { class: 'muted', text: row.detail || '—' }) },
          ],
          items,
          { empty: '没有检查结果' }
        )),

      // 对外端口
      (d.listening || []).length
        ? card('对外监听端口', `共 ${d.listening.length} 个（0.0.0.0 / ::）`,
          table(
            [
              { label: '端口', key: 'port', width: '80px' },
              { label: '协议', key: 'proto', width: '70px' },
              { label: '监听地址', key: 'local' },
              { label: '进程', render: (row) => el('span', { class: 'mono', text: row.proc || '—' }) },
            ],
            d.listening,
            { empty: '没有对外监听端口' }
          ))
        : null,

      note(`检查时间 ${d.scanned_at || ''} · 本页只做只读检测，不会修改 SSH、防火墙或账号配置。高危项处理前请先在局域网内确认可回退。`, 'info')
    );
  }

  await run();
}
