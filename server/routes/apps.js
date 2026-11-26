'use strict';

/**
 * 应用中心：预置常用自托管应用，生成 docker-compose 并可一键部署。
 *
 * 安全边界：
 * - 只允许部署目录里预置的镜像，不接受用户传入任意 image / compose；
 * - 端口、路径都做校验，数据目录必须落在授权目录内；
 * - Docker 权限不足时降级为「生成配置 + 复制命令」，不尝试提权。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

const {
  str, int, badRequest, HttpError, run, findBin, resolveUserPath, DATA_DIR, ROOTS,
} = require('../lib/util');

const APPS_DIR = path.join(DATA_DIR, 'apps');
const CACHE_FILE = path.join(DATA_DIR, 'releases-cache.json');
const CACHE_TTL = 6 * 60 * 60 * 1000;

// 拉不到 Docker Hub 时按顺序尝试的镜像加速源（前面快、后面兜底）
const MIRRORS = [
  'docker.m.daocloud.io',
  'docker.1ms.run',
  'dockerproxy.net',
  'hub.rat.dev',
  'docker.m.daocloud.net',
];
const PULL_TIMEOUT = 45000;

/* ------------------------------------------------------------------ */
/* 应用目录                                                            */
/* ------------------------------------------------------------------ */

const CATALOG = [
  {
    id: 'navidrome',
    name: 'Navidrome',
    category: '音乐',
    icon: '🎵',
    color: '#4dabf7',
    desc: '轻量音乐服务器，兼容 Subsonic / OpenSubsonic 协议',
    repo: 'navidrome/navidrome',
    image: 'deluan/navidrome:latest',
    fallback: '0.54',
    container: 'navidrome',
    ports: [{ host: 4533, container: 4533, label: 'Web' }],
    volumes: [
      { kind: 'data', container: '/data' },
      { kind: 'media', container: '/music', ro: true, label: '音乐目录' },
    ],
    web: { port: 4533, path: '/' },
  },
  {
    id: 'lx-music',
    name: '洛雪音乐服务（lxserver）',
    category: '音乐',
    icon: '🎶',
    color: '#fb7185',
    desc: '洛雪音乐服务：音乐 API/Web 播放器服务端，含数据/日志/音乐/缓存目录，支持 Web 播放器登录保护',
    repo: '',
    image: 'ghcr.nju.edu.cn/xcq0607/lxserver:latest',
    fallback: '1.0',
    container: 'lx-music',
    ports: [{ host: 9527, container: 9527, label: 'Web' }],
    volumes: [
      { kind: 'data', container: '/server/data' },
      { kind: 'data', container: '/server/logs', sub: 'logs' },
      { kind: 'data', container: '/server/music', sub: 'music' },
      { kind: 'data', container: '/server/cache', sub: 'cache' },
    ],
    env: { TZ: 'Asia/Shanghai', NODE_ENV: 'production', PORT: '9527', BIND_IP: '0.0.0.0', LOG_PATH: '/server/logs', ENABLE_WEBPLAYER_AUTH: 'true' },
    envParams: [
      {
        key: 'ADMIN_PASSWORD',
        label: '管理密码',
        default: 'admin',
        secret: true,
        hint: '首次进入请改为强密码',
      },
      {
        key: 'WEBPLAYER_PASSWORD',
        label: 'Web 播放器密码',
        default: 'admin',
        secret: true,
        hint: '启用 Web 播放器登录保护时使用，默认 admin，建议修改',
      },
    ],
    web: { port: 9527, path: '/' },
  },
  {
    id: 'jellyfin',
    name: 'Jellyfin',
    category: '媒体',
    icon: '🎬',
    color: '#a78bfa',
    desc: '开源媒体服务器，电影、剧集、音乐统一管理',
    repo: 'jellyfin/jellyfin',
    image: 'jellyfin/jellyfin:latest',
    fallback: '10.10',
    container: 'jellyfin',
    ports: [{ host: 8096, container: 8096, label: 'Web' }],
    volumes: [
      { kind: 'data', container: '/config' },
      { kind: 'data', container: '/cache', sub: 'cache' },
      { kind: 'media', container: '/media', ro: true, label: '媒体目录' },
    ],
    env: { TZ: 'Asia/Shanghai', PUID: '1000', PGID: '1000' },
    web: { port: 8096, path: '/' },
  },
  {
    id: 'alist',
    name: 'Alist',
    category: '网盘',
    icon: '☁️',
    color: '#34d399',
    desc: '聚合多个网盘，统一 WebDAV / 直链访问',
    repo: 'AlistGo/alist',
    image: 'xhofe/alist:latest',
    fallback: '3.4',
    container: 'alist',
    ports: [{ host: 5244, container: 5244, label: 'Web' }],
    volumes: [{ kind: 'data', container: '/opt/alist/data' }],
    env: { TZ: 'Asia/Shanghai', PUID: '1000', PGID: '1000', UMASK: '022' },
    web: { port: 5244, path: '/' },
  },
  {
    id: 'vaultwarden',
    name: 'Vaultwarden',
    category: '工具',
    icon: '🔐',
    color: '#fbbf24',
    desc: '轻量 Bitwarden 服务端，自建密码库',
    repo: 'dani-garcia/vaultwarden',
    image: 'vaultwarden/server:latest',
    fallback: '1.32',
    container: 'vaultwarden',
    ports: [{ host: 8081, container: 80, label: 'Web' }],
    volumes: [{ kind: 'data', container: '/data' }],
    env: { TZ: 'Asia/Shanghai', SIGNUPS_ALLOWED: 'true' },
    web: { port: 8081, path: '/' },
  },
  {
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    category: '监控',
    icon: '📈',
    color: '#f472b6',
    desc: '自托管可用性监控，支持告警通知',
    repo: 'louislam/uptime-kuma',
    image: 'louislam/uptime-kuma:1',
    fallback: '1.23',
    container: 'uptime-kuma',
    ports: [{ host: 3001, container: 3001, label: 'Web' }],
    volumes: [{ kind: 'data', container: '/app/data' }],
    env: { TZ: 'Asia/Shanghai' },
    web: { port: 3001, path: '/' },
  },
  {
    id: 'filebrowser',
    name: 'File Browser',
    category: '工具',
    icon: '📁',
    color: '#60a5fa',
    desc: '网页文件管理器，浏览与分享 NAS 文件',
    repo: 'filebrowser/filebrowser',
    image: 'filebrowser/filebrowser:latest',
    fallback: '2.31',
    container: 'filebrowser',
    ports: [{ host: 8082, container: 80, label: 'Web' }],
    volumes: [
      { kind: 'media', container: '/srv', ro: false, label: '共享目录' },
      { kind: 'data', container: '/database' },
    ],
    env: { TZ: 'Asia/Shanghai', PUID: '1000', PGID: '1000' },
    web: { port: 8082, path: '/' },
  },
  {
    id: 'memos',
    name: 'Memos',
    category: '工具',
    icon: '📝',
    color: '#c084fc',
    desc: '轻量碎片化笔记，支持标签与搜索',
    repo: 'usememos/memos',
    image: 'neosmemo/memos:stable',
    fallback: '0.22',
    container: 'memos',
    ports: [{ host: 5230, container: 5230, label: 'Web' }],
    volumes: [{ kind: 'data', container: '/var/opt/memos' }],
    env: { TZ: 'Asia/Shanghai' },
    web: { port: 5230, path: '/' },
  },
  {
    id: 'adguardhome',
    name: 'AdGuard Home',
    category: '网络',
    icon: '🛡️',
    color: '#22d3ee',
    desc: '全网广告拦截与 DNS 服务',
    repo: 'AdguardTeam/AdGuardHome',
    image: 'adguard/adguardhome:latest',
    fallback: '0.107',
    container: 'adguardhome',
    ports: [
      { host: 53, container: 53, label: 'DNS', proto: 'tcp' },
      { host: 53, container: 53, label: 'DNS', proto: 'udp' },
      { host: 3000, container: 3000, label: 'Web' },
    ],
    volumes: [
      { kind: 'data', container: '/opt/adguardhome/work' },
      { kind: 'data', container: '/opt/adguardhome/conf', sub: 'conf' },
    ],
    env: { TZ: 'Asia/Shanghai' },
    web: { port: 3000, path: '/' },
  },
  {
    id: 'syncthing',
    name: 'Syncthing',
    category: '同步',
    icon: '🔄',
    color: '#4ade80',
    desc: '点对点文件同步，跨设备保持一致',
    repo: 'syncthing/syncthing',
    image: 'syncthing/syncthing:latest',
    fallback: '1.27',
    container: 'syncthing',
    ports: [
      { host: 8384, container: 8384, label: 'Web' },
      { host: 22000, container: 22000, label: '同步' },
    ],
    volumes: [{ kind: 'data', container: '/var/syncthing' }],
    env: { TZ: 'Asia/Shanghai' },
    web: { port: 8384, path: '/' },
  },
  {
    id: 'songloft',
    name: 'Songloft',
    category: '音乐',
    icon: '🎧',
    color: '#22d3ee',
    desc: '自托管音乐服务器，扫描本地曲库，带 Web 播放器',
    repo: 'songloft-org/songloft',
    image: 'songloft/songloft:latest',
    fallback: '2.0',
    container: 'songloft',
    ports: [{ host: 58091, container: 58091, label: 'Web' }],
    volumes: [
      { kind: 'data', container: '/app/data' },
      { kind: 'media', container: '/app/music', ro: true, label: '音乐目录' },
    ],
    env: { LISTEN_PORT: '58091', PUID: '1000', PGID: '1000' },
    envParams: [
      { key: 'ADMIN_USERNAME', label: '管理员账号', default: 'admin' },
      {
        key: 'ADMIN_PASSWORD',
        label: '管理员密码',
        default: '',
        secret: true,
        hint: '留空会自动生成随机密码，部署后请保存',
      },
    ],
    web: { port: 58091, path: '/' },
  },
  {
    id: 'pansou',
    name: 'PanSou 盘搜',
    category: '搜索',
    icon: '🔍',
    color: '#34d399',
    desc: '网盘/磁力资源聚合搜索，Web 模式一键部署开箱即用',
    repo: 'fish2018/pansou',
    image: 'ghcr.io/fish2018/pansou-web:latest',
    fallback: '1.0',
    container: 'pansou',
    ports: [
      { host: 80, container: 80, label: 'Web' },
      { host: 8888, container: 8888, label: '后端/API' },
    ],
    volumes: [{ kind: 'data', container: '/app/data' }],
    env: { DOMAIN: 'localhost', PANSOU_PORT: '8888', PANSOU_HOST: '127.0.0.1', CACHE_ENABLED: 'true' },
    envParams: [
      { key: 'ENABLED_PLUGINS', label: '启用插件（逗号分隔）', default: 'dyyjpro,duoduo,hunhepan,pansearch,pikpak' },
      { key: 'CHANNELS', label: 'TG 频道（逗号分隔）', default: '', hint: '留空使用默认频道' },
      { key: 'PROXY', label: '代理（可选）', default: '', hint: '如 socks5://192.168.1.10:1080' },
    ],
    web: { port: 80, path: '/' },
  },
  {
    id: 'omnibox',
    name: 'Omnibox 全能搜索',
    category: '搜索',
    icon: '🔎',
    color: '#a78bfa',
    desc: '影视/音乐/网盘/直播一站式聚合搜索平台，支持爬源订阅',
    repo: 'Silent1566/OmniBox-Spider',
    image: 'lampon/omnibox:latest',
    fallback: '2.0',
    container: 'omnibox',
    ports: [{ host: 7023, container: 7023, label: 'Web' }],
    volumes: [{ kind: 'data', container: '/app/data' }],
    env: { TZ: 'Asia/Shanghai', DATABASE_TYPE: 'sqlite' },
    web: { port: 7023, path: '/' },
  },
  {
    id: 'libretv',
    name: 'LibreTV',
    category: '直播',
    icon: '📺',
    color: '#f472b6',
    desc: '免费影视聚合 + IPTV 直播（M3U/EPG），无状态一键部署',
    repo: 'LibreSpark/LibreTV',
    image: 'ghcr.io/librespark/libretv:latest',
    fallback: '1.0',
    container: 'libretv',
    ports: [{ host: 8080, container: 8080, label: 'Web' }],
    volumes: [],
    env: {},
    envParams: [
      {
        key: 'PASSWORD',
        label: '访问密码',
        default: '',
        secret: true,
        hint: '必填；留空可能无法启动（LibreTV 要求 PASSWORD 环境变量）',
      },
    ],
    web: { port: 8080, path: '/' },
  },
  {
    id: 'lemon-music',
    name: '柠檬音乐',
    category: 'FPK 应用',
    icon: '🍋',
    color: '#facc15',
    desc: '飞牛 NAS 原生音乐工具（搜索/试听/下载），在 GitHub 下载 .fpk 后到应用中心手动安装',
    githubUrl: 'https://github.com/jia070310/lemon-muisc',
    link: {
      url: 'https://github.com/jia070310/lemon-muisc/releases',
      text: '前往 GitHub 下载安装',
    },
  },
  {
    id: 'fnmedia-ext',
    name: '飞牛影视在线扩展',
    category: 'FPK 应用',
    icon: '🎬',
    color: '#2b8a3e',
    desc: '飞牛影视在线资源扩展：聚合苹果CMS资源站、多线路播放、播放记录与智能续播',
    githubUrl: 'https://github.com/yujian0815/fnmedia-ext',
    link: {
      url: 'https://github.com/yujian0815/fnmedia-ext/releases',
      text: '前往 GitHub 下载安装',
    },
  },
  {
    id: 'fnmusic-ext',
    name: '飞牛音乐扩展（在线音乐）',
    category: 'FPK 应用',
    icon: '🎵',
    color: '#e8590c',
    desc: '飞牛音乐扩展，提供在线音乐搜索与播放能力',
    githubUrl: 'https://github.com/javycoder/fnos_music_ext',
    link: {
      url: 'https://github.com/javycoder/fnos_music_ext/releases',
      text: '前往 GitHub 下载安装',
    },
  },
  {
    id: 'mediary-scout',
    name: '巡影 Mediary Scout',
    category: 'FPK 应用',
    icon: '🎬',
    color: '#7c3aed',
    desc: '开源 AI 影视自动追更与多网盘（夸克/UC/115/123 等）媒体库整理工具（注意：发布的是桌面 .dmg/.exe，不是 fnOS 的 .fpk）',
    githubUrl: 'https://github.com/fancydirty/mediary-scout',
    pkg: '桌面安装包（.dmg/.exe）',
    link: {
      url: 'https://github.com/fancydirty/mediary-scout/releases',
      text: '前往 GitHub 下载安装',
    },
  },
  {
    id: 'ysp-live',
    name: '央视频全频道直播（YSP Live）',
    category: '直播',
    icon: '📺',
    color: '#E60012',
    desc: '央视频（CCTV）全网全频道直播源代理，输出 M3U 直播列表，可导入 APTV / nanoTV / IPTV 等播放器，支持 4K',
    image: 'wuenci514/ysp-live:latest',
    repo: 'wuenci666/ysp-live-docker',
    fallback: 'v20261124-G',
    container: 'ysp-live',
    ports: [{ host: 8767, container: 8767, label: 'Web' }],
    volumes: [{ kind: 'data', container: '/app/data' }],
    env: { TZ: 'Asia/Shanghai' },
    web: { port: 8767, path: '/' },
  },
  {
    id: 'tailscale',
    name: 'Tailscale',
    category: '网络',
    icon: '🔗',
    color: '#8b9dff',
    desc: '基于 WireGuard 的组网工具，远程访问不用公网 IP',
    repo: 'tailscale/tailscale',
    image: 'tailscale/tailscale:latest',
    fallback: '1.8',
    container: 'tailscale',
    ports: [],
    networkMode: 'host',
    capAdd: ['NET_ADMIN'],
    devices: ['/dev/net/tun:/dev/net/tun'],
    volumes: [{ kind: 'data', container: '/var/lib/tailscale' }],
    env: { TS_STATE_DIR: '/var/lib/tailscale', TS_USERSPACE: 'false', TS_AUTO_UPDATE: 'true' },
    envParams: [
      {
        key: 'TS_AUTHKEY',
        label: 'Tailscale 授权密钥',
        default: '',
        secret: true,
        hint: '在 Tailscale 后台 Auth keys 生成，tskey-auth- 开头；留空需进容器手动登录',
      },
      { key: 'TS_HOSTNAME', label: '设备名称', default: 'nas-helper' },
    ],
    web: null,
    consoleUrl: 'https://login.tailscale.com/admin/machines',
  },
];

const BY_ID = new Map(CATALOG.map((a) => [a.id, a]));

/* ------------------------------------------------------------------ */
/* 版本缓存                                                            */
/* ------------------------------------------------------------------ */

let releaseCache = {};
try {
  releaseCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
} catch {
  releaseCache = {};
}

async function saveCache() {
  try {
    await fsp.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fsp.writeFile(CACHE_FILE, JSON.stringify(releaseCache, null, 2), 'utf8');
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

async function fetchRelease(repo) {
  const cached = releaseCache[repo];
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const headers = {
      'User-Agent': 'NAS-Helper',
      Accept: 'application/vnd.github+json',
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const json = await res.json();
    const info = {
      version: String(json.tag_name || '').replace(/^v/i, ''),
      url: json.html_url || '',
      at: Date.now(),
    };
    releaseCache[repo] = info;
    return info;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Docker                                                              */
/* ------------------------------------------------------------------ */

async function dockerState() {
  const bin = findBin('docker');
  const state = { available: false, bin, version: null, error: null };
  if (!bin) {
    state.error = '未找到 docker 命令';
    return state;
  }
  const result = await run(bin, ['info', '--format', '{{.ServerVersion}}'], { timeout: 4000 });
  if (result.code === 0) {
    state.available = true;
    state.version = result.stdout.trim();
  } else {
    state.error = (result.stderr || '无法连接 Docker 守护进程').trim().split('\n')[0];
  }
  return state;
}

async function containers(bin) {
  if (!bin) return [];
  const result = await run(bin, ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}'], { timeout: 5000 });
  if (result.code !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, status, ports] = line.split('\t');
      return { name, status: status || '', ports: ports || '', running: /up/i.test(status || '') };
    });
}

/* ------------------------------------------------------------------ */
/* compose 生成                                                        */
/* ------------------------------------------------------------------ */

function yamlValue(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+-]+$/.test(text) && !/^[0-9]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function hostPathFor(app, volume, dataRoot, mediaDir) {
  // 固定卷：直接原样输出（如 /:/hostfs:ro、/var/run/docker.sock），用于高权限监控类应用。
  // 只允许白名单内的安全绝对路径，避免任意挂载。
  if (volume.kind === 'fixed') {
    const allowed = new Set(['/:', '/var/run/docker.sock', '/etc/localtime']);
    const src = String(volume.host || '').replace(/\/+$/, '') || ':';
    const base = src.split(':')[0];
    if (!allowed.has(base)) throw badRequest(`不允许挂载 ${base}`);
    return `${src}${volume.ro ? ':ro' : ''}:${volume.container}`;
  }
  if (volume.kind === 'media') {
    if (!mediaDir) throw badRequest(`${app.name} 需要选择一个${volume.label || '数据目录'}`);
    return mediaDir;
  }
  const sub = volume.sub || '';
  return path.posix.join(dataRoot, app.id, sub);
}

function buildCompose(app, { dataRoot, mediaDir, port, extraEnv }) {
  const lines = [
    '# 由 NAS助手 生成',
    'services:',
    `  ${app.id}:`,
    `    image: ${app.image}`,
    `    container_name: ${app.container}`,
    '    restart: unless-stopped',
  ];

  if (app.privileged) lines.push('    privileged: true');

  if (app.networkMode) lines.push(`    network_mode: ${app.networkMode}`);

  if (app.capAdd && app.capAdd.length) {
    lines.push('    cap_add:');
    for (const cap of app.capAdd) lines.push(`      - ${cap}`);
  }

  if (app.devices && app.devices.length) {
    lines.push('    devices:');
    for (const device of app.devices) lines.push(`      - ${yamlValue(device)}`);
  }

  if (app.ports && app.ports.length) {
    lines.push('    ports:');
    for (const p of app.ports) {
      const host = Number(p.container) === Number(app.web && app.web.port) && port ? port : p.host;
      const proto = p.proto === 'udp' ? '/udp' : '';
      lines.push(`      - "${host}:${p.container}${proto}"`);
    }
  }

  const env = { ...(app.env || {}), ...(extraEnv || {}) };
  if (Object.keys(env).length) {
    lines.push('    environment:');
    for (const [key, value] of Object.entries(env)) {
      lines.push(`      ${key}: ${yamlValue(value)}`);
    }
  }

  if (app.volumes && app.volumes.length) {
    lines.push('    volumes:');
    for (const volume of app.volumes) {
      const host = hostPathFor(app, volume, dataRoot, mediaDir);
      const ro = volume.ro ? ':ro' : '';
      lines.push(`      - ${yamlValue(`${host}:${volume.container}${ro}`)}`);
    }
  }

  return lines.join('\n') + '\n';
}

function resolveParams(app, body) {
  const port = int(body.port, '端口', { min: 1, max: 65535, fallback: app.web ? app.web.port : 8080 });

  // 没填数据目录时，默认放到应用自己的私有目录：
  // 新手不需要先做目录授权，也能把不需要媒体库的应用装起来。
  const dataInput = body.dataDir ? str(body.dataDir, '数据目录', { max: 1024 }) : '';
  let dataRoot;
  if (dataInput) {
    dataRoot = resolveUserPath(dataInput, { mustExist: false, allowMissingLeaf: true });
  } else {
    dataRoot = path.join(DATA_DIR, 'docker');
    try {
      fs.mkdirSync(dataRoot, { recursive: true });
    } catch {
      /* Docker 守护进程也会创建 */
    }
  }

  let mediaDir = null;
  if (app.volumes.some((v) => v.kind === 'media')) {
    mediaDir = resolveUserPath(str(body.mediaDir, '媒体目录', { max: 1024 }), { mustExist: true });
  }

  // 只接受目录里声明过的参数，避免用户往 compose 里塞任意环境变量
  const extraEnv = {};
  if (app.envParams && body.extraEnv && typeof body.extraEnv === 'object') {
    for (const param of app.envParams) {
      const raw = body.extraEnv[param.key];
      if (raw === undefined || raw === null) continue;
      const value = String(raw);
      if (value.length > 512 || /[\r\n]/.test(value)) {
        throw badRequest(`${param.label} 不合法`);
      }
      if (value) extraEnv[param.key] = value;
    }
  }

  return { port, dataRoot, mediaDir, extraEnv };
}

/* ------------------------------------------------------------------ */
/* 镜像源兜底                                                        */
/* ------------------------------------------------------------------ */

/**
 * 先试官方源拉镜像；失败就依次换国内加速源。
 * 返回最终可用于 compose 的 image 引用（官方源不行时替换成加速源前缀）。
 */
async function resolveImage(bin, app) {
  const base = app.image;
  const attempts = [
    { ref: base, host: '官方', mirror: null },
    ...MIRRORS.map((m) => ({ ref: m + '/' + base, host: m, mirror: m })),
  ];
  const log = [];

  for (const attempt of attempts) {
    const res = await run(bin, ['pull', attempt.ref], { timeout: PULL_TIMEOUT });
    const ok = res.code === 0;
    const detail = (res.stderr || res.stdout || '').trim().split('\n').slice(-2).join(' ').slice(0, 160);
    log.push(`${ok ? '✓' : '✗'} ${attempt.host}: ${ok ? '成功' : detail}, ${res.code}`);
    if (ok) {
      return {
        image: attempt.ref,
        host: attempt.host,
        mirror: attempt.mirror,
        attempts: log,
      };
    }
  }

  return {
    image: base,
    host: '无法拉取',
    mirror: null,
    attempts: log,
  };
}

async function catalog() {
  const docker = await dockerState();
  const list = await containers(docker.bin);

  return {
    docker: { available: docker.available, version: docker.version, error: docker.error },
    categories: [...new Set(CATALOG.map((a) => a.category))],
    apps: CATALOG.map((app) => {
      // FPK 应用：只提供 GitHub 跳转卡片，不涉及 Docker 部署
      if (app.link) {
        return {
          id: app.id,
          name: app.name,
          category: app.category,
          icon: app.icon,
          color: app.color,
          desc: app.desc,
          repo: '',
          link: true,
          linkUrl: app.link.url,
          linkText: app.link.text || '前往 GitHub 下载安装',
          githubUrl: app.githubUrl || '',
          pkg: app.pkg || 'FPK',
          ports: [],
          web: null,
          envParams: [],
          needsMedia: false,
          installed: false,
          running: false,
          status: 'GitHub 安装',
        };
      }
      const hit = list.find((c) => c.name === app.container);
      const release = releaseCache[app.repo] || null;
      return {
        id: app.id,
        name: app.name,
        category: app.category,
        icon: app.icon,
        color: app.color,
        desc: app.desc,
        repo: app.repo,
        image: app.image,
        fallbackVersion: app.fallback,
        version: release ? release.version : null,
        releaseUrl: release ? release.url : `https://github.com/${app.repo}/releases`,
        ports: app.ports.map((p) => p.host),
        web: app.web || null,
        consoleUrl: app.consoleUrl || null,
        envParams: (app.envParams || []).map((p) => ({
          key: p.key,
          label: p.label,
          default: p.default,
          secret: Boolean(p.secret),
          hint: p.hint || '',
        })),
        needsMedia: app.volumes.some((v) => v.kind === 'media'),
        mediaLabel: (app.volumes.find((v) => v.kind === 'media') || {}).label || '数据目录',
        installed: Boolean(hit),
        running: Boolean(hit && hit.running),
        status: hit ? hit.status : '未部署',
      };
    }),
  };
}

async function releases(ctx) {
  const ids = Array.isArray(ctx.body.ids) && ctx.body.ids.length
    ? ctx.body.ids.filter((id) => BY_ID.has(id))
    : CATALOG.map((a) => a.id);

  const result = {};
  const queue = [...ids];
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const id = queue.shift();
      const app = BY_ID.get(id);
      try {
        const info = await fetchRelease(app.repo);
        result[id] = { version: info.version, url: info.url };
      } catch {
        result[id] = null;
      }
    }
  });
  await Promise.all(workers);
  await saveCache();
  return { versions: result };
}

async function compose(ctx) {
  const id = str(ctx.body.id, '应用', { max: 64 });
  const app = BY_ID.get(id);
  if (!app) throw badRequest('应用不存在');

  const params = resolveParams(app, ctx.body);
  const text = buildCompose(app, params);

  return {
    id,
    name: app.name,
    image: app.image,
    compose: text,
    port: params.port,
    dataDir: path.posix.join(params.dataRoot, app.id),
    mediaDir: params.mediaDir,
    notes: [
      '确认端口没有被占用；冲突时改端口重新生成。',
      '数据目录会由 Docker 自动创建，请确保上级目录存在且有写入权限。',
      '镜像来自官方仓库，升级时重新拉取镜像即可，数据卷不受影响。',
    ],
  };
}

async function deploy(ctx) {
  const id = str(ctx.body.id, '应用', { max: 64 });
  const app = BY_ID.get(id);
  if (!app) throw badRequest('应用不存在');

  const docker = await dockerState();
  if (!docker.available) {
    throw new HttpError(
      503,
      '当前无法操作 Docker：' + (docker.error || '未安装或未授权'),
      '可先生成 compose 复制到终端执行；若要让应用直接部署，需要把应用用户加入 docker 组，或改用 Docker 部署本工具。'
    );
  }

  const params = resolveParams(app, ctx.body);

  // 先自动拉取镜像（官方源失败就逐个换加速源），用拉取成功的那份作为 compose 的 image，
  // 避免 compose up 时回头再拉官方源而超时。
  const resolved = await resolveImage(docker.bin, app);
  const text = buildCompose({ ...app, image: resolved.image }, params);

  const dir = path.join(APPS_DIR, app.id);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'docker-compose.yml');
  await fsp.writeFile(file, text, 'utf8');

  const result = await run(docker.bin, ['compose', '-f', file, 'up', '-d'], { timeout: 120000 });
  const output = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-20).join('\n');

  if (result.code !== 0) {
    throw new HttpError(
      500,
      '部署失败',
      output + '\n\n[镜像拉取记录]\n' + resolved.attempts.join('\n') + '\n\n[最终镜像] ' + resolved.image + '（' + resolved.host + '）'
    );
  }

  return {
    id,
    composeFile: file,
    output,
    url: app.web
      ? `http://${ctx.req.headers.host ? String(ctx.req.headers.host).split(':')[0] : 'NAS-IP'}:${params.port}${(app.web && app.web.path) || '/'}`
      : null,
    consoleUrl: app.consoleUrl || null,
    imageUsed: resolved.image,
    imageHost: resolved.host,
    hint: '容器已启动，首次访问可能需要初始化配置。',
  };
}

async function action(ctx) {
  const id = str(ctx.body.id, '应用', { max: 64 });
  const app = BY_ID.get(id);
  if (!app) throw badRequest('应用不存在');
  const op = str(ctx.body.action, '操作', { max: 16 });
  if (!['start', 'stop', 'restart'].includes(op)) throw badRequest('不支持的操作');

  const docker = await dockerState();
  if (!docker.available) throw new HttpError(503, '当前无法操作 Docker：' + (docker.error || '未安装或未授权'));

  const result = await run(docker.bin, [op, app.container], { timeout: 30000 });
  if (result.code !== 0) {
    throw new HttpError(500, '操作失败', (result.stderr || result.stdout || '').trim().split('\n')[0]);
  }
  return { id, action: op, output: (result.stdout || '').trim() };
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}

/** 给小白用的端口建议：端口被占用时自动往后找，不让用户自己判断。 */
async function suggestPort(ctx) {
  let port = int(ctx.body.port, '端口', { min: 1, max: 65535, fallback: 8080 });
  for (let i = 0; i < 30 && port <= 65535; i += 1, port += 1) {
    if (await portFree(port)) return { port, original: Number(ctx.body.port) || null };
  }
  throw badRequest('附近没有找到空闲端口，请手动指定');
}

module.exports = [
  ['GET', '/api/apps/catalog', catalog],
  ['POST', '/api/apps/releases', releases],
  ['POST', '/api/apps/compose', compose],
  ['POST', '/api/apps/deploy', deploy],
  ['POST', '/api/apps/action', action],
  ['POST', '/api/apps/suggest-port', suggestPort],
];
