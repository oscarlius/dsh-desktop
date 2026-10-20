# DSH P7 第一期开发验证记录

日期：2026-10-20。工作分支：`codex/p7-company-models-v1`。本记录包含本机隔离联调；不代表生产模型或安装后的业务验收。README 中早期 mock 阶段的阻塞说明以本记录的最新结果为准。

## 已验证

- 独立 Host/Client 插件已加入 Stable、Beta 组合，复用已有 settings、credentials、模型选择和 pi-ai 运行时。
- 插件 12 个测试文件、57 项测试通过；TypeScript 类型检查和 Host/Client 构建通过。
- 核心覆盖：契约、映射、ETag/304、认证撤销、超时与退避、切换连接、持久化、损坏/丢失缓存恢复、默认写入迟到补偿、持久化及回滚同时失败。
- 实际 loopback HTTP 路由验证同源访问、方法与请求体边界；React 测试验证连接、只读目录、错误信息和输入密钥清除。
- 使用已发布 DSH 适配器，在拦截 fetch 的无网络测试中验证三类模型元数据，以及 OpenAI-compatible 流式文本/工具调用。出站 URL、Bearer 合成密钥、工具 schema 和请求 model alias 均有断言。
- Stable/Beta 构建及类型检查通过；包集成测试分别 52/52、53/53 通过；两版 runtime closure 均通过，318 个 first-party 节点闭合。
- `check:desktop-variants` 通过：210 个共享源文件一致。
- 固定 `deepseek-harness` 子模块未修改，仍为 `687f282e8625c6b8d11ff58211a90524be2e4317`。

可重复验证命令见 README，完整日志位于外层工作区 `.omx/logs/p7-*.log`。契约副本与交给 Qorder 的版本一致。

## 已解决的推理重定向问题

通过仓库自有 Yarn 兼容补丁 `patches/dsh-llm-pi-ai@0.2.1-rc.2.patch`，在固定发布版适配器中增加显式 `rejectRedirects` 配置。P7 provider 保存 `rejectRedirects: true`、`transport: sse`，推理逐请求校验 HTTPS origin 并使用 `redirect: error`。不修改固定上游子模块，也不替换全局 fetch 或关闭 TLS 校验。未启用该选项的 provider 保持原行为。

实际 HTTPS 测试覆盖三种协议的正常 SSE，以及每种协议的 302/307。跨源目标服务器收到请求数均为零；测试检查真实构造的 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`。联调同时发现并修复了 Anthropic SDK 对 `/v1` 二次拼接的问题：Messages 的 baseURL 使用 origin，OpenAI 两种协议使用 origin + `/v1`。

## 本机 P7 → DSH 网络联调

使用临时 SQLite、合成专用 key、本地测试证书和 loopback 模型上游；Node 通过 `NODE_EXTRA_CA_CERTS` 信任该次证书，TLS 校验正常开启。真实 control/gateway 路由通过 uvicorn 暴露，真实 CompanyHost、LlmRuntime、发布版 PiAiAdapter 和 LiteLLMExecutor 参与请求；没有 mock fetch 或推理执行器。模型输出为合成内容，不证明真实厂商模型已接入。

- 未登记 key 返回 403，管理员 PUT 发布后客户端同步并进入实际模型注册表。
- 真实 ETag/304、默认模型切换、本地 provider 保留、停用后撤回托管路线。
- Chat、Responses、Messages 均通过流式文本、工具调用、工具结果回传。
- 三种协议的客户端取消请求均在慢上游完成前返回 aborted；未将此记为上游推理已经停止的证明。
- 实际管理 API 撤销 key 后返回 401，客户端移除托管路线并清除凭据。

该环境的 LiteLLM 对合成 Responses 型号使用非流式上游结果转 SSE；未将此记为原生上游 Responses 流式验收。完整网络证据保存在外层 `.omx/logs/network-final/p7-dsh-network-integration.json`。

复现：先构建本 workspace，再运行 `tests/manual/p7-loopback.ps1 -P7Repository <P7仓库绝对路径> -Python <Python312绝对路径> -Artifacts <日志目录>`。P7 仓库需要配套 `pro7/admin_api/tests/manual/dsh_loopback.py` 及其原有测试依赖。脚本只启动本次临时进程，结束后关闭服务、删除临时证书/数据库和 ready 文件；报告不保存凭据。

## 待真实服务与 Windows 验收

- 本机隔离网络联调已完成。公司实际部署、真实模型质量/性能、PostgreSQL 并发锁和生产权限仍未验收。
- Windows 测试版采用独立名称、appId、userData 和 DSH home；关闭该测试版的上游更新。候选包及安装/卸载/重启结果见后续交付记录。

MCP、P7 版本推送和功能发布均未开发。P7/Zagent 的接手代码位于各自隔离工作树；未部署生产服务。
