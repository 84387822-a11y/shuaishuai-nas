#!/usr/bin/env node
/**
 * 零依赖 .fpk 打包器。
 *
 * fpk 本质是一个 tar.gz，内部结构：
 *   manifest      key=value 清单（含 app.tgz 的 md5）
 *   app.tgz       应用可执行文件（解压到 TRIM_APPDEST）
 *   cmd/          生命周期脚本
 *   config/       privilege / resource
 *   wizard/       安装、配置、卸载向导
 *   ui/           桌面入口配置与图标
 *   ICON.PNG / ICON_256.PNG
 *
 * 用法：
 *   node scripts/build-fpk.mjs                 # 默认 x86
 *   node scripts/build-fpk.mjs --platform arm
 *   node scripts/build-fpk.mjs --platform both # 同时产出 x86 / arm
 *   node scripts/build-fpk.mjs --version 1.0.1
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FPK_DIR = path.join(ROOT, 'fpk');
const DIST = path.join(ROOT, 'dist');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const platformArg = arg('platform', 'x86');
const versionArg = arg('version', '');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/* ------------------------------------------------------------------ */
/* 极简 tar 写入（ustar）                                              */
/* ------------------------------------------------------------------ */

function octal(value, width) {
  return Math.max(0, Math.floor(value)).toString(8).padStart(width - 1, '0') + '\0';
}

function tarHeader(name, size, mode, type, mtime) {
  const buf = Buffer.alloc(512, 0);
  let nm = name;
  let prefix = '';

  if (Buffer.byteLength(nm) > 100) {
    const parts = nm.split('/');
    prefix = parts.shift();
    nm = parts.join('/');
    while (Buffer.byteLength(prefix) > 155 && parts.length > 1) {
      prefix = prefix.split('/').slice(1).join('/');
    }
  }

  buf.write(nm, 0, 100, 'utf8');
  buf.write(octal(mode & 0o7777, 7), 100, 8, 'ascii');
  buf.write(octal(0, 7), 108, 8, 'ascii');
  buf.write(octal(0, 7), 116, 8, 'ascii');
  buf.write(octal(size, 11), 124, 12, 'ascii');
  buf.write(octal(mtime, 11), 136, 12, 'ascii');
  buf.fill(' ', 148, 156); // 校验和字段先填空格
  buf.write(type, 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  buf.write('root', 265, 32, 'ascii');
  buf.write('root', 297, 32, 'ascii');
  buf.write(octal(0, 7), 329, 8, 'ascii');
  buf.write(octal(0, 7), 337, 8, 'ascii');
  buf.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return buf;
}

function walkTar(dir, base = '') {
  const entries = [];
  const items = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const item of items) {
    const rel = base ? `${base}/${item.name}` : item.name;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      entries.push({ name: `${rel}/`, type: '5', mode: 0o755, size: 0, full });
      entries.push(...walkTar(full, rel));
    } else if (item.isFile()) {
      const isScript = item.name.startsWith('main') || rel.startsWith('cmd/') || /\.sh$/.test(item.name);
      entries.push({
        name: rel,
        type: '0',
        mode: isScript ? 0o755 : 0o644,
        size: fs.statSync(full).size,
        full,
      });
    }
  }
  return entries;
}

function tarBuffer(dir) {
  const chunks = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const entry of walkTar(dir)) {
    chunks.push(tarHeader(entry.name, entry.size, entry.mode, entry.type, mtime));
    if (entry.type === '0') {
      const data = fs.readFileSync(entry.full);
      chunks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

function tarGz(dir) {
  return zlib.gzipSync(tarBuffer(dir), { level: 9 });
}

/* ------------------------------------------------------------------ */
/* 构建                                                                */
/* ------------------------------------------------------------------ */

function copyDir(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => !p.includes(`${path.sep}.git${path.sep}`) && !p.endsWith('.log'),
  });
}

function buildAppTgz(appDir) {
  // 应用本体：server + web + package.json（无第三方依赖，不需要 node_modules）
  fs.mkdirSync(appDir, { recursive: true });
  copyDir(path.join(ROOT, 'server'), path.join(appDir, 'server'));
  copyDir(path.join(ROOT, 'web'), path.join(appDir, 'web'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(appDir, 'package.json'));
  for (const extra of ['LICENSE', 'README.md']) {
    if (fs.existsSync(path.join(ROOT, extra))) {
      fs.copyFileSync(path.join(ROOT, extra), path.join(appDir, extra));
    }
  }
  // 内置数据（应用商店种子目录等），避免首次打开时等外网
  if (fs.existsSync(path.join(ROOT, 'data'))) {
    copyDir(path.join(ROOT, 'data'), path.join(appDir, 'data'));
  }
  // 关键：入口配置必须在应用目录内（解压后为 target/ui/config）。
  // 官方文档：入口配置写在 app/ui/config；desktop_uidir 相对于应用目录解析。
  copyDir(path.join(FPK_DIR, 'ui'), path.join(appDir, 'ui'));
  return tarGz(appDir);
}

function assertFile(file) {
  if (!fs.existsSync(file)) {
    console.error(`[build-fpk] 缺少必需文件：${path.relative(ROOT, file)}`);
    process.exit(1);
  }
}

function buildOne(platform, version) {
  const stage = path.join(DIST, 'stage', platform);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  const appDir = path.join(stage, 'app');
  const appTgz = buildAppTgz(appDir);
  const checksum = crypto.createHash('md5').update(appTgz).digest('hex');

  const pkgDir = path.join(stage, 'package');
  fs.mkdirSync(pkgDir, { recursive: true });

  // 1) app.tgz
  fs.writeFileSync(path.join(pkgDir, 'app.tgz'), appTgz);

  // 2) 目录与图标
  for (const dir of ['cmd', 'config', 'wizard', 'ui']) {
    const src = path.join(FPK_DIR, dir);
    assertFile(src);
    copyDir(src, path.join(pkgDir, dir));
  }
  for (const icon of ['ICON.PNG', 'ICON_256.PNG']) {
    assertFile(path.join(FPK_DIR, icon));
    fs.copyFileSync(path.join(FPK_DIR, icon), path.join(pkgDir, icon));
  }

  // 3) manifest：注入版本、架构、校验和
  let manifest = fs.readFileSync(path.join(FPK_DIR, 'manifest'), 'utf8');
  manifest = manifest.replace(/^version\s*=.*$/m, `version         = ${version}`);
  manifest = manifest.replace(/^platform\s*=.*$/m, `platform        = ${platform}`);
  if (/^checksum\s*=.*$/m.test(manifest)) {
    manifest = manifest.replace(/^checksum\s*=.*$/m, `checksum        = ${checksum}`);
  } else {
    manifest += `checksum        = ${checksum}\n`;
  }
  fs.writeFileSync(path.join(pkgDir, 'manifest'), manifest);

  // 4) 打包
  const appname = (manifest.match(/^appname\s*=\s*(.+)$/m) || [, 'shuaishuai.nas'])[1].trim();
  const fpkName = `${appname}_${version}_${platform}.fpk`;
  const outFile = path.join(DIST, fpkName);
  fs.writeFileSync(outFile, tarGz(pkgDir));

  const size = fs.statSync(outFile).size;
  console.log(`[build-fpk] ${fpkName}  ${(size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`[build-fpk]   app.tgz md5 = ${checksum}`);
  console.log(`[build-fpk]   平台=${platform}  版本=${version}  文件数=${walkTar(pkgDir).length}`);
  return outFile;
}

function main() {
  fs.mkdirSync(DIST, { recursive: true });
  const version = versionArg || PKG.version;

  const platforms = platformArg === 'both' ? ['x86', 'arm'] : [platformArg];
  if (!platforms.every((p) => ['x86', 'arm', 'all'].includes(p))) {
    console.error('[build-fpk] platform 只能是 x86 / arm / all / both');
    process.exit(1);
  }

  const outputs = platforms.map((p) => buildOne(p, version));
  console.log('');
  for (const file of outputs) {
    console.log(`安装包：${path.relative(process.cwd(), file)}`);
  }
  console.log('安装：fnOS 应用中心 → 手动安装 → 选择 .fpk 文件');
}

main();
