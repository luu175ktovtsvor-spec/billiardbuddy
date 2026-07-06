# W2 返工 + W6 proxy 层 · findings（内核换 Anthropic 格式 + 国产模型不崩底盘）

> 📌 状态:✅现行 · 2026-07-06 落地(ts-harness-rewrite 分支,未 push、未并 main)
> 实现计划:`docs/plans/TS-W2返工+W6proxy-实现计划-2026-07-06.md`。上级 spec:主文档 §0.5/§2/§11 + `05-cc-haha能抄清单` ①。
> 全绿:`cd ts && bun test` → 185 pass / 0 fail;`bun run typecheck` clean。
>
> ⚠️ **方向修正（2026-07-06 · owner+审计后定，晚于本窗施工）**：主路径 = **内核 Anthropic 直连各家 Anthropic 端点**（MiMo `/anthropic`、豆包 `/api/coding`，都提供 Anthropic `/v1/messages`），**零翻译**。本文档描述的 Anthropic→OpenAI 翻译层**降级为"只给纯 OpenAI 端点模型"的兜底**——**W10 落地时把主路径接成直连 Anthropic 端点，别默认走翻译层**（否则白饶一圈、还可能踩 reasoning 400）。详见主文档 §0.6-1。

## 一、内核已换 Anthropic content-block(W2 返工)

- 消息类型 `ts/src/types/message.ts` 重写:`Message = { role:'user'|'assistant'; content: ContentBlock[] }`,`ContentBlock` ∈ `text`/`thinking`/`tool_use`/`tool_result`。**`content` 恒为块数组**(不用 `string|Block[]` 双态);**`role:'tool'` 已彻底消失**(全仓 grep 0 命中,除文档注释);`system` 是 `ModelStepInput.system` 独立字段、不是一条消息。
- 主循环 `ts/src/harness/loop.ts`:assistant 历史 = text 块 + tool_use 块(**thinking 块不进历史、不回灌模型**,仅作展示 event);一批 tool_call 的结果装进**单条 user 消息**(所有 tool_result 块 + steering/reminder 作尾随 text 块),保证 tool_result 紧贴 tool_use、user/assistant 严格交替。
- 工具错误回灌:未知工具 / 执行抛错 → `tool_result{is_error:true}` 且 content 包 `<tool_use_error>…</tool_use_error>`(OpenAI 侧无 is_error 字段,文本包壳是国产模型能看到的唯一报错信号);权限 deny / 审批 pending → 普通 tool_result(不当报错)。
- `model.ts`:`AssistantStep` 加 `thinking?`;`reminders.ts`:`drainSteering(ctx)` 改为只返原文、由循环建块 + `steerBlock` helper。
- 契约不变:`runAgentLoop(opts)` 仍收 `systemPrompt`/`userMessage` 字符串;`executeApproved`/`handleReject` 签名不变。

## 二、proxy 双向翻译层 + 不崩底盘(W6 · 新建 `ts/src/proxy/`)

| 文件 | 职责 | 照 cc-haha |
|---|---|---|
| `types.ts` | OpenAI chat 协议类型 + `AnthropicUsage`(Anthropic 块复用 message.ts) | `transform/types.ts`(OpenAI 部分) |
| `toolArguments.ts` | args 字符串/对象容错 + `{raw}` 兜底 | `transform/toolArguments.ts`(逐字) |
| `usage.ts` | OpenAI→Anthropic usage 归一(cache 命中从 input 扣减保不变式) | `transform/usage.ts`(逐字) |
| `toOpenAiChatRequest.ts` | **出方向**:内核 Anthropic 块 → OpenAI chat 请求(tool_result→tool 消息;thinking 不回灌;单 text 折串;text_only 图片占位) | `transform/anthropicToOpenaiChat.ts`(适配扁平结构) |
| `streamAccumulate.ts` | **回方向·流式**:OpenAI SSE → 内部块累积 | `streaming/openaiChatStreamToAnthropic.ts`(改累积目标) |
| `openaiChatToAnthropic.ts` | **回方向·非流式**:JSON 响应 → 同构 `AccumulatedResponse`(错误/非 SSE 兜底) | `transform/openaiChatToAnthropic.ts` |
| `messagePairing.ts` | 消息配对清洗(合并连续同角色/去重 id/补孤儿 tool_use/删孤儿 tool_result) | `utils/messages.ts:2004/5275`(简化版) |
| `streamIdleTimeout.ts` | 流卡死空闲超时(逐块重置计时,超时 cancel+error) | `server/proxy/handler.ts:103`(逐字) |
| `ProxyModel.ts` | `Model` 出口:清洗→翻译→fetch(stream)→空闲超时→累积→`AssistantStep`;非 SSE 走非流式;非 2xx 抛错。可注入 `fetchImpl`/`idFactory` | (进程内 Model,无 1:1 cc-haha 对应) |

**「不崩」机制落点对照(05 清单① 逐条)**:
- 消息配对清洗 → `messagePairing.ts`(`normalizeMessagesForAPI` 合并/丢空 + `ensureToolResultPairing` 补/删/去重)。✅
- 流式工具调用分片累积 + **缺 id 自造** → `streamAccumulate.ts`(`Map<index>` 累 id/name/args;收尾对有 name 无 id 的碎片用 `idFactory(index)` 自造)。✅ ⚠️见偏差 A。
- reasoning 三方言归一 → `streamAccumulate.ts:extractReasoning`(+ `openaiChatToAnthropic.ts`):`reasoning_content`/`reasoning`/`thinking_blocks`。✅
- args 容错 + `{raw}` 兜底 → `toolArguments.ts`。✅
- 工具错误一律 `<tool_use_error>` 回灌不崩 → `loop.ts:gateOneCall`。✅
- 退出信号看 tool_use 有无、不信 finish_reason → `ProxyModel.ts:toAssistantStep`(`kind = toolCalls.length>0 ? 'tool_calls':'final'`)。✅(有专测:`finish_reason:'stop'` + tool_calls → 判 `tool_calls`。)
- 流卡死空闲超时 → `streamIdleTimeout.ts`。✅
- tool_result 紧贴 tool_use → `loop.ts` 单条 user 装齐 + `messagePairing` 兜底。✅
- **压缩失败连续 3 次熔断 → ⛔本窗不做,移交 W7**(见下"移交项")。

## 三、与 cc-haha 的有意偏差(behavior-alignment 是唯一硬闸,偏差都往「更稳」偏)

- **A. 缺 tool_call id 自造(改进,非照抄)**:cc-haha `openaiChatStreamToAnthropic` 要 `id && name` 才开工具块 → 不给 id 的国产模型工具调用被**静默丢弃**(args 累了又扔)。我们改成「有 name 就收、缺 id 收尾自造 `call_{index}_{seq}`」。默认 `idFactory` 用模块级递增计数器(非裸 `Date.now()`),保证跨响应唯一(否则会被 messagePairing 去重误删)。测试注入确定性 factory。
- **B. 进程内累积成 `AssistantStep`,不 emit Anthropic SSE**:cc-haha proxy 是 HTTP 服务器、输出 Anthropic SSE 给 Claude Code 客户端解析;我们的 `Model.step` 在进程内被循环直接调,故复用 cc-haha 的分片/归一**状态机逻辑**、但累积目标换成内部块(省掉「序列化 Anthropic SSE 再解析回来」的浪费)。
- **C. `messagePairing` 是简化版**:去掉 cc-haha 的 `server_tool_use`/`mcp_tool_use`/statsig 门/HFI strict 分支(我们没有这些块型),保留核心:合并连续同角色、去重 tool_use/tool_result id(跨消息,`allSeenToolUseIds`,对齐 cc-haha CC-1212 修复)、forward 补合成 `is_error` 占位、reverse 删孤儿、起始孤儿保 `role:'user'` 占位防角色翻转、清空后保占位 user 维持交替。
- **D. `handleChunk` 整体进 try/catch(比 cc-haha 更稳)**:cc-haha 只 catch `JSON.parse`;我们把 `handleChunk` 也纳入,合法 JSON 但坏形状(`data: null`、`tool_calls:[null]`、`thinking_blocks:[null]`)也跳过不崩(单块畸形不丢整段)。作用域仅限单行处理,读循环真 bug 仍会抛(不掩盖)。
- **E. thinking 不回灌模型**:对齐 cc-haha 默认 `roundTripReasoningContent=false`(国产 reasoning 无 signature、display-only),也符合白标(思考只展示不喂回)。

## 四、移交项(本窗不做、明确交给对应窗口)

- **W7 抗失忆栈**:① **压缩失败连续 3 次熔断**(cc-haha `autoCompact.ts:70`)——熔断对象是压缩,本窗无压缩底物,建后即接;主循环跑飞本窗已由 `max_turns` 兜底,owner 内置 key 在本窗不裸奔。② 9 节结构化摘要 / 分级压缩 L1-L4 / 大结果落盘。
- **W10 模型出口+网关+编排**:构造 `ProxyModel({baseUrl,apiKey,model,...})` 的真实 config、网关路由、多 provider 注册/适配器、跨模型降级、temperature/top_p/tool_choice 等旋钮(本层 `ModelStepInput` 未带,故 `toOpenAiChatRequest` 未映射);**模型调用级重试/failover**(`ProxyModel.step` 现在非 2xx/网络错**会抛**、循环不 catch model.step → 交 W10 的 failover 层兜)。
- **W5 审批恢复流**:`executeApproved` 返回纯 output 字符串;把它包成 tool_result 块、带 `tool_use_id` 重注入会话是审批恢复流的活(需要 tool_use_id,本层没扩责)。
- **W16 前端**:token 级流式(现在 `model.step` 是整步返回、thinking/text 作单个 event,非逐 token)+ reasoning/token 事件细分。

## 五、已知 Minor / 未来硬化候选(各单元评审累积,非阻断)

- **[跨切·建议统一硬化]** 畸形 `thinking_blocks` 元素(如 `[null]`)在 `openaiChatToAnthropic.ts`(非流式)会抛崩调用方;`streamAccumulate.ts`(流式)已被偏差 D 的 try/catch 兜住 → **两路不对称**。建议给两处 `extractReasoning` 对「非对象数组元素」加守卫(1 行,比 cc-haha 更稳,owner 不崩优先允许)。
- `messagePairing`:缺「文字轮 + 纯文字 user 原样透传」回归测试(plain chat 现首次走 synth/cleaned/merge 共享机器,逻辑已验对,建议补 `toEqual` 防未来改坏 common path)。
- 覆盖缺口(实现均验对,纯补测):`usage.ts` cache_creation 减法/`Math.max(0)` 下限;`toOpenAiChatRequest` 空 system/空 content 兜底/多 part 分支/assistant 仅 tool_use→content:null;`openaiChatToAnthropic` usage 传播/错误体兜底;`loop.test` deny/pending 在 ToolResultBlock 层断言 `is_error` 假。
- `fakeModel.ts:scriptedModel.received` 存 live 引用:对 messages 做点态断言会假过(Part A 测试已用 `.slice()` 规避)。建议内部存 `input.messages.slice()` 或加文档注释防未来踩坑。
- `streamAccumulate.ts` `delta` 双 cast(纯风格)。

## 六、真机 smoke(不进自动化套件)

本窗自动化测试全 hermetic(注入 fake fetch 喂罐装 SSE、不进网络)。真链路验证需 W10 的真实端点/key/网关路由,本窗不做。要手动核真链路:构造 `new ProxyModel({ baseUrl, apiKey, model })` 指向国产 OpenAI 兼容端点(MiMo/豆包,base_url/key 见仓库外 `server/.env.usrelay.local` 或网关令牌),发一句「你好」+ 一次工具调用验证。**别把它加进 `bun test`**(需网络+花钱)。
