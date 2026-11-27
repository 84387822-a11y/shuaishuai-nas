/**
 * 常用小工具：编码转换、哈希、JSON、时间戳、Cron、生成器、文本处理。
 * 所有请求都由后端在本机完成，前端不引入任何第三方库。
 */

import { render as renderRename } from './rename.js';

import {
  action, api, badge, button, bytes, card, checkbox, codeBlock, copyText, el,
  field, hint, input, kv, list, note, segmented, select, split, stats, table, tabs, textarea, toast,
} from '../ui.js';

const WEEK_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

const TEXT_OPS = [
  { value: 'sort', label: '按行排序' },
  { value: 'dedupe', label: '去除重复行（保留首次出现）' },
  { value: 'trim', label: '去空行与首尾空白' },
  { value: 'reverse', label: '反转行序' },
  { value: 'upper', label: '转为大写' },
  { value: 'lower', label: '转为小写' },
  { value: 'slug', label: '转为 URL Slug（中文保留）' },
  { value: 'count', label: '统计字符 / 行 / 单词 / 字节' },
];

const TEXT_OP_LABELS = {
  sort: '排序',
  dedupe: '去重',
  trim: '去空行',
  reverse: '反转',
  upper: '大写',
  lower: '小写',
  slug: 'URL Slug',
  count: '统计',
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatLocalIso(iso) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ` +
    `星期${WEEK_NAMES[date.getDay()]}`;
}

function resultBox(text = '输入内容后点击执行。') {
  return el('div', { class: 'result-area' }, note(text));
}

function copyButton(text) {
  const btn = el('button', { type: 'button', class: 'mini', text: '复制' });
  btn.addEventListener('click', () => action(btn, () => copyText(text, btn)));
  return btn;
}

function stack(...children) {
  return el('div', { style: { display: 'grid', gap: '16px' } }, ...children);
}

/* ------------------------------------------------------------------ */
/* 1. 编码转换                                                         */
/* ------------------------------------------------------------------ */

function encodingTab() {
  /* Base64 */
  const b64Input = textarea({ rows: 5, placeholder: '输入要编码的文本，或要解码的 Base64 字符串' });
  const b64Out = resultBox();
  let b64Mode = 'encode';
  let b64UrlSafe = false;

  const b64ModeSelect = segmented(
    [{ value: 'encode', label: '编码' }, { value: 'decode', label: '解码' }],
    b64Mode,
    (v) => (b64Mode = v)
  );

  const b64Btn = button('执行 Base64', () => action(b64Btn, async () => {
    const data = await api('/api/tools/base64', {
      text: b64Input.value,
      mode: b64Mode,
      urlSafe: b64UrlSafe,
    });
    b64Out.replaceChildren(
      stats([
        { label: '输入字节', value: bytes(data.bytesIn) },
        { label: '输出字节', value: bytes(data.bytesOut) },
      ]),
      codeBlock(data.result, {
        title: b64Mode === 'encode' ? 'Base64 编码结果' : 'Base64 解码结果',
      })
    );
  }));

  const b64Card = card('Base64 编解码', '标准 Base64 与 URL 安全变体',
    field('内容', b64Input, '解码时会忽略空白字符，并自动补全缺失的 = 号'),
    field('模式', b64ModeSelect),
    el('div', { class: 'row', style: { marginBottom: '14px' } },
      checkbox('URL 安全（用 - _ 替换 + /，去掉 = 号）', b64UrlSafe, (v) => (b64UrlSafe = v))
    ),
    el('div', { class: 'form-actions' }, b64Btn)
  );

  /* URL 编解码 */
  const urlInput = textarea({ rows: 4, placeholder: '输入普通文本，或包含 %XX 转义的 URL 片段' });
  const urlOut = resultBox();
  let urlMode = 'encode';
  const urlModeSelect = segmented(
    [{ value: 'encode', label: '编码' }, { value: 'decode', label: '解码' }],
    urlMode,
    (v) => (urlMode = v)
  );

  const urlBtn = button('执行 URL 编解码', () => action(urlBtn, async () => {
    const data = await api('/api/tools/url', { text: urlInput.value, mode: urlMode });
    urlOut.replaceChildren(
      codeBlock(data.result, {
        title: urlMode === 'encode' ? 'URL 编码结果' : 'URL 解码结果',
      })
    );
  }));

  const urlCard = card('URL 编码 / 解码', '使用 encodeURIComponent 与 decodeURIComponent',
    field('内容', urlInput),
    field('模式', urlModeSelect),
    el('div', { class: 'form-actions' }, urlBtn),
    hint('编码后会转义空格、中文、& ? = 等字符，适合拼接到 URL 参数中。')
  );

  return stack(split(b64Card, b64Out), split(urlCard, urlOut));
}

/* ------------------------------------------------------------------ */
/* 2. 哈希                                                             */
/* ------------------------------------------------------------------ */

function hashTab() {
  const hashInput = textarea({ rows: 7, placeholder: '输入任意文本，支持中文与多行内容' });
  const hashOut = resultBox();

  const hashBtn = button('计算哈希', () => action(hashBtn, async () => {
    const data = await api('/api/tools/hash', { text: hashInput.value });
    const rows = [
      { name: 'MD5', value: data.md5 },
      { name: 'SHA-1', value: data.sha1 },
      { name: 'SHA-256', value: data.sha256 },
      { name: 'SHA-512', value: data.sha512 },
    ];
    hashOut.replaceChildren(
      stats([
        { label: '字符数', value: data.length },
        { label: 'UTF-8 字节数', value: `${data.bytes} B` },
      ]),
      table(
        [
          { key: 'name', label: '算法', width: '100px' },
          { key: 'value', label: '摘要', render: (r) => el('span', { class: 'mono small', text: r.value }) },
          { label: '操作', width: '80px', render: (r) => copyButton(r.value) },
        ],
        rows
      )
    );
  }));

  const left = card('文本哈希', 'UTF-8 编码后计算，结果与常见工具一致',
    field('文本', hashInput, '最多 200 KB'),
    el('div', { class: 'form-actions' }, hashBtn),
    hint('MD5 / SHA-1 仅适合校验完整性；需要安全场景时请使用 SHA-256 或 SHA-512。')
  );

  return split(left, hashOut);
}

/* ------------------------------------------------------------------ */
/* 3. JSON                                                             */
/* ------------------------------------------------------------------ */

function jsonTab() {
  const jsonInput = textarea({
    rows: 12,
    placeholder: '{\n  "name": "NAS助手",\n  "version": 1,\n  "features": ["影视", "音乐"]\n}',
  });
  const jsonOut = resultBox();

  async function runJson(mode, label) {
    const data = await api('/api/tools/json', { text: jsonInput.value, mode });
    if (!data.valid) {
      jsonOut.replaceChildren(note(data.error, 'error'));
      return;
    }
    const s = data.stats;
    jsonOut.replaceChildren(
      note(mode === 'validate' ? 'JSON 合法，可以正常解析。' : `${label}完成，JSON 语法合法。`, 'ok'),
      stats([
        { label: '键数量', value: s.keys },
        { label: '最大深度', value: s.depth },
        { label: '数组', value: s.arrays },
        { label: '字符串', value: s.strings },
        { label: '数字', value: s.numbers },
        { label: '布尔', value: s.booleans },
        { label: 'null', value: s.nulls },
      ]),
      codeBlock(data.result, { title: `${label}结果` })
    );
  }

  const prettyBtn = button('格式化', () => action(prettyBtn, () => runJson('pretty', '格式化')));
  const minifyBtn = button('压缩', () => action(minifyBtn, () => runJson('minify', '压缩')), { variant: 'ghost' });
  const validateBtn = button('校验', () => action(validateBtn, () => runJson('validate', '校验')), { variant: 'ghost' });

  const left = card('JSON 格式化 / 校验', '解析失败会给出中文错误位置',
    field('JSON 内容', jsonInput, '最多 200 KB'),
    el('div', { class: 'form-actions' }, prettyBtn, minifyBtn, validateBtn),
    hint('统计包含所有层级的键数量与叶子节点类型，最大深度按容器层级计算。')
  );

  return split(left, jsonOut);
}

/* ------------------------------------------------------------------ */
/* 4. 时间戳                                                           */
/* ------------------------------------------------------------------ */

function timeTab() {
  const timeInput = input({ placeholder: '1700000000 / 1700000000000 / 2024-01-01 12:00:00' });
  let timeFrom = 'auto';
  const timeSelect = select(
    [
      ['auto', '自动识别'],
      ['s', '秒级时间戳'],
      ['ms', '毫秒级时间戳'],
      ['date', '日期字符串'],
    ],
    timeFrom,
    (v) => (timeFrom = v)
  );
  const timeOut = resultBox();

  async function runTime() {
    const data = await api('/api/tools/time', { value: timeInput.value.trim(), from: timeFrom });
    timeOut.replaceChildren(
      stats([
        { label: '秒级时间戳', value: data.timestamp },
        { label: '毫秒级时间戳', value: data.timestampMs },
      ]),
      kv({
        ISO: data.iso,
        本地时间: data.local,
        'UTC 时间': data.utc,
        相对现在: data.relative,
        星期: data.week,
        年内第几天: data.dayOfYear,
      })
    );
  }

  const convertBtn = button('转换时间', () => action(convertBtn, runTime));
  const nowBtn = button('填入当前时间', () => action(nowBtn, async () => {
    timeInput.value = String(Date.now());
    timeFrom = 'auto';
    timeSelect.value = 'auto';
    await runTime();
  }), { variant: 'ghost' });

  const left = card('时间戳转换', '秒 / 毫秒 / 日期字符串互转',
    field('时间', timeInput, '自动识别 10 位秒级、13 位毫秒级时间戳，其余按日期解析'),
    field('来源', timeSelect),
    el('div', { class: 'form-actions' }, convertBtn, nowBtn),
    hint('本地时间与星期使用服务器本地时区；UTC 时间带 UTC 后缀。')
  );

  return split(left, timeOut);
}

/* ------------------------------------------------------------------ */
/* 5. Cron                                                             */
/* ------------------------------------------------------------------ */

function cronTab() {
  const cronInput = input({ placeholder: '0 3 * * *' });
  const cronOut = resultBox();

  async function runCron() {
    const data = await api('/api/tools/cron', { expr: cronInput.value.trim(), count: 5 });
    if (!data.valid) {
      cronOut.replaceChildren(
        note(`表达式不合法：${data.error}`, 'error'),
        hint('支持 5 段（分 时 日 月 周）、6 段（秒 分 时 日 月 周）以及 @daily 等快捷写法。')
      );
      return;
    }

    const children = [note(data.description, 'ok')];
    if (data.error) children.push(note(data.error, 'warn'));

    children.push(
      table(
        [
          { key: 'name', label: '字段', width: '80px' },
          { key: 'value', label: '表达式', render: (r) => el('span', { class: 'mono small', text: r.value }) },
          { key: 'meaning', label: '含义' },
        ],
        data.fields
      )
    );

    if (data.next.length > 0) {
      const lines = data.next.map((iso, i) => `${i + 1}. ${formatLocalIso(iso)}`);
      children.push(
        codeBlock(lines.join('\n'), {
          title: `未来 ${data.next.length} 次执行时间（${data.timezone}）`,
        })
      );
    }
    cronOut.replaceChildren(...children);
  }

  function sampleButton(expr) {
    const btn = button(expr, () => action(btn, async () => {
      cronInput.value = expr;
      await runCron();
    }), { variant: 'ghost' });
    return btn;
  }

  const cronBtn = button('解析表达式', () => action(cronBtn, runCron));

  const left = card('Cron 表达式', '支持标准 5 段与带秒的 6 段写法',
    field('表达式', cronInput, '例如 0 3 * * *、*/5 * * * *、0 0 1 * *、@daily'),
    el('div', { class: 'row', style: { marginBottom: '14px' } },
      ...['0 3 * * *', '*/5 * * * *', '0 0 1 * *', '@daily'].map(sampleButton)
    ),
    el('div', { class: 'form-actions' }, cronBtn),
    hint('月份可用 JAN-DEC，星期可用 SUN-SAT；周日既写 0 也写 7。6 段表达式只在未来 24 小时内查找。')
  );

  return split(left, cronOut);
}

/* ------------------------------------------------------------------ */
/* 6. 生成器                                                           */
/* ------------------------------------------------------------------ */

function generatorTab() {
  /* 密码 */
  const passLength = input({ type: 'number', value: '20', min: 4, max: 128 });
  const passCount = input({ type: 'number', value: '1', min: 1, max: 20 });
  let passSymbols = true;
  const passOut = resultBox();

  const passBtn = button('生成密码', () => action(passBtn, async () => {
    const data = await api('/api/tools/password', {
      length: Number(passLength.value),
      symbols: passSymbols,
      count: Number(passCount.value),
    });
    passOut.replaceChildren(
      stats([
        { label: '估算熵值', value: `${data.entropy} bit`, sub: `共 ${data.passwords.length} 条` },
      ]),
      codeBlock(data.passwords.join('\n'), { title: '生成的密码' })
    );
  }));

  const passCard = card('密码生成器', '使用 crypto.randomInt 取字符',
    field('长度（4 ~ 128）', passLength),
    field('数量（1 ~ 20）', passCount),
    el('div', { class: 'row', style: { marginBottom: '14px' } },
      checkbox('包含符号', passSymbols, (v) => (passSymbols = v))
    ),
    el('div', { class: 'form-actions' }, passBtn),
    hint('熵值 = 长度 × log2(字符集大小)，数值越高越难被暴力猜解。')
  );

  /* UUID */
  const uuidCount = input({ type: 'number', value: '5', min: 1, max: 50 });
  const uuidOut = resultBox();

  const uuidBtn = button('生成 UUID', () => action(uuidBtn, async () => {
    const data = await api('/api/tools/uuid', { count: Number(uuidCount.value) });
    uuidOut.replaceChildren(
      stats([{ label: '生成数量', value: data.uuids.length }]),
      codeBlock(data.uuids.join('\n'), { title: 'UUID v4' })
    );
  }));

  const uuidCard = card('UUID 生成器', '使用 crypto.randomUUID 生成 v4 UUID',
    field('数量（1 ~ 50）', uuidCount),
    el('div', { class: 'form-actions' }, uuidBtn),
    hint('UUID v4 包含 122 位随机数，适合作为数据库主键或文件名。')
  );

  return stack(split(passCard, passOut), split(uuidCard, uuidOut));
}

/* ------------------------------------------------------------------ */
/* 7. 文本处理                                                         */
/* ------------------------------------------------------------------ */

function textTab() {
  const textInput = textarea({
    rows: 12,
    placeholder: '每行一条内容，例如：\n苹果\n香蕉\n苹果',
  });
  let textOp = 'sort';
  const textOpSelect = select(TEXT_OPS, textOp, (v) => (textOp = v));
  const textOut = resultBox();

  const textBtn = button('处理文本', () => action(textBtn, async () => {
    const data = await api('/api/tools/text', { text: textInput.value, op: textOp });
    if (textOp === 'count') {
      textOut.replaceChildren(
        stats([
          { label: '字符数', value: data.stats.chars },
          { label: '行数', value: data.stats.lines },
          { label: '单词数', value: data.stats.words },
          { label: '字节数', value: `${data.stats.bytes} B` },
        ])
      );
      return;
    }
    textOut.replaceChildren(
      stats([
        { label: '处理前字符', value: data.before },
        { label: '处理后字符', value: data.after },
      ]),
      codeBlock(data.result, { title: `${TEXT_OP_LABELS[textOp] || '处理'}结果` })
    );
  }));

  const left = card('文本处理', '按行排序、去重、去空行、反转与编码转换',
    field('内容', textInput, '最多 200 KB'),
    field('操作', textOpSelect),
    el('div', { class: 'form-actions' }, textBtn),
    hint('单词数按连续非空白字符统计；Slug 会保留中文并把空白转成短横线。')
  );

  return split(left, textOut);
}

/* ------------------------------------------------------------------ */
/* 8. 音乐转 MP3                                                       */
/* ------------------------------------------------------------------ */

function clipText(text, max) {
  const s = String(text === null || text === undefined ? '' : text);
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function pathCell(text, title, max = 40) {
  const full = title || String(text === null || text === undefined ? '' : text);
  return el('span', { class: 'mono small', text: clipText(text, max), title: full });
}

function musicTab() {
  const dirInput = input({ placeholder: '/vol1/media/音乐' });
  const limitInput = input({ type: 'number', value: '500', min: 1, max: 8000, step: 1 });
  let recursive = true;
  let last = null;
  const selected = new Set();
  let flash = null;
  let countLabel = null;

  const QUALITY_OPTIONS = [
    { value: '0', label: '音质最高（≈245 kbps）' },
    { value: '2', label: '高质量（≈190 kbps，默认）' },
    { value: '5', label: '中（≈130 kbps）' },
    { value: '9', label: '低（≈65 kbps）' },
  ];
  let quality = '2';
  const qualitySelect = select(QUALITY_OPTIONS, quality, (v) => (quality = v));
  let qualityOut = null;

  const out = el(
    'div',
    { class: 'result-area', style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
    note('选择目录并扫描后，勾选要转换的音乐文件。')
  );

  function pendingItems() {
    if (!last) return [];
    return last.items.filter((item) => !item.exists);
  }

  function selectedItems() {
    if (!last) return [];
    return last.items.filter((item) => selected.has(item.from));
  }

  function updateCount() {
    if (countLabel) countLabel.textContent = `已选 ${selectedItems().length} 项`;
  }

  function selectCell(item) {
    const box = el('input', { type: 'checkbox', class: 'checkbox' });
    box.checked = selected.has(item.from);
    if (item.exists) box.disabled = true;
    box.addEventListener('change', () => {
      if (box.checked) selected.add(item.from);
      else selected.delete(item.from);
      updateCount();
    });
    return box;
  }

  function ffmpegBlock(ff) {
    if (!ff) return null;
    if (ff.available) return note(`ffmpeg 可用${ff.path ? `：${ff.path}` : ''}，可以直接转换。`, 'ok');
    return card(
      '缺少 ffmpeg',
      '转换依赖 ffmpeg，请先在 NAS 上安装后再使用本工具',
      note(ff.hint, 'warn'),
      codeBlock(ff.install, { title: 'SSH 安装命令' }),
      el('p', { class: 'hint', text: '安装后无需重装本应用，重新点「扫描」即可。' })
    );
  }

  function renderResult() {
    if (!last) {
      out.replaceChildren(note(flash ? flash.text : '选择目录并扫描后开始。', flash ? flash.kind : 'info'));
      return;
    }

    const pending = pendingItems();
    const noPending = pending.length === 0;

    const convertBtn = button('转换选中为 MP3', () => action(convertBtn, doConvert, { loadingText: '转换中…' }), {
      disabled: noPending,
    });

    countLabel = el('span', { class: 'muted small', text: `已选 ${selectedItems().length} 项` });

    const bar = el('div', { class: 'row', style: { marginBottom: '12px' } },
      convertBtn,
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        el('span', { class: 'field-label', text: '音质' }),
        qualitySelect),
      countLabel);

    const blocks = [
      stats([
        { label: '可转换文件', value: last.total },
        { label: '待转换', value: pending.length },
        { label: '已存在 mp3', value: last.total - pending.length },
      ]),
      ffmpegBlock(last.ffmpeg),
      last.truncated ? note('已达数量上限，建议缩小目录范围后重新扫描。', 'warn') : null,
      flash ? note(flash.text, flash.kind) : null,
      noPending && last.total > 0
        ? note('所有音频都已转成 mp3（或已存在 mp3 输出），无需转换。', 'ok')
        : null,
      noPending && last.total === 0
        ? note('该目录下没有可转换的音频文件（已排除.mp3）。', 'info')
        : null,
      card(
        '可转换的音乐文件',
        '未生成 mp3 的默认勾选；已存在 mp3 输出的条目不可勾选（不覆盖原文件）',
        el('div', { class: 'mono small muted', style: { wordBreak: 'break-all', marginBottom: '10px' } },
          '目录：' + last.dir),
        bar,
        table(
          [
            { label: '选择', width: '52px', render: selectCell },
            { label: '文件', render: (item) => pathCell(item.rel, item.from) },
            { label: '大小', width: '90px', render: (item) => (Number.isFinite(item.size) ? bytes(item.size) : '-') },
            { label: '输出', render: (item) =>
                el('span', { class: 'mono small', text: item.toRel || item.to, title: item.to }) },
            { label: '状态', width: '110px', render: (item) =>
                item.exists ? el('span', { class: 'small', text: '已存在，跳过' }) : '' },
          ],
          last.items,
          { empty: '没有可转换的音频文件' }
        )
      ),
    ];

    out.replaceChildren(...blocks.filter(Boolean));
  }

  async function scan() {
    const data = await api('/api/tools/music/scan', {
      dir: dirInput.value.trim(),
      recursive,
      limit: Number(limitInput.value) || 500,
    });
    last = data;
    selected.clear();
    for (const item of data.items) {
      if (!item.exists) selected.add(item.from);
    }
    renderResult();
    return data;
  }

  async function refresh(message, kind = 'info') {
    flash = { text: message, kind };
    if (!last) {
      renderResult();
      return;
    }
    try {
      await scan();
    } catch (err) {
      toast('扫描刷新失败：' + err.message, 'warn');
      renderResult();
    }
  }

  async function doConvert() {
    const items = selectedItems();
    if (items.length === 0) {
      toast('请先勾选要转换的音乐文件', 'warn');
      return;
    }
    if (!confirm(`确定将 ${items.length} 个音乐文件转换成 MP3 吗？\n\n转换会写入当前目录下的 mp3/ 子文件夹，原文件保留不变。`)) return;

    const data = await api('/api/tools/music/convert', {
      items: items.map((i) => ({ from: i.from })),
      quality: Number(quality),
    });

    const results = data.results || [];
    const okCount = results.filter((r) => r.ok && !r.skipped).length;
    const skipCount = results.filter((r) => r.skipped).length;
    const failCount = results.filter((r) => !r.ok).length;

    function statusCell(r) {
      if (!r.ok) return badge('失败', 'error');
      if (r.skipped) return badge('跳过', 'warn');
      return badge('成功', 'ok');
    }
    function noteCell(r) {
      if (!r.ok) return el('span', { class: 'small', text: r.error || '未知错误' });
      if (r.skipped) return el('span', { class: 'small muted', text: r.reason || '目标已存在，不覆盖' });
      return el('span', { class: 'small muted', text: '已生成' });
    }
    function outCell(r) {
      if (!(r.ok && !r.skipped)) return null;
      return el('span', { class: 'mono small', text: clipPath(r.to, 56), title: r.to });
    }

    const blocks = [
      note(`转换完成：成功 ${okCount} 个，跳过 ${skipCount} 个，失败 ${failCount} 个。`,
        failCount > 0 ? 'warn' : 'ok'),
      data.outDirs && data.outDirs.length
        ? card('输出目录', `本次成功生成的 mp3 在 ${data.outDirs.length} 个目录里：`,
            list(data.outDirs.map((d) => el('span', { class: 'mono small', text: d })), { class: 'list-check' }))
        : null,
      card('转换日志', '逐个文件的转换结果与保存位置',
        table(
          [
            { label: '文件', render: (r) => el('span', { class: 'mono small', text: r.name || basenameShort(r.from), title: r.from }) },
            { label: '大小', width: '90px', render: (r) => (Number.isFinite(r.size) && r.size > 0 ? bytes(r.size) : '-') },
            { label: '状态', width: '70px', render: statusCell },
            { label: '说明', width: '160px', render: noteCell },
            { label: '输出路径', render: outCell },
          ],
          results,
          { empty: '无转换结果' }
        ))
    ];

    // 直接渲染详细结果日志，而不是只弹一句话
    out.replaceChildren(...blocks.filter(Boolean));
    toast(`转换完成：成功 ${okCount}，跳过 ${skipCount}，失败 ${failCount}`, failCount > 0 ? 'warn' : 'ok');
  }

  function basenameShort(p) {
    return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
  }

  function clipPath(p, max) {
    const s = String(p || '');
    if (s.length <= max) return s;
    return '…' + s.slice(-Math.max(0, max - 1));
  }

  const scanBtn = button('扫描并预览', () => action(scanBtn, async () => {
    flash = null;
    const data = await scan();
    toast(
      data.items.length ? `扫描到 ${data.items.length} 个可转换的音频文件` : '该目录没有可转换的音频',
      data.items.length ? 'info' : 'ok'
    );
  }));

  const left = card(
    '扫描参数',
    '先扫描预览，再勾选转换',
    field('目录', dirInput, '例如 /vol1/media/音乐；相对路径按第一个授权目录解析'),
    el('div', { class: 'row', style: { marginBottom: '12px' } },
      checkbox('递归子目录', recursive, (v) => (recursive = v))),
    field('数量上限', limitInput, '1 ~ 8000，默认 500'),
    el('div', { class: 'form-actions' }, scanBtn),
    hint('扫描只读取文件名；转换会把 FLAC / APE / WAV / M4A / AAC / OGG 等转成 MP3（VBR 编码）。')
  );

  const bottom = card(
    '安全说明',
    '转换前请知悉以下边界',
    list([
      '转换只生成新的 .mp3 文件，不会修改、删除或覆盖任何原文件。',
      '输出统一放在每个音频文件所在目录的 mp3/ 子文件夹里（同名 .mp3）。',
      '目标 mp3 已存在时默认不勾选、不覆盖，需要你手动处理旧文件。',
      '此工具依赖 NAS 上的 ffmpeg；未安装时只给提示，不会自动安装。',
    ], { class: 'list-check' })
  );

  return el('div', { style: { display: 'grid', gap: '16px' } },
    note('把 FLAC / APE / WAV / M4A / AAC / OGG / WMA 等音乐格式转成 MP3，输出到所选目录的 mp3/ 子文件夹。', 'warn'),
    split(left, out),
    bottom);
}

/* ------------------------------------------------------------------ */
/* 9. 一键查快递                                                        */
/* ------------------------------------------------------------------ */

const EXPRESS_KEY_STORE = 'ss-kuaidi-key';

function expressTab() {
  const coms = [
    ['auto', '自动识别'],
    ['shunfeng', '顺丰速运'],
    ['yuantong', '圆通速递'],
    ['zhongtong', '中通快递'],
    ['shentong', '申通快递'],
    ['yunda', '韵达快递'],
    ['jtexpress', '极兔速递'],
    ['jd', '京东物流'],
    ['ems', 'EMS'],
    ['youzhengguonei', '邮政快递包裹'],
    ['debangkuaidi', '德邦快递'],
    ['baisi', '百世快递'],
  ];
  const numInput = input({ placeholder: '输入快递单号，如 SF1423... 或 7800...' });
  let com = 'auto';
  const comSelect = select(coms, com, (v) => (com = v));
  const savedKey = localStorage.getItem(EXPRESS_KEY_STORE) || '';
  const keyInput = input({ type: 'password', value: savedKey, placeholder: '快递100 API Key（可选）' });
  let mode = savedKey ? 'inline' : 'jump';
  const modeSelect = segmented([
    { value: 'jump', label: '跳官方查单页（无需 Key）' },
    { value: 'inline', label: '本工具内显示轨迹（需 Key）' },
  ], mode, (v) => (mode = v));
  const out = resultBox();

  /* ---------------- 绑定单号（本地持久化，打开自动刷新） ---------------- */
  const BINDS_KEY = 'ss-express-binds';
  const comByCode = new Map(coms);
  function loadBinds() { try { return JSON.parse(localStorage.getItem(BINDS_KEY) || '[]') || []; } catch { return []; } }
  let binds = loadBinds();
  function saveBinds() { try { localStorage.setItem(BINDS_KEY, JSON.stringify(binds)); } catch { /* ignore */ } }
  const bindResults = new Map(); // num -> {stateText,lastTime,url,needKey,error,updatedAt}
  const bindListHost = el('div', { class: 'bind-list' });

  function officialUrlFor(bind) {
    const q = new URL('https://www.kuaidi100.com/');
    q.searchParams.set('nu', bind.num);
    if (bind.com !== 'auto') q.searchParams.set('com', bind.com);
    return q.toString();
  }

  function bindRow(bind) {
    const r = bindResults.get(bind.num);
    const comLabel = comByCode.get(bind.com) || bind.com || '未知';
    let status;
    if (!r) status = el('span', { class: 'small muted', text: '待刷新' });
    else if (r.error) status = el('span', { class: 'small', text: '查询失败：' + r.error });
    else if (r.needKey) status = el('span', { class: 'small muted', text: '需跳官方（未配 Key）' });
    else status = el('span', { class: 'small', text: (r.stateText || '未知') + (r.lastTime ? ' · ' + r.lastTime : '') });

    const openBtn = el('button', { class: 'mini', text: '官方', title: '打开官方查单页', onclick: () => window.open((r && r.url) || officialUrlFor(bind), '_blank', 'noopener') });
    const refBtn = el('button', { class: 'mini', text: '刷新', onclick: () => action(refBtn, () => refreshOne(bind)) });
    const delBtn = el('button', { class: 'mini', text: '删除', onclick: () => {
      binds = binds.filter((b) => b.num !== bind.num);
      saveBinds();
      bindResults.delete(bind.num);
      paintBinds();
    } });

    return el('div', { class: 'bind-row' },
      el('span', { class: 'bind-note', text: bind.label || '未命名' }),
      el('span', { class: 'mono small', text: bind.num, title: bind.num }),
      el('span', { class: 'small muted', text: comLabel }),
      el('div', { class: 'bind-status' }, status),
      el('div', { class: 'row', style: { gap: '6px' } }, openBtn, refBtn, delBtn));
  }

  function paintBinds() {
    const hasKey = Boolean(keyInput.value.trim());
    bindListHost.replaceChildren(
      binds.length
        ? el('div', { class: 'bind-list-body' }, ...binds.map(bindRow))
        : el('div', { class: 'empty', text: hasKey
            ? '还没有绑定单号。把想自动看的（你和家人的）单号加进来，打开本页自动刷新全部。'
            : '未绑定单号；也没配快递100 Key。加单号后会自动跳官方查单页（无需 Key）。' }));
  }

  async function refreshOne(bind) {
    const key = keyInput.value.trim();
    const data = await api('/api/tools/express', { num: bind.num, com: bind.com, key });
    if (data.needKey) {
      bindResults.set(bind.num, { needKey: true, url: data.url, updatedAt: new Date().toISOString() });
    } else {
      const last = data.timeline && data.timeline[0];
      bindResults.set(bind.num, {
        stateText: data.stateText || data.message || '未知',
        lastTime: last ? last.time : '',
        lastContext: last ? last.context : '',
        url: data.url,
        needKey: false,
        error: data.error || null,
        updatedAt: new Date().toISOString(),
      });
    }
    paintBinds();
    return data;
  }

  async function refreshAll() {
    if (!binds.length) { paintBinds(); toast('还没有绑定单号', 'warn'); return; }
    let ok = 0; let jump = 0; let fail = 0;
    for (const bind of binds) {
      try {
        const d = await refreshOne(bind);
        if (d.needKey) jump += 1; else ok += 1;
      } catch {
        fail += 1;
        bindResults.set(bind.num, { error: '查询失败', updatedAt: new Date().toISOString() });
      }
    }
    paintBinds();
    toast(`刷新完成：成功 ${ok}，跳官方 ${jump}，失败 ${fail}`, fail > 0 ? 'warn' : 'ok');
  }

  function jumpUrl() {
    const q = new URL('https://www.kuaidi100.com/');
    q.searchParams.set('nu', numInput.value.trim());
    if (com !== 'auto') q.searchParams.set('com', com);
    return q.toString();
  }

  async function query() {
    const num = numInput.value.trim();
    if (!num) { toast('请先输入快递单号', 'warn'); return; }
    if (mode === 'jump') {
      window.open(jumpUrl(), '_blank', 'noopener');
      toast('已在官方查单页打开：' + num, 'ok');
      return;
    }
    const key = keyInput.value.trim();
    if (!key) { toast('本工具内查询需要快递100 API Key，可在「应用设置」补齐或改用跳官方页面', 'warn'); return; }
    localStorage.setItem(EXPRESS_KEY_STORE, key);
    const data = await api('/api/tools/express', { num, com, key });
    if (data.needKey) {
      window.open(data.url, '_blank', 'noopener');
      toast('未配置 Key，已跳转官方查单页', 'info');
      return;
    }
    out.replaceChildren(
      note(`物流状态：${data.stateText || data.message || '未知'}（${data.num} · ${data.comLabel}）`,
        data.state === '3' ? 'ok' : 'info'),
      stats([
        { label: '单号', value: data.num },
        { label: '快递', value: data.comLabel },
        { label: '状态', value: data.stateText || '未知' },
        { label: '轨迹条数', value: data.timeline.length },
      ]),
      el('div', { class: 'form-actions' },
        el('button', {
          class: 'mini',
          text: '打开官方查单页',
          onclick: () => window.open(data.url, '_blank', 'noopener'),
        })),
      table(
        [
          { key: 'time', label: '时间', width: '160px', render: (r) => el('span', { class: 'mono small', text: r.time }) },
          { key: 'context', label: '轨迹', render: (r) => r.context },
          { key: 'location', label: '地点', render: (r) => r.location || '' },
        ],
        data.timeline
      ),
      hint(data.hint || '')
    );
    toast('快递查询完成', 'ok');
  }

  const btn = button('一键查快递', () => action(btn, query));

  /* 绑定表单 */
  const bindNumInput = input({ placeholder: '例如 SF1423… 或 7800…' });
  let bindCom = 'auto';
  const bindComSelect = select(coms, bindCom, (v) => (bindCom = v));
  const bindLabelInput = input({ placeholder: '备注，如：我的 / 老婆的 / 爸爸的' });
  const addBindBtn = button('添加绑定', () => action(addBindBtn, async () => {
    const num = bindNumInput.value.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9-]{6,30}$/.test(num)) { toast('单号格式不正确（字母/数字/连字符，6~30 位）', 'warn'); return; }
    if (binds.some((b) => b.num === num)) { toast('该单号已绑定', 'warn'); return; }
    binds.push({ num, com: bindCom, label: bindLabelInput.value.trim() || num });
    saveBinds();
    bindNumInput.value = '';
    bindLabelInput.value = '';
    await refreshAll();
  }));

  let refreshAllBtn = null;

  /* 手机号：诚实说明 */
  const phoneInput = input({ placeholder: '输入手机号，看它为什么不能自动聚合' });
  const phoneBtn = button('绑定该手机号（说明）', () => action(phoneBtn, () => {
    const p = phoneInput.value.replace(/\s+/g, '');
    if (!/^1[3-9]\d{9}$/.test(p)) { toast('请输入 11 位大陆手机号', 'warn'); return; }
    toast('手机号“查全部快递”必须本人 OTP 归属核验（隐私授权），免费 API 不提供，工具无法自动聚合。请去官方，或把该号码名下的单号绑定到「我的快递」自动刷新。', 'info');
  }));

  // 已移除「我的快递」「手机号查快递」两张卡片，仅保留下方「查快递（临时输入单号）」。

  const tempCard = card('查快递（临时输入单号）', '不绑定也能查一次',
    field('快递单号', numInput, '支持顺丰 / 圆通 / 中通 / 申通 / 韵达 / 极兔 / 京东 / EMS / 邮政等'),
    field('快递公司', comSelect, '选「自动识别」会按单号前缀判断'),
    field('查单方式', modeSelect, '无 Key 跳官方页始终可用；要本工具内看轨迹需快递100 API Key'),
    field('快递100 API Key（可选）', keyInput, '申请地址 kuaidi100.com/openapi；填一次会记住'),
    el('div', { class: 'form-actions' }, btn),
    hint('轨迹由快递100 提供；「打开官方查单页」按钮始终可用，不看 Key。')
  );

  const left = stack(tempCard);

  return split(left, out);
}

/* ------------------------------------------------------------------ */

export async function render(root) {
  root.appendChild(note('所有计算都在本机完成，不会上传任何内容。', 'info'));
  root.appendChild(
    tabs([
      {
        label: '文件规范化',
        render: () => {
          const box = el('div', { style: { display: 'grid', gap: '16px' } });
          renderRename(box).catch((err) => box.appendChild(note('加载失败：' + (err.message || err), 'error')));
          return box;
        },
      },
      { label: '编码转换', render: encodingTab },
      { label: '哈希', render: hashTab },
      { label: 'JSON', render: jsonTab },
      { label: '时间戳', render: timeTab },
      { label: 'Cron', render: cronTab },
      { label: '生成器', render: generatorTab },
      { label: '文本处理', render: textTab },
      { label: '音乐转 MP3', render: musicTab },
      { label: '一键查快递', render: expressTab },
    ])
  );
}
