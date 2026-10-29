# P7 公司客户端正式发布

每个版本同时生成并发布三项文件。不要把更新包作为新同事安装包发放。

| 用途 | 文件 | 分发方式 |
| --- | --- | --- |
| 新同事首次安装，自动连接公司 P7 | `full/P7-DSH-Company-Full-<版本>-x64-Setup.exe` | P7Pro 管理员下载后在公司内部分发 |
| 已有用户更新，保留配置和数据 | `update/P7-DSH-Company-Test-<版本>-x64-Setup.exe` | P7Pro 发布后，客户端提醒下载、安装并重启 |
| 差分索引 | 更新包对应的 `.exe.blockmap` | 随更新包发布，差分失败时客户端回退全量 |

## 发布准备

在 Windows x64 构建机使用仓库的 Corepack/Yarn。更新 Beta `package.json` 版本，按 AGENTS 完成 Market 和 Agents Anywhere 准备，提交源码、锁文件与产物来源。构建要求工作树中的已跟踪源码已提交，Full 和更新包记录同一 Git 提交与版本。

设置 `DSH_P7_BOOTSTRAP_FILE` 指向本机受保护的公司连接 JSON（沿用现有 Host 格式）。文件不要入库。设置 `P7_BOOTSTRAP_PASSWORD_FILE` 或 `P7_ADMIN_TOKEN_FILE` 指向受保护的管理认证文件；不要把凭据写到命令参数、发布说明或日志。

## 一次生成并发布

```powershell
corepack yarn release:company --notes-file <发布说明文件> --reason "本次版本发布原因"
```

默认输出 `dsh-plugin-desktop-beta/dist-company/<版本>/`。可用 `DSH_COMPANY_RELEASE_OUTPUT` 指定一个尚不存在的版本输出目录。Full 与更新包分别构建到独立目录，最终 NSIS 内容也会校验：Full 必须带公司初始化材料；公开更新包必须不带公司密钥。三个文件全部成功才会原子生成 `release-manifest.json`，记录版本、同一源码提交、文件用途、大小和哈希。不要把整个输出目录上传到公开 CI 附件或公开静态目录。

发布器先核验本地清单及打包内容，再上传 Full、更新包、差分索引。P7Pro 核验同一版本的三项文件后，最后一次事务切换公开更新版本；缺文件、错版、错用途、哈希错误或并发修订冲突时保留原发布。成功生成 `publication-receipt.json`，再从 P7Pro 的 DSH 客户端页面下载已发布 Full 包分发给新同事。

## 只生成、预检及失败续传

```powershell
corepack yarn dist:win-company-release
corepack yarn publish:company-release --bundle <版本目录> --dry-run
corepack yarn publish:company-release --bundle <版本目录> --notes-file <发布说明文件> --reason "恢复本次发布"
```

需要先上传、不触发客户端提醒时，给发布命令加 `--stage-only`。同版本文件不可覆盖，续传会核对并跳过已上传且哈希一致的文件；不一致直接拒绝，修正内容必须升版本。重复执行已成功发布的同一清单只做回读，不再增加修订或重复提醒。

历史 `dist:win-company-test` 根命令已转为双包生成入口。低层单包命令只用于开发检查，不作为正式发布流程。

## 验证

涉及客户端入口或运行时依赖的修改，发布前运行 `corepack yarn workspace dsh-plugin-desktop-beta verify:client-boot`，在隔离 Host 中启动真正的官方前端与模块 Loader，确认 Desktop factory 激活并报告健康。该检查不调用真实模型、不使用生产账号；如使用已安装的 Edge，可设置 `DSH_NEXT_TEST_BROWSER_CHANNEL=msedge`。组件预览和 Host HTTP 接口通过不能代替这条启动验证。

运行 `corepack yarn test:company-release` 及两种 Desktop 打包门禁、变体一致性检查。正式发版核对 P7Pro 同版三文件状态和回执；对 Full 做空白配置自动连接及真实公司模型调用，对更新包核对差分/全量回退与既有配置保留。后台页面应清楚显示“新同事首次安装”和“已有用户更新”，并使用同一个本次发布版本。
