'use strict';

/**
 * 版本检测：对比 GitHub Releases 上的最新版本与当前版本。
 * 只读取公开信息，不上传任何数据；网络不可用或限流时返回失败原因。
 */

const path = require('node:path');
const fs = require('node:fs');

const { HttpError } = require('../lib/util');

const OWNER = '84387822-a11y';
const REPO = 'shuaishuai-nas';
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`;
const API_URLS = [
  `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`,
  `https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=1`,
];

let cache = { ts: 0, data: null };
const TTL = 10 * 60 * 1000;

function currentVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    return String(pkg.version || '');
  } catch {
    return '';
  }
}

/** 去掉前缀 v/V，只比较数字段。 */
function normalize(v) {
  return String(v || '').trim().replace(/^[vV]/, '');
}

function isNewer(latest, current) {
  const a = normalize(latest).split('.').map((n) => Number(n) || 0);
  const b = normalize(current).split('.').map((n) => Number(n) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/** 兜底 1：跟随 /releases/latest 的跳转拿 tag。 */
async function fetchViaRedirect() {
  const url = `${RELEASES_URL}/latest`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ShuaiShuaiNAS-Updater/1.0' },
    redirect: 'manual',
  });
  const location = res.headers.get('location') || '';
  const m = /\/releases\/tag\/([^/?#]+)/.exec(location) || /\/tag\/([^/?#]+)/.exec(location);
  if (!m) return null;
  const tag = decodeURIComponent(m[1]);
  return { tag, name: tag, url: `${RELEASES_URL}/tag/${m[1]}`, published_at: '', notes: '' };
}

/** 兜底 2：解析 Releases 页面里的第一个 tag 链接。 */
async function fetchViaHtml() {
  const res = await fetch(RELEASES_URL, { headers: { 'User-Agent': 'ShuaiShuaiNAS-Updater/1.0' } });
  if (!res.ok) return null;
  const html = await res.text();
  const m = /\/releases\/tag\/([^"'?#<>\s]+)/.exec(html);
  if (!m) return null;
  const tag = decodeURIComponent(m[1]);
  return { tag, name: tag, url: `${RELEASES_URL}/tag/${m[1]}`, published_at: '', notes: '' };
}

async function fetchLatest() {
  let lastErr = '';
  for (const url of API_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'ShuaiShuaiNAS-Updater/1.0', Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      const json = await res.json();
      const rel = Array.isArray(json) ? json[0] : json;
      if (!rel || !rel.tag_name) {
        lastErr = '返回数据缺少 tag_name';
        continue;
      }
      return {
        tag: rel.tag_name,
        name: rel.name || rel.tag_name,
        url: rel.html_url || RELEASES_URL,
        published_at: rel.published_at || '',
        notes: String(rel.body || '').slice(0, 800),
      };
    } catch (err) {
      lastErr = err && err.name === 'AbortError' ? '请求超时' : (err.message || '网络错误');
    } finally {
      clearTimeout(timer);
    }
  }
  // API 不可用（常见是限流 403）时，改用页面兜底
  for (const fallback of [fetchViaRedirect, fetchViaHtml]) {
    try {
      const rel = await fallback();
      if (rel) return rel;
    } catch { /* 继续下一个兜底 */ }
  }

  throw new HttpError(502, '无法获取最新版本：' + (lastErr || '未知错误'));
}

async function check(ctx) {
  const force = ctx && ctx.query && String(ctx.query.get('refresh') || '') === '1';
  const current = currentVersion();

  if (!force && cache.data && Date.now() - cache.ts < TTL) {
    return { ...cache.data, cached: true };
  }

  try {
    const latest = await fetchLatest();
    const data = {
      current,
      latest: normalize(latest.tag),
      hasUpdate: isNewer(latest.tag, current),
      release: latest,
      releases_url: RELEASES_URL,
      checked_at: new Date().toISOString(),
    };
    cache = { ts: Date.now(), data };
    return { ...data, cached: false };
  } catch (err) {
    // 网络失败也返回当前版本与链接，前端仍可跳转 Releases 页
    return {
      current,
      latest: '',
      hasUpdate: false,
      error: err.message || '无法获取最新版本',
      releases_url: RELEASES_URL,
      checked_at: new Date().toISOString(),
      cached: false,
    };
  }
}

module.exports = [
  ['GET', '/api/update/check', check],
];
