# 09 · 子代理/任务/团队/计划模式/goals — cc-haha 对齐差异审计

> 审计口径:spec = `~/Desktop/cc-haha-ref` 当前源码(注意:该仓是**对外发行快照**,ant-internal feature-gated 模块被 DCE 成 `@generated stub` — 凡涉及 stub 的行为点已单独标注"cc 侧无真源可比");现状 = `/Users/swl/Desktop/球房运营AI助手-桌面版/ts` 工作树。两侧均亲读源码,不采信文档;主报告关键结论(model 字段死读、mutateTeam 零调用、udsInbox 缺 error handler)已由主代理二次 grep 复核。只读审计,未改任何文件、未跑测试。
>
> 审计方式:4 个并行子代理分域深读(AgentTool 核心 / 后台任务+前台切后台 / team+mailbox+UDS / 计划模式+goals),主代理抽查复核 + 汇总。日期 2026-07-10。

## 总计数

| 分类 | 数量 |
|---|---|
| aligned | 22 |
| gap | 12 |
| deviation | 3 |
| intentional-delta | 6 |
| cc 侧无真源可比(stub) | 4 |

P0:0 · P1:5 · P2:其余。**无产品级破坏性缺口**;核心机制(fork、handoff、权限继承、worktree、hooks、AgentSummary、plan 落盘、goal)全部真落地且对齐。

---

## 一、AgentTool(子代理核心)

| 行为点 | cc | 我们 | 分类 | 级 | 量 |
|---|---|---|---|---|---|
| frontmatter 字段覆盖 | `loadAgentsDir.ts:73-98,568-748`(tools/disallowedTools/model/**effort**/permissionMode/mcpServers/hooks/maxTurns/skills/initialPrompt/memory/background/isolation/name/description/**color**) | `agentLoader.ts:13-32,105-132` 解析除 effort/color 外全部字段 | **gap** | P2 | S |
| ├ `effort:` 字段 | `loadAgentsDir.ts` schema 含 effort | 缺(全 ts/src 无 agent-frontmatter effort 解析) | gap | P2 | S |
| ├ `color:` 字段 + agentColorManager | `agentColorManager.ts` | 缺 | gap | P2 | S |
| **`model:` frontmatter 真生效** | `runAgent.ts:340-345` `getAgentModel(agentDefinition.model,...)`(含 'inherit' 变换 `loadAgentsDir.ts:79-84`);工具调用级还有 `AgentTool.tsx:86` `model: z.enum(['sonnet','opus','haiku'])` | `agentLoader.ts:119` **解析进 AgentDefinition.model 但全仓无人读**——`agentTool.ts:443`、`taskTools.ts:644,665` 一律硬编码 `model: opts.model`(父级模型);`agent_task` schema(`agentTool.ts:311-326`)也无 per-call model 参数。主代理复核:grep `agentDefinition.model/definition.model` 非测试代码零命中 | **gap** | **P1** | M |
| 工具子集继承(tools: 限池) | `agentToolUtils.ts:72-118` `filterToolsForAgent` + `:124-220` `resolveAgentTools`(通配展开/`Agent(t1,t2)` 子语法/mcp__* 永放行/plan 模式才给 ExitPlanMode/async 代理限 `ASYNC_AGENT_ALLOWED_TOOLS`) | `agentLoader.ts:156-161` 简单 allow/deny 集过滤 + `agentTool.ts:414` 滤 agent_task + `server/index.ts:1728,1734,1759` 结构性小注册表(后台/子代理基础工具集天然不含 agent 工具) | aligned(机制不同)+ 子项 gap | P2 | M |
| ├ 缺:mcp__* 永放行特例 / ExitPlanMode plan 模式特例 / async 代理只读白名单 / 内置 vs 自定义来源区分 | 同上 | 缺 | gap | P2 | M |
| 权限继承(父 bypass/acceptEdits 优先;后台兜底 acceptEdits) | `runAgent.ts:412-434` | `permissions/canonical.ts:56-65` `resolveSubagentPermissionMode`:父 canon 为 bypass/acceptEdits→用父;否则 agentMode;否则 background?'acceptEdits':父 | **aligned** | — | — |
| run_in_background(Agent 工具自身参数) | `AgentTool.tsx:87`(zod boolean)→ `:567` `shouldRunAsync = run_in_background \|\| agent.background \|\| ...` | `agentTool.ts:60-61,325,363,368` 同款 OR 逻辑接 startBackgroundAgent | **aligned** | — | — |
| fork:child message builder | `forkSubagent.ts`(buildForkedMessages/buildChildMessage/buildWorktreeNotice) | `src/agents/forkSubagent.ts` 近行级同款三函数 | **aligned** | — | — |
| fork:递归护栏 | `AgentTool.tsx:332-334` querySource==='agent:builtin:fork' 或 isInForkChild() 硬抛(硬禁非深度上限) | `agentTool.ts:343-345` 同款硬抛 | **aligned** | — | — |
| fork:fork_context / querySource 标记 | 隐式触发(省略 subagent_type,`AgentTool.tsx:82-88`)| ts 隐式路径之外**另加显式** `fork_context` 布尔字段(`agentTool.ts:62-63,326,346`) | intentional-delta(超集) | P2 | — |
| worktree isolation 真隔离 | `utils/worktree.ts:737-813,937-987,996-1055,1179-1208`(真 `git worktree add -B`/dirty-check/remove),`AgentTool.tsx:590-682` 调用 | `tools/worktreeTools.ts:71-97,329-368`(真 worktree add/branch -D/status --porcelain),`agentTool.ts:404-407` | **aligned(核心)** | — | — |
| ├ worktree 周边缺:WorktreeCreate/Remove hook、node_modules 类目录 symlink(防磁盘爆)、settings.local.json 传播、husky/core.hooksPath 拷贝、`.worktreeinclude`、stale worktree GC(`cleanupStaleAgentWorktrees`)、PR/baseRef/sparse-checkout 选项 | `utils/worktree.ts` 各处 | 缺 | gap | P2 | L |
| sidechain transcript | `sessionStorage.ts:1022-1030,1480-1491` 同一 session JSONL 内打 `isSidechain=true` 标记、读时过滤(`:1254,3929,4231`) | `agentTool.ts:185-196` 每 run 独立文件 `<sidechainRoot>/transcripts/<agentId>.jsonl`+meta;`memory/transcript.ts` 无 isSidechain 字段 | **intentional-delta** | — | — |
| ├ 理由:同一目标(子代理轨迹不进主会话视图/压缩/回放),我们文件式存储(每 id 一文件)天然分离,无需布尔标记。符合"文件式存储"红线 | | | | | |
| stored-result 回读(agentMemory/snapshot) | `agentMemory.ts`(user/project/local 三 scope + MEMORY.md)+ `agentMemorySnapshot.ts`(snapshot.json/.snapshot-synced.json) | `agents/agentMemory.ts` 近 1:1 移植(同三 scope/同目录布局/同 snapshot 机制/同截断护栏) | **aligned** | — | — |
| ├ ts 独有:`read_agent_task_sidechain`/`read_agent_task_tool_result_window`(`agentTool.ts:539-650`,超大工具输出窗口化回读)——cc AgentTool/ 下未见对应物 | 无 | 有 | intentional-delta(ts 自增强,owner 知悉即可) | P2 | — |
| agent-specific MCP | `runAgent.ts:85-218` `initializeAgentMcpServers`(name-ref → memoize 共享 client;inline → 新连接;只清理自建的) | `agents/agentMcp.ts:80-172` 真实现非 stub(真连接/取工具/清理);deviation:name-ref 也每 run 新开连接不共享,close 时全拆 | aligned(真功能)+ minor deviation | P2 | S |
| SubagentStart/Stop hooks | `utils/hooks.ts:3951,3672-3692` + `registerFrontmatterHooks.ts:37-43`(agent 自带 Stop 注册期转 SubagentStop) | `hooks/hooks.ts:309-324,389` + `hookConfig.ts:137`(同款加载期转换)+ `agentTool.ts:433-441` spawn 处接线 + `loop.ts:320` | **aligned** | — | — |
| AgentSummary 周期摘要 | `services/AgentSummary/agentSummary.ts`:30s 间隔、≥3 条消息门槛、同款 gerund prompt、deny 工具、完成后才重排(不重叠)、存 AppState | `tasks/agentSummary.ts`:同 30s/同门槛/**prompt 逐字同**/直接 model.step()(等效禁工具)/同重排模式/存文件式 task JSON(`taskTools.ts:648`) | **aligned** | — | — |

## 二、后台任务 + 前台切后台(foreground handoff)

| 行为点 | cc | 我们 | 分类 | 级 | 量 |
|---|---|---|---|---|---|
| 前台注册生命周期 | `AgentTool.tsx:808-833` registerAgentForeground | `agentTool.ts:399-403` + `taskService.ts:382-424` | **aligned** | — | — |
| race:iterator.next() vs backgroundSignal | `AgentTool.tsx:883-897` | `agentTool.ts:473-502` Promise.race | **aligned** | — | — |
| handoff 前 iterator/MCP 清理(1000ms race) | `AgentTool.tsx:914-918` | `agentTool.ts:282-309,484-489`(同 1000ms、同顺序 iterator→MCP→handoff) | **aligned** | — | — |
| continuation snapshot(复用前台已产消息) | `AgentTool.tsx:919-924` | `agentTool.ts:466-468,493` + `taskTools.ts:541-544,670-679`(initialMessages+skipUserMessage 防重复 user turn) | **aligned** | — | — |
| progress seed | `AgentTool.tsx:920-924` | `taskTools.ts:180-222,544,614,626` handoffProgressFromMessages | **aligned** | — | — |
| AgentSummary snapshot 继承 | cc 实际也是 handoff 时重启 summarizer、previousSummary 置 null(`AgentTool.tsx:934-939`),只带 cache-safe params snapshot | `taskTools.ts:642-651` summarizer.updateSnapshot(snapshot)——对齐 cc **实际**行为(非理想化) | **aligned** | — | — |
| token usage 继承 | `AgentTool.tsx:505`(progress tracker 近似 token 数) | `agentTool.ts:505` + `taskTools.ts:553-558,613-621,695` + `loop.ts:177,405`(真 API usage 对象,比 cc 更精) | **aligned** | — | — |
| worktree 所有权转移 | `AgentTool.tsx:644-683` cleanupWorktreeIfNeeded 闭包共享 | `agentTool.ts:497,519-527`(backgrounded 则前台跳清理)+ `taskTools.ts:560-561` 后台复用同 session | **aligned** | — | — |
| 未 backgrounded 时 unregister | `LocalAgentTask.tsx:656-676` | `agentTool.ts:513-514` | **aligned** | — | — |
| HTTP 触发入口 `POST /tasks/:id/background` | cc 无(TUI 快捷键驱动) | `server/index.ts:4456-4499,4228-4264` | intentional-delta(headless server + 桌面壳必需) | — | — |
| todo-list:task_create/complete **blocking hooks** | `TaskCreateTool.ts:92-113` executeTaskCreatedHooks、`TaskUpdateTool.ts:232-265` executeTaskCompletedHooks | `taskListTools.ts:116-127,180-198` **无任何 hook 调用** | **gap** | P2 | M |
| todo-list:关 3+ 任务触发 verification nudge | `TaskUpdateTool.ts:326-349,396-398`(growthbook flag `tengu_hive_evidence` 门控) | 缺 | gap | P2 | S |
| todo-list:task_list 过滤 `metadata._internal` | `TaskListTool.ts:68-70` | `taskListService.ts:98-101` 无过滤(内部簿记任务会漏进列表) | gap | P2 | S |
| TaskStop `KillShell` 工具名别名 | `TaskStopTool.ts:44` aliases:['KillShell'] | `taskTools.ts:1051-1114` 只保留 shell_id **参数**兼容,无工具名别名(老 transcript/SDK 按名调 KillShell 会解析失败) | gap | P2 | S |
| task_update 所有权变更写 mailbox 通知 | `TaskUpdateTool.ts:276-298` writeToMailbox | taskListTools 侧未见;是否经 teamService 补上未验 | gap(待核) | P2(P3) | S |
| TaskStop forceConfirm 加严 | cc 无 forceConfirm | 本轮四域源码内未见 TaskStop 上的 forceConfirm 加严实现(例外清单预设项,现状=未发现该 delta 存在) | n/a | — | — |
| cc 任务类型覆盖 | LocalAgentTask/LocalShellTask=已覆盖(shell 侧 stall-detection 心跳未验);RemoteAgentTask/DreamTask=范围外(远程/cc 专属 UX);LocalWorkflowTask/MonitorMcpTask=**cc 侧本身是 DCE stub,无真源可比**;InProcessTeammateTask→见团队节 | mixed | — | — | — |

## 三、team / mailbox / UDS

| 行为点 | cc | 我们 | 分类 | 级 | 量 |
|---|---|---|---|---|---|
| TeamCreate=纯元数据不 spawn | `TeamCreateTool.ts:128-236` | `teamTools.ts:593-623` + `teamService.ts:319-358` | **aligned** | — | — |
| TeamCreate 的 Team↔TaskList 1:1 接线 | `TeamCreateTool.ts:182-191`(resetTaskList/ensureTasksDir/setLeaderTeamName) | 缺——taskService 无 teamName 概念(grep 零命中) | gap | P2 | M |
| **teammate 真正入队(加入 team.members)** | 经 Agent 工具 `team_name`+`name` 参数入队(`SendMessageTool.ts:201` 报错文案 + TeamCreateTool/prompt.ts step3 佐证) | `teamService.ts:309-317` mutateTeam **生产代码零调用**(主代理复核确认,仅 `teamTools.test.ts:116-138` 造数据用);agentTool.ts 无 team_name/teamName 参数 → **模型现状无法让任何 teammate 入队,team 永远只有 lead 一人**,TeamCreate/SendMessage/ListPeers 全家桶实际空转 | **gap** | **P1** | M |
| SendMessage:running 路由 | `SendMessageTool.ts:802-874` queuePendingMessage(内存) | `teamTools.ts:414-436` → `taskService.ts:492-499` liveSteerInboxes(内存),回执文案近逐字同 | **aligned** | — | — |
| SendMessage:stopped 路由(resume) | `SendMessageTool.ts:822-871` resumeAgentBackground | `teamTools.ts:438-469` → resumeBackgroundAgentTask,回执文案同款 | **aligned** | — | — |
| 名字寻址 mailbox 兜底(fs JSON+锁) | `teammateMailbox.ts:134-192`(proper-lockfile) | `teamService.ts:400-413`(mkdir 目录锁 withFileLock),create-if-absent(wx)→锁→重读→append→写 全同 | **aligned**(锁原语不同,行为等价) | — | — |
| broadcast `to:"*"` | `SendMessageTool.ts:191-266` | `teamTools.ts:471-504`(同自排除/lead 排除/同"No teammates to broadcast to"文案) | **aligned** | — | — |
| 结构化协议(shutdown/plan-approval) | `SendMessageTool.ts:268-518` | `teamTools.ts:506-590`(reject 必带 reason、shutdown_response 只准发 team-lead、plan 继承 `mode==='plan'?'default':mode` 全同) | **aligned** | — | — |
| ListPeers 字段面 | 工具本体是 **stub**(feature-gated);最近真源 `teamDiscovery.ts:11-33`(model/prompt/idleSince/isHidden/三态 status) | `teamTools.ts:136-155` + `teamService.ts:443-479`(isActive 布尔/unreadMessages/isLead;缺 model/prompt/idleSince/isHidden) | gap(带 stub 保留意见) | P2 | S |
| **UDS 跨会话 IPC(我们有、cc 有没有?)** | **cc 有此设计但对外版被扒成 stub**:`feature('UDS_INBOX')` 真实存在(`SendMessageTool.ts:72-85,586-798`)、`uds:<socket>` 寻址 scheme、prompt.ts 明文 "Local Claude session's socket (same machine; use ListPeers)"、入站包 `<cross-session-message from="...">`;实现文件(udsClient/udsMessaging/ListPeersTool/bridge/peerSessions)全是 `@generated stub`(ant-internal DCE) | 完整实现:`udsInbox.ts`(net.createServer)/`udsClient.ts`/`udsPeerRegistry.ts`/`peerAddress.ts`/`crossSessionMessages.ts`(`CROSS_SESSION_MESSAGE_TAG='cross-session-message'` 与 cc 逐字同)+ `server/index.ts:1531-1545,2008-2009` 接线 | **intentional-delta(非 deviation)** | P1(仅提示存在,非缺陷) | — |
| ├ 判词:①cc 本地默认 team 通信 = 纯文件 mailbox(teammateMailbox.ts 全文无 net/socket,useInboxPoller 1000ms 轮询),我们 teamService 是它的忠实移植;②UDS 是 cc 自己设计的第二机制(feature-flag 对外关),我们把它做完整了,tag/scheme/文案与 cc 残片高度吻合 = 照 cc 设计补全而非自造;③架构必要性真实:我们的会话可以是独立 sidecar 进程,无共享 Node 堆可查内存 Map,socket 是正确原语(cc 在 tmux/iTerm2 多进程后端遇到同一问题时选的也是它) | | | | | |
| team memory sync | `services/teamMemorySync/index.ts` 真实现:跨用户/跨机器经 Anthropic 云 API 同步 org 记忆,须第一方 OAuth+org 成员(`index.ts:151-161`) | 缺,且**该缺正确**:免登录单用户全本地架构下无 org/OAuth 概念,属范围外 | intentional-delta / out-of-scope | — | — |

### UDS inbox flaky 排查(只读代码判断)

1. **真 bug · accepted socket 无 'error' 监听**(`udsInbox.ts:23-33`,主代理复核:全文件无 `on('error'`):客户端中途死掉(ECONNRESET/EPIPE)→ EventEmitter 零监听 error 直接 throw → **可能带崩整个 sidecar 进程**(不只丢消息)。一行修复(`socket.on('error',()=>{})`)。P1、S。这就是 flaky 最可疑病灶。
2. **server 对象启动后无 error 监听**(`udsInbox.ts:35-47`):`server.once('error',onError)` 只盖 listen 阶段且 listening 后主动 off;运行期 EMFILE/socket 文件被外删等同属 1 的崩溃风险类。P2、S。
3. **accepted 连接无超时**:无 `socket.setTimeout`,发端挂死不发 FIN → 消息永远静默不投递 + 连接泄漏(发端 udsClient.ts:9,23-26 自带 5s 超时,故良性发送方会拿到明确失败;收端裸奔)。P2、S。
4. **framing 无 bug(专项排除)**:协议 = 一连接一消息、client `socket.end(message)` FIN 定界(`udsClient.ts:29-31`),server 端 data 全缓冲、end 才处理(`udsInbox.ts:26-32`)——正确处理流式分片,不是"一 write 一 read"经典坑。
5. **崩溃遗留 peer 清不掉**:`udsPeerRegistry.ts:125-134,198-205` 只用 `fs.stat` 判 socket 文件存在、不探活;SIGKILL/断电后遗留 socket 文件 → 死 peer 一直出现在 ListPeers。影响有界(对死 peer 发消息会 ECONNREFUSED 快速失败),属卫生问题非丢数据。优雅退出路径(`server/index.ts:2008-2009`)清理正确。P2、S。
6. minor:注册表 mkdir 锁最坏 ~2s 等待;list() 无变化也走写锁重写周期。理论性能项,非正确性。P3。

## 四、计划模式 + goals

| 行为点 | cc | 我们 | 分类 | 级 | 量 |
|---|---|---|---|---|---|
| EnterPlanMode(切 mode='plan') | `EnterPlanModeTool.ts:82-94` | `loop.ts:1041-1073`(ts 多 reason/timeout_ms 参数,cc 无参——外观差异) | **aligned** | — | — |
| EnterPlanMode 审批门 | prompt 声称需审批,但工具/权限层未定位到强制点(grep 无果,cc 侧机制未证实) | `loop.ts:1041-1068` 无条件走 ask_question(更严) | deviation(cc 侧未证实) | P2 | — |
| **ExitPlanMode 从磁盘文件读 plan(非工具参数)** | `ExitPlanModeV2Tool.ts:246-253` getPlanFilePath/getPlan;prompt.ts 明文"does NOT take the plan content as a parameter" | `loop.ts:1075-1084` 同款 getPlanFilePath/getPlan + 空文件护栏;`agentInteractionTools.ts:89-100` schema 刻意无 plan 字段 | **aligned** | — | — |
| ExitPlanMode 空 plan 处理 | `ExitPlanModeV2Tool.ts:462-468` 空 plan 也放行 | `loop.ts:1080-1083` 拒绝并教模型先 write_file(更严) | deviation(合理,非字面对齐) | P2 | S |
| ExitPlanMode 批准后 mode 落点 | `ExitPlanModeV2Tool.ts:357-403` 恢复 prePlanMode(含 auto/断路器逻辑) | `loop.ts:1088-1099` 硬编码 acceptEdits(代码注释明示简化) | intentional-delta | P1 | M |
| **VerifyPlanExecutionTool** | **cc 侧是 stub**(VerifyPlanExecutionTool.ts 与自家 constants.ts MD5 同为 @generated stub);真 cc 中双重门控:`tools.ts:90-97` `CLAUDE_CODE_VERIFY_PLAN==='true'` + `classifierDecision.ts:37-42` `USER_TYPE==='ant'` = **ant 内部 dogfood 实验工具,非对外行为** | `verifyPlanExecutionTool.ts:1-178` 完整实现且**无条件常开**:`loop.ts:1093-1099` 设 pendingPlanVerification,每 3 次工具调用催一次(reminders.ts VERIFY_PLAN_REMIND_EVERY)+ 回合末再催(`loop.ts:588-595`) | deviation(超出任何对外 cc 行为;无 spec 可验) | P1 | M |
| **plan 落盘(fce9910)真伪** | cc:`utils/plans.ts:79-129`(`~/.claude/plans/{adj-verb-noun}.md`,子代理 `-agent-{id}` 后缀)四层架构:fs 模块→工具路径→权限门→每轮 reminder | **真落地非死码**,同款四层:①`harness/plans.ts:37-111` 真 fs I/O(`<workspace>/.billiardbuddy/plans/`,同 slug 算法/同子代理后缀)②`loop.ts:68` import,`:1049` enter 告知路径、`:1078-1079` exit 从盘读 ③`permissions/resolve.ts:7,16-21,169-177` plan 模式下唯一可写文件=本会话 plan 文件(热路径真强制)④`reminders.ts:8-24,63-71` 每轮注入路径+工作流 | **aligned(白标目录=intentional-delta)** | — | — |
| ├ 小勘误:fce9910 提交信息把"工作流系统提示"记在 systemPrompt.ts,实际在 reminders.ts(systemPrompt.ts 的 diff 全是记忆注入)。功能属实、引用文件错 | | | 记录归档 | P2 | — |
| plan 模式每轮 reminder 变体 | `utils/messages.ts:3253-3535`(full/sparse/subagent/interview 多变体) | `reminders.ts` 单一平铺变体 | gap(轻) | P2 | S |
| `/plan` 斜杠命令(查看/打开 plan 文件) | `commands/plan/plan.tsx:64-121` | 缺(只有模型侧 enter_plan 入口,用户无手动查看/打开入口) | gap | P2 | S |
| plan 恢复(resume/fork:copyPlanForResume/copyPlanForFork/persistFileSnapshotIfRemote) | `utils/plans.ts:164-397`(主要解 CCR 远程会话文件不持久问题,local 下 persistFileSnapshotIfRemote 本就 no-op) | 缺 resume 时 plan-slug 恢复 | gap(低优;主因是远程场景) | P2 | S |
| ultraplan | `utils/ultraplan/`(ccrSession 远程 teleport 轮询 + 关键词触发)= **远程 CCR 功能** | 缺,正确 | out-of-scope | — | — |
| goals:goalState | `goals/goalState.ts:1-239`(Stop-hook 长任务目标评估器:注入 `<goal-objective>`,判 `{"ok":true/false}` 决定放行/续跑) | `goals/goalState.ts:1-219` 近行级移植;`server/index.ts:481-507,1597` /goal 命令接线;`loop.ts:316-339` Stop-hook 续跑接线;`Goal set:/cleared:/complete.` 标记逐字同 | **aligned** | — | — |
| ├ 存储:cc 用 AppState.sessionHooks,我们内存 Map + createGoalHookRegistry(`server/index.ts:1631`)——无全局 AppState 的架构适配,行为等价 | | | intentional-delta(架构适配) | — | — |

---

## 已知待办核对结果

### ① fork 类型后台代理 resume(142dd27)— **真修了,结构完好**
- `taskTools.ts:746-797` resumeBackgroundAgentTask:`:767` 判 `agentName === FORK_SUBAGENT_TYPE` → `:767-776` 重建合成 AgentDefinition(name/description/prompt/filePath/permissionMode/maxTurns)作 forkAgentOverride → `:791` 经 runOptions.agentOverride 传入;`:530` startBackgroundAgentRun 里 `agentOverride ?? (forkContext? 合成 : pickAgent)`,override 优先,绕开原先抛"需要指定 agent"的 pickAgent 路径。
- 字段级对称性核过:与 spawn 时合成定义(`agentTool.ts:349-355`)逐字段同形;tools/allowedToolRules/isolation/hooks 两条路径都是 undefined,无不对称。commit 后还有一处严格改进:`maxTurns: opts.maxTurns` → `?? FORK_AGENT_MAX_TURNS`(补齐 spawn 侧兜底)。回归测试在 `taskTools.test.ts:487-494`。

### ② 矩阵 §3.298–§3.306 八项 foreground handoff 声称 — **8/8 confirmed-in-current-code**(非过期声称、未被后续改动冲掉)
registry 地基(taskService.ts:382-455)/registration 生命周期(agentTool.ts:399-403,511-517)/race 接管入口(agentTool.ts:470-502)/continuation snapshot(taskTools.ts:541-544,670-679)/progress seed(taskTools.ts:180-222)/AgentSummary snapshot(taskTools.ts:642-651)/token usage(agentTool.ts:505+taskTools.ts:553-558,613-621,695+loop.ts:177,405,下游真用非死管)/worktree ownership(agentTool.ts:497,519-527+taskTools.ts:560-561)/MCP cleanup(agentTool.ts:282-309,484-489,1000ms race 同 cc)。各节"口径"里自认的欠账都被同批下一节闭环,现码=堆满后的终态。

### ③ UDS inbox flaky — **有真 bug 藏着**
最可疑病灶 = `udsInbox.ts:23-33` accepted socket 零 'error' 监听(客户端中途断连即未捕获异常,可崩 sidecar);次级 = server 运行期无 error 监听、收端无连接超时、崩溃遗留 socket 文件不探活致死 peer 常驻 ListPeers。framing 专项排查无问题(FIN 定界 + 全缓冲,正确)。详见第三节排查小节。

---

## 修复优先级速览(P1,均为小-中量)

| # | 项 | 建议量 |
|---|---|---|
| 1 | udsInbox accepted-socket 补 'error' 监听(+server 运行期监听)——flaky 根因兼进程崩溃风险 | S |
| 2 | teammate 入队断链:agentTool 补 team_name/name 参数接 mutateTeam(或明确砍 team 全家桶前不宣称可用) | M |
| 3 | AgentDefinition.model 解析后未接线(effort 未解析):要么接进 runAgent 路径,要么文档化"单模型架构不支持"并加载时告警 | M |
| 4 | ExitPlanMode 批准后硬编码 acceptEdits vs cc 恢复 prePlanMode——确认是否保留简化(现有注释已自认) | S(决策)/M(对齐) |
| 5 | VerifyPlanExecution 常开+每 3 次工具催办 = 超出任何对外 cc 行为,cc 侧本身是 ant-internal 实验;交 owner 确认保留或降级 flag 门控 | S(决策) |
