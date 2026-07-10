# cc-haha 对齐审计 · 第三批:会话存储 / transcript / rewind / checkpoint / resume

> 只读审计,两仓库源码亲读独立核对,不采信 `ts/docs/alignment-notes.md` 自评(已发现该文档遗漏两个更严重的生产环境未接线 bug)。
> spec = `~/Desktop/cc-haha-ref`(当前源码)。现状 = `/Users/swl/Desktop/球房运营AI助手-桌面版/ts`(工作树未提交改动为准)。

## 头号发现(比 alignment-notes 自评严重得多,必须先看)

### 🔴 F1(P0):`ctx.messageId` 从未被主循环赋值 —— message 级 checkpoint/rewind 在生产环境实质上"从没工作过"

- `ts/src/tools/Tool.ts:66` 声明 `messageId?: string`,注释称"主循环发起工具调用前置好"。
- `ts/src/tools/fileHistory.ts:94` 写入 `FileHistoryRecord` 时 `...(ctx.messageId ? { messageId: ctx.messageId } : {})`——`ctx.messageId` 恒为 `undefined` 时,这个字段**永远不写入**。
- 对 `ts/src/harness/loop.ts` 全文 grep `messageId`(含 `gateOneCall`/`executeAllowedToolCall`/`prepareParallelReadOnlyCall` 等全部工具执行入口)**零命中**——没有任何一处代码把预生成的 assistant uuid 塞进 `ctx.messageId`。`ts/src/memory/transcript.ts:516-517` 的注释("主循环给发起工具调用的 assistant 消息预生成 uuid 并作 file-history 的 messageId")描述的是**从未实现的设计意图**,不是现状。
- 下游 `ts/src/server/services/sessionRewindService.ts` 四处消费点全部以 `r.messageId !== undefined` 为门(168/172/295/400 行)——由于生产环境写入的每条 `FileHistoryRecord.messageId` 恒为 `undefined`,这些 filter **恒为空集**。
- 实际后果(生产环境,不是理论推演):
  - `listTurnCheckpoints` 对任何真实会话恒返回 `[]`(每轮都因 `changes.length === 0` 被跳过)。
  - `previewRewind`/`executeRewind` 的 `buildRewindCodePreview` 恒返回 `{available:false, reason:'No file checkpoint is available for the selected message.'}`。
  - `executeRewind` 里"真的把文件恢复回目标之前"的整段(`if (code.available) { ... restoreFileFromHistory ... }`)**永远不会执行**——用户点"回退到这条消息",transcript 会被正确裁短(`rewindTo` 本身没问题),但**文件一个都不会被还原**,产品承诺的"回退连文件一起退"完全落空。
- 为什么测试全绿却没测出来:`ts/src/server/services/sessionRewindService.test.ts:43/47/145/173` 全部手工在 `ToolContext` 里硬编码 `messageId: 'msg-a1'` 等固定值来单测 `sessionRewindService` 内部逻辑——测的是"如果 messageId 被正确传入,这段代码对不对",从未验证"loop.ts 真的会把它传入"这条生产环境的关键连线,造成单测全绿、集成断链的假阳性。
- 修复量级:S(把 `ctx.messageId` 在 `loop.ts` 的 assistant 消息构造处(约 618 行 `messages.push({role:'assistant', content: asstContent})` 之前)预生成 uuid 并写入 `ctx.messageId`,再让 `Transcript.stamp()` 复用同一个 uuid(其 `stamp()` 已经支持复用 `(message as MessageProvenance).uuid`,只差没人把这个 uuid 也镜像进 `ctx.messageId`)——地基都在,只差一行连线 + 回归测试(真跑一次 loop→写文件→listTurnCheckpoints 断言非空)。

### 🔴 F2(P0):`Transcript.recordCompaction()` 从未被 loop.ts 调用 —— 压缩后 `loadFullHistory`/`rewind`/UI 回看会永久丢失压缩前历史

- `ts/src/harness/loop.ts:123-129` 的 `TranscriptLike` 接口(loop 依赖的唯一契约)里根本没有 `recordCompaction` 方法——loop 只认 `load()`/`append()`。
- `ts/src/harness/loop.ts:424-468` 的 `maybeCompact()` 在压缩成功后只是 `messages = out.messages`(替换成"摘要+近段"的短数组),随后仍旧调用通用的 `saveTranscript()`(=`opts.transcript.append(messages)`,loop.ts:307-314/587)。
- `ts/src/memory/transcript.ts:381-405` 的 `recordCompaction()`(专门写 `compact-boundary` 并把 `parentUuid` 接回压缩前链尾的正确实现)**只在 `ts/src/memory/transcript.test.ts:113/314/473` 里被调用过**,生产路径完全绕过它。
- 推导实际后果:`compactPipeline`(`ts/src/context/compaction.ts:308-312`)产出的压缩后首条消息是全新对象 `{role:'user', content:[textBlock('[此前对话摘要]...')]}`,在 `view`(压缩前持久化链)里绝不存在 → `append()`(`transcript.ts:322-372`)公共前缀比对在 `k=0` 处就分叉 → `boundaryParent = bi===-1 ? null : ...` 取 `null`(`transcript.ts:358`)→ 整个压缩后数组被当作**全新根**(`parentUuid:null`)重新打戳追加。`reconstructChain()`(`transcript.ts:181-198`)从文件最后一行(= 这个新根链的尾)往回溯,**永远够不到压缩前那条链**(没有任何 parentUuid 指回去)。
- 与 cc 对比:cc 的真实压缩边界(`sessionStorage.ts:1055-1070` `insertMessageChain`)虽然也把边界的 `parentUuid` 设为 `null`,但**额外**用 `logicalParentUuid` 字段保留指回压缩前链尾的逻辑指针,供需要"完整历史"的读路径专门遍历;我们的通用 `append()` 分支**没有任何等价的二级指针**,一旦走这条路径,压缩前历史对 `loadFullHistory()`/`loadFullHistoryStamped()`/`loadPage()`/rewind 全部永久不可达(字节还在磁盘上,但没有任何读路径能到达——事实上等价于丢数据)。
- 直接后果链:①UI"查看完整对话"在压缩后看不到压缩前内容;②`sessionRewindService.loadStampedHistory()` 调 `loadFullHistoryStamped()`,压缩前的任何 user 消息都从候选目标里消失——**用户无法回退到上一次压缩之前的任何一轮**;③`SessionService.fork()`(ts/server/services/sessionService.ts:174-176)用 `loadFullHistory()` 拷贝,fork 出来的新会话同样丢压缩前历史。
- `ts/src/harness/loop.test.ts` 的三个压缩用例(2176/2206/2233 行)全部不传 `transcript:` 选项(只用 `initialMessages`),从未端到端验证过"压缩 + 真实 Transcript.append() + 之后 reload"这条链路——测试盲区与 F1 同源(单元测试绿、集成断链)。
- 修复量级:M(`maybeCompact()` 压缩成功分支改为调用 `opts.transcript.recordCompaction(preCompact, postCompact, meta)` 而非通用 `append()`;需要拿到"压缩前完整未裁剪的 messages"作为 `preCompactMessages` 参数,当前 `compactPipeline` 输出里没直接暴露、需要在调用处补一个变量;另需补一条"压缩后 append→reload→loadFullHistory 仍含压缩前历史"的集成回归测试)。

---

## 发现表

| 行为点 | cc + file:line | 我们 + file:line(或"缺") | 分类 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| transcript uuid/parentUuid DAG 基本模型 | `sessionService.ts` `MessageEntry.parentUuid`(116-127)+ `RawEntry.parentUuid`(206-246);真实写入见 `sessionStorage.ts:1054-1098` `insertMessageChain` | `memory/transcript.ts:38-39`(`StampedMessage`)+ `reconstructChain`(181-198) | aligned | - | - |
| 存储写路径:整表重写 vs append-only 分支 | `sessionService.ts:2975-3031` `trimSessionMessagesFrom`(读全部→过滤→`fs.writeFile` 整表重写) | `memory/transcript.ts:415-445` `rewindTo`(只 append 一条 `rewind-boundary`,旧分支留痕不删) | intentional-delta(例外①) | - | - | 行为对外等价:`load()`/`loadFullHistory()`/`loadPage()` 视图裁短一致;已有 3 组回归(`transcript.test.ts` rewindTo 用例)验证 |
| 压缩边界写入(compact-boundary)是否真的被生产路径调用 | `sessionStorage.ts:1054-1070` `insertMessageChain` 对每条消息判 `isCompactBoundaryMessage`,实时同步写入(每条独立 `appendEntry`) | `harness/loop.ts` 的 `maybeCompact`(424-468)从不调用 `Transcript.recordCompaction()`(该方法只在测试里被调用,见 F2) | **gap** | **P0** | M |
| 逐条落盘时机(每条消息 vs 按轮/边界批量) | `sessionStorage.ts:1022-1098` `insertMessageChain` 对**每一条**消息(user/assistant/tool_use 拆分后的每条)单独 `appendEntry`,近乎实时同步落盘 | `harness/loop.ts` 只在 `step.kind==='final'`/abort/压缩/stop-hook 边界调用 `saveTranscript()`(307-314,522,559,574,587,327,339);多轮工具调用中途(`tool_calls` 分支,605-757 行)**没有任何一次落盘**,整轮工具调用要等到该轮自然收尾才批量写入 | **gap** | **P1** | M | 崩溃语义差:进程在多轮工具调用中途崩溃,cc 已发生的每条消息都在盘上;我们这一整段"从上次 saveTranscript() 到崩溃"之间的消息(哪怕工具已经真的执行、文件已经真的改了)**从 transcript 里彻底消失**,且这些工具调用产生的 fileHistory 记录的 `messageId`(若 F1 修复后)会指向一个从未落盘的幽灵 uuid |
| checkpoint 数据源:per-user-message 快照 vs per-write 前像记录 | `utils/fileHistory.ts:86-193`(`fileHistoryTrackEdit`,轮内只记一次)+ `198-342`(`fileHistoryMakeSnapshot`,每条 user 消息一份 `trackedFileBackups`);落盘见 `sessionService.ts:3033-3070` `getSessionFileHistorySnapshots` 读 `file-history-snapshot` 类型条目 | `tools/fileHistory.ts:83-134` `recordFileSnapshot`(每次真写前记一条,不去重)+ `server/services/sessionRewindService.ts:107-114` `firstRecordPerPath` 取轮内最早一条 | intentional-delta(例外②) | - | - | 已核实三类边界行为等价:同轮同文件先删后建(两边都取"轮首前像")、轮内新建文件(两边都在 rewind 时按"不存在"删除)、无写入轮(两边都跳过不出现在 checkpoint 列表) |
| **rewind 四能力之一:`getSessionTurnCheckpointDiff`(单文件 diff 端点)** | `sessionRewindService.ts:970-1080` `getSessionTurnCheckpointDiff` + 路由 `server/api/sessions.ts:161-171`(`GET .../turn-checkpoints/diff?path=`) | **缺**——`ts/src/server/services/sessionRewindService.ts` 只有 `listTurnCheckpoints`/`previewRewind`/`executeRewind` 三个方法;`server/index.ts:4563` 的路由正则 `(turn-checkpoints\|rewind)` 没有第四个 `diff` 分支 | **gap** | **P1** | S-M | 服务层已有 `computeTurnFileChanges`(sessionRewindService.ts:161-194)可复用大部分逻辑,只需补"单 path 定位 + 生成 unified diff 文本"(参考 cc `buildCheckpointDiff`,createTwoFilesPatch,我们 `tools/fileHistory.ts` 的 `previewRestore` 已经在用 `structuredPatch`,同款依赖已在) |
| rewind 四能力之二三四:list/preview/execute | `sessionRewindService.ts:916-968`/`886-914`/`1082-1152` | `server/services/sessionRewindService.ts:216-257`/`259-275`/`277-322` | aligned(形状/边界对齐,但 F1 未修前实质空转) | - | - | |
| executeRewind 部分失败无回滚 | `sessionRewindService.ts:1082-1152`(逐文件 `unlink`/`restoreBackupFile`,循环外无 try/catch,失败即整函数抛出、已恢复文件不回滚、`trimSessionMessagesFrom` 也不会跑) | `sessionRewindService.ts:277-322`(逐条 `restoreFileFromHistory`,同样无 try/catch,失败则 `rewindTo` 也不会执行) | **aligned**(两边都有此继承性限制,不是我们独有的退化) | - | - | alignment-notes 的自评"继承风险"经核实**属实** |
| 执行中会话中断等待:等待语义 | `conversationService.ts:47`(`DESKTOP_CLI_GRACEFUL_SHUTDOWN_TIMEOUT_MS=6000`)+ `798-848`(`stopSessionAndWait`:SIGTERM 等最多 6s→SIGKILL+等 0.5s→`waitForProcessOutputDrain` 再等最多同一 timeoutMs≈6s,总计约 12.5s **有界**,但真实同步在"OS 进程已退出"这个硬事实上) | `server/services/sessionRewindService.ts:64`(`INTERRUPT_WAIT_TIMEOUT_MS=10_000`)轮询 `turns.isRunning()`;`sessionService.ts:418-425` `TurnRegistry.interrupt()` **同步**把 controller 从 map 删除,调用完当场 `isRunning()` 就已经是 `false` | **gap** | **P1** | M | alignment-notes 自称"cc 无超时上限"**不准确**(cc 实际约 12.5s 有界,但强度不同):cc 是真的杀掉子进程、等它物理退出后才动文件;我们的"等待"只是等一个被自己立即清空的标志位,`waitUntilStopped` 的 while 循环在 `executeRewind` 调用它之前 `isRunning` 就已经是 false,**结构上从未真等待过**——如果在飞的工具调用仍在异步写文件(interruptBehavior≠'cancel' 的工具、或 cancel 但 IO 已发出未回),rewind 的文件恢复可能与仍在收尾的工具写发生竞态,cc 靠"真杀进程"从根上排除了这个竞态,我们没有 |
| 工作区外文件的 rewind 恢复 | `server/services/filesystemAccessRoots.ts:27-38` `registerChangedFileAccessRoot` + 调用点 `server/api/sessions.ts:956` | 缺——`sessionRewindService.ts` 构造的 `ToolContext`(334-336 `buildBaseCtx`)不带任何工作区外授权,`workspace.resolve(path,'write')` 会对越界路径抛错 | **gap**(自认属实) | P2 | S-M | 只在"工具曾经被 allowedTools 授权写到工作区外"这个边缘场景触发;E2E 概率低于 F1/F2,但一旦命中会让 `executeRewind` 直接抛错、连transcript trim 都不会跑(抛错发生在文件恢复循环内,先于 `rewindTo`) |
| resume 残尾清洗:未配对 tool_use / 孤儿 thinking / 空白 assistant | `utils/conversationRecovery.ts:164-252` `deserializeMessagesWithInterruptDetection` 内的 `filterUnresolvedToolUses`/`filterOrphanedThinkingOnlyMessages`/`filterWhitespaceOnlyAssistantMessages` | `harness/messageSanitize.ts:11-46` 三个同名语义函数 + `61-68` `sanitizeResumeMessages` | aligned | - | - | 逻辑一一对应,验证过 |
| resume 中断检测 + 自动续接(`interrupted_turn`→合成"Continue from where you left off.") | `utils/conversationRecovery.ts:272-333` `detectTurnInterruption` + 154-252 主流程里合成续接 user 消息、追加哨兵 assistant | 缺——全仓库 grep "续接/自动继续/中断检测/interrupted_turn" 类关键词、`skipUserMessage` 用法(仅见于 subagent fork/handoff,`tasks/taskTools.ts:679`、`agents/agentTool.ts:452`),主会话 resume 路径没有等价机制 | **gap** | P2 | M | 架构差异部分缓解:我们每次调用都强制带 `opts.userMessage`(HTTP 请求-响应式,没有"进程被杀后自动重启续跑"这个场景),且 `normalizeMessagesForAPI` 会合并连续 user 消息,不至于直接 400;但"交易在工具执行完成、assistant 文本还没生成时会话被打断"之后,没人主动告诉模型"接着刚才的说",纯等用户手动再发一句,体验/正确性都弱于 cc;与既有路线图"长任务后台化"缺口重叠 |
| 会话 fork(整份拷贝) | cc `--fork-session`(`sessionRestore.ts:412-474`,新 sessionId、保留 parentUuid、复制 fileHistory 备份见 `utils/fileHistory.ts:922-1046` `copyFileHistoryForResume`) | `server/services/sessionService.ts:168-178` `fork()`:新 id + `loadFullHistory()` 全量拷贝 + `Transcript.save()` 重新打戳 | aligned(语义等价:整会话克隆) | - | - | ⚠️若 F2 未修,fork 出的新会话同样看不到源会话压缩前历史(继承 F2 的缺陷,不是 fork 自身问题) |
| 会话"从任意历史消息分支出新会话"(branch,不同于整份 fork) | `utils/sessionBranching.ts` `createSessionBranch` + 路由 `server/api/sessions.ts:897-947`(`POST .../branch`,带 `targetMessageId`) | 缺——`sessionService.ts` 只有整份 `fork()`,没有"从消息 X 分支"的能力 | **gap** | P2 | M | 与"fork"是相邻但不同的产品能力(cc Desktop 用于"从对话中间探索另一条路径");任务描述里"fork(拷贝transcript)"对应的是上一行,这一行是额外发现,补充记录 |
| 会话文件里的 file-history 快照没有真正落到某个 messageId | 见 F1 | 见 F1 | **gap** | P0 | S | 已在头号发现详述,此处不重复 |
| 会话列表/项目聚合:分页 + workDirExists + 缓存 | `sessionService.ts:2332-2425` `listSessions`(project 过滤、offset/limit 分页、`workDirExists` 探测、结果内存缓存) | `server/services/sessionService.ts:133-146` `list()`(只有 `workspaceRoot` 过滤,无分页/无 workDirExists/无缓存)+ `149-166` `recentProjects()` | intentional-delta / P3 | P3 | S | 会话量小时无感;会话/项目量大时列表接口一次性返回全量、且不检测工作目录是否还存在,属产品体验缺口而非存储正确性问题,优先级明显低于 F1/F2,故只记录不展开 |
| 会话/项目索引丢失时的自愈重建 | cc:transcript 本身即真相源(逐条 `session-meta`/`custom-title` 等元条目内嵌),`listSessions` 直接扫描重建 | `server/services/sessionService.ts:133-146` `list()` + `330-364` `rebuildIndexFromDisk`(从 provenance 戳 `cwd`/`timestamp`/首条 user 文本重建 `sessions.json` 缓存) | aligned | - | - | 两边都做到"索引只是缓存、可从 transcript 重建",机制不同但目标一致 |
| migrations 机制 | `server/services/persistentStorageMigrations.ts`(provider-index/managed-settings 版本化迁移)+ `desktop/src/lib/persistenceMigrations.ts`(Electron localStorage UI 状态迁移)——**均不涉及 transcript/session 存储格式**,transcript 老格式靠读时容错(如 `migrateLegacyAttachmentTypes`,`conversationRecovery.ts:77`) | `ts/src/migrations/{types,registry,runner,versionStore,index}.ts`(版本化+启动执行+幂等+已应用版本持久化的地基,`registry.ts` 当前**有意留空**,面向未来 settings/数据 schema 迁移)——transcript 老格式同样靠 `parseEntries`/`reconstructChain` 读时容错(`memory/transcript.ts` "遗留裸行"兼容分支) | aligned | - | - | 两边都没有"transcript schema version 迁移"这个东西,都是容错读;config/settings 迁移地基思路一致(版本化+幂等),我们照抄的是地基不是内容,符合 registry.ts 注释里说明的意图 |

---

## 已知风险核对结果(逐条独立复核,不采信文档自评)

1. **"executeRewind 部分失败无回滚,cc 同样没做" —— 核实为真。**
   cc `sessionRewindService.ts:1082-1152` 的恢复循环(`unlink`/`restoreBackupFile`)在 for 循环外没有 try/catch,某个文件恢复抛错会让整个 `executeSessionRewind` 直接向上抛,已经恢复完的文件不会被撤销,且因为抛错发生在 `trimSessionMessagesFrom` 之前,transcript 也不会被裁剪——文件和会话都停在"半恢复"状态。我们的实现(`ts/server/services/sessionRewindService.ts:277-322`)结构完全对应:同样在 for 循环里逐条 `restoreFileFromHistory`,同样没有回滚,同样是恢复循环全部跑完(或中途抛错)之后才调 `rewindTo`。**两边风险等价,不是我们退化出来的独有缺陷。**

2. **"中断等待名义 10s、实际近乎立即返回" —— 核实为真,且比自评描述的更值得关注。**
   `TurnRegistry.interrupt()`(`ts/server/services/sessionService.ts:418-425`)同步执行 `controller.abort()` 后立刻 `this.controllers.delete(sessionId)`,`isRunning()` 随即返回 `false`。`SessionRewindService.executeRewind` 里先调 `turns.interrupt(sessionId)` 再调 `waitUntilStopped`,但 `waitUntilStopped` 的 while 循环条件 `this.turns.isRunning(sessionId)` 在进入循环体前就已经是 `false`——**循环从未真正等待过一次**。对照 cc:`stopSessionAndWait` 不是"无超时上限"(实测 `DESKTOP_CLI_GRACEFUL_SHUTDOWN_TIMEOUT_MS=6000`,总耗时上限约 12.5s,是**有界**的),但它等待的是"SIGTERM/SIGKILL 之后子进程真的退出"这个硬事实,再等输出管道 drain 完——是真同步。我们的"名义 10s"连"有界"都不构成实际意义上的保护,因为判定条件在等待开始前就已满足。**修正 alignment-notes 的表述:不是"cc 无界、我们有界更保守",而是"cc 有界但真同步于进程死亡,我们的等待结构性地从不生效"。** 若某个非 cancel 类工具此刻正在异步写文件,rewind 的文件恢复与之竞态的风险是真实存在的,不只是"结构上留好协议"这么轻描淡写。

3. **"工作区外文件的恢复会抛错(未覆盖)" —— 核实为真。**
   `SessionRewindService.buildBaseCtx`(`ts/server/services/sessionRewindService.ts:334-336`)构造的 `ToolContext` 只有 `workspace`/`stateRoot`/`conversationId`,没有任何 `registerChangedFileAccessRoot` 等价的越界授权;`Workspace.resolve(path,'write')` 对越界路径的行为会抛错。cc 确有 `registerChangedFileAccessRoot`(`filesystemAccessRoots.ts:27-38`)专门解决这个场景。属实认的差距,且目前无回归测试覆盖,但触发条件(工具曾被显式 allowedTools 授权写到工作区外)在当前产品形态下概率较低,优先级定 P2 合理。

---

## 分类计数

- **aligned**:9 项(transcript DAG 基本模型、rewind 3/4 服务方法形状、checkpoint 数据源语义、executeRewind 部分失败无回滚、resume 残尾三过滤器、fork 整体语义、索引自愈重建、migrations 机制)
- **intentional-delta**(含既定例外):3 项(append-only 分支 vs 整表重写、checkpoint 数据来源形状、会话列表分页/缓存)
- **gap**:8 项 —— **P0 × 2**(F1 messageId 未接线、F2 recordCompaction 未接线),**P1 × 3**(逐条落盘时机、getSessionTurnCheckpointDiff 缺失、中断等待结构性失效),**P2 × 3**(registerChangedFileAccessRoot 缺失、resume 自动续接缺失、session branch-from-message 缺失)
- **deviation**:0 项(未发现"看似对齐实则语义错误"的第三类问题,已发现的问题要么是彻底缺失[gap]要么是确认等价[aligned/intentional-delta])
