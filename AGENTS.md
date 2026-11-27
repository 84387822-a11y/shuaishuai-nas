# AGENTS.md —— 给 AI 助手的项目规则（OpenCode 自动读取）

**NAS助手**（`shuaishuai-nas`）：面向飞牛 fnOS 的本地 Web 工具箱。后端 Node.js 内置模块，前端原生 ES Module，**零第三方依赖、无框架、无构建**。版本 **1.0.1**，仓库 `github.com/84387822-a11y/shuaishuai-nas`。

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
7. 遵守 `docs/TASKS.md` 分工：**别和另一位 AI 同时改同一个文件**（当前分工：一人管 `server/`、一人管 `web/`）。

## 标准流程
```bash
npm run check   # 后端语法 + 前端 ESM + JSON + manifest + 生命周期脚本，必须 0 失败
npm test        # 端到端冒烟测试，必须全过
node scripts/build-fpk.mjs --platform both   # 改了功能才需要：打包 x86 + arm
```
改完：`git add`（只加你负责的文件）→ `git commit` → `git push`，保证 `check && test` 通过后再推。

## 发版（一次只由一个 AI 做）
```
npm run release -- --bump patch --changelog "说明"
```
自动升版本 → 更新 changelog → 打包 x86/arm → 校验。之后把 `dist/shuaishuai.nas_<版本>_<arch>.fpk` 上传到 GitHub Release。

## 已知可做的（认领前先对照 TASKS.md）
- 天气接国内 API（和风/高德，需 key）作第三备用源。
- 加 GitHub Actions 自动打包。
- 把封面脚本移入仓库。
