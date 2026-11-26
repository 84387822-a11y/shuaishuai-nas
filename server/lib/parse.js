'use strict';

/**
 * 影视文件名解析与命名规范化。
 * 目标：把 "流浪地球2.2023.2160p.WEB-DL.H265-GROUP.mkv" 解析成结构化字段，
 * 并给出符合飞牛影视 / Jellyfin / Emby 习惯的推荐命名。
 */

const path = require('node:path');

const RESOLUTIONS = [
  ['4320p', '8K'], ['2160p', '4K'], ['1080p', '1080P'], ['720p', '720P'],
  ['576p', '576P'], ['480p', '480P'],
];

const SOURCES = [
  'BluRay', 'Blu-ray', 'BDRip', 'BRRip', 'REMUX', 'Remux', 'WEB-DL', 'WEBRip',
  'WEBDL', 'HDTV', 'DVDRip', 'DVD', 'HDRip', 'HDCAM', 'TS', 'UHD',
];

const CODECS = ['H.265', 'H265', 'x265', 'HEVC', 'H.264', 'H264', 'x264', 'AVC', 'AV1', 'VP9'];

const EDITION_WORDS = [
  'Director\'s Cut', 'Extended', 'Uncut', 'Remastered', 'IMAX', 'Criterion',
  '导演剪辑版', '加长版', '未删减', '修复版', '国配', '中字', '双语',
];

function stripExt(name) {
  const ext = path.extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

function cleanSpaces(s) {
  return s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function sanitizeTitle(s) {
  return s
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析影视文件名。
 * @param {string} filename 文件名（可带扩展名）
 * @param {{ isDir?: boolean }} opts
 */
function parseMediaName(filename, opts = {}) {
  const base = opts.isDir ? filename : stripExt(filename);
  const raw = base;
  let work = base;

  const issues = [];
  const result = {
    raw,
    title: '',
    year: null,
    season: null,
    episode: null,
    episodeEnd: null,
    resolution: null,
    source: null,
    codec: null,
    group: null,
    edition: null,
    type: 'movie',
    confidence: 0,
    issues,
  };

  // 季集
  let m = work.match(/[Ss](\d{1,2})[ ._-]?[Ee](\d{1,3})(?:[Ee](\d{1,3}))?/);
  if (m) {
    result.season = Number(m[1]);
    result.episode = Number(m[2]);
    if (m[3]) result.episodeEnd = Number(m[3]);
  } else {
    m = work.match(/(?:^|[^0-9])(\d{1,2})[xX](\d{2,3})(?:[^0-9]|$)/);
    if (m) {
      result.season = Number(m[1]);
      result.episode = Number(m[2]);
    } else {
      m = work.match(/第\s*(\d{1,4})\s*[集话話期]/);
      if (m) {
        result.episode = Number(m[1]);
        result.season = 1;
      } else {
        m = work.match(/(?:^|[^0-9A-Za-z])[Ee][Pp]?(\d{1,3})(?:[^0-9]|$)/);
        if (m) {
          result.episode = Number(m[1]);
          result.season = 1;
        }
      }
    }
  }

  // 年份（取最后一个符合上下文的四位年份）
  const yearRe = /(?:^|[.\s_\-([【])((?:19|20)\d{2})(?=[.\s_\-\])】]|$)/g;
  let ym;
  let lastYear = null;
  let lastYearIndex = -1;
  while ((ym = yearRe.exec(work)) !== null) {
    lastYear = Number(ym[1]);
    lastYearIndex = ym.index;
  }
  if (lastYear && lastYear <= new Date().getFullYear() + 2) {
    result.year = lastYear;
  }

  // 清晰度 / 片源 / 编码
  const lower = work.toLowerCase();
  for (const [tag, label] of RESOLUTIONS) {
    if (lower.includes(tag.toLowerCase())) {
      result.resolution = label;
      break;
    }
  }
  if (!result.resolution && /\b(4k|uhd)\b/i.test(work)) result.resolution = '4K';

  for (const s of SOURCES) {
    const re = new RegExp(`(^|[^a-z])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
    if (re.test(work)) {
      result.source = s.replace(/-/g, '').toUpperCase() === 'WEBRIP' ? 'WEBRip' : s;
      break;
    }
  }

  for (const c of CODECS) {
    if (new RegExp(`(^|[^a-z0-9])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(work)) {
      result.codec = c;
      break;
    }
  }

  for (const e of EDITION_WORDS) {
    if (work.includes(e)) {
      result.edition = e;
      break;
    }
  }

  // 压制组：最后一个 -XXX 片段（排除中文字幕等）
  m = work.match(/-([A-Za-z0-9@._]{2,20})$/);
  if (m && !/^(chs|cht|gb|big5|mp4|mkv)$/i.test(m[1])) {
    result.group = m[1];
  }

  // 标题：从开头截断到第一个“结构性标记”
  let titlePart = work;
  const cutMarkers = [];
  if (result.season !== null) {
    const sm = work.match(/[Ss]\d{1,2}[ ._-]?[Ee]|第\s*\d+\s*[集话話期]|\d{1,2}[xX]\d{2,3}/);
    if (sm) cutMarkers.push(sm.index);
  }
  if (result.year !== null && lastYearIndex >= 0) cutMarkers.push(lastYearIndex);
  for (const tag of [...RESOLUTIONS.map((r) => r[0]), '4K', 'UHD', ...SOURCES, ...CODECS]) {
    const idx = lower.indexOf(tag.toLowerCase());
    if (idx > 0) cutMarkers.push(idx);
  }
  if (cutMarkers.length > 0) {
    titlePart = work.slice(0, Math.min(...cutMarkers));
  }

  titlePart = cleanSpaces(titlePart)
    .replace(/^[\s\-_.[\]【】()]+/, '')
    .replace(/[\s\-_.[\]【】()]+$/, '')
    .replace(/^\d{1,3}\s*[-._]\s*/, ''); // 去掉前置序号

  result.title = sanitizeTitle(titlePart);

  // 判定类型与置信度
  if (result.season !== null || result.episode !== null) {
    result.type = 'tv';
  }
  let score = 0;
  if (result.title) score += 50;
  if (result.year) score += 30;
  if (result.type === 'tv' && result.episode !== null) score += 20;
  if (result.type === 'movie' && result.year) score += 10;
  result.confidence = Math.min(100, score);

  // 问题诊断
  if (!result.title) issues.push('无法识别标题');
  if (!result.year) issues.push('缺少年份');
  if (result.type === 'tv' && result.episode === null) issues.push('剧集缺少集号');
  if (result.type === 'tv' && result.season === null) issues.push('剧集缺少季号');
  if (/[【】\[\]（）]/.test(raw)) issues.push('含中文括号，部分刮削器识别不稳定');
  if (/\b(sample|trailer|预告)\b/i.test(raw)) issues.push('疑似样片/预告');
  if (/\b(cd1|cd2|part1|part2|disc1|disc2)\b/i.test(raw)) issues.push('疑似分盘文件，建议合并');
  if (/[\u3000]/.test(raw)) issues.push('含全角空格');

  return result;
}

/**
 * 推荐命名（飞牛影视 / Jellyfin 通用）。
 * @param {object} parsed
 * @param {{ movieTemplate?: string, tvTemplate?: string, keepExt?: string }} opts
 */
function suggestName(parsed, opts = {}) {
  const ext = opts.keepExt !== undefined ? opts.keepExt : '.mkv';
  const title = parsed.title || '未识别标题';
  const year = parsed.year ? ` (${parsed.year})` : '';
  if (parsed.type === 'tv') {
    const s = String(parsed.season ?? 1).padStart(2, '0');
    const e = String(parsed.episode ?? 1).padStart(2, '0');
    const e2 = parsed.episodeEnd ? `-E${String(parsed.episodeEnd).padStart(2, '0')}` : '';
    return `${title} - S${s}E${e}${e2}${ext}`;
  }
  return `${title}${year}${ext}`;
}

function suggestedFolder(parsed) {
  const title = parsed.title || '未识别标题';
  if (parsed.type === 'tv') return `${title} (${parsed.year || '年份'})`;
  return `${title}${parsed.year ? ` (${parsed.year})` : ''}`;
}

module.exports = { parseMediaName, suggestName, suggestedFolder, sanitizeTitle, stripExt };
