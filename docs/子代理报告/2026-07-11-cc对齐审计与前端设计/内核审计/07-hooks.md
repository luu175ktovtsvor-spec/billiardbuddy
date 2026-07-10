# cc-haha 对齐审计 · Hooks 事件系统(只读代码级审计)

- spec 源:`~/Desktop/cc-haha-ref` 当前源码(`src/utils/hooks.ts` 5041行 + `src/utils/hooks/*.ts` + `src/entrypoints/sdk/coreSchemas.ts`/`coreTypes.ts`)
- 现状源:`/Users/swl/Desktop/球房运营AI助手-桌面版/ts`(`src/hooks/hooks.ts` 522行 + `src/hooks/hookConfig.ts` 791行 + 派发点分布在 `src/harness/loop.ts`/`src/agents/agentTool.ts`/`src/tasks/taskTools.ts`/`src/server/index.ts`)
- 审计方式:两边源码逐行亲读,不采信既有文档口径(文档"13/27"经核实数字准确,细节展开如下)。

---

## 一、27 事件清单逐个打勾

cc 权威事件表:`src/entrypoints/sdk/coreSchemas.ts:355-383`(与 `coreTypes.ts:25-53` 完全一致,27 个)。

| # | cc 事件名 | 我们落了? | 我们的事件名(ts/src/hooks/hookConfig.ts:10-23) | 备注 |
|---|---|---|---|---|
| 1 | PreToolUse | ✅ | PreToolUse | 派发 loop.ts:1120 |
| 2 | PostToolUse | ✅ | PostToolUse | 派发 loop.ts:979 |
| 3 | PostToolUseFailure | ✅ | PostToolUseFailure | 派发 loop.ts:992 |
| 4 | Notification | ✅ | Notification | 派发点单薄,见下 §2.9 |
| 5 | UserPromptSubmit | ✅ | UserPromptSubmit | 派发 loop.ts:299 |
| 6 | SessionStart | ✅ | SessionStart | 派发 loop.ts:287 |
| 7 | SessionEnd | ✅(但落点是死路径,见 §3) | SessionEnd | server/index.ts:425-438 fireSessionEndHooks,`defaultHooksPath()` 恒 undefined |
| 8 | Stop | ✅ | Stop | 派发 loop.ts:320(applyStopHookContinuation) |
| 9 | StopFailure | ✅ | StopFailure | 派发 loop.ts:358 |
| 10 | SubagentStart | ✅ | SubagentStart | 派发 agentTool.ts:433、taskTools.ts:652 |
| 11 | SubagentStop | ✅ | SubagentStop | 派发 loop.ts:320(subagent 分支,event 由 `applyStopHooks` 内部据 `opts.subagent` 切换) |
| 12 | PreCompact | ✅ | PreCompact | 派发 loop.ts:445 |
| 13 | PostCompact | ✅ | PostCompact | 派发 loop.ts:458 |
| 14 | PermissionRequest | ❌ 缺 | — | cc 的 SDK 级"权限弹窗即将显示"独立事件,不同于 PreToolUse |
| 15 | PermissionDenied | ❌ 缺 | — | cc"auto mode 分类器拒绝后允许重试"专用,依赖 cc 的 auto-mode 分类器(我们无此子系统) |
| 16 | Setup | ❌ 缺 | — | cc 仓库 init/maintenance 钩子(`claude init` 场景),我们无对应产品面 |
| 17 | TeammateIdle | ❌ 缺 | — | cc "Teams/swarm" 多队友功能专属,我们无此功能(产品边界外) |
| 18 | TaskCreated | ❌ 缺 | — | 同上,swarm task 专属 |
| 19 | TaskCompleted | ❌ 缺 | — | 同上 |
| 20 | Elicitation | ❌ 缺(作为 hook 事件) | — | MCP elicitation **协议本身**已支持(`src/mcp/client.ts` McpElicitationHandler),但未接进通用 hook 系统、不可被 hook 拦截/改写 |
| 21 | ElicitationResult | ❌ 缺 | — | 同上 |
| 22 | ConfigChange | ❌ 缺 | — | cc 热重载 settings.json 时触发;我们无配置热重载 hook |
| 23 | WorktreeCreate | ❌ 缺 | — | 我们已有 EnterWorktree/ExitWorktree **工具**,但创建时不触发 hook(cc 用该 hook 让命令返回 worktree 路径参与创建逻辑,语义不同于我们的固定工具实现) |
| 24 | WorktreeRemove | ❌ 缺 | — | 同上 |
| 25 | InstructionsLoaded | ❌ 缺 | — | cc 装载 CLAUDE.md/BILLIARDBUDDY.md 类指令文件时的可观测性 hook(`grep InstructionsLoaded` 全仓零命中,`src/harness/claudemd.ts` 无埋点) |
| 26 | CwdChanged | ❌ 缺 | — | cc 目录切换钩子(配合 CLAUDE_ENV_FILE 让 Bash 后续调用带环境变量) |
| 27 | FileChanged | ❌ 缺 | — | cc 文件监听钩子(watchPaths) |

**计数:13/27 已落(48%),14 缺。** 与既有文档"13/27"数字核实一致。

已落的 13 个里,**11 个有真实派发点**(PreToolUse/PostToolUse/PostToolUseFailure/UserPromptSubmit/SessionStart/SubagentStart/SubagentStop/Stop/StopFailure/PreCompact/PostCompact),**2 个派发点存在但覆盖面窄或实际不可达**:
- SessionEnd:call site 有(server/index.ts:425),但 `defaultHooksPath()`(server/index.ts:413-419)硬编码找 `server/hooks.json`——该目录**已随老 Python `server/` 整体删除**(项目 CLAUDE.md 明载),两个候选路径永远不存在,`existsSync` 全 false → `defaultHooksPath()` 恒返回 `undefined`。生产路径下 SessionEnd 从未真正加载到任何 local hook(除非调用方显式传 `opts.hooksPath`,但全仓无此调用点)。
- Notification:call site 只有 1 处(loop.ts:1161,权限询问弹出时),cc 有 idle_prompt/auth_success/elicitation_* 等多种 notification_type 落点(`src/services/notifier.ts` 多处调用 `executeNotificationHooks`),我们只覆盖了"需要确认"这一种。

14 个缺失事件里,**TeammateIdle/TaskCreated/TaskCompleted 是 cc 的 Teams/swarm 多队友功能专属**(产品边界外,不计入缺口);**PermissionDenied/Setup 依赖 cc 特有子系统**(auto-mode 分类器 / repo-init 场景),我们目前也没有对应功能主体,可归"暂不适用"而非"缺失待补"。真正值得排期的缺口是:**PermissionRequest、ConfigChange、InstructionsLoaded、CwdChanged、FileChanged、WorktreeCreate/Remove、Elicitation/ElicitationResult**(9 个)。

---

## 二、发现表(行为点 | cc+file:line | 我们+file:line或"缺" | 分类 | 优先级 | 规模)

### 2.1 PreToolUse `allow` 决策被静默丢弃(不生效)

- **cc**:`src/services/tools/toolHooks.ts:333-435` `resolveHookPermissionDecision` —— hook 返回 `permissionDecision:'allow'` 时,**跳过交互确认弹窗**(仍过 `checkRuleBasedPermissions` 的 deny/ask 规则,但不再弹窗),这是 PreToolUse hook 实现"自动放行"的核心用途。`src/utils/hooks.ts:2839-2866` 聚合器把 `allow` 当作真实决策项参与 deny>ask>allow 优先级运算。
- **我们**:`src/hooks/hooks.ts:273-291` `applyPreToolUseHooks` 的 for 循环只处理 `deny`/`ask`/`modify`/`context` 四种 action,**`action === 'allow'` 完全没有处理分支**——decision 被读入 `decisions` 数组、循环遍历、却无任何 case 命中,直接丢弃。`HookDecision` 类型(`src/hooks/hooks.ts:26`)虽然定义了 `{action:'allow'}`,`parseHookDecisionJSON`(`hooks.ts:188`)也确实会从 `hookSpecificOutput.permissionDecision:'allow'` 解析出这个 decision,但下游消费者(`applyPreToolUseHooks`)不认它。
- 实际后果:一个 PreToolUse hook 脚本返回 `{"hookSpecificOutput":{"permissionDecision":"allow"}}`,在我们系统里**不会跳过审批弹窗**——如果 `resolvePermission()`(loop.ts:1130)判定该工具需要 ask,依然会 ask,hook 的 allow 意图完全落空。这是"hook 自动批准工具调用"这个核心用例的功能性缺失。
- 分类:**gap**(不是有意为之——代码里连注释都没提这是取舍,纯粹是实现遗漏)
- 优先级:**P0**(PreToolUse hook 最常见用途之一就是自动放行,现状=功能哑)
- 规模:**S**(在 `applyPreToolUseHooks` 加一个 `if (decision.action === 'allow') { allowRequested = true; ... }` 分支,再在 loop.ts:1130 附近让 `resolvePermission` 结果被 hook 的显式 allow 覆盖——参考 `resolveHookPermissionDecision` 的"allow 跳过弹窗但不越过 deny 规则"语义)

### 2.2 多 hook 并发 vs 串行:cc 并行、我们串行

- **cc**:`src/utils/hooks.ts:2158-2160` 注释明写"Run all hooks in parallel with individual timeouts",`const hookPromises = matchingHooks.map(async function* (...) => {...})`,`src/query/stopHooks.ts` 等调用方用 `for await (const result of all(hookPromises))` 合并多个并发 async generator(`all()` 是 fan-in 工具)。每个 hook 各自独立 timeout,总耗时 ≈ max(各 hook 耗时)。
- **我们**:`src/hooks/hooks.ts:233-252` `runHookEvent`——`for (const rule of registry.rules) { ... const result = await rule.handler(payload, ctx) ... }`,**for 循环里 await,严格串行**,同一事件挂 3 个 command hook(各 120s 超时)最坏要等 360s,cc 同场景最坏只要 120s。
- 分类:**deviation**
- 优先级:**P1**(正确性不受影响,但延迟/超时语义与 cc 实测不一致,多 hook 场景下用户等待时间可能远超预期)
- 规模:**M**(改成 `Promise.allSettled(registry.rules.filter(...).map(rule => rule.handler(payload, ctx)))`,但要保留"deny 优先""按注册顺序聚合"等既有语义,需要配合测试重写)

### 2.3 command hook 载荷缺 `stop_hook_active` 字段

- **cc**:`src/utils/hooks.ts:3689-3704` `executeStopHooks` 构造的 `StopHookInput`/`SubagentStopHookInput` 含 `stop_hook_active: boolean`,command/http/prompt hook 脚本能读到这个字段、自行判断"上次已经因为我而继续过一轮了,这次别再 block"来避免死循环。
- **我们**:`src/hooks/hookConfig.ts:160-183` `commandHookPayload` 序列化给外部 command/http/prompt/agent hook 的 JSON **没有把 `payload.stopHookActive` 塞进去**——`HookPayload.stopHookActive`(`hooks.ts:41`)字段存在、loop.ts:320 也确实在往 `applyStopHooks` 传 `{ stopHookActive }`,但只有**内建 TS handler(managed 源)**能通过函数参数直接读到 `payload.stopHookActive`;**外部 command/http/agent/prompt hook 完全看不到这个字段**,没法自我限流,存在 Stop hook 反复 block 导致死循环的风险(我们这边也没有硬性轮数上限兜底,和 cc 一样完全依赖 hook 脚本自律)。
- 分类:**gap**
- 优先级:**P1**(有实际死循环风险,修复成本极低)
- 规模:**S**(`commandHookPayload` 加一行 `...(payload.stopHookActive !== undefined ? { stop_hook_active: payload.stopHookActive } : {})`)

### 2.4 决策聚合 deny>ask>allow 优先级

- **cc**:`src/utils/hooks.ts:2839-2866`,显式 switch:deny 总是覆盖;ask 仅在当前非 deny 时覆盖;allow 仅在当前为空时设置。
- **我们**:`src/hooks/hooks.ts:283-289` `applyPreToolUseHooks` —— deny 命中立即 `return`(短路,永远最高优先级,等价"deny 总覆盖");ask 用 `askRequested=true` 标记(不会被后续 allow 覆盖,因为 allow 根本不处理);顺序上如果先 ask 后 deny,循环会走到 deny 分支直接 return,语义等价 cc。**结论:deny>ask 的相对优先级实现正确**;但因为 §2.1(allow 完全不处理),"ask 优先于 allow"这条规则在我们这里没有意义(allow 本来就不生效)。
- 分类:**aligned**(deny/ask 两级),**依赖 §2.1** 修复后 allow 才有意义可评估
- 优先级:N/A(并入 2.1)
- 规模:N/A

### 2.5 `hookSpecificOutput.permissionDecision` + 旧 `decision:'block'` 兼容

- **cc**:`src/schemas/hooks.ts:70-165`(zod 定义)+ `src/utils/hooks.ts:531-670` 解析——新格式 `hookSpecificOutput.permissionDecision`,旧格式顶层 `decision:'block'|'approve'` 向后兼容,PreToolUse 专属旧格式已弃用但仍兼容。
- **我们**:`src/hooks/hooks.ts:180-208` `parseHookDecisionJSON` —— 完整实现新格式(`hookSpecificOutput.permissionDecision` allow/deny/ask)+ 旧格式(`decision === 'block'` → deny)+ 本项目自有扁平格式(`action` 字段,向后兼容自家早期版本)。`src/hooks/hookConfig.ts:197-211` `hookSpecificDecisions` 另外处理 `decision:'approve'`→allow、`hookSpecificOutput.additionalContext`、`hookSpecificOutput.updatedInput`。
- 分类:**aligned**
- 优先级:—
- 规模:—

### 2.6 Stop hook blocking continuation(阻断续跑)

- **cc**:`src/query/stopHooks.ts` —— hook 返回 `decision:'block'`(或退出码 2)时,产生 `blockingError`,作为 user message 重新注入对话、循环继续跑(不是真正终止),`stop_hook_active` 标记避免脚本自己无限循环。
- **我们**:`src/harness/loop.ts:317-342` `applyStopHookContinuation` —— 完整复刻:`stopHook.blockingFeedback` 非空则把 feedback 包成 `wrapReminder` 塞进 `messages`(user role),标记 `stopHookActive=true`,`shouldContinue:true` 触发外层继续跑;为空则真正停止。语义对齐,**但载荷缺口见 §2.3**。
- 分类:**aligned**(核心续跑机制到位),**gap 附带**(§2.3 载荷字段)
- 优先级:—(计入 2.3)
- 规模:—

### 2.7 matcher:管道 `Edit|Write`、正则 `mcp__.*`、锚定

- **cc**:`src/utils/hooks.ts:1364-1399` `matchesPattern` —— 纯字母数字+管道走**精确列表匹配**(等价我们的锚定行为);含正则元字符则走 `new RegExp(matcher).test(matchQuery)`,**不加 `^$` 锚定**(unanchored),另外还会退化匹配"legacy tool 别名"(`getLegacyToolNames`)。
- **我们**:`src/hooks/hookConfig.ts` 无独立 matchesPattern,`src/hooks/hooks.ts:211-220` `matchesToolMatcher` —— 精确匹配优先,否则 `new RegExp(`^(?:${matcher})$`)`,**显式锚定**(代码注释自述"锚定避免子串误匹配,Edit 不误配 MultiEdit")。管道 `Edit|Write`、正则前缀 `mcp__.*` 均有测试覆盖(`src/hooks/hooks.test.ts:57-69`)。
- 差异点:cc 的正则分支不锚定(存在"合法但危险"的子串误配可能,比如 matcher 写 `.*Edit`会不小心命中 `MultiEditFoo`);我们锚定更安全,但也意味着**如果哪天真需要故意写非锚定正则**(cc 允许的用法)我们会拒绝匹配。另外我们**没有"legacy 工具别名"回退匹配**(cc 为了兼容改名前的工具名单独测一遍),但我们的工具从未改名过,无对应场景。
- 分类:**intentional-delta**(代码注释已自述取舍理由,且是安全加固方向而非退化)
- 优先级:—
- 规模:—

### 2.8 超时(单 hook 粒度)

- **cc**:每个 hook 独立 `timeout`(秒),默认走 `TOOL_HOOK_EXECUTION_TIMEOUT_MS`(command/prompt);HTTP hook 默认 10 分钟(`execHttpHook.ts:12`)。
- **我们**:`src/hooks/hookConfig.ts` `commandTimeoutMs`(默认 120s,1s~600s 夹紧)、`hookTimeoutMs`(prompt 默认 30s、agent 默认 60s、http 默认 120s)——**HTTP hook 默认超时是 120s,cc 是 600s(10分钟)**,数值不同但同属"有超时"范畴。
- 分类:**deviation**(HTTP 默认超时数值不同,非阻断性差异)
- 优先级:**P2**
- 规模:**S**(改一个默认值常量,若要对齐 cc 就是 `120_000` → `600_000`)

### 2.9 executor 类型:command/http/prompt/agent 四类

- **cc**:`src/schemas/hooks.ts:32-171` 四类 zod schema,分别在 `src/utils/hooks/execHttpHook.ts`、`execPromptHook.ts`、`execAgentHook.ts`(prompt 走小/快模型,默认非当前对话模型;agent 走 Haiku 默认且可跑受限工具集)。
- **我们**:`src/hooks/hookConfig.ts` 四类都有:`runCommandHook`(474-523,spawn+超时+退出码语义)、`runHttpHook`(635-676,SSRF guard+URL allowlist+env 白名单插值)、`runPromptHook`(415-471)、`runAgentHook`(349-413,受限只读工具集 `AGENT_HOOK_ALLOWED_TOOLS` + `StructuredOutput` 工具强制结构化输出,机制上比 cc 更严格可控)。四类都齐全、退出码语义(0 成功/2 阻断/其他非阻塞错误)与 cc 完全一致(`runCommandHook:508-519`)。
- **但**:prompt/agent hook 的 `model` 字段(schema 里声明,`schemas/hooks.ts:81-86,149-154`)在我们这边**声明了类型但从不读取**——`runPromptHook`/`runAgentHook` 一律用 `ctx.model`(当前对话主模型),cc 默认给 prompt/agent hook 用**小/快模型**(注释:"如未指定用默认小快模型"/"如未指定用 Haiku"),用意是省钱省延迟。我们产品本身是单模型架构(`ToolContext.model` 只有一个字段,无"主模型/小模型"分层设计,`docs/当前架构与状态-总览.md` 口径下暂无多模型分层),所以这不是"漏读了却本可以生效"的纯 bug,而是**架构上尚未有"小模型"概念可用**。
- 分类:**gap**(功能确实缺,但根因是架构还没做多模型分层,不是简单的字段读取遗漏)
- 优先级:**P2**(cost/latency 优化类,非正确性问题;且 `raw.model` 字段目前读了也没地方接)
- 规模:**M**(要接的话得先有"小模型"配置概念,不只是 hookConfig.ts 一处改动)

### 2.10 HTTP hook allowlist / env policy / SSRF 防护

- **cc**:`src/utils/hooks/execHttpHook.ts` —— `allowedHttpHookUrls`/`httpHookAllowedEnvVars` 全局 settings 策略 + 逐 hook `allowedEnvVars`(取交集)+ header 值 `$VAR`/`${VAR}` 插值(仅白名单变量,CRLF 注入过滤)+ `ssrfGuardedLookup` DNS 层拦截私网/链路本地地址(放行 loopback)+ `maxRedirects:0`。
- **我们**:`src/hooks/hookConfig.ts:565-676` + `src/hooks/ssrfGuard.ts` —— 策略结构对等:`httpHookAllowedUrls`(`allowedUrls`/env `HTTP_HOOK_ALLOWED_URLS`)、`httpHookAllowedEnvVars`(hook 自带 ∩ policy 白名单)、`interpolateAllowedEnv` 同款 CRLF 过滤插值、`ssrfGuardedLookup`(`ssrfGuard.ts` 完整实现 v4/v6 私网段判定,含 IPv4-mapped IPv6 展开),node:http/https 原生请求默认不跟随重定向(等价 `maxRedirects:0`,无需显式设置)。
- **差异**:cc 有"sandbox network proxy"路由分支(启用沙箱时 HTTP hook 走沙箱代理、此时跳过 SSRF guard 交给代理做 DNS)——我们没有这层(W3 sandbox 模块暂未把 HTTP hook 纳入网络围栏管辖,SSRF guard 恒生效不因沙箱状态切换)。这属于沙箱模块(非 hooks 模块)边界,不计入本次 hooks 审计缺口。
- 分类:**aligned**(核心 SSRF/allowlist/env 策略三件套完整对齐)
- 优先级:—
- 规模:—

### 2.11 信任门(§3.405 #5 曾 rework)—— 现状真接线,但与 cc 语义有意分叉

- **cc**:`src/utils/hooks.ts:289-299` `shouldSkipHookDueToTrust` —— **"全或无"前置过滤**,交互模式下工作区未受信,连 managed/policy hook 一起挡(在 `executeHooks` 最前面短路,`hooks.ts:2010-2017`,比 source 分层还早)。
- **我们**:`src/hooks/hooks.ts:163-174` `shouldRunHookRule` —— **三道闸分层**:①`disableAllHooks` 才挡 managed;②③(`allowManagedHooksOnly`/workspace trust)只挡 `local`(和 `plugin` 部分受②约束、不受③约束)。`configureHookTrust` **确实在生产代码接线**:`src/server/index.ts:995` `configureHookTrust({ interactive: true, isWorkspaceTrusted: root => mcpTrust.isTrusted(root) })`,复用与 MCP 相同的 `McpTrustStore`,门是真生效的(不是摆设)。
- 这是代码里**已自述、已论证**的有意分叉(`hooks.ts:152-161` 大段注释解释:cc 的 managed=企业策略 hook 且有 trust 弹窗快速受信,我们的 managed=app 内置不可信改的 hook、无 trust 弹窗 UI,照搬会导致域包/目标 hook 被默认关停、零安全收益)。
- 分类:**intentional-delta**(有理有据,已落地生效,非"声称做了实际没做")
- 优先级:—
- 规模:—

### 2.12 配置加载:settings 层级(user/project/local)—— 本次审计最大缺口

- **cc**:`src/utils/hooks/hooksSettings.ts:92-161` `getAllHooks` —— 完整多源合并:`userSettings`(`~/.claude/settings.json`)+ `projectSettings`(`.claude/settings.json`)+ `localSettings`(`.claude/settings.local.json`)+ `policySettings`(企业 managed,`allowManagedHooksOnly` 时排他)+ `pluginHook` + `sessionHook`(运行时内存态,skill/agent frontmatter 走这条线)。所有源的 hook **全部合并参与匹配**(非"高优先级覆盖低优先级",`sortMatchersByPriority` 只影响 UI 展示排序,不影响执行范围)。
- **我们**:
  - **plugin 源**:✅对齐,`loadPluginHookRegistry`(`hookConfig.ts:774-791`)+ `pluginLoader.ts` 收集已启用插件的 hooks.json。
  - **session 源(skill/agent frontmatter)**:✅对齐,`agentLoader.ts:112`(`agentFrontmatter:true`,Stop→SubagentStop 转换)、`skillLoader.ts:148`,均走 `normalizeHookRegistry`,机制与 cc `registerFrontmatterHooks`/`registerSkillHooks` 等价(`once` 用闭包标记替代显式移除规则,行为等价)。
  - **local 源(工作区/用户可编辑 hook 配置)**:❌**实质性缺失**。`defaultHooksPath()`(`server/index.ts:413-419`)硬编码扫 `server/hooks.json`(老 Python `server/` 目录残留路径,该目录**已随迁移整体删除**,`find` 全仓验证零命中),两个候选路径永远不存在 → `existsSync` 恒 false → `defaultHooksPath()` 恒 `undefined` → `loadHookRegistryFile(undefined)` 直接短路返回 `undefined`(`hookConfig.ts:746-747`)。生产环境下 local hook 配置文件**从未被真正加载过**,除非调用方显式传 `hooksPath` option(全仓 grep 无此调用点,只有类型声明和测试会传)。
  - **更关键的是没有 user/project/local 三级分层**,只有单一路径。对照同仓库 `src/permissions/permissionsSettings.ts:134-186`(**同一产品、同一次迁移**已经把权限规则做成了 `~/.billiardbuddy/settings.json`(userSettings)+ `<workspaceRoot>/.billiardbuddy/settings.json`(projectSettings)+ `.billiardbuddy/settings.local.json`(localSettings)三级、白标目录名走 `memoryNames.ts` 统一入口、工作区信任门内置——**hooks 模块本该照抄这一套却没抄**,是本次审计里最具体、最好复制的修复参照物。
- 分类:**gap**(且是可对照本仓库姊妹模块直接抄的那种 gap,非"需要新设计")
- 优先级:**P0**
- 规模:**M**(参照 `permissionsSettings.ts` 的三级路径解析 + 白标目录名 + trust 门早已就绪,只需给 hooks 模块补一份同构的 `hooksSettings.ts` 风格加载器,替换掉 `defaultHooksPath()` 这个死路径)

### 2.13 PostToolUse `updatedMCPToolOutput` 覆盖能力

- **cc**:`src/schemas/hooks.ts:101-107` PostToolUse hook 可通过 `hookSpecificOutput.updatedMCPToolOutput` 改写 MCP 工具的返回结果(`toolHooks.ts:145-151` 消费)。
- **我们**:`HookDecision` 类型(`hooks.ts:25-30`)没有对应的 action 分支,`applyPostToolUseHooks`(`hooks.ts:358-378`)只处理 `context`/`deny`(转警告文本),无法改写工具输出。
- 分类:**gap**
- 优先级:**P2**(MCP 专属场景,窄)
- 规模:**S**(加一个 `{action:'rewriteOutput', output: unknown}` decision 分支)

### 2.14 决策语义细项:PreToolUse `updatedInput` 类型收窄

- **cc**:`updatedInput` 类型是 `Record<string, unknown>`(工具入参必须是对象)。
- **我们**:`hooks.ts:29` `modify` action 的 `updatedInput: unknown`(无类型收窄,运行时才可能出问题)。
- 分类:**deviation**(类型宽松,非运行时错误——`applyPreToolUseHooks` 直接把 `nextInput` 透传给工具执行,工具自己的 `inputSchema.safeParse` 兜底,loop.ts:1114 `validateToolInput` 在 hook 之前已跑过一次,hook 改写后的 input **不会再过一次校验**,理论上 hook 可以把 input 改成不合法结构绕过 §1111 的校验闸)
- 优先级:**P2**(安全加固类,非功能对齐类;但值得单独记一笔——hook `modify` 决策改写 input 后没有回退校验)
- 规模:**S**(在 `applyPreToolUseHooks` 返回 `nextInput` 前补一次 `validateToolInput`,或在 loop.ts 消费 `hookResult.input` 后立刻重跑校验)

---

## 三、"已知待办核对"结果

| 待办条目 | 结果 |
|---|---|
| 事件全集 27 个,我们 13/27 | **核实为真**,附 §一 逐个打勾清单;13 个里 2 个(SessionEnd/Notification)派发点覆盖有实质缺口 |
| 每事件派发点接线位置(PreToolUse/PostToolUse/UserPromptSubmit/SessionStart/SessionEnd/Stop/SubagentStart/SubagentStop/Notification/PermissionRequest) | PreToolUse✅loop.ts:1120、PostToolUse✅loop.ts:979、UserPromptSubmit✅loop.ts:299、SessionStart✅loop.ts:287、SessionEnd⚠️server/index.ts:425(死路径见§2.12)、Stop✅loop.ts:320、SubagentStart✅agentTool.ts:433/taskTools.ts:652、SubagentStop✅loop.ts:320(subagent分支)、Notification⚠️loop.ts:1161(仅1处覆盖面窄)、PermissionRequest❌不存在 |
| 决策语义 deny>ask>allow 聚合 | **deny/ask 两级对齐,allow 完全不生效**(§2.1,P0 gap) |
| hookSpecificOutput.permissionDecision | **对齐**(§2.5) |
| 旧 decision:block 兼容 | **对齐**(§2.5) |
| Stop hook blocking continuation | **核心机制对齐**(§2.6),但载荷缺 stop_hook_active 字段(§2.3,P1 gap) |
| matcher 管道/正则/锚定 | **对齐且有测试**,锚定策略是有意加固(§2.7,intentional-delta) |
| 多 hook 并发 vs 串行 | **cc 并行、我们串行**(§2.2,P1 deviation,确认属实) |
| 超时 | 有超时机制,HTTP 默认值数值不同(§2.8,P2 deviation) |
| executor 四类(command/http/prompt/agent) | **四类都实现**,退出码语义对齐;prompt/agent 的 `model` 字段未接(§2.9,P2 gap,根因是无多模型分层架构) |
| HTTP hook allowlist/env policy/SSRF | **对齐**(§2.10) |
| 信任门是否真生效 | **真生效**(server/index.ts:995 已接线,复用 McpTrustStore),但语义与 cc"全或无"有意分叉且已自述理由(§2.11,intentional-delta) |
| 配置加载 settings 层级 | **本次审计最大缺口**:local 源默认路径是已删除的死路径,且无 user/project/local 三级分层;同仓库 permissions 模块已有完整参照实现可抄(§2.12,P0 gap) |
| skill/agent frontmatter hooks 注册/恢复/once | **对齐**:agentLoader.ts:112(Stop→SubagentStop 转换)、skillLoader.ts:148、once 用闭包等价实现 |

---

## 四、分类计数与优先级汇总

| 分类 | 条数 |
|---|---|
| aligned | 6(§2.4 deny/ask、§2.5 兼容格式、§2.6 Stop续跑机制、§2.9 四类executor基础机制、§2.10 SSRF/allowlist、frontmatter hooks 注册） |
| gap | 6(§2.1 allow不生效、§2.3 stop_hook_active缺失、§2.9 model字段未接、§2.12 settings层级、§2.13 updatedMCPToolOutput、§2.14 modify后未重校验) |
| deviation | 3(§2.2 并发vs串行、§2.8 HTTP默认超时数值、§2.14 类型宽松) |
| intentional-delta | 2(§2.7 matcher锚定、§2.11 信任门语义分叉) |
| 事件级缺失(27事件清单) | 14 个未落(其中 3 个 TeammateIdle/TaskCreated/TaskCompleted 是 swarm 专属产品边界外;PermissionDenied/Setup 依赖 cc 专属子系统,可判"暂不适用";其余 9 个是真缺口) |

**P0(2 条)**
1. §2.1 PreToolUse `allow` 决策被完全丢弃——hook 自动放行工具调用这个核心用例现状是哑的。
2. §2.12 hook 配置文件加载走的是已删除的死路径,且无 user/project/local 三级分层,同仓库 `permissions` 模块已有可直接照抄的参照实现。

**P1(2 条)**
1. §2.2 多 hook 并发 cc 是并行、我们是严格串行,最坏延迟可能是 cc 的 N 倍。
2. §2.3 Stop/SubagentStop 命令行 hook 载荷缺 `stop_hook_active` 字段,外部 hook 脚本无法自我限流、有死循环风险。

**P2(5 条)**:HTTP 默认超时数值不同、prompt/agent hook `model` 字段未接(架构性,非简单遗漏)、PostToolUse 无法覆写 MCP 工具输出、`modify` 决策的 updatedInput 未重过校验闸、事件级 9 个真缺口(PermissionRequest/ConfigChange/InstructionsLoaded/CwdChanged/FileChanged/WorktreeCreate/WorktreeRemove/Elicitation/ElicitationResult)。
