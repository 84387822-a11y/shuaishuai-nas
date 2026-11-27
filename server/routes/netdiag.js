'use strict';

/**
 * 网络诊断：连通性（DNS + TCP 时延）、流量统计、路由追踪、局域网设备、下载测速。
 * 只做只读探测；不抓包、不改网络配置。
 */

const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns').promises;

const { run, findBin, str, badRequest } = require('../lib/util');

const DEFAULT_HOSTS = [
  { key: 'github', name: 'GitHub', host: 'github.com', port: 443 },
  { key: 'dockerhub', name: 'Docker Hub', host: 'registry-1.docker.io', port: 443 },
  { key: 'aliyun', name: '阿里云', host: 'mirrors.aliyun.com', port: 443 },
  { key: 'baidu', name: '百度', host: 'www.baidu.com', port: 443 },
  { key: 'tmdb', name: 'TMDB', host: 'api.themoviedb.org', port: 443 },
];

function tcpLatency(host, port, timeout = 4000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const done = (ok, extra) => {
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, ...extra });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, { error: '连接超时' }));
    socket.once('error', (err) => done(false, { error: err.code || err.message }));
  });
}

async function ping(ctx) {
  const raw = ctx.query && ctx.query.get('hosts');
  let hosts = DEFAULT_HOSTS;
  if (raw) {
    hosts = String(raw)
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)
      .slice(0, 12)
      .map((h) => {
        const [host, port] = h.split(':');
        return { key: host, name: host, host, port: Number(port) || 443 };
      });
  }

  // 并行探测，避免串行等待把总耗时拉长
  const items = await Promise.all(hosts.map(async (item) => {
    let ip = '';
    let dnsOk = false;
    try {
      const rec = await dns.lookup(item.host);
      ip = rec.address;
      dnsOk = true;
    } catch {
      dnsOk = false;
    }
    const tcp = dnsOk ? await tcpLatency(item.host, item.port) : { ok: false, ms: 0, error: 'DNS 解析失败' };
    return {
      key: item.key,
      name: item.name,
      host: item.host,
      port: item.port,
      ip,
      dns_ok: dnsOk,
      ok: Boolean(dnsOk && tcp.ok),
      ms: tcp.ok ? tcp.ms : null,
      error: tcp.error || '',
    };
  }));

  const reachable = items.filter((i) => i.ok);
  const avg = reachable.length ? Math.round(reachable.reduce((s, i) => s + i.ms, 0) / reachable.length) : 0;
  return {
    checked_at: new Date().toISOString(),
    total: items.length,
    ok_count: reachable.length,
    avg_ms: avg,
    items,
  };
}

/* 流量：两次采样差分，按接口累计 */
let lastTraffic = null;
function readNetDev() {
  try {
    const text = fs.readFileSync('/proc/net/dev', 'utf8');
    const out = {};
    for (const line of text.split('\n').slice(2)) {
      const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      const name = m[1].trim();
      const nums = m[2].trim().split(/\s+/).map(Number);
      out[name] = { rx: nums[0] || 0, tx: nums[8] || 0 };
    }
    return out;
  } catch {
    return null;
  }
}

function traffic() {
  const snap = readNetDev();
  if (!snap) {
    const os = require('node:os');
    const nets = os.networkInterfaces();
    const items = Object.keys(nets).map((name) => ({ name, rx: 0, tx: 0, rx_rate: 0, tx_rate: 0 }));
    return { available: false, items, note: '非 Linux 环境，只能列出接口' };
  }
  const now = Date.now();
  const prev = lastTraffic;
  const dt = prev ? Math.max(0.5, (now - prev.at) / 1000) : 0;
  const items = Object.entries(snap).map(([name, cur]) => {
    const before = prev && prev.data[name];
    const rxRate = before && dt ? Math.max(0, (cur.rx - before.rx) / dt) : 0;
    const txRate = before && dt ? Math.max(0, (cur.tx - before.tx) / dt) : 0;
    return { name, rx: cur.rx, tx: cur.tx, rx_rate: Math.round(rxRate), tx_rate: Math.round(txRate) };
  });
  lastTraffic = { at: now, data: snap };
  return { available: true, items };
}

async function traceroute(ctx) {
  const host = str(ctx.query && ctx.query.get('host'), 'host', { max: 128 }) || 'github.com';
  if (!/^[A-Za-z0-9.-]+$/.test(host)) throw badRequest('主机名不合法');
  const bin = findBin('traceroute') || findBin('tracert');
  if (!bin) return { host, available: false, text: '', note: '本机没有 traceroute/tracert' };

  const r = await run(bin, ['-n', '-w', '1', '-m', '16', host], { timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
  const text = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  return { host, available: true, text: text.slice(0, 8000) };
}

async function lan() {
  const items = [];
  if (process.platform === 'linux' && findBin('ip')) {
    const r = await run('ip', ['neigh'], { timeout: 8000 });
    for (const line of String(r.stdout || '').split('\n')) {
      const m = /^(\d+\.\d+\.\d+\.\d+)\s+dev\s+(\S+)\s+lladdr\s+([0-9a-f:]{17})\s+(\S+)/i.exec(line.trim());
      if (m) items.push({ ip: m[1], dev: m[2], mac: m[3], state: m[4] });
    }
  } else if (findBin('arp')) {
    const r = await run('arp', ['-a'], { timeout: 8000 });
    for (const line of String(r.stdout || '').split('\n')) {
      const m = /(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f-]{17})/i.exec(line);
      if (m) items.push({ ip: m[1], dev: '', mac: m[2].replace(/-/g, ':'), state: '' });
    }
  }
  return { items, count: items.length };
}

async function speed(ctx) {
  const url = str(ctx.query && ctx.query.get('url'), 'url', { max: 512 })
    || 'https://speed.cloudflare.com/__down?bytes=20000000';
  if (!/^https?:\/\//i.test(url)) throw badRequest('测速地址必须是 http(s)');

  const started = Date.now();
  let bytes = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'ShuaiShuaiNAS-NetDiag/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (Date.now() - started > 20000) {
        try { controller.abort(); } catch { /* ignore */ }
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  const seconds = Math.max(0.3, (Date.now() - started) / 1000);
  return {
    url,
    bytes,
    seconds: Number(seconds.toFixed(2)),
    mbps: Number(((bytes * 8) / seconds / 1e6).toFixed(2)),
  };
}

module.exports = [
  ['GET', '/api/netdiag/ping', ping],
  ['GET', '/api/netdiag/traffic', traffic],
  ['GET', '/api/netdiag/traceroute', traceroute],
  ['GET', '/api/netdiag/lan', lan],
  ['GET', '/api/netdiag/speed', speed],
];
