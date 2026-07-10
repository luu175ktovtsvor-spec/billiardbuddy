# 对齐笔记(cc-haha 对标的有意分叉记录)

> 📌 状态:✅现行 · 最后核对 2026-07-10

本文件记录"内核对标 cc-haha,但存储/执行细节因本仓库既有铁律(append-only JSONL、无 SQL、审批闸只卡三类等)
而**有意**分叉的地方——不是漏抄,是权衡后的选择。逐条写清:cc 怎么做、我们怎么做、为什么不一样。

## rewind/checkpoint 上层服务(sessionRewindService,本轮新增)

对标 cc-haha `src/server/services/sessionRewindService.ts` + `src/server/api/sessions.ts` 的 rewind 相关路由。
本仓库落地:`ts/src/memory/transcript.ts`(存储层扩展)+ `ts/src/server/services/sessionRewindService.ts`(新服务)
+ `ts/src/server/index.ts`(新增 `GET/POST /(api/)?sessions/:id/(turn-checkpoints|rewind)` 路由)。

### 1) 存储机制:append 分支 vs 整表重写

- **cc-haha**:`trimSessionMessagesFrom` 是"读全部 transcript → 过滤掉目标消息及其后 → 整份文件重写"。
- **本仓库**:`Transcript.rewindTo(targetUuid)` 只在活跃链尾追加一条新的 `rewind-boundary` 条目
  (与既有的 `compact-boundary` 平级、同属 `Entry` 联合类型),`parentUuid` 接回目标消息**前一条**消息的 uuid
  (目标是链首则 `null`)。目标消息及其后全部消息**留在文件里不删**(纯 append-only,不新增"整文件重写"这种
  写路径——仓库红线:除 `save()`(fork 播种唯一覆写点)外绝不整表重写)。`reconstructChain` 从新 tip(= 这条
  rewind-boundary)沿 `parentUuid` 回溯,天然够不到被移除的那段,所以 `load()`/`loadFullHistory()`/`loadPage()`
  的活跃视图直接变短,**对外行为与 cc 的"整表重写后变短"完全等价**,只是存储上更贴近 cc 真正的"分支"模型
  (旧分支留痕、只是不再被引用——这本来就是 compact-boundary 已经在用的模式,rewind-boundary 只是同一模式的
  第二个用例)。
- 连带效果:`rewindTo` 之后继续 `append()` 新消息,公共前缀比对会在 view 尾部的 rewind-boundary 处天然分叉
  (`sameMessage` 对边界恒判 false),新分支正确接回保留段最后一条真消息——不需要额外特判。

### 2) checkpoint 数据源:per-message 快照 vs per-write 前像记录

- **cc-haha**:每条 **user 消息**都会存一份 `trackedFileBackups` 快照(`FileHistorySnapshot`,以 messageId 为键,
  记录当时"正在跟踪的全部文件"各自的 backup 文件名),`getTurnBoundaryContents` 靠"目标快照 vs 下一条快照"
  拿到某一轮的前后内容。
- **本仓库**:没有"每条 user 消息一份全量快照"这个概念,而是每次工具真正写文件前记一条 `FileHistoryRecord`
  (绑定发起这次写的 **assistant 消息** uuid 为 `messageId`,见 `ts/src/tools/fileHistory.ts`)。
  `sessionRewindService` 按"user 消息 i → user 消息 i+1"切轮次区间,把区间内全部 assistant uuid 对应的
  `FileHistoryRecord` 归到该轮,再按 path 分组取"轮内首条记录"当前像、"下一轮首条记录 ?? 当前盘上内容"当后像
  ——语义上对齐 cc 的 `getTurnBoundaryContents`(before=目标快照备份,after=下一快照备份 ?? 当前文件),
  只是推导来源不同(cc 是现成的快照对象,我们是从写前记录反推)。
- 两边对"没法可靠出 diff 数字"的处理都保守如实:cc 对整份 preview 判 `available:false` 并给固定 reason 文案
  (本仓库沿用同样两条 reason 文案:`No file checkpoints were recorded for this session.` /
  `No file checkpoint is available for the selected message.`);本仓库额外在**单个文件**粒度上,若该文件的
  记录带 `skippedReason`(超 5MB / 非普通文件,没留真实备份内容),就单独跳过这个文件、不编造它的 diff 数字,
  但不影响其他文件正常出数据。

### 3) 执行中会话的中断等待:无界 vs 有界

- **cc-haha**:`executeSessionRewind` 调 `conversationService.stopSessionAndWait(sessionId)`,无超时上限地等真正
  停止。
- **本仓库**:`turns.isRunning(id)` 为真时先 `turns.interrupt(id)`,再轮询等 `isRunning()` 变 false,
  上限 **10s**(`INTERRUPT_WAIT_TIMEOUT_MS`),超时抛错、不强行继续回退(避免在还有工具真在写文件的中途去动
  同一批文件)。⚠️已知局限:本仓库 `TurnRegistry.interrupt()` 是同步方法,调用后立刻把 controller 从注册表摘掉,
  `isRunning()` 因此几乎立即变 false——轮询在当前实现下更多是"结构上留好等待协议",不是真的在等底层异步循环
  物理退出。这是现有 `TurnRegistry` 的既有语义(`/sessions/:id/interrupt` 路由本身也是这么用的),本轮任务范围
  不包含改造 `TurnRegistry`/主循环的中断机制,如实记录、留给后续窗口按需加强。

### 4) 路由前缀:裸 `/sessions` + `/api/sessions` 双前缀

`server/index.ts` 里绝大多数会话路由是历史遗留的裸 `/sessions/...`(无 `/api` 段)。本轮新增的两个路由
(`turn-checkpoints`、`rewind`)用 `^(?:\/api)?\/sessions\/...` 同时接受两种前缀——因为验收口径写的是带 `/api`
的形状,但为了不破坏同一会话下其它路由已经建立的裸前缀调用习惯,两条都留着,不强制迁移旧调用方。

## 存储层新增:transcript.ts 的 rewind-boundary(纯追加式模型扩展)

- 新增 `RewindBoundaryEntry`(与既有 `CompactBoundaryEntry` 平级,`Entry` 联合类型追加第三个成员)、
  新方法 `Transcript.rewindTo(targetUuid)`、新读法 `Transcript.loadFullHistoryStamped()`(保留 uuid/parentUuid
  戳的完整活跃链,供 rewind 服务按 uuid 定位历史消息;`load()`/`loadFullHistory()` 剥了 provenance 定位不到)。
- **没有改动任何已有条目的形状**、**没有新增整文件重写的写路径**(`save()` 仍是唯一覆写点)。
  `lastBoundaryIndex`(`load()` 的压缩裁窗点)特意只认 `compact-boundary`,不把 `rewind-boundary` 算进去
  ——否则回退后 `load()` 会被误裁成"只剩回退边界之后"(空),而不是"掰回后的真实活跃视图"。
- **遗留(无 uuid 戳)老格式兼容修复**(对抗审查发现的真 bug,已修;不变量 = "老历史绝不从活跃链消失"):
  老格式文件是裸 `{role,content}` 行(无 uuid/parentUuid 戳,`reconstructChain` 对全裸文件走文件顺序兜底)。
  续写/压缩时新条目没法把 parentUuid 链接到裸条目上(裸条目 uuid 是 undefined),曾导致新条目 parentUuid=null
  → 重建链从新 tip 回溯够不到老历史 → **老消息从活跃链上消失**。同一不变量共堵了三个入口:
  - ①`nearestMessageUuid` 加 `typeof e.uuid === 'string'` 判断,不是真 uuid 就继续往前找;
  - ②`append()` 检测公共前缀里的裸条目,从第一条裸条目起**整段重打戳追加**成连续新链(老裸行留痕成孤儿,
    append-only 不删,内容一条不丢)——只修 ① 不够:全裸文件里根本没有任何带 uuid 的条目可接,必须重打戳
    才能让新 tip 的链覆盖老历史;
  - ③(复核发现的同类洞)`append()` 的"无新增早退"(`k >= messages.length`)曾排在重打戳扫描之前——
    resume 老裸文件后**零新增**直接 `recordCompaction(history, [摘要])` 时,第一步 `append(history)` 早退、
    重打戳不触发,boundary 的 parent 取链尾裸条目 `uuid ?? null` = null,压缩前历史从完整历史里消失。
    修法:先算前缀里第一条裸条目下标 `firstBare`,等长全匹配且 `firstBare !== -1` 也走重打戳,
    仅"传入严格更短"(`messages.length < view.length`)保留早退(不破坏"append-only 不删"守卫)。
  - 顺手:`loadFullHistoryStamped()` 滤掉无戳裸条目(原会产出 `uuid: undefined as string` 的记录,流进
    `rewindTo(undefined)` 会诡异匹配上第一条裸行);`rewindTo` 加空目标防呆(空/undefined 直接拒)。
  回归测试(`transcript.test.ts`,共 3 个):「遗留无 uuid 戳的老格式文件续写」「遗留裸文件零新增直接
  recordCompaction」「loadFullHistoryStamped 滤裸条目 + rewindTo 空目标拒」。该场景现实存在:子代理/后台
  任务转录仍走默认 subdir 'transcripts' 老路径,可能有存量老格式文件被 resume。

## 工作树基线说明(改动归属,防误读 git diff)

本任务的改动**叠加在上一个任务(append-only 存储迁移本身)的未提交改动之上**,工作树没有干净的 commit
分界。看 `git diff` 时注意区分:
- **本任务自身的改动**:`transcript.ts` 的 rewind-boundary/rewindTo/loadFullHistoryStamped/遗留兼容修复;
  `transcript.test.ts` **仅追加**(`describe('Transcript.rewindTo...')` 块 + 遗留格式回归用例);
  `sessionRewindService.ts`/`sessionRewindService.test.ts` 两个新文件;`server/index.ts` 只加了一个 import、
  一行服务实例化、一个新路由块;`server/index.test.ts` 追加一个路由用例(顶部补了三个 import);本文件。
- **基线(前一任务)的改动,不属于本任务**:`transcript.test.ts` diff 里被删的旧用例
  (`savePreservingExternalTail`/`captureBaselineLen` 等旧存储模型用例,随 append-only 迁移被替换);
  `server/index.ts` 里 `save()`→`append()` 调用改写、`transcript(id, workspaceRoot)` 签名跟改、stateRoot
  接线;`Tool.ts` 的 `stateRoot`/`messageId` 字段、`fileHistory.ts` 的 messageId 绑定、`message.ts` 的
  provenance 类型、`sessionService.ts` 的索引重建等——这些在本任务开工前就已在树里。

## 已知风险与测试覆盖(如实记录)

- **executeRewind 部分失败无回滚**:恢复是逐文件顺序执行的,若恢复成功一半后 `transcript.rewindTo` 抛错
  (或中途某个文件恢复抛错),已恢复的文件**不会自动回滚**,会话与文件状态可能不一致。cc-haha 原实现同样
  没有处理这种部分失败(逐文件 `restoreBackupFile` 后才 trim,无事务/无补偿),属**继承风险**,如实记录。
  缓解因素:`restoreFileFromHistory` 每次恢复前自带"先给当前内容拍一张快照",事后手工可救。
- **中断等待名义 10s、实际近乎立即返回**:见上文分叉 ③ 的已知局限(`TurnRegistry.interrupt()` 同步摘除
  controller,`isRunning()` 立即变 false;轮询是留好的协议结构,不是真等异步循环物理退出)。
- **测试覆盖**:「同一轮内同一文件多次修改(恢复源取该轮最早前像)」与「skippedReason 无备份记录在预览/
  恢复循环中被如实跳过、不抛错、不影响其他文件」两类场景,已在 `sessionRewindService.test.ts` 补上专项
  用例(审查指出时曾是缺口,现已覆盖)。
- **工作区外文件的恢复会抛错(未覆盖)**:若先前某次工具写文件写到了会话工作区之外(经 allowedTools 路径
  规则授权),`executeRewind` 里为恢复构造的最小 `ToolContext` 没带这些授权,`workspace.resolve(path,'write')`
  会对该路径抛越界错——cc-haha 有 `registerChangedFileAccessRoot` 机制,本仓库 rewind 层暂无等价物。
  无测试,留待真实需要时补。

## 验证记录

- `bun test`:1529 pass / 0 fail(全量;含 transcript rewindTo 7 用例 + 遗留格式回归 3 用例、
  sessionRewindService 服务层 10 用例、server/index.ts 路由 1 用例)。存量 flaky(UDS inbox)在部分
  高负载轮次偶挂,已用 git worktree 在纯 HEAD 基线复现证明与本任务无关,且单独重跑通过。
- `bun run typecheck`:通过(`tsc --noEmit` + desktop renderer 的 tsconfig 均无报错)。
