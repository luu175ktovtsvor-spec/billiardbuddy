# cc 两条线:模型驱动的 agent 循环 vs 确定性代码 — 判据

> 📌 状态:✅现行 · 最后核对 2026-07-10
>
> 权威规格 = cc-haha 源码 `/Users/swl/Desktop/cc-haha-ref/src`。本文每条结论都附 cc 具体 `文件:行`。
> 我们的移植 = `ts/src`。只读研读产出,未改任何生产代码。

---

## 总纲:owner 的核心思想(为什么这么分 · 2026-07-10)

这份判据不是凭空来的,是 owner 在 2026-07-10 连续纠正主代理数轮后逼出来的**认知地基**。先记住这几条 owner 原话级的思想,再看下面的 cc 源码判据:

1. **为什么一定对标 cc-haha**:因为 cc 的架构**主要依靠模型的能力,而不是依靠我们约束好的一大堆流程**。人家那个循环就是最成熟、最正确的。所以内核直接照 cc 搬,别自己发明循环/机制/每个 case 的特殊逻辑。

2. **壳子适配"任何"大模型,不只 MiMo**:我们做的是一个"coding agent 的壳"——一个正确的循环 + 一套全工具,让**模型自己在里面 think→挑工具→解决问题**。壳只管把循环和工具备齐,换任何模型都能跑(今天接 MiMo,以后接别的,永不接 Claude)。唯一需要为具体模型适配的,是"cc 假设 Claude 有某能力、而换的模型没有"时补个降级(如识图/PDF),不是重写流程。

3. **千万别加 SOP 式的自研流程**:coding agent 的活,是让模型在循环里自己决策怎么干——**绝不能写死"用户说 X 就按 1-2-3-4 步执行"那种设置好的死程序**。加了这种 SOP = 违背了"靠模型能力"的初衷,也污染了循环的纯粹。发现自己写了 SOP,删掉。

4. **但要分清两条线**(今天的关键认知,主代理被纠的根因)——不是"什么都塞进循环":
   - **A 线 = 问答/对话/让 AI 帮你干活** → 走模型驱动的 cc 循环,禁写死 SOP。
   - **B 线 = 具体产品功能**(生图工作台、剪视频、定时任务、门店信息表单等按钮功能)→ 就是**我们设置好的确定性代码**,本来就该写死、按固定逻辑跑,**不用也不该塞进模型循环、不需要"衔接层"**。
   - 主代理反复犯的错就是把 B 硬塞进 A(把定时任务设计成"丢进 agent 会话让模型自己想怎么排期"、发明"cc 底座↔产品衔接层")。全反了。

5. **拿不准就派子代理去读 cc 源码**:与其凭理解揣测"这块该循环还是该写死",不如让子代理去 cc 代码里翻实底,用 cc 的真实做法校准。下面第 1~5 节就是这么来的(2026-07-10 一个专门读 cc 源码的子代理产出,每条附 cc `文件:行`)。

> **一句话记住**:壳适配模型(A 线循环照抄 cc)+ 产品功能正常写代码(B 线确定性)+ 两条线各走各的、只用三种廉价接法相接、绝无衔接层。

---

## 0. 一句话结论(先给结论)

cc 里有且只有两条线,泾渭分明,从不互相污染:

- **A 线 = 模型驱动的 agent 循环**(`query.ts` 的 `queryLoop`)。模型自己 think→挑工具→看结果→再想。循环体**只按"模型这轮有没有发工具调用"这一个机制信号分支**,从头到尾**没有一处按业务语义 if-else**(不存在"如果是查营业额就走 A、如果是排班就走 B"这种东西)。
- **B 线 = 确定性代码**(权限瀑布、压缩阈值、工具内部实现、hooks 分发、命令解析、cron 调度器、所有 `setInterval`)。写死的 if-else / 阈值 / 定时器,**永不进模型循环**,它们是"机制/护栏/基础设施",不是"该由模型决策的地方"。

两条线怎么接上?**不靠任何"衔接层"**。产品功能接入 agent 只有三种既有、廉价的方式(详见第 3、5 节):① 给模型一个**工具**;② 往标准 agent 会话**塞一条预定义 prompt**(cron 就是这么干的);③ 直接调后端服务 / 单次调一次模型,**根本不进主循环**。

---

## 1. cc 的模型驱动循环长什么样、边界在哪

**主循环文件**:`src/query.ts`,函数 `queryLoop`(`query.ts:244`),核心是一个 `while (true)`(`query.ts:310`)。

**模型在循环里怎么自主决策**:每轮循环干的事(纯机制,按顺序):
1. 预处理上下文(snip / microcompact / autocompact,`query.ts:404/417/457`)——这些都是 B 线机制,见第 2 节。
2. 调模型流式出结果:`deps.callModel({...})`(`query.ts:666`)。模型自己决定这轮说话还是发工具调用。
3. 边流边收 `tool_use` 块:只要模型发了工具调用,就 `needsFollowUp = true`(`query.ts:841`)。
4. **唯一的"继续还是收工"判定**:`if (!needsFollowUp)`(`query.ts:1070`)——模型这轮没发任何工具调用 ⇒ 收工;发了 ⇒ 执行工具、把结果拼回消息、`continue` 进下一轮(`query.ts:1390` 执行工具,`query.ts:1723-1735` 拼下一轮 state 并循环)。

**循环的"纯粹性"举证**:循环体里所有的分支/退出,全是机制信号,没有一个是业务语义。把 `query.ts` 里所有 `return { reason: ... }` 列出来即可自证:

| 行 | 退出原因 | 属于 |
|----|----------|------|
| `query.ts:653` | `blocking_limit`(上下文超硬上限) | 机制 |
| `query.ts:985` | `image_error` | 机制 |
| `query.ts:1004` | `model_error` | 机制 |
| `query.ts:1059` | `aborted_streaming`(用户中断) | 机制 |
| `query.ts:1183/1190` | `prompt_too_long` | 机制 |
| `query.ts:1272/1365` | `completed`(模型没再发工具=干完了) | 机制 |
| `query.ts:1287` | `stop_hook_prevented` | 机制 |
| `query.ts:1523` | `aborted_tools` | 机制 |
| `query.ts:1528` | `hook_stopped` | 机制 |
| `query.ts:1719` | `max_turns` | 机制 |

而"继续下一轮"的 transition 原因(`query.ts` 各 `continue` 站点)也全是机制:`next_turn`、`collapse_drain_retry`、`reactive_compact_retry`、`max_output_tokens_escalate`/`_recovery`、`stop_hook_blocking`、`token_budget_continuation`。

> **关键事实**:整个主循环里 **搜不到任何一个"按业务状态决定下一步"的 if-else**。循环只认一件事——`step.kind`(模型这一步是"要调工具"还是"结束了")。业务语义(要不要查数据、要不要排班、先做哪步)**全部交给模型在 prompt+工具里自己决定**,代码不写死 SOP。这就是 owner 说的 A 线"绝不写死固定业务流程"。

---

## 2. cc 里哪些是"确定性代码、不进循环"(逐类举例)

这些都是 B 线。它们**不是 agent 循环**(没有 think→act→observe),也**不是"该由模型决策的地方"**——它们是机制/护栏/基础设施,行为可预测、可测试、必须每次一样。

### 2a. 权限瀑布(护栏)
`src/utils/permissions/permissions.ts`,`hasPermissionsToUseToolInner`(`permissions.ts:1174`)。一条写死的 if-else 阶梯,顺序固定:
- 1a 整工具 deny 规则 → `deny`(`:1190`)
- 1b 整工具 ask 规则 → `ask`(`:1203`)
- 1c 调工具自己的 `checkPermissions`(`:1235`)
- 1d 工具判 deny → `deny`(`:1245`)
- 1e `requiresUserInteraction` 且 ask → `ask`(`:1250`)
- 1f 内容级 ask 规则 → `ask`(`:1263`)
- 1g 安全检查(`.git/`、`.claude/` 等敏感路径)→ `ask`(`:1276`)
- 2a bypass 模式 → `allow`(`:1290`)
- 2b 整工具 always-allow 规则 → `allow`(`:1301`)
- 3 passthrough → `ask`(`:1317`)

模型的工具调用是这个函数的**输入**;函数是闸门。**闸门本身没有模型**(唯一例外:auto 模式会调一次"分类器"模型做单点判定 `permissions.ts:698` 附近——但那是一次有界的一次性分类,不是 agent 循环,且可关)。

### 2b. 压缩触发阈值(机制)
`src/services/compact/autoCompact.ts`:`getAutoCompactThreshold(model)`(`autoCompact.ts:72`)、`calculateTokenWarningState`(`autoCompact.ts:93`)。就是"token 数 ≥ 阈值就触发压缩"的确定性数值判断,在循环入口被调用(`query.ts:457` autocompact、`query.ts:417` microcompact)。触发与否是算出来的,不是模型决定的。

### 2c. 工具内部实现(机制)
每个工具是一个 `ToolDef`,有 `inputSchema` / `checkPermissions` / `call`。模型只负责"挑哪个工具 + 填参数";工具的 `call()` 是写死的确定性代码。样例:`CronCreateTool.call()`(`tools/ScheduleCronTool/CronCreateTool.ts:117`)——就是把任务存盘 + 置一个 flag,零模型推理。

### 2d. hooks 事件分发(机制)
`src/utils/hooks.ts`:`getMatchingHooks`(`hooks.ts:1621`)、`executeHooks`(`hooks.ts:1970`)按事件类型 `switch`:`case 'PreToolUse'` / `'PostToolUse'` / `'SessionStart'` / `'Stop'`(`hooks.ts:596/630/646/1635`)。纯事件路由 + 跑用户配的脚本,不进模型循环。

### 2e. 命令解析、后台任务、调度器(基础设施)
- 所有 `setInterval` 定时器(见下表)——全是基建心跳/轮询/保活,不跑 agent。
- cron 调度器 tick(`server/services/cronScheduler.ts:416`)——见第 3 节。

**cc 里全部 `setInterval` 一览(证明:除 cron 外无一"跑 agent 循环")**:

| 文件:行 | 干嘛 | 跑 agent 吗 |
|---------|------|:-----------:|
| `server/services/cronScheduler.ts:390` | cron 调度 tick,每 60s | ❌ 只是"到点 spawn 一个 CLI 子进程",自己不跑循环 |
| `utils/cronScheduler.ts:456/490` | REPL 内 cron 检查/enable 轮询 | ❌ 只是"到点往命令队列塞 prompt",自己不跑循环 |
| `server/services/teamWatcher.ts:36` | 轮询团队文件变化 | ❌ |
| `utils/sessionActivity.ts:32` | 会话心跳 | ❌ |
| `utils/gracefulShutdown.ts:282` | 孤儿进程检查 | ❌ |
| `utils/backgroundHousekeeping.ts:86` | 后台清理 | ❌ |
| `utils/settings/changeDetector.ts:390` | MDM 设置轮询 | ❌ |
| `services/analytics/growthbook.ts:1099` | feature flag 刷新 | ❌ |
| `services/remoteManagedSettings/index.ts:621` / `services/policyLimits/index.ts:648` | 远端设置/额度轮询 | ❌ |
| `upstreamproxy/relay.ts:395`、`cli/remoteIO.ts:187`、`cli/transports/WebSocketTransport.ts:706/775`、`remote/SessionsWebSocket.ts:304` | WebSocket keepalive ping | ❌ |
| `bridge/bridgeMain.ts:428/2721`、`bridge/bridgeUI.ts:173`、`bridge/replBridge.ts:1511/1538` | 桥接状态/指针刷新 | ❌ |
| `services/mcp/client.ts:1444/3048` | MCP 重连/进度 | ❌ |
| `services/preventSleep.ts:81`、`services/voiceStreamSTT.ts:333` | 防休眠 / 语音保活 | ❌ |
| `utils/telemetry/*`、`utils/task/TaskOutput.ts:88`、`cli/print.ts:554`(gc) | 遥测写盘 / 任务输出轮询 / GC | ❌ |

> 之前的审计说"cc 里只有 `bridgeWorkerRefreshScheduler` 这种基建定时器"——**更正**:`bridgeWorkerRefreshScheduler` 其实在**我们的移植** `ts/src/tasks/bridgeWorkerRefreshScheduler.ts`,不在 cc-haha。但那句话的**精神是对的**:上面这张表证明,cc 的所有定时器都是基建心跳/轮询/保活,**没有一个"定时把活丢进模型循环"**;唯二跟 agent 沾边的是两套 cron,而它们的做法恰恰是"调度器自己不跑循环,到点只是 spawn 子进程 / 塞 prompt"(第 3 节)。

---

## 3. cc 有没有"产品功能"(定时任务/工作台/表单)?怎么实现的

**背景先说清**:cc-haha 是在 Claude Code 内核(CLI coding agent)之上做的**桌面 App 分支**。所以要分两层:
- **纯内核(vanilla cc)**:一个 CLI coding agent,基本没有面向终端用户的"产品按钮功能"。
- **cc-haha 分支**:在内核之上**加了**产品功能(桌面 App 的定时任务等)。

### ① cc 确实有 cron / 定时跑东西 —— 但做法完美印证 owner 的架构

cc-haha 里有**两套** cron,**两套都遵守 B 线纪律**:

**(a) 桌面 App 的定时任务(server 侧)** —— `server/services/cronScheduler.ts`
- 调度器 = 确定性服务:`setInterval(() => this.tick(), 60_000)`(`cronScheduler.ts:390`),`tick()` 里 `cronMatches(task.cron, now)` 匹配(`cronScheduler.ts:439`),加去重/时区/超时护栏。**全程没有模型。**
- 到点怎么执行任务?**`Bun.spawn` 拉起一个全新的 `claude --print` CLI 子进程**(`cronScheduler.ts:546`),把 `task.prompt`(用户建任务时写死的那条 prompt)从 stdin 喂进去(`cronScheduler.ts:523-531`)。**那个子进程内部才跑标准 query() 循环**,模型在里面自主用工具把活干完。
- 服务启动时 `cronScheduler.start()`(`server/index.ts:453`)。

**(b) REPL 内的定时任务 / `/loop`(KAIROS / `AGENT_TRIGGERS`)** —— `tools/ScheduleCronTool/` + `utils/cronScheduler.ts` + `hooks/useScheduledTasks.ts`
- 模型可以从会话里调 `CronCreate` **工具**(`CronCreateTool.ts`)来建定时任务——这是 A 线给模型一个**普通工具**;工具的 `call()` 只做确定性存盘(`CronCreateTool.ts:117`)。
- 一个确定性调度器(`createCronScheduler`)在 cron 命中且 **REPL 空闲**时触发(`useScheduledTasks.ts:84`)。触发动作 = **把预定义的 `task.prompt` 用 `enqueuePendingNotification({mode:'prompt', priority:'later'})` 塞进和用户输入同一个命令队列**(`useScheduledTasks.ts:71-82`、`onFireTask` `:91-115`)。
- 塞进去之后,这条 prompt 就**走和"人手打字"完全一样的入口**流进 query() 循环。

### ② 两套 cron 的共同铁律(这就是给 owner 的金句)

```
调度(什么时候跑) = B 线,确定性:cron 匹配 + 去重 + jitter + 空闲门控,无模型
预定义动作(跑什么)  = 建任务时写死的一条 prompt 字符串
执行(怎么跑)       = A 线,标准 agent 会话:spawn 一个 claude 子进程 / 往命令队列塞 prompt
两者的"接口"       = 就一句 Bun.spawn(claude,...) 或 enqueue(prompt),复用既有入口,零定制"衔接层"
```

调度器**从不进循环**;循环**从不含调度逻辑**;模型对"排期"的唯一参与是调一个普通工具 `CronCreate`。

### ③ 结论:我们的产品功能 cc 里有没有对应物?

- **定时任务**:cc 有对应物(上面两套 cron),而且证明了正确做法 = 确定性调度器 + spawn/enqueue 一个标准会话。**不是**"把调度逻辑缝进循环"。
- **生图工作台 / 剪视频这类产品按钮功能**:cc 里**没有对应物**——cc 是 coding agent,没有这些垂直产品面板。所以这些**纯粹是我们自己的 B 线代码**(后端服务 + 前端按钮),**跟 cc 循环无关、不需要任何"衔接"**。要让模型也能用它们,就照 cc 的三种既有方式之一接:给模型一个工具 / 塞一条 prompt / 后端直接调。
- **证实 owner 的判断**:是的——我们的产品功能在 cc 里大多没有对应物,是我们自己的 B 线;需要模型触碰时,用既有原语接,**不发明"cc 底座↔产品功能衔接层"**。

---

## 4. 可操作判据:一块功能该走 A 线还是 B 线?

基于 cc 的实际做法,给主代理 5 条一眼判据:

**判据 1 —— "解法是否需要临场随机应变?"**
- 需要模型看情况决定步骤/工具/顺序(开放式任务)⇒ **A 线**:给它工具,丢进循环,别写 SOP。
- 步骤/规则每次都一样、能写成 if-else/阈值 ⇒ **B 线**:写确定性代码。
- cc 例:「帮我总结昨天营业额」= A 线(模型自己查、算、写);「token≥阈值就压缩」= B 线(`autoCompact.ts:72`)。

**判据 2 —— "它是护栏/机制/基础设施吗?"**
- 权限判定、压缩、hooks 分发、命令解析、心跳、调度、重试、去重 = **一律 B 线**。这些必须可预测、可测试、每次一样,绝不能交给模型"看着办"。cc 把它们全放在循环外(第 2 节)。

**判据 3 —— "谁来决定'做什么' vs 谁来决定'怎么做'?"**
- "什么时候做 / 做不做 / 允不允许" = **B 线**(调度器、权限瀑布)。
- "拿到一个任务后具体怎么做" = **A 线**(模型在循环里)。
- cron 是教科书:调度器(B)决定何时,模型(A)决定怎么干。

**判据 4 —— "要不要模型,能不能一次调用搞定?"**
- 完全不需要模型 ⇒ B 线后端服务。
- 需要模型但只是"生成一段内容/做一次判断",不需要多轮用工具 ⇒ **单次调一次模型 API 即可,不进 agent 主循环**(cc 例:工具调用摘要 `generateToolUseSummary`、autocompact 的总结、job 分类器 `jobs/classifier.ts`——都是一次性调用,不是循环)。
- 需要模型多轮 think→act→observe ⇒ A 线,进循环。

**判据 5 —— "产品功能怎么跟 agent 接?只能用这三种既有方式"**
1. 给模型一个**工具**(`ToolDef`,`call()` 是 B 线);
2. 往标准会话**塞一条 prompt**(spawn CLI / enqueue),复用既有入口;
3. **后端直接调**(纯 B 线,不碰模型)。
- 任何"第四种:发明一个把产品逻辑织进 `query.ts` 内部的层" = **反模式,cc 里不存在。**

**正例**:
- 「定时每天 9 点生成昨日经营日报」→ B 线调度器到点,把预定义 prompt「生成昨日经营日报」塞进一个标准会话,模型自己查数据+写报告(A 线)。✅ 完全对齐 cc cron。
- 「用户点'生成海报'按钮」→ 后端服务直接调生图(B 线);若想让模型也能触发,就给它一个 `GenerateImage` 工具。✅

**反例(主代理踩过的)**:
- ❌ 把定时任务设计成"到点丢进一个 agent 会话让模型**自己想该定时干嘛、怎么调度**"——调度是 B 线,模型不该管排期。
- ❌ 发明"cc 底座↔产品功能衔接层"把生图/剪视频**缝进主循环**——循环内部不认识任何产品,`query.ts` 通篇零产品分支。

---

## 5. 直接纠正主代理的两个偏差

### 偏差 (a):"定时任务接进 agent 会话让模型驱动"

**判决:一半对、一半错,必须拆开说,别整体照搬也别整体推翻。**

- ✅ **对的一半**:cc 确实是"到点把一条**预定义 prompt** 喂进一个**标准 agent 会话**,让模型自主用工具把这条 prompt 干完"(`cronScheduler.ts:546` spawn 子进程 / `useScheduledTasks.ts:71` 塞进命令队列)。所以"定时触发 → 起一个真 agent 会话执行"这个方向本身没错,和 cc 一致,也和我们移植里 `ts/src/server/services/scheduledTaskRunner.ts` 已有的做法一致(它注释里就写明了对标 `cronScheduler`、"绝不是执行写死的 SOP 脚本")。
- ❌ **错的一半 / 必须守住的边界**——只要主代理是下面任一意思,就是把 B 线塞进 A 线,错:
  1. 让**调度器本身**变成模型驱动 / "让模型自己想什么时候跑、怎么排期" —— 错。调度器是**哑的确定性 cron**(`setInterval` + `cronMatches`,`cronScheduler.ts:390/439`),排期、去重、jitter、空闲门控全写死,零模型。
  2. 把定时任务的活**织进当前/主循环**,而不是**另起一个隔离的标准会话** —— 错。cc 一律新开(spawn 子进程或往队列塞 prompt),`query.ts` 内部对"这是不是定时任务"一无所知。
  3. 为它**发明专门管道** —— 错。复用既有入口就行:`Bun.spawn(claude,...)` 或 `enqueuePendingNotification({mode:'prompt'})`。
- **正确基准一句话**:*定时任务 = 确定性调度器(B 线)到点,把一条预定义 prompt 交给一个标准 agent 会话(A 线)去执行;调度归调度、循环归循环,接口就是"塞条 prompt / 起个子进程",没有第三样东西。*

### 偏差 (b):"cc 底座↔产品功能衔接层(#66)"

**判决:这个"衔接层"在 cc 里根本不存在,是凭空发明的中间层,删掉这个概念。**

- cc 源码里**搜不到**任何把产品功能"缝进循环"的桥接层。`query.ts`(1738 行)通篇**零产品分支**——它只认 `callModel`(`:666`)、`runTools`(`:1390`)、`needsFollowUp`(`:1070`)这些机制原语,压根不知道"生图/剪视频/日报"是什么。
- 产品功能与 agent 的接触面在 cc 里**只有三种既有、廉价的接法**(第 4 节判据 5),全是复用既有原语:
  1. 给模型一个**工具**(如 `CronCreate`,`CronCreateTool.ts`),工具 `call()` 是 B 线;
  2. 往标准会话**塞一条 prompt**(cron 就这么干,`useScheduledTasks.ts:71` / `cronScheduler.ts:546`);
  3. **后端服务 / 单次模型调用**直接办,不进主循环(如 `generateToolUseSummary`、`jobs/classifier.ts`)。
- **正确对应物**:所谓"衔接层" = 上面这三种里选一种的**那一行调用**而已(`spawn` 一次、`enqueue` 一次、或注册一个 `ToolDef`)。**不需要、也不该有**一个把产品逻辑和循环内部耦合起来的"层"。产品功能就是 B 线代码,自己活在后端服务/前端按钮里;要让模型能用,就挂个工具或塞条 prompt,**到此为止**。

---

## 附:关键 cc 文件:行 速查

| 主题 | 文件:行 |
|------|---------|
| 主循环 `queryLoop` / `while(true)` | `src/query.ts:244` / `:310` |
| 调模型 `callModel` | `src/query.ts:666` |
| 唯一的继续/收工判定 `if(!needsFollowUp)` | `src/query.ts:1070`(设值 `:841`) |
| 执行工具 `runTools` | `src/query.ts:1390` |
| 下一轮拼装并循环 | `src/query.ts:1723-1735` |
| 权限瀑布 `hasPermissionsToUseToolInner` | `src/utils/permissions/permissions.ts:1174-1332` |
| 权限入口 `hasPermissionsToUseTool` | `src/utils/permissions/permissions.ts:483` |
| 压缩阈值 `getAutoCompactThreshold` | `src/services/compact/autoCompact.ts:72` |
| hooks 分发 `getMatchingHooks` / `executeHooks` | `src/utils/hooks.ts:1621` / `:1970` |
| 桌面 cron 调度器(spawn 子进程) | `src/server/services/cronScheduler.ts:390`(tick `:416`,spawn `:546`) |
| cron 调度器启动 | `src/server/index.ts:453` |
| REPL cron:模型建任务的工具 | `src/tools/ScheduleCronTool/CronCreateTool.ts:117` |
| REPL cron:到点塞 prompt 进队列 | `src/hooks/useScheduledTasks.ts:71-115` |
| KAIROS 开关 `isKairosCronEnabled` | `src/tools/ScheduleCronTool/prompt.ts:36` |
| 我们移植里对标 cron 的注释(已对齐) | `ts/src/server/services/scheduledTaskRunner.ts:11-14` |
