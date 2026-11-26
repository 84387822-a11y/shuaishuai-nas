#!/usr/bin/env node
'use strict';

/**
 * 把 KEY=VALUE 写入 shell 可 source 的环境文件（值用单引号安全转义）。
 * 由 cmd/install_callback、cmd/config_callback 调用。
 */

const fs = require('node:fs');
const path = require('node:path');

const [, , file, key, value] = process.argv;

if (!file || !key || value === undefined) {
  console.error('用法: node write-env.js <文件> <KEY> <VALUE>');
  process.exit(1);
}
if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
  console.error('KEY 不合法');
  process.exit(1);
}

const escaped = String(value).replace(/'/g, "'\\''");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${key}='${escaped}'\n`, { mode: 0o600 });
try {
  fs.chmodSync(file, 0o600);
} catch {
  /* 某些文件系统不支持 chmod */
}
console.log(`${key} written to ${file}`);
