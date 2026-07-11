# Provider/模型运行时/协议转换 —— cc-haha 对齐差异审计

- spec = `~/Desktop/cc-haha-ref` 当前源码(src/services/api/**、src/server/proxy/**、src/server/services/provider*、src/utils/model/**)
- 现状 = `ts/src/proxy/**`、`ts/src/model/**`、`ts/src/server/services/providerService.ts` + `providerHealthStore.ts`、`ts/src/model/fetchRetry.ts`
- 方法:两边源码亲读(未跑测试、未改文件)。

## 架构前提(判分类前必须知道,否则会误判一堆"gap")

cc-haha 的核心循环**只会说 Anthropic 协议**:CLI 内核直接用官方 `@anthropic-ai/sdk` 打 `/v1/messages`。要接非 Anthropic 供应商时,它在本机起一个**独立 HTTP 代理进程**(`standaloneProviderProxy.ts` → `handler.ts`),把 Anthropic 请求翻成 OpenAI chat/responses、把 OpenAI SSE **逐字节重建成 Anthropic SSE 帧**(`message_start/content_block_*/message_delta/message_stop`)回给 CLI 内核,内核全程不知道自己在跟非 Anthropic 供应商说话。

我们的架构是**同进程内嵌 Model 接口**:`harness/loop.ts` 直接调 `Model.step()`(一个返回 `AssistantStep` 的 async 函数),`ProxyModel`/`AnthropicMessagesModel` 内部把 OpenAI/Anthropic-compatible SSE 累积成内部 `AccumulatedResponse` 对象再转 `AssistantStep`,从不重建 Anthropic 协议 SSE 字节流对外广播(`onDelta` 回调直接把逐 token 增量塞回调用方,不走 wire protocol)。

→ **"SSE stream chunk 拼装成 Anthropic 协议帧"这件事本身在我们架构里不存在对应物,是 intentional-delta(架构差异),不是 gap**。但"SSE 累积语义要不要正确"(tool_use 分片配对、thinking 通道、error 帧识别、空闲超时)仍是两边都要做对的等价问题,逐项对比如下。

同理 cc 的 `providerService.ts`(单 active provider、用户手动切换、CRUD + 测试连通性)对应我们的 `providerService.ts`(BYOK saved providers CRUD),这块基本对齐;但我们额外建了 cc 完全没有的**多 provider 运行时健康冷却/自动 failover 系统**(`providerHealthStore.ts` + `orderRuntimeProvidersForAttempt`),这是我们自己的产品创新,cc 无对应实现可比对,同样按 intentional-delta 处理(不是"抄漏了",是"cc 没有这东西")。

---

## 发现表

| 行为点 | cc + file:line | 我们 + file:line 或"缺" | 分类 | P | 工作量 |
|---|---|---|---|---|---|
| Anthropic↔OpenAI chat 请求方向翻译(system/tools/tool_choice/thinking→reasoning_effort) | `src/server/proxy/transform/anthropicToOpenaiChat.ts:33-123` | `ts/src/proxy/toOpenAiChatRequest.ts:22-41` | aligned | - | - |
| user 消息 tool_result→独立 tool 消息、image_url 多模态回灌 | `anthropicToOpenaiChat.ts:151-205` | `toOpenAiChatRequest.ts:53-101`(额外支持 PDF/document 块,cc 无) | aligned(我们更全) | - | - |
| assistant 消息 tool_calls 编码 | `anthropicToOpenaiChat.ts:207-246` | `toOpenAiChatRequest.ts:119-136` | aligned | - | - |
| **DeepSeek-reasoner thinking round-trip**(`roundTripReasoningContent`/`passThinkingToggle`,按 baseUrl 正则探测 deepseek/opencode.ai,回灌上一轮 thinking 块为 `reasoning_content`) | `anthropicToOpenaiChat.ts:21-24,74,113,219`;探测 `handler.ts:422-427` | 缺——我们 `toOpenAiChatRequest.ts:131` 显式"thinking:默认不回灌(display-only)",无按端点开关 | **gap** | P2 | S |
| text_only image content mode(端点不吃多模态时降级) | `handler.ts:272,430`(deepseek/opencode.ai 自动探测) | `ts/src/model/providerConfig.ts` `imageContentMode` 字段(需显式配置,非自动探测) | aligned(手动挡位替代自动探测,能力等价) | - | - |
| OpenAI chat SSE → 内部累积:text/thinking(三方言 reasoning_content/reasoning/thinking_blocks 归一)、并行 tool_calls 按 index 分片、finish_reason | cc 侧是 SSE→Anthropic SSE 重建:`src/server/proxy/streaming/openaiChatStreamToAnthropic.ts:260-458` | `ts/src/proxy/streamAccumulate.ts:44-138`(累积成对象而非重建 SSE,语义等价);15 条测试覆盖并行工具/跨 chunk 断行/坏 JSON/缺 id 自造/reasoning 三方言 `ts/src/proxy/streamAccumulate.test.ts:18-218` | intentional-delta(架构不同,内容语义对齐) | - | - |
| **SSE 中途 error 帧识别**(`{"error":{...}}` 不静默吞成截断空响应,抛错触发降级/重试) | 无直接对应(cc 用官方 SDK,SDK 内部处理);我们自己 commit `600d34b` 移植的意图对齐"cc 语义" | `ts/src/proxy/streamAccumulate.ts:20-26,106-110`(`StreamProviderError`)——**仅 OpenAI chat 路径有**;`ts/src/model/AnthropicMessagesModel.ts:319-354` 的 `handleEvent` 完全不处理 `event.type === 'error'`,静默吞成空 final | **deviation(我们自己代码内部不一致)** | **P0** | S |
| **流空闲超时**(卡死的 SSE body 兜底) | 官方 SDK 内建;我们 commit `8c195d2` 意图"跟随 aiRequestTimeoutMs" | `ProxyModel.ts:136-140` 用 `withStreamIdleTimeout` 包住 body;`modelFactory.ts:30-42` 只把 `idleTimeoutMs` 传给 `ProxyModel`,`AnthropicMessagesModelConfig`(`AnthropicMessagesModel.ts:11-34`)**根本没有 `idleTimeoutMs` 字段**,`readResponse`/`accumulateAnthropicStream`(line 192-200,298-397)裸读 `reader.read()`,无任何超时兜底——一旦 headers 收到后连接卡死,`fetchWithTimeout` 的 timer 早已在 `finally`(line 186-188)里被清掉,永久挂起 | **gap(单文件内未补齐,cc 语义 + 我们自己 ProxyModel 先例都要求有)** | **P0** | S |
| Anthropic-format SSE 累积测试覆盖 | - | `AnthropicMessagesModel.test.ts` grep "idle/error frame" **0 命中**,零测试覆盖上面两个洞 | gap(测试债) | P0 | S |
| 重试/退避(withRetry 核心指数退避语义:408/429/5xx 可重试,Retry-After,4xx/超时不重试) | `src/services/api/withRetry.ts:746-837`(`shouldRetry`)+`580-598`(`getRetryDelay`),**默认开启**(`DEFAULT_MAX_RETRIES=10`,`getDefaultMaxRetries` 无条件生效,`withRetry` 是 claude.ts 唯一请求路径,不可关) | `ts/src/model/fetchRetry.ts:56-88`(`fetchWithModelRetry`)逻辑移植到位(核心退避语义等价,砍掉 OAuth/AWS/GCP/fast-mode/subscriber 分支——这些是 Claude 账号体系专属,属意料内裁剪);但 **opt-in 且从未被任何调用方启用**:`ProxyModel.ts:38-39,101-103`、`AnthropicMessagesModel.ts:27-28,120-122` 都是"仅当 `cfg.retry` 显式配置才重试",全仓 grep `providerConfig.ts`/`modelFactory.ts`/`providerService.ts` 均未设置 `.retry`,默认路径下单次 fetch 失败即抛给 `FallbackModel` 切出口,**从不在同一供应商内重试瞬时抖动** | **deviation → decision(owner 未拍板)** | **P1** | S(把 opt-in 接成默认开,或显式拍板"保持关") |
| withStreamRetry(流创建阶段外的 mid-stream 瞬时错误重试,复用整个 attempt) | `src/services/api/streamRetry.ts:48-94` | 缺——我们没有对应的"整轮 attempt 重试"层;`StreamProviderError` 抛出后直接冒泡给 `FallbackModel` 切供应商(粒度更粗:换出口而非同口重试) | intentional-delta(与上面 retry 未开是同一决策——FallbackModel 顶替了"同口重试"这层,见下方"已知待办核对") | P2 | - |
| streaming→non-streaming fallback(空流/tool_use 无完整块时降级非流式重发) | `src/services/api/claude.ts:841-944`(`getNonstreamingFallbackTimeoutMs`)+ `streamFallback.ts:1-13`(`shouldTriggerNonStreamingFallbackForEmptyStream`) | 缺——我们的 `ProxyModel`/`AnthropicMessagesModel` 没有"流式空/异常→自动降级成非流式重发"这一层;空流会被当成空 final 直接返回(除非命中上面的 error 帧检测) | gap | P2 | M |
| 输出长度上限升级重试(max_tokens 撞顶、无 tool_calls 时提额重试一次) | `claude.ts` escalate 逻辑(query.ts:1196-1229 对应处) | `ProxyModel.ts:73-84`、`AnthropicMessagesModel.ts:98-107`(`ESCALATED_MAX_TOKENS=64_000`,对齐) | aligned | - | - |
| 529/opus-only 单模型 fallback(`fallbackModel` 字符串,MAX_529_RETRIES=3 才切) | `withRetry.ts:376-415`、`query.ts:901-953` | 无直接对应——我们不区分"529 专属单模型 swap",走通用 `FallbackModel` 多候选轮询(任意失败即切,不限 529) | intentional-delta(我们方案更通用,cc 这条是 Claude 订阅体系专属逻辑,产品边界排除) | - | - |
| **failover:active→saved fallbacks→env fallback 链** | 无对应(cc 是单 active provider,用户手动切换,无自动多供应商链) | `ts/src/server/services/providerService.ts:311-330`(`resolveRuntimeConfigs`):active 优先→其余 enabled saved→env 兜底,顺序确认无误 | intentional-delta(我们自建,cc 无此设计可比对) | - | - |
| 健康冷却/失败分类(configuration/rate_limit/transient)+ 冷却时长曲线 | 无对应 | `ts/src/server/services/providerHealthStore.ts:7,231-248`:401/403/404→configuration(10min×2^n,封顶1h);429/quota→rate_limit(2min×2^n,封顶15min);其余→transient(30s×2^n,封顶5min);落盘 `provider-health.json` 跨进程持久 | intentional-delta(自建,无 cc 对应物;分类粒度、封顶值合理) | - | - |
| sticky fallback(记住上次成功出口,下次优先用) | 弱对应:`query.ts` 单 fallbackModel 字符串本身就是"粘"的(触发后不切回) | `ts/src/model/FallbackModel.ts:26-64` 的 `preferredIndex`(单次 step() 内部候选轮询起点前移)**只在同一 FallbackModel 实例内生效**;`createModelFromRuntimeProviders` 是每轮 HTTP 请求现建(`server/index.ts:1554,2201,2237`),所以 `preferredIndex` **不跨轮持久**——跨轮的"粘性"改由 `providerHealth` 冷却表(落盘、跨轮持久)间接实现:上一轮失败的供应商被 `orderRuntimeProvidersForAttempt`(`server/index.ts:1301-1320`)移到候选队尾,直到冷却到期 | intentional-delta(两层机制分工明确:进程内 preferredIndex 管单轮内多次 step() 调用,跨轮持久冷却表管跨轮)——**非 bug,是有意分层**,备注供下次审计别误判 | - | - |
| prewarm | cc `prewarm_session`(`server/ws/handler.ts:571-620`)是**预启动 CLI 子进程会话**(mobile/远程桥接场景),与"模型供应商探活"无关 | 我们 `/agent/prewarm`(`server/index.ts:2231-2296`)是**探活+预建 FallbackModel+预加载 skills/commands/hooks/mcp**,概念上更接近"会话预热"而非"供应商健康检测"(虽然顺带建了一次 model 但没真的发请求探活) | intentional-delta(同名不同物,概念不对应,非漏做) | - | - |
| usage 统计映射(OpenAI input 含 cache、Anthropic 排除→扣减保不变式) | `src/server/proxy/transform/usage.ts:20-40` | `ts/src/proxy/usage.ts:4-20` | **aligned(逐行一致)** | - | - |
| reasoning_effort 归一(low/medium/high,max→high) | `src/server/proxy/transform/effort.ts:3-13` | `ts/src/model/reasoningEffort.ts:7-11` | **aligned(逐行一致)** | - | - |
| thinking 参数生成(adaptive vs budget_tokens,按模型/env 判定) | `claude.ts:1653-1736`(cc 内部,Claude 专属模型名单) | `ts/src/model/reasoningEffort.ts:58-115`(`buildAnthropicThinking`)——按 MiniMax/Xiaomi MiMo 等国产 Anthropic 兼容端点重新查证 capability,逻辑结构对齐 cc(adaptive/budget/off 三态、env 覆盖、预算夹紧) | aligned(移植到位 + 针对我方供应商重新查证) | - | - |
| tool_use/tool_result 配对清洗(孤儿补占位、跨消息去重、resume 中途孤儿) | `src/utils/messages.ts:5275-5400+`(`ensureToolResultPairing`) | `ts/src/proxy/messagePairing.ts:35-117`——变量命名(`allSeenToolUseIds`→`seenToolUseIds`)、resume 孤儿占位文案、去重口径均对应;8 条测试覆盖(含"跨轮 id 复用后旧 tool_result 变孤儿必须删"这条 cc 标注过 CC-1212 真实事故的场景) | **aligned(逐行核对像素级移植)** | - | - |
| 连续同角色消息合并 + 空 content 消息丢弃 | cc `normalizeMessagesForAPI`(utils/messages.ts:2004) | `ts/src/proxy/messagePairing.ts:11-25`(`normalizeMessagesForAPI`) | aligned | - | - |
| prompt-cache break 检测(系统提示/工具 schema hash diff、TTL 猜因、token drop 阈值) | `src/services/api/promptCacheBreakDetection.ts` 全文件(727 行,含 fastMode/betas/autoMode/overage/cachedMC/effort/extraBody 等 Claude 账号体系专属维度) | `ts/src/context/promptCacheBreakDetection.ts` 全文件(258 行):核心维度(system/tools/model hash diff、per-tool 变更定位、token drop 阈值 `MIN_CACHE_MISS_TOKENS=2000`/`CACHE_DROP_RATIO=0.95`、TTL 猜因 5min/1h)**逐项移植到位**;Claude 专属维度(fastMode/betas/autoMode/overage/cachedMC/effort/extraBody)裁掉——这些概念在 OpenAI-compatible 供应商侧不存在,属意料内裁剪 | aligned(核心维度已落,矩阵§4声称属实) | - | - |
| **TTL 猜因用的"距上条 assistant 消息经过时间"** | `promptCacheBreakDetection.ts:460-463`:`Date.now() - new Date(lastAssistantMessage.timestamp).getTime()`(真实墙钟耗时) | `ts/src/context/promptCacheBreakDetection.ts:91-96`(`lastAssistantAgeMs`):**没有用 `timestamp` 字段算真实耗时**,而是判断"最后一条 assistant 后面还有没有消息"来返回硬编码 `0` 或 `null`——`Message` 类型明明有 `timestamp?: string`(`ts/src/types/message.ts:55`)却没接上;实际效果是 TTL 分支("possible 1h/5min TTL expiry")**几乎永远走不到**,cache-break 诊断文案会系统性地报成"unknown cause"或错误的"0ms"分支 | **deviation(实现 bug,非架构差异)** | P2(只影响诊断日志文案,不影响模型调用本身) | S |
| cache deletion 预告(cached microcompact 主动删缓存前缀时,预期 drop 不算 break) | `promptCacheBreakDetection.ts:669-682`(`notifyCacheDeletion`)+ `state.cacheDeletionsPending` 分支(473-481) | 缺——`ts/src/context/promptCacheBreakDetection.ts` 只有 `notifyPromptCacheCompaction`(对应 cc 的 `notifyCompaction`,235-242 行),没有 `notifyCacheDeletion` 等价物 | gap(仅当我们做"cache_edits 主动删除前缀"这类微压缩时才用得上,当前若无此功能则是 dead gap) | P2 | S |
| 模型名单/context window 表 | `src/utils/model/modelContextWindows.ts:5-59`(167 行,含 claude-* 系列 + kimi-k2.5/k2-0905/k2-turbo/k2-thinking(-turbo)/minimax-m2.7(-highspeed)/qwen3.6-27b/glm-5-turbo/glm-4.7/glm-4.5-air 等 + 4 条额外 PATTERN 正则) | `ts/src/model/modelContextWindows.ts:1-97`——结构/归一化逻辑(`normalizeModelContextKey`/env 覆盖/pattern 匹配)**逐行一致**;数据表**故意不登记 claude-*系列**(注释说明"owner 肯定不接 Claude");但也**漏登了非 Claude 的新条目**:kimi-k2.7-code-highspeed/k2.5/k2-0905-preview/k2-turbo-preview/k2-thinking(-turbo)、minimax-m2.7(-highspeed)、qwen/qwen3.6-27b、glm-5-turbo/4.7/4.5-air,以及 PATTERN 表少 4 条(qwen3.6-max-preview/qwen3.5-plus-flash/qwen3-max/qwen3-coder-next) | gap(数据表漂移,不是结构性缺失) | P2 | S(纯数据同步,抄表即可) |
| max_tokens/max_output_tokens 透传 | cc 不带 max_tokens、交上游默认(注释在 anthropicToOpenaiChat.ts:68-70) | `ProxyModel` 同样不带(`toOpenAiChatRequest.ts:32` 注释一致);`AnthropicMessagesModel` 带 `max_tokens`(Anthropic 协议必填字段,cc 官方 SDK 同样会带) | aligned | - | - |
| OpenAI Responses API(`openai_responses` apiFormat) | `src/server/proxy/transform/anthropicToOpenaiResponses.ts`、`openaiResponsesToAnthropic.ts`、`streaming/openaiResponsesStreamToAnthropic*.ts` 全套 | 完全没有:`ProviderApiFormat` 类型(`providerConfig.ts:5`)只有 `'anthropic' | 'openai_chat'` 两态,无 `'openai_responses'` | gap(范围外,已知) | **P2(按题面口径标注,不升级)** | L |

---

## 已知待办核对结果

1. **"重试默认开(owner 未拍板→标 decision)"** —— **核实属实**。cc 的 `withRetry` 是唯一请求路径且默认 `maxRetries=10`,无法绕过(claude.ts 每次 API 调用都走它)。我们的 `fetchWithModelRetry` 逻辑移植到位,但 opt-in 开关(`cfg.retry`)在全仓没有任何调用方设置——`providerConfig.ts`/`modelFactory.ts`/`providerService.ts` 全部留空,**实际运行时永远是"单次失败即抛给 FallbackModel 切出口"**,不在同一供应商内吸收 429/5xx 瞬时抖动。当前的设计理由(commit e14b464 message)是"避免和 FallbackModel 的跨供应商切换时序打架,留给 owner 权衡切换延迟 vs 单出口韧性"——这个理由本身合理,但**至今没有被拍板**,属于真实悬而未决的 decision,不是"已完成的谨慎设计"。建议:至少给内置 key 走的默认 provider(网关自己控制的出口)默认打开重试(网关侧供应商稳定性我们更清楚),BYOK 自定义供应商可保持关闭或做成用户可见开关。

2. **"流空闲超时接线(是否跟随 aiRequestTimeoutMs)"** —— **部分属实,且发现新洞**。`ProxyModel`(OpenAI-compatible 路径,commit 8c195d2)已正确接好,`idleTimeoutMs` 跟随 `networkSettings.aiRequestTimeoutMs`。但 `AnthropicMessagesModel`(Anthropic-compatible BYOK 路径,例如接 MiniMax/MiMo 的 `/v1/messages` 端点)**完全没有流空闲超时**——`modelFactory.ts` 计算了 `idleTimeoutMs` 却只塞给 `ProxyModel`,`AnthropicMessagesModelConfig` 接口里根本没这个字段。一旦这条链路的连接在收到 headers 后卡死(不返回也不断开),会话会永久挂起,直到用户手动中止。这是本次审计发现的**唯一 P0 级真实功能缺口**(不只是矩阵声称的"接线"问题,是"从未接线")。

3. **"Anthropic 流超时缺失问题"** —— 与上一条是同一个洞,**确认存在**且比预期更彻底:不仅超时缺失,**mid-stream error 帧识别也缺失**(`AnthropicMessagesModel.ts` 的 `handleEvent` 不处理 `event.type === 'error'`),而 OpenAI-compatible 路径的同类洞已经在 commit 600d34b 修过。两个洞加起来:Anthropic-compatible BYOK 供应商中途返回错误或卡死连接时,当前代码要么静默吞成空回复(模型"没说话"的假象,循环无法识别为失败去触发 FallbackModel 切出口),要么永久挂起。`AnthropicMessagesModel.test.ts` 对这两点零覆盖,证实这不是"测过但没暴露",是真的没做。

4. **"Responses API 缺口"** —— **核实属实,范围外**。cc 有完整的 `anthropicToOpenaiResponses`/`openaiResponsesToAnthropic`/流式转换三件套,我们的 `ProviderApiFormat` 类型里完全没有 `openai_responses` 选项。按题面口径标 gap-P2,不升级——只有当 BYOK 用户接入的供应商只暴露 Responses API(不提供 Chat Completions 兼容层)时才会真的卡住,当前已知主力供应商(MiMo/豆包/DeepSeek/GLM/Kimi/MiniMax)均有 Chat Completions 端点,不阻塞当前产品线。

---

## 分类计数

- aligned: 15
- gap: 8(DeepSeek thinking round-trip P2 / streaming→non-streaming fallback P2 / cache deletion 预告 P2 / context window 表漂移 P2 / Responses API P2 / AnthropicMessagesModel 空闲超时 P0 / AnthropicMessagesModel 测试覆盖 P0 / TTL 墙钟计算 bug P2)
- deviation: 2(AnthropicMessagesModel error 帧检测缺失 P0 / 重试 opt-in 未启用 P1,后者同时也是 decision)
- intentional-delta: 8(SSE 累积架构差异 / withStreamRetry 层级差异 / streaming fallback 未做同架构差异 / 529 单模型 fallback / failover 三级链 / 健康冷却分类 / sticky fallback 双层机制 / prewarm 概念不对应)
- decision(未拍板): 1(重试默认是否打开)

## P0/P1 清单(按严重度)

- **P0-1**:`AnthropicMessagesModel` 无流空闲超时 —— 卡死连接永久挂起会话(`ts/src/model/AnthropicMessagesModel.ts:192-200,298-397`,`modelFactory.ts:30-42` 未传参)
- **P0-2**:`AnthropicMessagesModel` 无 SSE error 帧识别 —— 中途报错被静默吞成空回复,FallbackModel 侦测不到失败(`AnthropicMessagesModel.ts:319-354`)
- **P0-3**:上述两点零测试覆盖(`AnthropicMessagesModel.test.ts`)
- **P1-1**:瞬时错误重试 opt-in 从未启用,单出口韧性为零,需 默认策略(`ProxyModel.ts:101-103`、`AnthropicMessagesModel.ts:120-122`,调用方均未设 `.retry`)
