/**
 * 设置：外观与使用偏好（都保存在本机浏览器）。
 *
 * - 主题：浅色 / 深色 / 跟随系统
 * - 默认首页：打开应用后进入哪个页面
 * - 紧凑模式：减小卡片与页面留白，一屏看更多
 * - 操作二次确认：关闭后清理/停止等操作不再弹确认框（请谨慎）
 *
 * 文件目录授权由 fnOS「应用设置 → 可访问的文件」提供，本页不再重复管理。
 */

import { api, card, el, note, segmented, select, toast } from '../ui.js';

const HOME_OPTIONS = [
  ['checkup', '一键体检'],
  ['cleanup', '系统清理'],
  ['netdiag', '网络诊断'],
  ['security', '安全防护'],
  ['procs', '服务进程'],
  ['docker', 'Docker'],
  ['storage', '硬盘存储'],
  ['filemgr', '文件管理'],
  ['apps', '应用中心'],
  ['monitor', '监控仪表盘'],
  ['tools', '小工具'],
  ['about', '关于'],
];

export async function render(root) {
  let system = null;
  try {
    system = await api('/api/system');
  } catch { /* 读不到版本不影响设置 */ }

  const theme = localStorage.getItem('ss-theme') || 'light';
  const home = localStorage.getItem('ss-home') || 'apps';
  const compact = localStorage.getItem('ss-density') === 'compact';
  const confirmOn = localStorage.getItem('ss-confirm') !== 'off';

  root.append(
    card('概览', '当前版本与运行状态',
      el('div', { class: 'info-grid' },
        el('div', { class: 'info-item' },
          el('span', { class: 'info-label', text: '版本' }),
          el('span', { class: 'info-value', text: 'v' + ((system && system.app && system.app.version) || '—') })),
        el('div', { class: 'info-item' },
          el('span', { class: 'info-label', text: '访问密码' }),
          el('span', { class: 'info-value', text: system && system.authEnabled ? '已启用' : '未启用' })),
        el('div', { class: 'info-item info-wide' },
          el('span', { class: 'info-label', text: '数据目录' }),
          el('span', { class: 'info-value mono path-wrap', text: (system && system.dataDir) || '—' })))),

    /* ---------------- 外观 ---------------- */
    card('外观', '主题偏好保存在本机浏览器',
      el('div', { class: 'set-field' },
        el('span', { class: 'set-label', text: '主题' }),
        segmented(
          [
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色' },
            { value: 'auto', label: '跟随系统' },
          ],
          theme,
          (v) => {
            localStorage.setItem('ss-theme', v);
            const resolved = v === 'auto'
              ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
              : v;
            document.documentElement.dataset.theme = resolved;
            const btn = document.getElementById('theme-btn');
            if (btn) btn.textContent = resolved === 'dark' ? '🌙' : '☀️';
            toast('已切换主题', 'ok');
          }
        ))),

    /* ---------------- 使用偏好 ---------------- */
    card('使用偏好', '改完立即生效，保存在本机',
      el('div', { class: 'set-field' },
        el('span', { class: 'set-label', text: '默认首页' }),
        select(
          HOME_OPTIONS.map(([value, label]) => ({ value, label })),
          home,
          (v) => {
            localStorage.setItem('ss-home', v);
            toast('下次打开将进入该页面', 'ok');
          }
        ),
        el('span', { class: 'field-hint', text: '打开应用且地址栏没有指定页面时使用。' })),

      el('div', { class: 'set-divider' }),

      el('div', { class: 'set-field' },
        el('span', { class: 'set-label', text: '紧凑模式' }),
        el('label', { class: 'switch' },
          el('input', {
            type: 'checkbox',
            class: 'checkbox',
            checked: compact,
            onchange: (e) => {
              const on = e.target.checked;
              localStorage.setItem('ss-density', on ? 'compact' : '');
              document.documentElement.dataset.density = on ? 'compact' : '';
              toast(on ? '已开启紧凑模式' : '已关闭紧凑模式', 'ok');
            },
          }),
          el('span', { text: compact ? '开启后卡片与页面留白更小' : '关闭中，使用默认留白' })),
        el('span', { class: 'field-hint', text: '一屏能看更多内容，适合小屏或内容多的页面。' })),

      el('div', { class: 'set-divider' }),

      el('div', { class: 'set-field' },
        el('span', { class: 'set-label', text: '操作二次确认' }),
        el('label', { class: 'switch' },
          el('input', {
            type: 'checkbox',
            class: 'checkbox',
            checked: confirmOn,
            onchange: (e) => {
              const on = e.target.checked;
              localStorage.setItem('ss-confirm', on ? 'on' : 'off');
              window.__SS_CONFIRM__ = on;
              toast(on ? '已开启二次确认' : '已关闭二次确认，请谨慎操作', on ? 'ok' : 'warn');
            },
          }),
          el('span', { text: confirmOn ? '清理、停止、结束进程前会再确认' : '已关闭，操作将直接执行' })),
        el('span', { class: 'field-hint', text: '关闭后清理缓存、停止容器等操作不再弹确认框，误操作无法撤销。' }))),

    note('文件相关功能使用的目录由 fnOS「应用设置 → 可访问的文件」授权，本页不再单独管理。', 'info')
  );
}
