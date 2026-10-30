# 公司版 macOS 通用测试包

在原生 macOS 主机上使用当前公司 Beta 源码构建，应用名称为 `P7 DSH Company Test`。Universal DMG 同时包含 Apple Silicon 与 Intel 的 Electron 和对应运行时。界面继续显示 beta15 与内部构建号。

## 构建

`.github/workflows/company-mac.yml` 可在 `company/mac-installer-*` 分支推送时构建，也可手动执行。工作流安装锁定依赖、验证 Market/Agents Anywhere 来源、构建公司插件与前端，然后执行现有 `dist:mac-smoke` 和 DMG 挂载、架构、运行时、Host 检查。仅上传 DMG、哈希、来源清单和使用说明，保留 14 天。

输出目录为 `dsh-plugin-desktop-beta/dist/mac-company/`。`release-manifest.json` 记录源码、传输/界面版本、内部构建号、平台、Universal 架构、签名状态、字节数及 SHA-256。

## 登录与更新

该测试包不携带共享接入密钥。首次启动使用公司飞书登录；客户端通过默认 P7 公网地址获取个人认证、模型和 MCP。现有 Windows Full/Update 发布流程不变。

目前 P7 安装更新源提供的是 Windows EXE，因此 Mac 公司测试包不请求该源，也不会回退到普通上游更新源。后续 Mac 安装更新源需要单独接入。

测试包没有 Apple Developer ID 签名及公证。它不代表已完成员工 Mac 上的首次安装、飞书本人授权和业务验收。
