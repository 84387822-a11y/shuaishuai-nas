#!/usr/bin/env node
'use strict';

/**
 * 把向导里的访问密码安全写入 auth.env（仅应用用户可读）。
 * 由 cmd/install_callback、cmd/config_callback 调用。
 *
 * 值使用单引号包裹，并把 ' 转义成 '\''，保证 bash source 时不会被解释。
 */

const fs = require('node:fs');
const path = require('node:path');

const [, , file, password] = process.argv;

if (!file || password === undefined) {
  console.error('用法: node set-password.js <auth.env 路径> <密码>');
  process.exit(1);
}

const escaped = String(password).replace(/'/g, "'\\''");
const content = `SS_PASSWORD='${escaped}'\n`;

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, content, { mode: 0o600 });
try {
  fs.chmodSync(file, 0o600);
} catch {
  /* 某些文件系统不支持 chmod，忽略 */
}

console.log(`access password written to ${file}`);
