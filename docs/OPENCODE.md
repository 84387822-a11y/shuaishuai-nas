# 用 OpenCode 更新 NAS助手（接入说明）

> 本文件是给「OpenCode」这个 AI 编程工具看的快速上手说明。
> 配合 `docs/HANDOFF.md`（项目背景）与 `docs/TASKS.md`（协作约定）一起读。

---

## 1. 认项目

- 名称：**NAS助手**（`shuaishuai-nas`），面向飞牛 fnOS 的本地 Web 工具箱。
- 技术栈：后端 Node.js 内置模块（**零第三方依赖**）；前端原生 ES Module（无框架、无构建）。
- 仓库：`https://github.com/84387822-a11y/shuaishuai-nas`（公开，默认分支 `main`）。
- 当前版本：**1.0.1**；本地目录：`C:\Users\lenovo\Documents\deepseek-harness\default-workspace\shuaishuai-nas`。

## 2. 先读懂结构

- `server/routes/index.js` 自动加载 `routes/` 里的所有路由文件。
- `web/modules/<id>.js` 导出 `render(root)`，在 `web/app.js` 的 `MODULES` 注册后由 `#/<id>` 进入页面。
- 发版流程、环境变量、安全模型见 `README.md` 与 `docs/HANDOFF.md`。

## 3. 本地跑起来（不要 `npm install`）

需要 Node.js ≥ 18。直接在项目根目录：

```bash
npm start          # 打开 http://127.0.0.1:8620
npm run check      # 语法 + JSON + manifest 检查（前端 ESM 会临时复制成 .mjs 检查）
npm test           # 端到端冒烟测试（临时实例，20 项断言）
npm run build:fpk  # 打包 x86
node scripts/build-fpk.mjs --platform both   # x86 + arm 一起打包
```

## 4. Git 协作（重要）

- 你的工作目录需要是 git 仓库并关联到 GitHub。两种做法：
  - **方式 1（推荐）**：安装 Git 与 GitHub CLI → `gh auth login` → `git clone https://github.com/84387822-a11y/shuaishuai-nas`，在克隆目录里改。
  - 方式 2：在现有目录里 `git init`，然后 `git remote add origin https://github.com/84387822-a11y/shuaishuai-nas.git`，`git fetch && git rebase origin/main`。
- 每次改完：`git add`（只加你负责的文件）→ `git commit` → `git push`。
- **遵守 `docs/TASKS.md` 分工**：不要和另一位 AI 同时改同一个文件；不要手改 `dist/`。
- 安装包 `.fpk` 不进仓库，作为 **GitHub Release 附件**发布。

## 5. 发版（一次只让一个 AI 做）

```
npm run release -- --bump patch --changelog "说明本次改动"
```
它自动：升 `package.json` 版本 → 更新 `fpk/manifest` changelog → 打包 x86/arm → 校验。
然后把 `dist/shuaishuai.nas_<版本>_<arch>.fpk` 上传到 GitHub Release（网页拖拽或 `gh release create ...`）。

## 6. 保持底线

- **不引入第三方依赖**（保持零依赖，别 `npm install`）。
- **路径必须走 `resolveUserPath()`**（沙箱），不要绕过。
- JSON 文件写 UTF-8（无 BOM），否则 `loadWeatherConfig` 等读取会失败。
- 改完先 `npm run check && npm test` 全过再提交。

## 7. 想做的但还没做的（可认领）

- 天气接入国内 API（和风/高德，需要 key）作为第三备用源。
- 加 GitHub Actions 自动打包 Release。
- 把封面脚本 `make_cover*.py` 移入仓库并纳入版本控制。
