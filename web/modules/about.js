/**
 * 关于页：版本、能力边界、安全模型与免责声明。
 */

import {
  action, api, apiDownload, badge, button, bytes, card, codeBlock, el, grid,
  input, kv, list, note, stats, toast,
} from '../ui.js';

export async function render(root) {
  let sys = null;
  try {
    sys = await api('/api/system');
  } catch (err) {
    root.appendChild(note('无法读取系统信息：' + err.message, 'error'));
  }

  root.appendChild(
    note('NAS助手是一套完全本地运行、免费开源的独立工具箱（MIT 许可）：所有扫描、生成、重命名都发生在你自己的 NAS 上，不经过任何第三方服务器。', 'info')
  );

  if (sys) {
    root.appendChild(
      stats([
        { label: '版本', value: 'v' + sys.app.version },
        { label: '已运行', value: Math.floor(sys.runtime.uptime / 60) + ' 分' },
        { label: '授权目录', value: sys.roots.length },
        { label: '访问密码', value: sys.authEnabled ? '已启用' : '未启用' },
      ])
    );
  }

  const moduleRows = [
    { name: '应用中心', desc: '常用自托管应用目录、一键部署 Docker Compose、版本检测', write: '部署容器' },
    { name: '文件规范化', desc: '批量重命名预览、执行、撤销与脚本导出', write: '重命名文件' },
    { name: '网络工具', desc: 'Ping、端口探测、DNS、HTTP、子网计算', write: '不写入' },
    { name: '监控仪表盘', desc: 'CPU/内存/网络/磁盘 IO 实时监控、磁盘信息与 SMART 摘要', write: '不写入' },
    { name: '硬盘 SMART', desc: '磁盘健康、温度、通电时间、挂载容量', write: '不写入' },
    { name: '桌面壁纸', desc: '挑选壁纸素材并生成切换脚本（由用户自行 sudo 执行）', write: '生成脚本' },
    { name: '小工具', desc: '编码、哈希、JSON、时间戳、Cron、密码、文本处理', write: '不写入' },
    { name: '设置', desc: '授权目录（文件路径）新增/移除、访问模式与偏好', write: '写配置' },
    { name: '音乐转 MP3', desc: '把授权的音乐文件转码为 MP3（输出到 mp3/ 子目录）', write: '转码写盘' },
  ];

  root.appendChild(
    card('功能与写入边界', '哪些操作会真的改动磁盘，一眼看清',
      el('div', { class: 'table-wrap' },
        el('table', { class: 'table' },
          el('thead', {}, el('tr', {}, el('th', { text: '模块' }), el('th', { text: '能力' }), el('th', { text: '是否写盘' }))),
          el('tbody', {}, ...moduleRows.map((m) =>
            el('tr', {},
              el('td', { text: m.name }),
              el('td', { text: m.desc }),
              el('td', {}, m.write === '不写入'
                ? badge('只读', 'ok')
                : badge(m.write, 'warn'))
            )
          ))
        ))
    )
  );

  root.appendChild(
    grid(
      card('安全模型', '为什么可以放心跑在 NAS 上',
        list([
          '路径沙箱：所有路径先 realpath，再校验是否位于 SS_ROOTS / 授权目录内，符号链接逃逸同样会被拒绝。',
          '命令执行：只调用 ping / smartctl / df 等固定程序，参数用数组传递，不经过 shell 拼接。',
          '无第三方依赖：整个应用只用 Node 内置模块，不存在供应链投毒风险。',
          '可选登录：设置 SS_PASSWORD 后所有接口需要签名 Cookie，登录失败有节流。',
          '默认非 root：Docker 镜像以 node 用户运行，SMART 需要时才单独提权。',
          '可撤销：批量重命名会写入撤销日志，支持一键回退。',
        ], { class: 'list-check' })
      ),
      card('运行环境', '当前实例信息',
        sys ? kv({
          '应用版本': sys.app.version,
          '应用标识': sys.app.appname,
          'Node': sys.runtime.node,
          '平台': `${sys.runtime.platform} / ${sys.runtime.arch}`,
          '主机名': sys.host.hostname,
          '时区': sys.host.timezone,
          '数据目录': sys.dataDir,
          '授权目录': sys.roots.map((r) => `${r.path}${r.exists ? '' : '（不存在）'}`).join('\n'),
        }) : el('div', { class: 'muted', text: '读取失败' })
      )
    )
  );

  root.appendChild(
    card('升级与备份', '以后更新不用重装，数据也不会丢',
      sys ? kv({
        '数据目录': sys.dataDir,
        '访问密码文件': 'fnOS：etc/auth.env；Docker：环境变量 SS_PASSWORD',
        '升级方式': '用新 .fpk 覆盖安装 / docker compose up -d',
      }) : null,
      list([
        'fnOS：应用中心 → 手动安装新 .fpk，系统走升级流程，var/ 与授权目录原样保留。',
        'Docker：docker compose build && docker compose up -d，/data 卷不受影响。',
        '发版：npm run release -- --bump patch --changelog "修复 xxx"，自动升版本、打包、校验。',
        '回滚：保留上一版 .fpk 或旧镜像 tag，随时切回。',
        '卸载时默认保留数据；只有向导里选择「删除所有应用数据」才会清理。',
      ], { class: 'list-check' }),
      codeBlock('tar czf shuaishuai-data-$(date +%F).tgz ./data', { filename: 'backup-data.sh', title: '备份数据目录' })
    )
  );

  root.appendChild(
    card('授权目录怎么配', 'Docker 与 FPK 两种方式',
      el('div', { class: 'grid' },
        el('div', {},
          el('h4', { text: 'Docker' }),
          codeBlock(
            `docker run -d --name shuaishuai-nas \\\n  -p 8620:8620 \\\n  -e SS_PASSWORD="your-password" \\\n  -e SS_ROOTS="/vol1/media:/vol2/media" \\\n  -v /vol1/media:/vol1/media:ro \\\n  -v ./data:/data \\\n  tongtongshuaishuai/nas-helper:latest`,
            { title: 'docker run' }
          )),
        el('div', {},
          el('h4', { text: 'fnOS FPK' }),
          list([
            '安装后在「应用设置 → 授权目录」添加媒体目录。',
            '授权变更会自动重启应用并重新读取路径。',
            '未授权的目录会直接返回 403，不会降级放行。',
          ]))
      )
    )
  );

  const DISCLAIMER = [
    ['项目性质', '本项目是完全免费的独立第三方社区开源工具（MIT 许可），与飞牛 fnOS 官方以及应用内以 Docker 部署的第三方软件均无隶属、合作或背书关系，也不构成任何商业产品或服务承诺。文中出现的名称、商标与标识归各自权利人所有，仅用于说明兼容对象与技术来源。'],
    ['软件许可', '项目代码依 MIT 许可提供。复制、修改和分发时须保留版权及许可声明；第三方依赖（如 ffmpeg、Docker 镜像、外部天气服务）遵循各自许可。本声明不改变也不缩减 MIT 已授予的软件许可，亦不额外授予任何内容或服务权益。'],
    ['内容版权', '本项目不托管、不分发任何影视、音乐或图片资源，也不内置、不下载、不提供音源或片源。文件扫描、重命名、音乐转码、壁纸脚本仅作用于你授权目录中你自己拥有或有权处理的文件。软件开源不代表这些内容可被自由下载、传播或商用。'],
    ['合法使用', '请仅访问、播放、整理或转码你有权使用的内容，并遵守适用法律、平台协议与账号授权范围。本项目不提供会员、付费内容或 DRM 的绕过服务；技术研究与个人使用不当然构成版权授权。'],
    ['第三方服务与网络', '天气等功能会向外部服务（如 Open-Meteo）发起请求；Docker 部署与镜像拉取依赖第三方仓库。第三方服务的可用性、准确性与隐私政策由对应提供方负责，本工具不保证其持续可用或结果准确，相关费用与风险请自行评估。'],
    ['脚本与执行安全', '应用会生成重命名、切换壁纸、Docker Compose 等脚本（如 rename-media.sh、set-wallpaper.sh、docker-compose.yml）。这些是可执行代码，可能发起网络请求或改动运行环境；请审查来源与权限后再执行，不要导入不可信脚本。切换壁纸脚本需由你手动用 sudo 执行，应用本身不直接改系统。'],
    ['隐私与告知', '访问密码、授权目录、天气城市、日志等可能包含敏感信息，请妥善保管配置、备份与导出文件。日志会记录 API 访问信息（方法、路径、状态码）用于排错；脱敏不能替代人工检查，请勿将管理端口直接暴露到公网。'],
    ['数据与维护风险', '重命名、音乐转码、文件整理、Docker 部署与升级可能占用资源、移动或改写文件，并可能影响官方应用中的歌单、收藏等关联。执行前请核对路径并独立备份重要数据；撤销机制与备份不能替代完整备份，也不保证恢复全部数据或业务关联。'],
    ['无担保与责任限制', '软件按 MIT 许可「原样」提供，不作任何明示或暗示担保，包括适销性、特定用途适用性、不侵权与持续可用性。在适用法律允许的最大范围内，作者与版权持有人不对因使用或无法使用本软件造成的任何索赔、损害或其它责任负责；依法不得排除或限制的责任不受影响。'],
    ['权利与安全反馈', '如认为代码、文档或界面展示内容涉及权利问题，请通过 Issues 提供可核验的权利及具体内容信息，维护者将核实处理。发现安全漏洞或密钥泄露等敏感问题，请遵循安全反馈指引，不要公开提交秘密或个人信息。'],
  ];

  root.appendChild(
    card('免责声明', '使用前请务必阅读以下条目',
      note('本项目完全免费、开源（MIT），仅作为个人与家庭自用的本地工具箱发布，不是商业产品，也不提供任何技术支持、使用担保或服务承诺。使用与执行均由你自主决定、风险自负；请只管理你合法拥有的文件，批量操作前自行备份。', 'warn'),
      el('div', { class: 'disclaimer' },
        ...DISCLAIMER.map(([title, text]) =>
          el('p', { class: 'disclaimer-item' },
            el('b', { text: title + '：' }),
            text)))
    )
  );

  /* ---------------- 运行日志 ---------------- */
  const logsState = { files: [], selected: null };
  const logsHost = el('div');
  const saveDirInput = input({
    value: sys && sys.roots[0] ? sys.roots[0].path : '',
    placeholder: '/vol1/...（授权目录内）',
  });

  function paintLogs() {
    const listBox = el('div', { class: 'log-list' });
    if (!logsState.files.length) {
      listBox.appendChild(el('div', { class: 'empty', text: '暂无日志文件。应用运行后会自动写入 server.log。' }));
    }
    for (const f of logsState.files) {
      listBox.appendChild(el('div', {
        class: 'log-row' + (logsState.selected === f.name ? ' active' : ''),
        onclick: () => { logsState.selected = f.name; paintLogs(); },
      },
        el('span', { class: 'log-dot' }),
        el('span', { class: 'log-name', text: f.name }),
        el('span', { class: 'log-size', text: bytes(f.size) })));
    }

    const downloadBtn = button('下载到本机', () => action(downloadBtn, async () => {
      if (!logsState.selected) { toast('请先选择一个日志文件', 'warn'); return; }
      await apiDownload('/api/logs/download', { name: logsState.selected }, logsState.selected);
      toast('已开始下载', 'ok');
    }), { variant: 'ghost' });

    const saveBtn = button('保存到 NAS', () => action(saveBtn, async () => {
      if (!logsState.selected) { toast('请先选择一个日志文件', 'warn'); return; }
      const dir = saveDirInput.value.trim();
      if (!dir) { toast('请填写保存目录（授权目录内）', 'warn'); return; }
      const res = await api('/api/logs/save', { name: logsState.selected, dir });
      toast('已保存到：' + res.saved, 'ok');
    }));

    const refreshBtn = button('刷新', () => action(refreshBtn, loadLogs), { variant: 'ghost' });

    logsHost.replaceChildren(card('运行日志', '应用运行日志，可下载到本机或另存到 NAS 授权目录',
      el('p', { class: 'hint', text: '日志位于数据目录：' + (sys ? sys.dataDir : '—') + '，记录 API 访问与错误，便于排错。' }),
      listBox,
      el('label', { class: 'field' },
        el('span', { class: 'field-label', text: '保存目录（授权目录内）' }),
        saveDirInput,
        el('span', { class: 'field-hint', text: '填写 NAS 上已授权的文件夹，日志会复制进去；同名文件会自动加时间戳，不覆盖。' })),
      el('div', { class: 'form-actions' }, downloadBtn, saveBtn, refreshBtn)));
  }

  async function loadLogs() {
    try {
      const data = await api('/api/logs');
      logsState.files = data.files || [];
      if (!logsState.selected || !logsState.files.some((f) => f.name === logsState.selected)) {
        logsState.selected = logsState.files[0] ? logsState.files[0].name : null;
      }
      paintLogs();
    } catch (err) {
      logsHost.replaceChildren(card('运行日志', '', note('读取日志列表失败：' + err.message, 'error')));
    }
  }

  /* ---------------- 访问模式 ---------------- */
  const curUnrestricted = Boolean(sys && sys.unrestricted);
  const modeBtn = button(
    curUnrestricted ? '关闭全盘访问' : '开启全盘访问（不逐目录授权）',
    () => action(modeBtn, async () => {
      try {
        const res = await api('/api/settings', { unrestricted: !curUnrestricted });
        toast(res.hint || '已切换访问模式', 'ok');
        setTimeout(() => location.reload(), 700);
      } catch (err) {
        toast(err.message, 'error');
      }
    }),
    { variant: curUnrestricted ? 'ghost' : 'primary' }
  );

  root.appendChild(
    card('访问模式', '默认只访问你授权的目录；可切换为全盘访问',
      note(curUnrestricted
        ? '当前为「全盘访问」：应用不再要求逐目录授权，但仍受 fnOS 系统读权限约束（系统不给读权限时依然会报无权限）。'
        : '当前为「授权目录」模式：只能访问授权目录。关闭状态下可以点上方横幅逐个目录点选授权。',
        curUnrestricted ? 'warn' : 'info'),
      el('div', { class: 'row', style: { marginTop: '10px' } },
        modeBtn,
        el('span', { class: 'hint', text: '开启前请确认已设置访问密码，避免把可读文件暴露给局域网。' })))
  );

  root.appendChild(logsHost);

  root.appendChild(
    card('开源与反馈', '',
      list([
        '技术栈：Node.js 内置模块 + 原生 Web Components（无框架、无构建步骤）。',
        '打包：Docker 单镜像；fnOS .fpk 由 scripts/build-fpk.mjs 零依赖生成。',
        '如果你要二次开发，直接改 web/ 与 server/ 即可，npm start 就能跑。',
      ])
    )
  );

  await loadLogs();
}
