'use strict';

/**
 * 桌面壁纸：从授权目录挑选壁纸（静态图片或动态视频），预览后
 * 生成「一键切换壁纸」脚本，由用户在 SSH 里用 sudo 执行。
 *
 * 安全与一致性说明（很关键）：
 * - fnOS 没有公开桌面壁纸的系统路径/接口文档，本工具因此不擅自写系统目录，
 *   只负责：扫描授权目录里的壁纸素材、本机预览、生成脚本。
 * - 脚本需要用户先确认目标系统路径（TARGET），并用 sudo 执行——脚本本身
 *   只做「备份原文件 + 复制新壁纸到目标路径」，不下载、不联网、不改系统配置。
 * - 预览接口只提供授权目录内的图片/视频，且只读，不改动任何文件。
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  resolveUserPath, str, bool, int, oneOf, HttpError, DATA_DIR,
} = require('../lib/util');
const { walk, IMAGE_EXT } = require('../lib/scan');

const WALLPAPER_EXT = new Set([
  ...Array.from(IMAGE_EXT),
  '.mp4', '.webm', // 动态（视频）壁纸
]);

/** 只有这些扩展名允许被预览接口读取（防止把任意文件当作图片暴露）。 */
const IMAGE_PREVIEW_EXT = new Set([...Array.from(IMAGE_EXT), '.mp4', '.webm', '.gif']);

/** 动态壁纸（视频）扩展名判断。 */
function isDynamic(ext) {
  return ext === '.mp4' || ext === '.webm' || ext === '.gif';
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

async function scan(ctx) {
  const dir = resolveUserPath(str(ctx.body.dir, '目录', { max: 1024 }));
  const recursive = bool(ctx.body.recursive, true);
  const limit = int(ctx.body.limit, '数量上限', { min: 1, max: 8000, fallback: 500 });

  const { files, truncated, deniedDirs, skippedLinks } = await walk(dir, {
    maxFiles: limit,
    maxDepth: recursive ? 8 : 1,
    exts: WALLPAPER_EXT,
    followFileSymlinks: true, // 跟随指向普通文件的软链，避免“文件明明在却扫不到”
  });

  if (files.length === 0) {
    const rootDenied = deniedDirs.includes(dir);
    if (rootDenied) {
      throw new HttpError(
        403,
        '应用用户无权读取该目录：' + dir,
        '全盘访问只解除应用层的路径限制，并不改变 fnOS 系统读权限。请在「应用设置 → 可访问的文件」把该文件夹授权给应用（读/读写），或用 root 给应用用户 shuaishuainas 添加读权限后重试。'
      );
    }
    if (deniedDirs.length > 0) {
      throw new HttpError(
        403,
        `扫描时发现 ${deniedDirs.length} 个子目录无权读取（例如 ${deniedDirs[0]}）`,
        '这些子目录被系统权限拒绝，应用用户 shuaishuainas 无法进入。请授权对应目录，或改用可读取的目录。'
      );
    }
  }

  const items = files.map((f) => ({
    from: f.path,
    rel: f.rel,
    name: f.name,
    ext: f.ext,
    size: f.size,
    dir: f.dir,
    dynamic: isDynamic(f.ext),
    previewable: IMAGE_PREVIEW_EXT.has(f.ext),
  }));

  return {
    dir,
    recursive,
    total: files.length,
    truncated,
    deniedDirs: deniedDirs.length,
    skippedLinks,
    items,
    hint: skippedLinks > 0
      ? `有 ${skippedLinks} 个符号链接指向目录或已失效，已安全跳过。`
      : '扫描只读取文件名，预览不改动原文件。生成的脚本由你在 SSH 里用 sudo 执行。',
  };
}

/* ------------------------------------------------------------------ */
/* 预览：把授权目录内的图片/视频流式返回给浏览器                        */
/* ------------------------------------------------------------------ */

function previewContentType(ext) {
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  return 'application/octet-stream';
}

function preview(ctx) {
  const input = ctx.query && ctx.query.get ? ctx.query.get('path') : (ctx.query && ctx.query.path);
  const file = resolveUserPath(str(input, '路径', { max: 2048 }), { mustExist: true });
  const ext = path.extname(file).toLowerCase();
  if (!IMAGE_PREVIEW_EXT.has(ext)) {
    throw new HttpError(400, '该扩展名不支持预览，仅支持常见图片与 mp4 / webm 视频');
  }
  const st = fs.statSync(file);
  if (!st.isFile()) throw new HttpError(400, '不是文件');
  // 提前校验读取权限，把「读不了」从静默断流变成明确 403，而不是页面裂图
  try {
    fs.accessSync(file, fs.constants.R_OK);
  } catch {
    throw new HttpError(
      403,
      '应用用户无权读取该文件：' + path.basename(file),
      '预览需要真正读取文件内容。请在「应用设置 → 可访问的文件」授权该目录（读写），或用 root 给应用用户 shuaishuainas 添加读权限后重试。'
    );
  }
  // 单次预览上限 200MB，超出只给占位提示，不整文件流给浏览器
  if (st.size > 200 * 1024 * 1024) {
    throw new HttpError(413, '文件过大，无法在网页预览（上限 200MB），请直接生成脚本使用');
  }

  const res = ctx.res;
  res.writeHead(200, {
    'Content-Type': previewContentType(ext),
    'Content-Length': st.size,
    'Content-Disposition': 'inline',
    'Cache-Control': 'no-store',
  });
  const stream = fs.createReadStream(file);
  stream.on('error', () => {
    try { res.destroy(); } catch { /* ignore */ }
  });
  stream.pipe(res);
  return;
}

/* ------------------------------------------------------------------ */
/* 生成切换壁纸脚本                                                     */
/* ------------------------------------------------------------------ */

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function basename(p) {
  return String(p).split('\\').pop().split('/').pop();
}

function buildBash(source, target, dynamic) {
  const kind = dynamic ? '动态（视频）' : '静态图片';
  return [
    '#!/usr/bin/env bash',
    '# 由「NAS助手」生成：切换桌面壁纸（' + kind + '）',
    '#',
    '# 使用方法：',
    '#   1) 先在 SSH 里确认你的 fnOS 桌面壁纸的系统路径（官方界面是「桌面 → 设置 → 壁纸」）。',
    '#      建议执行：  sudo find / -iname "*wallpaper*" 2>/dev/null',
    '#   2) 把确认到的路径填到下面的 TARGET 变量，或直接替换。',
    '#   3) 检查无误后执行：  bash set-wallpaper.sh',
    '#',
    '# 本脚本只做两件事：备份原壁纸、用 sudo 把新壁纸复制到目标路径。',
    '# 不下载、不联网、不改任何系统配置。',
    'set -u',
    '',
    "SRC=" + shQuote(source),
    "TARGET=" + shQuote(target || ''),
    '',
    'if [ -z "$TARGET" ]; then',
    '  echo "错误：未填写目标路径 TARGET。"',
    '  echo "请先在 SSH 里确认 fnOS 桌面壁纸的系统位置（find / -iname \\\"*wallpaper*\\\"），再填到这里。"',
    '  echo "直接改系统的壁纸要写对位置才有效，本工具无法替你验证。"',
    '  exit 1',
    'fi',
    '',
    'if [ ! -f "$SRC" ]; then',
    '  echo "错误：源文件不存在：$SRC"',
    '  exit 1',
    'fi',
    '',
    'if [ -f "$TARGET" ]; then',
    '  sudo cp -n -- "$TARGET" "$TARGET.bak" 2>/dev/null || true',
    '  echo "已备份原壁纸到：${TARGET}.bak"',
    'fi',
    '',
    'sudo cp -- "$SRC" "$TARGET"',
    'sudo chown root:root "$TARGET" 2>/dev/null || true',
    '',
    'echo "完成：已把壁纸更新为 $SRC → $TARGET"',
    'echo "如果桌面没有立即刷新，重新登录一次，或按桌面设置里的位置确认。"',
    '',
  ].join('\n') + '\n';
}

function buildPowerShell(source, target, dynamic) {
  const kind = dynamic ? '动态（视频）' : '静态图片';
  return [
    '# 由「NAS助手」生成：切换桌面壁纸（' + kind + '，PowerShell）',
    '# 仅适合 Windows / 需要 PowerShell 的环境；fnOS 上请使用 Bash 版本。',
    '$ErrorActionPreference = "Stop"',
    '',
    '$SRC = ' + psQuote(source),
    '$TARGET = ' + psQuote(target || ''),
    '',
    'if (-not $TARGET) {',
    '  Write-Host "错误：未填写目标路径 TARGET。"',
    '  Write-Host "请先在 shell 里确认桌面壁纸的系统路径后，填到 TARGET 变量。"',
    '  exit 1',
    '}',
    'if (-not (Test-Path -LiteralPath $SRC)) {',
    '  Write-Host "错误：源文件不存在：$SRC"',
    '  exit 1',
    '}',
    'if (Test-Path -LiteralPath $TARGET) {',
    '  Copy-Item -LiteralPath $TARGET -Destination "$TARGET.bak" -Force',
    '  Write-Host "已备份原壁纸到：$TARGET.bak"',
    '}',
    'Copy-Item -LiteralPath $SRC -Destination $TARGET -Force',
    'Write-Host "完成：已把壁纸更新为 $SRC → $TARGET"',
    'Write-Host "如果桌面没有立即刷新，重新登录一次确认效果。"',
    '',
  ].join('\n') + '\n';
}

function script(ctx) {
  const rawItems = Array.isArray(ctx.body.items) ? ctx.body.items.slice(0, 1) : [];
  if (rawItems.length === 0) throw new HttpError(400, '请先选择一个壁纸文件');
  const format = str(ctx.body.format || 'bash', '脚本类型', { max: 20 });
  if (format !== 'bash' && format !== 'powershell') {
    throw new HttpError(400, '脚本类型必须是 bash / powershell 之一');
  }
  const target = String(ctx.body.target || '').trim();

  const raw = rawItems[0];
  const source = resolveUserPath(str(raw.from, '源路径', { max: 2048 }), { mustExist: true });
  const ext = path.extname(source).toLowerCase();
  if (!WALLPAPER_EXT.has(ext)) {
    throw new HttpError(400, '该文件不是壁纸素材，仅支持常见图片与 mp4 / webm 视频');
  }

  const content = format === 'bash'
    ? buildBash(source, target, isDynamic(ext))
    : buildPowerShell(source, target, isDynamic(ext));
  const base = path.basename(source, path.extname(source));

  return {
    __download: {
      filename: format === 'bash' ? 'set-wallpaper.sh' : `set-wallpaper-${base}.ps1`,
      content,
      mime: format === 'bash' ? 'application/x-sh' : 'text/plain; charset=utf-8',
    },
  };
}

/* ------------------------------------------------------------------ */
/* 配置记忆：记住目录 / 目标路径 / 脚本格式，下次打开自动回填             */
/* ------------------------------------------------------------------ */

const WCFG_FILE = path.join(DATA_DIR, 'wallpaper.json');

function loadWcfg() {
  try {
    return JSON.parse(fs.readFileSync(WCFG_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveWcfg(cfg) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WCFG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {
    /* 持久化失败只影响下次回填 */
  }
}

function configGet() {
  const c = loadWcfg();
  return { dir: c.dir || '', target: c.target || '', format: c.format || 'bash' };
}

function configSet(ctx) {
  const c = loadWcfg();
  if (ctx.body.dir !== undefined) c.dir = str(ctx.body.dir, '目录', { max: 1024, allowEmpty: true });
  if (ctx.body.target !== undefined) c.target = str(ctx.body.target, '目标路径', { max: 1024, allowEmpty: true });
  if (ctx.body.format !== undefined) c.format = oneOf(String(ctx.body.format), '脚本类型', ['bash', 'powershell']);
  saveWcfg(c);
  return configGet();
}

module.exports = [
  ['POST', '/api/wallpaper/scan', scan],
  ['GET', '/api/wallpaper/preview', preview],
  ['POST', '/api/wallpaper/script', script],
  ['GET', '/api/wallpaper/config', configGet],
  ['POST', '/api/wallpaper/config', configSet],
];
