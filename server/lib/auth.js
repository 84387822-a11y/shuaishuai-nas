'use strict';

/**
 * 可选访问密码。
 * - 未设置 SS_PASSWORD 时完全放行（适合完全可信的家庭内网，界面上会明确提示）。
 * - 设置后：/api/* 需要签名 Cookie，登录接口有失败节流。
 * - SS_SECRET 用于给 Cookie 签名；容器内未设置则每次启动随机生成（重启后需重新登录）。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');

const AUTH_FILE = process.env.SS_AUTH_FILE || '';
const SECRET = process.env.SS_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'ss_auth';
const TOKEN = crypto.createHmac('sha256', SECRET).update('shuaishuai-nas:v1').digest('hex');

// 密码文件热加载：配置向导改密码后不需要重启应用
let cachedPassword = { mtime: -1, value: process.env.SS_PASSWORD || '' };

function currentPassword() {
  if (!AUTH_FILE) return process.env.SS_PASSWORD || '';
  try {
    const st = fs.statSync(AUTH_FILE);
    if (st.mtimeMs !== cachedPassword.mtime) {
      const text = fs.readFileSync(AUTH_FILE, 'utf8');
      const hit = /^SS_PASSWORD='([\s\S]*)'\s*$/m.exec(text);
      cachedPassword = {
        mtime: st.mtimeMs,
        value: hit ? hit[1].replace(/'\\''/g, "'") : '',
      };
    }
  } catch {
    cachedPassword = { mtime: -1, value: '' };
  }
  return cachedPassword.value;
}

const attempts = new Map(); // ip -> { fails, until }
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;

function enabled() {
  return currentPassword().length > 0;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isLocked(ip) {
  const rec = attempts.get(ip);
  if (!rec) return 0;
  const left = rec.until - Date.now();
  return left > 0 ? left : 0;
}

function noteFailure(ip) {
  const rec = attempts.get(ip) || { fails: 0, until: 0 };
  rec.fails += 1;
  if (rec.fails >= MAX_FAILS) {
    rec.until = Date.now() + LOCK_MS;
    rec.fails = 0;
  }
  attempts.set(ip, rec);
}

function isAuthed(req) {
  if (!enabled()) return true;
  const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
  return Boolean(cookie) && safeEqual(cookie, TOKEN);
}

function checkPassword(password) {
  const current = currentPassword();
  return current.length > 0 && safeEqual(password, current);
}

function login(req, res, password) {
  const ip = req.socket.remoteAddress || 'unknown';
  const locked = isLocked(ip);
  if (locked > 0) {
    return { ok: false, status: 429, message: `尝试过于频繁，请 ${Math.ceil(locked / 1000)} 秒后再试` };
  }
  if (!checkPassword(password)) {
    noteFailure(ip);
    return { ok: false, status: 401, message: '密码不正确' };
  }
  attempts.delete(ip);
  const maxAge = 7 * 24 * 3600;
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  );
  return { ok: true, status: 200, message: '登录成功' };
}

function logout(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

module.exports = { enabled, isAuthed, login, logout, parseCookies };
