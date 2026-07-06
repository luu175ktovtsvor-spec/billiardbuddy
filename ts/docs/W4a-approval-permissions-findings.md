# W4a · 审批与权限 findings（2026-07-06 · macOS arm64 · Bun 1.3.14）

> 审批闸 + 权限三档(+plan 判定) + 跨会话拒绝跟踪 + HMAC 签名 + 白标 anti-reveal——照 cc-haha 权限瀑布**结构**、按我们产品**红线口径**重写(reimplement,不搬源码)。
> 全量 `bun test` = **110 pass / 0 fail / 219 expect / 19 files**;`tsc --noEmit` = exit 0;**无新第三方依赖**(纯 `node:crypto`)。
> 9 commits `5626f01..262a419`(6 feat + 3 review-fix，末条为 Opus 终审收口)。分步计划:`docs/plans/TS-W4a-审批权限-实现计划-2026-07-06.md`(7 任务 · subagent-driven · 每任务独立子代理评审)。**W4 拆 5 子窗全景 + W4b–W4e 研究底稿**:`docs/plans/TS-W4-拆窗与研究底稿-2026-07-06.md`。

## 建了什么（新增/改动文件）
| 层 | 文件 | 职责 |
|---|---|---|
| 类型 leaf | `src/permissions/types.ts`(新) | `PermissionMode`(4 档)/`PermissionBehavior`/`ApprovalClass`/`DecisionReason`/`ApprovalReason`/`PermissionDecision`(allow/ask/deny 三态)。零 import |
| 序列化 leaf | `src/permissions/canonical.ts`(新) | `stableStringify`(递归键序排序 + 紧凑)——`actionKey` 与 HMAC 规范化**单一真相源** |
| 瀑布 | `src/permissions/resolve.ts`(新) | `resolvePermission(tool,input,ctx)`(**同步**)+ `AUTO_SPEND_LIMIT=3` + 三文案常量(`APPROVAL_PENDING_MSG`/`PLAN_SKIP_MSG`/`DENIAL_FALLBACK_MSG`) |
| 拒绝跟踪 | `src/permissions/denialTracking.ts`(新) | 跨会话 `Map`(cap 500)+ `actionKey`/`recordDenial`/`clearDenial`/`shouldStopAsking`/`resetDenialStore` + `DENIAL_FALLBACK={perAction:2,global:20}` |
| 签名 | `src/permissions/approval.ts`(新) | `signApproval`/`verifyApproval`(HMAC-SHA256,照 `approval.py` 1:1,畸形 token 归校验失败不抛) |
| 提示 | `src/harness/prompts.ts`(新) | `buildAntiReveal(productName?)` + `ACTIONS_SECTION` + `DENIAL_RULE` |
| 接线 | `src/tools/Tool.ts`(改) | `Tool` 加 8 个可选权限字段(`requiresApproval`/`approvalClass`/`forceConfirm`/`requiresApprovalFor`/`fatalReasonFor`/`safePrefixFor`/`previewFor`/`approvalReasonFor`);`ToolContext` 加 `permissionMode?`/`conversationId?`/`autoSpendCount?` |
| 接线 | `src/types/events.ts`(改) | `AgentEvent` 加 `approval_request` 变体(tool/args/id/token/preview?/reason?) |
| 接线 | `src/harness/loop.ts`(改) | 工具执行前插 `gateOneCall`(deny/ask/allow 三分支,提案模式)+ 导出 `executeApproved`/`handleReject`;`RunAgentLoopOptions` 加 `permissionMode?`/`conversationId?` |
| 提示 | `src/harness/systemPrompt.ts`(改) | 装配加 anti-reveal + actions + denial-rule(`<env>`/git 保留) |

## 关键决策（记给后窗,别重新纠结）
1. **Delta A：本机文件读写默认直接放行**(比 CC 的 acceptEdits 更宽)——无权限字段的工具在**任何档**(含 ask)都 `allow`,靠 W2 改前备份兜底,不弹卡。`resolvePermission` 里 `!needsApproval → allow` 在 autoApprove 之前短路。
2. **Delta B：`forceConfirm` 旁路免疫**——在任何 mode 分支之前判,连 `full`(跳过确认)也强制弹卡。删数据这类真危险动作设它。`full` 档 spend 类还有 `AUTO_SPEND_LIMIT=3` 计数闸(防一次 bug 循环烧钱)。
3. **提案模式(非 cc-haha 阻塞对话框)**:我们是 SSE 客户端/服务器,循环撞 `ask` → 吐 `approval_request`(HMAC token + preview + reason)+ 回灌「待确认」文案 → **继续、不阻塞、不执行**;真执行走独立入口 `executeApproved`(验 token → clearDenial → 跑)。`handleReject` 记一次拒绝。**HTTP `/execute`·`/reject` 端点没建**(给了纯函数,壳交真服务器/前端窗)。
4. **拒绝语义与 cc-haha 相反**:拒同一动作 **2 次**(或全局 **20 次**)→ `shouldStopAsking` 让循环回灌「先不做了」、**停止再弹卡**(cc-haha 是"回退去问人");`clearDenial` 成功确认后**同时清 byAction[key] 和 total=0**(否则长会话零散攒够 20 会永久吞审批)。全模块故障安全。
5. **anti-reveal 措辞绝不写 `gpt`/`claude` 字面**:W2 白标测试断言整段 prompt `.toLowerCase()` 不含这俩字;anti-reveal 写成"不报任何模型名/不认领任何第三方 AI 身份",**不点名反而更对**。`prompts.ts` 文件头注释里的引用词是 inert(不入 prompt)。
6. **`canonical.stableStringify` 单一真相源**(pre-flight 修正):计划原让 Task3 内联一份 stableStringify(重复逻辑块=评审会挑),开工前抽成 `canonical.ts` leaf,`denialTracking` 与 `approval` 都 import 它、无重复。
7. **`SECRET_KEY` 缺省空串**:`signApproval`/`verifyApproval` 默认 `process.env.SECRET_KEY ?? ''`(照 Python `settings.secret_key or ""` 宽松兜底);**W5 接真 config 后收紧**。
8. **现有工具无一 `requiresApproval`**:`read_file`/`write_file`/`list_dir`/`run_command` 都本机可逆(命令有 W3 沙箱 + 危险命令红线兜底)→ 全走 allow。审批/拒绝/plan 路径靠**测试 fixture 工具**验证;**第一个真需审批的工具 = 生图(W8)**。

## W4a 明确没做（留后窗,别以为漏了）
- **oob 越界写 → 审批卡**:现 W2/W3 是**硬抛错**(WorkspaceBoundaryError);`oob→卡` + `full_disk_access` 放开是文件工具 + full-disk 概念的事,后置。W4a 用 `requiresApprovalFor` 留了接口。
- **plan 模式的 enter/exit 工具 + plan 文件专属可写 + plan 指令注入 + todo** → **W4b**(定向脚手架)。本窗只做了「plan 档非只读工具 → deny(planSkip)」的**权限判定**(在 `resolve.ts`)。
- **`/agent/execute`·`/agent/reject` HTTP 端点** → 真服务器/前端窗(本窗给了 `executeApproved`/`handleReject` 纯函数 + `signApproval` 供其调用)。
- **完整危险命令分类器(可逆性·爆炸半径) + `shouldUseSandbox` 逐命令决策 + OS 沙箱默认开 + 网络围栏** → 「**sandbox 尾巴**」(W3 findings 交给 W4 的、不在 W4a–e 五窗内,见拆窗底稿 §5,owner 定当独立小窗 W3c 或并进某窗)。W3 的 `dangerousCommand` 仍是最小红线种子。

## 坑 / 注意
- **type-only 测试的 RED 信号**:`tsconfig` 有 `verbatimModuleSyntax: true`,`import type { X } from './m'` 编译期完全擦除,故 type-only 测试文件在 `./m` 尚不存在时 **`bun test` 仍过**(Bun 不解析被擦除的 import);真 RED 要看 `tsc --noEmit`(复现 `TS2307: Cannot find module`)。W4a Task1 踩过,后续 type-only 任务同理。
- **`stableStringify` 静默把非 plain 对象(Date/Map/Set/类实例)压成 `"{}"`**:JSON args 无害(工具 args 恒 JSON-parsed),但若将来对 exotic 值签 HMAC 有(极低)完整性隐患;威胁模型低,记录待终审。
- **`actionKey`/`previewFor` 的 fail-safe 是评审补的**(见下):确定性红线路径上的工具作者代码(序列化/算 diff)都要包 try/catch,别让它穿出生成器崩循环。
- 审批路径**没有真工具可端到端验**(现有工具全 allow),全靠 fixture 工具(`outreachTool` 等)驱动;`full` 档 `autoSpendCount` 三振跨阈只在 `resolvePermission` 层单测、无 loop 级端到端测试。
- `denialTracking` store 是**进程内模块级全局**,测试靠 `resetDenialStore()` + `afterEach` 隔离。

## 评审逮到并修的 2 个真 bug（范例,均"确定性红线路径的 fail-safe 缺口")
- **Task3**:`actionKey` 无 try/catch,`stableStringify` 遇循环引用(递归栈溢出)/BigInt(TypeError)会抛、直穿 Task5 审批闸(违模块自称的「全故障安全」)→ 修:包 try/catch 返稳定回退 `${name}:<unserializable>`(刻意不用 `${name}:{}` 避免撞空参键)+ 补循环对象测试。commit `3f1c80c`。
- **Task5**:`gateOneCall` 的 ask 分支 `await tool.previewFor?.(...)` 无 try/catch,工具算 diff 读文件抛(ENOENT/EACCES)会穿出 async 生成器崩 `runAgentLoop`(违本文件「工具执行永不抛」红线,W8 生图会实现 previewFor)→ 修:包 try/catch 退化 `preview=undefined` + 补崩溃安全测试。commit `92d8c2a`。
- **终审(Opus 最终全分支 review)**:reproduced 出 gate 路还有 **5 处未护**——`resolve.ts` 的 4 个工具钩子(`fatalReasonFor`/`requiresApprovalFor`/`safePrefixFor`/`approvalReasonFor`)+ `loop.ts` 的 `signApproval` 铸币(同 `actionKey` 的 `stableStringify` 抛法,当初只护了 `actionKey`)→ 修:`resolvePermission` 包一层 try/catch **失败关闭到 `ask`(绝不静默放行 allow)**、`signApproval` 对不可序列化 args 稳定回退不抛(verify 走同一条故一致)+ 补钩子抛/循环 args/64-CJK 三测。commit `262a419`。顺手补 T4 的 UTF-16/UTF-8 撞车回归测试。
> 教训:确定性红线/循环路径上,凡调用**工具作者提供的可选钩子**(previewFor/requiresApprovalFor/fatalReasonFor/safePrefixFor/approvalReasonFor)或**可能抛的序列化**(signApproval/actionKey),都要 fail-safe,别信它不抛;**失败方向 = 关闭到问人,绝不静默放行**。同一个 bug 类(gate 路 fail-safe 缺口)前后修了 3 次(actionKey / previewFor / 终审的 5 处),值得 W4b–e 一上来就把工具钩子调用统一包好。

## 给 W4b（定向脚手架)的硬交接
- **地基已就位**:`ToolContext` 已有 `permissionMode`;`AgentEvent` 已加 `approval_request`(W4b 再加 `steering`/`todo_update`/`context_note`)。
- **plan 判定已在 `resolve.ts`**(plan 档非只读 → deny planSkip);W4b 在其上建 plan 的 enter/exit 工具、plan 文件专属可写、plan 指令 system-reminder 注入、todo。
- **循环要从 `for` 改 `while`(可变 turnsLimit)** 以支持 steering 续命(见底稿 §1)。现 `loop.ts` 的 `gateOneCall` async-generator + `feedback` 闭包结构别打散,steering 的 drain 点在「每 batch 后 + finalize 边界」。
- **W4b/W4c 都会改 `loop.ts`,务必串行、每窗跑全量回归**(W4a 已把 loop 的 allow 路保持与 W2/W3 字节等价,别破)。

## Minor findings 累积（交最终 review / W15 终审分诊）
完整清单见 `.superpowers/sdd/progress.md`(gitignored 台账)「Minor findings 累积」节。要点:
- [Task1] `PermissionBehavior` 导出未用(若权限引擎不消费即 dead code);`approval_request.reason` 结构复制 `ApprovalReason`(events.ts 刻意无 import)。
- [Task2] `reason:{type:'mode'}` 复用于两语义;文案常量无字面内容断言;测试临时目录不清理(继承 W2/W3)。
- [Task4] **建议纳入**:补 UTF-16/UTF-8 长度撞车用例锁死 verifyApproval never-throws(`expect(verifyApproval('publish',{},'中'.repeat(64),SECRET)).toBe(false)`);`args ?? {}` vs Python `args or {}`。
- [Task5] ask 分支重算 `APPROVAL_PENDING_MSG` 而非复用 `decision.message`;两处 catch 错误前缀不一致;test 动态 import;无 loop 级 autoSpendCount 端到端测试。
- [Task6] 文件头注释含引用词(inert);`toContain('模型')` 弱断言(plan-mandated)。

## 复跑
```bash
cd ts && export PATH="$HOME/.bun/bin:$PATH"
bun test          # 110 pass / 0 fail / 19 files
bun run typecheck # exit 0
```
