#!/usr/bin/env node
/**
 * 全量静态检查：后端语法、前端 ESM 语法、JSON 与 manifest 结构。
 * 前端模块在浏览器里是 ES Module，而 package.json 没有 "type": "module"，
 * 所以复制成临时 .mjs 后再用 node --check 校验。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
let checked = 0;
let seq = 0;

/**
 * 用文件描述符而不是管道收集子进程输出：
 * 某些受限环境不允许 pipe，但允许普通文件。
 */
function runCheck(target) {
  const logFile = path.join(os.tmpdir(), `ss-check-${process.pid}-${seq++}.log`);
  const fd = fs.openSync(logFile, 'w');
  const res = spawnSync(process.execPath, ['--check', target], { stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  const output = fs.readFileSync(logFile, 'utf8');
  fs.unlinkSync(logFile);
  return { status: res.status, output, error: res.error };
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === 'node_modules' || item.name === 'dist') continue;
      walk(full, out);
    } else if (item.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function checkJs(file, asModule = false) {
  let target = file;
  let temp = null;
  if (asModule) {
    temp = path.join(os.tmpdir(), `ss-check-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
    fs.copyFileSync(file, temp);
    target = temp;
  }
  const res = runCheck(target);
  checked += 1;
  if (res.status !== 0) {
    const message = (res.output || (res.error && res.error.message) || '语法错误')
      .trim()
      .split('\n')
      .slice(0, 4)
      .join('\n');
    failures.push({ file: path.relative(ROOT, file), error: message });
  }
  if (temp) fs.unlinkSync(temp);
}

function checkJson(file) {
  checked += 1;
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    failures.push({ file: path.relative(ROOT, file), error: err.message });
  }
}

// 1. 后端
for (const file of walk(path.join(ROOT, 'server')).filter((f) => f.endsWith('.js'))) {
  checkJs(file);
}
for (const file of walk(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs'))) {
  checkJs(file);
}

// 2. 前端 ESM
const webFiles = walk(path.join(ROOT, 'web')).filter((f) => f.endsWith('.js'));
for (const file of webFiles) checkJs(file, true);

// 3. JSON 配置
for (const file of [
  ...walk(path.join(ROOT, 'fpk', 'config')).filter((f) => f.endsWith('.json')),
  ...walk(path.join(ROOT, 'fpk', 'wizard')).filter((f) => f.endsWith('.json')),
  path.join(ROOT, 'fpk', 'ui', 'config'),
  path.join(ROOT, 'package.json'),
  path.join(ROOT, 'fpk', '..', 'package.json'),
]) {
  if (fs.existsSync(file)) checkJson(file);
}

// 4. manifest
const manifestFile = path.join(ROOT, 'fpk', 'manifest');
if (fs.existsSync(manifestFile)) {
  checked += 1;
  const text = fs.readFileSync(manifestFile, 'utf8');
  for (const key of ['appname', 'version', 'display_name', 'source', 'service_port']) {
    if (!new RegExp(`^${key}\\s*=`, 'm').test(text)) {
      failures.push({ file: 'fpk/manifest', error: `缺少字段 ${key}` });
    }
  }
  if (!/^checksum\s*=/m.test(text)) {
    console.warn('[check] manifest 暂无 checksum（打包时自动注入）');
  }
}

// 5. 生命周期脚本存在性
for (const name of ['main', 'install_init', 'install_callback', 'uninstall_init', 'uninstall_callback', 'upgrade_init', 'upgrade_callback', 'config_init', 'config_callback']) {
  const file = path.join(ROOT, 'fpk', 'cmd', name);
  checked += 1;
  if (!fs.existsSync(file)) failures.push({ file: `fpk/cmd/${name}`, error: '缺少生命周期脚本' });
}

console.log(`\n检查完成：${checked} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.error(`\n✗ ${f.file}\n  ${f.error}`);
  process.exit(1);
}
console.log('✓ 全部通过');
