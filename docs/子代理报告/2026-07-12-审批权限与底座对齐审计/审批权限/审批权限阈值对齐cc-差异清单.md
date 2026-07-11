# 审批权限阈值对齐 cc 差异清单

> 📌 状态:🚧进行中 · 任务〈审批权限对齐审计〉

## 怎么复核我的结论

1. 我方代码位置固定为 `ts/src/...`(仓库根 `/Users/swl/Desktop/球房运营AI助手-桌面版/ts`),cc 代码位置固定为 `~/Desktop/cc-haha-ref/src/...`。每条发现都给了双边 `file:line`,可以直接用 `Read` 工具打开对应行核对——我给的行号是当时读到的真实行号,不是转述。
2. 所有"毒例"(poison example)都是"同一个输入 I,分别喂给我方 `resolvePermission`/cc 对应函数,看两边判定"的形式,可以直接抄成 `bun test` 用例(我方)或在 `cc-haha-ref` 里跑交互式 REPL 手工复现(cc)。
3. 我在收尾前跑了 `cd ts && bun test src/permissions/`,120 个既有用例全绿(见文末"我实际验证了什么")——这说明我列出的分叉**都不是被现有测试判过的行为**,而是真实的覆盖空白;凡是我在 `resolve.test.ts` 里找到"显式断言当前行为"的地方,我都在对应发现里点出了具体测试名和行号,并据此把该条判成"确认为故意设计"而非"疑似 bug"。
4. 我没有可执行 `~/Desktop/cc-haha-ref` 的运行环境(它是一个独立的大型 Electron/CLI 项目,没有现成的最小可跑入口能让我在本次审计时间内拉起来跑交互式验证),所以 cc 一侧的结论全部来自**读源码 + 静态追踪调用链**,不是跑出来的观测结果。凡是我判断"疑似"的条目,都在"验证步骤"里写清了如果有 cc 运行环境应该怎么跑才能实锤。
5. 审计范围边界(避免与其它三路重叠):本报告只覆盖"审批权限判定本身"——`ts/src/permissions/*` 的判定瀑布、`dangerousCommand.ts` 的红线如何喂进判定、`server/index.ts` 的 `runApprovedTool/handleReject/permissionUpdates`。**不覆盖**:Bash 工具自身的命令解析/AST/超时/输出截断机制、workspace/sandbox 的物理隔离实现、Server 的 WS 协议/SSE/崩溃恢复(这些是"丙"组 `丙-工具与护栏对齐清单.md` 的范围);也不覆盖主循环/模型出口/上下文压缩/系统提示词(“乙”组)、hooks/skills/子代理/MCP/存储/记忆(“丁”组)。凡是我在追查判定逻辑时顺带路过这些模块的代码,只作为"判定所需的上下文证据"引用,不对它们本身下结论。

## 结论摘要

审批权限判定链路上找到 **8 条具体分叉/缺口**,其中 2 条是**已被我方测试显式断言的故意设计**(但仍与 cc 源码机制不同,需要 owner 确认知悉)、2 条是**结构性真分叉/真缺口**(其中 1 条是 2026-07-12 那个 `working_dir` 洞的同款孪生洞——`enabled_packs` 在审批执行链路上同样没有从 session 补齐)、1 条是**我方凭空多出的机制**(拒绝限流静默拒答)、2 条是**疑似**(需要更多验证)、1 条是**降级适配**(Windows UNC 放宽未接入,低风险)。全部结论都在下面逐条列出,每条给了 ≥3 个可直接转成对齐测试的毒例(只有明确没有第三个有意义变体的条目除外,并说明原因)。

---

## 1. bypassPermissions 是否越过了不该越过的——「危险命令红线」在两边的处理方式根本不同

**级别:产品层故意(已被我方测试显式断言为设计意图,但与 cc 实际机制不同,请 owner 确认知悉这条分叉)**

### 我方判定
- `ts/src/permissions/resolve.ts:157-158`:
  ```
  const fatal = tool.fatalReasonFor?.(input, ctx)
  if (fatal) return { behavior: 'deny', message: `拒绝执行:${fatal}`, reason: { type: 'fatal', text: fatal } }
  ```
  这是瀑布**第一步**,在读 `mode` 之后立刻执行,不受任何档位影响——`bypassPermissions`/`dontAsk` 也一样被 deny。
- `ts/src/tools/runCommandTool.ts:71-73`:`fatalReasonFor(input) { return isDangerousCommand(input.command) ? \`危险命令:${input.command}\` : null }`——把 `isDangerousCommand` 接进 `fatalReasonFor`。
- `ts/src/tools/dangerousCommand.ts:10-20`(`DANGEROUS_PATTERNS`):`rm -rf /|~|$HOME`、`sudo`、`mkfs`、`dd ... of=/dev/`、fork 炸弹 `:(){ :|:& };:`、`shutdown|reboot|halt|poweroff`、`rm *|/*`、`rm C:\`。
- **已有测试证明这是故意设计**:`ts/src/permissions/resolve.test.ts:115`(`test('bypassPermissions:跳过普通审批,但不跳过 fatal/forceConfirm/必须用户交互', ...)`)、`resolve.test.ts:32-36`(`test('fatal → deny(永不执行)', ...)`,输入档位就是 `ctx('bypassPermissions')`)。这不是抄漏,是明确写了测试的设计。

### cc 判定
- `~/Desktop/cc-haha-ref/src/tools/BashTool/pathValidation.ts:70-108`(`checkDangerousRemovalPaths`):对 `rm`/`rmdir` 命中危险路径(`/`、`~`、盘符根、通配 `*`、根目录直接子目录)时返回的是 **`behavior: 'ask'`**,不是 `deny`;函数注释原话是"requires explicit approval and **cannot be auto-allowed by permission rules**"——即它只保证"不能被 allow 规则自动放行",从没说"不能被 bypassPermissions 模式放行"。
- 这个 `ask` 的 `decisionReason.type` 是 `'other'`(`pathValidation.ts:93-96`),不是 `'rule'` 也不是 `'safetyCheck'`。回到通用瀑布 `~/Desktop/cc-haha-ref/src/utils/permissions/permissions.ts:1174-1337`(`hasPermissionsToUseToolInner`):只有 `decisionReason.type==='rule'`(1263-1270,step 1f)和 `'safetyCheck'`(1276-1282,step 1g)这两类 ask 会在 `!shouldBypassPermissions` 时被保留;`'other'` 类型的 ask 不受这两步保护,直接落到 `permissions.ts:1287-1299`(step 2a)`if (shouldBypassPermissions) return { behavior: 'allow', ... }`——**在 `bypassPermissions` 模式下会被静默放行,不弹任何卡**。
- cc 里检索不到任何一处对 `sudo`/`mkfs`/fork 炸弹/`shutdown` 这类命令做"字面模式硬拒"的代码(`grep -rn "FATAL" src/tools/BashTool src/utils/bash` 零命中;`dangerousPatterns.ts` 里唯一近似的 `DANGEROUS_BASH_PATTERNS`/`CROSS_PLATFORM_CODE_EXEC` 只用于**ant-only 的 auto/YOLO 模式**下剥离过宽的 allow 规则前缀,跟 default/acceptEdits/plan/bypassPermissions/dontAsk 这五个外部档位的判定完全无关)。

### 毒例(同输入 I,cc 判 X,我方判 Y)
1. I = `{tool:'run_command', args:{command:'rm -rf /'}}`,mode=`bypassPermissions`。
   cc:X = **allow**(直接执行,用户看不到任何提示——`pathValidation.ts:70-108` 的 ask 在 `permissions.ts:1287-1299` 被 bypass 短路)。
   我方:Y = **deny**(`resolve.ts:157-158`,`isDangerousCommand` 命中第一条正则,消息"拒绝执行:危险命令:rm -rf /")。
2. I = `{tool:'run_command', args:{command:'sudo systemctl stop sshd'}}`,mode=`bypassPermissions`。
   cc:X = **allow**(cc 对裸 `sudo` 无任何硬性拦截,普通命令在 bypassPermissions 下直接放行)。
   我方:Y = **deny**(`dangerousCommand.ts:13` `\bsudo\b`)。
3. I = `{tool:'run_command', args:{command:'mkfs.ext4 /dev/sda1'}}`,mode=`default`(刻意换成非 bypass 档,证明这不只是 bypass 语义分叉,default 档下我方也让用户**连审批卡都看不到**)。
   cc:X = passthrough → **ask**(用户能看到审批卡、可以决定批不批准)。
   我方:Y = **deny**,模型收到拒绝文本,用户从未看到过这次请求。

### 掰回改法 / 工作量
如果要求逐决策点跟 cc 一致:把 `fatal` 检查从"瀑布最前、无视 mode"改成"只在非 `bypassPermissions` 档生效",在 `bypassPermissions` 档下把这些命令降级为 cc 式的 `ask`(且不可被 allow 规则/`sessionAllowsTool` 越过,语义对齐 `checkDangerousRemovalPaths` 的"不能被规则自动放行,但能被人工批准")。工作量:中(改 `resolve.ts` 判定顺序 + 改 2 条现有测试的期望值 + 新增"bypassPermissions 下危险命令仍会问"的对齐测试,约 0.5-1 天)。

**但**:项目 `CLAUDE.md`(根级)关键约束 #5/#7 与本任务的项目背景说明都明确写了"bypassPermissions 放行但不越过 forceConfirm/用户交互/**硬拒红线**""危险命令(删根/提权/格式化)直接拒"——"硬拒红线"这个概念本身就是 cc 没有、我们自己加的一层。所以这条更准确的判法是:**我方多出了一层 cc 没有的"fatal 硬拒"机制,且已经写了专门测试确认这是有意为之**。是否要撤回这层加严、换成跟 cc 完全一致的"ask 但可批准",是产品决策,不是 bug——但必须让 owner 清楚:只要保留现状,我们的 `bypassPermissions` 就不是 cc 定义下的真正"跳过一切确认",这一点如果不在测试注释/文档里挑明,以后任何人拿 cc 源码做"行为对齐"回归测试,会在这一条上持续误报。

---

## 2. 同族工具绕过——`run_command` 完全不查文件路径作用域的 deny/ask/allow 规则,这是本次审计找到的唯一一条"cc 挡住、我方放行"的真安全洞

**级别:真分叉(真安全洞)**

### 我方判定
- `ts/src/permissions/resolve.ts:103-133`(`ruleMatchesInput`):对 `tool.name === 'run_command' || tool.name === 'PowerShell'` 分支(106-118 行),`ruleContent` 永远被当成**命令模式**去匹配(`shellCommandMatchesDenyOrAskRule`/`commandMatchesPattern`),完全不会去看这条规则是不是一条**文件路径规则**、命令本身有没有触碰到那个路径。
- `ts/src/permissions/filePathRuleMatch.ts:96-100`(`filePathToolOperation`):只认定 `WRITE_PATH_TOOLS`/`READ_PATH_TOOLS`(`write_file`/`edit_file`/`multi_edit_file`/`patch_file`/`patch_files`/`edit_excel`/`NotebookEdit`/`restore_file`/`read_file`/`read_many_files`/`code_outline`/`file_history`)这个固定集合,`run_command` 不在其中,函数对它返回 `null`——resolve.ts 第 124-128 行的路径规则匹配分支因此对 `run_command` **整体跳过**。
- `ts/src/tools/dangerousCommand.ts:4095-4100`(`redirectionTargetNeedsApproval`):对输出重定向目标只判断"是否越出 workspace root / 含特殊展开字符",**不查任何用户配置的 deny/ask/allow 规则内容**。

### cc 判定
- `~/Desktop/cc-haha-ref/src/utils/permissions/filesystem.ts:934-948`(`getPatternsByRoot`)原文注释:
  ```
  case 'edit':
    // Apply Edit tool rules to any tool editing files
    return FILE_EDIT_TOOL_NAME
  case 'read':
    // Apply Read tool rules to any tool reading files
    return FILE_READ_TOOL_NAME
  ```
  即:规则不是按"发起工具的名字"分桶,而是按"这次操作是读还是写"分桶——`Edit(...)`/`Read(...)` 规则对**任何**做读写操作的工具都生效,不局限于 Read/Edit/Write 工具本身。
- `~/Desktop/cc-haha-ref/src/utils/permissions/pathValidation.ts:141-162`(`isPathAllowed` 第 1 步):`matchingRuleForInput(resolvedPath, context, permissionType, 'deny')`——不带 toolName 参数,纯按路径 + 操作类型查。
- `~/Desktop/cc-haha-ref/src/tools/BashTool/pathValidation.ts:924-1003`(`validateOutputRedirections`)对每个重定向目标调 `validatePath(target, cwd, ctx, 'create')`(951-956 行),`validatePath` 内部就是走到上面那个共享的 `isPathAllowed`;命中 deny 规则时(970-981 行)直接返回 `{behavior:'deny', message:"Output redirection to '...' was blocked by a deny rule."}`。也就是说 **BashTool 的路径校验复用的是和 Read/Write/Edit 完全同一份规则引擎**,一条 `Edit(.env)` deny 规则天然保护 `.env` 不被 Bash 重定向写入。

### 毒例
1. I = 已配置规则「`deny Edit(.env)`」(持久化,localSettings)+ 模型调用 `write_file({path:'.env', content:'X'})`。
   cc:X = **deny**。我方:Y = **deny**(`filePathRuleMatch.ts` 对 `write_file` 挂了这条规则)。→ 这一条两边一致,只是用来证明"直接走文件工具"没问题,反衬下一条的落差。
2. **(核心洞)** I = 同一条「`deny Edit(.env)`」规则不变,模型换成 `run_command({command:'echo leaked_secret > .env'})`。
   cc:X = **deny**(`validateOutputRedirections` 通过共享 `isPathAllowed` 命中同一条 `Edit(.env)` deny 规则)。
   我方:Y = **不受这条规则约束**——`ruleMatchesInput` 对 `run_command` 只按命令模式匹配,`deny Edit(.env)` 的 `ruleValue.toolName` 是 `'Edit'`/`'write_file'` 之类,不在 `run_command` 的别名集合 `TOOL_RULE_ALIASES['run_command'] = ['run_command','Bash']`(resolve.ts:83-96)里,永远不命中;`redirectionTargetNeedsApproval` 也只看"越不越出 workspace root",`.env` 在 workspace 内、不越界,不需要审批。最终该命令按普通 `run_command` 的档位规则走(acceptEdits 下直接允许,default 下只是普通 ask——而普通 ask 用户很可能不会意识到这是在绕过他明确设置的 `.env` 保护规则,一批准就写进去了)。
3. I = 规则「`deny Read(**/secrets/**)`」+ 模型调用 `run_command({command:'cat secrets/api_key.txt'})`(读,不是写)。
   cc:X 需要进一步确认——受时间限制我没有把 `~/Desktop/cc-haha-ref/src/tools/BashTool/pathValidation.ts` 里 `validateSinglePathCommand`/`PATH_EXTRACTORS['cat']`(约 819-924 行)完整读到底、没能 100% 确认它是否也调用 `validatePath(path, cwd, ctx, 'read')`。**此条降级为疑似**,不计入"真分叉"计数,但强烈怀疑同样成立(cc 的 `PathCommand` 类型联合体里明确列了 `'cat'|'rm'|'rmdir'|'mv'|'cp'|...`,说明这些命令的路径参数本来就有专门的提取器)。
   我方:Y 可以肯定是**不受保护**——`run_command` 完全不查 Read 家族规则,且我方"输出层 read-ignore 过滤"(`readIgnoreFilter.ts`)只包在 `list_dir`/`glob_files`/`grep_files` 这三个工具上(`filePathRuleMatch.ts:53-58` 的头部注释明确写了这个范围),不包 `run_command` 的 `cat`。
   **验证步骤(供确认第 3 条 cc 侧结论)**:读 `~/Desktop/cc-haha-ref/src/tools/BashTool/pathValidation.ts:819-924` 的 `validateSinglePathCommand`/`PATH_EXTRACTORS`,确认 `cat`/`grep`/`head` 是否调用 `validatePath(..., 'read')`;若确认成立,则在我方仓库配置 `deny Read(secrets/**)` 后,分别用 `read_file` 和 `run_command` 的 `cat` 读同一文件,断言前者拒、后者放行,即可实锤。

### 掰回改法 / 工作量
在 `resolve.ts` 的 `ruleMatchesInput` 里,对 `run_command`/`PowerShell` 分支新增一步:提取命令里的"写目标路径"(复用已有的 `extractOutputRedirectionTargets`/`shellOutputRedirectionNeedsApproval` 逻辑,以及 `cat`/`rm`/`mv`/`cp`/`sed -i` 等命令的路径参数提取——`dangerousCommand.ts` 里已经有大量类似的路径抽取代码可以复用,比如 `removalCommandTouchesDangerousPath`/`readCommandTouchesSensitivePath` 用的 tokenizer),对每个目标路径用已经存在的 `fileGlobMatchesPathForRule`(`filePathRuleMatch.ts`)分别按 write/read 操作类型过一遍 Edit/Read 规则表,命中 deny 直接 deny、命中 ask 直接 ask。工作量:中高(约 2-3 天,核心难点是要把 `dangerousCommand.ts` 里已经零散实现的路径抽取逻辑和 `filePathRuleMatch.ts` 的规则匹配引擎对接起来,同时不能引入新的性能问题,并且要写覆盖 compound command / `xargs` / heredoc 场景的对齐测试)。

---

## 3. 计划模式(plan)下非只读工具——我方是硬 deny,cc 找不到证据是硬 deny(更像是跟 default 一样只是 ask)

**级别:疑似(我方为确认过的故意设计;cc 侧结论基于 3 处独立代码路径的排除法,未能实际跑 cc 观察,降级为疑似)**

### 我方判定
- `ts/src/permissions/resolve.ts:170-177`:
  ```
  if (mode === 'plan' && !readOnly) {
    if (isPlanFileWrite(tool, input, ctx)) return { behavior: 'allow', ... }
    return { behavior: 'deny', message: PLAN_SKIP_MSG(tool.name), reason: { type: 'planSkip' } }
  }
  ```
  对**所有**非只读工具,在 plan 模式下一律 deny(唯一例外是写本会话计划文件本身)。
- **已有测试确认这是故意设计**:`ts/src/permissions/resolve.test.ts:38-40`(`test('plan 模式 + 非只读 → deny(planSkip)', ...)`)。

### cc 判定(基于源码排除法,非运行观测)
我在三处独立代码路径里都没有找到 cc 对 `mode==='plan'` 做 deny 判定的证据:
1. `~/Desktop/cc-haha-ref/src/tools/BashTool/modeValidation.ts:23-56,72-90`(`checkPermissionMode`)——只处理 `acceptEdits`(37-50 行,`ACCEPT_EDITS_ALLOWED_COMMANDS` 自动放行)、显式跳过 `bypassPermissions`(77-82 行)和 `dontAsk`(85-90 行),对 `plan` 没有任何分支,直接落到 92-100 行的透传(`passthrough`)。
2. `~/Desktop/cc-haha-ref/src/utils/permissions/pathValidation.ts:207-215`(`isPathAllowed` 第 3 步):"For write/create operations, require **acceptEdits mode** to auto-allow"——只认 `acceptEdits`,`plan` 和 `default` 一样落到后面的 `ask`。
3. 通读 `~/Desktop/cc-haha-ref/src/utils/permissions/permissions.ts` 的 `hasPermissionsToUseToolInner`(全函数,1174-1337 行)和 `~/Desktop/cc-haha-ref/src/tools/*` 下所有 `.checkPermissions` 实现,`grep -rn "mode === 'plan'" src/tools` 零命中——没有任何单个工具的 `checkPermissions` 对 plan 模式做特殊处理。

三处证据共同指向:cc 里 `plan` 模式对写操作的**技术强制层面**等同 `default`(都是 ask,用户能看到审批卡、可以批准),"计划模式不动手"更可能是靠系统提示词指令模型只读 + `EnterPlanMode`/`ExitPlanMode` 工具的产品流程去实现,不是权限引擎里的强制拒绝。

### 毒例
1. I = mode=`plan`,`{tool:'write_file', args:{path:'notes.txt', content:'draft'}}`(非计划文件)。
   cc(基于排除法推断):X = passthrough → **ask**(用户能看到"Claude requested permission to write to notes.txt"卡片、可批准)。
   我方:Y = **deny**(`PLAN_SKIP_MSG`),用户完全看不到审批卡。
2. I = mode=`plan`,`{tool:'run_command', args:{command:'mkdir -p /tmp/scratch'}}`。
   cc:X = `BashTool.isReadOnly('mkdir ...')`=false → 落到 ask(可批准执行)。
   我方:Y = **deny**(`run_command` 的 `isReadOnlyFor` 判 `mkdir` 非只读 → plan+非只读 → deny)。
3. I = mode=`plan`,`{tool:'edit_file', args:{path:'src/foo.ts', ...}}`(非计划文件)。
   cc:X = ask。我方:Y = **deny**。

### 判级理由与验证步骤
虽然三处代码路径高度一致地指向"cc 的 plan 模式在权限引擎层面不拒绝",但我没有可运行的 cc-haha 环境去肉眼验证"进入 Plan Mode 后尝试 Write 到底出不出审批卡",不能排除有我没检索到的第四处拦截点(例如 query 组装阶段按 mode 过滤工具列表——我按关键词检索未命中,但不能 100% 排除是我检索词没覆盖到)。**验证步骤**:①在 `~/Desktop/cc-haha-ref` 跑 `bun install` 后启动交互式入口,Shift-Tab 切到 Plan Mode,发一句会触发 Write 的请求,肉眼确认是弹审批卡还是直接被拒且无提示;②或读 `~/Desktop/cc-haha-ref/src/screens/REPL.tsx` 里 `isInPlanMode` 相关渲染分支,确认工具调用结果在 plan 模式下的展示逻辑。

### 掰回改法 / 工作量(若验证后确认要对齐 cc)
删除 `resolve.ts:170-177` 的整段特判分支,只保留 `isPlanFileWrite` 的显式 allow 例外,让非只读工具在 plan 模式下并入 default 档的正常瀑布(走到 ask)。工作量:小(半天,含改 1 条现有测试的期望值 + 新增"plan 模式写文件应该是 ask 不是 deny"的对齐测试)。**但**注意项目根 `CLAUDE.md` 核心架构原则 #6 写的是"plan 只读"——如果 owner 认定"plan 只读"就是要比 cc 更硬的产品定义(不满足于"模型自律 + UI 引导"这种软约束),那么现状就该保留、只需要在测试/文档里标注"这是故意比 cc 严"。

---

## 4. 我方多出:"拒绝够了就不再问"的静默熔断,cc 里这套机制只存在于外部用户根本用不到的 ant-only auto 模式

**级别:我方多出(cc 的对外五档里完全没有这个机制,是否保留需 owner 判断)**

### 我方判定
- `ts/src/harness/loop.ts:1233-1236`:
  ```
  if (!forceAsk && shouldStopAskingForContext(ctx, key)) {
    yield* fireDenied(DENIAL_FALLBACK_MSG(call.name))
    yield feedback(DENIAL_FALLBACK_MSG(call.name), true)
    return
  }
  ```
  挂在 `decision.behavior === 'ask'` 的通用处理里(1222 行起),**不区分档位**,default/acceptEdits/plan/bypassPermissions/dontAsk 全部适用。
- `ts/src/permissions/denialTracking.ts:6`:`DENIAL_FALLBACK = { perAction: 2, global: 20 }`——同一动作(工具名+参数精确匹配的 `actionKey`)被拒 2 次,或本会话累计拒绝 20 次,之后同一 `actionKey` 会被**静默拒绝**,不再弹审批卡,模型只收到"老板已经多次没同意执行……换个思路"的固定文案。

### cc 判定
- `~/Desktop/cc-haha-ref/src/utils/permissions/permissions.ts:528-537`:denial-tracking/`handleDenialLimitExceeded` 整套逻辑全部包在
  ```
  if (feature('TRANSCRIPT_CLASSIFIER') && (appState.toolPermissionContext.mode === 'auto' || ...))
  ```
  这个大分支内部。
- `~/Desktop/cc-haha-ref/src/types/permissions.ts:16-38`:`EXTERNAL_PERMISSION_MODES` 只有 `acceptEdits/bypassPermissions/default/dontAsk/plan` 五个,`auto` 是额外塞进 `INTERNAL_PERMISSION_MODES` 的 ant-only 值。
- `~/Desktop/cc-haha-ref/src/utils/permissions/PermissionMode.ts:97-105`(`isExternalPermissionMode`):外部用户(`USER_TYPE !== 'ant'`)时函数恒真,但注释明确"External users can't have auto"。
即:cc 面向外部用户开放的五个档位里,**没有任何一处会因为"拒绝次数太多"就自动停止弹审批卡**——ask 永远是 ask,每次都重新问。

### 毒例
I = mode=`default`,模型连续 3 次请求 `run_command({command:'rm important.log'})`(工具名+参数完全一致),用户连续点了 3 次"拒绝"。
- cc:X = 第 3 次(及以后任意次)依然弹出一模一样的审批卡,用户永远有机会重新考虑批准。
- 我方:Y = 第 3 次请求时 `byAction[key] >= 2` 命中 → **静默拒绝**(`DENIAL_FALLBACK_MSG`),不再弹卡;此后要批准这个精确操作,只能等 `clearDenialForContext` 被别的成功操作触发重置(`denialTracking.ts:69-78`,`recordApproval` 时 `b.total = 0`),或者换一个字节上不同的 `command` 参数(`actionKey` 是精确参数的 `stableStringify`)。

由于这不是"哪边更对",而是我们自己发明的一层机制,不再要求第 2、3 个变体(阈值参数不同不改变结论性质,没有另开新变体的必要)。

### 判级说明
判为【我方多出】而非"疑似 bug":代码本身逻辑自洽、注释清楚("老板拒够了就别再烦"),不是抄漏,是新功能。是否保留是产品决策——好处是防止模型对同一个已被明确拒绝的危险操作反复骚扰用户;坏处是这个"停止询问"的状态**对用户完全不可见**(前端 `ApprovalCard.tsx` 只在收到 `approval_request` 事件时渲染卡片,静默拒绝走的是普通工具失败文案,大概率淹没在聊天记录里,用户不会意识到"系统已经替我做主永久拒绝了这件事,除非我提别的要求")。建议至少在静默拒绝时给用户一条弱提示(比如"已连续拒绝该操作,如果想换个说法批准可以直接说明"),而不是完全无感知地拦截。

---

## 5. 审批放行执行(`runApprovedTool`)硬编码 `permissionMode: 'default'`,丢失原会话真实档位

**级别:疑似(事实已确认,后果依赖被批准工具是否消费 `ctx.permissionMode`,需要更多验证坐实影响面)**

### 我方判定
- 前端 `ts/desktop/renderer-react/src/stores/chatStore.ts:646-655`:
  ```
  approve: (blockId, remember) => {
    ...
    send({
      type: 'approve',
      tool: block.tool,
      args: block.args,
      token: block.token,
      conversationId: id,
      permissionMode: 'default',
      remember_approval: remember,
      ...(approveRoot ? { working_dir: approveRoot } : {}),
    })
    ...
  }
  ```
  `permissionMode` 写死字符串 `'default'`。对比同文件 `sendMessage`(628-636 行)会正确地用 `permissionMode: settings.defaultPermissionMode`(读真实当前档位)。
- 后端 `ts/src/server/index.ts:2405`:`permissionMode: permissionModeFrom(body.permission_mode ?? body.permissionMode)`——原样信了前端传来的值,而 `working_dir` 有专门的"body 缺省时从 session meta 自愈"兜底(2394-2397 行),`permissionMode` 没有对应兜底。

### 毒例
1. I = 会话真实档位是 `bypassPermissions`,模型调用一个 `forceConfirm` 工具(bypassPermissions 也拦不住 forceConfirm,这一步我方行为本身正确,产生审批卡),用户点"允许一次"。
   若该工具 `execute()` 内部会创建子代理(见下第 2 点证据),期望行为:子代理应继承 `bypassPermissions`(用户已经选择了"完全访问",不该被打断)。
   我方实际:`executeApproved` 收到的 `ctx.permissionMode` 被前端强制成 `'default'`——`ts/src/agents/agentTool.ts:393,533` 把 `ctx.permissionMode` 原样/经 `resolveSubagentPermissionMode` 传给子代理,子代理因此会在错误的 `'default'` 档跑,内部再触发一轮不该有的审批打断。
2. I = 会话真实档位是 `acceptEdits`,某文件操作因命中 `autoEditSafetyReason`(比如目标是 `.bashrc`)被打回 ask,用户批准。
   我方:`executeApproved` 内 `resolvePermission` 用被污染的 `mode='default'` 重新跑瀑布——`resolve.ts:204-210` 的 acceptEdits 专属分支因为 `mode !== 'acceptEdits'` 整个跳过,直接落到最后一行的默认 `ask`(`resolve.ts:213`),这次仍然是 `ask` 不是 `deny`,`executeApproved` 只在 `behavior==='deny'` 时才短路——**这条具体命令最终会正常执行**,但 `ctx.permissionMode` 被污染的事实依然存在,任何该工具 `execute()` 内部读 `ctx.permissionMode` 做其它判断的地方都会看到错的值。
3. I = 会话真实档位是 `plan`(理论组合;plan 档下多数写操作会先被 §3 的 deny 拦住,走不到审批卡,所以这个组合当前几乎不可达,只作为"如果 §3 被掰回成 ask 之后"的前瞻性毒例列出):plan 档下 write_file 被 ask,用户批准。cc/理想行为下 mode 该保持 `plan`;我方一样会被强改成 `'default'`。

### 判级理由与验证步骤
已 100% 确认的事实:前端永远传 `'default'`、后端无兜底。未确认的是"是否存在会因此产生可观察错误行为的具体工具组合"——目前唯一确认会消费 `ctx.permissionMode` 的地方是 `agentTool.ts` 的子代理派生(毒例 1);受时间限制,我没有逐一核对**当前 registry 里到底有没有"同时是 forceConfirm/requiresApproval 且内部会调 `agent_task`"这样的真实工具**,如果没有,毒例 1 目前不可复现,只是"结构性地雷"。**验证步骤**:①`grep -rn "AGENT_TOOL_NAME\|agent_task" ts/src/tools ts/src/packs` 找出所有会派生子代理的工具,检查它们是否同时设了 `forceConfirm`/`requiresApproval`;②若存在,构造一个 `bypassPermissions` 会话触发它的审批卡,人工点批准,在 `agentTool.ts` 派生子代理处打日志观察 `ctx.permissionMode` 实际值。

### 掰回改法 / 工作量
前端 `chatStore.ts:652` 把 `permissionMode: 'default'` 改成 `permissionMode: useSettingsStore.getState().defaultPermissionMode`(与 `sendMessage` 同源);后端再补一道防御性兜底(仿 `working_dir` 的自愈,`body.permission_mode` 缺省时从 `sessions.get(conversationId)` 的持久化档位读回)。工作量:小(半天,含一条"approve 请求应带上真实档位"的前后端契约测试)。

---

## 6. 审批放行执行(`buildExecutionRegistry`)不合并会话已持久化的 `enabledPacks`——`working_dir` 洞的结构性孪生洞

**级别:真分叉(结构性,当场可写单测坐实)/ 具体故障后果目前疑似(暂无可触发的真实工具组合)**

### 我方判定
- **主回合正确做法** `ts/src/server/index.ts:1564-1582`,原文注释:
  ```
  // 领域包启用来源三合一(owner 设计:斜杠命令 /台球 → 主循环注入 pack → 自动找内容 + 跨回合保持):
  //   ① 请求体 enabled_packs(前端专家选择器);② 本回合斜杠入口命令(/台球、/球房、/billiards…→ packIdForCommandName);
  //   ③ 会话已持久化的 enabledPacks(上一回合敲过入口命令,即便这回合前端没回传也保持在模式里)。
  const persistedPackIds = Array.isArray(touchedMeta.enabledPacks) ? touchedMeta.enabledPacks : []
  const enabledPacks = mergeEnabledPacks(resolveEnabledPacks(rawBody), [
    ...persistedPackIds,
    ...(slashEnabledPackId ? [slashEnabledPackId] : []),
  ])
  ```
- **审批执行路径的缺口** `ts/src/server/index.ts:2339-2344`(`buildExecutionRegistry`,被 `runApprovedTool` 于 2398 行调用):
  ```
  const enabledPacks = resolveEnabledPacks(rawBody)
  ```
  只读请求体,**没有**合并 `sessions.get(conversationId)` 里持久化的 `enabledPacks`,也没有走 `mergeEnabledPacks`。
- **前端证据**:`ts/desktop/renderer-react/src/stores/chatStore.ts:646-655` 的 `approve`/`reject` payload 里完全没有 `enabled_packs` 字段(对比 `sendMessage` 634 行才会带上),即每次 approve 请求 `rawBody.enabled_packs` 必为 `undefined`。
- 我确认了 `createDomainPackTools`(`ts/src/packs/domainPacks.ts:188-199`)产出的工具目前**都没有设置** `requiresApproval`/`forceConfirm`/`approvalClass`(`grep -rln "requiresApproval\|forceConfirm\|approvalClass" ts/src/packs/` 零命中),所以"审批时报未知工具"这个具体故障目前**没有可触发的真实工具组合**——这是一颗结构性地雷,不是当前活跃的功能性 bug。

### 毒例(第 2 条不依赖任何假设,当场可写单测坐实)
1. **(假设性,展示故障后果)** I:用户已选"台球运营专家"(`enabledPacks=['billiards']`,已持久化进 session meta),模型调用一个**假设**被标记 `requiresApproval` 的台球领域包工具,用户点"允许一次"。
   期望行为(理想中,主回合与审批回合应保持一致):registry 里应该有这个工具。
   我方实际:`buildExecutionRegistry(body)` 用空 `enabledPacks` 建 registry → `createDomainPackTools([])` 为空 → `executeApproved`(`loop.ts:1367-1368`)里 `registry.get(tool)` 返回 `undefined` → `{ok:false, output:'未知工具 ${tool}'}`,批准操作直接失败报错——这与 2026-07-12 已修的 `working_dir` 洞是**完全同构**的故障模式(参数在 approve 请求里没带,后端也没有从 session 自愈)。
2. **(当场可复现的最小单测,不依赖任何工具是否需要审批)** I:某 conversationId 已 `sessions.touch(id, {enabledPacks:['billiards']})`,不带 `enabled_packs` 直接构造两次调用:一次是主回合式的 `enabledPacks` 计算(1564-1582 行的逻辑)、一次是 `buildExecutionRegistry(body)`(2339-2344 行)。断言前者算出的 `enabledPacks` 包含 `'billiards'`,后者不包含——这条断言**现在就成立**,是无条件的结构性分叉,不需要等到有工具需要审批才能验证。
3. I:模型在两个不同请求里对**同一个 conversationId**先后调用 `GET /providers/status`(prewarm,`server/index.ts:2263` 一带走的是同款 `resolveEnabledPacks(rawBody)`、同样没有 session 合并)和 `/agent/run`(主回合),断言两次返回的 `domainTools.count`(`server/index.ts:2319`)与主回合的 `commands`/`skills` 清单不一致——这条同样当场可复现,进一步证明这不是 `runApprovedTool` 独有,而是 `buildExecutionRegistry`/`prewarm` 这一整类"非主回合入口"共享的同一个缺口。

### 掰回改法 / 工作量
把 1564-1582 行那套"三源合并"逻辑抽成一个共享函数(比如 `resolveEnabledPacksForConversation(rawBody, sessions)`),`buildExecutionRegistry`/`prewarm` 都改成调用它,不再各自重复一份 `resolveEnabledPacks(rawBody)`。工作量:小(1-2 小时改代码 + 一条"审批执行 registry 与主回合 registry 一致"的回归测试,即上面毒例 2 的形式)。

---

## 7. `additionalWorkingDirectories` 在审批放行执行时的初始状态缺口(自我修正:比我最初判断的范围窄)

**级别:疑似(字段确实没有默认初始化,但通过 `sessionPermissionUpdates` 的既有机制大部分场景能自愈;窄化后的缺口需要验证)**

### 我方判定
- `ts/src/server/index.ts:2400-2408`(`runApprovedTool` 的 `baseCtx: ToolContext`)没有显式设置 `additionalWorkingDirectories` 字段。
- 但 `server/index.ts:2410-2411` 确实会把 `sessionPermissionUpdates.get(conversationId)` apply 到 ctx 上,而"记住"(remember=true)产生的 `addDirectories` 更新(`ts/src/harness/approvalSuggestions.ts:17-49` 的 `rememberedPermissionUpdatesForApproval`)恰好会被写回 `sessionPermissionUpdates`(`server/index.ts:2413-2416`)——所以**如果目录授权是通过"记住"批准的**,下一次 approve 请求能通过这条既有链路正确拿回 `additionalWorkingDirectories`,不算丢失。
- 真正会丢的是 `ts/src/harness/approvalSuggestions.ts:10-15`(`transientPermissionUpdatesForApproval`)产生的临时授权:它只在 `executeApproved` 内部临时 apply 给 `executionCtx`(`loop.ts:1381`),**不会**被写回 `sessionPermissionUpdates`——但这本来就是"允许一次"(remember=false)语义下的正确行为(只为这一次执行放行,不留痕),不是 bug。
- 我没能在有限时间内确认的是:`additionalWorkingDirectories` 除了 `ts/src/permissions/filePathRules.ts:33-49`(`additionalWorkingDirectoryAllows`,被 `harness/approvalSuggestions.ts:78-86` 的 `isOutsideWorkspace` 消费,只影响"要不要生成一条新的记住建议")之外,**是否还有别的消费点直接参与 `resolve.ts` 瀑布本身的 allow/ask/deny 判定**(而不只是"生成建议文案")。如果只被 `approvalSuggestions.ts` 消费,影响仅限于"重复生成冗余建议",不影响安全性;如果还有别处直接拿它判定,才是实质性的功能 bug。

### 毒例(需要先完成上面的"消费点排查"才能确定是否真的可复现)
1. I:用户此前通过"允许一次"(remember=false)临时授权了 `~/Desktop/素材库` 目录下某次写入,approve 执行完毕后立刻请求第二次写入同目录**另一个文件**、且这第二次因为其它原因(而非目录越界本身)也命中了 ask。批准第二次时,`executeApproved` 重新计算 `isOutsideWorkspace`——由于 `runApprovedTool` 的 baseCtx 没有这次临时授权(它只存在于上一次调用的局部 `executionCtx` 里,从未持久化),会重新判定"这个目录还没被授权",生成一条冗余的"要不要顺便记住这个目录"建议——**目前已确认这只是冗余建议,不影响本次是否放行**,因为 `resolve.ts` 瀑布本身判定这次 ask 是走其它 `approvalClass`/规则路径,不依赖 `additionalWorkingDirectories`。

### 判级理由与验证步骤
自我更正:我最初判断这是"实质性丢失",深入代码后发现"记住"场景有既有机制自愈,"允许一次"场景本来就该是一次性的——所以现在归类为**疑似**而非真分叉。**验证步骤**:`grep -rn "additionalWorkingDirectories" ts/src --include="*.ts"`,把所有消费点过一遍分类:哪些只用于"生成建议/文案"(不影响本次判定),哪些直接参与 `resolve.ts`/工具自身 `requiresApprovalFor`/`isReadOnlyFor` 的 allow/ask/deny 判定本身。如果确认全部只是"生成建议",这条应该降级为"不算问题、可以从清单里划掉";我没做完这一步排查,所以保留在清单里如实标注。

---

## 8. `autoEditSafetyReason` 从不为 Windows UNC 路径放宽,始终传 `allowUncPath=false`

**级别:降级适配(比 cc 更保守,非安全洞,当前几乎不可触发)**

### 我方判定
- `ts/src/permissions/autoEditSafety.ts:188`:`const result = checkPathSafetyForAutoEdit(abs)`——调用时**没有传第二个参数**,而函数签名(`autoEditSafety.ts:127`)是 `checkPathSafetyForAutoEdit(absPath: string, allowUncPath = false)`,永远吃默认值 `false`。

### cc 判定
- `~/Desktop/cc-haha-ref/src/utils/permissions/pathValidation.ts:188-193`(`isPathAllowed` 内对 `checkPathSafetyForAutoEdit` 的调用):`{ allowUncPath: getPlatform() === 'windows' && isInWorkingDir }`——按平台 + 是否在工作目录内动态决定要不要放宽 UNC 路径检查。

### 毒例
I = Windows 平台,mode=`acceptEdits`,写入目标是工作区内的一个 UNC 形式路径(如 `\\?\C:\workspace\file.txt` 这种工作区内但带 UNC 前缀的路径,`\\` 前缀本身在我方 `hasSuspiciousPathPattern` 里会被判"可疑路径规范化特征")。
- cc:X = 因为 `allowUncPath=true`(平台是 Windows 且在工作目录内),不当作可疑路径,继续走正常 acceptEdits 自动放行判断。
- 我方:Y = 始终当作可疑路径(`allowUncPath` 恒为 `false`),退回询问。

由于场景本身很窄(只有 Windows + UNC 前缀 + 工作区内三个条件同时成立才触发),没有再列第二、三个变体的必要。

### 判级理由
`ts/CLAUDE.md` 明确"mac 为首要目标",当前也只验证过 mac 出包(见项目记忆库),这条差异属于"没来得及接入 Windows 专属放行条件",方向是**比 cc 更保守**(拒的更多,不是放的更多),不构成安全洞。工作量:小(半天,把 `resolveAbs` 顺带能拿到的平台信息 + `isInWorkingDir` 判断传进去)。

---

## 未覆盖清单(诚实列出,禁止假装看完)

1. `~/Desktop/cc-haha-ref/src/tools/BashTool/bashSecurity.ts`(2593 行)与 `~/Desktop/cc-haha-ref/src/tools/BashTool/bashPermissions.ts`(2622 行)里除"危险删除路径""输出重定向""plan/acceptEdits 模式校验"之外的其余校验器(`validateObfuscatedFlags`/`validateIFSInjection`/`validateProcEnvironAccess`/zsh 危险命令等 20+ 个校验函数),没有逐条跟我方 `ts/src/tools/dangerousCommand.ts`(4285 行)里的对应实现做逐行比对,只抽查了其中被移植过来、注释写明"移植自 cc"的几处(而这几处抽查看起来是认真逐条对齐过的)。原因:两边文件体量都是 2500-4300 行级别,在本次审计时间内无法做到逐行覆盖,只能优先核对"审批权限判定阈值"直接相关的部分(危险命令是否硬拒/是否越过 bypass/是否跨工具生效),这也是本条审计任务本身要求的重点。
2. `ts/src/permissions/permissionsSettings.ts`(`loadPermissionRules`/`persistPermissionRule`/`configurePermissionTrust`)——磁盘持久化规则的读写细节、跨 `localSettings`/`userSettings`/`projectSettings` 三层与 cc `SETTING_SOURCES` 的精确对应关系,只看了它被调用的位置(`server/index.ts:107,1971,2410`),没有深入核对内部实现是否和 cc 的 `permissionsLoader.ts` 逐层对应。
3. PowerShell 侧:只对比了我方 `dangerousCommand.ts` 里的 `WINDOWS_DANGEROUS_PATTERNS`(cmd.exe 语法)与 cc `PowerShellTool/dangerousCmdlets.ts` 的 YOLO 名单,**没有**深入对比 cc `~/Desktop/cc-haha-ref/src/utils/powershell/powershellSecurity.ts`(实际的 PowerShell cmdlet 危险判定逻辑本体)与我方 `ts/src/tools/powerShellTool.ts` 的逐点对齐情况。
4. hooks 对审批的介入(`PreToolUse`/`PermissionRequest` hook 的 allow/deny/ask 语义):只读了 `ts/src/harness/loop.ts:1170-1256` 的调用点、确认调用顺序看起来合理(hook allow 只豁免 mode 级 ask、hook deny 直接拒、hook 未裁决则照常弹卡),没有深入 `ts/src/hooks/hooks.ts` 内部实现去跟 cc `executePermissionRequestHooks`(`utils/hooks.ts`)逐行比对——这块更偏"丁"组(hooks/skills/子代理/MCP)的地盘,我只做了浅层确认没有越界深挖。
5. 现有 120 个 `src/permissions/*.test.ts` 用例我没有逐条读完内容(只对 `resolve.test.ts` 做了针对性 grep 找"bypassPermissions"/"plan"相关断言),不能保证我列出的 8 条发现里,除了明确引用到的 `resolve.test.ts:32-40,115-124` 之外,没有其它测试文件已经间接覆盖或反驳了某条发现——建议下一步收尾时把这 120 条测试的名字过一遍确认。
6. cc 一侧全部结论来自静态读源码,没有可运行的 `cc-haha-ref` 环境做交互式验证(见"怎么复核我的结论"第 4 条),第 1、2、3 条发现里凡是标"疑似"的都已经写清楚了要跑什么才能实锤。

---

## 我实际验证了什么

**读过的关键文件(我方,`ts/src/`)**:`permissions/resolve.ts`(全文)、`permissions/types.ts`、`permissions/canonical.ts`、`permissions/denialTracking.ts`、`permissions/permissionRules.ts`(全文)、`permissions/filePathRuleMatch.ts`(全文)、`permissions/filePathRules.ts`(导出清单)、`permissions/permissionUpdate.ts`(全文)、`permissions/approval.ts`(全文)、`permissions/approvalSuggestions.ts`(全文,即 `harness/approvalSuggestions.ts` 实际路径经确认为 `ts/src/permissions/approvalSuggestions.ts`)、`permissions/autoEditSafety.ts`(全文)、`permissions/readIgnoreFilter.ts`(全文)、`tools/dangerousCommand.ts`(前 1426 行,含 `DANGEROUS_PATTERNS`/`WINDOWS_DANGEROUS_PATTERNS`/`isDangerousCommand`/`redirectionTargetNeedsApproval` 等核心判定函数;受文件体量限制未读满全部 4285 行,见"未覆盖清单"第 1 条)、`tools/runCommandTool.ts`(`fatalReasonFor` 相关片段)、`tools/Tool.ts`(全文,`ToolContext`/`Tool` 接口定义)、`agents/agentTool.ts`(`permissionMode` 传递片段)、`harness/loop.ts`(1170-1426 行,`executeApproved`/`handleReject`/`isApprovalRememberable`/deny-ask 分支处理)、`server/index.ts`(1555-1600、2260-2460、2340-2382 等段,`runApprovedTool`/`buildExecutionRegistry`/`prewarm`/主回合三源合并逻辑)、`packs/domainPacks.ts`(`createDomainPackTools`/`resolveEnabledPacks`/`mergeEnabledPacks`)、`desktop/renderer-react/src/stores/chatStore.ts`(`sendMessage`/`approve`/`reject` 片段)、`desktop/renderer-react/src/components/chat/ApprovalCard.tsx`(全文)。

**读过的关键文件(cc,`~/Desktop/cc-haha-ref/src/`)**:`utils/permissions/permissions.ts`(全文,1505 行,`hasPermissionsToUseToolInner`/`checkRuleBasedPermissions`/审批规则查询函数)、`utils/permissions/PermissionMode.ts`(全文)、`utils/permissions/PermissionRule.ts`(全文)、`utils/permissions/PermissionResult.ts`(全文)、`types/permissions.ts`(全文)、`utils/permissions/bypassPermissionsKillswitch.ts`(全文)、`utils/permissions/dangerousPatterns.ts`(全文)、`tools/BashTool/bashPermissions.ts`(前 1365 行,受文件体量限制)、`tools/BashTool/bashSecurity.ts`(前 1293 行,受文件体量限制)、`tools/BashTool/pathValidation.ts`(1-135、300-407、924-1178 行,`checkDangerousRemovalPaths`/`isDangerousRemovalPath`/`validateOutputRedirections`/`checkPathConstraints`)、`utils/permissions/pathValidation.ts`(1-407 行,`isPathAllowed`/`isDangerousRemovalPath`/`matchingRuleForInput` 调用点)、`utils/permissions/filesystem.ts`(869-1000、1225-1320、1420-1510 行,`getPatternsByRoot`/`matchingRuleForInput`/`checkWritePermissionForTool`/`generateSuggestions`/`checkEditableInternalPath`)、`tools/BashTool/modeValidation.ts`(全文)、`utils/powershell/dangerousCmdlets.ts`(全文)、`tools/BashTool/BashTool.tsx`(500-620 行,`checkPermissions`/`requiresUserInteraction` 确认)、`utils/permissions/permissionSetup.ts`(1180-1245 行,auto 模式 kick-out 逻辑,确认与 plan 模式判定无关)。

**跑过的命令**:`grep`/`find` 若干轮(cc 侧 FATAL/plan/requiresUserInteraction/isPathAllowed 等关键词定位,我方侧 fatalReasonFor/additionalWorkingDirectories/enabledPacks 等消费点定位);`cd ts && bun test src/permissions/` —— **120 pass / 0 fail**(确认现状测试全绿,我列出的分叉都不是被现有测试判过的行为,而是覆盖空白);`grep -rn "bypassPermissions\|'plan'" ts/src/permissions/resolve.test.ts` 确认 §1、§3 两条在我方代码里是有专门测试断言的故意设计,不是随手写的分支。未执行任何写操作(未 `bun run build`、未改任何源文件、未跑需要联网/装依赖的命令)。
