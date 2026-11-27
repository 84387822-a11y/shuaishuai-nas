'use strict';

/**
 * 通用工具：错误类型、路径沙箱、命令执行、参数校验。
 *
 * 安全约定（非常重要）：
 * 1. 所有用户传入的路径都必须经过 resolveUserPath()，它会做 realpath 并校验是否落在授权根目录内。
 * 2. 所有外部命令都必须通过 run() 调用，参数用数组传递，禁止拼接 shell 字符串。
 * 3. 所有主机名 / IP 在进入网络调用前用 isHostLike() 校验。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
  }
}

function badRequest(message, detail) {
  return new HttpError(400, message, detail);
}

function notFound(message = '资源不存在') {
  return new HttpError(404, message);
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const IS_WIN = process.platform === 'win32';

function parseRoots() {
  const raw = process.env.SS_ROOTS;

  // 未设置 = 开发环境，用常见媒体目录方便调试；
  // 设置但为空 = 明确没有授权目录（fnOS 未授权时就是这种），必须返回空而不是回退。
  if (raw === undefined) {
    const defaults = IS_WIN
      ? [process.cwd()]
      : ['/vol1', '/vol2', '/vol3', '/mnt', '/media', '/home', '/data'];
    return resolveRootList(defaults);
  }
  if (raw.trim() === '') return [];

  let list = raw
    .split(IS_WIN ? ';' : ':')
    .map((s) => s.trim())
    .filter(Boolean);

  return resolveRootList(list);
}

function resolveRootList(list) {
  const out = [];
  for (const p of list) {
    try {
      out.push(fs.realpathSync(p));
    } catch {
      // 目录暂不存在时保留原样，真正访问时会再次校验
      out.push(path.resolve(p));
    }
  }
  return [...new Set(out)];
}

const DATA_DIR = (() => {
  const p = process.env.SS_DATA_DIR || path.join(process.cwd(), 'var');
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    /* ignore */
  }
  return p;
})();

const ROOTS_FILE = path.join(DATA_DIR, 'roots.json');

/** 用户手动补加的目录（fnOS 环境变量没传过来时的兜底）。 */
function loadSavedRoots() {
  try {
    const list = JSON.parse(fs.readFileSync(ROOTS_FILE, 'utf8'));
    if (!Array.isArray(list)) return [];
    return list.filter((p) => typeof p === 'string' && p.startsWith('/') && (() => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    })());
  } catch {
    return [];
  }
}

const SAVED_ROOTS = loadSavedRoots();
let ROOTS = [...new Set([...parseRoots(), ...SAVED_ROOTS])];

const PATHS_FILE = process.env.SS_PATHS_FILE || path.join(DATA_DIR, 'paths.env');

/* ------------------------------------------------------------------ */
/* 全盘访问模式                                                        */
/* 开启后应用不再要求逐目录授权（路径沙箱放行），但仍然受 OS 读权限约束。 */
/* ------------------------------------------------------------------ */

const SETTINGS_FILE = process.env.SS_SETTINGS_FILE || path.join(DATA_DIR, 'settings.json');
let UNRESTRICTED = false;

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    UNRESTRICTED = Boolean(s && s.unrestricted);
  } catch {
    UNRESTRICTED = process.env.SS_UNRESTRICTED === '1';
  }
}
loadSettings();

function isUnrestricted() {
  return UNRESTRICTED;
}

function setUnrestricted(value) {
  UNRESTRICTED = Boolean(value);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ unrestricted: UNRESTRICTED }, null, 2), 'utf8');
  } catch {
    /* 持久化失败只影响下次启动 */
  }
  return UNRESTRICTED;
}

/** 解析 cmd 写入的 paths.env（SS_ROOTS='a:b'，单引号已转义）。 */
function readPathsFile() {
  let text;
  try {
    text = fs.readFileSync(PATHS_FILE, 'utf8');
  } catch {
    return null;
  }
  const hit = /^SS_ROOTS='([\s\S]*)'\s*$/m.exec(text);
  if (!hit) return null;
  const raw = hit[1].replace(/'\\''/g, "'").trim();
  if (!raw) return [];
  return resolveRootList(raw.split(IS_WIN ? ';' : ':').filter(Boolean));
}

function applyRoots(list) {
  const merged = [...new Set([...list, ...SAVED_ROOTS])];
  ROOTS.length = 0;
  ROOTS.push(...merged);
}

let rootsMtime = 0;
function refreshRoots(force) {
  let mtime;
  try {
    mtime = fs.statSync(PATHS_FILE).mtimeMs;
  } catch {
    return;
  }
  if (!force && mtime === rootsMtime) return;
  rootsMtime = mtime;
  const fileRoots = readPathsFile();
  if (fileRoots) applyRoots(fileRoots);
}

// 启动时以文件为准（比环境变量更新），之后每 2 秒热加载，授权保存后无需重启
refreshRoots(true);
setInterval(() => refreshRoots(false), 2000).unref();

function allowedRoots() {
  if (UNRESTRICTED) return ['/'];
  return ROOTS.slice();
}

function addRoot(realPath) {
  if (!ROOTS.includes(realPath)) {
    ROOTS.push(realPath);
    SAVED_ROOTS.push(realPath);
    try {
      fs.writeFileSync(ROOTS_FILE, JSON.stringify(SAVED_ROOTS, null, 2), 'utf8');
    } catch {
      /* 写失败只影响持久化，本次运行仍然可用 */
    }
  }
  return allowedRoots();
}

/** 应用内置追加的授权目录（写进 roots.json），只读副本。 */
function savedRoots() {
  return SAVED_ROOTS.slice();
}

/**
 * 移除一个授权目录。
 * 只作用于「应用侧手动追加」的目录（roots.json）；由 fnOS 环境变量 / paths.env
 * 授予的目录属于系统配置，不在应用内删除，避免与系统状态不一致。
 * @returns 移除后的完整授权目录列表
 */
function removeRoot(realPath) {
  const sIndex = SAVED_ROOTS.indexOf(realPath);
  if (sIndex >= 0) {
    SAVED_ROOTS.splice(sIndex, 1);
    const rIndex = ROOTS.indexOf(realPath);
    if (rIndex >= 0) ROOTS.splice(rIndex, 1);
    try {
      fs.writeFileSync(ROOTS_FILE, JSON.stringify(SAVED_ROOTS, null, 2), 'utf8');
    } catch {
      /* 写失败只影响持久化，本次运行仍然可用 */
    }
  }
  return allowedRoots();
}

/* ------------------------------------------------------------------ */
/* 路径安全                                                            */
/* ------------------------------------------------------------------ */

function compareKey(p) {
  const normalized = path.normalize(p);
  return IS_WIN ? normalized.toLowerCase() : normalized;
}

function isWithin(child, parent) {
  const rel = path.relative(compareKey(parent), compareKey(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 把用户输入解析成位于授权根目录内的真实路径。
 * @param {string} input 用户输入路径
 * @param {{ mustExist?: boolean, allowMissingLeaf?: boolean }} opts
 * @returns {string} 规范化后的真实路径
 */
function resolveUserPath(input, opts = {}) {
  const { mustExist = true, allowMissingLeaf = false } = opts;

  if (typeof input !== 'string' || input.trim() === '') {
    throw badRequest('路径不能为空');
  }
  if (input.length > 4096 || input.includes('\0')) {
    throw badRequest('路径不合法');
  }

  let target = input.trim();
  if (!path.isAbsolute(target)) {
    target = path.join(ROOTS[0] || '/', target);
  }
  target = path.resolve(target);

  let real;
  try {
    real = fs.realpathSync(target);
  } catch (err) {
    if (err.code === 'ENOENT' && allowMissingLeaf) {
      const parent = path.dirname(target);
      let realParent;
      try {
        realParent = fs.realpathSync(parent);
      } catch {
        throw badRequest(`上级目录不存在：${parent}`);
      }
      real = path.join(realParent, path.basename(target));
    } else if (err.code === 'ENOENT') {
      throw notFound(`路径不存在：${target}`);
    } else if (err.code === 'EACCES' || err.code === 'EPERM') {
      throw new HttpError(403, '没有权限访问该路径');
    } else {
      throw badRequest(`无法解析路径：${err.message}`);
    }
  }

  if (!UNRESTRICTED && !ROOTS.some((root) => isWithin(real, root))) {
    throw new HttpError(
      403,
      '路径不在授权目录内',
      `当前授权目录：${ROOTS.join('  ') || '（未配置）'}。可在页面开启「全盘访问」，或用环境变量 SS_ROOTS 追加。`
    );
  }
  if (mustExist && !fs.existsSync(real)) {
    throw notFound(`路径不存在：${real}`);
  }
  return real;
}

/** 拼接并校验：用于生成输出文件名（不要求叶子存在）。 */
function safeChild(parent, name) {
  if (typeof name !== 'string' || name.includes('\0')) throw badRequest('文件名不合法');
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw badRequest(`文件名包含非法字符：${name}`);
  }
  const full = path.join(parent, name);
  if (!isWithin(full, parent)) throw badRequest('文件名越界');
  return full;
}

/* ------------------------------------------------------------------ */
/* 命令执行                                                            */
/* ------------------------------------------------------------------ */

function findBin(name) {
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  // 服务进程的 PATH 往往不含 sbin，而 smartctl / df 等常装在 /usr/sbin
  const extraDirs = IS_WIN ? [] : ['/usr/sbin', '/sbin', '/usr/local/sbin', '/usr/local/bin', '/usr/bin', '/bin'];
  const dirs = [...new Set([...(process.env.PATH || '').split(path.delimiter), ...extraDirs])];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) return full;
      } catch {
        /* continue */
      }
    }
  }
  return null;
}

function decodeBuffer(buf) {
  if (typeof buf === 'string') return buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

/**
 * 安全执行外部命令（不经过 shell）。
 * @returns {Promise<{code:number,stdout:string,stderr:string,timedOut:boolean}>}
 */
function run(cmd, args = [], opts = {}) {
  const { timeout = 10000, maxBuffer = 8 * 1024 * 1024 } = opts;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // Windows 下 .cmd/.bat 必须经由 shell 才能被 execFile 执行（自动化测试用的假命令）
    const useShell = IS_WIN && /\.(cmd|bat)$/i.test(String(cmd));

    let child;
    try {
      child = execFile(
        cmd,
        args,
        { timeout, maxBuffer, encoding: 'buffer', windowsHide: true, killSignal: 'SIGKILL', shell: useShell },
        (err, stdout, stderr) => {
          done({
            code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
            stdout: decodeBuffer(stdout || ''),
            stderr: decodeBuffer(stderr || ''),
            timedOut: Boolean(err && err.killed),
          });
        }
      );
    } catch (err) {
      done({ code: -1, stdout: '', stderr: String(err.message || err), timedOut: false });
      return;
    }
    child.on('error', (err) => {
      done({ code: -1, stdout: '', stderr: String(err.message || err), timedOut: false });
    });
  });
}

/* ------------------------------------------------------------------ */
/* 参数校验                                                            */
/* ------------------------------------------------------------------ */

function str(value, name, { max = 2000, min = 0, allowEmpty = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw badRequest(`${name} 必须是字符串`);
  const v = value.trim();
  if (!allowEmpty && v.length === 0) throw badRequest(`${name} 不能为空`);
  if (v.length < min) throw badRequest(`${name} 长度不能少于 ${min}`);
  if (v.length > max) throw badRequest(`${name} 长度不能超过 ${max}`);
  return v;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, name, { min = -Infinity, max = Infinity, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw badRequest(`${name} 不能为空`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`${name} 必须是数字`);
  const i = Math.trunc(n);
  if (i < min || i > max) throw badRequest(`${name} 必须在 ${min} ~ ${max} 之间`);
  return i;
}

function oneOf(value, name, list) {
  if (!list.includes(value)) throw badRequest(`${name} 必须是 ${list.join(' / ')} 之一`);
  return value;
}

function isHostLike(host) {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) return false;
  if (host.includes('..') || /[\s/\\<>"'`;|&$]/.test(host)) return false;
  // IPv4 / IPv6 / 主机名（含单标签，便于局域网 NAS）
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6 = /^[0-9a-fA-F:]+$/;
  const hostname = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
  if (ipv4.test(host)) return host.split('.').every((p) => Number(p) >= 0 && Number(p) <= 255);
  if (host.includes(':')) return ipv6.test(host);
  return hostname.test(host);
}

function isPrivateHost(host) {
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

module.exports = {
  HttpError,
  badRequest,
  notFound,
  IS_WIN,
  DATA_DIR,
  ROOTS,
  allowedRoots,
  addRoot,
  savedRoots,
  removeRoot,
  isUnrestricted,
  setUnrestricted,
  resolveUserPath,
  isWithin,
  safeChild,
  findBin,
  run,
  decodeBuffer,
  str,
  bool,
  int,
  oneOf,
  isHostLike,
  isPrivateHost,
};
