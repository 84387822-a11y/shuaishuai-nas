'use strict';

/**
 * 带宽测速：后台任务 + 轮询进度。
 * - 下行：从公共测速端点流式下载，按 200ms 窗口统计瞬时速率；
 * - 上行：向公共测速端点 POST 一块数据，统计上传速率；
 * - 同时提供延迟 / 抖动 / 丢包探测（TCP 连接采样，不依赖 ICMP 权限）。
 */

const net = require('node:net');
const crypto = require('node:crypto');

const { str, badRequest, HttpError, run, findBin } = require('../lib/util');

const DOWN_URL = 'https://speed.cloudflare.com/__down?bytes=';
const UP_URL = 'https://speed.cloudflare.com/__up';
const PROBE_HOST = 'speed.cloudflare.com';

const tasks = new Map();

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function tcpProbe(host, port = 443, timeout = 3000) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const socket = net.connect({ host, port });
    const finish = (ok) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      socket.destroy();
      resolve(ok ? ms : null);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** 延迟 / 抖动 / 丢包：连续 TCP 探测。 */
async function ping(ctx) {
  const count = Math.min(20, Math.max(5, Number((ctx.query && ctx.query.get('count')) || 10) || 10));
  const rawHost = ctx.query && ctx.query.get('host');
  const host = rawHost ? str(rawHost, 'host', { max: 128 }) : PROBE_HOST;
  if (!/^[A-Za-z0-9.-]+$/.test(host)) throw badRequest('主机名不合法');

  const samples = [];
  let lost = 0;
  for (let i = 0; i < count; i += 1) {
    const ms = await tcpProbe(host);
    if (ms == null) lost += 1;
    else samples.push(ms);
  }
  if (!samples.length) {
    return { host, count, ok_count: 0, loss: 100, latency: null, jitter: null, samples: [] };
  }
  const avg = samples.reduce((s, n) => s + n, 0) / samples.length;
  const min = Math.min(...samples);
  // 抖动用相邻采样差值的平均
  let jitter = 0;
  for (let i = 1; i < samples.length; i += 1) jitter += Math.abs(samples[i] - samples[i - 1]);
  jitter = samples.length > 1 ? jitter / (samples.length - 1) : 0;

  return {
    host,
    count,
    ok_count: samples.length,
    loss: Number(((lost / count) * 100).toFixed(1)),
    latency: Number(avg.toFixed(1)),
    min: Number(min.toFixed(1)),
    jitter: Number(jitter.toFixed(1)),
    samples: samples.map((n) => Number(n.toFixed(1))),
  };
}

/* ------------------------------------------------------------------ */
/* 后台测速任务                                                        */
/* ------------------------------------------------------------------ */

async function runDownload(task) {
  task.phase = 'download';
  const started = Date.now();
  const deadline = started + task.durationMs;
  let bytes = 0;
  let windowBytes = 0;
  let windowStart = started;

  // 公共测速端点单次最大 50MB：按分片循环下载，直到达到测试时长
  const CHUNK = 50 * 1024 * 1024;

  while (Date.now() < deadline && !task.cancelled) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(DOWN_URL + CHUNK, {
        signal: controller.signal,
        headers: { 'User-Agent': 'ShuaiShuaiNAS-Speedtest/1.0' },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          windowBytes += value.length;
          const now = Date.now();
          if (now - windowStart >= 200) {
            const mbps = (windowBytes * 8) / ((now - windowStart) / 1000) / 1e6;
            task.samples.push({ t: now - started, down: Number(mbps.toFixed(1)), up: 0 });
            task.downMbps = Number(mbps.toFixed(1));
            task.downPeak = Math.max(task.downPeak, task.downMbps);
            task.totalBytes += windowBytes;
            windowBytes = 0;
            windowStart = now;
          }
          if (now >= deadline || task.cancelled) break;
        }
      } finally {
        try { await reader.cancel(); } catch { /* ignore */ }
        try { controller.abort(); } catch { /* ignore */ }
      }
    } catch (err) {
      // 主动中止属于正常结束；其它错误才向上抛
      if (!/abort/i.test(String((err && err.name) || ''))) throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  task.elapsed = Date.now() - started;
  return bytes;
}

async function runUpload(task) {
  task.phase = 'upload';
  const payload = crypto.randomBytes(8 * 1024 * 1024);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), task.durationMs + 5000);
  try {
    const res = await fetch(UP_URL, {
      method: 'POST',
      body: payload,
      signal: controller.signal,
      headers: { 'User-Agent': 'ShuaiShuaiNAS-Speedtest/1.0', 'Content-Type': 'application/octet-stream' },
    });
    await res.arrayBuffer().catch(() => null);
    const seconds = Math.max(0.2, (Date.now() - started) / 1000);
    const mbps = (payload.length * 8) / seconds / 1e6;
    task.upMbps = Number(mbps.toFixed(1));
    task.upPeak = task.upMbps;
    task.totalBytes += payload.length;
    task.samples.push({ t: Date.now() - task.startedAt, down: task.downMbps, up: task.upMbps });
    task.phase = 'done';
    return payload.length;
  } finally {
    clearTimeout(timer);
  }
}

async function runTask(task) {
  try {
    if (task.mode !== 'up') await runDownload(task);
    if (task.mode !== 'down' && !task.cancelled) await runUpload(task);
    if (!task.cancelled) task.state = 'done';
  } catch (err) {
    if (task.cancelled) {
      task.state = 'cancelled';
    } else if (/abort/i.test(String((err && err.name) || ''))) {
      task.state = 'done'; // 到达时长后主动中止，视为正常完成
    } else {
      task.state = 'error';
      task.error = (err && err.message) || '测速失败';
    }
  } finally {
    task.finishedAt = Date.now();
    // 任务保留 5 分钟供前端取结果
    setTimeout(() => tasks.delete(task.id), 5 * 60 * 1000).unref?.();
  }
}

function start(ctx) {
  const mode = str(ctx.body && ctx.body.mode, 'mode', { max: 8 }) || 'both';
  if (!['both', 'down', 'up'].includes(mode)) throw badRequest('mode 只能是 both / down / up');
  const seconds = Math.min(30, Math.max(5, Number((ctx.body && ctx.body.seconds) || 10) || 10));

  const task = {
    id: newId(),
    mode,
    seconds,
    durationMs: seconds * 1000,
    state: 'running',
    phase: 'starting',
    startedAt: Date.now(),
    finishedAt: 0,
    downMbps: 0,
    upMbps: 0,
    downPeak: 0,
    upPeak: 0,
    totalBytes: 0,
    elapsed: 0,
    cancelled: false,
    error: '',
    samples: [],
  };
  tasks.set(task.id, task);
  runTask(task);
  return { taskId: task.id, mode, seconds };
}

function status(ctx) {
  const id = str(ctx.query && ctx.query.get('taskId'), 'taskId', { max: 64 });
  const task = tasks.get(id);
  if (!task) throw new HttpError(404, '测速任务不存在或已过期');
  return {
    id: task.id,
    state: task.state,
    phase: task.phase,
    mode: task.mode,
    seconds: task.seconds,
    elapsed: task.finishedAt ? task.finishedAt - task.startedAt : Date.now() - task.startedAt,
    downMbps: task.downMbps,
    upMbps: task.upMbps,
    downPeak: task.downPeak,
    upPeak: task.upPeak,
    totalBytes: task.totalBytes,
    avgDown: task.samples.length ? Number((task.samples.reduce((s, x) => s + (x.down || 0), 0) / task.samples.length).toFixed(1)) : 0,
    avgUp: task.samples.length ? Number((task.samples.reduce((s, x) => s + (x.up || 0), 0) / task.samples.length).toFixed(1)) : 0,
    samples: task.samples.slice(-120),
    error: task.error,
  };
}

function cancel(ctx) {
  const id = str(ctx.body && ctx.body.taskId, 'taskId', { max: 64 });
  const task = tasks.get(id);
  if (!task) throw new HttpError(404, '测速任务不存在');
  task.cancelled = true;
  task.state = 'cancelled';
  return { id, state: task.state };
}

module.exports = [
  ['GET', '/api/speedtest/ping', ping],
  ['POST', '/api/speedtest/start', start],
  ['GET', '/api/speedtest/status', status],
  ['POST', '/api/speedtest/cancel', cancel],
];
