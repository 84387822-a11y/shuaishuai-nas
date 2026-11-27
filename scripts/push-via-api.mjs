#!/usr/bin/env node
/**
 * 通过 GitHub REST API 推送代码（绕过被阻断的 github.com:443）。
 *
 * 原理：blob → tree（base_tree 增量 + 删除项置 null）→ commit → 更新 ref。
 * 需要环境变量 GH_TOKEN（repo 权限）。
 *
 * 用法：node scripts/push-via-api.mjs [--message "release: v1.0.3"] [--branch main] [--dry]
 */

import fs from 'node:fs';
import path from 'node:path';

const OWNER = '84387822-a11y';
const REPO = 'shuaishuai-nas';
const API = 'https://api.github.com';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const MESSAGE = getArg('--message', 'chore: sync code');
const BRANCH = getArg('--branch', 'main');
const DRY = args.includes('--dry');

const TOKEN = process.env.GH_TOKEN || '';
if (!TOKEN) {
  console.error('缺少 GH_TOKEN 环境变量');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'var', 'coverage', '.idea', '.vscode']);
const IGNORE_FILES = new Set(['.DS_Store', '.env']);
const IGNORE_EXT = ['.log'];

function api(pathname, init = {}) {
  return fetch(API + pathname, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ShuaiShuaiNAS-Publisher',
      ...(init.headers || {}),
    },
  }).then(async (res) => {
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method || 'GET'} ${pathname} -> ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  });
}

function walk(dir, base = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (IGNORE_FILES.has(entry.name)) continue;
    if (IGNORE_EXT.some((ext) => entry.name.endsWith(ext))) continue;
    out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    for (;;) {
      const i = index;
      index += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

async function main() {
  const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  const headSha = ref.object.sha;
  const commit = await api(`/repos/${OWNER}/${REPO}/git/commits/${headSha}`);
  const baseTree = commit.tree.sha;
  console.log(`远端 ${BRANCH} = ${headSha.slice(0, 7)}`);

  const remoteTree = await api(`/repos/${OWNER}/${REPO}/git/trees/${baseTree}?recursive=1`);
  const remotePaths = new Set((remoteTree.tree || []).filter((n) => n.type === 'blob').map((n) => n.path));
  console.log(`远端文件 ${remotePaths.size} 个`);

  const localPaths = walk(ROOT);
  const localSet = new Set(localPaths);
  console.log(`本地文件 ${localPaths.length} 个`);

  const changed = [];
  for (const rel of localPaths) {
    const bytes = fs.readFileSync(path.join(ROOT, rel));
    if (bytes.length > 40 * 1024 * 1024) { console.log(`跳过超大文件 ${rel}`); continue; }
    changed.push({ rel, bytes, base64: bytes.toString('base64') });
  }

  const deleted = [...remotePaths].filter((p) => !localSet.has(p));
  console.log(`待上传 ${changed.length} 个，待删除 ${deleted.length} 个`);

  if (DRY) {
    console.log('（dry-run，不上传）');
    return;
  }

  const blobs = await mapLimit(changed, 5, async (item) => {
    const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: item.base64, encoding: 'base64' }),
    });
    process.stdout.write('.');
    return { path: item.rel, mode: '100644', type: 'blob', sha: blob.sha };
  });
  console.log('\nblob 上传完成');

  const treeEntries = [
    ...blobs,
    ...deleted.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null })),
  ];

  const tree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTree, tree: treeEntries }),
  });
  console.log(`新 tree = ${tree.sha.slice(0, 7)}`);

  const newCommit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message: MESSAGE, tree: tree.sha, parents: [headSha] }),
  });
  console.log(`新 commit = ${newCommit.sha.slice(0, 7)}`);

  await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });
  console.log(`已更新 ${BRANCH} → ${newCommit.sha.slice(0, 7)}`);
  console.log(`https://github.com/${OWNER}/${REPO}/commit/${newCommit.sha}`);
}

main().catch((err) => {
  console.error('失败：' + err.message);
  process.exit(1);
});
