---
name: billiardbuddy-backend-e2e
description: 给「球房管家」后端(ts/ 架构:Bun/TS sidecar + ReAct 主循环 + 文件式存储)做**端到端后端测试**——不碰前端 UI,程序化起真 sidecar,喂真实用户输入,观察大模型在 ReAct 循环里怎么走(调哪些工具/什么路径/transcript 留什么/最终结果),断言到"工具调用链 + 落盘副作用 + 权限档 + 领域包 + 白标"。两种模型模式:脚本模型(fetchImpl 注入固定 SSE,确定性、可 CI,主力)/ 真模型(真调 mimo 走大陆网关,看真实决策走位,冒烟)。当要测后端全链路、验证某个用户输入大模型会怎么处理、复现/定位后端行为、或在 UI e2e 之前先把后端跑通时使用。配套驱动:run.ts。
---

# 球房管家 · 后端端到端测试(不碰前端 · 观察大模型在 ReAct 循环里怎么走)

> ⚠️ 开发期测试 skill(测我们自己的后端),不进产品分发;内容写真实端口/路径没问题。
> 与 `billiardbuddy-desktop-e2e`(UI e2e,带 Electron+React,慢)分工不同:本 skill **只打后端 sidecar API**,无前端、无浏览器,快得多。

## 三层测试金字塔里的位置(先想清楚再动手)

| 层 | 测什么 | 工具 | 速度/数量 |
|---|---|---|---|
| 底层 · 单测 | 函数/模块(权限判定、路径校验、压缩、命令分类…) | `bun test`(已有 1706 个) | 快、多、进 CI |
| **中层 · 后端 e2e(本 skill)** | **起真 sidecar,喂用户输入,看大模型 ReAct 走位 + 工具链 + 落盘 + 权限 + 领域包 + 白标** | `run.ts`(程序化 startServer + fetchImpl / 真模型) | 中、少而关键 |
| 顶层 · UI e2e | Electron+React 真机点,前端渲染 + 主进程 | `billiardbuddy-desktop-e2e` | 慢、极少、只覆关键路径 |

**owner 口径:先把中层(后端 e2e)做全、做稳,再上顶层(UI e2e)——UI e2e 每轮太慢,不该当主力。**

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
- 运行时 = **Bun**(startServer 用 Bun.serve/bun:sqlite),驱动必须 `bun run`,不能 node。
