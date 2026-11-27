#!/usr/bin/env node
/**
 * 校验构建产物 .fpk：结构、manifest 校验和、app.tgz 内容、脚本可执行位。
 * 用法：node scripts/verify-fpk.mjs [dist/xxx.fpk]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const notes = [];

function fail(msg) {
  failures.push(msg);
}

/* ---------------------- 极简 tar 读取 ---------------------- */

function readTar(buffer) {
  const entries = new Map();
  let offset = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const rawName = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/s, '');
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const size = parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/s, '').trim() || '0', 8);
    const mode = parseInt(header.toString('ascii', 100, 108).replace(/\0.*$/s, '').trim() || '0', 8);
    const type = header.toString('ascii', 156, 157);

    offset += 512;
    const data = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (type === '0' || type === '') entries.set(name, { data, mode, type: 'file' });
    else if (type === '5') entries.set(name, { data: Buffer.alloc(0), mode, type: 'dir' });
  }
  return entries;
}

function findFpk() {
  const arg = process.argv[2];
  if (arg) return path.resolve(arg);
  const files = fs
    .readdirSync(path.join(ROOT, 'dist'))
    .filter((f) => f.endsWith('.fpk'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(ROOT, 'dist', f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) throw new Error('dist/ 下没有 .fpk，请先运行 node scripts/build-fpk.mjs');
  return path.join(ROOT, 'dist', files[0].f);
}

/* ---------------------- 校验 ---------------------- */

function main() {
  const file = findFpk();
  console.log(`校验文件：${path.relative(ROOT, file)}  (${(fs.statSync(file).size / 1024 / 1024).toFixed(2)} MB)\n`);

  const outer = readTar(zlib.gunzipSync(fs.readFileSync(file)));

  const required = [
    'manifest',
    'app.tgz',
    'cmd/main',
    'cmd/install_init',
    'cmd/install_callback',
    'config/privilege',
    'ui/config',
    'wizard/install',
    'ICON.PNG',
    'ICON_256.PNG',
  ];
  for (const name of required) {
    if (!outer.has(name)) fail(`缺少必需条目：${name}`);
  }

  for (const [name] of outer) {
    if (name.startsWith('/') || name.split('/').includes('..')) fail(`条目路径不安全：${name}`);
  }

  // manifest
  const manifest = outer.get('manifest');
  if (!manifest) {
    console.log('✗ 没有 manifest，终止');
    process.exit(1);
  }
  const text = manifest.data.toString('utf8');
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z_]+)\s*=\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2].trim();
  }
  for (const key of ['appname', 'version', 'display_name', 'source', 'service_port', 'platform', 'checksum']) {
    if (!fields[key]) fail(`manifest 缺少字段：${key}`);
  }
  if (fields.source !== 'thirdparty') fail(`source 应为 thirdparty，实际 ${fields.source}`);
  if (fields.platform !== 'x86' && fields.platform !== 'arm') fail(`platform 异常：${fields.platform}`);

  // app.tgz 与 checksum
  const appTgz = outer.get('app.tgz');
  if (!appTgz) {
    fail('缺少 app.tgz');
  } else {
    const md5 = crypto.createHash('md5').update(appTgz.data).digest('hex');
    if (fields.checksum !== md5) fail(`checksum 不匹配：manifest=${fields.checksum} 实际=${md5}`);
    else notes.push(`checksum 匹配 ${md5}`);

    const inner = readTar(zlib.gunzipSync(appTgz.data));
    for (const name of [
      'server/index.js',
      'server/lib/util.js',
      'server/routes/index.js',
      'web/index.html',
      'web/app.js',
      'web/styles.css',
      'web/modules/apps.js',
      'web/modules/tools.js',
      'ui/config',
      'ui/images/icon_64.png',
      'ui/images/icon_256.png',
      'package.json',
    ]) {
      if (!inner.has(name)) fail(`app.tgz 缺少：${name}`);
    }
    notes.push(`app.tgz 条目 ${inner.size} 个，解压后 ${(appTgz.data.length / 1024).toFixed(0)} KB（压缩）`);

    // 应用不应包含 node_modules / 测试产物
    for (const name of inner.keys()) {
      if (name.startsWith('node_modules/')) fail('app.tgz 不应包含 node_modules');
      if (name.includes('selftest')) fail(`app.tgz 不应包含测试文件：${name}`);
    }
  }

  // 脚本可执行位
  for (const [name, entry] of outer) {
    if (!name.startsWith('cmd/')) continue;
    if (!(entry.mode & 0o111)) fail(`生命周期脚本缺少可执行位：${name} (mode ${entry.mode.toString(8)})`);
  }

  // 图标尺寸
  for (const [name, expect] of [['ICON.PNG', 64], ['ICON_256.PNG', 256]]) {
    const entry = outer.get(name);
    if (!entry) continue;
    const width = entry.data.readUInt32BE(16);
    const height = entry.data.readUInt32BE(20);
    if (width !== expect || height !== expect) fail(`${name} 尺寸应为 ${expect}×${expect}，实际 ${width}×${height}`);
  }

  // ui/config 入口（支持两种形态：url+端口直连 / iframe+gatewaySocket 桌面网关）
  const uiConfig = outer.get('ui/config');
  if (uiConfig) {
    try {
      const cfg = JSON.parse(uiConfig.data.toString('utf8'));
      const entry = cfg['.url'] && cfg['.url'][`${fields.appname}.main`];
      if (!entry) {
        fail('ui/config 缺少主入口');
      } else if (entry.type === 'iframe' && entry.gatewaySocket) {
        // 桌面网关形态：走 unix socket，不需要也没法对 TCP 端口
        if (!entry.gatewayPrefix) fail('网关形态缺少 gatewayPrefix（如 /app/shuaishuai）');
        else notes.push(`入口 ${fields.appname}.main → 桌面网关 ${entry.gatewayPrefix} (socket ${entry.gatewaySocket})`);
      } else {
        if (String(entry.port) !== String(fields.service_port)) fail('ui/config 端口与 manifest 不一致');
        else notes.push(`入口 ${fields.appname}.main → :${entry.port}`);
      }
    } catch (err) {
      fail(`ui/config 不是合法 JSON：${err.message}`);
    }
  }

  // privilege
  const privilege = outer.get('config/privilege');
  if (privilege) {
    try {
      const cfg = JSON.parse(privilege.data.toString('utf8'));
      // 桌面网关（fnOS）需在应用 target 目录建 unix socket，app 用户可能无写权限；
      // 与牛管家一致，本应用允许以 root 运行。仅提示，不再判为失败。
      notes.push(`运行身份 ${cfg.defaults ? cfg.defaults['run-as'] : '未声明'}${cfg.defaults && cfg.defaults['run-as'] === 'root' ? '（root：桌面网关建立 socket 需要；Docker/直连仍建议非 root）' : ''}`);
    } catch (err) {
      fail(`config/privilege 不是合法 JSON：${err.message}`);
    }
  }

  console.log('检查项：');
  for (const n of notes) console.log(`  ✓ ${n}`);
  console.log('');

  if (failures.length) {
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(`\n校验失败：${failures.length} 项`);
    process.exit(1);
  }
  console.log(`✓ ${path.basename(file)} 结构校验通过（${fields.appname} ${fields.version} ${fields.platform}）`);
}

main();
