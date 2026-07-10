# cc-haha 对齐差异审计 · 可观测性 / 错误恢复 / stuck 检测 / 成本追踪

规格源:`~/Desktop/cc-haha-ref`(当前源码)。现状:`/Users/swl/Desktop/球房运营AI助手-桌面版/ts`(工作树)。只读审计,均为亲读源码后结论。

## 发现表

| # | 行为点 | cc + file:line | 我们 + file:line 或"缺" | 分类 | P | 工作量 |
|---|---|---|---|---|---|---|
| 1.1 | 调试日志落盘(每 session 一个 `.txt` + `~/.claude/debug/latest` 符号链接,支持 `--debug`/`--debug-file`/`CLAUDE_CODE_DEBUG_LOGS_DIR`) | `src/utils/debug.ts:135-236`(getDebugWriter/getDebugLogPath/updateLatestDebugLogSymlink) | 缺。`ts/src` 里没有任何集中式调试日志模块;`grep console.error/warn/log` 全仓只命中 4 个文件(computerUse/2、server/index.ts、sandbox/windowsLauncher.ts),均为零散 ad hoc 输出,无落盘、无 session 归档 | gap | P0 | M |
| 1.2 | 调试日志级别过滤(verbose/debug/info/warn/error,`CLAUDE_CODE_DEBUG_LOG_LEVEL` 可调) | `src/utils/debug.ts:18-40` | 缺(同上,无日志系统可谈级别) | gap | P1 | S |
| 1.3 | 内存态最近错误环形缓冲(`getInMemoryErrors`,上限 100 条,供 bug 报告/前端展示) | `src/utils/log.ts:64-77, 202-204` | 缺 | gap | P1 | S |
| 1.4 | 持久化错误 JSONL(`~/.claude/errors/<date>.jsonl`) | `src/utils/errorLogSink.ts:29-31, 111-126` | 缺;但 ⚠️ cc 自己这条也只对 `USER_TYPE==='ant'`(Anthropic 内部员工)生效(`errorLogSink.ts:112`),普通用户同样不落这份文件 | intentional-delta | P2 | S |
| 1.5 | 诊断日志静默回传自有服务器(项目既定产品线) | 范围外(不算 cc 范围) | 已有产品方向(见 memory `silent-log-upload-fully-private`),但 `dataeye` 上报重接在 ts 侧尚未落地(CLAUDE.md「在建」task#13/#16);目前是 1.1 的替代方案**也未接通**,叠加放大 1.1 的影响面 | decision(方向) / gap(落地) | P0 | — |
| 2.1 | `tool_call`/`tool_result` 事件线上形状:是否带 id/耗时/时间戳 | 权限决策记录带 `messageId`/`toolUseID`/等待耗时(`src/hooks/toolPermission/permissionLogging.ts:20-26, 91-104, 181-235`),另有独立 API 级 trace(见 2.3) | `ts/src/types/events.ts:30,32`:`tool_call{tool,input}` / `tool_result{tool,output}` — 无 id、无 duration、无 timestamp,前端/日志侧拿不到单次调用的耗时或稳定关联键(tool_use.id 只在内部 messages 数组里,不上 SSE 线) | gap | P2 | S |
| 2.2 | 工具事件的 agent_id 归属(hook payload 里带 `agent_id`/`agent_type`) | `src/utils/hooks/execAgentHook.ts:54-55,121-127`、`hooksConfigManager.ts:120,130` | `ts/src/hooks/hooks.ts:311,319,384,394` + `hookConfig.ts:170` 同样把 `agentId` 编进 hook payload(`agent_id` 字段) | aligned | — | — |
| 2.3 | API 调用级完整 trace 捕获(request/response body 快照 + sha256 + 敏感字段脱敏 + per-session 汇总 + 可视化 Trace 页面) | `src/services/api/traceCapture.ts` 全文件(1070 行,`TraceCallRecord`/`TraceEventRecord`/`TraceSessionSummary` 等完整结构),desktop 侧 `desktop/src/pages/TraceSession.tsx` 等渲染 | 完全没有此概念;工具执行错误只在 tool_result 里回灌文本,没有独立的"这一次 HTTP 调用发了什么/收了什么"快照可查 | gap | P2(偏调试工具而非核心 harness,故非 P0/P1) | L |
| 2.4 | 拒绝/批准计数 + "拒够了就别再问"降级 | `src/hooks/toolPermission/permissionLogging.ts`(主要 fan-out 到 Statsig/OTel,范围外;`sourceToString`/`logPermissionDecision` 决策数据仅短暂挂在 `toolUseContext.toolDecisions`,不落盘) | `ts/src/permissions/denialTracking.ts` 全文件:按 conversationId 计数(`perAction:2, global:20`),`shouldStopAsking`/`recordDenial`/`recordApproval`,同样纯进程内、不落盘 | aligned | — | — |
| 3.1 | 运行时循环内"重复调用/多轮不进展"检测(同一 tool_use 连续 N 次、连续报错、连续多轮不动手只说话) | 无对应机制。全仓检索 `same.?call\|repeat.*tool\|loop.?detect\|stuck.*loop` 均无命中;唯一的 `/stuck` 是 **ant-only** 手动诊断斜杠命令,诊断对象是"另一个 Claude Code 进程有没有卡死(CPU/RSS/进程状态)",与"模型在循环里打转"是两回事(`src/skills/bundled/stuck.ts:61-64` 直接 `if (process.env.USER_TYPE !== 'ant') return`) | `ts/src/harness/stuckDetector.ts` 全文件 + `ts/src/harness/loop.ts:735-742` 接线:4 种模式(`action_observation` 同调用重复≥4/40次、`action_error` 连续3次报错、`monologue` 连续3轮不调工具、`too_many_tools` 累计40次无进展),命中后软提醒注入 `<system-reminder>`,不硬拦 | intentional-delta | — | — |
| 3.2 | OS 进程级卡死诊断(ps/CPU/RSS/僵尸态排查 + 上报 Slack) | `src/skills/bundled/stuck.ts`(ant-only) | 缺,但这是 Anthropic 内部运维工具,不属产品能力范围 | 范围外 | — | — |
| 4.1 | 模型 API 错误分类 + 人话文案(429/401/403/404/413/500/529/超时/连接/SSL,各自独立 businessErrorCode + 建议文案) | `src/services/api/errors.ts` 全文件(~1150 行);例如 429 限流(521-625)、413 payload 过大(732)、401/403 鉴权(915-959)、404(979)、timeout/rate_limit/overloaded 归类(1049-1079) | `ts/src/model/AnthropicMessagesModel.ts:126`:非 2xx 一律 `throw new Error(\`Anthropic 模型请求失败 ${status}:${detail.slice(0,500)}\`)`;`ts/src/server/index.ts:1999-2006` 统一兜成 `任务执行失败:${detail}`(仅做白标脱敏,不做状态码分类/友好文案/可恢复性判断) | gap | P0 | M |
| 4.2 | 瞬时错误退避重试(408/429/5xx 指数退避 + 尊重 `Retry-After`) | `src/services/api/errors.ts` + `withRetry.ts` | `ts/src/model/fetchRetry.ts` 全文件,注释明确"移植 cc-haha `withRetry.ts` 核心退避语义"(:1-11),`isRetryableStatus`/`parseRetryAfterMs`/指数退避实现到位 | aligned | — | — |
| 4.3 | 模型 fallback 触发 + 用户可见的"已切换模型"提示,且丢弃失败尝试的半截流式输出 | `src/query.ts:900-958`(`FallbackTriggeredError`→`createSystemMessage('Switched to X due to high demand')`,并 tombstone 孤儿消息) | `ts/src/model/FallbackModel.ts:30-67`:失败候选的 buffered 流式增量整体丢弃(:59-64),中选后追加 notice `已切换到...出口继续`(:53-58),`sanitizeError` 脱敏 token/key(:10-16) | aligned | — | — |
| 4.4 | 工具执行段整段异常兜底:未配对的 `tool_use` 补 `is_error:true` 的 `tool_result`,保证配对不崩循环 | `src/query.ts` 注释体现的 `yieldMissingToolResultBlocks` 语义(:900-1004 model 层同款兜底) | `ts/src/harness/loop.ts:639-712`,注释显式写明"对齐 cc yieldMissingToolResultBlocks",catch 块里逐个补 `<tool_use_error>` 包壳的 is_error tool_result(:699-711) | aligned | — | — |
| 4.5 | 单个工具执行异常 → 错误文本回灌模型自救,且超长输出做首尾截断保护(10000 字符,含 5000/5000 头尾保留提示) | `src/utils/toolErrors.ts:5-21`(`formatError`) | `ts/src/harness/loop.ts:988-999`(`executeAllowedToolCall` catch → `错误:工具 X 执行失败:${message}`)有错误回灌,但**没有长度截断**——超大 stderr/stdout 原样回灌,存在把上下文撑爆或反复触发 compact 的风险 | gap | P2 | S |
| 4.6 | 工具入参 Zod 校验失败 → 结构化人话(缺哪个参数/多了哪个/类型不对,逐条列出) | `src/utils/toolErrors.ts:66-132`(`formatZodValidationError`) | `ts/src/tools/Tool.ts` 未见等价的结构化校验错误格式化;入参校验失败大概率落到通用 `执行失败:${message}` 分支,原始校验器报错文本直传 | gap | P2 | S |
| 4.7 | 特定业务错误(如图片过大)→ 工具级友好文案 | `src/query.ts:976-986`(`ImageSizeError`/`ImageResizeError` → `BUSINESS_ERROR_CODES.IMAGE_TOO_LARGE`) | `ts/src/tools/fileReadTool.ts:474`:`read_file` 命中图片过大时返回 `<file_image ... error="too_large">图片过大(...),请先裁剪/压缩后再读。` | aligned(工具级,非 query 循环级 businessErrorCode,但用户体验等价) | — | — |
| 5.1 | per-session/per-model token 用量累加(input/output/cache read/write/web search),且**跨 session resume 持久化恢复**(`restoreCostStateForSession`) | `src/cost-tracker.ts` 全文件(`addToTotalSessionCost:336-381`、`getStoredSessionCosts`/`restoreCostStateForSession:110-165` 存进 project config) | `ts/src/harness/loop.ts:773-802`(`usageTotalsFromInitial`/`usageUpdateEvent`)只在单次 `runAgentLoop` 调用的生命周期内存活;每轮当作 SSE 事件追加进 `sessions.appendEvent`(`server/index.ts:2050`),但**没有任何地方把这些 usage_update 事件聚合成一个可查询的 per-session 总量**,更没有跨 resume 恢复累计值这层 | gap | P1 | M |
| 5.2 | 按模型定价表计算 USD 成本(`calculateUSDCost`),并挂历史累计 | `src/utils/modelCost.ts` 全文件 + `cost-tracker.ts:308-334` | 全仓检索 `costUSD\|pricing\|USD` 无一处命中模型计费(命中的都是台球门店业务侧"美元/定价"字样,与模型成本无关);**不是"算了但前端不显示"，是后端压根没有这层核算** | decision(前端不露钱味,产品既定;CLAUDE.md 铁律 4"不设消费上限")+ gap(内部核算层缺失,若未来要做网关侧用量对账/成本分析,ts 这一层是空的;网关那台服务器可能另有独立记账,但不在 ts/ 范围内,未核实) | P2 | M |
| 5.3 | API 调用耗时/工具耗时/wall-clock 总耗时统计(`getTotalAPIDuration`/`getTotalToolDuration`/`getTotalDuration`) | `src/cost-tracker.ts`(import 自 `bootstrap/state.js` 的一组 getter) | 缺,无耗时累加 | gap | P2 | S |
| 5.4 | 代码改动行数统计(linesAdded/linesRemoved 累加进 session 总量) | `src/cost-tracker.ts:336-381`(`addToTotalLinesChanged`) | 缺 | gap | P2 | S |
| 6.1 | 核心执行进程(相当于我们的 backend sidecar)级 `uncaughtException`/`unhandledRejection`:记录 + 不主动退出 | `src/utils/gracefulShutdown.ts:299-333` | 缺。`ts/desktop/sidecars/backend-sidecar.ts`(真正跑 harness 循环的 Bun 进程入口)**没有注册任何顶层 handler**;一旦某处未被 request 级 try/catch 兜住的异常抛出(如后台任务/WS 分支/hooks 聚合器之外的路径),整个 Bun 进程会按运行时默认行为崩溃退出,拖垮当时**所有**并发会话(cc 的每个 query 是独立 try/catch,一个坏请求只死一个 query) | gap | P0 | S |
| 6.2 | Electron 主进程级 crash guard(记录 + 保持存活 + 首次弹一次提示) | 无此层(cc 是 CLI,没有 Electron 壳) | `ts/desktop/electron/services/crashGuard.ts` 全文件:`handleFatal` 记录日志 + 不退出 + `onFirstFatal` 回调弹窗(:23,32-46),另有测试覆盖(`crashGuard.test.ts`) | intentional-delta(桌面壳产品形态自建,合理) | — | — |
| 6.3 | 子进程崩溃自动重启(指数退避 + 重启窗口限流 + 放弃回调) | 无直接对应(cc 本身是被执行的单进程语境,没有"看护子进程"这层概念) | `ts/desktop/electron/services/sidecarManager.ts:102-227`:`healthyResetMs`/`restartWindowMs`/`maxRestarts`/`onGaveUp`,实现完整;部分缓解了 6.1 的影响(能重启但重启前的并发会话仍全部丢失、且没有崩溃原因日志可查——叠加 1.1 缺口) | intentional-delta | — | — |
| 6.4 | 单次请求(SSE 流)级 try/catch 兜底:失败转成对用户友好的消息 + 会话状态标记失败,而不拖垮进程 | `src/query.ts:962-1004`(区分 `image_error`/`model_error` 等 reason,分别处理) | `ts/src/server/index.ts:1999-2006`:catch → `scrubProviderIdentifiers` 脱敏 → yield `任务执行失败:${detail}` + `final` + `finalStatus='failed'`;粒度更粗(无 reason 分类),但"这一路请求失败不拖垮别的会话"的核心语义等价 | aligned(细粒度弱于 cc,但已覆盖见 4.1 的 gap) | — | — |
| 6.5 | 会话历史增量落盘,防止进程崩溃丢失已发生的对话/事件 | 假定 cc 每条 message 落 transcript(未逐行核实,cc 有完整 JSONL transcript 体系) | 双层:①`ts/src/server/services/sessionService.ts:261-275` `appendEvent` 对每个 SSE 事件同步 `appendFile`(await 后才 yield 给客户端),实时落盘,粒度到"每一次 tool_call/tool_result/final";②`ts/src/harness/loop.ts` 里模型重放用的 `transcript.append` 只在 final/abort/输出截断恢复点调用(:522,559,574,587),工具批次中途不落这份 replay 格式,但①已经保证了"发生过什么"不会因进程崩溃而丢失 | aligned(甚至部分强于——事件级落盘更细) | — | — |

## 分类计数

- aligned:9(2.2、2.4、4.2、4.3、4.4、4.7、6.2*、6.4、6.5;*6.2/6.3 严格说是 intentional-delta 但功能上起到"崩溃兜底"作用,归入下方 intentional-delta 计数更准确——见下)
- gap:12(1.1、1.2、1.3、2.1、2.3、4.1、4.5、4.6、5.1、5.3、5.4、6.1)
- intentional-delta:4(1.4、3.1、6.2、6.3)
- decision:2(1.5 方向层面、5.2 前端不露钱味层面;两条各自还叠了一部分 gap,已在行内注明)
- 范围外:1(3.2)

（严格按分类列统计:aligned=7,gap=12,intentional-delta=4,decision=2,范围外=1,合计26行）

## P0/P1 top5 gap 一句话

1. **1.1 无调试日志落盘**:`ts/src` 没有任何集中式调试日志模块,console.error 全仓仅 4 处零散调用,出问题后既无本地 debug 文件可翻、接诊断回传的 dataeye 链路也还没接通(P0)。
2. **6.1 backend sidecar 无顶层崩溃兜底**:真正跑 harness 循环的 Bun 进程(`backend-sidecar.ts`)没注册 `uncaughtException`/`unhandledRejection`,一处未被 request 级 try/catch 兜住的异常会打崩整个进程、拖死所有并发会话,虽有 Electron 侧自动重启缓解但重启前的会话全丢且没有崩溃原因日志(P0)。
3. **4.1 模型 API 错误无分类**:cc 用 ~1150 行区分 429/401/403/413/500/529/超时/连接失败并各给友好文案,我们目前不管什么错误都通过 fetchRetry 重试耗尽后原样抛出、最终统一兜成"任务执行失败:xxx",用户看不出是限流/鉴权/网络哪一种、该不该重试(P0)。
4. **5.1 token 用量不做 session 级持久化聚合**:每轮 usage 只作为一次性 SSE 事件写日志,没有任何地方把它们汇总成"这个 session 总共用了多少 token"且可在 resume 时恢复,cc 有完整的跨 session 累计 + 恢复机制(P1)。
5. **1.5 诊断日志回传替代方案未接通**:项目自己的"错误静默回传自有服务器"本该顶替 cc 的 debug 日志体系,但 CLAUDE.md 显示这条(dataeye 重接)目前仍是"在建"状态,等于 1.1 的缺口暂时没有任何兜底(P0,与 1.1 同源)。
