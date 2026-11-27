# AGENTS.md —— 给 AI 助手的项目规则（OpenCode 自动读取）

**NAS助手**（`shuaishuai-nas`）：面向飞牛 fnOS 的本地 Web 工具箱。后端 Node.js 内置模块，前端原生 ES Module，**零第三方依赖、无框架、无构建**。当前版本 **1.7.0**，仓库 `github.com/84387822-a11y/shuaishuai-nas`。

参考全文：`docs/HANDOFF.md`（项目全貌）、`docs/OPENCODE.md`（接入）、`docs/TASKS.md`（协作分工）。

## 先读
- `web/app.js` 定义导航模块；`web/modules/<id>.js` 导出 `render(root)`，注册后 `#/<id>` 访问。
- `server/routes/index.js` 自动加载 `routes/` 全部 `.js`，新增接口=新增路由文件。
- `README.md` 有环境变量与安全模型；`docs/fnos-packaging.md` 有 fpk 打包细节。

## 本仓库硬规则
1. **不要 `npm install` / 不要加第三方依赖**——保持零依赖（镜像与 fpk 都依赖这一点）。
2. **路径必须走 `server/lib/util.js` 的 `resolveUserPath()`**（realpath + 授权目录校验），不要绕过沙箱。
3. **不要手改 `dist/`**（打包产物，由 `build-fpk.mjs` 生成；`.gitignore` 已排除）。
4. **安装包 `.fpk` 不进仓库**，作为 GitHub Release 附件发布。
5. **版本唯一来源 `package.json`**；`fpk/manifest` 的 version 由打包注入。
6. **JSON 用 UTF-8 无 BOM** 写，否则读取函数（如天气配置）会失败。
7. **桌面网关模式（v1.0.4）**：fnOS 下走 unix socket（默认 `${TRIM_APPDEST}/app.sock`，与牛管家一致，`SS_SOCKET` 可覆盖）+ 网关前缀 `SS_BASE=/app/shuaishuai`，不再暴露 8620 端口；桌面打开为系统窗口内嵌。Docker / `npm start` 直连仍走 `SS_PORT`。`fpk/ui/config` 是 `type:iframe+gatewaySocket`，`fpk/manifest` 为 `os_min_version=1.2.1102`、`checkport=false`。**注意**：socket 建在应用 target 目录，若 app 用户（`shuaishuainas`）对该目录无写权限，会因权限失败而网关 Not Found——真机若见权限错误，需把 `run-as` 改为 `root`（牛管家即如此）并相应放开 verify 对 root 的检查。
8. 遵守 `docs/TASKS.md` 分工：**别和另一位 AI 同时改同一个文件**（当前分工：一人管 `server/`、一人管 `web/`）。

## 硬规则（重点）
- **每次改代码 / 功能，都要同步升级版本号，并重新生成安装包。** 不允许“改了代码但不升版本/不打安装包”。
- **测试阶段只构建、只交付 x86 安装包**（`node scripts/build-fpk.mjs` 默认即 x86）；**正式发版时**才追加 arm（`--platform both`）。
- **交付前必须自己先跑通**：`npm run check` + `npm test`（`scripts/selftest.mjs`）全绿才打包；不要把用户当第一轮测试。
- 涉及 fnOS 真机才有的行为（真实 `appcenter-cli`、应用包布局、网关路由），本地无法完全模拟：**一次攒成一批改动再交付**，并在交付说明里写清「哪些需要真机确认」。
- 「应用市场」（聚合第三方 fpk 源、命令行安装）已按用户要求删除，只保留「应用中心」；不要擅自加回。
- 是否**推送到 GitHub**：默认**先问用户**，确认后才推。不要擅自创建 Release/上传安装包。

## 标准流程
```bash
npm run check   # 后端语法 + 前端 ESM + JSON + manifest + 生命周期脚本，必须 0 失败
npm test        # 端到端冒烟测试，必须全过
# 升版本 + 打包（测试阶段只打 x86）：
npm run release -- --bump patch --changelog "本次改动说明"
```
`release` 默认会升 `package.json` 版本 → 更新 `fpk/manifest` 的 version/changelog → 打包 x86（+ arm，可选）→ 校验。产物在 `dist/shuaishuai_<版本>_<arch>.fpk`。
**测试阶段只把 `dist/shuaishuai_<版本>_x86.fpk` 交给用户**；**推 GitHub 前先问用户**。

## 已知可做的（认领前先对照 TASKS.md）
- 天气接国内 API（和风/高德，需 key）作第三备用源。
- 加 GitHub Actions 自动打包。
- 把封面脚本移入仓库。
