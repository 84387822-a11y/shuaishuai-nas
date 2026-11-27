# NAS助手 · 协作约定（多工具并行开发）

> 适用：本对话里的 AI 助手 与 **OpenCode** 同时维护同一个仓库时使用。
> 目标：两个 AI 都能改，但**绝不互相覆盖**、每次改动都经过校验。

---

## 1. 分工（文件归属，不要越界）

| 区域 | 归属建议 | 说明 |
|---|---|---|
| `server/`（后端 / 路由 / 接口） | 一个 AI 专用 | 改动会互相影响 API 形状，**同一时刻只允许一个改** |
| `web/`（前端 / 页面 / ui / styles） | 另一个 AI 专用 | 与后端解耦，可各自并行 |
| `fpk/` `scripts/` `Dockerfile` `package.json` | 谁改内容谁负责 | 改前先认领 |
| `README.md` `docs/` 封面 | 谁写文案谁负责 | 内容很少冲突 |
| `dist/`（打包产物） | 一律不要手改 | 由 `build-fpk.mjs` 生成，`.gitignore` 已排除 |

**硬规则**：两个人**不同时编辑同一个文件**。要动对方区域的文件前，先在 `TASKS.md` 里登记认领并等对方确认。

## 2. 每次改动前的流程

1. `git pull`（或 `git fetch origin && git rebase origin/main`）——拿最新。
2. 在当前 `TASKS.md` 登记「我要改哪个文件、做什么」。
3. 改代码 → 在**项目根目录**跑：
   ```bash
   npm run check   # 语法 + JSON + manifest + 生命周期脚本检查，必须 0 失败
   npm test        # 端到端冒烟测试，必须全过
   ```
   （两个工具都装好 Node.js ≥ 18，不要装 npm 依赖。）
4. 如果改了功能 / 界面：`node scripts/build-fpk.mjs --platform both` 重新打包并做一次真机/临时实例验证。
5. `git add` 只提交你认领的文件 → `git commit` → `git push`。

## 3. 分支约定（可选，更安全）

- 常态：直接在 `main` 上改（项目较小、单人工具，简单直接）。
- 若两个 AI 同一轮都要改：各自开分支 `ai-a/xxx`、`ai-b/xxx` → 各自推 → 合并回 `main`。
- 原则：**谁的后端或前端改动都先让 `npm run check && npm test` 通过再合。**

## 4. 别踩的坑（接手者必读）

- **零第三方依赖**：后端只用 Node 内置模块。不要 `npm install` 任何依赖——否则 Docker 镜像和 fpk 打包方式都要动。
- **路径沙箱**：所有用户路径必须走 `server/lib/util.js` 的 `resolveUserPath()`（realpath + 授权目录内校验）。不要为省事绕过，这是安全底线。
- **路由自动加载**：`server/routes/index.js` 会自动加载 `routes/` 里所有 `.js`，新增接口只需新增文件。
- **版本唯一来源**是 `package.json`；`fpk/manifest` 的 version 由打包注入。
- **安装包不进仓库**：`.fpk` 作为 GitHub Release 附件发布，不提交进 `dist/`。

## 5. 需要沟通的情况

- 要动对方的文件 / 要改 API 返回结构 / 要引入新的能力时，**先在对话里或 TASKS.md 里说明**，等对方确认再动手。
- 打包发版建议一次只由一个 AI 执行，避免两个 Release 撞车。

---

## 当前改动登记（临时）

| 文件 | 改动 | 负责方 | 状态 |
|---|---|---|---|
| `docs/HANDOFF.md` | 项目交接说明 | 助手 | 已写 |
| `docs/TASKS.md` | 本协作约定 | 助手 | 已写 |
| `docs/OPENCODE.md` | OpenCode 接入说明 | 助手 | 已写 |
| `docs/cover.png` / `docs/cover-vertical.png` | 发布封面 | 助手 | 已生成 |
