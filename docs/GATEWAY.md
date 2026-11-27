# NAS助手 · 桌面网关接入改造方案

> 目标：让 NAS助手 像 CowButler 一样，在 fnOS 桌面「点开即用」，页面内嵌进 fnOS 桌面框架，不再需要浏览器访问 8620 端口。
> 现状：`type: url + service_port: 8620`（网页直连，需开放端口）。
> 状态：**方案**（未实施），需真机验证。

---

## 0. 一句话结论

可以改，但**有硬性前提**：

1. **fnOS 版本必须较新**（cowbutler 要求 `os_min_version=1.2.1102`，因为 `gatewaySocket` / `.url` iframe 网关是新版本才支持）。
2. **必须真机验证**（同一份配置在不同 fnOS 版本上行为可能不同；`.url` 网关对「应用内部是否带前缀路径」很敏感，见第 4 节风险）。

改完的收益是「不暴露端口、原生嵌入桌面」；代价是**安装门槛变高** + 可能影响 `Docker` 形态（见第 5 节权衡）。

---

## 1. 借鉴了什么（对照 CowButler）

| 能力 | CowButler | 我们的现状 | 改造后 |
|---|---|---|---|
| 桌面入口 | `type: iframe` + `.url` | `type: url` + 端口 | 改为 `type: iframe` + `.url` 网关 |
| 后端挂载 | `gatewayPrefix: /app/cowbutler` + `gatewaySocket: app.sock`（unix socket） | TCP `8620` | 改为绑定 unix socket + 走网关前缀 |
| 端口 | `checkport=false` | `checkport=true` | `checkport=false`（不对外暴露端口） |
| 身份 | `run-as: root` + `join-groups: disk` | `run-as: shuaishuainas` + `join-groups: disk,docker` | 保持 package（不学 root，安全优先），如需直读 SMART 保留 `disk` |
| 数据共享 | `config/resource: data-share/cowbutler/reports` | 空 | 可选：声明一个 `reports` share 供系统访问 |

---

## 2. 要改的文件清单

### A. `fpk/manifest`（打包元数据）
- `os_min_version`：`1.1.8` → 需 ≥ **1.2.1xxx**（建议对齐 cowbutler 的 `1.2.1102`；具体以你所装 fnOS 为准）。
- `checkport`：`true` → `false`（不再有 TCP 端口可探活）。
- `service_port`、`desktop_applaunchname`：视网关方案调整（`desktop_applaunchname` 指向入口键）。

### B. `fpk/ui/config`（桌面入口）
当前：
```json
".url": { "shuaishuai.nas.main": { "type": "url", "protocol": "http", "port": "8620", "url": "/", ... } }
```
改为（参照 cowbutler 形态，前缀用我们自己的名）：
```json
".url": {
  "shuaishuai.nas.main": {
    "title": "NAS助手",
    "icon": "images/icon_{0}.png",
    "type": "iframe",
    "protocol": "",
    "gatewayPrefix": "/app/shuaishuai",
    "gatewaySocket": "app.sock",
    "url": "/app/shuaishuai",
    "allUsers": true,
    "control": { "accessPerm": "readonly" }
  }
}
```

### C. `fpk/cmd/main`（生命周期脚本）
- 启动时不再是「监听 TCP 端口」，而是**把 `app.sock` 放到 fnOS 网关预期路径**（通常在应用数据目录/运行目录下），并往 `server/index.js` 传 `SS_SOCKET=<sock 路径>`（替代 `SS_PORT`）。
- `stop` 时清理 socket 文件。
- `status` 探活方式从「查 TCP」改为「socket 文件 + 进程」。

### D. `server/index.js`（后端）
- 支持 `SS_SOCKET` 环境变量：`http.createServer().listen(sockPath)`（Node 原生支持 unix socket），无 TCP 端口。
- **处理网关前缀**（关键）：网关会把请求映射到 `/app/shuaishuai` 这个路径前缀下。前端 `index.html` 里 `/styles.css`、`/app.js`、`/api/...` 都是**绝对路径**，直接放网关背后会 404。两种解法：
  1. 后端在 `pathname` 以 `/app/shuaishuai` 开头时去掉前缀再按原逻辑服务；
  2. 或前端改用相对路径 / 注入 `base`。
  推荐先做 1（改后端一处）、必要时前端 `api()` 前缀适配。
- 保留 `SS_PORT` 作为**后备**：设了 `SS_PORT` 就走 TCP（Docker / 直接 npm 跑），设了 `SS_SOCKET` 就走网关。这样**不影响 Docker 形态**。

### E. `fpk/config/resource`（可选）
如想给 fnOS 报表/备份共享导出目录，仿 cowbutler 加 `data-share`；非必须，先不动。

---

## 3. 必须真机验证的点

1. 你的 fnOS 版本是否支持 `.url` iframe + `gatewaySocket`（≥ 大概 1.2.1xxx）。**低于则此方案不可用**，需维持现状或用「反向代理 + HTTPS」替代。
2. 网关前缀 `/app/shuaishuai` 下，`/api/...`、静态资源、`#/` hash 路由是否都正常（这是最容易翻车的点）。
3. SDK `app.sock` 的**可用路径**由 fnOS 环境变量给出（`TRIM_*` 类的运行目录），脚本里要用对位置。
4. 访问密码、授权目录、热加载在 socket 模式下是否仍生效（它们走 cookie / 文件读取，与 TCP/socket 无关，理论不受影响）。

---

## 4. 风险与权衡

| 影响 | 说明 | 建议 |
|---|---|---|
| **安装门槛提高** | `os_min_version` 提到 1.2.x → 旧版本 fnOS 用户装不了 | 若目标用户主要是新版本，可接受；否则别贸然提 |
| **资源路径/前缀兼容** | 前端的绝对路径 `/api`、`/styles.css` 在网关前缀下可能 404 | 必须真机调：后端去前缀或前端改 base |
| **Docker 形态** | 网关是 fnOS 专属；Docker 没有 fnOS 网关 | 保留 `SS_PORT` 后备，Docker 继续走网页/反向代理 |
| **root vs package 身份** | 学 cowbutler 用 root 能直读系统/清理，但降低安全边界 | **不建议**：你的卖点是「非 root + 路径沙箱」，维持 package |
| **验证成本** | 必须真机装新版 fpk 反复试 | 预留时间，准备一台/一个 fnOS 实例 |

---

## 5. 建议路线（分两步，风险低）

**第一步（低风险，不必改 socket）**：先把 `fpk/ui/config` 从「网页直连」调整为更接近桌面的体验，但**不删端口、不动 socket**，跑一遍真机确认 `.url` 各字段行为。

**第二步（才真正切到网关）**：确认你的 fnOS ≥ 1.2 后，再按第 2 节全量改造（socket + 前缀 + checkport=false）。

这样即使网关方案在你的版本上不可行，也能无损回退到现在的网页形态。

---

## 6. 你最好先告诉我

在动手前，请确认：
1. 你的 **fnOS 系统版本**是多少？（决定方案可行性）
2. 目标用户是否需要支持**旧版 fnOS**？（决定 `os_min_version` 怎么设）
3. 是否接受「为桌面体验提高安装门槛」的取舍？

拿到这三点后，我才能真正确定是「全量网关改造」还是「保留网页 + 优化入口」。

---

## 6.5 实施状态（用户确认 fnOS = 1.2.1102，已实施）

- 用户实际系统为 **1.2.1102**（支持 `.url` iframe + gatewaySocket 桌面网关），方案已**实施于 v1.0.3**：
  - `server/index.js`：支持 `SS_SOCKET`（unix socket）+ `SS_BASE`（网关前缀剥离）+ HTML 基址注入；保留 `SS_PORT` 作 Docker/直连后备。
  - `web/index.html`、`web/login.html`、`web/ui.js`：改为相对路径 / app-base 解析。
  - `fpk/ui/config`：`type:iframe` + `gatewayPrefix:/app/shuaishuai` + `gatewaySocket:app.sock`。
  - `fpk/cmd/main`：网关模式绑 `app.sock`，stop 清理；`SS_SOCKET` 可覆盖路径。
  - `fpk/manifest`：`os_min_version=1.2.1102`、`checkport=false`。
  - `scripts/verify-fpk.mjs`：支持网关形态校验。
- 本地已验证：网关前缀模拟（`/app/shuaishuai/...`）首页/静态/API/登录全通；静态检查 48/48、端到端 20/20；x86+arm 打包校验通过。
- **待真机确认**：`fpk/cmd/main` 默认 socket 在 `${DATA_DIR}/app.sock`。若 fnOS 桌面网关期望的 socket 目录不在数据目录，需按真机日志改为 fnOS 期望路径。

---

## 7. 附：CowButler 参考片段（已解包核实）

- manifest：`os_min_version=1.2.1102`、`checkport=false`、无 service_port 直连。
- `app/ui/config`：`.url` + `gatewayPrefix:/app/cowbutler` + `gatewaySocket:app.sock` + `type:iframe` + `accessPerm:readonly`。
- `config/privilege`：`run-as: root` + `join-groups:[disk]`。
- `config/resource`：`data-share/cowbutler/reports`。
