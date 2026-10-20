# P7 → DSH 模型配置协议 v1（拟定契约）

状态：供 Qorder/Codex 并行实现的接口草案，当前 P7 尚无该接口。机器可读响应定义在 model-config-v1.schema.json；示例是合成测试数据，不是生产配置。

## 1. 身份与地址

- 一次性连接参数：HTTPS P7 origin，例如 https://p7.example.invalid；专用 p7k_ key。
- 只用 P7 网关 key 认证，不使用 AdminSession、DesktopSession、sessionNonce 或 Codex audience。
- DSH 不接受 URI 中的用户名密码、query/fragment；key 只放 Authorization: Bearer。
- 配置 API、推理请求都使用已配置的同一 HTTPS origin；服务响应不能指定第三方 baseURL。
- TLS 校验保持启用。跨源重定向拒绝；key 不随重定向传播。不新增信任自签证书的绕过开关。
- 本期一份 DSH profile 连接一个 P7 账号/key。key 重置或重发后用户手动替换；不实现 SSO、自动 token exchange。

## 2. 管理端新增接口（Qorder）

路径：/api/v1/model-admin/access-keys/{key_id}/desktop-model-config
- GET：读取该专用 key 的配置与管理 revision；仅 owner + gateway_key:read。
- PUT：完整原子发布；仅 owner + gateway_key:write；需要 reason 和 expectedRevision。
- 首次创建 expectedRevision=0；并发冲突 409，不能最后写入者静默覆盖。
- 管理请求形状：{ enabled, expectedRevision, reason, defaultModel, models }。
- models 条目形状与消费响应相同；id 是 P7 已有 alias，不是上游原始 model id；默认值必须在有效集合内。
- enabled=false 时 models=[]、defaultModel=null；同一事务清空该 key 的显式 allowlist，并保持 allows_all_aliases=false。
- enabled=true 且 models=[] 亦允许发布空名单，defaultModel 必须 null。
- 启用 DSH 管理即将该专用 key 切为显式 alias allowlist，allows_all_aliases=false。models 中的 alias 全部验证同 owner、已发布且 enabled；更新关联表与分发配置同事务提交并审计。
- 仅 opt-in 的专用 key 受此接口管理，其他 key、已有 /v1/models、Codex bootstrap 行为不改。
- 在现有 key 重置（同 key id）时保留分发配置，在重发产生新 key id 时要求显式复制 DSH 配置/allowlist，旧 key 撤销；不得新 key 默认允许所有 alias。
- 请求的 api、streaming、tools、inputModalities 以及容量必须与实际可达路线相容。缺能力或容量依据时不得当成完整 Agent 模型发布。
- 元数据放分发配置中；不恢复已删除的 upstream model context_window 字段，不改全局容量语义。

## 3. 客户端消费接口（Qorder）

GET /v1/desktop/model-config
Authorization: Bearer p7k_...
Accept: application/json
If-None-Match: "<上次有效 ETag>"（可选）

成功 200：
- Content-Type: application/json
- Cache-Control: private, no-cache
- ETag: "<有效 revision>"，与响应 revision 的 quoted 表示一致。
- Vary: Authorization

响应字段：
| 字段 | 规则 |
|---|---|
| schemaVersion | 固定 1；新版本客户端不认识则拒绝应用 |
| revision | 不透明稳定字符串；反映当前 key 可见的有效快照，不含 key 明文 |
| enabled | 当前 key 是否启用 DSH 模型下发 |
| defaultModel | 允许集合中的 alias；空集合为 null |
| models | 有序模型数组，最多 128 个；alias 不重复 |
| models[].id/displayName | 网关 alias / 管理员选择的名称；不写死 Qwen、Gemini 等 |
| models[].api | openai-completions、openai-responses、anthropic-messages 三选一 |
| models[].contextWindow/maxOutputTokens | 正整数；输出上限不能大于上下文。由管理员依据真实路线设置，不能从品牌名猜测 |
| models[].inputModalities | 至少含 text；image 仅确有支持才下发 |
| models[].streaming/tools | v1 Agent 目录均要求 true；不支持的模型不进入本期可用目录 |
| models[].reasoningEfforts | 可选，false 或受支持档位到 wire 参数的映射；未配置时不擅自添加推理参数/档位 |

其他状态：
- 304：必须先完成 key 身份与权限验证；仅有效快照未变化时返回，空 body。DSH 没有相应有效本地快照时发起一次不带 ETag 的读取。
- 401：key 不合法/过期/撤销。
- 403：合法 key 但从未登记 DSH 用途（没有分发记录）、策略拒绝或不可访问。已有分发记录但 enabled=false 时返回 200 的 disabled 快照。
- 429/5xx：保留客户端最近有效快照，显式显示未同步；不凭错误生成空名单。
- 错误响应只含稳定 error.code、可安全展示的 message 与 requestId；不得回显 key。

成功响应可见集合必须与网关权限一致，且仅包含已启用/发布并满足本期 Agent 能力的路线。无可用 alias 返回 200 + models=[] + defaultModel=null，而非随便补一个模型。
被停用/删除/改路线的 alias 不能由于管理员未再次点“发布”而留在旧 ETag 内；effective revision 至少纳入 key 状态、分发配置、有效 alias 发布状态及相关能力投影。
若管理员指定默认 alias 后该 alias 被移除，服务对非空集合选择已发布顺序中的第一个有效项作为新 defaultModel，并改变 revision；这是默认配置修复，不代表自动切换进行中的会话。

## 4. 推理与客户端映射（Codex）

baseURL 固定为连接 origin + /v1（origin 不含路径）。
- openai-completions → POST /v1/chat/completions
- openai-responses → POST /v1/responses
- anthropic-messages → POST /v1/messages

alias 不做解析/改写。DSH 按 api 分组创建自己拥有的 provider：p7-company-chat、p7-company-responses、p7-company-messages；credential-ref 指向当前 profile 的 P7 专用 key。
api 分组意味着底层厂商完全由 P7 决定，Gemini 也可经 P7 兼容接口提供。Google 原生协议本期不进客户端。
models[].contextWindow → PiAiModelProfile.contextWindow；
maxOutputTokens → maxTokens（能力，不强行重设用户每次请求上限）；
inputModalities → input；
reasoningEfforts 仅在有声明时映射。
变更候选先完整校验，再原子替换 P7 管理的 provider 子树；不能删除其他 provider。route id 冲突或 home/argv 不允许写入则报告失败，不绕开现有 Config 验证。

## 5. 同步、默认值与停用

- 启动同步；正常每 60 秒一次，单实例不重叠请求，10 秒超时；失败按 60/120/240/300 秒退避。后台正常发布后下一次正常轮询生效目标 ≤70 秒。
- 界面有立即同步、最近成功时间和已应用 revision。MVP 不建服务端“所有设备已应用”看板。
- 用户没有明确选择的新会话采用当前管理员 defaultModel；已有会话保持其选择，不强切进行中的请求。
- 当前模型被删除：不杀已在执行的请求；下一次发起前提示模型不可用并要求用户另选。不静默改用默认模型。
- 合法空名单/disabled 快照：卸载 P7 公司 provider、阻止新公司请求；不回退其他供应商。
- 401/403：阻止新公司调用，展示重新连接状态；清除托管 route 可用性及内存 key，等待用户重连。
- 网络/格式错误：最近有效模型可保留用于向 P7 发起请求，但状态必须显示过期/同步失败；服务端仍决定调用是否允许。没有有效快照则无公司模型可用。
- 生效 revision 与 ETag 只在运行时配置确实应用成功后提交。崩溃重启先恢复最近有效配置，再异步同步。
- 更换 origin/key 或断开：取消旧请求、旧 poll generation 失效、清掉旧 P7 routes 与 ETag，再应用新连接；旧响应不能写进新连接。

## 6. 跨字段校验与兼容

JSON Schema 覆盖结构；实现还须校验 id 唯一、默认值属于集合、text 存在、maxOutputTokens≤contextWindow，以及完整响应大小≤256 KiB。
reasoningEfforts 的 key 仅限上游已支持档位；wire 值由 P7 管理员依据真实路线设置，DSH 不猜厂商方言。
未知字段按 schema 拒绝，接口扩展通过 schemaVersion 协商，不让任意 provider options、headers、脚本/YAML 或命令从服务端进入客户端。
DSH 不执行服务端下发的代码、包管理或 arbitrary URL。

## 7. 联调 fixture

- model-config-v1.example.json：两个合成测试模型，显示名称使用用户示例；容量、alias、revision 和能力均为测试数据，禁止直接发布到生产。
- 两边需增加：单模型、空集合、disabled、非法默认、重复 alias、未知 api、未知 schemaVersion、非法容量、304、401、403、超时、连接切换迟到响应。
- 完成标准：真实调用的请求 model 等于下发 alias，供应商原始 key 从未下发；服务端撤权直接调用同样拒绝。
