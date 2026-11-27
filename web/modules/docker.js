/**
 * Docker 治理：容器列表与启停、镜像清单、容器日志。
 */

import { action, api, badge, button, card, codeBlock, el, note, spinner, table, toast } from '../ui.js';

const STATE_KIND = { running: 'ok', exited: 'default', paused: 'warn', created: 'warn', dead: 'error' };

export async function render(root) {
  const out = el('div', { style: { display: 'grid', gap: '16px' } });
  const logBox = el('div');

  const refresh = button('刷新', () => action(refresh, load), { variant: 'primary' });

  root.append(
    card('Docker 治理', '查看容器与镜像、启停容器、查看日志（不会删除数据）',
      el('div', { class: 'form-actions' }, refresh)),
    out,
    logBox
  );

  async function doAction(name, act) {
    if (act === 'stop' && !window.confirm(`确定停止容器 ${name}？`)) return;
    try {
      await api('/api/docker/action', { name, action: act });
      toast(`${name}：${act} 成功`, 'ok');
      await load();
    } catch (err) {
      toast('操作失败：' + (err.message || err), 'error');
    }
  }

  async function showLogs(name) {
    logBox.replaceChildren(spinner('正在读取日志…'));
    try {
      const r = await api('/api/docker/logs?name=' + encodeURIComponent(name) + '&lines=200');
      logBox.replaceChildren(card(`容器日志 · ${name}`, `最近 ${r.lines} 行`,
        codeBlock(r.text || '（没有日志输出）')));
      logBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      logBox.replaceChildren(note('读取日志失败：' + (err.message || err), 'error'));
    }
  }

  async function load() {
    out.replaceChildren(spinner('正在读取 Docker 信息…'));
    try {
      const d = await api('/api/docker/overview');
      if (!d.available) {
        out.replaceChildren(note(d.error || '本机 Docker 不可用（未安装或未运行）', 'warn'));
        return;
      }
      const containers = d.containers || [];
      const images = d.images || [];

      const running = containers.filter((c) => c.state === 'running').length;

      out.replaceChildren(
        card('容器', `共 ${containers.length} 个，运行中 ${running} 个`,
          table(
            [
              { label: '名称', key: 'name' },
              { label: '镜像', key: 'image' },
              { label: '状态', render: (row) => badge(row.state || '', STATE_KIND[row.state] || 'default') },
              { label: '端口', key: 'ports' },
              {
                label: '操作',
                width: '210px',
                render: (row) => el('div', { class: 'row', style: { gap: '6px' } },
                  row.state === 'running'
                    ? button('停止', () => doAction(row.name, 'stop'), { variant: 'ghost' })
                    : button('启动', () => doAction(row.name, 'start'), { variant: 'ghost' }),
                  button('重启', () => doAction(row.name, 'restart'), { variant: 'ghost' }),
                  button('日志', () => showLogs(row.name), { variant: 'ghost' })),
              },
            ],
            containers,
            { empty: '没有容器' }
          )),
        card('镜像', `${images.length} 个镜像`,
          table(
            [
              { label: '镜像', key: 'ref' },
              { label: '大小', key: 'size', width: '100px' },
              { label: 'ID', key: 'id', width: '120px' },
            ],
            images,
            { empty: '没有镜像' }
          )),
        d.usage ? card('磁盘占用', 'docker system df', codeBlock(d.usage)) : null
      );
    } catch (err) {
      out.replaceChildren(note('读取失败：' + (err.message || err), 'error'));
    }
  }

  await load();
}
