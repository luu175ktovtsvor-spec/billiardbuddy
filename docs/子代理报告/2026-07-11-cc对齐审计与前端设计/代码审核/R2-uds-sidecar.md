# R2 · UDS + teammate / sidecar 崩溃兜底 + logger — 验证式代码审核

审核对象:工作树当前状态(未 commit),对照 `~/Desktop/cc-haha-ref`。方法:逐条读 diff/源码 + 亲跑测试 + 对刁钻边界写独立集成测试复现(不改源文件、不 commit)。

---

## CONFIRMED(实锤)

### C1. teammate 入队"幂等去重"对生产路径不成立 —— 会产生同名重复队员(真复现)
- **位置**:`src/agents/agentTool.ts:289-315`(`registerTeamMember`,dedup key = `member.agentId`)+ `src/tasks/taskTools.ts:549-552`(`stableAgentId = stringTaskParam(task,'agent_id') || ... || task.id`,`backgroundTaskParams` 本身从不设 `agent_id`,见 `taskTools.ts:108-121`)。
- **问题**:注释声称"idempotent by agentId so a foreground->background handoff of the same agent doesn't duplicate the roster entry",但生产路径下 `agent_id` 恒等于 `task.id`——**每次 `agent_task` 调用都会新建一个 task,`task.id` 每次都是新随机 ID**(`taskTools.ts:511` `opts.tasks.create(payload)`)。这点已被同仓库既有测试自证:`taskTools.test.ts:95` `expect(done.params).toMatchObject({..., agent_id: done.id})`。
- **真复现**(用真实 `startBackgroundAgentRun` 而非手搓 mock,脚本见 `scratchpad/review/team_dup_repro.test.ts`):同一 `agent_task({name:"researcher", team_name:"squad"})` 连续调用两次,`team.members` 里出现**两条** `name:"researcher"` 的不同 `agentId` 记录(无任何改名/合并),`total members: 3`(lead + 两条重复 researcher)。
  ```
  researcher entries: [ {agentId:"3922...", name:"researcher", ...}, {agentId:"d1f1...", name:"researcher", ...} ]
  ```
- **假绿测试实锤**:`src/agents/agentTool.test.ts` 里 3 条新增 team 测试(约 1145-1245 行)全部依赖手搓 `startBackgroundAgent` mock,**硬编码固定 `agent_id`**(如 `'researcher@squad'`)跨两次调用不变——这不是生产 `startBackgroundAgentRun` 的真实行为(生产每次都是新 `task.id`)。测试断言"重复 spawn 不重复入队"只在这个不真实的 mock 前提下成立,是假绿。
- **对照 cc**:cc `spawnMultiAgent.ts:handleSpawnInProcess` 用 `generateUniqueTeammateName` 做真正的改名去重(重名自动变 `name-2`),ts port 完全没有这层碰撞处理——`registerTeamMember` 试图用另一种(且实际不生效的)机制模拟同一保证,两头都没做对。
- **影响**:模型每次以同名重新调用 `agent_task` 给同一"队友"派活,team 名册会不断堆积同名重复条目,`ListPeers` 出现幽灵重复队友,`SendMessage({to:name})` 寻址存在多条同名候选的歧义风险。

### C2. team 上下文按整个 server 进程全局共享,而非按会话/对话隔离 —— 真跨会话渗漏(真复现)
- **位置**:`src/server/index.ts:1016` `const teams = new TeamService(stateRoot)`(整个 `startServer()` 生命周期内单例,所有 conversationId 共用同一引用,见 `:1768` 传入 `backgroundAgentOptions`)+ `src/tasks/teamService.ts:259-260`(`activeTeamPath = join(stateRoot,'teams','active-team.json')`,单一全局文件,`createTeam` 若已有 active team 直接抛错——**同一 stateRoot 任意时刻只能有一个"active team"**)。
- **触发点**:`src/agents/agentTool.ts` 新增逻辑 —— `if (!teamName && !wantsForkContext && opts.teams) { teamName = (await opts.teams.getActiveTeam())?.teamName }`(约 400-410 行),对 `getActiveTeam()` 的调用**不带 `ctx.conversationId`**,无任何按会话隔离的机制。
- **真复现**(脚本见 `scratchpad/review/team_cross_session_repro.test.ts`,用与 `server/index.ts` 完全一致的单例 wiring):
  1. 对话 A 调 `TeamCreate({team_name:"session-a-team"})` + `agent_task({name:"a-helper", team_name:"session-a-team"})`。
  2. 对话 B(完全不相关、从未提及 team、只是普通的 `agent_task({name:"b-helper", task:"..."})` 调用,不带 `team_name`)。
  3. 结果:`session-a-team` 的成员列表变成 `["team-lead", "a-helper", "b-helper"]`——对话 B 的调用被**强制** `wantsBackground=true` 并静默并入对话 A 的团队,对话 B 的调用方拿到的不再是期望的同步结果,而是 `<background_task_started ...>`。
- **审计里"无 team 上下文的 name-only 调用行为不变(guard 测试)"的验证结论**:`agentTool.test.ts` 里那条 guard 测试("...runs synchronously as before...")只测了"整个 stateRoot 从未有过任何 team"这一种情况,**没有覆盖"另一个会话曾经建过 team 且未清理"这一更现实的场景**——这正是本项目多会话/后台任务/定时任务架构下会真实发生的情形(CLAUDE.md 记录了后台任务、定时任务、多会话并存等能力)。
- **根因**:cc 里 `appState.teamContext` 是**每个进程一份**的内存态(cc 每次 CLI 调用是独立进程,天然按会话隔离);ts 把它照搬成了**落盘在 stateRoot 下的全局单文件**,配合 server 端 `teams` 单例贯穿所有并发会话——把 cc"进程级隔离"错误对应成了"整个后端服务级共享",丢失了会话边界。
- **影响**:①普通、无意的具名后台代理调用可能被悄悄强制异步化,改变调用方预期的同步返回语义;②消息/名册跨会话泄漏(A 的 `ListPeers`/广播能看到、能触达 B 会话生成的代理);③一旦某会话建过 team 又忘记 `TeamDelete`(或因为有 active member 而无法删除,见 `teamService.ts:369-376`),该状态会一直污染后续所有会话,直到显式清理。

---

## PLAUSIBLE(存疑,非确证)

### P1. `getLogger()` 模块顶层实例化在部分文件里捕获了"过早"的 stateRoot(潜伏,当前不触发)
- **位置**:`src/sandbox/windowsLauncher.ts:12`、`src/tools/computerUse/hostAdapter.ts:14`、`src/tools/computerUse/pythonBridge.ts:41` 三处都是**模块顶层** `const log = getLogger('...')`(无显式 `logDir`),而 `desktop/sidecars/backend-sidecar.ts` 的执行顺序是:静态 import `server/index.ts`(经 `sandbox.ts`→`windowsLauncher.ts`、经 `generalTools.ts`→`computerUse`→`hostAdapter.ts`/`pythonBridge.ts` 触发这三个模块求值,含顶层 `getLogger()` 调用)→ **之后**才在函数体里跑 `applyEnvFiles()`(会 `Object.assign(process.env, ...)`,见 `src/model/envLoader.ts:35-38`)。
- **已用最小复现脚本证实**(非本仓库文件,纯 ESM 求值顺序验证):模块顶层捕获的值确实是 `applyEnvFiles()` 修改前的旧值,之后同一 key 的"惰性读取"才是新值——两者出现分裂。
- **当前实际影响**:`desktop/bundled.env` 里目前没有设置过 `BILLIARDBUDDY_STATE_DIR`(仓库里搜不到这个组合),所以**眼下不触发**;只在未来给白标部署走"用 `.env` 文件覆盖 `BILLIARDBUDDY_STATE_DIR`"这条路径(代码注释里明确写了这是设计初衷)时才会实际发作——届时 sandbox/computer-use 这三处日志会悄悄写进默认 `~/.billiardbuddy/state/logs`,而不是被覆盖后的真实 stateRoot,和 `server/index.ts`(migrations 日志)、`processCrashGuard.ts`(崩溃日志,两者都是在函数体内、`applyEnvFiles()` 之后才调用 `getLogger`)分裂到两个目录。
- 定为 PLAUSIBLE 而非 CONFIRMED:因为在**当前**代码/配置组合下不会实际观察到日志错位(需要额外的部署配置改动才会触发),但根因(顶层 vs 函数体内实例化时机不一致)是真实存在且可复现的。

### P2. logger 轮转逻辑非跨进程安全(低优先级,当前单进程产品形态下无实际影响)
- `rotateDebugLogIfNeeded`(`logger.ts:76-93`)在超过阈值时做 rename,若同一时刻有两个进程写同一 `debug.log`(本产品目前是单 backend-sidecar 进程,不构成真实风险),`rename` 竞态最坏结果是丢一次轮转或短暂 ENOENT(被 try/catch 吞掉),不会导致内容级损坏(单次 `appendFileSync` 调用在 POSIX 下对小行是原子写)。仅记录留痕,不建议现在处理。

---

## 已验证正确(逐条走查通过)

1. **udsInbox accepted-socket 补 `error`/`timeout` 监听**(`src/tasks/udsInbox.ts:17-66`):
   - 30s idle timeout **不会误杀合法慢客户端**——发送端 `udsClient.ts:9` 自身超时仅 5s,任何真实客户端最多在 5s 内就会主动断开/报错,不可能拖到 30s 边界;30s 是给"连接了但半天不发/不关"的僵死连接兜底,阈值选得足够宽松。
   - `destroy()` 后半包数据处理正确:`message` 缓冲区只在闭包生命周期内存活,`destroy()` 不触发 `'end'`,半包数据被静默丢弃(不会拼进 inbox),符合"半截消息不该被当成完整消息处理"的预期,无副作用泄漏。
   - 真实 Node/Bun 语义核实:`EventEmitter` 对零监听器的 `'error'` 事件确实同步 throw(已用 `bun -e` 验证),证实了修复动机成立;但用简单 `client.destroy()`/`resetAndDestroy()` 尝试在 macOS+Bun 上人工复现真实 OS 级 ECONNRESET 未成功(过于依赖操作系统时序,天然 flaky)——这恰好解释了为什么修复方用**合成 EventEmitter 直接 emit('error')** 的单测(`udsInbox.test.ts:66-101`)而非依赖真实 OS 触发,是合理且更确定的测试策略,不算敷衍。
   - `bun test src/tasks/` **114 pass / 0 fail**,含新增 hard-disconnect 与 fake-error 两条用例全绿。
2. **backend-sidecar 顶层崩溃兜底**(`src/utils/processCrashGuard.ts`):
   - `uncaughtException` → 写崩溃日志(同步 `appendFileSync`)后 `exit(1)`;`unhandledRejection` → 只记录不退出。策略分野理由(见文件头注释)合理。
   - 崩溃日志写失败(目录被占用等)**不会二次抛出/死循环**:`writeLine`/`writeCrashLog` 全程 try/catch 静默吞(`logger.ts:95-104,170-178`),有专门测试覆盖(`logger.test.ts:134-140`:logDir 撞上一个已存在的普通文件,断言 `not.toThrow()`)。
   - `exit(1)` 前日志确已 flush:全链路用的是**同步** fs API(`appendFileSync`/`mkdirSync`/`renameSync`),JS 单线程语义下这些调用在 `exit()` 被调用前已经完整跑完并阻塞返回,不存在"进程退出快于日志落盘"的竞态。
   - 子进程级真实验证是真的:`processCrashGuard.subprocess.test.ts` 真起 `Bun.spawn` 子进程、真 `throw`/真 unhandled rejection,断言退出码(1 / 0)与落盘文件内容,不是假 mock。`bun test` 全绿(2/2)。
3. **logger 5MB 轮转 + `QF_DEBUG_LOG` 开关 + 崩溃文件保留 20 份**:源码 + 专项测试(`logger.test.ts` 全 9 条)逐条核对一致,轮转/裁剪/verbose 开关/循环引用 meta 兜底全部有测试且真通过。
4. **4 处 console 调用替换未改变对外行为**:`windowsLauncher.ts`(`console.error`→`log.warn`,行为仍受 `DESKTOP_DEBUG` 门控)、`server/index.ts` migrations 警告、`hostAdapter.ts`/`pythonBridge.ts` 的 computer-use 日志——均为纯"落盘方式"替换,原判断条件/触发时机未变(只是 P1 提到的顶层实例化时机需要留意)。
5. **白标检查**:`grep -rniE "claude|anthropic|gpt-|openai"` 命中的仅两处都是**代码注释**(`logger.ts:4` 引用 cc 自己的 `~/.claude/debug/latest` 路径作设计参照、`backend-sidecar.ts:1` 提 "cc-haha claude-sidecar.ts"),均非运行时字符串/日志内容/用户可见文案,不构成白标违规。
6. **`bun run typecheck` 全过**;`bun test src/tasks/ src/utils/logger.test.ts src/utils/processCrashGuard*.test.ts src/agents/agentTool.test.ts` 共 158 pass / 0 fail(不含本审核额外写的 2 份复现脚本,那两份特意留在 scratchpad 外部、不提交进仓库)。

---

## 裁决建议

- **udsInbox / 崩溃兜底 / logger 三块(B 组 + A 组第 1 点)**:实现扎实,验证到位,可以合入。P1(顶层 getLogger 时机)属于潜伏问题,建议顺手把这 3 个模块的 `getLogger()` 挪进函数体内按需实例化(或接受当前风险、留 TODO),不阻塞本轮合并。
- **teammate 入队(A 组第 2 点)是本轮唯一应该拦下重新处理的部分**:C1(去重逻辑对生产不生效 + 测试假绿)和 C2(team 上下文全局单例、跨会话渗漏)都是可稳定复现的真实缺陷,且改动点相同(`agentTool.ts` 的 team 接线 + `teamService.ts` 的 active-team 存储模型)。建议:
  1. C1:去重键换成按 `formatAgentId(name, teamName)` 计算的稳定值,而不是依赖 `task.params.agent_id`(生产恒为新 `task.id`);或补齐 cc 的 `generateUniqueTeammateName` 改名策略。
  2. C2:`getActiveTeam()`/team 归属要按 `conversationId` 或显式 `team_name` 收紧,不能让"整个进程只有一个全局 active team"这件事悄悄影响所有未显式参与 team 的普通 `agent_task` 调用;至少应该要求"仅在同一 conversationId 曾经 TeamCreate 过"才允许隐式继承,而不是任何会话都能读到任意会话建的 team。
- 在这两处修好、补上真实覆盖跨会话隔离与生产级 ID 稳定性的测试之前,不建议宣称"teammate 入队断链已修复"。
