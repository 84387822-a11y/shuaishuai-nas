'use strict';

/**
 * 服务进程：CPU/内存占用最高的进程、失败的系统服务、监听端口。
 * 全部只读；非 Linux 或缺少命令时返回空列表。
 */

const { run, findBin, str, badRequest } = require('../lib/util');

/** 允许被结束的进程保护名单（避免误杀关键进程）。 */
const PROTECTED = /^(systemd|init|sshd|dockerd|containerd|trim|fnos|node)$/i;

async function top() {
  const items = [];
  if (process.platform !== 'linux') {
    return { items, services: [], ports: [], note: '非 Linux 环境，进程信息不可用' };
  }

  const ps = await run('ps', ['-eo', 'pid,comm,%cpu,%mem,rss', '--sort=-%cpu'], { timeout: 10000 });
  const lines = String(ps.stdout || '').split('\n').slice(1).filter(Boolean).slice(0, 20);
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const [pid, comm, cpu, mem, rss] = parts;
    items.push({
      pid: Number(pid),
      name: comm,
      cpu: Number(cpu) || 0,
      mem: Number(mem) || 0,
      rss: Math.round((Number(rss) || 0) / 1024),
    });
  }

  let services = [];
  if (findBin('systemctl')) {
    const s = await run('systemctl', ['--failed', '--no-legend', '--plain'], { timeout: 10000 });
    services = String(s.stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((l) => {
        const [unit, ...rest] = l.split(/\s+/);
        return { unit, state: rest.join(' ').slice(0, 80) };
      });
  }

  let ports = [];
  if (findBin('ss')) {
    const p = await run('ss', ['-lntup'], { timeout: 10000 });
    ports = String(p.stdout || '')
      .split('\n')
      .slice(1)
      .filter(Boolean)
      .slice(0, 40)
      .map((l) => {
        const parts = l.trim().split(/\s+/);
        const local = parts[4] || '';
        const proc = (parts[6] || '').replace(/users:\(\("/, '').replace(/"\)\)?.*$/, '');
        return { local, proc };
      })
      .filter((x) => x.local);
  }

  return { items, services, ports };
}

async function kill(ctx) {
  const pid = Number(ctx.body && ctx.body.pid);
  if (!Number.isInteger(pid) || pid <= 1) throw badRequest('pid 不合法');
  if (process.platform !== 'linux') throw badRequest('当前环境不支持结束进程');
  const ps = await run('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 5000 });
  const comm = String(ps.stdout || '').trim();
  if (!comm) throw badRequest('进程不存在：' + pid);
  if (PROTECTED.test(comm)) throw badRequest('受保护进程，拒绝结束：' + comm);
  const r = await run('kill', ['-TERM', String(pid)], { timeout: 5000 });
  if (r.code !== 0) throw badRequest('结束失败：' + String(r.stderr || '').slice(0, 120));
  return { pid, name: comm, signal: 'TERM' };
}

module.exports = [
  ['GET', '/api/procs', top],
  ['POST', '/api/procs/kill', kill],
];
