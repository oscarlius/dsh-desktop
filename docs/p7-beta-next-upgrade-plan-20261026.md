# P7 公司定制版基线与 Next 迁移计划

日期：2026-10-26。状态：**公司定制代码归档；Next 迁移尚未实施，不是升级发布通知。**

## 仓库与分支

- 公司仓库：<https://github.com/oscarlius/dsh-desktop>。
- 公司维护分支：`company/beta15`，保存现有飞书登录、个人用量、P7 公司模型、搜索、托管 MCP 和 Windows 公司更新能力。
- 当前产品源码基线：`f61fcfc4de9663658f60bb6baea30efb1ef4e34e`，传输版本 `2.0.19-beta.15`，内部构建 `2026102201`。
- 原作者上游：<https://github.com/anywhere-labs/dsh-desktop>。上游默认分支与公司维护分支独立，不用上游目录直接覆盖公司定制层。
- 本次提交只增加这份说明，不修改客户端版本、运行代码、P7 服务或公开更新指针。

## 已固定的升级评估目标

| 项目 | 当前基线 | 评估目标 |
|---|---|---|
| DSH Desktop | 公司基线 `f61fcfc`，与上游共同祖先 `a5c914ce` | [上游 `3c5db655`](https://github.com/anywhere-labs/dsh-desktop/commit/3c5db655ba98327f16c19bda43e46379a811f33c)，Beta 已采用 Next 框架 |
| DeepSeek Harness | `687f282e` / `0.2.1-rc.2` | [上游固定 pin `1f81c047`](https://github.com/deepseek-ai/deepseek-harness/commit/1f81c047fc48fa190a683e469daa699857e9afe8) / `0.2.1-rc.3` |

这次迁移可行，但不能直接合并后发版。关键文件的三方静态探测已发现 manifest、锁文件、Profile、主进程与 WebServer 冲突；没有执行目标构建、真实升级或业务验收。

## 公司功能兼容性与发布阻断

| 能力 | 可保留部分 | 必须适配及验收 |
|---|---|---|
| 飞书登录 | [AccountBroker](../dsh-plugin-p7-company-models/src/account-broker.ts)、[加密 vault](../dsh-plugin-desktop-beta/src/p7-session-vault.ts) | 将公司 policy、首屏 gate、原生账户/存储桥迁入 Next Host；保持 `requirePersonalLogin`，验证首次登录、重启恢复、refresh 轮换、注销及 Profile 隔离。 |
| 公司模型 | [目录及 Host](../dsh-plugin-p7-company-models/src/company-host.ts)、[三协议映射](../dsh-plugin-p7-company-models/src/map-providers.ts) | 补回公司插件组合、统一 rc.3 依赖，迁移现有 llm-pi-ai 防重定向补丁；三个协议的正常 SSE、错误 CA 和 302/307 零泄漏测试必须通过。 |
| 搜索及 MCP | [搜索插件](../dsh-plugin-p7-web-search/src/index.ts)、[MCP 注册与同步](../dsh-plugin-p7-mcp/src/index.ts) | 新 Profile 必须装载三个 P7 插件，账号与工具同处 Host。验证主 Agent、spawn/fork、受限 preset、动态撤权、切账号及重启；工具列表可见不等于实际调用成功。 |
| 公司更新 | [P7 检查](../dsh-plugin-desktop-beta/src/company-update-check.ts)、[差分传输](../dsh-plugin-desktop-beta/src/company-differential-update.ts)、[三件套发布](../scripts/publish-company-release.mjs) | 上游 Beta 默认关闭 NSIS differentialPackage、使用官方更新源，且改为 ASAR。必须恢复 P7 feed/blockmap、公司包身份、ASAR 内容校验与安装交接，保留 Full/update 凭据边界。 |

上游 rc.3 原始 llm-pi-ai 包没有本公司的 `rejectRedirects` 扩展；不能删掉该配置来绕过保护。公司设置仍有回环/同源访问限制，Next 原生 `dsh-app` 转发与同机 Web 分别验收，不将此次迁移描述为 LAN 多用户服务。

## 产品、数据和版本契约

- 保留公司 appId `ai.deepseek.dsh.desktop.companytest`、产品及 EXE 名 `P7 DSH Company Test`、原安装位置/范围/快捷方式和 updater cache。
- 以旧数据目录状态中的实际 activeHome 和 Profile 选择为准，保留聊天、工作区和插件设置；不直接改成新 Beta 默认目录。vault 绑定 Profile 路径，改变路径时必须设计重新认证，不能导出明文 refresh token。
- 界面继续维持现有 `2.0.18-beta.15` 展示；实际升级的完整传输版本必须递增，不能覆盖已有同版本制品。候选示例为 `2.0.20-beta.15`，本次没有设置或发布该版本。
- 构建前从单一 manifest 分配新内部构建号，UI 展示为 `2.0.18-beta.15（构建 B）`；ASAR、app.getVersion、P7/feed 使用完整传输 SemVer。
- 区分两种 EXE：现有安装前验证要求 **Setup.exe ProductVersion 等于完整 SemVer**；安装后的应用 EXE 按数值投影校验，例如 `2.0.20.0`。不能把安装包和应用 EXE 的 PE 版本混为一谈。

## 实施顺序

1. **恢复点与隔离环境**：保留现有 bridge、三件套、源码提交和可恢复数据；使用独立候选 worktree 与可销毁 Windows VM，不在日常客户端上试装同身份安装器。
2. **框架合并与依赖封口**：固定上游提交，按模块解决冲突；保留公司 workspace/脚本/测试；对齐 Harness pin、vendor、peer、补丁及 lock，不批量选择 ours/theirs。
3. **公司运行层**：先接回产品身份、旧目录/选择状态、OS vault 和登录门禁，再接模型、搜索、MCP；使用 mock P7 和测试 Profile 验证，不消耗供应商工具配额。
4. **更新及打包层**：使用单一主进程更新协调器、P7 源和完整内容验证；恢复 blockmap、原安装路径保护，以及 Full/credential-free update/blockmap 同版本同提交契约。
5. **真实隔离升级**：必测当前 bridge 到候选；beta14/原始 beta15 等每条声称支持的路径，分别使用真实历史安装器验证。检查自动发现、确认、下载、安装、重开、实际新 Host、数据保留及回退。
6. **发布前验收**：在专用身份上验证真实飞书/模型及获授权 MCP，核对个人用量；所有门禁通过后才考虑 P7 受控发布，不能把源码提交当作已完成升级。

## 不触碰生产的自动更新验证

旧客户端固定公司 origin，因此使用一次性 Windows VM 中的隔离 DNS/TLS fixture：只在 VM 将原域名解析到私网回放网关，以一次性测试 CA 验证 Node/Electron HTTPS，不关闭证书校验、不复制生产私钥、不修改公司 DNS。

VM 默认拒绝真实生产出网；fixture 在原精确路径提供候选 latest/feed、无凭据 update、blockmap、Range/206 和故障注入。这样可以验证未改写的旧客户端升级正式候选二进制，不必改生产更新指针。此隔离机制未准备好时，只能报告离线安装验证，不能宣称自动更新全链路已通过。

P7 的 stage-only 只表示上传不激活，不自动提供按用户灰度 feed。参见[公司发布流程](company-release.md)。

## 差分与回退验收

- 首次跨框架更新可能接近完整更新包大小；必须记录实际 Range 请求、传输字节和重建哈希，不承诺固定节省率。
- blockmap 缺失、Range 失败或缓存损坏时，回退完整的 **credential-free update EXE**，不是带初始化材料的 Full 新装包。
- 继续拒绝错误产品、哈希篡改、确认后目标漂移、降级和同版本不同内容。
- 新框架写过旧数据后能否直接降级尚未验证；保留原数据恢复点，不把切回旧 EXE 当作完整回滚。
- 正式发布仍使用[三件套流程](company-release.md)，不改变 P7 网关修复、现有 MCP 服务配置或其他服务。

实际服务密钥、登录态、bootstrap 文件和带初始化材料的 Full 安装包不属于本仓库的公开源码分发内容。
