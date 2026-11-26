'use strict';

/**
 * 网络工具：本机网络信息、Ping、TCP 端口探测、DNS 查询、HTTP 探测、IPv4 子网计算。
 *
 * 安全边界：
 * - 所有主机名 / IP 必须先过 isHostLike()，外部命令一律通过 run() + 参数数组执行，不经过 shell。
 * - Ping 只调用系统自带命令；命令缺失时给出中文错误，而不是让接口 500 崩溃。
 * - 禁止访问云厂商元数据地址，避免工具被当成 SSRF 跳板。
 * - 本模块只读取网络状态、不读写用户文件，因此不涉及 resolveUserPath / DATA_DIR。
 */

const os = require('node:os');
const dns = require('node:dns');
const net = require('node:net');
const { domainToASCII } = require('node:url');

const {
  str,
  int,
  oneOf,
  badRequest,
  HttpError,
  run,
  findBin,
  isHostLike,
  isPrivateHost,
} = require('../lib/util');

const METADATA_HOST = '169.254.169.254';
const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV'];
const HTTP_METHODS = ['GET', 'HEAD'];
const MAX_TCP_PORTS = 200;
const TCP_CONCURRENCY = 32;
const TCP_TIMEOUT = 1500;
const MAX_PREVIEW = 2000;
const PREVIEW_BYTES = 128 * 1024;

const PREVIEW_HEADERS = [
  'content-type',
  'content-length',
  'content-encoding',
  'server',
  'date',
  'cache-control',
  'last-modified',
  'etag',
  'location',
  'via',
  'x-cache',
  'x-powered-by',
  'strict-transport-security',
  'access-control-allow-origin',
];

const TCP_ERROR_LABEL = {
  ECONNREFUSED: '连接被拒绝',
  ETIMEDOUT: '连接超时',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  EACCES: '权限不足',
  EADDRNOTAVAIL: '地址不可用',
};

const FETCH_ERROR_LABEL = {
  ECONNREFUSED: '连接被拒绝',
  ENOTFOUND: '域名解析失败',
  EAI_AGAIN: 'DNS 暂时不可用',
  ETIMEDOUT: '连接超时',
  ECONNRESET: '连接被重置',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  CERT_HAS_EXPIRED: '证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: '证书无效（自签名）',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书链无法验证',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书域名不匹配',
};

/* ------------------------------------------------------------------ */
/* 通用校验                                                            */
/* ------------------------------------------------------------------ */

/** 校验主机名 / IP，顺带给出统一的错误提示。 */
function checkedHost(value, name = '主机') {
  const host = str(value, name, { max: 253 });
  if (!isHostLike(host)) throw badRequest(`${name}格式不正确，只支持 IP 或域名`);
  return host;
}

/** 云元数据地址会泄露实例凭据，任何主动探测都直接拒绝。 */
function rejectMetadata(host) {
  if (host === METADATA_HOST) {
    throw badRequest('出于安全考虑，禁止访问云元数据地址 169.254.169.254');
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new HttpError(504, message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ------------------------------------------------------------------ */
/* 1. 本机网络信息                                                      */
/* ------------------------------------------------------------------ */

async function info() {
  const interfaces = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const item of addresses || []) {
      // 过滤掉刚被移除的网卡等空条目
      if (!item || !item.address) continue;
      interfaces.push({
        name,
        address: item.address,
        family: item.family,
        mac: item.mac,
        internal: Boolean(item.internal),
        cidr: item.cidr || null,
      });
    }
  }

  return {
    hostname: os.hostname(),
    interfaces,
    dnsServers: dns.getServers(),
    platform: os.platform(),
    uptime: os.uptime(),
  };
}

/* ------------------------------------------------------------------ */
/* 2. Ping                                                            */
/* ------------------------------------------------------------------ */

/**
 * 解析 ping 输出。中英文、Windows / Linux 汇总行格式差异很大，因此逐个字段兜底。
 * 解析不出来时返回 null 字段，而不是报错——用户至少还能看原始输出。
 */
function parsePingOutput(text) {
  const value = String(text || '');
  const stats = { sent: null, received: null, loss: null, min: null, avg: null, max: null };

  let hit = /(?:已发送|sent)\s*[=:：]\s*(\d+)/i.exec(value);
  if (hit) stats.sent = Number(hit[1]);
  hit = /(?:已接收|received)\s*[=:：]\s*(\d+)/i.exec(value);
  if (hit) stats.received = Number(hit[1]);
  if (stats.sent === null) {
    hit = /(\d+)\s+packets?\s+transmitted/i.exec(value);
    if (hit) stats.sent = Number(hit[1]);
  }
  if (stats.received === null) {
    hit = /(\d+)\s+(?:packets?\s+)?received/i.exec(value);
    if (hit) stats.received = Number(hit[1]);
  }

  // Windows「丢失 = 0 (0% 丢失)」与 Linux「0% packet loss」的第一个百分数都是丢包率
  hit = /(\d+(?:\.\d+)?)\s*%/.exec(value);
  if (hit) stats.loss = Number(hit[1]);
  if (stats.loss === null && stats.sent !== null && stats.received !== null && stats.sent > 0) {
    stats.loss = Number((((stats.sent - stats.received) / stats.sent) * 100).toFixed(1));
  }

  // Linux / macOS: rtt min/avg/max/mdev = 0.041/0.052/0.063/0.010 ms
  hit = /=\s*([\d.]+)\/([\d.]+)\/([\d.]+)(?:\/[\d.]+)?\s*ms/.exec(value);
  if (hit) {
    stats.min = Number(hit[1]);
    stats.avg = Number(hit[2]);
    stats.max = Number(hit[3]);
  }
  if (stats.min === null) {
    hit = /(?:minimum|最短|最小)\s*[=:：]\s*([\d.]+)\s*ms/i.exec(value);
    if (hit) stats.min = Number(hit[1]);
  }
  if (stats.max === null) {
    hit = /(?:maximum|最长|最大)\s*[=:：]\s*([\d.]+)\s*ms/i.exec(value);
    if (hit) stats.max = Number(hit[1]);
  }
  if (stats.avg === null) {
    hit = /(?:average|平均)\s*[=:：]\s*([\d.]+)\s*ms/i.exec(value);
    if (hit) stats.avg = Number(hit[1]);
  }

  // 没有汇总行（例如只收到部分回包）时，用逐包 time= / 时间= 计算
  if (stats.min === null || stats.avg === null || stats.max === null) {
    const times = [];
    const re = /(?:time|时间)\s*[=<]\s*([\d.]+)\s*ms/gi;
    let item;
    while ((item = re.exec(value)) !== null) times.push(Number(item[1]));
    if (times.length > 0) {
      stats.min = Math.min(...times);
      stats.max = Math.max(...times);
      stats.avg = Number((times.reduce((sum, n) => sum + n, 0) / times.length).toFixed(2));
    }
  }

  return stats;
}

async function ping(ctx) {
  const host = checkedHost(ctx.body.host);
  const count = int(ctx.body.count, '探测次数', { min: 1, max: 10, fallback: 4 });

  const bin = findBin('ping');
  if (!bin) throw new HttpError(500, '本机没有找到 ping 命令，无法执行连通性测试');

  const args = process.platform === 'win32'
    ? ['-n', String(count), '-w', '1500', host]
    : ['-c', String(count), '-W', '2', host];

  const result = await run(bin, args, { timeout: 30000 });
  if (result.code === -1 && !result.stdout) {
    throw new HttpError(500, `Ping 执行失败：${result.stderr || '命令无法启动'}`);
  }

  const raw = [result.stdout, result.stderr].filter((s) => s && s.trim()).join('\n')
    || (result.timedOut ? '命令执行超时（30 秒）' : '没有输出');
  const stats = parsePingOutput(raw);
  const reachable = stats.received !== null ? stats.received > 0 : result.code === 0;

  const lines = raw.replace(/\r/g, '').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return {
    host,
    count,
    reachable,
    stats,
    lines: lines.slice(0, 60),
    raw,
  };
}

/* ------------------------------------------------------------------ */
/* 3. TCP 端口探测                                                      */
/* ------------------------------------------------------------------ */

/** 解析 "80,443,5000-5010"：去重、排序，并限制总数，防止一次探测把 NAS 打满。 */
function parsePorts(value) {
  // 先收拢「5000 - 5010」里的空格，再按逗号 / 空白切分
  const text = str(value, '端口', { max: 4096 }).replace(/\s*-\s*/g, '-');
  const ports = new Set();

  for (const piece of text.split(/[,\s;，；]+/).filter(Boolean)) {
    const match = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(piece);
    if (!match) throw badRequest(`端口表达式不合法：${piece}`);
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start < 1 || start > 65535 || end < 1 || end > 65535) {
      throw badRequest('端口必须在 1 ~ 65535 之间');
    }
    if (end < start) throw badRequest(`端口范围不合法：${piece}`);
    for (let port = start; port <= end; port += 1) {
      ports.add(port);
      if (ports.size > MAX_TCP_PORTS) {
        throw badRequest(`一次最多探测 ${MAX_TCP_PORTS} 个端口`);
      }
    }
  }

  if (ports.size === 0) throw badRequest('请填写要探测的端口');
  return [...ports].sort((a, b) => a - b);
}

function probePort(host, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const socket = net.connect({ host, port });

    const finish = (open, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const item = { port, open, ms: Date.now() - started };
      if (error) item.error = error;
      resolve(item);
    };

    socket.setTimeout(TCP_TIMEOUT, () => finish(false, '连接超时'));
    socket.once('connect', () => finish(true));
    socket.once('error', (err) => {
      const code = err && err.code;
      finish(false, TCP_ERROR_LABEL[code] || (code ? `连接失败（${code}）` : '连接失败'));
    });
  });
}

/** 固定并发数执行，避免 200 个端口同时建连耗尽文件描述符。 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function next() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const size = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: size }, () => next()));
  return results;
}

async function tcp(ctx) {
  const host = checkedHost(ctx.body.host);
  rejectMetadata(host);
  const ports = parsePorts(ctx.body.ports);

  const results = await mapLimit(ports, TCP_CONCURRENCY, (port) => probePort(host, port));

  return {
    host,
    results,
    openPorts: results.filter((item) => item.open).map((item) => item.port),
  };
}

/* ------------------------------------------------------------------ */
/* 4. DNS 查询                                                         */
/* ------------------------------------------------------------------ */

const DNS_ERROR_LABEL = {
  ENOTFOUND: '域名不存在（NXDOMAIN）',
  ENODATA: '没有查询到该类型的记录',
  ETIMEOUT: 'DNS 服务器响应超时',
  ESERVFAIL: 'DNS 服务器返回失败',
  EREFUSED: 'DNS 服务器拒绝查询',
  ECONNREFUSED: '无法连接 DNS 服务器',
  EAI_AGAIN: 'DNS 服务暂时不可用',
  EBADNAME: '域名格式不正确',
};

function normalizeDnsName(value) {
  const raw = str(value, '域名', { max: 512 });
  if (/[\s/\\]/.test(raw)) throw badRequest('域名格式不正确，不能包含空格或路径分隔符');
  // 转成 punycode，顺便支持「例子.中国」这类中文域名
  const ascii = domainToASCII(raw);
  if (!ascii || ascii.length > 253) throw badRequest('域名格式不正确');
  return ascii;
}

function dnsErrorMessage(err) {
  const code = err && err.code;
  return DNS_ERROR_LABEL[code] || (err && err.message) || '未知错误';
}

async function dnsQuery(ctx) {
  const name = normalizeDnsName(ctx.body.name);
  const type = oneOf(String(ctx.body.type || 'A').toUpperCase(), '记录类型', DNS_TYPES);
  const started = Date.now();

  // 本机解析（走 getaddrinfo / hosts）与指定类型查询并行，两者失败互不影响
  const lookupPromise = withTimeout(dns.promises.lookup(name, { all: true }), 5000, '本机解析超时')
    .catch(() => []);

  let records;
  try {
    records = await withTimeout(
      dns.promises.resolve(name, type),
      5000,
      'DNS 解析超时（5 秒）'
    );
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw badRequest(`解析失败：${dnsErrorMessage(err)}`);
  }

  const lookup = await lookupPromise;

  return {
    name,
    type,
    records,
    lookup,
    ms: Date.now() - started,
  };
}

/* ------------------------------------------------------------------ */
/* 5. HTTP 探测                                                        */
/* ------------------------------------------------------------------ */

function normalizeHttpUrl(value) {
  const raw = str(value, 'URL', { max: 2048 });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('URL 必须是 http:// 或 https:// 开头的完整地址');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('只支持 http 或 https 地址');
  }
  if (url.username || url.password) throw badRequest('URL 不能包含用户名或密码');
  rejectMetadata(url.hostname);
  return url;
}

function isTextualContentType(contentType) {
  const value = String(contentType || '').toLowerCase();
  if (value.startsWith('text/')) return true;
  return /(?:json|xml|javascript|ecmascript|graphql|x-www-form-urlencoded|yaml|csv)/.test(value);
}

/** 按响应声明的字符集解码，避免 GBK 页面预览出现乱码。 */
function decodePreview(buffer, contentType) {
  const match = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType || '');
  const label = match ? match[1] : 'utf-8';
  try {
    return new TextDecoder(label).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

/** 只读前 128KB 再解码，避免把大文件整个读进内存。 */
async function readBodyPreview(response, maxChars, contentType) {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;

  try {
    while (size < PREVIEW_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(Buffer.from(value));
      size += value.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 流已自然结束或已被超时中止，cancel 抛错可以忽略
    }
  }

  return decodePreview(Buffer.concat(chunks), contentType).slice(0, maxChars);
}

function pickHeaders(headers) {
  const picked = {};
  for (const name of PREVIEW_HEADERS) {
    const value = headers.get(name);
    if (value) picked[name] = value;
  }
  return picked;
}

function fetchFailure(err) {
  if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
    return new HttpError(504, '请求超时（8 秒）');
  }
  const code = err && err.cause && err.cause.code;
  const detail = FETCH_ERROR_LABEL[code] || code || (err && err.message) || '未知错误';
  return new HttpError(502, `请求失败：${detail}`);
}

async function httpProbe(ctx) {
  const target = normalizeHttpUrl(ctx.body.url);
  const method = oneOf(String(ctx.body.method || 'GET').toUpperCase(), '请求方法', HTTP_METHODS);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const started = Date.now();

  try {
    let response;
    try {
      response = await fetch(target, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'ShuaiShuaiNAS-Network/1.0' },
      });
    } catch (err) {
      throw fetchFailure(err);
    }

    const contentType = response.headers.get('content-type') || '';
    let bodyPreview = '';

    if (method === 'GET' && isTextualContentType(contentType)) {
      try {
        bodyPreview = await readBodyPreview(response, MAX_PREVIEW, contentType);
      } catch (err) {
        throw fetchFailure(err);
      }
    } else if (response.body) {
      // 非文本或 HEAD：不下载响应体
      try {
        await response.body.cancel();
      } catch {
        /* ignore */
      }
    }

    return {
      url: target.toString(),
      finalUrl: response.url || target.toString(),
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      ms: Date.now() - started,
      headers: pickHeaders(response.headers),
      bodyPreview,
      contentType,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* 6. IPv4 子网计算                                                     */
/* ------------------------------------------------------------------ */

function ipv4ToInt(value) {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    result = result * 256 + n;
  }
  return result >>> 0;
}

function intToIPv4(value) {
  const n = value >>> 0;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

async function subnet(ctx) {
  const raw = str(ctx.body.cidr, 'CIDR', { max: 64 });
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(raw);
  if (!match) throw badRequest('请使用 IPv4 CIDR 写法，例如 192.168.1.0/24');

  const address = ipv4ToInt(match[1]);
  if (address === null) throw badRequest('IPv4 地址不合法，每段必须在 0 ~ 255 之间');

  const prefix = Number(match[2]);
  if (prefix < 0 || prefix > 32) throw badRequest('子网前缀必须在 0 ~ 32 之间');

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const wildcard = (~mask) >>> 0;
  const network = (address & mask) >>> 0;
  const broadcast = (network | wildcard) >>> 0;
  const total = 2 ** (32 - prefix);

  let hostCount;
  let firstHost;
  let lastHost;
  if (prefix === 32) {
    // 单主机路由：网络号、广播号与主机地址重合
    hostCount = 1;
    firstHost = network;
    lastHost = network;
  } else if (prefix === 31) {
    // 点对点链路（RFC 3021）：两个地址都可用
    hostCount = 2;
    firstHost = network;
    lastHost = broadcast;
  } else {
    hostCount = total - 2;
    firstHost = (network + 1) >>> 0;
    lastHost = (broadcast - 1) >>> 0;
  }

  const networkText = intToIPv4(network);
  const firstOctet = network >>> 24;
  const ipClass = firstOctet < 128 ? 'A' : firstOctet < 192 ? 'B' : firstOctet < 224 ? 'C' : firstOctet < 240 ? 'D' : 'E';

  return {
    cidr: `${networkText}/${prefix}`,
    network: networkText,
    broadcast: intToIPv4(broadcast),
    netmask: intToIPv4(mask),
    wildcard: intToIPv4(wildcard),
    firstHost: intToIPv4(firstHost),
    lastHost: intToIPv4(lastHost),
    hostCount,
    // 0.0.0.0/0 表示「任意地址」，按 isPrivateHost 会被误判为私有，这里单独处理
    isPrivate: network !== 0 && isPrivateHost(networkText),
    class: ipClass,
  };
}

module.exports = [
  ['GET', '/api/network/info', info],
  ['POST', '/api/network/ping', ping],
  ['POST', '/api/network/tcp', tcp],
  ['POST', '/api/network/dns', dnsQuery],
  ['POST', '/api/network/http', httpProbe],
  ['POST', '/api/network/subnet', subnet],
];
