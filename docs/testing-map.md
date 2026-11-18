# 三平台测试入口

Windows 与 macOS 共用桌面工作区中的测试；Stable、Beta、Next 是产品渠道。测试文件继续与所属源码包一起保存，避免移动后破坏 fixture 和相对导入。

| 范围 | 正式测试目录 | 工作区入口 |
| --- | --- | --- |
| Stable 桌面：Windows / macOS | `dsh-plugin-desktop/tests/` | `corepack yarn workspace dsh-plugin-desktop test` |
| Beta 桌面：Windows / macOS | `dsh-plugin-desktop-beta/tests/` | `corepack yarn workspace dsh-plugin-desktop-beta test` |
| Next 桌面：Windows / macOS | `dsh-desktop-next/tests/` | `corepack yarn workspace dsh-desktop-next test` |
| Web Host | `dsh-web-host/tests/` | `corepack yarn workspace dsh-web-host test` |
| 公司模型与身份 | `dsh-plugin-p7-company-models/tests/` | `corepack yarn workspace dsh-plugin-p7-company-models test` |
| 公司 MCP | `dsh-plugin-p7-mcp/tests/` | `corepack yarn workspace dsh-plugin-p7-mcp test` |
| 公司搜索 | `dsh-plugin-p7-web-search/tests/` | `corepack yarn workspace dsh-plugin-p7-web-search test` |
| 跨包布局和发布规则 | `scripts/*.test.mjs` | 根 `package.json` 的对应 `test:*` 命令 |

Web 门户、执行器、鉴权和上传代理属于 P7 后端仓库，测试在该仓库 `pro7/web_workspaces/tests/`；网关与管理 API 测试在 `pro7/admin_api/tests/`，不复制进本仓库。

## 诊断和历史脚本

- 可重复的离线检查留在所属包 `tests/`，复用该包的测试工具和 fixture。
- 会连接服务器、修改发布配置、登录真实账号或加载模型的脚本属于手工运维，应与默认测试发现范围分开，并说明执行前置条件。
- 工作区外层早期散落脚本已经归入本地 `archive/legacy-operator-scripts-20261118/`，按旧文件名保存，并有移动前后哈希清单。该目录包含历史连接材料，不属于 GitHub 源码。
- `.task-artifacts/` 保存本地过程证据与临时采集，不作为另一套正式测试库，也不通过批量执行历史脚本验证当前版本。

## 2026-11-18 保存检查

本次仅为保存最新开发代码，不是发布验收。Beta 与 Next 的 `web-document.spec.ts` 各 35 项通过；Web Host 的默认工作区、启动、员工资料、记忆、工具观察及 profile/index 定向测试共 21 项通过；Next/Beta 323 个文件的同步检查通过。上游子模块的本地 Git 关联仍需修复，未运行完整构建或三平台打包，也未启动 WSL。
