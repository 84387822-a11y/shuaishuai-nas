'use strict';

/**
 * 硬件信息：CPU、内存条、主板/BIOS、网卡、温度、USB 设备。
 * 依赖 dmidecode（需要 root，本应用以 root 运行）、ethtool、sensors、lsusb；缺失时逐项降级。
 */

const fs = require('node:fs');
const os = require('node:os');

const { run, findBin } = require('../lib/util');

function readFile(file, max = 8192) {
  try {
    return fs.readFileSync(file, 'utf8').slice(0, max);
  } catch {
    return '';
  }
}

function cpuInfo() {
  const text = readFile('/proc/cpuinfo', 65536);
  const model = (/model name\s*:\s*(.+)/.exec(text) || [])[1] || os.cpus()[0]?.model || '';
  const cores = os.cpus().length;
  const mhz = os.cpus()[0]?.speed || 0;
  let temp = null;
  for (const zone of fs.existsSync('/sys/class/thermal') ? fs.readdirSync('/sys/class/thermal') : []) {
    const t = Number(readFile(`/sys/class/thermal/${zone}/temp`, 32).trim());
    if (Number.isFinite(t) && t > 0) {
      temp = Math.round(t / 1000);
      break;
    }
  }
  return { model, cores, mhz, temp };
}

async function memoryInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  const info = { total, free, used: total - free, modules: [] };

  const bin = findBin('dmidecode');
  if (!bin) return info;

  const r = await run(bin, ['-t', 'memory'], { timeout: 12000 });
  if (r.code !== 0) return info;

  const blocks = String(r.stdout || '').split('Memory Device');
  for (const block of blocks.slice(1)) {
    const size = (/Size:\s*(.+)/.exec(block) || [])[1]?.trim();
    if (!size || /No Module Installed|Unknown/i.test(size)) continue;
    info.modules.push({
      size,
      type: ((/Type:\s*(.+)/.exec(block) || [])[1] || '').trim(),
      speed: ((/Speed:\s*(.+)/.exec(block) || [])[1] || '').trim(),
      manufacturer: ((/Manufacturer:\s*(.+)/.exec(block) || [])[1] || '').trim(),
      part: ((/Part Number:\s*(.+)/.exec(block) || [])[1] || '').trim(),
      slot: ((/Locator:\s*(.+)/.exec(block) || [])[1] || '').trim(),
    });
  }
  return info;
}

async function boardInfo() {
  const out = { board: '', bios: '', serial: '' };
  const bin = findBin('dmidecode');
  if (!bin) return out;

  const r = await run(bin, ['-t', 'baseboard'], { timeout: 10000 });
  if (r.code === 0) {
    const t = String(r.stdout || '');
    out.board = [((/Manufacturer:\s*(.+)/.exec(t) || [])[1] || '').trim(), ((/Product Name:\s*(.+)/.exec(t) || [])[1] || '').trim()]
      .filter(Boolean).join(' ');
  }
  const b = await run(bin, ['-t', 'bios'], { timeout: 10000 });
  if (b.code === 0) {
    const t = String(b.stdout || '');
    out.bios = [((/Version:\s*(.+)/.exec(t) || [])[1] || '').trim(), ((/Release Date:\s*(.+)/.exec(t) || [])[1] || '').trim()]
      .filter(Boolean).join(' · ');
  }
  return out;
}

async function nicInfo() {
  const items = [];
  if (process.platform !== 'linux') {
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      items.push({ name, mac: (addrs && addrs[0] && addrs[0].mac) || '', ip: (addrs || []).filter((a) => a.family === 'IPv4').map((a) => a.address).join(', '), speed: '', state: 'unknown' });
    }
    return items;
  }

  const links = await run('ip', ['-br', 'link'], { timeout: 8000 });
  const addrs = await run('ip', ['-br', 'addr'], { timeout: 8000 });
  const ipMap = new Map();
  for (const line of String(addrs.stdout || '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (!parts[0]) continue;
    const m = /(\d+\.\d+\.\d+\.\d+)/.exec(line);
    ipMap.set(parts[0], m ? m[1] : '');
  }
  for (const line of String(links.stdout || '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (!parts[0]) continue;
    const name = parts[0];
    const mac = (parts.find((p) => /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(p)) || '').toLowerCase();
    const state = parts.includes('UP') ? 'connected' : 'down';
    items.push({ name, mac, ip: ipMap.get(name) || '', speed: '', state });
  }

  const eth = findBin('ethtool');
  if (eth) {
    for (const item of items.slice(0, 8)) {
      const r = await run(eth, [item.name], { timeout: 6000 });
      const speed = (/Speed:\s*(.+)/.exec(String(r.stdout || '')) || [])[1];
      if (speed) item.speed = speed.trim();
    }
  }
  return items;
}

async function sensorsInfo() {
  const bin = findBin('sensors');
  if (!bin) return { available: false, text: '' };
  const r = await run(bin, ['-j'], { timeout: 10000 });
  return { available: r.code === 0, text: String(r.stdout || '').slice(0, 4000) };
}

async function usbInfo() {
  const bin = findBin('lsusb');
  if (!bin) return [];
  const r = await run(bin, [], { timeout: 8000 });
  return String(r.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 30)
    .map((l) => {
      const m = /^Bus (\d+) Device (\d+): ID (\S+) (.+)$/.exec(l);
      return m ? { bus: m[1], device: m[2], id: m[3], name: m[4] } : { name: l };
    });
}

async function overview() {
  const [mem, board, nics, sensors, usb] = await Promise.all([
    memoryInfo(), boardInfo(), nicInfo(), sensorsInfo(), usbInfo(),
  ]);
  return {
    hostname: os.hostname(),
    platform: `${process.platform} ${os.release()}`,
    uptime: os.uptime(),
    cpu: cpuInfo(),
    memory: mem,
    board,
    nics,
    sensors,
    usb,
  };
}

module.exports = [
  ['GET', '/api/hardware/overview', overview],
];
