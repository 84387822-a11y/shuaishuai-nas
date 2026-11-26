#!/usr/bin/env node
'use strict';

/**
 * NAS助手 —— 单文件 HTTP 服务入口（零第三方依赖）。
 *
 * 设计目标：
 * - 一个 node 进程即可跑，天然适配 fnOS 的 nodejs_v22 运行时与 Docker。
 * - 所有能力都是「本地只读扫描 + 模板生成」，不内置任何资源、音源或索引。
 * - 默认仅对局域网开放；设置 SS_PASSWORD 后所有接口需要登录。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { HttpError, allowedRoots, DATA_DIR, ROOTS } = require('./lib/util');
const auth = require('./lib/auth');
const logger = require('./lib/logger');
const routes = require('./routes');

const PKG = require('../package.json');
const PORT = Number(process.env.SS_PORT || 8620);
const HOST = process.env.SS_HOST || '0.0.0.0';
const WEB_DIR = path.join(__dirname, '..', 'web');
const MAX_BODY = 4 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/* ------------------------------------------------------------------ */
/* 响应工具                                                            */
/* ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function sendDownload(res, { filename, content, mime = 'text/plain; charset=utf-8' }) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const asciiName = String(filename || 'download.txt').replace(/[^\x20-\x7e]/g, '_');
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': body.length,
    'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, '请求体过大（上限 4MB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      const type = String(req.headers['content-type'] || '');
      try {
        if (type.includes('application/x-www-form-urlencoded')) {
          const out = {};
          for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
          return resolve(out);
        }
        const parsed = JSON.parse(raw);
        return resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        return reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, pathname) {
  let rel;
  if (pathname === '/') rel = 'index.html';
  else if (pathname === '/login') rel = 'login.html';
  else rel = pathname.replace(/^\/+/, '');
  const full = path.resolve(WEB_DIR, rel);

  if (!full.startsWith(path.resolve(WEB_DIR) + path.sep)) {
    return sendText(res, 403, '403 Forbidden');
  }
  if (pathname === '/' && !auth.isAuthed(req)) {
    res.writeHead(302, { Location: '/login' });
    return res.end();
  }
  if (pathname === '/login' && auth.isAuthed(req)) {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      if (pathname !== '/' && !path.extname(pathname)) {
        // 前端使用 hash 路由，未匹配到的无扩展名路径退回首页
        return serveStatic(req, res, '/');
      }
      return sendText(res, 404, '404 Not Found');
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': rel === 'index.html' ? 'no-store' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* API 分发                                                            */
/* ------------------------------------------------------------------ */

function matchRoute(method, pathname) {
  const m = method === 'HEAD' ? 'GET' : method;
  return routes.find((r) => r.method === m && r.path === pathname) || null;
}

async function handleApi(req, res, pathname, query) {
  // 登录相关接口不要求已登录
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    const result = auth.login(req, res, String(body.password || ''));
    if (!result.ok) {
      // 统一 400ms 延迟，降低暴力破解速度
      await new Promise((r) => setTimeout(r, 400));
    }
    return sendJson(res, result.status, { ok: result.ok, error: result.ok ? undefined : result.message });
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    auth.logout(res);
    return sendJson(res, 200, { ok: true });
  }
  // 健康检查给容器探针使用，不泄露任何业务信息
  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, uptime: Math.floor(process.uptime()), version: PKG.version });
  }

  if (!auth.isAuthed(req)) {
    return sendJson(res, 401, { ok: false, error: '需要登录', needLogin: true });
  }

  if (pathname === '/api/session' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      data: { authEnabled: auth.enabled(), version: PKG.version },
    });
  }

  const route = matchRoute(req.method, pathname);
  if (!route) return sendJson(res, 404, { ok: false, error: '接口不存在' });

  let body = {};
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    body = await readBody(req);
  }

  const ctx = {
    body,
    query,
    req,
    res,
    ip: clientIp(req),
    userAgent: req.headers['user-agent'] || '',
  };

  const data = await route.handler(ctx);

  // 处理器直接写了响应（音频流、下载等）
  if (res.writableEnded || res.headersSent) return;

  if (data && typeof data === 'object' && data.__download) {
    return sendDownload(res, data.__download);
  }
  return sendJson(res, 200, { ok: true, data });
}

/* ------------------------------------------------------------------ */
/* 服务启动                                                            */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendText(res, 400, '400 Bad Request');
  }

  res.on('finish', () => {
    const ms = Date.now() - started;
    if (process.env.SS_LOG !== '0') {
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${ms}ms`);
    }
    // 只记录 API 请求，避免静态资源把日志刷屏
    if (url.pathname.startsWith('/api/')) {
      logger.write(`${req.method} ${url.pathname} ${res.statusCode} ${ms}ms`);
    }
  });

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendText(res, 400, '400 Bad Request');
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, url.searchParams).catch((err) => {
      if (res.writableEnded) return;
      if (err instanceof HttpError) {
        logger.write(`WARN ${req.method} ${pathname} ${err.status} ${err.message}`);
        return sendJson(res, err.status, { ok: false, error: err.message, detail: err.detail });
      }
      console.error('[api error]', err);
      logger.write(`ERROR ${req.method} ${pathname} 500 ${err.message}`);
      return sendJson(res, 500, { ok: false, error: '服务器内部错误', detail: err.message });
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, '405 Method Not Allowed');
  }
  serveStatic(req, res, pathname);
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[启动失败] 端口 ${PORT} 已被占用，请用 SS_PORT 指定其他端口。`);
    process.exit(1);
  }
  console.error('[启动失败]', err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const roots = allowedRoots();
  const lines = [
    '',
    '  NAS助手  v' + PKG.version,
    '  ------------------------------------------',
    `  监听地址 : http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`,
    `  授权目录 : ${roots.join('  ') || '（无）'}`,
    `  数据目录 : ${DATA_DIR}`,
    `  访问密码 : ${auth.enabled() ? '已开启' : '未设置（仅建议在内网使用）'}`,
    `  运行平台 : ${process.platform} / node ${process.version}`,
    '',
  ];
  console.log(lines.join('\n'));
  logger.write(`启动 v${PKG.version} · platform=${process.platform} · port=${PORT} · roots=${ROOTS.length}`);
  if (ROOTS.length === 0) console.warn('[警告] 没有可用的授权目录，文件类功能会全部被拒绝。');
});

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在停止服务...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
