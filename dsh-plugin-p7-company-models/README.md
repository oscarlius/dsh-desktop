# DSH 公司模型（P7）

第一期 DSH 实现。P7 服务端由 Qorder 按 [接口契约](contracts/MODEL-CONFIG-V1.md) 独立开发，本目录用合成响应进行联调测试。

## 使用

Stable 和 Beta 的 Cordis 组合均已加入本插件。在桌面设置的“公司模型（P7）”中填写 P7 HTTPS origin 和专用 `p7k_` 密钥。连接成功后，公司模型进入现有模型选择器；管理员配置的默认模型用于未显式选模型的新会话。

型号、名称、alias、协议、上下文容量由 P7 下发，没有写死供应商品牌。现有本地模型供应商保留。MCP、版本推送和功能发布不在本期实现范围。

## 已实现

- `GET /v1/desktop/model-config`、Bearer 认证、ETag/304、严格 schema 和跨字段校验。
- 启动恢复、60 秒轮询、手动同步、10 秒请求超时及失败退避；更换连接使旧请求失效。
- 按三种兼容协议生成 `p7-company-chat`、`p7-company-responses`、`p7-company-messages` 托管 provider；只修改自己的 provider 路径。
- 网络或格式错误保留最近有效目录并显示同步失败；空名单、停用、401/403 撤销公司可用性。
- 本地设置页包含中英文、连接/断开、只读目录、协议与容量、默认模型、revision 和最近同步时间；不向页面返回密钥。
- 密钥写入 DSH 已有 credentials 服务，目录缓存 `.p7-company-models.json` 只保存 origin、目录和所有权信息。现有 credentials 存储不是操作系统加密保险库，也不隔离同一用户运行的本地程序。

## 开发与 mock 验证

从仓库根目录运行（无需 P7 服务或真实密钥）：

```powershell
corepack yarn workspace dsh-plugin-p7-company-models check
corepack yarn workspace dsh-plugin-desktop-beta build
corepack yarn workspace dsh-plugin-desktop-beta typecheck
corepack yarn check:desktop-variants
```

`tests/fixtures/config.ts` 提供最小有效配置；`contracts/model-config-v1.example.json` 和 JSON Schema 与交给 Qorder 的契约保持一致，均为合成测试数据。

测试覆盖解析/映射、HTTP mock 同步状态机、Host 和 settings/credentials 持久化边界、本地 HTTP 路由、React 设置交互，以及真实 Cordis 插件入口和已发布 pi-ai 适配器的模型映射、mock 流式文本与工具调用。测试不会连接公司服务。

## 后续真实联调

Qorder 提供测试 P7 origin 和专用 key 后，验证实际发布/撤销/重置密钥、不同 alias、流式回复和工具调用，再验证 Windows 桌面及安装包。当前构建和 mock 测试不代表上述业务验收通过，也尚未生成公司 Windows 安装包。现有上游更新入口尚未改造；制作公司分发包时须先落实独立应用身份和更新源策略。

**发布阻塞项：推理重定向策略。** 配置读取和本地设置请求已使用 `redirect: 'error'`。现有 DSH pi-ai 推理适配器没有请求级 fetch 注入点，使用的 SDK 默认仍可能跟随 HTTP 重定向，尚不满足契约对推理重定向的要求。未改动固定上游，也没有全局替换 fetch。此项必须在公司发布前通过专属 transport 扩展或经验证的适配器升级解决并测试，详见 [开发验证记录](VALIDATION.md)。

消费字段和权限语义以 `contracts/` 为准；如需变更，双方先同步契约和 fixture。
