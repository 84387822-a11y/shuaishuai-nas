/**
 * 服务进程：占用最高的进程、启动失败的服务、监听端口。
 */

import { action, api, button, card, el, note, spinner, table, toast } from '../ui.js';

export async function render(root) {
  const out = el('div', { style: { display: 'grid', gap: '16px' } });
  const btn = button('刷新进程', () => action(btn, load), { variant: 'primary' });

  root.append(
    card('服务进程', '查看 CPU / 内存占用靠前的进程、启动失败的系统服务、正在监听的端口',
      el('div', { class: 'form-actions' }, btn),
      note('结束进程会向该进程发送 TERM 信号，关键系统进程已加入保护名单。', 'warn')),
    out
  );

  async function killProc(row) {
    if (!window.confirm(`确定结束进程 ${row.name}（PID ${row.pid}）？`)) return;
    try {
      await api('/api/procs/kill', { pid: row.pid });
      toast('已发送结束信号：' + row.name, 'ok');
      await load();
    } catch (err) {
      toast('结束失败：' + (err.message || err), 'error');
    }
  }

  async function load() {
    out.replaceChildren(spinner('正在读取进程…'));
    try {
      const d = await api('/api/procs');
      const procs = d.items || [];
      const services = d.services || [];
      const ports = d.ports || [];

      const killBtn = (row) => button('结束', () => killProc(row), { variant: 'ghost' });

      out.replaceChildren(
        card('进程占用 Top', `按 CPU 排序，共 ${procs.length} 条`,
          table(
            [
              { label: 'PID', key: 'pid', width: '80px' },
              { label: '进程', key: 'name' },
              { label: 'CPU %', key: 'cpu', width: '80px' },
              { label: '内存 %', key: 'mem', width: '80px' },
              { label: 'RSS(MB)', key: 'rss', width: '90px' },
              { label: '操作', render: (row) => killBtn(row), width: '80px' },
            ],
            procs,
            { empty: '没有读到进程信息（非 Linux 环境）' }
          )),
        card('启动失败的服务', services.length ? `${services.length} 个服务处于 failed 状态` : '没有失败的服务',
          table(
            [
              { label: '服务', key: 'unit' },
              { label: '状态', key: 'state' },
            ],
            services,
            { empty: '未发现失败服务' }
          )),
        card('监听端口', `${ports.length} 个端口在监听`,
          table(
            [
              { label: '地址', key: 'local' },
              { label: '进程', key: 'proc' },
            ],
            ports,
            { empty: '没有读到监听端口' }
          )),
        note(d.note || '', d.note ? 'info' : 'ok')
      );
    } catch (err) {
      out.replaceChildren(note('读取失败：' + (err.message || err), 'error'));
    }
  }

  await load();
}
