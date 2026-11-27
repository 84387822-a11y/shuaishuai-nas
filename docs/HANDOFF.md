# NAS助手 · 项目交接说明（给下一位 AI / 开发者）

> 本文件记录「NAS助手（shuaishuai-nas）」当前状态、已完成改动、关键机制与操作方法，便于换用其他 AI 继续修改。
> 最后更新：v1.0.1

---

## 1. 项目概况

| 项 | 内容 |
|---|---|
| 名称 | NAS助手（appname: `shuaishuai.nas`） |
| 定位 | 面向飞牛 fnOS 玩家的一体化**本地** Web 工具箱（Docker + `.fpk` 双形态） |
| 技术栈 | 后端：Node.js 内置模块（**零第三方依赖**）；前端：原生 ES Module（无框架、无构建） |
| 运行要求 | Node.js ≥ 18（fnOS 的 `nodejs_v22` 即可） |
| 默认端口 | 8620 |
| 当前版本 | **1.0.1**（版本唯一来源：`package.json`） |
| GitHub | `https://github.com/84387822-a11y/shuaishuai-nas`（公开，默认分支 `main`） |
| 许可 | MIT |

**本地项目路径**：`C:\Users\lenovo\Documents\deepseek-harness\default-workspace\shuaishuai-nas`

> 注意：本地目录**没有 `.git`**。GitHub 上的仓库是上一轮通过 GitHub REST API 直接创建的（见第 7 节）。

---

## 2. 目录结构

```
shuaishuai-nas/
├── server/
│   ├── index.js            # HTTP 服务、静态资源、鉴权、路由分发
│   ├── lib/
│   │   ├── util.js         # 路径沙箱、环境变量、命令执行、参数校验
│   │   ├── auth.js         # 可选访问密码（SS_PASSWORD / auth.env，热加载）
│   │   ├── logger.js
│   │   ├── parse.js / scan.js
│   │   ├── write-env.js    # 写 paths.env（授权目录）
│   │   └── set-password.js # 写 auth.env（访问密码）
│   └── routes/             # 自动加载：每个文件导出 [ ['GET', path, handler], ... ]
│       ├── index.js        # 路由注册表
│       ├── system.js       # /api/system、/api/roots（列表/新增/移除）、/api/settings
│       ├── monitor.js      # 监控 + 天气（/api/monitor/weather）
│       ├── network.js      # Ping / TCP / DNS / HTTP / 子网
│       ├── apps.js / rename.js / smart.js / tools.js / music.js / logs.js
├── web/
│   ├── index.html / login.html / styles.css / app.js / ui.js
│   └── modules/            # 每个页面一个模块，导出 render(root, ctx)
│       ├── apps.js rename.js network.js monitor.js smart.js tools.js
│       ├── settings.js     # 「设置」页（授权目录/访问模式）—— 本轮新增
│       └── about.js        # 关于/免责声明/日志/访问模式
├── fpk/                    # fnOS 应用包源
│   ├── manifest            # 版本、描述、图形入口等（打包时注入 version/checksum/platform）
│   ├── cmd/                # 生命周期脚本 main/install_callback/config_callback...
│   ├── config/ wizard/ ui/ # fnOS 权限、配置向导、入口配置
│   └── ICON*.PNG
├── scripts/
│   ├── build-fpk.mjs       # 零依赖 .fpk 打包器（自带 tar/gzip 写入）
│   ├── verify-fpk.mjs      # 产物结构/校验和校验
│   ├── release.mjs         # 一键发版：升版本→改 manifest→打包→校验
│   ├── check-all.mjs       # 后端语法 + 前端 ESM 语法 + JSON/manifest 检查
│   ├── selftest.mjs        # 端到端冒烟测试（起临时实例打真实接口）
│   └── make-icons.py
├── docs/
│   ├── cover.png           # 横版封面 1280×640（本轮生成）
│   ├── cover-vertical.png  # 竖版封面 1080×1920（本轮生成）
│   ├── screenshots/        # 界面截图
│   ├── fnos-packaging.md
│   └── upgrade.md
├── dist/                   # 打包产物（.gitignore 排除 *.fpk 与 stage/）
├── Dockerfile / docker-compose.yml / README.md / LICENSE
└── package.json
```

---

## 3. 本次会话完成的改动（按时间顺序）

1. **删除「测网速」功能**
   - 网络工具里移除测速标签页与后端测速路由；`web/modules/network.js`、`server/routes/network.js` 已不含测速代码，并重新打包验证。

2. **新增「设置」页（重点：文件路径/授权目录管理）**
   - 新增 `web/modules/settings.js`，并在 `web/app.js` 的 `MODULES` 与 `ICONS` 中注册（id: `settings`，名称「设置」）。
   - 功能：列出授权目录、应用内**新增**（手动输入 / 目录浏览点选）、**移除**、切换**全盘访问**、显示版本/数据目录/密码状态。
   - 后端改动：
     - `server/lib/util.js`：新增 `savedRoots()`、`removeRoot()` 并导出（只移除应用侧写入 `roots.json` 的目录）。
     - `server/routes/system.js`：新增 `GET /api/roots`（返回 `roots`、`saved`、`unrestricted`、`dataDir`）、`DELETE /api/roots` 与 `POST /api/roots/remove`。

3. **更新「关于」页介绍与免责声明**
   - `web/modules/about.js`：首行改为「完全本地运行、免费开源（MIT）」；功能表新增「设置」行；免责声明强调「完全免费、开源，仅个人/家庭自用，非商业产品、不担保、责任自负」。

4. **版本定为 1.0.0（发布前第一个版本）**
   - `package.json`、`fpk/manifest` 版本改为 `1.0.0`，changelog 改为首发说明；重新打包 x86/arm。

5. **修复天气「获取失败」**
   - 根因：国内网络访问 `api.open-meteo.com`（预报接口）TCP 443 超时；而 `geocoding-api.open-meteo.com`（城市转坐标）通常可通，导致「城市能保存、天气拉取失败」。
   - 修复：`server/routes/monitor.js` 增加**自动回退**——Open-Meteo 失败时改用 `wttr.in`（按经纬度），并做 WWO→WMO 码映射（中文描述 + 前端图标）。新增环境变量 `SS_WEATHER_PROVIDER=wttr` 可强制只用备用源。
   - README 环境变量表补充说明。

6. **发布到 GitHub**
   - 创建公开仓库并推送 74 个源文件；发布 `v1.0.0`，后发布 `v1.0.1`。
   - 安装包作为 **Release 附件**上传（不放进仓库，`.gitignore` 已排除 `dist/*.fpk`）。

6b. **桌面网关改造（v1.0.3，仿牛管家 CowButler）**
   - 目标：fnOS 桌面点开在系统窗口内嵌、不暴露 8620 端口。
   - `server/index.js`：支持 `SS_SOCKET`（unix socket）+ `SS_BASE`（网关前缀剥离，`/app/shuaishuai`）+ HTML 注入 `<base>`/`app-base` meta；保留 `SS_PORT` 作 Docker/直连后备。
   - `web/index.html`、`web/login.html`、`web/ui.js`：改为相对路径 / `resolveApp()` 基址解析。
   - `fpk/ui/config`：`type:iframe` + `gatewayPrefix:/app/shuaishuai` + `gatewaySocket:app.sock`。
   - `fpk/cmd/main`：网关模式绑 `${DATA_DIR}/app.sock`（`SS_SOCKET` 可覆盖），stop 清理 socket。
   - `fpk/manifest`：`os_min_version=1.2.1102`、`checkport=false`（保留 `service_port=8620` 以满足校验）。
   - `scripts/verify-fpk.mjs`：支持 `url+port` 与 `iframe+gatewaySocket` 两种入口校验。
   - 已验证：网关前缀模拟全通、check 48/48、e2e 20/20、x86+arm 打包校验通过。
   - **待真机确认**：fnOS 网关期望的 socket 路径（默认假设在 `${DATA_DIR}`）；若不对需按 fnOS 日志调整。

7. **发布封面**
   - `docs/cover.png`（1280×640，GitHub 社交预览）与 `docs/cover-vertical.png`（1080×1920 竖版）。
   - 生成脚本在工作区根目录（**不在仓库内**）：`make_cover.py`、`make_cover_vertical.py`。

---

## 4. 关键机制（改代码前务必知道）

1. **零第三方依赖**：后端只用 Node 内置模块；不要引入 npm 依赖，否则 Docker 镜像与 fpk 打包方式都要改。
2. **路由自动加载**：`server/routes/index.js` 会 `readdirSync` 加载 `routes/` 下所有 `.js`，每个文件必须导出 `[ [method, path, handler], ... ]` 数组。新增接口只要加文件即可。
3. **前端模块约定**：`web/modules/<id>.js` 导出 `async function render(root, ctx)`；在 `web/app.js` 的 `MODULES` 注册后即可通过 `#/<id>` 访问。
4. **路径沙箱**：所有用户路径必须经 `resolveUserPath()`（realpath + 必须落在授权目录内）。授权目录来源：
   - 环境变量 `SS_ROOTS`（fnOS 由 `paths.env` 热加载）；
   - 应用内追加的 `roots.json`（`DATA_DIR` 下）；
   - 全盘访问模式（`/api/settings`）关闭沙箱检查。
5. **鉴权**：设置 `SS_PASSWORD` 后所有 `/api/*` 需签名 Cookie；密码来自 `auth.env`（fnOS）或环境变量（Docker），**热加载**。
6. **数据目录**：`SS_DATA_DIR`（默认 `./var`；Docker 为 `/data`）。天气配置写在 `DATA_DIR/weather.json`，目录写在 `DATA_DIR/roots.json`。
7. **版本唯一来源**：`package.json`。`fpk/manifest` 的 `version` 由打包脚本注入；`release.mjs` 会同时改两处。
8. **fpk 打包零依赖**：`scripts/build-fpk.mjs` 自己实现 ustar/gzip，产物结构见 `docs/fnos-packaging.md`。

---

## 5. 常用命令（在项目根目录执行）

```bash
npm start                 # 本地起服务 http://127.0.0.1:8620
npm run check             # 后端语法 + 前端 ESM + JSON + manifest + 生命周期脚本检查
npm test                  # 端到端冒烟测试（临时实例，20 项断言）
npm run build:fpk         # 生成 x86 .fpk
node scripts/build-fpk.mjs --platform both   # 同时生成 x86 + arm
npm run verify:fpk -- dist/xxx.fpk           # 校验单个产物
npm run release -- --bump patch --changelog "修复 xxx"   # 升版本+打包+校验
```

> 前端是 ESM 但 `package.json` 没有 `"type": "module"`，所以 `check-all.mjs` 会先把前端文件复制成临时 `.mjs` 再 `node --check`。

---

## 6. 天气模块特别注意

- 配置：城市 → 先调 Open-Meteo 地理编码拿经纬度，存 `DATA_DIR/weather.json`；之后按经纬度取预报。
- 国内网络 `api.open-meteo.com` 常被阻断，因此有 `wttr.in` 回退：
  - URL：`https://wttr.in/<lat>,<lon>?format=j1`
  - 映射函数：`WWO_WMO`（`server/routes/monitor.js`），把 WWO 码转成前端 `weatherIcon()` 认识的 WMO 码。
- `SS_WEATHER_PROVIDER=wttr` 强制备用源（便于排查）。
- 缓存 10 分钟（`WEATHER_TTL`）；超时 12 秒（`WEATHER_TIMEOUT`）。

---

## 7. 发布到 GitHub 的方式与现状

- 当前 GitHub 仓库已有两个提交：`v1.0.0`（首发）与 `v1.0.1`（天气修复）；两个 Release 各带 x86/arm 安装包。
- 上一轮发布**不是用 git/gh**，而是在本机用 PowerShell 调 **GitHub REST API**（Git Data API 建 blob/tree/commit/ref + Releases API 传附件）完成——因为该环境里 `git`/`gh` 没有安装、`winget` 安装失败。
- 若要继续用 git：先安装 Git 与 GitHub CLI，`gh auth login` 后 `git clone` 仓库、正常提交推送即可。
- 若继续用 API 方式：需要具有 `repo` 权限的 GitHub Personal Access Token（PAT）。
- **安全提示**：上一轮使用过的 PAT 应尽快在 GitHub → Settings → Developer settings → Personal access tokens 里撤销（Revoke），换用新令牌。

---

## 8. 给下一位 AI 的建议工作流

1. 先读 `README.md` 与 `docs/fnos-packaging.md`，了解功能与打包。
2. 改完代码先跑 `npm run check` 与 `npm test`，两类都通过再打包。
3. 打包用 `npm run release -- --bump patch --changelog "..."`，它会自动升版本、生成 x86/arm、校验。
4. 若要发布到 GitHub：安装 `git`/`gh`（推荐）或使用 PAT 走 API；安装包作为 Release 附件上传，不要提交进仓库。
5. 保持「零第三方依赖」与「路径沙箱」两条底线，不要为图方便引入 npm 包或绕过 `resolveUserPath`。

---

## 9. 已知限制 / 可继续做的事

- 天气依赖第三方（Open-Meteo / wttr.in），国内网络可能都不稳；可考虑接入国内天气 API（需 key，如和风、高德）。
- SMART 仅 Linux 可用；Docker 需 `privileged` + `/dev` 挂载。
- 单用户模型，无多用户权限体系。
- 未配置 CI；可加 GitHub Actions 自动打包 Release。
- 封面脚本在仓库外，如需长期维护可移入 `scripts/` 并纳入版本控制。
