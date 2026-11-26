'use strict';

/**
 * 系统信息：版本、运行环境、授权目录、能力探测。
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PKG = require('../../package.json');
const {
  allowedRoots, addRoot, savedRoots, removeRoot, findBin, DATA_DIR, HttpError,
  str, badRequest, notFound, isUnrestricted, setUnrestricted, bool,
} = require('../lib/util');
const auth = require('../lib/auth');

function diskFree(p) {
  try {
    const st = fs.statfsSync(p);
    return { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
  } catch {
    return null;
  }
}

function system() {
  const roots = allowedRoots().map((root) => ({
    path: root,
    exists: fs.existsSync(root),
    writable: (() => {
      try {
        fs.accessSync(root, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    })(),
    disk: diskFree(root),
  }));

  const mem = {
    total: os.totalmem(),
    free: os.freemem(),
  };

  return {
    app: {
      name: 'NAS助手',
      appname: 'shuaishuai.nas',
      version: PKG.version,
      description: '面向飞牛 fnOS 玩家的一体化本地 Web 工具箱',
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptime: Math.floor(process.uptime()),
      now: new Date().toISOString(),
    },
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      cpus: os.cpus().length,
      loadavg: os.loadavg(),
      mem,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    roots,
    dataDir: DATA_DIR,
    authEnabled: auth.enabled(),
    unrestricted: isUnrestricted(),
    capabilities: {
      smartctl: findBin('smartctl'),
      ping: findBin(process.platform === 'win32' ? 'ping' : 'ping'),
      df: findBin('df'),
      docker: findBin('docker'),
      smart: process.platform === 'linux' && Boolean(findBin('smartctl')),
    },
    disclaimers: [
      '本工具只生成配置与脚本，不内置、不下载、不分发任何影视资源或音源。',
      '所有文件操作都在你授权的目录内进行，且默认只读扫描。',
      '请遵守当地版权法规，仅管理你自己合法拥有的媒体文件。',
    ],
  };
}

function health() {
  return { ok: true, uptime: Math.floor(process.uptime()), version: PKG.version };
}

/**
 * 重启应用：授权目录变化后需要重新读取环境变量。
 * 只支持 fnOS 原生安装（有 cmd/main），Docker 部署请重启容器。
 */
function restart() {
  const script = path.resolve(__dirname, '..', '..', '..', 'cmd', 'main');
  if (!fs.existsSync(script)) {
    throw new HttpError(501, '仅 fnOS 原生安装支持自动重启，Docker 部署请在宿主机重启容器');
  }

  // 先返回响应，再由后台脚本停止并拉起，避免请求被自己中断
  const child = spawn(
    '/bin/bash',
    ['-c', `sleep 1; "${script}" stop >/dev/null 2>&1; sleep 1; "${script}" start >/dev/null 2>&1`],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();
  return { restarting: true };
}

/**
 * 手动补加一个扫描根目录。
 * fnOS 的 TRIM_DATA_ACCESSIBLE_PATHS 偶尔不会传到应用进程，这时让用户
 * 把文件管理里的真实路径填进来；OS 层 ACL 仍然决定应用能不能读。
 */
function addRootRoute(ctx) {
  const input = str(ctx.body.path, '路径', { max: 1024 });
  if (!path.isAbsolute(input)) {
    throw new HttpError(400, '请填写绝对路径，例如 /vol2/.../影音库');
  }

  let real;
  try {
    real = fs.realpathSync(input);
  } catch {
    throw new HttpError(400, '路径不存在，请从文件管理地址栏复制完整路径');
  }

  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new HttpError(400, '无法读取该路径');
  }
  if (!stat.isDirectory()) throw new HttpError(400, '请选择文件夹，而不是文件');

  try {
    fs.accessSync(real, fs.constants.R_OK);
  } catch {
    throw new HttpError(403, '应用用户无权读取该目录，请先在应用设置里完成授权');
  }

  addRoot(real);
  return { added: real, roots: allowedRoots() };
}

/* ------------------------------------------------------------------ */
/* 目录浏览器：只读列出可读取的子目录，帮助用户「点选」而不是手打路径     */
/* ------------------------------------------------------------------ */

const BROWSE_VOLUMES = [
  '/vol1', '/vol2', '/vol3', '/vol4', '/vol5', '/vol6', '/vol7', '/vol8', '/vol9',
  '/home', '/mnt', '/media', '/data',
];

/** 列出真实存在的顶层卷 / 常用挂载点，作为浏览起点。 */
function volumeRoots() {
  const out = [];
  const seen = new Set();
  for (const p of BROWSE_VOLUMES) {
    let real;
    try {
      const st = fs.statSync(p);
      if (!st.isDirectory()) continue;
      real = fs.realpathSync(p);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push({ name: path.basename(real) || real, path: real });
  }
  return out;
}

function normalizeBrowsePath(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  const value = raw.trim();
  if (value.length > 4096 || value.includes('\0') || value.includes('..')) {
    throw badRequest('路径不合法');
  }
  if (!path.isAbsolute(value)) throw badRequest('请输入绝对路径');
  return value;
}

function browse(ctx) {
  const raw = ctx.query && ctx.query.get ? ctx.query.get('path') : '';
  const input = normalizeBrowsePath(raw);

  // 未指定路径：返回可用的卷作为起点
  if (!input) {
    return { path: '', parent: null, roots: volumeRoots(), volumes: true };
  }

  let real;
  try {
    real = fs.realpathSync(input);
  } catch {
    throw notFound('目录不存在：' + input);
  }
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    throw badRequest('无法读取该目录');
  }
  if (!stat.isDirectory()) throw badRequest('该路径不是文件夹');

  try {
    fs.accessSync(real, fs.constants.R_OK);
  } catch {
    throw new HttpError(403, '应用用户没有该目录的读取权限，请先在「应用设置 → 可访问的文件」授权父目录');
  }

  let entries = [];
  try {
    entries = fs.readdirSync(real, { withFileTypes: true });
  } catch {
    throw new HttpError(403, '应用用户没有该目录的读取权限，请先在「应用设置 → 可访问的文件」授权父目录');
  }

  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name.startsWith('@')) continue;
    dirs.push({ name: entry.name, path: path.join(real, entry.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  const parent = path.dirname(real);
  return {
    path: real,
    parent: parent === real ? null : parent,
    dirs: dirs.slice(0, 500),
    total: dirs.length,
  };
}

/* ------------------------------------------------------------------ */
/* 访问模式设置：全盘访问（不逐目录授权）                                 */
/* ------------------------------------------------------------------ */

function settingsGet() {
  return { unrestricted: isUnrestricted(), roots: allowedRoots() };
}

function settingsSet(ctx) {
  const value = bool(ctx.body && ctx.body.unrestricted, false);
  setUnrestricted(value);
  return {
    unrestricted: isUnrestricted(),
    roots: allowedRoots(),
    hint: value
      ? '已开启全盘访问：应用不再限制路径，但仍受 fnOS 系统读权限约束。'
      : '已关闭全盘访问：恢复为只访问授权目录。',
  };
}

/* ------------------------------------------------------------------ */
/* 授权目录列表与移除（供「设置」页使用）                                 */
/* ------------------------------------------------------------------ */

/** 当前完整授权目录 + 应用侧手动追加的目录，便于前端区分可移除项。 */
function rootsGet() {
  return {
    roots: allowedRoots(),
    saved: savedRoots(),
    unrestricted: isUnrestricted(),
    dataDir: DATA_DIR,
  };
}

function rootRemove(ctx) {
  const input = str(ctx.body && ctx.body.path, '路径', { max: 1024 });
  let real;
  try {
    real = fs.realpathSync(input);
  } catch {
    throw badRequest('路径不存在，无法移除');
  }
  const before = allowedRoots();
  removeRoot(real);
  const after = allowedRoots();
  return {
    roots: after,
    saved: savedRoots(),
    removed: before.includes(real) && !after.includes(real),
  };
}

module.exports = [
  ['GET', '/api/system', system],
  ['GET', '/api/health', health],
  ['POST', '/api/system/restart', restart],
  ['GET', '/api/roots', rootsGet],
  ['POST', '/api/roots', addRootRoute],
  ['DELETE', '/api/roots', rootRemove],
  ['POST', '/api/roots/remove', rootRemove],
  ['GET', '/api/roots/browse', browse],
  ['GET', '/api/settings', settingsGet],
  ['POST', '/api/settings', settingsSet],
];
