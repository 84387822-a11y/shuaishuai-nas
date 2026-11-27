'use strict';

/**
 * Docker 治理：容器/镜像概览、启停重启、日志、清理。
 * 所有操作都先校验容器名，命令用参数数组传给 execFile，不经过 shell。
 */

const { run, findBin, str, badRequest, HttpError } = require('../lib/util');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ACTIONS = new Set(['start', 'stop', 'restart', 'pause', 'unpause']);

function dockerBin() {
  const bin = findBin('docker');
  if (!bin) throw new HttpError(501, '本机没有 docker 命令');
  return bin;
}

async function overview() {
  const bin = findBin('docker');
  if (!bin) return { available: false, containers: [], images: [], usage: null };

  const ps = await run(bin, ['ps', '-a', '--format', '{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}'], { timeout: 12000 });
  if (ps.code !== 0) {
    return { available: false, containers: [], images: [], usage: null, error: String(ps.stderr || '').slice(0, 200) };
  }
  const containers = String(ps.stdout || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, image, state, status, ports] = line.split('\t');
      return { name, image, state, status, ports: ports || '' };
    });

  const imgs = await run(bin, ['images', '--format', '{{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.ID}}'], { timeout: 12000 });
  const images = String(imgs.stdout || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, size, id] = line.split('\t');
      return { ref, size, id: (id || '').slice(0, 12) };
    })
    .slice(0, 100);

  const df = await run(bin, ['system', 'df'], { timeout: 12000 });
  return {
    available: true,
    containers,
    images,
    usage: String(df.stdout || '').trim().slice(0, 1200),
  };
}

async function action(ctx) {
  const name = str(ctx.body && ctx.body.name, 'name', { max: 128 });
  const act = str(ctx.body && ctx.body.action, 'action', { max: 16 });
  if (!NAME_RE.test(name)) throw badRequest('容器名不合法');
  if (!ACTIONS.has(act)) throw badRequest('不支持的操作：' + act);
  // 禁止通过名称注入参数
  if (name.startsWith('-')) throw badRequest('容器名不合法');

  const bin = dockerBin();
  const r = await run(bin, [act, name], { timeout: 60000 });
  const detail = String(r.stdout || r.stderr || '').trim().slice(0, 400);
  if (r.code !== 0) throw new HttpError(500, `${act} 失败：${detail || 'docker 返回非 0'}`);
  return { name, action: act, detail };
}

async function logs(ctx) {
  const name = str(ctx.query && ctx.query.get('name'), 'name', { max: 128 });
  if (!NAME_RE.test(name)) throw badRequest('容器名不合法');
  const lines = Math.min(2000, Math.max(10, Number((ctx.query && ctx.query.get('lines')) || 200) || 200));

  const bin = dockerBin();
  const r = await run(bin, ['logs', '--tail', String(lines), name], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const text = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  if (r.code !== 0 && !text) throw new HttpError(500, '读取日志失败：' + String(r.stderr || '').slice(0, 160));
  return { name, lines, text: text.slice(-20000) };
}

module.exports = [
  ['GET', '/api/docker/overview', overview],
  ['POST', '/api/docker/action', action],
  ['GET', '/api/docker/logs', logs],
];
