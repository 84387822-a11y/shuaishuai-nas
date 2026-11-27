'use strict';

/**
 * 安全防护：只读体检，不改动任何系统配置。
 *
 * 检查项：
 * - SSH：是否允许 root 登录、是否启用密码登录、端口是否默认 22
 * - 账号：空密码账号、UID 0 账号、可登录账号数量
 * - 对外端口：监听在 0.0.0.0 / :: 的端口，并标注常见高危端口
 * - 防火墙：ufw / nftables / iptables 是否有生效规则
 * - 失败登录：lastb 最近记录数（需要 root，读不到则跳过）
 *
 * 评分：100 分起，按风险等级扣分（高危 15 / 中危 8 / 低危 3）。
 */

const fs = require('node:fs');

const { run, findBin } = require('../lib/util');

const HIGH_RISK_PORTS = {
  21: 'FTP（明文传输）',
  23: 'Telnet（明文传输）',
  111: 'rpcbind',
  139: 'SMB',
  445: 'SMB',
  2375: 'Docker 未加密 API',
  3306: 'MySQL',
  5432: 'PostgreSQL',
  6379: 'Redis',
  9200: 'Elasticsearch',
  27017: 'MongoDB',
};

const SHELL_BLOCKLIST = /(nologin|false|sync|shutdown|halt)$/;

function readFile(file, max = 65536) {
  try {
    return fs.readFileSync(file, 'utf8').slice(0, max);
  } catch {
    return '';
  }
}

/* ---------------- SSH ---------------- */

function checkSsh() {
  const items = [];
  const conf = readFile('/etc/ssh/sshd_config', 65536);
  if (!conf) {
    return [{ key: 'ssh', title: 'SSH 配置', level: 'unknown', detail: '读不到 /etc/ssh/sshd_config' }];
  }

  const value = (re) => {
    const m = re.exec(conf);
    return m ? m[1].trim().toLowerCase() : '';
  };

  const rootLogin = value(/^\s*PermitRootLogin\s+(\S+)/im);
  if (rootLogin === 'yes') {
    items.push({ key: 'ssh-root', title: 'SSH 允许 root 直接登录', level: 'high', detail: 'PermitRootLogin yes，建议改为 prohibit-password 并改用普通账号 + sudo' });
  }

  const passwordAuth = value(/^\s*PasswordAuthentication\s+(\S+)/im);
  if (passwordAuth !== 'no') {
    items.push({ key: 'ssh-password', title: 'SSH 允许密码登录', level: 'medium', detail: '建议改用密钥登录（PasswordAuthentication no），可显著降低爆破风险' });
  }

  const port = value(/^\s*Port\s+(\d+)/im) || '22';
  if (port === '22') {
    items.push({ key: 'ssh-port', title: 'SSH 使用默认端口 22', level: 'low', detail: '改到非默认端口可减少自动化扫描（安全收益有限，按需处理）' });
  }

  if (!items.length) items.push({ key: 'ssh', title: 'SSH 配置', level: 'ok', detail: `端口 ${port}，未发现明显风险项` });
  return items;
}

/* ---------------- 账号 ---------------- */

function checkAccounts() {
  const items = [];
  const passwd = readFile('/etc/passwd', 65536);
  const shadow = readFile('/etc/shadow', 65536);

  if (passwd) {
    const lines = passwd.split('\n').filter(Boolean);
    const roots = lines.filter((l) => l.split(':')[2] === '0').map((l) => l.split(':')[0]);
    const loginUsers = lines.filter((l) => {
      const parts = l.split(':');
      return parts.length >= 7 && Number(parts[2]) >= 1000 && !SHELL_BLOCKLIST.test(parts[6]);
    });

    if (roots.length > 1) {
      items.push({ key: 'uid0', title: `存在 ${roots.length} 个 UID 0 账号`, level: 'high', detail: 'UID 0 账号：' + roots.join('、') });
    }

    items.push({
      key: 'login-users',
      title: `可登录账号 ${loginUsers.length} 个`,
      level: loginUsers.length > 3 ? 'low' : 'ok',
      detail: loginUsers.map((l) => l.split(':')[0]).slice(0, 10).join('、') || '无',
    });
  }

  if (shadow) {
    const empty = shadow.split('\n').filter((l) => {
      const parts = l.split(':');
      return parts.length >= 2 && parts[1] === '';
    }).map((l) => l.split(':')[0]);
    if (empty.length) {
      items.push({ key: 'empty-password', title: `${empty.length} 个账号密码为空`, level: 'high', detail: '账号：' + empty.join('、') + '，请立即设置密码或锁定' });
    }
  }

  if (!items.length) items.push({ key: 'accounts', title: '账号检查', level: 'unknown', detail: '读不到 /etc/passwd' });
  return items;
}

/* ---------------- 对外端口 ---------------- */

async function checkPorts() {
  const bin = findBin('ss');
  if (!bin) return { listening: [], items: [{ key: 'ports', title: '监听端口', level: 'unknown', detail: '本机没有 ss 命令' }] };

  const r = await run(bin, ['-lntuH'], { timeout: 10000 });
  const rows = String(r.stdout || '').split('\n').filter(Boolean);
  const listening = [];
  const risky = [];

  for (const line of rows) {
    const parts = line.trim().split(/\s+/);
    const proto = parts[0] || '';
    const local = parts[4] || '';
    const proc = (parts[6] || '').replace(/^users:\(\("/, '').replace(/"\).*$/, '');
    if (!local) continue;
    const portMatch = /:(\d+)$/.exec(local);
    const port = portMatch ? Number(portMatch[1]) : 0;
    const exposed = /^(0\.0\.0\.0|\*|\[::\]|::):/.test(local);
    listening.push({ proto, local, port, proc, exposed });
    if (risky.length < 10 && exposed && HIGH_RISK_PORTS[port]) {
      risky.push({ port, proc, hint: HIGH_RISK_PORTS[port] });
    }
  }

  const items = [];
  if (risky.length) {
    items.push({
      key: 'risky-ports',
      title: `${risky.length} 个高危端口对外开放`,
      level: 'high',
      detail: risky.map((x) => `${x.port}（${x.hint}）`).join('、'),
    });
  }
  const exposedCount = listening.filter((l) => l.exposed).length;
  items.push({
    key: 'exposed',
    title: `对外监听端口 ${exposedCount} 个`,
    level: exposedCount > 20 ? 'medium' : 'ok',
    detail: '仅统计监听在 0.0.0.0 / :: 的端口；局域网内网使用属正常。',
  });

  return { listening, items };
}

/* ---------------- 防火墙 ---------------- */

async function checkFirewall() {
  const ufw = findBin('ufw');
  if (ufw) {
    const r = await run(ufw, ['status'], { timeout: 10000 });
    const text = String(r.stdout || '');
    if (/Status:\s*active/i.test(text)) return { key: 'firewall', title: '防火墙', level: 'ok', detail: 'ufw 已启用' };
    if (/Status:\s*inactive/i.test(text)) return { key: 'firewall', title: '防火墙未启用', level: 'medium', detail: 'ufw 处于 inactive 状态' };
  }

  const nft = findBin('nft');
  if (nft) {
    const r = await run(nft, ['list', 'ruleset'], { timeout: 10000 });
    const text = String(r.stdout || '').trim();
    if (text) return { key: 'firewall', title: '防火墙', level: 'ok', detail: 'nftables 存在规则' };
  }

  const ipt = findBin('iptables');
  if (ipt) {
    const r = await run(ipt, ['-S'], { timeout: 10000 });
    const text = String(r.stdout || '').trim();
    const lines = text.split('\n').filter((l) => l && !/^-P .* ACCEPT$/.test(l));
    if (lines.length) return { key: 'firewall', title: '防火墙', level: 'ok', detail: `iptables 有 ${lines.length} 条规则` };
    return { key: 'firewall', title: '防火墙', level: 'medium', detail: 'iptables 只有默认 ACCEPT 策略，未配置规则' };
  }

  return { key: 'firewall', title: '防火墙', level: 'unknown', detail: '未检测到 ufw / nftables / iptables' };
}

/* ---------------- 失败登录 ---------------- */

async function checkFailedLogins() {
  const lastb = findBin('lastb');
  if (lastb) {
    const r = await run(lastb, ['-n', '200'], { timeout: 10000 });
    const text = String(r.stdout || '').trim();
    if (text) {
      const count = text.split('\n').filter((l) => /\S/.test(l) && !/^btmp begins/i.test(l) && !/^$/.test(l)).length;
      return { key: 'failed-login', title: `最近失败登录记录 ${count} 条`, level: count > 100 ? 'medium' : 'ok', detail: '来自 lastb（/var/log/btmp），数量大说明可能被爆破' };
    }
  }
  return { key: 'failed-login', title: '失败登录记录', level: 'unknown', detail: '读不到 lastb 记录（可能无权限或未安装）' };
}

/* ---------------- 汇总与评分 ---------------- */

const PENALTY = { high: 15, medium: 8, low: 3 };

async function overview() {
  const portResult = await checkPorts();
  const items = [
    ...checkSsh(),
    ...checkAccounts(),
    ...portResult.items,
    await checkFirewall(),
    await checkFailedLogins(),
  ];

  const known = items.filter((i) => i.level !== 'unknown');
  let score = null;
  let level = 'unknown';
  let levelText = '无法检测';
  if (known.length) {
    score = 100;
    for (const item of known) score -= PENALTY[item.level] || 0;
    score = Math.max(0, Math.min(100, score));
    level = score >= 90 ? 'good' : score >= 70 ? 'warn' : 'bad';
    levelText = level === 'good' ? '良好' : level === 'warn' ? '需要关注' : '存在风险';
  }

  return {
    scanned_at: new Date().toISOString(),
    score,
    level,
    level_text: levelText,
    counts: {
      high: items.filter((i) => i.level === 'high').length,
      medium: items.filter((i) => i.level === 'medium').length,
      low: items.filter((i) => i.level === 'low').length,
      ok: items.filter((i) => i.level === 'ok').length,
      unknown: items.filter((i) => i.level === 'unknown').length,
    },
    items,
    listening: portResult.listening.filter((l) => l.exposed).slice(0, 30),
  };
}

module.exports = [
  ['GET', '/api/security/overview', overview],
];
