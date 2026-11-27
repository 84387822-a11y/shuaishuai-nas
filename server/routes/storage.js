'use strict';

/**
 * 硬盘存储：磁盘清单（型号/容量/温度/健康）、分区占用、总容量汇总。
 * 全部只读；smartctl / lsblk 缺失时自动降级。
 */

const fs = require('node:fs');
const path = require('node:path');

const { run, findBin } = require('../lib/util');

const SKIP_PREFIX = ['loop', 'ram', 'dm-', 'md', 'sr', 'zram', 'nbd'];

function readFile(file, max = 4096) {
  try {
    return fs.readFileSync(file, 'utf8').slice(0, max);
  } catch {
    return '';
  }
}

/** 从 /sys/block 读取磁盘基础信息（不依赖 lsblk）。 */
function sysDisks() {
  const base = '/sys/block';
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  const disks = [];
  for (const name of names) {
    if (SKIP_PREFIX.some((p) => name.startsWith(p))) continue;
    const dir = path.join(base, name);
    const sectors = Number(readFile(path.join(dir, 'size'), 32).trim()) || 0;
    const size = sectors * 512;
    if (!size) continue;
    const rotational = readFile(path.join(dir, 'queue/rotational'), 8).trim();
    const model = readFile(path.join(dir, 'device/model'), 128).trim();
    const vendor = readFile(path.join(dir, 'device/vendor'), 64).trim();
    const serial = readFile(path.join(dir, 'device/serial'), 64).trim();
    let temp = null;
    for (const hw of ['hwmon0', 'hwmon1', 'hwmon2']) {
      const t = Number(readFile(path.join(dir, 'device', hw, 'temp1_input'), 32).trim());
      if (Number.isFinite(t) && t > 0) { temp = Math.round(t / 1000); break; }
    }
    disks.push({
      name,
      dev: '/dev/' + name,
      size,
      model: [vendor, model].filter(Boolean).join(' ').trim(),
      serial,
      type: rotational === '0' ? 'SSD' : 'HDD',
      temp,
      health: '',
    });
  }
  return disks;
}

/** smartctl 健康状态与温度。 */
async function enrichSmart(disks) {
  const bin = findBin('smartctl');
  if (!bin) return disks;
  for (const disk of disks.slice(0, 8)) {
    let r = await run(bin, ['-H', '-A', '-n', 'standby', disk.dev], { timeout: 12000 });
    let out = `${r.stdout || ''}\n${r.stderr || ''}`;
    // 有些 USB 硬盘盒 / 桥接芯片对 -n standby 不友好，读不到结论时再试一次
    if (!/overall-health|Health Status/i.test(out)) {
      r = await run(bin, ['-H', '-A', disk.dev], { timeout: 12000 });
      out = `${r.stdout || ''}\n${r.stderr || ''}`;
    }
    // 只认健康结论那一行，避免把 "open device failed" 之类误判成硬盘故障
    const healthLine = /SMART overall-health self-assessment test result:\s*(\S+)/i.exec(out)
      || /SMART Health Status:\s*(\S+)/i.exec(out);
    if (healthLine) {
      const verdict = healthLine[1].toUpperCase();
      disk.health = verdict.startsWith('PASS') ? 'PASSED' : verdict.startsWith('FAIL') ? 'FAILED' : '';
    }
    const t = /Temperature:\s*(\d+)/i.exec(out);
    if (t) disk.temp = Number(t[1]);
  }
  return disks;
}

/** df 分区占用。 */
async function partitions() {
  if (process.platform !== 'linux') return [];
  const r = await run('df', ['-kP'], { timeout: 8000 });
  const items = [];
  for (const line of String(r.stdout || '').split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [dev, sizeK, usedK, availK, pct, mount] = parts;
    if (!/^\/dev\//.test(dev)) continue;
    const pctNum = Number(String(pct).replace('%', ''));
    if (!Number.isFinite(pctNum)) continue;
    items.push({
      dev,
      mount,
      size: Number(sizeK) * 1024,
      used: Number(usedK) * 1024,
      avail: Number(availK) * 1024,
      usedPct: pctNum,
    });
  }
  return items;
}

async function overview() {
  let disks = sysDisks();
  disks = await enrichSmart(disks);
  const parts = await partitions();

  const totalSize = disks.reduce((s, d) => s + d.size, 0);
  const totalUsed = parts.reduce((s, p) => s + p.used, 0);
  const totalAvail = parts.reduce((s, p) => s + p.avail, 0);

  return {
    disks,
    partitions: parts,
    summary: {
      diskCount: disks.length,
      totalSize,
      totalUsed,
      totalAvail,
      usedPct: totalSize ? Math.round((totalUsed / (totalUsed + totalAvail || 1)) * 100) : 0,
    },
  };
}

module.exports = [
  ['GET', '/api/storage/overview', overview],
];
