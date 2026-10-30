# 公司版 macOS 通用测试包

在原生 macOS 主机上使用当前公司 Beta 源码构建，应用名称为 `P7 DSH Company Test`。Universal DMG 同时包含 Apple Silicon 与 Intel 的 Electron 和对应运行时。界面继续显示 beta15 与内部构建号。

## 构建

`.github/workflows/company-mac.yml` 可在 `company/mac-installer-*` 分支推送时构建，也可手动执行。工作流安装锁定依赖、验证 Market/Agents Anywhere 来源、构建公司插件与前端，然后执行现有 `dist:mac-smoke` 和 DMG 挂载、架构、运行时、Host 检查。原生升级检查会通过本机模拟 P7 下载实际 DMG、替换隔离的应用副本并核对重启及数据标记。仅上传 DMG、哈希、来源清单、P7 Mac 发布元数据和使用说明，保留 14 天。

输出目录为 `dsh-plugin-desktop-beta/dist/mac-company/`。`release-manifest.json` 记录源码、传输/界面版本、内部构建号、平台、Universal 架构、签名状态、字节数及 SHA-256。

## 登录与更新

该测试包不携带共享接入密钥。首次启动使用公司飞书登录；客户端通过默认 P7 公网地址获取个人认证、模型和 MCP。现有 Windows Full/Update 发布流程不变。

从构建 `2026103002` 起，公司 Mac 通过独立的 `/v1/desktop/releases/macos/latest` 获取更新，下载固定版本及哈希的 Universal DMG；安装前校验公司包标识、版本、个人登录分发属性和代码签名完整性，再退出、替换原 `.app` 并重新启动。失败替换或启动命令失败时恢复旧应用。此阶段下载完整 DMG，不启用差分。Windows `/v1/desktop/releases/latest`、EXE/blockmap 和发布修订保持独立。

先前构建 `2026103001` 关闭了 Mac 公司更新入口，需要手动安装本包一次；不要承诺它能自行更新到本包。更新只替换应用目录，原有 `.p7-dsh-companytest` 和公司 Chromium 用户目录保持原路径。

测试包使用 ad-hoc 签名，没有 Apple Developer ID 签名及公证。该模式只用于已标识的公司个人登录测试包，普通 Mac 更新的同团队签名验证保持不变。原生 CI 使用隔离的配置、聊天和模拟认证标记，不等于已完成员工 Mac 上的飞书本人授权及真实凭据恢复验收。
