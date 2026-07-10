# R3 审核报告 · hooks P0 修复 + 权限小修对

审核对象:ts/src/hooks/{hooks.ts,hookConfig.ts}、server/index.ts hooks 加载段、
agents/bundled/{explore.md,plan.md}、agents/readOnlyAgentTools.test.ts、permissions/autoEditSafety.ts。
规格对照:~/Desktop/cc-haha-ref(src/services/tools/toolHooks.ts、src/utils/hooks.ts、
src/utils/hooks/hooksSettings.ts、hooksConfigSnapshot.ts、src/utils/permissions/{permissions,filesystem}.ts、
src/tools/AgentTool/built-in/exploreAgent.ts)。

测试:`bun test src/hooks/ src/permissions/autoEditSafety.test.ts src/agents/readOnlyAgentTools.test.ts src/harness/loop.test.ts`
→ 177 pass / 0 fail。`bun run typecheck` → 干净。

---

## CONFIRMED

### C1. readOnlyAgentTools.test.ts 的"遍历真实生产工具注册表"是夸大其词——实测漏掉一批无门禁写工具
file: ts/src/agents/readOnlyAgentTools.test.ts:23-25(`buildGeneralRegistry()` 空参调用)
对照: ts/src/server/index.ts:1732(`backgroundBaseRegistry = buildGeneralRegistry({..., extraTools:
[...domainPackTools, ...taskTools, ...teamTools, ...mediaTools, ...storeDocTools]})`),
:1738(`backgroundAgentOptions.baseTools = backgroundBaseRegistry.list()`),
:1760-1763(`createAgentTaskTool({ baseTools: backgroundAgentOptions.baseTools, ... })`——
agent_task 分发 Explore/Plan 时真正吃到的 baseTools 就是这份扩展注册表)。

守卫测试用的是**同一个函数**`buildGeneralRegistry`,但**调用参数不同**:测试传空(无 extraTools),
生产传了 domainPackTools/taskTools/teamTools/mediaTools/storeDocTools。测试的 docstring 写"遍历真实生产
工具注册表……agent_task 装配子代理工具集时用的同一个函数"——这句话技术上没错(函数是同一个)但结论误导
(参数不同导致覆盖面差很多),让人以为测试盖住了生产实际能拿到的工具集,实际没有。

**复现**(脚本见 `/private/tmp/.../scratchpad/audit/verify_leak.test.ts`,构造与生产同形的 registry:
`buildGeneralRegistry({ extraTools: [...createTaskTools(fakeTasks), ...createMediaTools(fakeMedia)] })`,
对 Explore/Plan 跑 `resolveAgentTools` + 同一判定逻辑):

```
Explore leaked tools: [ "cancel_background_task", "TaskStop", "run_command_background",
  "make_poster", "generate_image", "edit_image" ]
Plan leaked tools: [ 同上 ]
```

逐个定性(按 file:line):
- **`cancel_background_task`**(ts/src/tasks/taskTools.ts:997-1015):`isReadOnly:false`,
  **无 requiresApproval / requiresApprovalFor / approvalClass / forceConfirm 任何一个**。走
  `resolvePermissionInner`(ts/src/permissions/resolve.ts:180,202):`needsApproval` 算出 false →
  直接 `{behavior:'allow'}`,**零门禁静默放行**。只要父会话不是 `plan` 模式(Explore/Plan 默认继承父
  模式,见 `resolveSubagentPermissionMode`,ts/src/permissions/canonical.ts:56-65,不会被强制收紧到
  plan),Explore/Plan 这类自称"READ-ONLY……STRICTLY PROHIBITED from … Running ANY commands that
  change system state"的子代理**可以真的悄悄取消任意后台任务**(不限于自己会话)。这是本轮 disallowedTools
  清单和守卫测试都没盖到的真缺口——不是本次 P0 批次引入的(taskTools.ts 不在本次 diff 里),但恰好是
  这条守卫测试本该但没能抓住的那类问题。
- **`make_poster` / `generate_image` / `edit_image`**(ts/src/media/mediaTools.ts:119-204):`isReadOnly:false`,
  同样零门禁——这是产品有意为之的全局策略(CLAUDE.md 铁律 4:"生图不弹审批直接出图"),对主对话是对的,
  但对自称"不创建任何文件"的只读子代理是矛盾的:Explore/Plan 理论上能触发真花钱、真写文件的生图任务。
- **`run_command_background`**(ts/src/tools/backgroundCommandTool.ts:51-):有 `requiresApprovalFor`
  (按命令风险动态判,同 `run_command`),非只读命令仍会走 ask,**不是**无门禁静默放行;但它**没有
  `isReadOnlyFor`**(`run_command` 有),纯从声明上看少了这个一致性标记,守卫测试的"读工具有 isReadOnlyFor
  就豁免"逻辑套不到它头上——功能上比 cancel_background_task 安全得多,只是清单/声明不一致。
- **`TeamCreate`**(ts/src/tasks/teamTools.ts:592-623):`isReadOnly:false`,同样**零门禁**——
  与 `cancel_background_task` 同类问题(建团队目录/文件是真实写盘动作)。`TeamDelete` 有 forceConfirm、
  `SendMessage` 只对 bridge scheme 加门禁(本地队友消息仍零门禁)——同一模式的延伸,篇幅所限未逐一复现。
- **`TaskStop`**(ts/src/tasks/taskTools.ts:1051-1102):`requiresApproval:true, forceConfirm:true`
  ——虽然天真的 `isReadOnly` 检测会把它标为"leaked",但它每次都强制问人,实际安全,是这套判定逻辑的
  假阳性(而非真缺口)。

**结论**:本次 P0 批次给 Explore/Plan **新增的四项**(save_memory/todo_write/EnterWorktree/ExitWorktree)
本身是对的、且被现有守卫测试真实盖住(该测试对"空参 buildGeneralRegistry()" 这个较窄注册表而言是绿的、
不是假绿)。但守卫测试**对生产实际组装的更大注册表不成立**——`cancel_background_task`/`TeamCreate` 这类
"isReadOnly:false 且零门禁"的工具,在生产环境下确实能被自称"只读"的子代理调用且不弹任何确认,这是货真价实
的功能缺口,只是不属于本次改动引入(taskTools.ts/teamTools.ts 均不在本轮 diff 里)。

建议:①把守卫测试的 registry 构造对齐生产实际形状(至少把 domainPackTools/taskTools/teamTools/mediaTools/
storeDocTools 也塞进去,或者干脆从 server/index.ts 抽一个"生产 baseTools 构造函数"给测试复用,避免测试和
生产两处独立拼装再次跑偏);②`cancel_background_task`/`TeamCreate` 补 requiresApproval 或至少把它们塞进
Explore/Plan 的 disallowedTools(治标);③generate_image/edit_image/make_poster 是否该对只读子代理禁用,
是产品决策,建议问 owner。

---

## 已验证正确(PLAUSIBLE 排除 / 无发现)

### V1. hookAllowBypassesAsk 与 cc resolveHookPermissionDecision 语义对照——逐层核实,判定等价
cc(`~/Desktop/cc-haha-ref/src/services/tools/toolHooks.ts:333-435`):hook allow 时先查
`tool.requiresUserInteraction?.()`(未被 hook.updatedInput 满足则强制走 canUseTool,不吃 allow)+
`requireCanUseTool` 强制位;否则调 `checkRuleBasedPermissions`——该函数内部检查 deny 规则(1a)、
ask 规则(1b/1f,含 bash 子命令级)、safetyCheck(1g,acceptEdits 敏感路径闸)。三者都不命中(`null`)
才让 hook allow 生效跳过弹窗;`null` **不等于**"没有任何规则"而是"没有规则/安全闸提出异议"。

我们(`ts/src/permissions/resolve.ts:154-214` + `hooks.ts:336-344` `hookAllowBypassesAsk`):
`resolvePermissionInner` 统一跑完整瀑布(deny 规则→forceConfirm→requiresUserInteraction→ask 规则→
…→acceptEdits safetyCheck→default ask),**只有** fallback 到最后一行"default/acceptEdits 走到这的
只读+需审批或对外/不可逆工具 → 弹卡"(`resolve.ts:213`,`reason:{type:'mode'}`)这一种 ask 才会被
`hookAllowBypassesAsk` 放行;forceConfirm/requiresUserInteraction/rule/safetyCheck 四种 reason 类型
全部在 `hookAllowBypassesAsk`(`hooks.ts:341-343`)里被挡(`decision.reason?.type === 'mode'` 判定)。

逐项对照:denyRule(cc 1a)→ 我们的 denyRule 分支已在 ask 判断之前短路返回 deny,不会走到
hookAllowBypassesAsk;askRule(cc 1b/1f)→ 我们 `reason:{type:'rule'}` 挡;safetyCheck(cc 1g)→
我们 `reason:{type:'safetyCheck'}` 挡;requiresUserInteraction(cc 调用方预检查)→ 我们
`reason:{type:'requiresUserInteraction'}` 挡。**没找到"cc 会放行而我们不放(或反之)"的输入**——
唯一的架构差异是:cc 用一个专门的窄函数(checkRuleBasedPermissions,故意不跑分类器/bypassPermissions)
判定是否放行 hook allow;我们复用完整瀑布再看 reason 打标——但由于我们没有 cc 的"auto-mode 分类器"
子系统(该缺口已在既有审计 07-hooks.md §一 #15 记录、非本轮范围),两者在**现有功能交集**上行为等价。

测试证据:`ts/src/hooks/hooks.test.ts:127-146` 单元测试 + `ts/src/harness/loop.test.ts:1195-1212`
端到端集成测试(真跑 runAgentLoop,断言 hook allow 下 write_file 真落盘且无 approval_request)双重覆盖
正例;负例(forceConfirm/rule/safetyCheck 不被绕过)目前**只有** hooks.test.ts 的纯函数单测覆盖,
loop.ts 端到端层面没有对应负例(轻微覆盖缺口,非功能 bug)。

⚠️ 文档陈旧(非功能问题):`hooks.ts:329` 注释写"本次改动未接线到 loop——见调用方接线说明",但
`loop.ts:1163,1180` 已经真实接线并有集成测试通过。这句注释是过时文案,建议顺手删掉避免误导下一个读者。

### V2. loadUserHookRegistry/loadWorkspaceHookRegistry 三级合并——与 cc getAllHooks/getHooksFromAllowedSources 语义对照
cc 运行时合并(`~/Desktop/cc-haha-ref/src/utils/hooks/hooksConfigSnapshot.ts:18-53`
`getHooksFromAllowedSources`):正常情况下(无 allowManagedHooksOnly/disableAllHooks)
`mergedSettings.hooks`——**全源合并、无覆盖语义**,与我们 `mergeHookRegistries(...)` 的"全部拼接进
rules 数组"行为一致。三级路径(user/project/local)对齐 `permissions/permissionsSettings.ts` 同构
实现,测试(`hookConfig.test.ts:130-167`)验证三级都加载、且 `.claude` 目录不会被误读(白标隔离正确)。

**未受信工作区挡 project/local 但放 user 的口径与 cc 是否一致?—— 不一致,但这是既有、已自述的
intentional-delta,本轮只是把它从"仅 managed"扩展到"managed+user"两个来源。**
cc 的 `shouldSkipHookDueToTrust()`(`~/Desktop/cc-haha-ref/src/utils/hooks.ts:289-299`)是**单一
全局布尔闸**,doc 明确写"ALL hooks require workspace trust"——在 `executeHooksOutsideREPL`/主执行入口
(`hooks.ts:2010-2017,3049-3054`)最前面短路,**不区分 user/project/local/managed 来源**;若当前项目
未过信任对话框,连 `~/.claude/settings.json`(cc 的"user"级全局配置)里配的 hook 也会被一起挡。
我们的 `shouldRunHookRule`(`hooks.ts:169-181`)让 `source==='user'` 和 `'plugin'` 都直接跳过 workspace
trust 检查(只挡 `local`),这与 cc 的字面行为**不等价**(cc 会挡 user,我们不挡)。但这是代码里
已自述、已有测试覆盖的产品决策(`hooks.ts:67-70` 注释 + `hookConfig.test.ts:169-205` 显式测试
"user 不受信任门影响"),延续了既有审计(07-hooks.md §2.11)已经记录并认可的"managed 不受 cc 全或无
信任门约束"这条 intentional-delta,本轮只是把同样的理由套用到 'user' 源——不是本轮新引入的隐藏偏差,
是同一决策的自然延伸,已测试锁定行为、非"声称做了实际没做"。**结论:与 cc 字面行为不一致,但有意为之
且已充分记录/测试,不算实现缺陷。**

死路径清理:全仓 grep `defaultHooksPath|server/hooks\.json` 只剩注释里的历史说明(`server/index.ts:418-419,
1627`、`hookConfig.ts:798`、`hookConfig.test.ts:127`),没有可执行的死代码残留;`opts.hooksPath` 作为
`extraPath` 参数正确叠加进 `loadWorkspaceHookRegistry`(`hookConfig.test.ts:207-230` 有测试)。

### V3. readOnlyAgentTools.test.ts 的哨兵断言——真实有效,不会因 prompt 改写静默失效
`readOnlyAgentTools.test.ts:23` `expect(readOnlyAgents.map(a => a.name).sort()).toEqual(['Explore', 'Plan'])`
——若有人把 explore.md/plan.md 的"READ-ONLY MODE"文案删掉或改写,`readOnlyAgents` 会变成空数组或者少一个,
这行断言直接失败(而不是静默通过空循环)。若未来新增第三个自称只读的 bundled agent,同理会因为数组多一项
而失败,强制去更新这行哨兵——机制本身设计正确,不是自欺欺人的假绿。

`run_command` 的 `isReadOnlyFor` 动态豁免口径:cc 自身对 Bash 工具也不做静态禁用,只在 Explore/Plan
的 prompt 里教"只用来跑 ls/git status 等只读操作"(`~/Desktop/cc-haha-ref/src/tools/AgentTool/built-in/
exploreAgent.ts:47-48`),真正的写操作仍会走正常 Bash 权限检查(ask/deny)。我们的
`runCommandTool.ts:39-45`(`isReadOnly:false, isReadOnlyFor` 按 `classifyCommandRisk==='read'` 判定)+
守卫测试把"有 isReadOnlyFor 的工具"整体豁免的处理方式,与 cc 口径一致——这不是漏洞,是双方共同的
设计取舍(在 C1 里发现的 `cancel_background_task`/`TeamCreate` 才是真问题,它们**没有** isReadOnlyFor
这层动态豁免的正当性,是彻头彻尾的零门禁,性质不同)。

### V4. autoEditSafety.ts 白标翻转——逐项对照 cc checkPathSafetyForAutoEdit,核心清单等价,发现两处域外差异
`~/Desktop/cc-haha-ref/src/utils/permissions/filesystem.ts:57-79`(DANGEROUS_FILES/DANGEROUS_DIRECTORIES)
与我们 `autoEditSafety.ts:28-42` 逐项比对:`.gitconfig/.gitmodules/.bashrc/.bash_profile/.zshrc/.zprofile/
.profile/.ripgreprc/.mcp.json` 完全一致;`.claude.json`→`.billiardbuddy.json`、`.claude`→`MEMORY_DOT_DIR`
是纯白标换名,清单本体没有裁剪。worktree 例外分支(`.billiardbuddy/worktrees/` 不算危险目录)与 cc
`.claude/worktrees/` 例外逻辑等价移植,且代码自己承认了一个已知遗留(`autoEditSafety.ts:70-73`:
`worktreeTools.ts` 仍把 worktree 落在字面 `.claude/worktrees` 下未跟着改名,该分支目前打不到,但因为
`.claude` 已整体从清单移除、不会被误判为危险,不影响现有行为)——经代码核实(`worktreeTools.ts:326,345,374`)
这段自述准确。文案 grep(`autoEditSafety.ts` 全文 + `autoEditSafety.test.ts:39-45` 专门断言
`!/claude|anthropic/i.test(message)`)确认用户可见文案不含 `claude`/`anthropic` 字面,只有代码注释里保留
(合理,注释面向开发者非用户)。

发现两处 cc 有而我们没照搬的检查项,判定均为**域外(产品无对应子系统)、非缺陷**:
1. cc `checkPathSafetyForAutoEdit`(`filesystem.ts:634-679`)比我们多一层 `isClaudeConfigFilePath` 检查
   (`filesystem.ts:225-242`),覆盖 `flagSettings`(--settings 命令行指定的任意路径)和 `policySettings`
   (企业 managed-settings.json,通常在 `.claude` 目录之外的系统路径)——这两个 SETTING_SOURCES
   在我们的产品里没有对应实体(纯本地单用户桌面应用,无 --settings CLI 参数、无 MDM 托管配置文件),
   `.claude/commands|agents|skills` 部分则已被我们的 `.claude`→segment 级通用目录检查间接覆盖
   (任何路径带 `.claude` 段都会被挡,虽然我们现在挡的是 `MEMORY_DOT_DIR` 段——对我们自己的
   `.billiardbuddy/commands|agents|skills` 同样生效)。**结论:非我们产品架构的功能缺口。**
2. cc 的 Windows-like 判定用 `getPlatform() === 'windows' || getPlatform() === 'wsl'`
   (`filesystem.ts:560`,WSL 下 DrvFs 挂载仍走 Windows 内核解释冒号语法);我们只判
   `process.platform === 'win32'`(`autoEditSafety.ts:93`),WSL 场景不会触发 ADS 冒号检测。
   项目目标平台是 mac dmg / win nsis(`ts/CLAUDE.md` 常用命令),不含 WSL 分发,**该差异对当前
   目标平台不构成实际风险**,仅记一笔供将来若支持 WSL 时补上。

测试覆盖(`autoEditSafety.test.ts`)全绿且刁钻边界到位:大小写绕过、Windows 规范化绕过特征
(trailing dot/8.3 短名/UNC/三连点)、worktree 例外、bypassPermissions 豁免、resolvePermission 集成
(acceptEdits 下 file 类 + 敏感路径退回 ask/safetyCheck reason)均有对应用例并通过。

---

## 裁决建议

P0 hooks 两处修复(allowRequested/hookAllowBypassesAsk 语义、三级配置加载替换死路径)**本身实现正确、
测试到位、与 cc 语义等价或有充分记录的合理分叉**,可判过。权限小修对里 autoEditSafety 的白标翻转
**正确、无遗漏**(域外差异已排除)。

**唯一需要打回/补充的是 C1**:readOnlyAgentTools.test.ts 对"只读子代理不泄漏写工具"的验证覆盖面
不到生产实际注册表,已验证存在真实可复现的缺口(`cancel_background_task`/`TeamCreate` 对 Explore/Plan
零门禁可调用)。这两个具体工具不在本轮 diff 范围内(taskTools.ts/teamTools.ts 未改动),不阻塞本次
hooks/权限批次合并,但建议开一个后续任务:①把守卫测试的 registry 构造对齐生产真实形状;
②给 cancel_background_task/TeamCreate 补审批门禁或加进 disallowedTools。
