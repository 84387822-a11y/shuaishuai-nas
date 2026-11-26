'use strict';

/**
 * 影视文件规范化：批量重命名（先预览、再执行、可撤销），以及导出脚本离线执行。
 * 安全约束：所有 from/to 都必须落在授权目录内；默认不覆盖已存在文件。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const {
  resolveUserPath,
  isWithin,
  str,
  bool,
  int,
  oneOf,
  badRequest,
  HttpError,
  DATA_DIR,
  ROOTS,
} = require('../lib/util');
const { walk, VIDEO_EXT } = require('../lib/scan');
const { parseMediaName, suggestName, suggestedFolder } = require('../lib/parse');

const JOURNAL = path.join(DATA_DIR, 'rename-journal.json');
const PROFILES = ['auto', 'movie', 'tv'];

function samePath(a, b) {
  if (process.platform === 'win32') return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  return path.resolve(a) === path.resolve(b);
}

function describeChange(parsed, fromRel, toRel) {
  const reasons = [];
  if (path.basename(fromRel) !== path.basename(toRel)) {
    if (/[._]/.test(path.basename(fromRel, path.extname(fromRel)))) reasons.push('去掉了点/下划线分隔');
    if (!parsed.year) reasons.push('补年份需手动确认');
  }
  if (parsed.type === 'tv') reasons.push('统一为 SxxEyy 命名');
  return reasons.length ? reasons.join('、') : '符合命名规范';
}

async function scan(ctx) {
  const dir = resolveUserPath(str(ctx.body.dir, '目录', { max: 1024 }));
  const profile = oneOf(String(ctx.body.profile || 'auto'), '整理模式', PROFILES);
  const recursive = bool(ctx.body.recursive, true);
  const organize = bool(ctx.body.organize, false);
  const limit = int(ctx.body.limit, '数量上限', { min: 1, max: 3000, fallback: 800 });

  const { files, truncated } = await walk(dir, {
    maxFiles: limit,
    maxDepth: recursive ? 8 : 1,
    exts: VIDEO_EXT,
  });
  const videos = files.filter((f) => f.ext !== '.strm');

  const items = [];
  let compliant = 0;

  for (const f of videos) {
    const parsed = parseMediaName(f.name);
    if (profile !== 'auto') parsed.type = profile;

    let targetDir = f.dir;
    if (organize) {
      const folder = suggestedFolder(parsed);
      // 已经在同名目录里的文件不再重复建目录
      if (path.basename(f.dir) !== folder) targetDir = path.join(f.dir, folder);
    }
    const newName = suggestName(parsed, { keepExt: f.ext });
    const target = path.join(targetDir, newName);
    const fromRel = f.rel;

    if (samePath(target, f.path)) {
      compliant += 1;
      continue;
    }

    items.push({
      from: f.path,
      to: target,
      fromRel,
      toRel: path.relative(dir, target),
      newName,
      type: parsed.type,
      title: parsed.title,
      year: parsed.year,
      slot: `${parsed.season ?? ''}-${parsed.episode ?? ''}`,
      confidence: parsed.confidence,
      issues: parsed.issues,
      reason: describeChange(parsed, fromRel, path.relative(dir, target)),
      conflict: fs.existsSync(target) && !samePath(target, f.path),
    });
  }

  const seen = new Map();
  for (const it of items) {
    const key = process.platform === 'win32' ? it.to.toLowerCase() : it.to;
    if (seen.has(key)) it.conflict = true;
    seen.set(key, true);
  }

  return {
    dir,
    profile,
    organize,
    total: videos.length,
    truncated,
    compliant,
    changed: items.length,
    conflicts: items.filter((i) => i.conflict).length,
    items,
    hint:
      '预览不会改动任何文件。确认后点击「执行重命名」；执行前会自动写入撤销记录，可在本页一键撤销。',
  };
}

function nearestExistingAncestor(p) {
  let cur = p;
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
  return cur;
}

/** 校验并准备目标路径；必要时创建父目录。 */
function prepareTarget(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw badRequest('目标路径必须是绝对路径');
  if (input.includes('\0') || input.includes('..')) throw badRequest('目标路径包含非法字符');

  const abs = path.resolve(input);
  const anc = nearestExistingAncestor(abs);
  let realAnc;
  try {
    realAnc = fs.realpathSync(anc);
  } catch {
    throw badRequest('无法解析目标路径');
  }
  if (!ROOTS.some((r) => isWithin(realAnc, r))) {
    throw new HttpError(403, '目标路径不在授权目录内');
  }

  const real = path.join(realAnc, path.relative(anc, abs));
  if (!ROOTS.some((r) => isWithin(real, r))) throw new HttpError(403, '目标路径越界');

  if (!fs.existsSync(path.dirname(real))) {
    try {
      fs.mkdirSync(path.dirname(real), { recursive: true });
    } catch (err) {
      throw badRequest(`无法创建目标目录：${err.message}`);
    }
  }
  return real;
}

async function execute(ctx) {
  const rawItems = Array.isArray(ctx.body.items) ? ctx.body.items : [];
  if (rawItems.length === 0) throw badRequest('没有需要重命名的条目');
  if (rawItems.length > 1000) throw badRequest('单次最多处理 1000 个文件');
  const dryRun = bool(ctx.body.dryRun, false);

  const results = [];
  const journal = [];

  for (const raw of rawItems) {
    try {
      if (!raw || typeof raw !== 'object') throw badRequest('条目格式不正确');
      const from = resolveUserPath(str(raw.from, '原路径', { max: 2048 }), { mustExist: true });
      const to = prepareTarget(str(raw.to, '新路径', { max: 2048 }));

      if (samePath(from, to) && path.basename(from) !== path.basename(to)) {
        // 仅大小写差异：先改到临时名再改回
        const tmp = `${from}.ss-tmp-${Date.now()}`;
        if (!dryRun) {
          await fsp.rename(from, tmp);
          await fsp.rename(tmp, to);
        }
        results.push({ from, to, ok: true, caseOnly: true });
        journal.push({ from, to });
        continue;
      }
      if (samePath(from, to)) {
        results.push({ from, to, ok: true, skipped: true, reason: '路径相同' });
        continue;
      }
      if (fs.existsSync(to)) throw new HttpError(409, '目标文件已存在', to);
      if (dryRun) {
        results.push({ from, to, ok: true, preview: true });
        continue;
      }
      await fsp.rename(from, to);
      results.push({ from, to, ok: true });
      journal.push({ from, to });
    } catch (err) {
      results.push({
        from: raw && raw.from,
        to: raw && raw.to,
        ok: false,
        error: err instanceof HttpError ? err.message : String(err.message || err),
      });
    }
  }

  const okCount = results.filter((r) => r.ok && !r.skipped).length;
  const failCount = results.filter((r) => !r.ok).length;

  if (!dryRun && journal.length > 0) {
    try {
      await fsp.writeFile(JOURNAL, JSON.stringify({ createdAt: new Date().toISOString(), items: journal }, null, 2), 'utf8');
    } catch (err) {
      console.warn('[rename] 写入撤销记录失败:', err.message);
    }
  }

  return {
    dryRun,
    total: results.length,
    renamed: dryRun ? 0 : okCount,
    failed: failCount,
    results: results.slice(0, 200),
    canUndo: !dryRun && journal.length > 0,
    hint: dryRun ? '预览模式，未改动文件。' : '已完成重命名，如需回退可点击「撤销上次操作」。',
  };
}

async function undo(ctx) {
  let data;
  try {
    data = JSON.parse(await fsp.readFile(JOURNAL, 'utf8'));
  } catch {
    throw badRequest('没有可撤销的重命名记录');
  }
  const items = Array.isArray(data.items) ? data.items.slice().reverse() : [];
  const results = [];

  for (const it of items) {
    try {
      if (!fs.existsSync(it.to)) {
        results.push({ from: it.to, to: it.from, ok: false, error: '当前文件不存在，可能已被再次移动' });
        continue;
      }
      const back = prepareTarget(it.from);
      if (fs.existsSync(back)) {
        results.push({ from: it.to, to: back, ok: false, error: '原文件名已被占用' });
        continue;
      }
      await fsp.rename(it.to, back);
      results.push({ from: it.to, to: back, ok: true });
    } catch (err) {
      results.push({ from: it.to, to: it.from, ok: false, error: String(err.message || err) });
    }
  }

  const okAll = results.length > 0 && results.every((r) => r.ok);
  if (okAll) await fsp.unlink(JOURNAL).catch(() => {});

  return {
    total: results.length,
    restored: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results: results.slice(0, 200),
    hint: okAll ? '已全部恢复。' : '部分文件未能恢复，请根据结果手动处理。',
  };
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function exportScript(ctx) {
  const items = Array.isArray(ctx.body.items) ? ctx.body.items.slice(0, 1000) : [];
  if (items.length === 0) throw badRequest('没有可导出的条目');
  const format = oneOf(String(ctx.body.format || 'bash'), '脚本类型', ['bash', 'powershell']);

  const lines = [];
  if (format === 'bash') {
    lines.push('#!/usr/bin/env bash', '# 由「NAS助手」生成：影视文件批量重命名脚本', '# 请先备份，再在 NAS 上以有权限的用户执行：bash rename.sh', 'set -euo pipefail', '');
    for (const it of items) {
      lines.push(`mv -n -- ${shQuote(it.from)} ${shQuote(it.to)}`);
    }
    lines.push('', 'echo "完成：' + items.length + ' 个文件"');
  } else {
    lines.push('# 由「NAS助手」生成：影视文件批量重命名脚本（PowerShell）', '$ErrorActionPreference = "Stop"', '');
    for (const it of items) {
      lines.push(`Move-Item -LiteralPath ${psQuote(it.from)} -Destination ${psQuote(it.to)}`);
    }
    lines.push('', `Write-Host "完成：${items.length} 个文件"`);
  }

  return {
    __download: {
      filename: format === 'bash' ? 'rename-media.sh' : 'rename-media.ps1',
      content: lines.join('\n') + '\n',
      mime: 'text/plain; charset=utf-8',
    },
  };
}

module.exports = [
  ['POST', '/api/files/scan', scan],
  ['POST', '/api/files/rename', execute],
  ['POST', '/api/files/undo', undo],
  ['POST', '/api/files/script', exportScript],
];
