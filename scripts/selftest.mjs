#!/usr/bin/env node
/**
 * 端到端冒烟测试：启动一个临时实例，对主要接口发真实请求。
 * 不依赖任何测试框架，失败时以非 0 退出。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-fixture-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-data-'));

function touch(rel) {
  const full = path.join(fixture, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '');
}

touch('电影/流浪地球2.2023.2160p.WEB-DL.H265-GROUP.mkv');
touch('电影/The.Matrix.1999.1080p.BluRay.x264.mkv');
touch('电视剧/漫长的季节.S01E01.2160p.WEB-DL.mkv');
touch('电视剧/漫长的季节.S01E02.2160p.WEB-DL.mkv');

const results = [];
let child = null;

async function waitFor(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function call(base, method, pathname, body, headers = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, payload, headers: res.headers };
}

function check(name, fn) {
  return (async () => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || '' });
    } catch (err) {
      results.push({ name, ok: false, detail: err.message });
    }
  })();
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function start(port, extraEnv) {
  // 受限环境不允许 pipe，因此把子进程输出重定向到普通文件
  const logFile = path.join(dataDir, `server-${port}.log`);
  const fd = fs.openSync(logFile, 'a');
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      SS_PORT: String(port),
      SS_HOST: '127.0.0.1',
      SS_ROOTS: fixture,
      SS_DATA_DIR: dataDir,
      SS_LOG: '0',
      ...extraEnv,
    },
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  proc.getLogs = () => {
    try {
      return fs.readFileSync(logFile, 'utf8');
    } catch {
      return '';
    }
  };
  return proc;
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  child = start(port, {});

  if (!(await waitFor(base + '/api/health'))) {
    console.error('服务启动失败：\n' + child.getLogs());
    process.exit(1);
  }

  await check('POST /api/roots (手动补加目录)', async () => {
    const extra = path.join(fixture, 'extra-media');
    fs.mkdirSync(extra, { recursive: true });
    fs.writeFileSync(path.join(extra, 'keep.txt'), 'x');
    const r = await call(base, 'POST', '/api/roots', { path: extra });
    assert(r.payload.ok, r.payload.error || '失败');
    assert(r.payload.data.roots.some((p) => p.endsWith('extra-media')), '目录未加入');
    return '已加入 ' + r.payload.data.added;
  });

  await check('GET /api/system', async () => {
    const r = await call(base, 'GET', '/api/system');
    assert(r.status === 200 && r.payload.ok, '响应异常');
    assert(r.payload.data.app.version, '缺少版本号');
    return 'v' + r.payload.data.app.version;
  });

  await check('POST /api/files/scan', async () => {
    const r = await call(base, 'POST', '/api/files/scan', { dir: path.join(fixture, '电视剧'), profile: 'auto' });
    assert(r.payload.ok, r.payload.error || '失败');
    assert(r.payload.data.items.length >= 1, '没有待整理条目');
    return `${r.payload.data.items.length} 条待改`;
  });

  await check('POST /api/files/script', async () => {
    const r = await call(base, 'POST', '/api/files/script', {
      items: [{ from: path.join(fixture, 'a.mkv'), to: path.join(fixture, 'b.mkv') }],
      format: 'bash',
    });
    assert(r.status === 200 && String(r.payload).includes('mv -n'), '脚本内容异常');
    return 'bash 脚本正常';
  });

  await check('POST /api/network/subnet', async () => {
    const r = await call(base, 'POST', '/api/network/subnet', { cidr: '192.168.1.0/24' });
    assert(r.payload.ok, r.payload.error || '失败');
    assert(r.payload.data.broadcast === '192.168.1.255', '广播地址错误');
    return '192.168.1.255';
  });

  await check('POST /api/tools/hash', async () => {
    const r = await call(base, 'POST', '/api/tools/hash', { text: 'hello' });
    assert(r.payload.ok, r.payload.error || '失败');
    assert(r.payload.data.md5 === '5d41402abc4b2a76b9719d911017c592', 'MD5 错误');
    return 'MD5 正确';
  });

  await check('POST /api/tools/cron', async () => {
    const r = await call(base, 'POST', '/api/tools/cron', { expr: '0 3 * * *' });
    assert(r.payload.ok, r.payload.error || '失败');
    assert(r.payload.data.next.length === 5, '未来执行时间不足');
    return '5 次执行时间';
  });

  await check('GET /api/apps/catalog', async () => {
    const r = await call(base, 'GET', '/api/apps/catalog');
    assert(r.payload.ok, r.payload.error || '失败');
    assert(r.payload.data.apps.length >= 10, '应用数量不足');
    assert(Array.isArray(r.payload.data.categories), '分类缺失');
    return `${r.payload.data.apps.length} 个应用`;
  });

  await check('POST /api/apps/compose', async () => {
    const r = await call(base, 'POST', '/api/apps/compose', {
      id: 'navidrome',
      dataDir: path.join(fixture, 'docker'),
      mediaDir: fixture,
      port: 4533,
    });
    assert(r.payload.ok, r.payload.error || '失败');
    assert(r.payload.data.compose.includes('deluan/navidrome'), '镜像缺失');
    assert(r.payload.data.compose.includes(':4533'), '端口缺失');
    return 'compose 正常';
  });

  await check('GET /api/checkup/scan（一键体检）', async () => {
    const r = await call(base, 'GET', '/api/checkup/scan');
    assert(r.payload.ok, r.payload.error || '失败');
    const d = r.payload.data;
    assert(Array.isArray(d.items) && d.items.length >= 3, '体检项不足');
    assert(typeof d.summary.total === 'number', '缺少汇总');
    return `${d.items.length} 项 / 异常 ${d.summary.bad}`;
  });

  await check('GET /api/cleanup/scan（系统清理，只扫描）', async () => {
    const r = await call(base, 'GET', '/api/cleanup/scan');
    assert(r.payload.ok, r.payload.error || '失败');
    assert(Array.isArray(r.payload.data.targets), 'targets 应为数组');
    return `${r.payload.data.targets.length} 个可清理项`;
  });

  await check('GET /api/procs（服务进程）', async () => {
    const r = await call(base, 'GET', '/api/procs');
    assert(r.payload.ok, r.payload.error || '失败');
    assert(Array.isArray(r.payload.data.items), '进程列表应为数组');
    return `${r.payload.data.items.length} 个进程 / 端口 ${r.payload.data.ports.length}`;
  });

  await check('GET /api/docker/overview（Docker 概览）', async () => {
    const r = await call(base, 'GET', '/api/docker/overview');
    assert(r.payload.ok, r.payload.error || '失败');
    assert(typeof r.payload.data.available === 'boolean', '缺少 available 标记');
    return r.payload.data.available ? `${r.payload.data.containers.length} 个容器` : '本机 Docker 不可用（已降级）';
  });

  await check('GET /api/hardware/overview（硬件信息）', async () => {
    const r = await call(base, 'GET', '/api/hardware/overview');
    assert(r.payload.ok, r.payload.error || '失败');
    const d = r.payload.data;
    assert(d.cpu && typeof d.cpu.cores === 'number', '缺少 CPU 信息');
    assert(Array.isArray(d.nics), '网卡列表应为数组');
    assert(d.memory && typeof d.memory.total === 'number', '缺少内存信息');
    return `${d.cpu.cores} 核 / 内存 ${(d.memory.total / 1024 ** 3).toFixed(0)}GB / 网卡 ${d.nics.length}`;
  });

  await check('GET /api/storage/overview（硬盘存储）', async () => {
    const r = await call(base, 'GET', '/api/storage/overview');
    assert(r.payload.ok, r.payload.error || '失败');
    const d = r.payload.data;
    assert(Array.isArray(d.disks), '磁盘列表应为数组');
    assert(Array.isArray(d.partitions), '分区列表应为数组');
    assert(d.summary && typeof d.summary.diskCount === 'number', '缺少汇总');
    return `${d.disks.length} 块盘 / ${d.partitions.length} 个分区`;
  });

  await check('GET /api/update/check（版本检测）', async () => {
    const r = await call(base, 'GET', '/api/update/check');
    assert(r.payload.ok, r.payload.error || '失败');
    const d = r.payload.data;
    assert(typeof d.current === 'string' && d.current, '缺少当前版本');
    assert(typeof d.releases_url === 'string' && d.releases_url.includes('releases'), '缺少 Releases 链接');
    return `当前 v${d.current} / ${d.latest ? '最新 v' + d.latest : (d.error || '未取到最新')}`;
  });

  await check('GET /api/filemgr/list + analyze（文件管理）', async () => {
    const list = await call(base, 'GET', '/api/filemgr/list');
    assert(list.payload.ok, list.payload.error || '失败');
    assert(Array.isArray(list.payload.data.entries), '目录列表应为数组');
    const a = await call(base, 'GET', '/api/filemgr/analyze');
    assert(a.payload.ok, a.payload.error || '失败');
    assert(Array.isArray(a.payload.data.categories), '分类应为数组');
    assert(Array.isArray(a.payload.data.largest), '大文件应为数组');
    return `${list.payload.data.entries.length} 个条目 / ${a.payload.data.files} 个文件`;
  });

  await check('GET /api/security/overview（安全防护）', async () => {
    const r = await call(base, 'GET', '/api/security/overview');
    assert(r.payload.ok, r.payload.error || '失败');
    const d = r.payload.data;
    assert(Array.isArray(d.items) && d.items.length >= 3, '检查项不足');
    assert(d.score === null || typeof d.score === 'number', 'score 类型异常');
    assert(typeof d.level === 'string', '缺少等级');
    return `${d.items.length} 项 / ${d.score === null ? '无法评分' : d.score + ' 分'}`;
  });

  await check('GET /api/speedtest/ping（延迟/抖动/丢包）', async () => {
    const r = await call(base, 'GET', '/api/speedtest/ping?count=5');
    assert(r.payload.ok, r.payload.error || '失败');
    const d = r.payload.data;
    assert(typeof d.loss === 'number', '缺少丢包率');
    assert(Array.isArray(d.samples), '缺少采样');
    return `延迟 ${d.latency ?? '—'}ms / 丢包 ${d.loss}%`;
  });

  await check('GET /api/netdiag/lan + /traffic（网络诊断）', async () => {
    const lan = await call(base, 'GET', '/api/netdiag/lan');
    assert(lan.payload.ok, lan.payload.error || '失败');
    assert(Array.isArray(lan.payload.data.items), '邻居列表应为数组');
    const t = await call(base, 'GET', '/api/netdiag/traffic');
    assert(t.payload.ok, t.payload.error || '失败');
    assert(Array.isArray(t.payload.data.items), '流量列表应为数组');
    return `邻居 ${lan.payload.data.items.length} / 接口 ${t.payload.data.items.length}`;
  });

  await check('POST /api/apps/suggest-port', async () => {
    const r = await call(base, 'POST', '/api/apps/suggest-port', { port: 4533 });
    assert(r.payload.ok, r.payload.error || '失败');
    assert(r.payload.data.port >= 4533, '端口建议异常');
    return '可用端口 ' + r.payload.data.port;
  });

  await check('GET /api/monitor', async () => {
    await call(base, 'GET', '/api/monitor'); // 首次采样只建立基线
    const r = await call(base, 'GET', '/api/monitor');
    assert(r.payload.ok, r.payload.error || '失败');
    assert(r.payload.data.memory.total > 0, '内存总量异常');
    assert(Array.isArray(r.payload.data.disks), '磁盘列表异常');
    return `${r.payload.data.cores} 核 / ${r.payload.data.disks.length} 块盘`;
  });

  await check('GET /api/smart/overview', async () => {
    const r = await call(base, 'GET', '/api/smart/overview');
    assert(r.payload.ok, r.payload.error || '失败');
    assert(Array.isArray(r.payload.data.disks), 'disks 不是数组');
    return `${r.payload.data.disks.length} 块磁盘`;
  });

  await check('GET /api/smart/diagnose', async () => {
    const r = await call(base, 'GET', '/api/smart/diagnose');
    assert(r.payload.ok, r.payload.error || '失败');
    assert(Array.isArray(r.payload.data.disks), 'disks 不是数组');
    return `${r.payload.data.disks.length} 块磁盘诊断`;
  });

  await check('授权文件热加载（无需重启）', async () => {
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-hotroot-'));
    fs.writeFileSync(path.join(dataDir, 'paths.env'), `SS_ROOTS='${fixture}${path.delimiter}${extra}'\n`);
    await new Promise((r) => setTimeout(r, 2600));
    const r = await call(base, 'GET', '/api/system');
    assert(r.payload.ok, r.payload.error || '失败');
    assert(
      r.payload.data.roots.some((x) => x.path === fs.realpathSync(extra)),
      '2 秒内没有热加载新目录'
    );
    return '2 秒内生效';
  });

  await check('路径沙箱拒绝越界', async () => {
    const r = await call(base, 'POST', '/api/files/scan', { dir: path.join(os.tmpdir(), '..'), profile: 'auto' });
    assert(r.status === 403, `期望 403，实际 ${r.status}`);
    return '403';
  });

  // 登录保护
  const authPort = await freePort();
  const authBase = `http://127.0.0.1:${authPort}`;
  const authChild = start(authPort, { SS_PASSWORD: 'test-pass-123' });
  const started = await waitFor(authBase + '/api/health');
  if (!started) {
    results.push({ name: '登录保护：启动', ok: false, detail: '启动失败' });
  } else {
    await check('未登录访问被拒绝', async () => {
      const r = await call(authBase, 'GET', '/api/system');
      assert(r.status === 401, `期望 401，实际 ${r.status}`);
      return '401';
    });
    await check('错误密码被拒绝', async () => {
      const r = await call(authBase, 'POST', '/api/login', { password: 'wrong' });
      assert(r.status === 401, `期望 401，实际 ${r.status}`);
      return '401';
    });
    await check('正确密码可登录并访问', async () => {
      const login = await call(authBase, 'POST', '/api/login', { password: 'test-pass-123' });
      assert(login.status === 200, '登录失败');
      const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
      assert(cookie.startsWith('ss_auth='), '未下发 Cookie');
      const r = await call(authBase, 'GET', '/api/system', undefined, { Cookie: cookie });
      assert(r.status === 200 && r.payload.ok, '登录后仍无法访问');
      return 'Cookie 有效';
    });
    authChild.kill();
  }

  child.kill();

  console.log('\n端到端测试结果\n' + '─'.repeat(46));
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log('─'.repeat(46));
  console.log(`${results.length - failed.length}/${results.length} 通过`);

  if (failed.length) {
    console.log('\n服务日志（末尾）：\n' + child.getLogs().slice(-3000));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  if (child) child.kill();
  process.exit(1);
});
