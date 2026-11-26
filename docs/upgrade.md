# 升级与维护

这份文档回答两件事：**代码改了怎么发出去**，以及 **装到 NAS 上之后怎么升级、怎么回滚、数据在哪**。

---

## 1. 版本号规则

- 唯一来源是 `package.json` 的 `version`；
- `fpk/manifest` 里的 `version` 会在打包时被自动覆盖，不用手动改；
- 遵循语义化版本：
  - `1.0.1`：修 bug、改文案、调样式（patch）
  - `1.1.0`：加功能、加工具（minor）
  - `2.0.0`：改数据结构、改配置格式、不兼容旧数据（major）

**不要改 `appname`**。`shuaishuai.nas` 是系统内唯一标识，改了会被当成另一个应用，用户数据全部对不上。

---

## 2. 改完代码怎么发版

```bash
# 0. 先自测
npm run check     # 语法、JSON、manifest、生命周期脚本
npm test          # 21 项端到端断言（临时目录，不碰真实数据）

# 1. 发一个补丁版本（自动改版本号 + 打包 + 校验）
npm run release -- --bump patch --changelog "修复重命名撤销日志边界"

# 2. 只改版本不打包（想手动检查时）
node scripts/release.mjs --bump minor --changelog "新增网络诊断项" --no-build
```

`scripts/release.mjs` 会依次做：

1. 计算新版本号，写回 `package.json`；
2. 更新 `fpk/manifest` 的 `version` 和 `changelog`（升级弹窗会显示这段文字）；
3. 调 `scripts/build-fpk.mjs` 打包 x86 + arm；
4. 调 `scripts/verify-fpk.mjs` 校验校验和、结构、图标、脚本可执行位。

产物：`dist/shuaishuai.nas_<version>_<arch>.fpk`。

> 不想用脚本也行：手动改两个文件里的版本号，然后 `npm run build:fpk && npm run verify:fpk`。

---

## 3. fnOS 上升级（保留数据）

1. 用新版本 `.fpk`，在 **应用中心 → 手动安装** 选择文件；
2. 系统识别到 `appname` 相同、`version` 更高，走 **升级流程**：
   - 先调用 `cmd/upgrade_init`：停止旧服务；
   - 替换 `target/`（应用本体）；
   - 调用 `cmd/upgrade_callback`：保留并检查 `var/`（数据）、`etc/`（配置）；
3. 升级完成后自动启动，桌面入口不变。

**数据保留情况：**

| 目录 | 内容 | 升级 | 卸载 |
| --- | --- | --- | --- |
| `var/`（`TRIM_PKGVAR`） | 撤销日志、app.log | 保留 | 默认保留，向导选「删除数据」才清理 |
| `etc/`（`TRIM_PKGETC`） | `auth.env` 访问密码 | 保留 | 同上 |
| `target/` | 程序本体 | 整体替换 | 删除 |
| 授权目录 | 你的媒体文件 | 完全不动 | 完全不动 |

**回滚：** 保留上一版 `.fpk`，出问题时重新安装旧版本。fnOS 通常不允许直接降级，必要时先卸载（选「保留数据」）再装旧版，数据仍在 `var/`，会继续使用。

---

## 4. Docker 上升级

```bash
# 自己构建
docker compose build && docker compose up -d

# 用镜像仓库
docker compose pull && docker compose up -d
```

`/data` 是独立卷，`docker compose down` 不会删数据；只有 `down -v` 才会。

**回滚**：把 compose 里的镜像 tag 改回旧版本（如 `:1.0.0`）再 `up -d`。所以每次发版请保留旧 tag，不要只留 `latest`。

---

## 5. 数据与备份

真正需要备份的只有两样：

```
/data                     # Docker
/vol?/@appdata/shuaishuai.nas/var   # fnOS（TRIM_PKGVAR）
```

里面是 `rename-journal.json`（撤销记录）和 `app.log`，没有数据库。备份方式：

```bash
# Docker
tar czf shuaishuai-data-$(date +%F).tgz ./data

# fnOS（把路径换成实际存储空间）
tar czf /vol1/backup/shuaishuai-data-$(date +%F).tgz -C /vol1/@appdata/shuaishuai.nas var
```

另外建议固定 `SS_SECRET`：不设置时每次启动随机生成，重启后需要重新登录（数据不受影响）。

---

## 6. 常见问题

**升级后打不开 / 502**

```bash
# Docker
docker logs --tail 100 shuaishuai-nas
# fnOS
tail -n 100 /vol?/@appdata/shuaishuai.nas/var/app.log
```

常见原因：端口被占用（`SS_PORT` 改了但入口配置没改）、Node 运行时缺失、授权目录被移除。

**忘记访问密码**

- Docker：改 `SS_PASSWORD` 环境变量后 `up -d`；
- fnOS：删除 `etc/auth.env`（`/vol?/@appconf/shuaishuai.nas/auth.env`），重启应用即关闭密码；或改密码后重启。

**升级后功能 403**

授权目录在升级时不会自动继承。到 **应用设置 → 授权目录** 重新确认一遍，保存后服务会自动重启。

**想换端口**

- Docker：改 compose 的 `ports` 与 `SS_PORT`；
- fnOS：`manifest` 的 `service_port` 是固定值，换端口需要改源码重新打包（入口 `ui/config` 同步改），不建议普通用户操作。

---

## 7. 兼容性约定（改代码时注意）

1. **`appname` 永远不改**，否则等于换了一个应用。
2. **撤销日志格式**（`rename-journal.json`）如果改结构，读取时要兼容旧格式，或直接忽略旧文件而不是报错。
3. **API 路径尽量只增不改**，前端与后端同包发布，但用户可能开着旧页面缓存。
4. **授权目录语义不变**：任何新功能只要碰文件，都必须走 `resolveUserPath`。
5. **不要引入第三方依赖**：NAS 上离线安装，`node_modules` 会让 `.fpk` 变大且容易装不上。
6. 生命周期脚本改动后，至少在真机上完整走一遍：安装 → 启动 → 改配置 → 升级 → 卸载。

---

## 8. 发布前检查清单

- [ ] `npm run check` 全绿
- [ ] `npm test` 全绿
- [ ] `npm run release -- --bump patch --changelog "..."` 成功
- [ ] `dist/` 下 x86 / arm 两个包都存在，`verify:fpk` 通过
- [ ] 真机覆盖安装，数据与密码仍在
- [ ] 旧版本 `.fpk` 与 data 目录已备份
