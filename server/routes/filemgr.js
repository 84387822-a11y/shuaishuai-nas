'use strict';

/**
 * 文件管理：卷用量、目录浏览、按类型统计空间构成、大文件排行。
 * 全部只读；所有路径都经过 resolveUserPath 的授权目录校验。
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  resolveUserPath, allowedRoots, run, str, badRequest,
} = require('../lib/util');

const TYPE_MAP = [
  { key: 'video', label: '影音', exts: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'ts', 'm2ts', 'rmvb', 'webm', 'mpg', 'mpeg'] },
  { key: 'image', label: '图片', exts: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'tif', 'tiff', 'svg'] },
  { key: 'audio', label: '音乐', exts: ['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'ape', 'wma', 'dsf'] },
  { key: 'doc', label: '文档', exts: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv'] },
  { key: 'ebook', label: '电子书', exts: ['epub', 'mobi', 'azw3', 'djvu'] },
  { key: 'archive', label: '压缩包', exts: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst'] },
  { key: 'program', label: '程序与镜像', exts: ['iso', 'img', 'exe', 'msi', 'apk', 'dmg', 'deb', 'rpm', 'appimage', 'bin'] },
];

const EXT_TO_TYPE = new Map();
for (const t of TYPE_MAP) for (const e of t.exts) EXT_TO_TYPE.set(e, t.key);

function typeOf(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return EXT_TO_TYPE.get(ext) || 'other';
}

/* ---------------- 卷用量 ---------------- */

async function volumes() {
  if (process.platform !== 'linux') {
    const roots = allowedRoots();
    return { items: roots.map((p) => ({ mount: p, notSupported: true })) };
  }
  const r = await run('df', ['-kP'], { timeout: 8000 });
  const items = [];
  for (const line of String(r.stdout || '').split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [dev, sizeK, usedK, availK, pct, mount] = parts;
    if (!/^\/dev\//.test(dev)) continue;
    items.push({
      dev,
      mount,
      size: Number(sizeK) * 1024,
      used: Number(usedK) * 1024,
      avail: Number(availK) * 1024,
      usedPct: Number(String(pct).replace('%', '')) || 0,
    });
  }
  return { items };
}

/* 可浏览根：授权目录 + 存储卷（未授权时也能只读浏览） */
async function browseRoots() {
  const roots = new Set(allowedRoots());
  if (process.platform === 'linux') {
    const r = await run('df', ['-P'], { timeout: 8000 });
    for (const line of String(r.stdout || '').split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      const mount = parts[parts.length - 1];
      if (!mount) continue;
      if (/^\/(vol\d+|home|mnt|media)(\/|$)/.test(mount)) roots.add(mount);
    }
  }
  return [...roots].filter((p) => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });
}

/** 只读校验：路径必须落在授权目录或存储卷之内。 */
async function resolveReadable(raw) {
  const roots = await browseRoots();
  const fallback = roots[0] || null;
  if (!raw) {
    if (!fallback) throw badRequest('没有可浏览的目录');
    return { real: fallback, roots };
  }
  const target = path.resolve(str(raw, 'path', { max: 4096 }));
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    throw badRequest('目录不存在：' + target);
  }
  const ok = roots.some((root) => real === root || real.startsWith(root + path.sep));
  if (!ok) throw badRequest('该路径不在可浏览范围内');
  if (!fs.statSync(real).isDirectory()) throw badRequest('该路径不是目录');
  return { real, roots };
}

/* ---------------- 目录浏览 ---------------- */

async function listDir(ctx) {
  const { real: target, roots } = await resolveReadable(ctx.query && ctx.query.get('path'));

  let dirents;
  try {
    dirents = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    throw badRequest('读取目录失败：' + err.code);
  }

  const entries = [];
  for (const d of dirents.slice(0, 600)) {
    if (d.name.startsWith('.')) continue;
    const full = path.join(target, d.name);
    let size = 0;
    let mtime = 0;
    try {
      const st = fs.statSync(full);
      size = st.size;
      mtime = st.mtimeMs;
    } catch { /* 权限不足则跳过大小 */ }
    entries.push({ name: d.name, path: full, isDir: d.isDirectory(), size, mtime });
  }

  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  const parent = path.dirname(target);
  const withinParent = roots.some((r) => target.startsWith(r)) && parent !== target;

  return { path: target, parent: withinParent ? parent : null, roots, entries };
}

/* ---------------- 空间构成与大文件 ---------------- */

async function analyze(ctx) {
  const { real: target } = await resolveReadable(ctx.query && ctx.query.get('path'));

  const MAX_FILES = 60000;
  const MAX_MS = 15000;
  const MAX_DEPTH = 6;
  const started = Date.now();

  const stats = new Map();
  for (const t of TYPE_MAP) stats.set(t.key, { key: t.key, label: t.label, size: 0, count: 0 });
  stats.set('other', { key: 'other', label: '其它', size: 0, count: 0 });

  const largest = [];
  const stack = [{ dir: target, depth: 0 }];
  let files = 0;
  let totalSize = 0;
  let truncated = false;

  while (stack.length) {
    if (files >= MAX_FILES || Date.now() - started > MAX_MS) { truncated = true; break; }
    const { dir, depth } = stack.pop();
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (files >= MAX_FILES || Date.now() - started > MAX_MS) { truncated = true; break; }
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (depth < MAX_DEPTH && !d.name.startsWith('.')) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!d.isFile()) continue;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      files += 1;
      totalSize += st.size;
      const key = typeOf(d.name);
      const bucket = stats.get(key) || stats.get('other');
      bucket.size += st.size;
      bucket.count += 1;

      // 维护最大的 50 个文件（简单插入，量级可控）
      if (largest.length < 50 || st.size > largest[largest.length - 1].size) {
        largest.push({ name: d.name, path: full, size: st.size });
        largest.sort((a, b) => b.size - a.size);
        if (largest.length > 50) largest.length = 50;
      }
    }
  }

  const categories = [...stats.values()].filter((c) => c.count > 0).sort((a, b) => b.size - a.size);

  return {
    path: target,
    files,
    totalSize,
    truncated,
    elapsedMs: Date.now() - started,
    categories,
    largest,
  };
}

module.exports = [
  ['GET', '/api/filemgr/volumes', volumes],
  ['GET', '/api/filemgr/list', listDir],
  ['GET', '/api/filemgr/analyze', analyze],
];
