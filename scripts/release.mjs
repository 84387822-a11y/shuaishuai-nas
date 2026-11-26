#!/usr/bin/env node
/**
 * 一键发版：升版本号 → 更新 manifest → 打包 x86/arm → 结构校验。
 *
 * 用法：
 *   node scripts/release.mjs --bump patch --changelog "修复 STRM 前缀拼接"
 *   node scripts/release.mjs --bump minor --no-build     # 只改版本，不打包
 *   node scripts/release.mjs --dry-run                    # 只预览，不写文件
 *
 * 约定：版本号只以 package.json 为唯一来源，打包时会覆盖 manifest 里的 version。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_FILE = path.join(ROOT, 'package.json');
const MANIFEST_FILE = path.join(ROOT, 'fpk', 'manifest');

const args = process.argv.slice(2);
function arg(name, fallback = '') {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}
function flag(name) {
  return args.includes(`--${name}`);
}

const bump = arg('bump', 'patch');
const changelog = arg('changelog', '');
const dryRun = flag('dry-run');
const noBuild = flag('no-build');
const platforms = arg('platform', 'both');

if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error('--bump 只能是 patch / minor / major');
  process.exit(1);
}

function nextVersion(current, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!m) throw new Error(`当前版本号不规范：${current}`);
  let [, major, minor, patch] = m.map(Number);
  if (kind === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (kind === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

/** 子进程输出重定向到文件（受限环境不允许 pipe）。 */
function runNode(script, extraArgs) {
  const logFile = path.join(os.tmpdir(), `ss-release-${process.pid}-${Date.now()}.log`);
  const fd = fs.openSync(logFile, 'w');
  const res = spawnSync(process.execPath, [script, ...extraArgs], {
    cwd: ROOT,
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  const output = fs.readFileSync(logFile, 'utf8');
  fs.unlinkSync(logFile);
  return { status: res.status, output };
}

const pkgText = fs.readFileSync(PKG_FILE, 'utf8');
const pkg = JSON.parse(pkgText);
const current = pkg.version;
const next = nextVersion(current, bump);
const summary = (changelog || '修复与体验改进').replace(/\s+/g, ' ').trim();

console.log('发版预览');
console.log('─'.repeat(50));
console.log(`  当前版本 : ${current}`);
console.log(`  新版本   : ${next}`);
console.log(`  变更摘要 : ${summary}`);
console.log(`  打包架构 : ${platforms}`);
console.log(`  模式     : ${dryRun ? '预览（不写文件）' : '实际执行'}`);

if (dryRun) {
  console.log('─'.repeat(50));
  console.log('将修改：package.json、fpk/manifest');
  console.log(`将执行：node scripts/build-fpk.mjs --platform ${platforms}`);
  console.log('将执行：node scripts/verify-fpk.mjs <每个产物>');
  process.exit(0);
}

// 1. package.json（保持原有缩进与换行）
pkg.version = next;
fs.writeFileSync(PKG_FILE, JSON.stringify(pkg, null, 2) + '\n');

// 2. manifest：version + changelog（其余字段保持不变）
let manifest = fs.readFileSync(MANIFEST_FILE, 'utf8');
manifest = manifest.replace(/^version\s*=.*$/m, `version         = ${next}`);
if (/^changelog\s*=.*$/m.test(manifest)) {
  manifest = manifest.replace(/^changelog\s*=.*$/m, `changelog       = v${next}：${summary}`);
} else {
  manifest += `changelog       = v${next}：${summary}\n`;
}
fs.writeFileSync(MANIFEST_FILE, manifest);

console.log('─'.repeat(50));
console.log(`✓ package.json → ${next}`);
console.log('✓ fpk/manifest 已更新版本与 changelog');

if (noBuild) {
  console.log('\n已跳过打包。需要时执行：node scripts/build-fpk.mjs --platform both');
  process.exit(0);
}

// 3. 打包
const build = runNode('scripts/build-fpk.mjs', ['--platform', platforms]);
process.stdout.write(build.output);
if (build.status !== 0) {
  console.error('✗ 打包失败，请检查上面的输出');
  process.exit(1);
}

// 4. 校验每个产物
const files = fs
  .readdirSync(path.join(ROOT, 'dist'))
  .filter((f) => f.startsWith(`${pkg.name.replace(/-/g, '.')}_${next}`) || f.includes(`_${next}_`))
  .filter((f) => f.endsWith('.fpk'));

let failed = 0;
for (const file of files) {
  const res = runNode('scripts/verify-fpk.mjs', [path.join('dist', file)]);
  process.stdout.write(res.output);
  if (res.status !== 0) failed += 1;
}

console.log('─'.repeat(50));
if (failed) {
  console.error(`✗ ${failed} 个产物校验失败`);
  process.exit(1);
}
console.log(`✓ 发版完成：v${next}，产物 ${files.length} 个`);
console.log('');
console.log('下一步：');
console.log('  1. fnOS：应用中心 → 手动安装 → 选择新 .fpk（直接覆盖旧版本，数据保留）');
console.log('  2. Docker：docker compose build && docker compose up -d（/data 卷保留）');
console.log('  3. 保留旧版本 .fpk 与 data 目录，出问题可回滚');
