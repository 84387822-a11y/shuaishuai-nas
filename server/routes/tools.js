'use strict';

/**
 * 常用小工具：哈希、Base64、URL 编解码、JSON、时间戳、Cron、密码、
 * UUID、文本处理、chmod 权限换算。
 *
 * 全部是纯本地计算：不读写文件、不访问网络、不调用外部命令。
 */

const crypto = require('node:crypto');
const { str, int, bool, oneOf, badRequest, HttpError } = require('../lib/util');

const MAX_TEXT_BYTES = 200 * 1024;
const MAX_TEXT_KB = MAX_TEXT_BYTES / 1024;

/* ------------------------------------------------------------------ */
/* 通用参数                                                            */
/* ------------------------------------------------------------------ */

/** 读取原始文本：保留用户输入的空白，只校验类型与 200KB 上限。 */
function textArg(value, name) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw badRequest(`${name}必须是字符串`);
  const size = Buffer.byteLength(value, 'utf8');
  if (size > MAX_TEXT_BYTES) {
    throw new HttpError(413, `${name}过大（${size} 字节），上限 ${MAX_TEXT_KB} KB`);
  }
  return value;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/* ------------------------------------------------------------------ */
/* 哈希                                                                */
/* ------------------------------------------------------------------ */

function hashText(ctx) {
  const text = textArg(ctx.body.text, '文本');
  const buf = Buffer.from(text, 'utf8');
  const digest = (name) => crypto.createHash(name).update(buf).digest('hex');

  return {
    md5: digest('md5'),
    sha1: digest('sha1'),
    sha256: digest('sha256'),
    sha512: digest('sha512'),
    bytes: buf.length,
    length: Array.from(text).length,
  };
}

/* ------------------------------------------------------------------ */
/* Base64                                                              */
/* ------------------------------------------------------------------ */

function base64(ctx) {
  const text = textArg(ctx.body.text, '内容');
  const mode = oneOf(String(ctx.body.mode || 'encode'), '模式', ['encode', 'decode']);
  const urlSafe = bool(ctx.body.urlSafe, false);

  if (mode === 'encode') {
    const buf = Buffer.from(text, 'utf8');
    let result = buf.toString('base64');
    if (urlSafe) result = result.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return {
      result,
      bytesIn: buf.length,
      bytesOut: Buffer.byteLength(result, 'utf8'),
    };
  }

  // 解码：容忍换行与空格，支持 URL 安全字符，缺省补全 = 号。
  let input = text.replace(/\s+/g, '');
  if (input.length === 0) throw badRequest('Base64 内容不合法');
  if (urlSafe) input = input.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input)) throw badRequest('Base64 内容不合法');

  const core = input.replace(/=+$/, '');
  if (core.length % 4 === 1) throw badRequest('Base64 内容不合法');
  const padded = core + '='.repeat((4 - (core.length % 4)) % 4);
  const buf = Buffer.from(padded, 'base64');

  // 只接受规范编码，避免把随意字符静默解码成空内容。
  if (buf.toString('base64').replace(/=+$/, '') !== core) {
    throw badRequest('Base64 内容不合法');
  }

  let result;
  try {
    result = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw badRequest('Base64 解码结果不是有效的 UTF-8 文本');
  }

  return {
    result,
    bytesIn: Buffer.byteLength(text, 'utf8'),
    bytesOut: buf.length,
  };
}

/* ------------------------------------------------------------------ */
/* URL 编解码                                                          */
/* ------------------------------------------------------------------ */

function urlCodec(ctx) {
  const text = textArg(ctx.body.text, '内容');
  const mode = oneOf(String(ctx.body.mode || 'encode'), '模式', ['encode', 'decode']);

  if (mode === 'encode') return { result: encodeURIComponent(text) };

  try {
    return { result: decodeURIComponent(text) };
  } catch {
    throw badRequest('URL 编码内容不合法，请检查百分号转义是否完整');
  }
}

/* ------------------------------------------------------------------ */
/* JSON                                                                */
/* ------------------------------------------------------------------ */

function emptyJsonStats() {
  return { keys: 0, depth: 0, arrays: 0, strings: 0, numbers: 0, booleans: 0, nulls: 0 };
}

/** 递归统计键数量、最大深度与各类型叶子节点数量。 */
function walkJson(value, level, stats) {
  if (Array.isArray(value)) {
    stats.arrays += 1;
    stats.depth = Math.max(stats.depth, level + 1);
    for (const item of value) walkJson(item, level + 1, stats);
    return;
  }

  if (value !== null && typeof value === 'object') {
    stats.keys += Object.keys(value).length;
    stats.depth = Math.max(stats.depth, level + 1);
    for (const key of Object.keys(value)) walkJson(value[key], level + 1, stats);
    return;
  }

  if (value === null) stats.nulls += 1;
  else if (typeof value === 'string') stats.strings += 1;
  else if (typeof value === 'number') stats.numbers += 1;
  else if (typeof value === 'boolean') stats.booleans += 1;
}

/** 把 V8 的英文解析错误转成带行列位置的中文提示。 */
function jsonErrorMessage(err, text) {
  const message = String((err && err.message) || '');
  const matched = /position\s+(\d+)/i.exec(message);
  if (matched) {
    const pos = Math.min(Number(matched[1]), text.length);
    let line = 1;
    let col = 1;
    for (let i = 0; i < pos; i += 1) {
      if (text[i] === '\n') {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
    }
    return `JSON 格式错误：第 ${line} 行第 ${col} 列附近存在语法问题`;
  }
  return 'JSON 格式错误：请检查引号、逗号与括号是否配对';
}

function jsonTool(ctx) {
  const text = textArg(ctx.body.text, 'JSON 内容');
  const mode = oneOf(String(ctx.body.mode || 'pretty'), '模式', ['pretty', 'minify', 'validate']);

  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return {
      valid: false,
      result: '',
      error: jsonErrorMessage(err, text),
      stats: emptyJsonStats(),
    };
  }

  const stats = emptyJsonStats();
  walkJson(value, 0, stats);

  let result;
  if (mode === 'minify') result = JSON.stringify(value);
  else if (mode === 'validate') result = text;
  else result = JSON.stringify(value, null, 2);

  return { valid: true, result, error: '', stats };
}

/* ------------------------------------------------------------------ */
/* 时间戳                                                              */
/* ------------------------------------------------------------------ */

function formatLocal(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatUtc(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ` +
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

function relativeTime(targetMs) {
  const diff = targetMs - Date.now();
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '后' : '前';

  if (abs < 5000) return '刚刚';

  const units = [
    [365 * 86400000, '年'],
    [30 * 86400000, '个月'],
    [86400000, '天'],
    [3600000, '小时'],
    [60000, '分钟'],
    [1000, '秒'],
  ];
  for (const [size, label] of units) {
    if (abs >= size) return `${Math.floor(abs / size)} ${label}${suffix}`;
  }
  return '刚刚';
}

function weekName(date) {
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  return `星期${names[date.getDay()]}`;
}

function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 1);
  const current = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((current - start) / 86400000) + 1;
}

function parseDateText(text) {
  let value = text;
  // 纯日期按本地 00:00:00 解析，避免被当成 UTC 零点。
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(value)) {
    value = `${value.replace(/\//g, '-')}T00:00:00`;
  } else if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{1,2}(:\d{1,2})?$/.test(value)) {
    value = value.replace(/\//g, '-').replace(' ', 'T');
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw badRequest('无法识别的时间，请输入 10 位秒级时间戳、13 位毫秒级时间戳或日期字符串');
  }
  return ms;
}

function timeTool(ctx) {
  const from = oneOf(String(ctx.body.from || 'auto'), '来源', ['auto', 's', 'ms', 'date']);
  const raw = ctx.body.value;
  const text = typeof raw === 'number' ? String(raw) : (typeof raw === 'string' ? raw.trim() : '');
  if (!text) throw badRequest('时间不能为空');
  if (text.length > 200) throw badRequest('时间内容过长');

  let ms;
  if (from === 's' || (from === 'auto' && /^-?\d{10}$/.test(text))) {
    if (!/^-?\d+$/.test(text)) throw badRequest('秒级时间戳必须是整数');
    ms = Number(text) * 1000;
  } else if (from === 'ms' || (from === 'auto' && /^-?\d{13}$/.test(text))) {
    if (!/^-?\d+$/.test(text)) throw badRequest('毫秒级时间戳必须是整数');
    ms = Number(text);
  } else if (from === 'auto') {
    if (/^-?\d+$/.test(text)) {
      throw badRequest('时间戳必须是 10 位（秒）或 13 位（毫秒），或改用日期字符串');
    }
    ms = parseDateText(text);
  } else {
    if (/^-?\d+$/.test(text)) throw badRequest('日期格式不合法，请输入如 2024-01-01 12:00:00');
    ms = parseDateText(text);
  }

  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) throw badRequest('时间无效');

  return {
    iso: date.toISOString(),
    local: formatLocal(date),
    utc: `${formatUtc(date)} UTC`,
    timestamp: Math.floor(ms / 1000),
    timestampMs: ms,
    relative: relativeTime(ms),
    week: weekName(date),
    dayOfYear: dayOfYear(date),
  };
}

/* ------------------------------------------------------------------ */
/* Cron                                                                */
/* ------------------------------------------------------------------ */

const CRON_ALIASES = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const DOW_NAMES = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

const CRON_FIELDS = {
  second: { label: '秒', min: 0, max: 59 },
  minute: { label: '分钟', min: 0, max: 59 },
  hour: { label: '小时', min: 0, max: 23 },
  dom: { label: '日', min: 1, max: 31 },
  month: { label: '月', min: 1, max: 12, names: MONTH_NAMES },
  dow: { label: '星期', min: 0, max: 7, names: DOW_NAMES, normalize: (v) => (v === 7 ? 0 : v) },
};

function cronValue(token, cfg) {
  const value = token.toUpperCase();
  if (cfg.names && Object.prototype.hasOwnProperty.call(cfg.names, value)) return cfg.names[value];
  if (!/^\d+$/.test(value)) throw badRequest(`Cron ${cfg.label}字段含有无法识别的值：${token}`);
  return Number(value);
}

/** 解析单段 Cron：星号、a、a-b、a,b,c、星号/n、a-b/n。 */
function parseCronField(raw, key) {
  const cfg = CRON_FIELDS[key];
  const text = raw.trim();
  if (!text) throw badRequest(`Cron ${cfg.label}字段不能为空`);
  if (text.length > 120) throw badRequest(`Cron ${cfg.label}字段过长`);

  const values = new Set();
  for (const part of text.split(',')) {
    if (!part) throw badRequest(`Cron ${cfg.label}字段含有空项（多余的逗号）`);

    const chunks = part.split('/');
    if (chunks.length > 2) throw badRequest(`Cron ${cfg.label}字段的步长写法不合法：${part}`);

    let step = 1;
    if (chunks.length === 2) {
      if (!/^\d+$/.test(chunks[1]) || Number(chunks[1]) < 1) {
        throw badRequest(`Cron ${cfg.label}字段的步长必须是正整数：${part}`);
      }
      step = Number(chunks[1]);
    }

    const body = chunks[0];
    let lo;
    let hi;
    if (body === '*') {
      lo = cfg.min;
      hi = cfg.max;
    } else if (body.includes('-')) {
      const pair = body.split('-');
      if (pair.length !== 2) throw badRequest(`Cron ${cfg.label}字段的区间写法不合法：${part}`);
      lo = cronValue(pair[0], cfg);
      hi = cronValue(pair[1], cfg);
    } else {
      lo = cronValue(body, cfg);
      hi = chunks.length === 2 ? cfg.max : lo;
    }

    if (lo < cfg.min || lo > cfg.max || hi < cfg.min || hi > cfg.max) {
      throw badRequest(`Cron ${cfg.label}字段的值超出范围 ${cfg.min}-${cfg.max}：${part}`);
    }
    if (lo > hi) throw badRequest(`Cron ${cfg.label}字段的区间起点大于终点：${part}`);

    for (let v = lo; v <= hi; v += step) {
      values.add(cfg.normalize ? cfg.normalize(v) : v);
    }
  }

  if (values.size === 0) throw badRequest(`Cron ${cfg.label}字段没有有效取值`);
  return Array.from(values).sort((a, b) => a - b);
}

function parseCron(expr) {
  let text = str(expr, 'Cron 表达式', { max: 200 }).trim();
  const lower = text.toLowerCase();
  if (lower.startsWith('@')) {
    if (!CRON_ALIASES[lower]) throw badRequest(`不支持的 Cron 快捷写法：${text}`);
    text = CRON_ALIASES[lower];
  }

  const parts = text.split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    throw badRequest('Cron 表达式必须是 5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周）');
  }

  const hasSeconds = parts.length === 6;
  const offset = hasSeconds ? 1 : 0;
  const domRaw = parts[offset + 2];
  const dowRaw = parts[offset + 4];

  return {
    raw: text,
    rawFields: parts,
    hasSeconds,
    second: hasSeconds ? parseCronField(parts[0], 'second') : [0],
    minute: parseCronField(parts[offset], 'minute'),
    hour: parseCronField(parts[offset + 1], 'hour'),
    dom: parseCronField(domRaw, 'dom'),
    month: parseCronField(parts[offset + 3], 'month'),
    dow: parseCronField(dowRaw, 'dow'),
    domRestricted: domRaw.trim() !== '*',
    dowRestricted: dowRaw.trim() !== '*',
  };
}

function isFullRange(values, min, max) {
  return values.length === max - min + 1 && values[0] === min && values[values.length - 1] === max;
}

function isContiguous(values) {
  return values.length > 1 && values.every((v, i) => i === 0 || v === values[i - 1] + 1);
}

/** 星期几匹配：日/周同时受限时按标准 Cron 的「或」语义。 */
function dayMatches(parsed, date) {
  if (!parsed.month.includes(date.getMonth() + 1)) return false;
  const domOk = parsed.dom.includes(date.getDate());
  const dowOk = parsed.dow.includes(date.getDay());
  if (parsed.domRestricted && parsed.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/** 5 段表达式：按天推进，命中日期后再枚举小时/分钟。 */
function nextMinuteCron(parsed, count, now) {
  const out = [];
  const maxDays = 366 * 20;
  const start = new Date(now.getTime());
  start.setSeconds(0, 0);
  if (start.getTime() <= now.getTime()) start.setMinutes(start.getMinutes() + 1);
  const startMs = start.getTime();

  for (let day = 0; day < maxDays && out.length < count; day += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day);
    if (!dayMatches(parsed, date)) continue;

    for (const hour of parsed.hour) {
      for (const minute of parsed.minute) {
        const candidate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
        // 跳过夏令时切换造成的不存在时刻。
        if (candidate.getDate() !== date.getDate() || candidate.getHours() !== hour) continue;
        if (candidate.getTime() < startMs) continue;
        out.push(candidate);
        if (out.length >= count) break;
      }
      if (out.length >= count) break;
    }
  }
  return out;
}

/** 6 段表达式：逐秒搜索，按需求只在未来 24 小时内查找。 */
function nextSecondCron(parsed, count, now) {
  const out = [];
  const endMs = now.getTime() + 86400000;
  let current = Math.floor(now.getTime() / 1000) * 1000 + 1000;

  for (; current <= endMs && out.length < count; current += 1000) {
    const date = new Date(current);
    if (!parsed.month.includes(date.getMonth() + 1)) continue;
    if (!parsed.hour.includes(date.getHours())) continue;
    if (!parsed.minute.includes(date.getMinutes())) continue;
    if (!parsed.second.includes(date.getSeconds())) continue;
    if (!dayMatches(parsed, date)) continue;
    out.push(date);
  }
  return out;
}

function weekRange(values) {
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  const sorted = values.slice().sort((a, b) => a - b);
  if (isContiguous(sorted)) {
    return `周${names[sorted[0]]}至周${names[sorted[sorted.length - 1]]}`;
  }
  return sorted.map((v) => `周${names[v]}`).join('、');
}

function monthText(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (isContiguous(sorted)) return `${sorted[0]} 月至 ${sorted[sorted.length - 1]} 月`;
  return `${sorted.join('、')} 月`;
}

function domText(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (isContiguous(sorted)) return `${sorted[0]} 日至 ${sorted[sorted.length - 1]} 日`;
  return `${sorted.join('、')} 日`;
}

function cronFieldMeaning(key, raw, values) {
  const text = raw.trim();
  const every = text === '*';
  const step = /^\*\/(\d+)$/.exec(text);

  if (key === 'second') {
    if (every) return '每秒';
    if (step) return `每 ${Number(step[1])} 秒`;
    if (values.length === 1) return `第 ${values[0]} 秒`;
    return `第 ${values.join('、')} 秒`;
  }
  if (key === 'minute') {
    if (every) return '每分钟';
    if (step) return `每 ${Number(step[1])} 分钟`;
    if (values.length === 1) return `每小时第 ${values[0]} 分钟`;
    return `每小时的第 ${values.join('、')} 分钟`;
  }
  if (key === 'hour') {
    if (every) return '每小时';
    if (step) return `每 ${Number(step[1])} 小时`;
    return `每天 ${values.map((v) => `${pad2(v)}:00`).join('、')}`;
  }
  if (key === 'dom') {
    if (every) return '每天';
    if (step) return `每 ${Number(step[1])} 天`;
    if (values.length === 1) return `每月 ${values[0]} 日`;
    return `每月的 ${values.join('、')} 日`;
  }
  if (key === 'month') {
    if (every) return '每月';
    if (step) return `每 ${Number(step[1])} 个月`;
    return `${values.join('、')} 月`;
  }
  if (key === 'dow') {
    if (every || values.length === 7) return '不限制星期';
    return weekRange(values);
  }
  return text;
}

function buildCronFields(parsed) {
  const offset = parsed.hasSeconds ? 1 : 0;
  const defs = [
    { key: 'minute', name: '分钟', raw: parsed.rawFields[offset], values: parsed.minute },
    { key: 'hour', name: '小时', raw: parsed.rawFields[offset + 1], values: parsed.hour },
    { key: 'dom', name: '日', raw: parsed.rawFields[offset + 2], values: parsed.dom },
    { key: 'month', name: '月', raw: parsed.rawFields[offset + 3], values: parsed.month },
    { key: 'dow', name: '星期', raw: parsed.rawFields[offset + 4], values: parsed.dow },
  ];
  if (parsed.hasSeconds) {
    defs.unshift({ key: 'second', name: '秒', raw: parsed.rawFields[0], values: parsed.second });
  }
  return defs.map((item) => ({
    name: item.name,
    value: item.raw,
    meaning: cronFieldMeaning(item.key, item.raw, item.values),
  }));
}

/** 生成「每天 03:00 执行」这类中文描述。 */
function describeCron(parsed) {
  const allDay = isFullRange(parsed.month, 1, 12) &&
    isFullRange(parsed.dom, 1, 31) &&
    isFullRange(parsed.dow, 0, 6);

  let dayPart = '每天';
  if (!allDay) {
    const monthPart = isFullRange(parsed.month, 1, 12) ? '' : monthText(parsed.month);
    const domPart = isFullRange(parsed.dom, 1, 31) ? '' : domText(parsed.dom);
    const dowPart = isFullRange(parsed.dow, 0, 6) ? '' : weekRange(parsed.dow);

    if (monthPart && domPart && dowPart) dayPart = `每年 ${monthPart} ${domPart}或每${dowPart}`;
    else if (monthPart && domPart) dayPart = `每年 ${monthPart} ${domPart}`;
    else if (monthPart && dowPart) dayPart = `每年 ${monthPart}的每${dowPart}`;
    else if (monthPart) dayPart = `每年 ${monthPart}的每天`;
    else if (domPart && dowPart) dayPart = `每月 ${domPart} 或每${dowPart}`;
    else if (domPart) dayPart = `每月 ${domPart}`;
    else if (dowPart) dayPart = `每${dowPart}`;
  }

  const hourAll = isFullRange(parsed.hour, 0, 23);
  const minuteAll = isFullRange(parsed.minute, 0, 59);
  const secondAll = !parsed.hasSeconds || isFullRange(parsed.second, 0, 59);

  let timePart;
  if (hourAll && minuteAll && secondAll) {
    timePart = '每分钟';
  } else if (hourAll && minuteAll) {
    timePart = `每分钟的第 ${parsed.second.join('、')} 秒`;
  } else if (hourAll) {
    const minuteRaw = parsed.rawFields[parsed.hasSeconds ? 1 : 0].trim();
    const step = /^\*\/(\d+)$/.exec(minuteRaw);
    if (step && secondAll) timePart = `每 ${Number(step[1])} 分钟`;
    else if (secondAll && parsed.minute.length === 1) timePart = `每小时第 ${parsed.minute[0]} 分钟`;
    else timePart = `每小时的第 ${parsed.minute.join('、')} 分钟`;
  } else {
    const withSeconds = parsed.hasSeconds &&
      !(parsed.second.length === 1 && parsed.second[0] === 0);
    const times = [];
    for (const hour of parsed.hour) {
      for (const minute of parsed.minute) {
        if (withSeconds) {
          for (const second of parsed.second) {
            times.push(`${pad2(hour)}:${pad2(minute)}:${pad2(second)}`);
          }
        } else {
          times.push(`${pad2(hour)}:${pad2(minute)}`);
        }
      }
    }
    timePart = times.length <= 8
      ? times.join('、')
      : `${times.slice(0, 8).join('、')} 等 ${times.length} 个时刻`;
  }

  if (allDay && timePart.includes(':')) return `每天 ${timePart} 执行`;
  if (allDay && timePart.startsWith('每')) return `${timePart}执行`;
  return `${dayPart} ${timePart} 执行`;
}

function serverTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时区';
  } catch {
    return '本地时区';
  }
}

function cronTool(ctx) {
  const count = int(ctx.body.count, '计算次数', { min: 1, max: 5, fallback: 5 });
  const timezone = serverTimezone();

  let parsed;
  try {
    parsed = parseCron(ctx.body.expr);
  } catch (err) {
    if (err instanceof HttpError) {
      return {
        valid: false,
        error: err.message,
        description: '',
        fields: [],
        next: [],
        timezone,
      };
    }
    throw err;
  }

  const now = new Date();
  const dates = parsed.hasSeconds
    ? nextSecondCron(parsed, count, now)
    : nextMinuteCron(parsed, count, now);

  let error = '';
  if (dates.length === 0) {
    error = parsed.hasSeconds
      ? '未来 24 小时内没有匹配的触发时间，请检查表达式'
      : '未来 20 年内没有匹配的触发时间，请检查日期组合是否成立';
  }

  return {
    valid: true,
    error,
    description: describeCron(parsed),
    fields: buildCronFields(parsed),
    next: dates.map((date) => date.toISOString()),
    timezone,
  };
}

/* ------------------------------------------------------------------ */
/* 密码与 UUID                                                         */
/* ------------------------------------------------------------------ */

const PASSWORD_LOWER = 'abcdefghijklmnopqrstuvwxyz';
const PASSWORD_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PASSWORD_DIGITS = '0123456789';
const PASSWORD_SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?/';

function passwordTool(ctx) {
  const length = int(ctx.body.length, '密码长度', { min: 4, max: 128, fallback: 20 });
  const count = int(ctx.body.count, '生成数量', { min: 1, max: 20, fallback: 1 });
  const withSymbols = bool(ctx.body.symbols, true);

  let charset = PASSWORD_LOWER + PASSWORD_UPPER + PASSWORD_DIGITS;
  if (withSymbols) charset += PASSWORD_SYMBOLS;

  const passwords = [];
  for (let i = 0; i < count; i += 1) {
    let password = '';
    for (let j = 0; j < length; j += 1) {
      password += charset[crypto.randomInt(0, charset.length)];
    }
    passwords.push(password);
  }

  const entropy = Number((length * Math.log2(charset.length)).toFixed(1));
  return { passwords, entropy };
}

function uuidTool(ctx) {
  const count = int(ctx.body.count, '生成数量', { min: 1, max: 50, fallback: 1 });
  const uuids = [];
  for (let i = 0; i < count; i += 1) uuids.push(crypto.randomUUID());
  return { uuids };
}

/* ------------------------------------------------------------------ */
/* 文本处理                                                            */
/* ------------------------------------------------------------------ */

const TEXT_OPS = ['sort', 'dedupe', 'trim', 'reverse', 'upper', 'lower', 'slug', 'count'];

function countText(text) {
  return {
    chars: Array.from(text).length,
    lines: text === '' ? 0 : text.split(/\r\n|\r|\n/).length,
    words: (text.match(/\S+/g) || []).length,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function textTool(ctx) {
  const text = textArg(ctx.body.text, '文本');
  const op = oneOf(String(ctx.body.op || 'trim'), '操作', TEXT_OPS);

  if (op === 'count') return { stats: countText(text) };

  const lines = text.split(/\r\n|\r|\n/);
  let result;
  if (op === 'sort') {
    result = lines.slice().sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')).join('\n');
  } else if (op === 'dedupe') {
    result = Array.from(new Set(lines)).join('\n');
  } else if (op === 'trim') {
    result = lines.map((line) => line.trim()).filter((line) => line.length > 0).join('\n');
  } else if (op === 'reverse') {
    result = lines.slice().reverse().join('\n');
  } else if (op === 'upper') {
    result = text.toUpperCase();
  } else if (op === 'lower') {
    result = text.toLowerCase();
  } else {
    result = slugify(text);
  }

  return {
    result,
    before: Array.from(text).length,
    after: Array.from(result).length,
  };
}

/* ------------------------------------------------------------------ */
/* chmod                                                               */
/* ------------------------------------------------------------------ */

const PERM_READ = [0o400, 0o040, 0o004];
const PERM_WRITE = [0o200, 0o020, 0o002];
const PERM_EXEC = [0o100, 0o010, 0o001];

function parseSymbolicMode(text) {
  const triads = [text.slice(0, 3), text.slice(3, 6), text.slice(6, 9)];
  let total = 0;

  for (let i = 0; i < 3; i += 1) {
    const [read, write, exec] = triads[i];
    if (read !== 'r' && read !== '-') throw badRequest('权限写法不合法，请输入 755、0755 或 rwxr-xr-x');
    if (write !== 'w' && write !== '-') throw badRequest('权限写法不合法，请输入 755、0755 或 rwxr-xr-x');

    const allowed = i < 2 ? ['x', 's', 'S', '-'] : ['x', 't', 'T', '-'];
    if (!allowed.includes(exec)) throw badRequest('权限写法不合法，请输入 755、0755 或 rwxr-xr-x');

    let part = 0;
    if (read === 'r') part |= PERM_READ[i];
    if (write === 'w') part |= PERM_WRITE[i];
    if (exec === 'x' || exec === 's' || exec === 't') part |= PERM_EXEC[i];

    if (i === 0 && (exec === 's' || exec === 'S')) total |= 0o4000;
    if (i === 1 && (exec === 's' || exec === 'S')) total |= 0o2000;
    if (i === 2 && (exec === 't' || exec === 'T')) total |= 0o1000;

    total |= part;
  }

  return total;
}

function symbolicFromBits(bits) {
  const chars = [];
  for (let i = 0; i < 3; i += 1) {
    chars.push((bits & PERM_READ[i]) !== 0 ? 'r' : '-');
    chars.push((bits & PERM_WRITE[i]) !== 0 ? 'w' : '-');
    const executable = (bits & PERM_EXEC[i]) !== 0;
    let execChar = executable ? 'x' : '-';
    if (i === 0 && (bits & 0o4000)) execChar = executable ? 's' : 'S';
    else if (i === 1 && (bits & 0o2000)) execChar = executable ? 's' : 'S';
    else if (i === 2 && (bits & 0o1000)) execChar = executable ? 't' : 'T';
    chars.push(execChar);
  }
  return chars.join('');
}

function permissionSummary(triad, who) {
  const actions = [];
  if (triad[0] === 'r') actions.push('读');
  if (triad[1] === 'w') actions.push('写');
  if (triad[2] === 'x' || triad[2] === 's' || triad[2] === 't') actions.push('执行');
  if (actions.length === 0) return `${who}无权限`;
  return `${who}可${actions.join('、')}`;
}

function chmodTool(ctx) {
  const raw = ctx.body.mode;
  if (raw === undefined || raw === null || raw === '') throw badRequest('权限不能为空');
  const input = String(raw).trim();
  if (input.length > 20) throw badRequest('权限写法不合法，请输入 755、0755 或 rwxr-xr-x');

  let bits;
  if (/^[0-7]{3,4}$/.test(input)) {
    bits = parseInt(input, 8);
  } else if (/^[rwxstST-]{9}$/.test(input)) {
    bits = parseSymbolicMode(input);
  } else {
    throw badRequest('权限写法不合法，请输入 755、0755 或 rwxr-xr-x');
  }

  const symbolic = symbolicFromBits(bits);
  const owner = symbolic.slice(0, 3);
  const group = symbolic.slice(3, 6);
  const other = symbolic.slice(6, 9);
  const special = bits & 0o7000;
  const octal = special
    ? bits.toString(8).padStart(4, '0')
    : (bits & 0o777).toString(8).padStart(3, '0');

  const summary = [
    permissionSummary(owner, '所有者'),
    permissionSummary(group, '同组用户'),
    permissionSummary(other, '其他用户'),
  ].join('；');

  const warnings = [];
  if (input === '777' || input === '0777' || (bits & 0o777) === 0o777) {
    warnings.push('777 权限过于宽松，任何用户都能读、写、执行，建议改为 755（目录）或 644（文件）。');
  } else if (bits & 0o002) {
    warnings.push('其他用户拥有写权限，存在被篡改的风险，建议去掉写权限。');
  }
  if (bits & 0o4000) warnings.push('已设置 setuid 位，执行时会临时获得文件所有者权限，请确认是否符合预期。');
  if (bits & 0o2000) warnings.push('已设置 setgid 位，新建文件会继承所属组，请确认是否符合预期。');
  if (bits & 0o1000) warnings.push('已设置粘滞位（sticky bit），仅文件所有者可删除自己的文件。');

  return {
    octal,
    symbolic,
    owner,
    group,
    other,
    summary,
    warning: warnings.join(' '),
  };
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* 查快递                                                              */
/* ------------------------------------------------------------------ */

/** 常见快递公司（快递100 com 代码）。 */
const EXPRESS_COMS = [
  { com: 'auto', label: '自动识别' },
  { com: 'shunfeng', label: '顺丰速运' },
  { com: 'yuantong', label: '圆通速递' },
  { com: 'zhongtong', label: '中通快递' },
  { com: 'shentong', label: '申通快递' },
  { com: 'yunda', label: '韵达快递' },
  { com: 'jtexpress', label: '极兔速递' },
  { com: 'jd', label: '京东物流' },
  { com: 'ems', label: 'EMS' },
  { com: 'youzhengguonei', label: '邮政快递包裹' },
  { com: 'debangkuaidi', label: '德邦快递' },
  { com: 'baisi', label: '百世快递' },
];
const EXPRESS_BY_COM = new Map(EXPRESS_COMS.map((c) => [c.com, c]));
const KUAIDI100_API = 'https://api.kuaidi100.com/api';
const KUAIDI100_WEB = 'https://www.kuaidi100.com/';
const EXPRESS_TIMEOUT = 12000;

/** 用单号前缀粗略识别常见快递，识别不到就回退到用户选择。 */
function detectExpressCom(num) {
  const n = String(num || '').trim().toUpperCase();
  if (/^SF/i.test(n)) return 'shunfeng';
  if (/^[A-Z]{2}\d{9}CN/.test(n)) return 'ems'; // EA123456789CN
  if (/^[A-Z]{2}\d{9}[A-Z]{2}/.test(n)) return 'youzhengguonei'; // LD123456789XX
  if (/^JD\d{13,}/i.test(n)) return 'jd';
  if (n.length === 10 && /^JT\d{8}$/.test(n)) return 'jtexpress';
  return null;
}

function officialUrl(com, num) {
  const n = String(num || '').trim();
  const q = new URL(KUAIDI100_WEB);
  q.searchParams.set('nu', n);
  if (com && com !== 'auto') q.searchParams.set('com', com);
  return q.toString();
}

async function express(ctx) {
  const num = str(ctx.body.num, '快递单号', { max: 64 }).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9-]{6,30}$/.test(num)) {
    throw badRequest('单号格式不正确：只支持字母/数字/连字符，6~30 位');
  }

  const askedCom = oneOf(String(ctx.body.com || 'auto'), '快递公司',
    EXPRESS_COMS.map((c) => c.com));
  const detected = detectExpressCom(num);
  const com = (askedCom === 'auto' && detected) ? detected : askedCom;
  const comLabel = (EXPRESS_BY_COM.get(com) || {}).label || com;
  const url = officialUrl(com, num);

  // 没有快递100 key：给出一键跳官方查单页 + 配置指引
  const key = String(ctx.body.key || '').trim();
  if (!key) {
    return {
      needKey: true,
      num,
      com,
      comLabel,
      detected: detected ? EXPRESS_BY_COM.get(detected).label : null,
      url,
      guide: '未配置快递100 API Key。可在查询框旁的「查单方式」里选「跳官方页面」直接打开官方查单页；要本工具内直接返回物流轨迹，请到 https://www.kuaidi100.com/openapi 申请免费 Key 填入。',
    };
  }

  const q = new URL(KUAIDAI100_API);
  q.searchParams.set('id', key);
  q.searchParams.set('com', com);
  q.searchParams.set('nu', num);
  q.searchParams.set('show', '0');
  q.searchParams.set('muti', '1');
  q.searchParams.set('order', 'desc');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPRESS_TIMEOUT);
  let json;
  try {
    const res = await fetch(q.toString(), {
      signal: controller.signal,
      headers: { 'User-Agent': 'ShuaiShuaiNAS-Tools/1.0', Accept: 'application/json' },
    });
    if (!res.ok) throw new HttpError(502, '快递查询服务异常', `HTTP ${res.status}`);
    try {
      json = await res.json();
    } catch {
      throw new HttpError(502, '快递查询返回的不是有效 JSON');
    }
  } catch (err) {
    if (err && err.name === 'AbortError') throw new HttpError(504, '快递查询超时');
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, '快递查询失败', err.message || '');
  } finally {
    clearTimeout(timer);
  }

  if (!json || json.status !== '200') {
    throw new HttpError(422, json && json.message ? json.message : '查询失败，请检查 Key / 快递公司 / 单号是否正确');
  }

  const items = Array.isArray(json.data) ? json.data : [];
  const timeline = items.map((it) => ({
    time: it.time || '',
    context: it.context || '',
    location: it.location || '',
    areaCode: it.areaCode || '',
    status: it.status || null,
  }));

  return {
    needKey: false,
    num,
    com,
    comLabel,
    state: json.state,
    stateText: ['在途', '揽收', '疑难', '签收', '退签', '派件', '退回'][Number(json.state)] || '未知',
    message: json.message || '',
    url,
    timeline,
    updatedAt: json.updateTime ? new Date(json.updateTime).toISOString() : new Date().toISOString(),
    hint: '物流轨迹由快递100 提供（你填的 Key）。结果仅供参考；跳官方查单页始终可用。',
  };
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

module.exports = [
  ['POST', '/api/tools/hash', hashText],
  ['POST', '/api/tools/base64', base64],
  ['POST', '/api/tools/url', urlCodec],
  ['POST', '/api/tools/json', jsonTool],
  ['POST', '/api/tools/time', timeTool],
  ['POST', '/api/tools/cron', cronTool],
  ['POST', '/api/tools/password', passwordTool],
  ['POST', '/api/tools/uuid', uuidTool],
  ['POST', '/api/tools/text', textTool],
  ['POST', '/api/tools/chmod', chmodTool],
  ['GET', '/api/tools/express/coms', () => ({ coms: EXPRESS_COMS })],
  ['POST', '/api/tools/express', express],
];
