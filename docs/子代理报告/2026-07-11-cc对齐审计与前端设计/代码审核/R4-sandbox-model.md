# R4 审核报告:沙箱三处联动 + Anthropic 模型流韧性

审核范围:ts/(工作树未提交改动,当前状态)。规格源 ~/Desktop/cc-haha-ref + node_modules/@anthropic-ai/sandbox-runtime@0.0.63 源码(dist/sandbox/*.js,非 .d.ts)。
方法:读代码 + 读 cc-haha 对应源码 + 读第三方库源码 + 构造真机 smoke/probe 脚本实测(非纯静态阅读)+ 跑既有测试/typecheck。

## 结论速览

- CONFIRMED(实锤,已复现):3 条,全部有可复现脚本
- PLAUSIBLE(疑点,未做穷尽验证):2 条
- 已验证正确(过审):见文末清单

---

## CONFIRMED #1 — Sandbox 跨工作区单例互相覆写(EPERM 误杀),P1 §7 修复的并发前提不成立

**位置**:`ts/src/sandbox/osSandbox.ts:54-64`(模块级 `let initialized = false` + `ensureInitialized`)、
`ts/src/sandbox/sandbox.ts:44-51`(`Sandbox.initialized` 是**per-instance**标记,不知道模块级单例已被别的实例改过)。

**问题**:`@anthropic-ai/sandbox-runtime` 的 `SandboxManager` 是进程级单例(module-scope `config` 变量)。
`osSandbox.ensureInitialized()` 用一个**模块级**(非 per-workspace)的 `initialized` flag 判断"要不要 initialize
还是 updateConfig"。生产代码每次顶层 `/agent/run` 请求都 `new Sandbox({workspace: buildSandbox(workspace)})`
(`server/index.ts:973,1958,2369`,每个 turn 全新实例,并行子代理/后台任务/定时任务同理各自新建、workspace 各不同)。
第一个工作区 A 的 Sandbox 首次调用 `wrapCommand()` 会 `SandboxManager.initialize(configA)`。第二个工作区 B 的
**任何一个新 Sandbox 实例**首次调用 `wrapCommand()` 时,因为模块级 `initialized` 已是 true,会走
`SandboxManager.updateConfig(configB)` 分支——**把进程级 allowWrite 整个覆写成只认 B 的 root**,A 后续任何未携带
`extraWritablePaths`(即没走 per-call customConfig 覆盖)的写入,会被 OS 沙箱当场 EPERM,即使写的是 A 自己的
workspace.root。

这条诊断直接命中审计验证点②(denyWrite/extraWritablePaths per-call 机制)的设计初衷——`sandbox.ts` 注释明确写
"避免并发多工作区 Sandbox 实例互相覆写彼此的 allowWrite",但**这个防护只覆盖了"同一个 Sandbox 实例多次调用、
extraWritablePaths 变化"这一种场景**,对"不同工作区的不同 Sandbox 实例分别首次调用 ensureInitialized"这个更常见
的场景完全没堵——本该堵的洞还开着,注释的自我认知与实现范围不一致。

**复现**(真机跑通,两次独立运行结果一致):
```
A 先跑一次命令(触发 ensureInitialized,全局 allowWrite=[rootA])→ A 写自己 root 成功
B 首次跑命令(触发 ensureInitialized,因为 initialized 已 true,走 updateConfig(configB),
              全局 allowWrite 被整个覆写成 [rootB])→ B 写自己 root 成功
A 再跑一次命令(A.initialized 已是 true 不再走 ensureInitialized,直接用【已被 B 覆写的】全局配置)
→ /bin/bash: .../probe-A-xxx/a2.txt: Operation not permitted  ← A 写自己的 root 都失败了
```
探测脚本:`/private/tmp/.../scratchpad/probe-concurrency-race.ts`(已跑,输出见上)。

**影响**:功能性回归(过度拦写、假阳性 EPERM),不是权限扩大类安全洞。触发条件在本项目现实可达——同一进程内多个
会话/子代理/后台任务/定时任务只要 workspace 不同、时间上有交叠,就可能互相踩。

**建议**:`ensureInitialized` 的判定不该是"进程是否已 initialize 过"而该是"当前这个 workspace 的配置是否已是
`SandboxManager` 当前生效配置"——比如缓存上次 `updateConfig` 用的 workspace root,不同 root 时也走
"重新 initialize"或至少接受"这是已知的多工作区共享单例场景、每次都无条件 updateConfig 到当前工作区"并接受
"进程内任一时刻只有一个工作区的沙箱配置生效"这条硬限制并写进文档——目前是两头不着:代码结构像是要支持并发多工作区,
实际单例语义只支持单工作区。

---

## CONFIRMED #2 — OS 沙箱层 denyWrite(P1 §8 修复)对 workspace.root 经 symlink 前缀时静默失效

**位置**:`ts/src/workspace/workspace.ts:27`(`this.root = resolve(root)`,从不 `realpathSync`)、
`ts/src/sandbox/osSandbox.ts:20-29`(`sandboxDenyWritePaths` 纯字符串 `join`)、
`ts/src/server/index.ts:664-675`(`workspaceFromBody`,`rawBody.working_dir` 直接喂给 `new Workspace()`,无 realpath)。

**问题**:macOS 的 `/tmp`、`/var`、`/etc` 全是指向 `/private/*` 的 symlink;`os.tmpdir()` 在 macOS 上返回的
`$TMPDIR` 也是 `/var/folders/...` 形式(即符号链接前缀)。生产代码路径上 `Workspace.root` 从不做
symlink 解析(只有基础 boundary 校验那条路径——`pathContainedInRoots`——会算 symlink,但那是"允许放行"判定,
不是 denyWrite 传给 OS 沙箱库时用的字符串)。用真实 workspace root 的**符号链接形式**(而非其 realpath)喂给
`sandboxDenyWritePaths()`/`buildRuntimeConfig()` 时,编译出的 macOS Seatbelt profile 里 `(deny file-write*
(subpath ".../.billiardbuddy/settings.json"))` 规则**不再拦住对该文件的实际写入**,尽管"工作区内写入放行 /
工作区外写入拒绝"这条粗粒度边界仍然正常工作(用同一 symlink 形式的字符串测过,粗边界不受影响,只有"deny 嵌套在
allow 内部"这条更精细的规则失效)。

**复现**(真机跑通,两次独立运行结果一致,root 换成 realpath 后行为翻转,对照干净):
```ts
// 原始(symlink 形式)root: /var/folders/kr/.../probe-symlink-xxx
// realpath: /private/var/folders/kr/.../probe-symlink-xxx (不同,证明真的过了一层 symlink)
写 <symlink-root>/.billiardbuddy/settings.json → 写入成功(PWNED 落地),denyWrite 未生效
```
```ts
// 同样步骤,root 换成 realpathSync(mkdtempSync(...)) → Operation not permitted,denyWrite 生效
```
探测脚本:`probe-symlink-denywrite.ts` / `probe-realpath-denywrite.ts`(对照组)/ `probe-symlink-basic.ts`
(证明粗边界不受影响,排除"整个沙箱在 symlink root 下失灵"的更严重假设)。

**关键**:官方 smoke 脚本(`scripts/smoke/sandbox.smoke.ts`)"8 场景全过"这个结论本身是真的(我复验过,见下文
"已验证正确"),但它能过是因为脚本**显式** `realpathSync(mkdtempSync(...))` 构造所有 root——这个用法本身没错,
但**掩盖了生产路径不会这样做**的事实(`workspaceFromBody` 直接吃 client 传来的 `working_dir` 字符串)。这是一个
"smoke 测试本身没造假,但测试条件系统性地比生产环境更干净"的假绿信号来源,值得单独标注。

**影响**:P1 §8(denyWrite 保护 `.billiardbuddy/settings.json`/`skills`)在 workspace root 落在任何系统临时目录
(或其它经 symlink 到达的路径)时**静默不生效**——不报错、不降级,只是悄悄不拦。触发条件现实可达:任何显式传
`working_dir` 指向 `/tmp` 或 `$TMPDIR` 下路径的调用方(测试脚手架、临时会话、未来可能的"快速草稿区"功能)都会中招。
默认工作区 `~/Documents/...` 本身不经过 symlink,常规主会话不受影响。

**建议**:`Workspace` 构造时对 `root` 做一次 `realpathSync`(存在才 realpath,不存在保留原样走 mkdir 逻辑),
或至少 `sandboxDenyWritePaths`/`buildRuntimeConfig` 入参前统一 realpath 一次。

---

## CONFIRMED #3 — AnthropicMessagesModel 的 error 帧判定用 `!== undefined`,与其自称对齐的 ProxyModel 路径语义不一致

**位置**:`ts/src/model/AnthropicMessagesModel.ts:391`(`rec.type === 'error' || rec.error !== undefined`)
对照 `ts/src/proxy/streamAccumulate.ts:108`(`(parsed as {error?:unknown}).error`,真值判断)。

**问题**:代码注释明确声称"两种都识别... 对齐 ProxyModel/streamAccumulate.ts 的 StreamProviderError 语义"
(AnthropicMessagesModel.ts:386-388),但两处判定条件语义不同——`streamAccumulate.ts` 用**真值**(falsy 的
`null`/`false`/`0`/`""` 都不触发),`AnthropicMessagesModel.ts` 用 **`!== undefined`**(`error: null` 也会触发)。
若某个"Anthropic 协议兼容"的 BYOK 供应商(本项目目标场景之一,MiniMax/MiMo 等国产厂商的 `/v1/messages` 兼容端点)
在正常事件里带一个占位 `"error": null` 字段(常见 JSON API 惯例),会被误判成 provider 错误,整段流被
`StreamProviderError` 中止——ProxyModel 那条 OpenAI-chat 路径遇到同款占位字段不会误判。

**复现**(`bun test` 跑通,单测已写清楚断言):
```
构造一个正常 SSE 流,每个事件都带 "error": null(如 {"type":"content_block_start",...,"error":null})
→ 实际抛出:StreamProviderError({"type":"content_block_start",...,"error":null})
→ 期望(对齐 ProxyModel 语义):不应该抛错,应正常累积完成
```
探测脚本:`probe-error-null.test.ts`(bun test 直接跑失败,失败信息即是确证)。

**影响**:P2 级——只在特定供应商这个具体 JSON 形状下触发,当前已知主力供应商(文档列出的 MiMo/豆包/DeepSeek/
GLM/Kimi/MiniMax)是否真的会发 `error: null` 未逐一验证(未做外呼真实供应商测试,超出本次只读审核范围),
但代码逻辑本身的判定条件确实与其自称对齐的目标不一致,是可独立验证、可独立修的小缺陷。

**建议**:改成 `rec.error` 真值判断(与 streamAccumulate.ts 一致),或至少注释去掉"对齐"措辞、如实写清两处语义
不同的理由(如果是有意为之的话——但从代码读不出任何"有意从紧"的意图痕迹,看起来是无意识的实现差异)。

---

## PLAUSIBLE(未升级为 CONFIRMED,原因写在各条里)

**P-1 · 额外工作目录内嵌套的 `.billiardbuddy/settings.json` 不受 denyWrite 保护**——已验证确实不保护(探测脚本
`probe-nested-settings.ts` 真机复现:额外目录里预先建好 `.billiardbuddy/settings.json`,通过 `extraWritablePaths`
放行该目录后,里面这份 settings.json 可以被覆写)。**不升级为 CONFIRMED 缺陷**,因为核对了 cc-haha 的
`sandbox-adapter.ts:290-299` 源码——cc 自己对 `additionalDirectories` 也只塞进 `allowWrite`,从不为每个额外目录
派生对应的 denyWrite(cc 的 denyWrite 只覆盖 `cwd`/`originalCwd` 两处),即这不是"抄漏了",是与 cc 现状完全对齐的
既有局限,不该算这批修复的回归。仅作记录,供以后如果真出现"额外目录本身就是另一个 billiardbuddy 项目"的用例时参考。

**P-2 · worktree/subagent 切换 `ctx.workspace` 时,`ctx.sandbox`(按引用绑定旧 Workspace)可能不同步**——
`worktreeTools.ts:60` 等处 `ctx.workspace = new Workspace(session.worktreePath)`(不带 `fullDiskAccess`,新实例
默认 false),但没看到对应地方重建 `ctx.sandbox`;`Sandbox.workspace` 是构造时绑定的引用。若这个假设成立,
worktree 会话中 `Sandbox.isOsSandboxActive()`/`wrapCommand()` 用的仍是旧 workspace 的 root/fullDiskAccess,
不是新 worktree 的。**未验证**(没有写复现脚本、没有确认 sandbox 字段是否在 worktree 入口处另有别的地方被重建),
超出本次指定审核文件范围(worktreeTools.ts/agentTool.ts 不在 A 组文件清单内),按疑点记录,建议下一轮针对性复核。

---

## 已验证正确(过审)清单

1. **fullDiskAccess 单点闸的宽窄程度合理**:`buildRuntimeConfig` 恒定 `allowRead:[]/denyRead:[]`(读永远不设限)
   + `askCallback` 恒 `async()=>true`(网络永远不设限,见 osSandbox.ts:61-62,W3/W4 已知姿态非本轮范围)——OS 沙箱
   当前实际只提供"写围栏"这一层保护,`isOsSandboxActive()` 对 fullDiskAccess 会话整体判 false,失去的就只是这层写
   围栏,与 `Workspace.resolve()` 对同一批会话本来就在 app 层放行写入完全一致,不存在"OS 层比 app 层更松"的新增
   暴露面。判断合理,非过宽。
2. **fullDiskAccess 不会误判**:`rawBody.full_disk_access === true || rawBody.fullDiskAccess === true`
   (server/index.ts:673)与 `opts.fullDiskAccess === true`(workspace.ts:29)都是严格布尔全等,任何非
   `true` 的传入值(字符串 "true"、1、undefined)一律落空判 false——失败方向是"更严格"而非"更松",没有误开风险。
   全仓 `new Workspace(` 调用点核对一遍(worktreeTools.ts/taskTools.ts/agentTool.ts/server/index.ts 等),
   除 `workspaceFromBody` 外均未传 `fullDiskAccess`,默认 false,不会意外继承。
3. **extraWritablePaths 与 denyWrite 不冲突**:读了 `sandbox-manager.js:890-897` 确认库的 `customConfig` 语义
   是**整体替换**(`??`)而非 merge/union——我们每次构造 per-call customConfig 时都完整重新算一遍
   `sandboxDenyWritePaths(this.workspace.root)`,不依赖 session 级配置残留,所以不会出现"加了 extraWritablePaths
   之后 denyWrite 意外消失"的问题(smoke 场景 3/4 组合验证、真机复验通过)。
4. **smoke:sandbox 8 场景真机复验全过**(`bun run smoke:sandbox`,macOS 真机,原样跑官方脚本,未改动):
   工作区内写入成功 / 工作区外写入被拒 / fullDiskAccess 会话沙箱不激活 / fullDiskAccess 会话可写工作区外 /
   授权额外目录写入放行 / 未授权额外目录仍被拒 / denyWrite 拦 settings.json / denyWrite 不误伤普通文件——8/8 通过。
5. **denyWrite �covers hooks 配置**:hooks 配置字段就活在 `.billiardbuddy/settings.json`/`settings.local.json`
   内部(hookConfig.ts:787-801),已被 denyWrite 覆盖,不存在"单独一份 hooks 文件没保护"的缺口。
6. **`.billiardbuddy/commands`/`agents` 未列入 denyWrite 目前是死缺口非活缺口**:核对
   `agentLoader.ts:99` 注释("当前生产只从 app 目录加载...若日后接入工作区 .claude/agents")+
   `server/index.ts:447-451`(`workspaceCommandRoots` 只读 `.claude/commands`/`.codex/commands`,不读
   `.billiardbuddy/commands`)——这两个目录当前都不是生产环境会真实加载的路径,denyWrite 没覆盖它们不构成现实
   暴露面(而 `.claude/commands`/`.claude/agents` 这两个真会被读的兼容路径,恰好被库自带的
   `getDangerousDirectories()`——sandbox-utils.js:34-35——硬编码保护住了,虽然保护的理由是巧合不是设计)。
7. **Group B 慢而不死的流不会被误杀**:真机跑 `withStreamIdleTimeout` 探测(每 50ms 一个 chunk、idle 超时 80ms、
   总耗时 260ms)——每个 chunk 都会 `arm()` 重置计时器,总耗时远超超时阈值但流正常收尾,未被误杀。
   `probe-slow-alive-stream.ts` 已跑通。
8. **error 帧判定不会误伤正文含 "error" 字样的正常文本**:判定逻辑是结构化的(顶层 `type`/`error` 字段),不是
   对 raw text 做子串匹配,`content_block_delta` 里 `delta.text` 即使包含字面 "error" 也不会命中这两个条件
   (读代码 + 现有测试 `AnthropicMessagesModel.test.ts` 用真实文案验证过)。
9. **超时后资源清理**:`withStreamIdleTimeout` 超时分支 `reader?.cancel()` + `controller.error()`,`finally` 里
   `reader.releaseLock()`(在 `accumulateAnthropicStream` 侧),路径与既有 `ProxyModel` 完全复用同一个工具函数,
   非本轮新写代码,行为与既有生产路径一致。
10. **测试是真链路,非戏台**:`AnthropicMessagesModel.test.ts` 新增用例全部构造真实 `Response` + 真实
    `ReadableStream` SSE body,走 `model.step()` 完整公开入口(经 `readResponse`→`withStreamIdleTimeout`→
    `accumulateAnthropicStream` 完整链路),不是对内部函数做浅层 mock。
11. **modelFactory 接线正确**:`resolveModelTimeouts` 算出的 `idleTimeoutMs` 正确同时喂给 `ProxyModel` 与
    `AnthropicMessagesModel` 两个分支构造参数(modelFactory.ts:38,对照修复前只喂 ProxyModel 一支)。
12. **[DONE] 之后的迟到 error 帧不会被吞**:`processLine` 对 `[DONE]` 只是 `return` 跳过该行,不 break 外层读循环,
    后续任何行(包括迟到的 error 帧)仍会被正常处理/识别,不存在"看到 DONE 就提前收工漏掉后面错误"的问题
    (读代码确认,`[DONE]` 本身也不是真实 Anthropic 协议会发的东西,只是防御性兼容)。

## 测试与 typecheck

```
bun test src/model/ src/sandbox/ src/workspace/ src/tools/runCommandTool.test.ts src/tools/backgroundCommandTool.test.ts
→ 194 pass / 0 fail / 1324 expect() calls

bun run smoke:sandbox → 8/8 通过(真机)
bun run typecheck → 通过(tsc --noEmit + desktop renderer tsconfig 均无报错)
```

## 探测脚本清单(均在 scratchpad 下,只读验证、未改动源码)

- probe-nested-settings.ts — 额外目录嵌套 settings.json 不受保护(P-1)
- probe-concurrency-race.ts — 跨工作区 Sandbox 单例互相覆写(CONFIRMED #1)
- probe-symlink-denywrite.ts / probe-realpath-denywrite.ts / probe-symlink-basic.ts — symlink root 下
  denyWrite 失效对照组(CONFIRMED #2)
- probe-slow-alive-stream.ts — 慢而不死流不误杀(已验证正确 #7)
- probe-error-null.test.ts — error:null 占位字段误判(CONFIRMED #3)
- dump-profile.ts — 直接调库内部 `wrapCommandWithSandboxMacOS` 打印编译后的 Seatbelt profile 文本,
  用于定位 CONFIRMED #2 的具体规则文本证据
