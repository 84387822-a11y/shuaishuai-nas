'use strict';

/**
 * 系统清理：先扫描可清理项（只读），再由用户勾选执行。
 * 只做「安全清理」：Docker 悬空镜像/构建缓存、系统日志归档、7 天前的临时文件。
 */

const fs = require('node:fs');
const path = require('node:path');

const { run, findBin, badRequest, str } = require('../lib/util');

/** 目录占用（KB），失败返回 0。 */
async function dirSizeKb(dir) {
  const r = await run('du', ['-sk', dir], { timeout: 15000 });
  const n = Number(String(r.stdout || '').split(/\s+/)[0]);
  return Number.isFinite(n) ? n : 0;
}

async function dockerTargets() {
  const items = [];
  const bin = findBin('docker');
  if (!bin) return items;

  const df = await run(bin, ['system', 'df', '--format', '{{.Type}}\t{{.Reclaimable}}'], { timeout: 15000 });
  if (df.code !== 0) return items;

  for (const line of String(df.stdout || '').split('\n')) {
    const [type, reclaimable] = line.split('\t');
    if (!type || !reclaimable) continue;
    const m = /([\d.]+)\s*([KMG]?B)/i.exec(reclaimable);
    if (!m) continue;
    const unit = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 }[m[2].toUpperCase()] || 1;
    const bytes = Math.round(Number(m[1]) * unit);
    if (bytes < 10 * 1024 * 1024) continue; // 小于 10MB 不值得清理
    if (/Images/i.test(type)) items.push({ id: 'docker-images', title: '未使用镜像', size: bytes, hint: 'docker image prune -f', category: '容器与镜像', safe: false, count: 1 });
    if (/Build Cache/i.test(type)) items.push({ id: 'docker-buildcache', title: 'Docker 构建缓存', size: bytes, hint: 'docker builder prune -f', category: '容器与镜像', safe: true, count: 1 });
    if (/Containers/i.test(type)) items.push({ id: 'docker-containers', title: '已停止容器', size: bytes, hint: 'docker container prune -f', category: '容器与镜像', safe: false, count: 1 });
  }
  return items;
}

async function logTargets() {
  const items = [];
  if (process.platform !== 'linux') return items;
  for (const dir of ['/var/log', '/tmp']) {
    if (!fs.existsSync(dir)) continue;
    const kb = await dirSizeKb(dir);
    if (kb < 50 * 1024) continue; // 小于 50MB 不提示
    items.push({
      id: dir === '/var/log' ? 'var-log' : 'tmp',
      title: dir === '/var/log' ? '系统日志（/var/log）' : '临时文件（/tmp）',
      size: kb * 1024,
      hint: dir === '/var/log' ? 'journalctl --vacuum-time=7d' : '删除 7 天前的临时文件',
      category: '应用与文件',
      safe: dir === '/tmp',
      count: 1,
    });
  }
  return items;
}

async function scan() {
  const targets = [...(await dockerTargets()), ...(await logTargets())];
  const total = targets.reduce((sum, t) => sum + (t.size || 0), 0);

  const byCategory = new Map();
  for (const t of targets) {
    const name = t.category || '其它';
    const entry = byCategory.get(name) || { name, size: 0, count: 0 };
    entry.size += t.size || 0;
    entry.count += t.count || 1;
    byCategory.set(name, entry);
  }

  return {
    scanned_at: new Date().toISOString(),
    total,
    targets,
    categories: [...byCategory.values()],
  };
}

/** 校验可执行的清理项，避免任意命令注入。 */
const ALLOWED = new Set(['docker-images', 'docker-buildcache', 'docker-containers', 'var-log', 'tmp']);

async function execute(ctx) {
  const raw = (ctx.body && ctx.body.ids) || [];
  if (!Array.isArray(raw) || !raw.length) throw badRequest('请先勾选要清理的项目');
  const ids = raw.map((x) => str(x, 'id', { max: 32 }));
  for (const id of ids) {
    if (!ALLOWED.has(id)) throw badRequest('不支持清理项：' + id);
  }

  const out = [];
  const docker = findBin('docker');
  for (const id of ids) {
    if (id === 'docker-images' && docker) {
      const r = await run(docker, ['image', 'prune', '-f'], { timeout: 120000 });
      out.push({ id, ok: r.code === 0, detail: String(r.stdout || r.stderr || '').trim().slice(0, 300) });
    } else if (id === 'docker-buildcache' && docker) {
      const r = await run(docker, ['builder', 'prune', '-f'], { timeout: 120000 });
      out.push({ id, ok: r.code === 0, detail: String(r.stdout || r.stderr || '').trim().slice(0, 300) });
    } else if (id === 'docker-containers' && docker) {
      const r = await run(docker, ['container', 'prune', '-f'], { timeout: 120000 });
      out.push({ id, ok: r.code === 0, detail: String(r.stdout || r.stderr || '').trim().slice(0, 300) });
    } else if (id === 'var-log') {
      const r = await run('journalctl', ['--vacuum-time=7d'], { timeout: 60000 });
      out.push({ id, ok: r.code === 0, detail: String(r.stdout || r.stderr || '').trim().slice(0, 300) });
    } else if (id === 'tmp') {
      // 只删 7 天前、且非目录的普通文件
      const r = await run('find', ['/tmp', '-xdev', '-type', 'f', '-mtime', '+7', '-delete'], { timeout: 60000 });
      out.push({ id, ok: r.code === 0, detail: String(r.stdout || r.stderr || '').trim().slice(0, 300) });
    } else {
      out.push({ id, ok: false, detail: '环境不支持（缺少 docker 或非 Linux）' });
    }
  }
  return { executed_at: new Date().toISOString(), results: out };
}

module.exports = [
  ['GET', '/api/cleanup/scan', scan],
  ['POST', '/api/cleanup/run', execute],
];
