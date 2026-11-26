'use strict';

/**
 * 目录遍历（只读、异步、有上限，避免在 NAS 大目录上卡死）。
 * - 默认不进入隐藏目录、系统回收站与 @ 开头的系统目录
 * - 不跟随符号链接（防止环）
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const SKIP_DIRS = new Set([
  '#recycle',
  '$RECYCLE.BIN',
  'System Volume Information',
  'lost+found',
  'node_modules',
  '@eaDir',
  '.git',
]);

const VIDEO_EXT = new Set([
  '.mkv', '.mp4', '.avi', '.ts', '.m2ts', '.mts', '.mov', '.wmv',
  '.flv', '.webm', '.iso', '.rmvb', '.rm', '.mpg', '.mpeg', '.m4v', '.strm',
]);

const AUDIO_EXT = new Set([
  '.flac', '.ape', '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.dsf', '.dff', '.aiff',
]);

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);

const SUB_EXT = new Set(['.srt', '.ass', '.ssa', '.sub', '.idx', '.vtt', '.sup']);

const DEFAULT_LIMIT = 8000;

/**
 * @param {string} root 已校验的真实路径
 * @param {{
 *   maxFiles?: number, maxDepth?: number, exts?: Set<string>|null,
 *   includeHidden?: boolean, followFileSymlinks?: boolean
 * }} opts
 */
async function walk(root, opts = {}) {
  const {
    maxFiles = DEFAULT_LIMIT,
    maxDepth = 8,
    exts = null,
    includeHidden = false,
    followFileSymlinks = false,
  } = opts;

  const files = [];
  const queue = [{ dir: root, depth: 0 }];
  const deniedDirs = [];
  let truncated = false;
  let scanned = 0;
  let skippedLinks = 0;

  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      // 记录读取失败的目录（通常是权限不足），不再静默当作空目录
      deniedDirs.push(dir);
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      const name = entry.name;
      if (!includeHidden && name.startsWith('.')) continue;

      const full = path.join(dir, name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        // 默认不跟随符号链接；开启 followFileSymlinks 时只跟随「指向普通文件」的链接，
        // 绝不进入符号链接目录（避免环路）。
        if (!followFileSymlinks) {
          skippedLinks += 1;
          continue;
        }
        let st;
        try {
          st = await fsp.stat(full);
        } catch {
          skippedLinks += 1;
          continue;
        }
        isDir = false;
        isFile = st.isFile();
        if (!isFile) {
          skippedLinks += 1;
          continue;
        }
      }

      if (isDir) {
        if (!includeHidden && (name.startsWith('@') || SKIP_DIRS.has(name))) continue;
        if (depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!isFile) continue;

      const ext = path.extname(name).toLowerCase();
      if (exts && !exts.has(ext)) continue;

      scanned += 1;
      let st;
      try {
        st = await fsp.stat(full);
      } catch {
        continue;
      }
      files.push({
        path: full,
        rel: path.relative(root, full),
        name,
        ext,
        size: st.size,
        mtime: st.mtimeMs,
        dir,
      });
    }
    if (truncated) break;
  }

  return { root, files, truncated, scanned, deniedDirs, skippedLinks };
}

module.exports = { walk, VIDEO_EXT, AUDIO_EXT, IMAGE_EXT, SUB_EXT, SKIP_DIRS };
