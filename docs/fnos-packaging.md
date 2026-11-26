# fnOS `.fpk` 打包说明

本文记录NAS助手的 `.fpk` 结构、生命周期脚本约定与构建方式，便于二次开发与上架。

> 依据：飞牛官方开发者文档 <https://developer.fnnas.com/docs/>（快照 2026-08），以及社区打包实践。字段可能随系统版本变化，上架前请以官方文档为准。

## 1. `.fpk` 是什么

`.fpk` 本质是一个 **tar.gz**，安装时由应用中心解包。内部结构：

```
manifest              # 应用身份证（key = value，不是 JSON）
app.tgz               # 应用文件，解压到 TRIM_APPDEST（target/）
cmd/                  # 生命周期脚本
config/privilege      # 运行身份
config/resource       # 资源与权限声明
wizard/               # install / config / uninstall 向导
ui/                   # 兼容位置（部分版本从包根读取）
ICON.PNG              # 64×64
ICON_256.PNG          # 256×256
```

**入口配置的权威位置是 `app/ui/config`**，打包后即 `target/ui/config`——`desktop_uidir = ui` 是相对应用目录（`TRIM_APPDEST`）解析的。本项目同时保留包根 `ui/` 作为兼容副本，但 `app.tgz` 内必须有一份，否则会出现「应用在运行、但没有打开按钮」。

`app.tgz` 解压后：

```
target/
├── server/             # Node 后端
├── web/                # 前端
├── ui/config           # 桌面入口（关键）
├── ui/images/icon_64.png
└── package.json
```

`manifest` 中的 `checksum` 必须是 **app.tgz 的 md5**，否则安装会校验失败。

## 2. 本项目的 manifest

```ini
appname         = shuaishuai.nas
version         = 1.0.0
display_name    = NAS助手
platform        = x86            # 打包时按架构替换为 x86 / arm
source          = thirdparty
service_port    = 8620
os_min_version  = 1.1.8
install_dep_apps = nodejs_v22
desktop_uidir   = ui
desktop_applaunchname = shuaishuai.nas.main
```

- 依赖 `nodejs_v22`，由应用中心自动安装，运行时路径 `/var/apps/nodejs_v22/target/bin`。
- `service_port` 固定 8620，`checkport = true` 会在启动前检查占用。
- `os_min_version = 1.1.8`：用到了 `TRIM_DATA_ACCESSIBLE_PATHS`（授权目录）与向导占位符。

## 3. 生命周期脚本

| 脚本 | 作用 |
| --- | --- |
| `cmd/install_init` | 检查 Node 运行时与版本 |
| `cmd/install_callback` | 建目录、按向导写访问密码（`etc/auth.env`，600） |
| `cmd/main` | `start` / `stop` / `status`，PID 文件 + 端口 |
| `cmd/config_init` / `cmd/config_callback` | 授权目录或密码变更后重启服务 |
| `cmd/upgrade_init` / `cmd/upgrade_callback` | 升级前后处理，保留 `var` 数据 |
| `cmd/uninstall_init` / `cmd/uninstall_callback` | 停进程，按向导决定是否删除数据 |

约定：

- `status` 运行中 `exit 0`，未运行 `exit 3`，其它 `exit 1`。
- 启动失败时把中文原因写入 `$TRIM_TEMP_LOGFILE` 再 `exit 1`，系统会以弹窗展示。
- 所有路径使用 `$TRIM_APPDEST`、`$TRIM_PKGVAR`、`$TRIM_PKGETC`，不硬编码安装位置。

## 4. 目录授权（关键）

第三方应用默认无法读取用户个人目录。用户在 **应用设置 → 授权目录** 授权后，系统通过：

- `TRIM_DATA_ACCESSIBLE_PATHS`：可访问路径列表（`: ` 分隔）
- `TRIM_DATA_SHARE_PATHS`：应用共享目录

`cmd/main` 把 `TRIM_DATA_ACCESSIBLE_PATHS` 直接传给 `SS_ROOTS`，服务端再做一次 realpath 包含校验。未授权目录返回 403，不做降级放行。

## 5. 构建

```bash
node scripts/build-fpk.mjs --platform both
```

脚本做四件事：

1. 把 `server/`、`web/`、`package.json` 复制进 `app/`；
2. 用内置的 ustar 写入器打成 `app.tgz`（不依赖系统 tar，Windows 也能构建）；
3. 计算 md5 注入 `manifest.checksum`，替换 `version` / `platform`；
4. 把 `fpk/` 下的 `manifest / cmd / config / wizard / ui / ICON*` 与 `app.tgz` 打成最终 `.fpk`。

产物：`dist/shuaishuai.nas_<version>_<platform>.fpk`。

## 6. 安装与验证

```bash
# 应用中心「手动安装」选择 .fpk，或使用 CLI（需设备环境）
appcenter-cli install-fpk shuaishuai.nas_1.0.0_x86.fpk
appcenter-cli list
appcenter-cli start shuaishuai.nas
```

验收清单：

- [ ] 应用中心可正常安装，图标与名称正确；
- [ ] 桌面入口可打开 Web 界面；
- [ ] 设置访问密码后，未登录访问返回 401；
- [ ] 授权 `/vol1/media` 后，文件规范化能扫描并列出目录；
- [ ] 未授权目录访问返回 403；
- [ ] 停止/启动应用后端口释放、PID 正常；
- [ ] 卸载保留数据；选择删除时仅清理应用自身目录。

## 7. 上架注意

- `display_name`、`desc`、图标需符合应用中心规范（256×256 / 64×64，≤1MB）。
- 第三方应用默认 `run-as: package`；本项目不需要 root，SMART 在原生安装下由应用用户读取 `/sys` 与 `smartctl`，若权限不足会降级提示。
- 不要把 Token、密钥写入包内；本项目不调用开放 API，无 Token 依赖。
- 官方文档：<https://developer.fnnas.com/docs/guide/>
