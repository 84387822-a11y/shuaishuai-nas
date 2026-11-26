/**
 * 网络工具：Ping 连通性、TCP 端口探测、HTTP 探测、DNS 查询、IPv4 子网计算。
 *
 * 所有请求都发往本机后端（/api/network/*），由后端在 NAS 上执行；
 * 页面不引用任何 CDN 或内联脚本。
 */

import {
  api, action, badge, button, card, codeBlock, el, field, grid, hint,
  input, kv, list, note, select, split, stats, table, tabs, toast,
} from '../ui.js';

const DNS_TYPE_OPTIONS = [
  { value: 'A', label: 'A（IPv4 地址）' },
  { value: 'AAAA', label: 'AAAA（IPv6 地址）' },
  { value: 'CNAME', label: 'CNAME（别名）' },
  { value: 'MX', label: 'MX（邮件服务器）' },
  { value: 'TXT', label: 'TXT（文本记录）' },
  { value: 'NS', label: 'NS（域名服务器）' },
  { value: 'SRV', label: 'SRV（服务定位）' },
];

const SUBNET_EXAMPLES = ['192.168.1.0/24', '10.0.0.0/8', '172.16.0.0/20'];

function resultBox() {
  return el('div', { class: 'result-area' }, note('填写参数后点击执行。'));
}

function msText(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? '—'
    : `${value} ms`;
}

function countText(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('zh-CN')
    : '—';
}

/* ------------------------------------------------------------------ */
/* 连通性                                                              */
/* ------------------------------------------------------------------ */

function pingCard() {
  const hostInput = input({ placeholder: '192.168.1.1 或 www.baidu.com' });
  const countInput = input({ type: 'number', value: '4', min: 1, max: 10 });
  const out = resultBox();

  const btn = button('开始 Ping', () => action(btn, async () => {
    const rawCount = countInput.value.trim();
    const data = await api('/api/network/ping', {
      host: hostInput.value.trim(),
      count: rawCount === '' ? 4 : Number(rawCount),
    });
    const s = data.stats || {};

    out.replaceChildren(
      note(
        data.reachable
          ? `目标可达：${data.host}，丢包率 ${s.loss === null || s.loss === undefined ? '未知' : s.loss + '%'}。`
          : `目标不可达或全部丢包：${data.host}。`,
        data.reachable ? 'ok' : 'warn'
      ),
      stats([
        { label: '丢包率', value: s.loss === null || s.loss === undefined ? '—' : `${s.loss}%` },
        { label: '平均延迟', value: msText(s.avg) },
        { label: '最小延迟', value: msText(s.min) },
        { label: '最大延迟', value: msText(s.max) },
      ]),
      codeBlock(data.lines.join('\n') || '（无输出）', { title: 'ping 原始输出' })
    );
    toast(data.reachable ? 'Ping 执行完成' : 'Ping 已完成，目标不可达', data.reachable ? 'ok' : 'warn');
  }));

  return card('Ping 连通性', '调用系统 ping 命令，测试目标是否可达',
    field('目标主机', hostInput, '支持 IPv4 / IPv6、局域网主机名和域名'),
    field('探测次数', countInput, '1 ~ 10 次，默认 4 次'),
    el('div', { class: 'form-actions' }, btn),
    out
  );
}

function tcpCard() {
  const hostInput = input({ placeholder: '192.168.1.10' });
  const portsInput = input({ value: '80,443,5000', placeholder: '80,443,5000-5010' });
  const out = resultBox();

  const btn = button('开始探测', () => action(btn, async () => {
    const data = await api('/api/network/tcp', {
      host: hostInput.value.trim(),
      ports: portsInput.value.trim(),
    });

    out.replaceChildren(
      stats([
        { label: '开放端口', value: data.openPorts.length },
        { label: '探测总数', value: data.results.length },
        { label: '关闭 / 失败', value: data.results.length - data.openPorts.length },
      ]),
      data.openPorts.length
        ? el('div', { class: 'row', style: { marginBottom: '14px' } },
            ...data.openPorts.map((port) => badge(String(port), 'ok')))
        : note('没有发现开放端口。请确认目标主机在线、端口填写正确，并检查防火墙。', 'warn'),
      table(
        [
          { key: 'port', label: '端口', width: '90px', render: (r) => el('span', { class: 'mono', text: r.port }) },
          {
            key: 'open',
            label: '状态',
            width: '90px',
            render: (r) => badge(r.open ? '开放' : '关闭', r.open ? 'ok' : 'default'),
          },
          { key: 'ms', label: '耗时', width: '110px', render: (r) => `${r.ms} ms` },
          { key: 'error', label: '说明', render: (r) => r.error || (r.open ? '连接成功' : '连接被拒绝') },
        ],
        data.results
      )
    );
    toast(`端口探测完成，发现 ${data.openPorts.length} 个开放端口`, 'ok');
  }));

  return card('端口探测', 'TCP 连接探测，最多 200 个端口，并发 32',
    field('目标主机', hostInput, '只探测你有权限的网络设备'),
    field('端口表达式', portsInput, '用逗号分隔，支持范围，例如 80,443,5000-5010'),
    el('div', { class: 'form-actions' }, btn),
    out
  );
}

function httpCard() {
  const urlInput = input({ value: 'https://example.com', placeholder: 'https://example.com' });
  let method = 'GET';
  const methodSelect = select(
    [{ value: 'GET', label: 'GET' }, { value: 'HEAD', label: 'HEAD' }],
    method,
    (value) => (method = value)
  );
  const out = resultBox();

  const btn = button('发起探测', () => action(btn, async () => {
    const data = await api('/api/network/http', {
      url: urlInput.value.trim(),
      method,
    });

    const headerRows = Object.entries(data.headers || {}).map(([name, value]) => ({ name, value }));
    const statusText = `${data.status}${data.statusText ? ' ' + data.statusText : ''}`;

    out.replaceChildren(
      note(`HTTP ${statusText}，耗时 ${data.ms} ms。`, data.ok ? 'ok' : 'warn'),
      stats([
        { label: '状态码', value: data.status, sub: data.statusText || undefined },
        { label: '耗时', value: `${data.ms} ms` },
      ]),
      kv({
        '最终地址': data.finalUrl,
        '内容类型': data.contentType || '（未提供）',
      }),
      el('h4', { text: '响应头' }),
      table(
        [
          { key: 'name', label: '名称', width: '220px', render: (r) => el('span', { class: 'mono small', text: r.name }) },
          { key: 'value', label: '值', render: (r) => el('span', { class: 'mono small', text: r.value }) },
        ],
        headerRows,
        { empty: '没有可展示的响应头' }
      ),
      el('h4', { text: '响应体预览（前 2000 字）' }),
      data.bodyPreview
        ? codeBlock(data.bodyPreview, { title: '响应体' })
        : note(
            method === 'HEAD'
              ? 'HEAD 请求不返回响应体。'
              : '响应体为空，或内容类型不是文本，未显示预览。',
            'info'
          )
    );
    toast(`HTTP 探测完成：${statusText}`, data.ok ? 'ok' : 'warn');
  }));

  return card('HTTP 探测', '跟随重定向，只读取响应头与前 2000 字文本',
    field('URL', urlInput, '必须是 http:// 或 https:// 开头的完整地址'),
    field('请求方法', methodSelect, 'HEAD 只取响应头，不下载响应体'),
    el('div', { class: 'form-actions' }, btn),
    out
  );
}

function connectivityTab() {
  return grid(pingCard(), tcpCard(), httpCard());
}

/* ------------------------------------------------------------------ */
/* DNS                                                                 */
/* ------------------------------------------------------------------ */

function formatRecord(record) {
  if (Array.isArray(record)) return record.join('');
  if (record && typeof record === 'object') {
    if ('exchange' in record) return `${record.exchange}（优先级 ${record.priority}）`;
    if ('name' in record && 'port' in record) {
      return `${record.name}:${record.port}（优先级 ${record.priority}，权重 ${record.weight}）`;
    }
    return JSON.stringify(record);
  }
  return String(record);
}

function familyBadge(family) {
  const ipv6 = family === 6 || family === 'IPv6';
  return badge(ipv6 ? 'IPv6' : 'IPv4', ipv6 ? 'accent' : 'default');
}

function dnsTab() {
  const nameInput = input({ placeholder: 'example.com 或 _sip._tcp.example.com' });
  let recordType = 'A';
  const typeSelect = select(DNS_TYPE_OPTIONS, recordType, (value) => (recordType = value));
  const out = resultBox();

  const btn = button('查询 DNS', () => action(btn, async () => {
    const data = await api('/api/network/dns', {
      name: nameInput.value.trim(),
      type: recordType,
    });

    const rows = data.records.map((record, index) => ({
      index: index + 1,
      value: formatRecord(record),
    }));

    out.replaceChildren(
      stats([
        { label: '记录数量', value: data.records.length },
        { label: '查询耗时', value: `${data.ms} ms` },
      ]),
      el('h4', { text: `DNS 记录（${data.name} · ${data.type}）` }),
      table(
        [
          { key: 'index', label: '序号', width: '70px', render: (r) => el('span', { class: 'mono', text: r.index }) },
          { key: 'value', label: '记录值', render: (r) => el('span', { class: 'mono small', text: r.value }) },
        ],
        rows,
        { empty: `没有查询到 ${data.type} 记录` }
      ),
      el('h4', { text: '本机解析结果（系统 DNS / hosts）' }),
      data.lookup.length
        ? table(
            [
              { key: 'address', label: '地址', render: (r) => el('span', { class: 'mono', text: r.address }) },
              { key: 'family', label: '协议族', width: '100px', render: (r) => familyBadge(r.family) },
            ],
            data.lookup
          )
        : note('本机解析没有返回结果。SRV 等以下划线开头的名称通常无法直接 lookup，可忽略此项。', 'info'),
      card('常见用法', '排查解析问题时的常用记录类型',
        list([
          'A / AAAA：确认域名当前解析到的 IPv4 / IPv6 地址。',
          'CNAME：检查 CDN、对象存储或别名是否已正确绑定。',
          'MX：排查邮件域名的收信服务器与优先级。',
          'TXT：核对 SPF、DKIM、站点验证等文本记录。',
          'NS：确认域名当前由哪组 DNS 服务器托管。',
          'SRV：名称通常形如 _sip._tcp.example.com，用于定位服务端口。',
        ], { class: 'list-check' })
      )
    );
    toast('DNS 查询完成', 'ok');
  }));

  const left = card('DNS 查询', '支持 A / AAAA / CNAME / MX / TXT / NS / SRV',
    field('域名', nameInput, '支持中文域名，会自动转换为 punycode'),
    field('记录类型', typeSelect, '默认 A 记录'),
    el('div', { class: 'form-actions' }, btn),
    hint('查询会同时返回指定类型的记录和本机 getaddrinfo 解析结果，便于对比。')
  );

  return split(left, out);
}

/* ------------------------------------------------------------------ */
/* 子网计算                                                            */
/* ------------------------------------------------------------------ */

function subnetTab() {
  const cidrInput = input({ value: '192.168.1.0/24', placeholder: '192.168.1.0/24' });
  const out = resultBox();

  async function calculate() {
    const data = await api('/api/network/subnet', { cidr: cidrInput.value.trim() });
    const prefix = Number(data.cidr.slice(data.cidr.indexOf('/') + 1));

    out.replaceChildren(
      note(`已计算 ${data.cidr}，可用主机地址 ${countText(data.hostCount)} 个。`, 'ok'),
      stats([
        { label: '可用主机数', value: countText(data.hostCount) },
        { label: '子网掩码', value: data.netmask },
        { label: '地址分类', value: `${data.class} 类` },
      ]),
      kv({
        'CIDR': data.cidr,
        '网络地址': data.network,
        '广播地址': data.broadcast,
        '子网掩码': data.netmask,
        '反掩码（通配符）': data.wildcard,
        '第一个可用地址': data.firstHost,
        '最后一个可用地址': data.lastHost,
        '可用主机数': countText(data.hostCount),
        '地址分类': `${data.class} 类`,
        '私有地址': data.isPrivate ? '是' : '否',
      }),
      prefix === 31
        ? note('/31 属于点对点链路（RFC 3021），没有传统网络号与广播地址，两个地址都可用。', 'info')
        : null,
      prefix === 32
        ? note('/32 是单主机路由，网络地址、广播地址与主机地址重合，仅一个可用地址。', 'info')
        : null,
      prefix < 31
        ? note('网络地址与广播地址不分配给主机，可用主机数为「地址总数 - 2」。', 'info')
        : null
    );
    toast('子网计算完成', 'ok');
  }

  const calcBtn = button('开始计算', () => action(calcBtn, calculate));

  const exampleButtons = SUBNET_EXAMPLES.map((cidr) => {
    const exampleBtn = button(cidr, () => action(exampleBtn, async () => {
      cidrInput.value = cidr;
      await calculate();
    }), { variant: 'ghost' });
    return exampleBtn;
  });

  const left = card('子网计算', '纯本地计算，不发起任何网络请求',
    field('CIDR', cidrInput, 'IPv4 网段，前缀 0 ~ 32'),
    el('div', { class: 'form-actions' }, calcBtn),
    el('h4', { text: '示例' }),
    el('div', { class: 'row' }, ...exampleButtons),
    hint('输入主机地址（如 192.168.1.10/24）时会自动归一到网络地址。')
  );

  return split(left, out);
}

/* ------------------------------------------------------------------ */

export async function render(root) {
  root.appendChild(
    note('网络工具只在本机发起请求，不经过任何第三方服务器；请只探测你有权限的网络。', 'info')
  );
  root.appendChild(
    tabs([
      { label: '连通性', render: connectivityTab },
      { label: 'DNS 查询', render: dnsTab },
      { label: '子网计算', render: subnetTab },
    ])
  );
}
