# R2b 复审:teammate 去重 + 会话隔离返工

范围:`ts/src/tasks/teamService.ts`(+38/-0)、`ts/src/agents/agentTool.ts`(+88/-6)、`ts/src/agents/agentTool.test.ts`(+163/-6)。`ts/src/tasks/teamTools.ts` 本次 diff 为 0(未改动)。均为未 commit 的工作区改动。

## 声明 1 — C1 去重(generateUniqueTeammateName)

**核实**:`teamService.ts:148-155` 照抄 cc `spawnMultiAgent.ts:267-294`(base 名不冲突原样返回;冲突则 `-2/-3...` 递增,大小写不敏感)。`agentTool.ts:410-425` 在 `startBackgroundAgent` 调用**之前**算好 `uniqueTeammateName`,以它作为 `startBackgroundAgent` 的 `name` 参数(422-425/433-440);回来后 `paramName = task.params?.name`,`finalName = paramName ?? uniqueTeammateName ?? ...`,`registerTeamMember` 用 `formatAgentId(finalName, teamName)` 写入花名册(443-451)。

- **三者一致性**:追到 `taskTools.ts:backgroundTaskParams`→`normalizeAgentInstanceName`(只 trim+校验,不改写字符串),`task.params.name` 与传入的 `uniqueTeammateName` 逐字节相同 → `finalName`/`agentId`/真实后台任务 name 三者恒等。**已用真实路径测试(agentTool.test.ts:1178-1219)验证**,另外自己跑脚本把 `generateUniqueTeammateName`+`mutateTeam` 顺序调 3 次,验证递增到 `researcher-3` 正确(测试文件本身只覆盖到第 2 次,第 3 次是我用 `race-check2.ts` 独立复现验证的,不是被漏测)。
- **并发同名(非串行)**:自己写脚本 `Promise.all([generateUniqueTeammateName(...), generateUniqueTeammateName(...)])`(两次都读同一个尚无成员的 team file)—— **两次都返回裸 `"researcher"`(不是都拿 `-2`,是都拿到未加后缀的重名)**。原因:名字解析(`readTeam`)发生在 `mutateTeam` 写锁**之外**,与 cc 原版同款 race(`teamService.ts:144-146` 注释已如实承认)。核实 cc 源码 `spawnMultiAgent.ts:267-294/855` 确认 cc 本身就是这个写法(读不加锁、写在 `mutateTeamFileAsync` 里),不是本次移植引入的新洞。
  - 影响链:两次并发都算出同一个 `finalName`→同一个 `agentId`→`registerTeamMember` 的去重判定(`existing.agentId === member.agentId`)会让第二次调用静默 no-op(不进花名册),但它对应的后台任务确实在跑——即并发下会重现一个跟 C1 原 bug**同形状**的"静默不入册"。
  - **可达性评估**:本仓库工具执行循环(`loop.ts:663-714`)里非只读工具(`agent_task` 是 `isReadOnly:false`)**严格串行执行**,只有只读工具才会走 `mapWithConcurrency` 并行批;同一轮模型多次调用 `agent_task` 不会真并发。唯一能触发这条 race 的场景是**两个不同 conversationId** 显式传相同 `team_name`(有意跨会话共享)且在几乎同一时刻各自 spawn 同名队友——这是一个很窄的边界,和 cc 本身的已知限制同级,不是这次返工引入的退化。**判定:PLAUSIBLE(cc 同款已知 race,非新增回归,未被测试覆盖但可达性极低)**。

## 声明 2 — C2 会话隔离(getActiveTeamForConversation)

**核实**:`teamService.ts:311-326` 新增,只有 `active.conversationId === conversationId` 才返回;`agentTool.ts:413` 隐式继承(`team_name` 未显式传入时)已切到这个方法;显式传 `team_name`(410-411 `explicitTeamName`)完全绕开这个门,有意允许跨会话。

- 用真实路径测试验证(agentTool.test.ts:1221-1258,`realTeamAgentHarness` 是真 `TaskService`+`startBackgroundAgentRun`+`TeamService`,非 mock):会话 A 建团、显式 `team_name` spawn → `<background_task_started>`;会话 B 不传 `team_name` 单纯 `name` → 落回 `<agent_task>` 前台同步路径、不产生 `<background_task_started>`,团花名册最终只有 `team-lead` + `a-helper`,不含 `b-helper`。**断言严格(精确数组相等,非仅 contains),未放宽**。
- 另一条继承测试(1260-1281)用的是**都不传 conversationId**(mock 路径,ctx 无 `conversationId`,`createTeam` 也没传 `conversationId`)——`undefined === undefined` 匹配成立,能正确继承。这不是"偷偷放宽",生产路径 `server/index.ts:1526` `conversationId = stringOr(rawBody.conversationId, crypto.randomUUID())` 保证真实会话永远有非空 UUID,undefined-vs-undefined 的分支在生产里不会被触发,只是这条测试本身场景选得比较巧(mock,非真实路径),不构成安全漏洞。

**负对照复验**(自己做,不只信声明):`git stash push --keep-index` 只回退 `teamService.ts`+`agentTool.ts`(测试文件保留新版本)→ 3 个新测试里的 **2 个真实路径测试 + 1 个继承测试全部按预期失败**(assert 到旧的 `<agent_task>` 前台输出 / `helper` 未入册),其余 26 个旧测试仍然绿;`git stash pop` 恢复。**证明这几个测试确实是有效回归闸,不是假绿**。

## 声明 3 — 真实路径测试有效性

- **CONFIRMED**:`realTeamAgentHarness`(agentTool.test.ts:1152-1176)用 `new TaskService(root)` + 真实 `startBackgroundAgentRun`(从 `../tasks/taskTools` 导入)+ 真实 `TeamService`,agent_id 不是硬编码常量,每次调用走真实 `task.id` 分配路径。
- 递增覆盖到 `researcher-2`(测试到此为止,第 3 次用独立脚本补验,见声明 1)。
- 跨会话隔离用不同 `conversationId`('conversation-A' vs 'conversation-B')真实验证,非同一 undefined 值取巧。
- 断言未放宽:花名册用精确数组相等/`toMatchObject` 结构校验,ListPeers 输出用具体 `local_peer_count` 数值校验,均非泛泛 `toBeTruthy`。

## 声明 4 — teamTools.ts 遗留 getActiveTeam() 的定性

`teamTools.ts` 本次 diff = 0,以下几处仍用未按会话隔离的 `teams.getActiveTeam()`:

| 位置 | 行为 | 与两条 CONFIRMED 是否同一复现范围 | 风险定性 |
|---|---|---|---|
| `ListPeers`(742,内部走 `teamService.ts:481-484`) | 不传 `team_name` 时落到全局 active team | 不在原复现范围 | 只读信息泄露:B 会话能看到 A 会话团的成员/未读数,无状态破坏 |
| `SendMessage` 纯文本 to 具名目标(`sendPlainMessage`,318-320/704-718) | 无 `team_name` 入参(inputSchema 压根没这个字段);先走 `resolveBackgroundAgentTarget(to,{conversationId})`(**已按会话过滤**,taskService.ts:299-317),命中才走会话内路径;不命中才回落到全局 active team 的邮箱 | 不在原复现范围,但同根因 | 真实跨会话注入:B 会话可以把消息写进 A 会话团里某队友的邮箱(只要 `to` 名字在 A 的团里、且不是 B 会话自己名下的后台任务) |
| `SendMessage` 广播 `to:"*"`(`broadcastPlainMessage`,471-504) | 同上,全局 active team | 不在原复现范围,同根因 | 同上,且是广播,影响面更大 |
| `TeamDelete`(625-646→`teamService.ts:398-424`) | 无会话过滤,直接删全局 active team 目录 | 不在原复现范围,同根因 | 最高风险:B 会话能删掉 A 会话正在用的团(邮箱+花名册),即便有 `requiresApproval:true/forceConfirm:true` 人工确认兜底,但确认框未必能让用户意识到"这是另一个会话的团" |

**判断**:这几处和两条 CONFIRMED(dedup key、agent_task 会话继承)不是同一段代码,严格意义上"没漏"——它们不在这次返工声明要修的范围内,teammate 没有夸大战果。但**根因完全一样**(`TeamService` 单实例、`active-team.json` 单文件、跨全部会话共享,cc 里"一个 CLI 进程 = 一个会话"的隐含假设在这个多会话共享后端里不成立)。是否需要同批修:`TeamDelete`(破坏性、跨会话可删他人团)与 `SendMessage` 落空邮箱(跨会话可注入消息)属于同类真实洞,建议后续同根因批一起补 `getActiveTeamForConversation`(或至少给 `TeamDelete`/`SendMessage` 加显式 `team_name` 校验 + 会话归属检查);`ListPeers` 只读优先级最低。**不阻塞本次返工合入**,因为不在这次声明的两条 CONFIRMED 复现范围内,但建议开一条新任务跟踪。

## 测试与 typecheck 实测

```
bun test src/agents/agentTool.test.ts src/tasks/taskTools.test.ts src/tasks/teamTools.test.ts
→ 77 pass / 0 fail / 444 expect() calls

bun run typecheck  → 通过,无报错
```

负对照(仅本次复审自己做的验证,非重复 teammate 的话):stash 掉 `teamService.ts`+`agentTool.ts` 到改前版本、保留新测试文件 → 3 个新测试全部失败(证明测试有效);pop 恢复后全绿。

## 结论

- **CONFIRMED**(经我独立复现验证,非仅采信描述):C1 三者一致性成立、递增到 -3 正确;C2 会话隔离在真实路径下成立;两条负对照(teammate 声称的 + 我自己做的)一致,测试非假绿。
- **PLAUSIBLE / 已知边界**:并发(非串行)同名 spawn 仍会撞名并让第二个静默丢出花名册——与 cc 本身的已知 race 同款、非新增回归,代码注释已如实自曝,可达性低(本仓库同一轮工具调用不并发执行 `agent_task`,只有跨会话+显式共享 team_name+真并发窗口才触发)。
- **同类未修补(不在两条 CONFIRMED 范围内,teammate 没有漏报,但建议跟进)**:`teamTools.ts` 的 `SendMessage`(具名回落 + 广播)、`TeamDelete` 仍用未按会话隔离的全局 `getActiveTeam()`,同根因、真实存在跨会话消息注入/误删风险,`ListPeers` 只读泄露风险最低。

## 裁决

**合入**。两条 CONFIRMED 的返工都经独立验证确实修好,测试是真实路径、非假绿,typecheck/目标测试全绿。建议合入后另开一条任务跟踪 `teamTools.ts` 里 `SendMessage`/`TeamDelete` 的同根因跨会话隔离缺口(尤其 `TeamDelete` 破坏性更高),不必卡这次返工。
