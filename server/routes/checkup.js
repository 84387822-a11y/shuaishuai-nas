'use strict';

/**
 * 一键体检：汇总磁盘、内存、负载、SMART、Docker 的关键指标，给出问题清单。
 * 全部只读；命令缺失或平台不支持时自动跳过，不报错。
 */

const fs = require('node:fs');
const os = require('node:os');

const { run, findBin } = require('../lib/util');

function levelOf(ok, warn) {
  if (ok) return 'ok';
  return warn ? 'warn' : 'bad';
}

async function diskItems() {
  const items = [];
  if (process.platform !== 'linux') {
    const total = os.totalmem();
    items.push({ id: 'platform', title: '平台', level: 'warn', summary: '非 Linux 环境，磁盘检查已跳过', detail: '' });
    void total;
    return items;
  }

  const df = await run('df', ['-kP'], { timeout: 8000 });
  const lines = String(df.stdout || '').split('\n').slice(1);
  let checked = 0;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [dev, sizeK, usedK, availK, pctStr, mount] = parts;
    if (['tmpfs', 'devtmpfs', 'overlay', 'squashfs'].includes(dev) && !mount.startsWith('/vol')) continue;
    const pct = Number(String(pctStr).replace('%', ''));
    if (!Number.isFinite(pct) || pct <= 0) continue;
    checked += 1;
    const level = pct >= 95 ? 'bad' : pct >= 85 ? 'warn' : 'ok';
    items.push({
      id: 'disk:' + mount,
      title: `磁盘空间 ${mount}`,
      level,
      summary: `已用 ${pct}%（剩余 ${Math.round(Number(availK) / 1024)} MB / 共 ${Math.round(Number(sizeK) / 1024)} MB）`,
      detail: `设备 ${dev}`,
    });
  }
  if (!checked) items.push({ id: 'disk', title: '磁盘空间', level: 'warn', summary: '未读到磁盘信息', detail: '' });
  return items;
}

async function memoryItem() {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPct = total ? Math.round(((total - free) / total) * 100) : 0;
  const level = usedPct >= 95 ? 'bad' : usedPct >= 85 ? 'warn' : 'ok';
  return {
    id: 'memory',
    title: '内存占用',
    level,
    summary: `已用 ${usedPct}%（${Math.round((total - free) / 1048576)} MB / ${Math.round(total / 1048576)} MB）`,
    detail: '',
  };
}

function loadItem() {
  const cores = os.cpus().length || 1;
  const [l1, l5] = os.loadavg();
  const ratio = l1 / cores;
  const level = ratio >= 1.5 ? 'bad' : ratio >= 0.8 ? 'warn' : 'ok';
  return {
    id: 'load',
    title: '系统负载',
    level,
    summary: `1 分钟 ${l1.toFixed(2)} / 5 分钟 ${l5.toFixed(2)}（${cores} 核）`,
    detail: ratio >= 1 ? '负载高于核数，可能有进程占满 CPU' : '',
  };
}

async function smartItems() {
  const items = [];
  const bin = findBin('smartctl');
  if (!bin) {
    items.push({ id: 'smart', title: '硬盘 SMART', level: 'warn', summary: '未安装 smartctl，跳过健康检测', detail: '' });
    return items;
  }
  const scan = await run(bin, ['--scan'], { timeout: 8000 });
  const devs = String(scan.stdout || '')
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((d) => d && d.startsWith('/dev/'));
  for (const dev of devs.slice(0, 8)) {
    const r = await run(bin, ['-H', '-n', 'standby', dev], { timeout: 10000 });
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    // 只认健康结论那一行，避免把 "open device failed" 之类误判成硬盘故障
    const healthLine = /SMART overall-health self-assessment test result:\s*(\S+)/i.exec(out)
      || /SMART Health Status:\s*(\S+)/i.exec(out);
    const verdict = healthLine ? healthLine[1].toUpperCase() : '';
    const pass = Boolean(verdict) && verdict.startsWith('PASS');
    const fail = Boolean(verdict) && verdict.startsWith('FAIL');
    items.push({
      id: 'smart:' + dev,
      title: 'SMART ' + dev,
      level: fail ? 'bad' : pass ? 'ok' : 'warn',
      summary: fail ? '健康状态异常（FAILED）' : pass ? '健康状态正常' : '无法读取健康状态',
      detail: out.split('\n').filter((l) => /result|SMART overall/i.test(l)).join(' ').slice(0, 200),
    });
  }
  if (!items.length) items.push({ id: 'smart', title: '硬盘 SMART', level: 'warn', summary: '没有检测到可查询的磁盘', detail: '' });
  return items;
}

async function dockerItem() {
  const bin = findBin('docker');
  if (!bin) return { id: 'docker', title: 'Docker', level: 'ok', summary: '未安装 Docker，跳过', detail: '' };

  const ps = await run(bin, ['ps', '-a', '--format', '{{.Names}}\t{{.State}}'], { timeout: 10000 });
  if (ps.code !== 0) {
    return { id: 'docker', title: 'Docker', level: 'warn', summary: 'Docker 未运行或无权访问', detail: String(ps.stderr || '').slice(0, 160) };
  }
  const lines = String(ps.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  let exited = 0;
  let running = 0;
  const exitedNames = [];
  for (const line of lines) {
    const [name, state] = line.split('\t');
    if (state === 'running') running += 1;
    else {
      exited += 1;
      if (exitedNames.length < 5) exitedNames.push(name);
    }
  }
  const level = exited >= 3 ? 'warn' : 'ok';
  return {
    id: 'docker',
    title: 'Docker 容器',
    level,
    summary: `运行中 ${running} 个，未运行 ${exited} 个`,
    detail: exitedNames.length ? '未运行：' + exitedNames.join('、') : '',
  };
}

async function scan() {
  const items = [
    await memoryItem(),
    loadItem(),
    ...(await diskItems()),
    ...(await smartItems()),
    await dockerItem(),
  ];
  const bad = items.filter((i) => i.level === 'bad').length;
  const warn = items.filter((i) => i.level === 'warn').length;
  const ok = items.filter((i) => i.level === 'ok').length;
  return {
    scanned_at: new Date().toISOString(),
    summary: { ok, warn, bad, total: items.length },
    items,
    host: { hostname: os.hostname(), platform: process.platform, release: os.release(), uptime: os.uptime() },
  };
}

async function history() {
  // 体检结果不落库，只返回空历史，保持接口形状稳定
  return { items: [] };
}

module.exports = [
  ['GET', '/api/checkup/scan', scan],
  ['GET', '/api/checkup/history', history],
];
