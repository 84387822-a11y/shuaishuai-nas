'use strict';

/**
 * 运行日志：列出数据目录下的日志文件，支持下载到本机、另存到 NAS 授权目录。
 *
 * 安全边界：
 * - 只读取 DATA_DIR 内、扩展名为 .log 的文件；文件名必须是单段 basename。
 * - 另存目标必须落在授权目录内（resolveUserPath + safeChild），不覆盖已有文件。
 */

const fs = require('node:fs');
const path = require('node:path');

const { DATA_DIR, resolveUserPath, safeChild, str, HttpError } = require('../lib/util');

const MAX_DOWNLOAD = 20 * 1024 * 1024; // 单个日志下载上限 20MB
const NAME_RE = /^[A-Za-z0-9._-]+\.log$/;

function listLogs() {
  let entries = [];
  try {
    entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!NAME_RE.test(entry.name)) continue;
    const full = path.join(DATA_DIR, entry.name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    files.push({ name: entry.name, size: st.size, mtime: st.mtimeMs });
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

/** 校验日志名并返回真实路径（防止路径穿越）。 */
function resolveLog(nameInput) {
  const name = str(nameInput, '日志文件', { max: 128 });
  if (!NAME_RE.test(name)) throw new HttpError(400, '日志文件名不合法');
  const full = path.join(DATA_DIR, name);
  let real;
  try {
    real = fs.realpathSync(full);
  } catch {
    throw new HttpError(404, '日志文件不存在');
  }
  const root = fs.realpathSync(DATA_DIR);
  const rel = path.relative(root, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new HttpError(403, '日志文件越界');
  const st = fs.statSync(real);
  if (!st.isFile()) throw new HttpError(400, '不是文件');
  return { name, real, size: st.size };
}

function download(ctx) {
  const { name, real, size } = resolveLog(ctx.body.name);
  if (size > MAX_DOWNLOAD) throw new HttpError(413, '日志文件过大（上限 20MB）');
  const content = fs.readFileSync(real, 'utf8');
  return {
    __download: {
      filename: name,
      content,
      mime: 'text/plain; charset=utf-8',
    },
  };
}

function save(ctx) {
  const { name, real } = resolveLog(ctx.body.name);
  const dir = resolveUserPath(str(ctx.body.dir, '保存目录', { max: 1024 }), { mustExist: true });
  if (!fs.statSync(dir).isDirectory()) throw new HttpError(400, '保存位置不是文件夹');

  let target = safeChild(dir, name);
  if (fs.existsSync(target)) {
    // 不覆盖已有文件，追加时间戳区分
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const base = path.basename(name, '.log');
    target = safeChild(dir, `${base}-${stamp}.log`);
  }

  fs.copyFileSync(real, target);
  const st = fs.statSync(target);
  return {
    saved: target,
    size: st.size,
    hint: '日志已另存到 NAS 授权目录，可在文件管理中查看。',
  };
}

module.exports = [
  ['GET', '/api/logs', () => ({ files: listLogs() })],
  ['POST', '/api/logs/download', download],
  ['POST', '/api/logs/save', save],
];
