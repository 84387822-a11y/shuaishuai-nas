'use strict';

/**
 * 路由注册表。
 * 每个模块导出一个数组：[ ['GET', '/api/xxx', handler], ... ]
 * handler(ctx) 的返回值会被包成 { ok: true, data }；
 * 返回 { __download: { filename, content, mime } } 时直接下载文件。
 */

const fs = require('node:fs');
const path = require('node:path');

const routes = [];

for (const file of fs.readdirSync(__dirname).sort()) {
  if (!file.endsWith('.js') || file === 'index.js') continue;
  const mod = require(path.join(__dirname, file));
  if (!Array.isArray(mod)) {
    console.warn(`[routes] ${file} 未导出路由数组，已跳过`);
    continue;
  }
  for (const item of mod) {
    if (!Array.isArray(item) || item.length !== 3) {
      console.warn(`[routes] ${file} 存在格式不正确的路由项`);
      continue;
    }
    routes.push({ method: item[0], path: item[1], handler: item[2] });
  }
}

module.exports = routes;
