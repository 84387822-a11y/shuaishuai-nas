/**
 * 桌面壁纸：从授权目录挑选壁纸（静态图片或动态视频），本机预览，
 * 并生成「一键切换壁纸」脚本，由用户在 SSH 里用 sudo 执行。
 *
 * 不做危险动作：不直接改系统、不下载、不改系统配置；只生成脚本。
 * fnOS 桌面壁纸的系统路径未公开，脚本需要你确认目标路径后再执行。
 */

import {
  action, api, apiDownload, button, bytes, card, checkbox, codeBlock, el,
  field, hint, input, list, note, select, split, stats, table, toast,
} from '../ui.js';

const WALLPAPER_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.mp4', '.webm'];

function clipText(text, max) {
  const s = String(text === null || text === undefined ? '' : text);
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function extLabel(ext) {
  if (ext === '.mp4' || ext === '.webm') return '动态（视频）';
  return '静态图片';
}

function previewUrl(item) {
  return '/api/wallpaper/preview?path=' + encodeURIComponent(item.from);
}

function previewNode(item) {
  const holder = el('div', { style: { display: 'grid', gap: '10px' } });
  const url = previewUrl(item);

  function fail(kind) {
    holder.replaceChildren(
      note(kind + '无法加载，请点下方「查看失败原因」。', 'error'));
  }

  async function diagnose(btn) {
    holder.replaceChildren(spinner('正在检查预览…'));
    try {
      const res = await fetch(url);
      let msg = '服务返回 HTTP ' + res.status;
      try {
        const data = await res.json();
        if (data && data.error) msg = data.error + (data.detail ? '：' + data.detail : '');
      } catch {
        // 成功时返回的是图片/视频二进制，JSON 解析不到属正常
        if (res.ok) msg = '连接正常（HTTP ' + res.status + '），可能是播放器/浏览器不支持该编码。';
      }
      holder.replaceChildren(note('预览失败：' + msg, 'error'));
    } catch (err) {
      holder.replaceChildren(note('预览失败：' + (err.message || err), 'error'));
    }
  }

  const media = item.dynamic
    ? el('video', {
        src: url, controls: true, autoplay: true, muted: true, loop: true,
        style: { maxWidth: '100%', maxHeight: '360px', borderRadius: '8px', objectFit: 'contain' },
      })
    : el('img', {
        src: url,
        style: { maxWidth: '100%', maxHeight: '360px', objectFit: 'contain', borderRadius: '8px' },
      });

  media.addEventListener('error', () => fail(item.dynamic ? '视频' : '图片'));
  holder.appendChild(media);

  // 预览失败时点「查看原因」会去服务器拿到真实的 HTTP 错误，而非空白裂图
  const diagBtn = button('查看失败原因', () => action(diagBtn, () => diagnose()));
  holder.appendChild(el('div', { class: 'form-actions' }, diagBtn));
  return holder;
}

export async function render(root) {
  const dirInput = input({ placeholder: '/vol1/media/壁纸' });
  const limitInput = input({ type: 'number', value: '500', min: 1, max: 8000, step: 1 });
  let recursive = true;
  let last = null;
  let chosen = null; // 当前选中的壁纸条目
  let flash = null;

  const out = el(
    'div',
    { class: 'result-area', style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
    note('扫描目录后点选一个壁纸文件，右侧预览。')
  );

  async function persistConfig(extra) {
    try {
      await api('/api/wallpaper/config', {
        dir: dirInput.value.trim(),
        target: targetInput.value.trim(),
        format,
        ...(extra || {}),
      });
    } catch {
      /* 配置保存失败不影响本次使用 */
    }
  }

  async function scan() {
    const data = await api('/api/wallpaper/scan', {
      dir: dirInput.value.trim(),
      recursive,
      limit: Number(limitInput.value) || 500,
    });
    last = data;
    chosen = null;
    persistConfig(); // 记住目录，下次打开自动回填
    renderResult();
    return data;
  }

  function selectCell(item) {
    const radio = el('input', { type: 'radio', name: 'ss-wallpaper', class: 'checkbox', value: item.from });
    if (chosen && chosen.from === item.from) radio.checked = true;
    radio.addEventListener('change', () => {
      chosen = item;
      renderResult();
    });
    return radio;
  }

  function renderPreview() {
    const panel = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
    if (!chosen) {
      panel.appendChild(note('未选择壁纸。请在表格里点选一个文件查看预览。', 'info'));
      return panel;
    }
    if (!chosen.previewable) {
      panel.appendChild(note('该文件扩展名不支持网页预览，请直接生成脚本使用。', 'warn'));
      return panel;
    }
    panel.appendChild(
      card('预览', `${chosen.name}（${extLabel(chosen.ext)}）`,
        previewNode(chosen),
        stats([
          { label: '大小', value: bytes(chosen.size) },
          { label: '类型', value: extLabel(chosen.ext) },
        ]))
    );
    return panel;
  }

  function renderResult() {
    if (!last) {
      out.replaceChildren(note(flash ? flash.text : '扫描目录后点选一个壁纸文件。', flash ? flash.kind : 'info'));
      return;
    }

    const blocks = [
      stats([
        { label: '壁纸素材', value: last.total },
        { label: '动态（视频）', value: last.items.filter((i) => i.dynamic).length },
        { label: '静态图片', value: last.items.filter((i) => !i.dynamic).length },
      ]),
      last.truncated ? note('已达数量上限，建议缩小目录范围后重新扫描。', 'warn') : null,
      flash ? note(flash.text, flash.kind) : null,
      last.total === 0 ? note('该目录没有壁纸素材（支持 jpg / png / webp / bmp / mp4 / webm）。', 'info') : null,
      card(
        '壁纸素材',
        '点选一个文件用于生成切换脚本',
        el('div', { class: 'mono small muted', style: { wordBreak: 'break-all', marginBottom: '10px' } },
          '目录：' + last.dir),
        table(
          [
            { label: '选择', width: '56px', render: selectCell },
            { label: '文件', render: (item) => el('span', { class: 'mono small', text: clipText(item.rel, 40), title: item.from }) },
            { label: '类型', width: '110px', render: (item) => (item.dynamic ? '动态视频' : '图片') },
            { label: '大小', width: '90px', render: (item) => (Number.isFinite(item.size) ? bytes(item.size) : '-') },
            { label: '操作', width: '150px', render: (item) =>
                el('div', { class: 'row', style: { gap: '6px' } },
                  el('button', {
                    class: 'mini',
                    text: '预览',
                    onclick: () => {
                      chosen = item;
                      renderResult();
                    },
                  }),
                  el('button', {
                    class: 'mini',
                    text: '一键',
                    title: '直接生成并下载切换壁纸脚本（会记住目标路径）',
                    onclick: function () { action(this, () => generateFor(item)); },
                  })) },
          ],
          last.items,
          { empty: '没有壁纸素材' }
        )
      ),
    ];

    out.replaceChildren(...blocks.filter(Boolean));
  }

  const scanBtn = button('扫描并预览', () => action(scanBtn, async () => {
    flash = null;
    const data = await scan();
    toast(data.items.length ? `扫描到 ${data.items.length} 个壁纸素材` : '该目录没有壁纸素材', data.items.length ? 'info' : 'ok');
  }));

  const left = card(
    '扫描参数',
    '挑选壁纸素材并预览',
    field('目录', dirInput, '例如 /vol1/media/壁纸；相对路径按第一个授权目录解析'),
    el('div', { class: 'row', style: { marginBottom: '12px' } },
      checkbox('递归子目录', recursive, (v) => (recursive = v))),
    field('数量上限', limitInput, '1 ~ 8000，默认 500'),
    el('div', { class: 'form-actions' }, scanBtn),
    hint('支持 jpg / png / webp / bmp 静态壁纸，以及 mp4 / webm 动态（视频）壁纸。')
  );

  // 右侧：预览 + 生成脚本
  const targetInput = input({ placeholder: '例如 /usr/.../wallpaper.jpg（先用 SSH 确认）' });
  let format = 'bash';
  const formatSelect = select([
    ['bash', 'Bash（Linux / fnOS）'],
    ['powershell', 'PowerShell'],
  ], format, (v) => (format = v));

  const scriptOut = el('div');

  /** 一键：目标路径已填就记住并直接生成下载。 */
  async function generateFor(item) {
    const target = targetInput.value.trim();
    if (!target) {
      toast('先填「目标系统路径」；SSH 里确认一次后会自动记住，下次免填', 'warn');
      return;
    }
    chosen = item;
    await persistConfig();
    const fallback = 'set-wallpaper.sh';
    await apiDownload('/api/wallpaper/script', {
      items: [{ from: item.from }],
      target,
      format,
    }, fallback);
    flash = { text: '已生成并下载「' + item.name + '」的切换脚本。到 SSH 用 sudo 执行前，请再核对 TARGET 路径。', kind: 'ok' };
    toast('已生成并下载：' + item.name, 'ok');
  }

  const scriptBtn = button('生成切换壁纸脚本', () => action(scriptBtn, async () => {
    if (!chosen) {
      toast('请先选择一个壁纸文件', 'warn');
      return;
    }
    if (!targetInput.value.trim()) {
      toast('先填「目标系统路径」（SSH 确认一次后会自动记住）', 'warn');
      return;
    }
    await persistConfig();
    const fallback = 'set-wallpaper.sh';
    await apiDownload('/api/wallpaper/script', {
      items: [{ from: chosen.from }],
      target: targetInput.value.trim(),
      format,
    }, fallback);
    flash = { text: '脚本已生成并下载。拷贝到 SSH 执行前，请先确认 TARGET 路径正确。', kind: 'ok' };
    toast('切换壁纸脚本已生成并下载', 'ok');
  }));

  const right = card(
    '预览与生成脚本',
    '先预览确认效果，再生成 SSH 执行脚本',
    renderPreview(),
    field('目标系统路径（TARGET）', targetInput, 'fnOS 的桌面壁纸系统路径未公开，需先用 SSH 确认后填入'),
    field('脚本类型', formatSelect),
    el('div', { class: 'form-actions' }, scriptBtn),
    scriptOut,
    hint('脚本只做「备份原壁纸 + sudo 复制新壁纸到目标路径」，不下载、不改系统配置。')
  );

  const bottom = card(
    '安全说明',
    '本工具不直接改系统壁纸',
    list([
      'fnOS 桌面壁纸的系统路径没有公开文档；官方方式是在「桌面 → 设置 → 壁纸」中上传。',
      '本工具只生成脚本，真正的切换由你在 SSH 里用 sudo 执行，避免应用越权改系统。',
      '生成的脚本会用 sudo 备份原壁纸（同名 .bak）后再复制新壁纸，出错可恢复。',
      '先用 sudo find / -iname "*wallpaper*" 找到你这台 fnOS 的实际路径，再填到脚本顶部 TARGET。',
    ], { class: 'list-check' })
  );

  // 打开页面时回填上次记住的目录 / 目标路径 / 脚本格式，省去重复输入
  try {
    const cfg = await api('/api/wallpaper/config');
    if (cfg && cfg.dir) dirInput.value = cfg.dir;
    if (cfg && cfg.target) targetInput.value = cfg.target;
    if (cfg && cfg.format) {
      format = cfg.format;
      formatSelect.value = cfg.format;
    }
  } catch {
    /* 首次使用无配置，忽略 */
  }

  root.appendChild(
    note('从授权目录挑选壁纸并生成「一键切换」脚本，由你在 SSH 里用 sudo 执行——本工具不改系统文件。', 'warn')
  );
  root.appendChild(split(left, out));
  root.appendChild(split(right, el('div')));
  root.appendChild(bottom);
}
