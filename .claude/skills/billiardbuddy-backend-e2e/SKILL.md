---
name: billiardbuddy-backend-e2e
description: 对球房管家 Bun/TS sidecar 做后端端到端测试，验证 ReAct 工具链、事件流、落盘、权限、领域包和白标。需要先跑通后端全链路、复现跨层后端行为或为 UI E2E 提供后端证据时使用；默认脚本模型，真模型仅作手动冒烟。配套驱动 run.ts。
---

# 球房管家 · 后端端到端测试(不碰前端 · 观察大模型在 ReAct 循环里怎么走)

> ⚠️ 开发期测试 skill(测我们自己的后端),不进产品分发;内容写真实端口/路径没问题。
> 与 `billiardbuddy-desktop-e2e`(UI e2e,带 Electron+React,慢)分工不同:本 skill **只打后端 sidecar API**,无前端、无浏览器,快得多。
> 先读取 `.claude/skills/模块化开发总路由/SKILL.md`，只运行改动说明中受影响的检查点；新增契约时同时覆盖生产者和消费者。

## 三层测试金字塔里的位置(先想清楚再动手)

| 层 | 测什么 | 工具 | 速度/数量 |
|---|---|---|---|
| 底层 · 单测 | 函数/模块(权限判定、路径校验、压缩、命令分类…) | `bun test` | 快、多、进 CI |
| **中层 · 后端 e2e(本 skill)** | **起真 sidecar,喂用户输入,看大模型 ReAct 走位 + 工具链 + 落盘 + 权限 + 领域包 + 白标** | `run.ts`(程序化 startServer + fetchImpl / 真模型) | 中、少而关键 |
| 顶层 · UI e2e | Electron+React 真机点,前端渲染 + 主进程 | `billiardbuddy-desktop-e2e` | 慢、极少、只覆关键路径 |

先把中层后端 E2E 做稳，再用少量顶层 UI E2E 覆盖关键用户路径；UI E2E 每轮较慢，不当普通回归主力。

## 为什么"看大模型怎么走"而不只是断言返回值

后端的核心是 **ReAct 主循环**(`ts/src/harness/loop.ts`:think→挑工具→过权限闸→执行→回灌→再 think)。一个用户输入进来,大模型可能:调 0 个工具直接答、调 N 个工具串起来、触发审批卡、挂领域包工具、走压缩……**单测测不到这条"活的路径",本 skill 就是把它端到端跑出来、看清楚、断言对**。观察的是"给这句话,大模型在后端实际走了哪条路 + 落了什么 + 结果对不对",不是某个函数的返回。

## 两种模型模式(结合项目形态的核心决策)

后端出口 = `ProxyModel`(OpenAI 兼容,对接国产 mimo)→ 大陆网关 qfgw。所以模型响应从 `fetchImpl`(HTTP 出网)进来。据此两种模式:

### ① 脚本模型(scripted · 默认 · 回归主力 · 可 CI)
`startServer({ fetchImpl })` 注入一个**按后端第 N 次调模型返回第 N 个预定 SSE** 的 fetchImpl,确定性模拟"大模型这样决策":
- 第 1 次返回 `delta.tool_calls`(模型调工具)+ `finish_reason:'tool_calls'` → 后端过权限闸、执行工具、回灌;
- 第 2 次返回 `delta.content` + `finish_reason:'stop'`(final)。
用于精确验证:**给定模型这样走,后端的循环/权限/工具/存储/领域包/压缩/白标是否都对**。快、确定、可断言、无网络无 key 无花钱。

### ② 真模型(live · 冒烟 · 手动 · 不进 CI)
不传 fetchImpl、给真 env(真 key)→ 真调 mimo 走大陆网关,喂真实用户输入,观察大模型**真实决策走位**(它到底调不调 billiards 工具、怎么理解"帮我想个活动方案")。慢、非确定、依赖网络/key。只跑少量关键场景,验"真链路能跑 + 大模型真会这么走"。
> ⚠️ 后端返 200/"成功" ≠ 走对了模型。白标下要核**日志里那条实际出网 URL**(`ark.cn-beijing`=豆包 / mimo 网关)+ transcript 里 usage/model,别只看成没成。

## 前端等价测试(不起壳子,做到"像真起壳子一样"的效果)

**核心认知:前端有两类职责,只有一类非起壳子不可。**
- **① 视觉渲染**(chip 长啥样、审批卡布局、颜色、动画、DOM 像素)——**只有起壳子/React 才测得了**,是 UI e2e 唯一不可替代的领地。
- **② 状态-参数翻译**(把"用户操作"翻成"后端请求参数",把"后端事件"翻成"UI 状态")——**纯逻辑,不需要壳子**。

**关键:前端对后端的全部影响 = 一组请求参数 + 一串后续消息(approve/reject/steer)。** 用户"点击/选目录/切会话/挑权限档/敲大白话/看到审批卡点允许",最后全归结为发给后端的 `{message, working_dir, conversationId, permissionMode, enabled_packs}` + 一条 `approve`。**把这些等价构造出来打后端,就 = 前端操作过了**——无需 DOM/Electron。

驱动里用 **`UserSession`** 抽象把这些等价出来(一个 UserSession = 一个前端窗口):
| 前端操作 | UserSession 等价 |
|---|---|
| 选工作目录(点"选目录") | `.selectFolder(dir)` |
| 挂/关领域包(设置开关 or /台球) | `.enablePack('billiards')` / `.disablePack('billiards')` |
| 切权限档(default/接受修改/完全访问) | `.setPermission('default')` |
| 敲一句大白话回车 | `.say('帮我建个报表', model)` |
| 看到审批卡点"允许" | `.approve()` |
| 多窗口并行 | 多个 UserSession(不同 convId,各带各的目录/挂件/权限,天然不串台) |

**真实项目目录**:综合场景用你桌面真实的"测试台球运营管家"等文件夹当 working_dir(= 模拟前端的项目文件夹),验证文件真落进对的文件夹、不串台。缺文件夹则跳过并提示。

样板检查点 `frontend-like-multi-session` 就是这样跑的:窗口A(选文件夹1+挂台球+default档→建报表→弹审批→点允许→落盘文件夹1)、窗口B(选文件夹2+不挂+完全访问档→列目录→不弹审批直执行),断言文件各落各夹不串台、审批档行为对、域上下文注入对、双会话 transcript 各分区——**全程不起壳子,覆盖上面 6 类前端操作**。

**诚实边界**:这套测不了"审批卡长啥样、chip 什么颜色、动画顺不顺"——那些像素级视觉必须起壳子(UI e2e)。但"选目录/多会话/三权限/大白话输入/输出文件夹/点审批"这些**行为**,全能不起壳子模拟。

## 观察维度(每个检查点结合项目形态查这些)

| 维度 | 从哪看 | 关注点 |
|---|---|---|
| 大模型走的路径 | SSE 事件流(`event: <type>`) | thinking / tool_call / tool_result / approval_request / final —— 调了几个工具、串成什么链 |
| 工具调用+参数+结果 | transcript JSONL | `<transcriptRoot>/projects/<slug>/<id>.jsonl`:tool_use 块的 name/input、tool_result、最终 assistant text |
| 落盘副作用 | 真文件系统 | write_file 文件真落在 working_dir、命令真跑、job 真起 |
| 权限档行为 | 事件流 + 落盘 | default 弹 approval_request、bypass 放行、plan 只读拦(危险命令 default 弹卡不静默执行) |
| 领域包挂载 | 请求带 `enabled_packs:['billiards']` | 系统提示含 `<domain_context id="billiards">`、billiards_ops_checklist 工具在 registry、命令 /billiards:* 进清单 |
| 白标出口 | final 文本 + 事件 | 真实模型名(mimo/豆包)不泄漏到用户可见输出 |
| 会话隔离/存储 | transcript 分区 + session meta | 不同 conversationId 各分区、meta 记各自 workspaceRoot/enabledPacks |

## Quick start

```bash
cd ts
bun run ../.claude/skills/billiardbuddy-backend-e2e/run.ts            # 脚本模型(默认,快,确定)
QF_E2E_LIVE=1 bun run ../.claude/skills/billiardbuddy-backend-e2e/run.ts   # 真模型冒烟(需真 env/key,慢)
```
产出在 `ts/test-results/backend-e2e/`:
- `manifest.json` —— 每检查点:期望 + 事件流摘要 + transcript 工具链 + 落盘检查 + 归因(后端做对没)
- 控制台逐检查点打印 `[归因] name: 走位=... 工具链=... 结果=...`

## 怎么加检查点(以后往这里补)

每个检查点 = `{ name, expectation, model, run(ctx) }` 塞进 `run.ts` 的 `CHECKPOINTS`:
- `model`:脚本模型的分步响应 `[{ toolCalls:[{id,name,input}] }, { text:'final' }]`(live 模式忽略,用真模型)。
- `run(ctx)` 里:① `ctx.runTurn({message, working_dir, permissionMode, enabled_packs})` 发用户输入、收 SSE 事件;② `ctx.transcript(convId)` 读工具链;③ 检查落盘;④ return `{ ok, note }`,driver 写 manifest + 归因。

**建议补的第一批**(覆盖项目形态的要害):
1. 通用文件写:喂"在当前文件夹建 X",脚本模型调 write_file → 断言事件流有 tool_call(write_file) + 文件真落盘 + transcript 记录。
2. 权限档:default 档喂危险命令、脚本模型调 run_command('rm -rf /') → 断言弹 approval_request、命令没执行、没落盘。
3. 领域包:`enabled_packs:['billiards']` 喂"想个活动方案" → 断言系统提示含 domain_context + billiards 工具可用 + 出口无模型名。
4. 会话隔离:两个 conversationId 各发 → transcript 按 slug 分区、meta 各记各的。
5. live 冒烟:真模型喂"列出当前目录文件" → 看它真调 list_dir、真实出网 URL 对。

现在骨架里放了 `general-file-write` + `billiards-pack-mount` 两个样板检查点。

## 死参数(结合项目形态,写死不猜)
- 起法:`import { startServer } from '<repo>/ts/src/server/index'`;`startServer({ port:0, transcriptRoot, fetchImpl?, env? })`(port:0=OS 随机口)。
- 打:`POST http://127.0.0.1:<port>/agent/run`,body `{ message, conversationId?, working_dir?, permissionMode?, enabled_packs?, knowledge_packs? }`,响应 `text/event-stream`。
- SSE 格式:`event: <type>\ndata: <json>\n\n`(type=thinking/tool_call/tool_result/approval_request/context_note/final/done…)。
- transcript:`<transcriptRoot>/projects/<workspaceRoot slug>/<conversationId>.jsonl`;读用 `SessionService(transcriptRoot).loadTranscript(id)`。
- 假模型 SSE:OpenAI chat.completions 流式——`data: {choices:[{delta:{tool_calls:[{index,id,function:{name,arguments}}]},finish_reason:'tool_calls'}]}` 然后 `data: {choices:[{delta:{content:'…'},finish_reason:'stop'}]}` 然后 `data: [DONE]`。
- 运行时 = **Bun**（`startServer` 使用 `Bun.serve`），驱动必须 `bun run`，不能用 Node 代跑。
