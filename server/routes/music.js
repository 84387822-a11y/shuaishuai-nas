'use strict';

/**
 * 音乐转 MP3：扫描授权目录内的非 MP3 音频，用 ffmpeg 转码，
 * 输出到所选目录下的 mp3/ 子文件夹，保留原文件。
 *
 * 安全约束：
 * - 源文件必须落在授权根目录内（resolveUserPath）。
 * - 输出目录取自源文件所在目录的 mp3/ 子目录，天然位于授权根目录内。
 * - ffmpeg 通过 run()（数组参数、不经 shell）调用，参数不拼接字符串。
 *
 * 依赖：NAS 上需要安装 ffmpeg；未安装时只提示安装命令，不静默安装。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { run, findBin, resolveUserPath, isWithin, safeChild, str, int, bool, badRequest, HttpError, ROOTS } = require('../lib/util');
const { walk, AUDIO_EXT } = require('../lib/scan');

/** 可转码为 MP3 的音频扩展名（MP3 本身不需要转换）。 */
const CONVERT_EXT = new Set(
  Array.from(AUDIO_EXT).filter((ext) => ext !== '.mp3')
);

const MAX_ITEMS = 1000;

/** VBR 音质档位：值越小码率越高（lame -q:a）。 */
const QUALITY_HINTS = {
  0: '音质最高（约 245 kbps）',
  2: '高质量（约 190 kbps）',
  5: '中（约 130 kbps）',
  9: '低（约 65 kbps）',
};

function ffmpegPath() {
  return findBin('ffmpeg');
}

function ffmpegStatus() {
  const found = ffmpegPath();
  return {
    available: Boolean(found),
    path: found,
    hint: found
      ? `已找到 ffmpeg：${found}`
      : '未找到 ffmpeg。请在 NAS 上安装后刷新工具，无需重装本应用。',
    install:
      'sudo apt update\nsudo apt install -y ffmpeg\nffmpeg -version\n# Docker 部署请先确认基础镜像自带 ffmpeg',
  };
}

/** 生成输出路径：<所在目录>/mp3/<原名>.mp3，并校验落在授权目录内。 */
function outputTarget(fromReal) {
  const dir = path.dirname(fromReal);
  const outDir = path.join(dir, 'mp3');
  const anc = outDir;
  let real, realAnc;
  try {
    realAnc = fs.realpathSync(dir);
    if (!ROOTS.some((r) => isWithin(realAnc, r))) {
      throw new HttpError(403, '源文件所在目录不在授权目录内');
    }
    real = path.join(realAnc, 'mp3');
    if (!ROOTS.some((r) => isWithin(real, r))) {
      throw new HttpError(403, '输出目录越界');
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw badRequest(`无法解析输出目录：${err.message}`);
  }
  const base = path.basename(fromReal, path.extname(fromReal));
  const file = safeChild(real, `${base}.mp3`);
  return { outDir: real, file };
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

async function scan(ctx) {
  const dir = resolveUserPath(str(ctx.body.dir, '目录', { max: 1024 }));
  const recursive = bool(ctx.body.recursive, true);
  const limit = int(ctx.body.limit, '数量上限', { min: 1, max: 8000, fallback: 800 });

  const { files, truncated } = await walk(dir, {
    maxFiles: limit,
    maxDepth: recursive ? 8 : 1,
    exts: CONVERT_EXT,
  });

  const items = files.map((f) => {
    let outDir = '';
    let to = '';
    let exists = false;
    try {
      const t = outputTarget(f.path);
      outDir = t.outDir;
      to = t.file;
      exists = fs.existsSync(t.file);
    } catch {
      // 输出目录解析失败时保留空，前端标记为不可转换
    }
    return {
      from: f.path,
      rel: f.rel,
      name: f.name,
      ext: f.ext,
      size: f.size,
      dir: f.dir,
      to,
      toRel: to ? path.relative(dir, to) : '',
      outDir,
      exists,
    };
  });

  return {
    dir,
    recursive,
    total: files.length,
    truncated,
    items,
    ffmpeg: ffmpegStatus(),
    quality: QUALITY_HINTS,
    hint: '扫描只读取文件名。转换使用 VBR 编码，原文件不会被修改或删除。',
  };
}

/* ------------------------------------------------------------------ */
/* 转换                                                                */
/* ------------------------------------------------------------------ */

async function convert(ctx) {
  const ff = ffmpegStatus();
  if (!ff.available) {
    throw new HttpError(
      500,
      '未找到 ffmpeg，无法转换。请先在 NAS 上安装 ffmpeg。',
      ff.install
    );
  }

  const rawItems = Array.isArray(ctx.body.items) ? ctx.body.items : [];
  if (rawItems.length === 0) throw badRequest('没有需要转换的文件');
  if (rawItems.length > MAX_ITEMS) throw badRequest(`单次最多转换 ${MAX_ITEMS} 个文件`);

  const quality = int(ctx.body.quality, '音质', { min: 0, max: 9, fallback: 2 });

  const results = [];
  let converted = 0;
  let skipped = 0;
  let failed = 0;

  for (const raw of rawItems) {
    const res = { from: raw && raw.from, name: '', to: '', outDir: '', size: 0, ok: false };
    try {
      if (!raw || typeof raw !== 'object') throw badRequest('条目格式不正确');
      const from = resolveUserPath(str(raw.from, '源路径', { max: 2048 }), { mustExist: true });

      const ext = path.extname(from).toLowerCase();
      if (!CONVERT_EXT.has(ext)) throw badRequest(`不支持 ${ext}，仅支持转换成 mp3 的常见音频格式`);

      const t = outputTarget(from);
      res.name = path.basename(from);
      res.to = t.file;
      res.outDir = t.outDir;

      if (fs.existsSync(t.file)) {
        res.ok = true;
        res.skipped = true;
        res.reason = '目标 mp3 已存在，跳过（不覆盖）';
        skipped += 1;
        continue;
      }

      try {
        fs.mkdirSync(t.outDir, { recursive: true });
      } catch (err) {
        throw badRequest(`无法创建输出目录：${err.message}`);
      }

      const out = await run(ff.path, [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', from,
        '-vn',
        '-codec:a', 'libmp3lame',
        '-q:a', String(quality),
        '-map_metadata', '0',
        '-id3v2_version', '3',
        '-n', t.file,
      ], { timeout: 600000, maxBuffer: 8 * 1024 * 1024 });

      if (out.code !== 0) {
        const detail = (out.stderr || '').trim() || (out.timedOut ? '转换超时（10 分钟）' : 'ffmpeg 返回异常');
        throw new HttpError(500, '转换失败', `${detail}\n$ ffmpeg -i ${from} ...`);
      }

      const st = fs.statSync(t.file);
      res.ok = true;
      res.size = st.size;
      converted += 1;
    } catch (err) {
      res.error = err instanceof HttpError ? err.message : String(err.message || err);
      failed += 1;
    }
    results.push(res);
  }

  // 去重列出本次实际生成过文件的输出目录，方便用户直接去找到 mp3
  const outDirs = [
    ...new Set(
      results
        .filter((r) => r.ok && !r.skipped && r.outDir)
        .map((r) => r.outDir)
    ),
  ];

  const logLines = results.map((r) => {
    const status = !r.ok
      ? `失败：${r.error || '未知错误'}`
      : r.skipped
        ? `跳过：${r.reason || '目标已存在'}`
        : `成功 → ${r.to || r.outDir || ''}`;
    return `${r.name || r.from || '(未知)'}｜${status}`;
  });

  return {
    total: results.length,
    converted,
    skipped,
    failed,
    quality,
    qualityHint: QUALITY_HINTS[quality] || '',
    results: results.slice(0, MAX_ITEMS),
    outDirs,
    log: logLines,
    hint: '已完成。原文件保持不变；转换出的 mp3 在各自目录的 mp3/ 子文件夹里，见上方「输出目录」。',
  };
}

module.exports = [
  ['POST', '/api/tools/music/scan', scan],
  ['POST', '/api/tools/music/convert', convert],
];
