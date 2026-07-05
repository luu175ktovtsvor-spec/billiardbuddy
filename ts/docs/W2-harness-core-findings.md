# W2 · Harness 核心 findings（2026-07-06 · macOS arm64 · Bun 1.3.14）

> 主循环 + 工具框架 + 文件夹工作区 + `<env>` 注入,照 cc-haha 重写(reimplement,不搬源码)。
> 全量 `bun test` = **43 pass / 0 fail / 12 files**;`tsc --noEmit` = **exit 0**。分步计划见 `docs/plans/TS-W2-Harness核心-实现计划-2026-07-06.md`。

## 建了什么（新增文件）
| 层 | 文件 | 职责 |
|---|---|---|
| 类型 | `src/types/message.ts` | OpenAI 兼容 `Message`(system/user/assistant/tool)+ `ToolCall` |
| 类型 | `src/types/model.ts` | `Model` 依赖注入接口 + `AssistantStep`(tool_calls / final)+ `ModelStepInput` |
| 工具框架 | `src/tools/Tool.ts` | `Tool`/`ToolContext`/`ToolSpec`/`JSONSchema`(名/描述/JSON schema/执行函数 + isReadOnly) |
| 工具框架 | `src/tools/registry.ts` | `ToolRegistry`(注册/查找/list/`specs()` 产模型可见描述) |
| 工作区 | `src/workspace/pathBoundary.ts` | `resolveInWorkspace` + `WorkspaceBoundaryError`(越界抛错) |
| 工作区 | `src/workspace/workspace.ts` | `Workspace`(root + resolve + backup)+ `defaultBackupHook`(改前 copy 进 `.backups`) |
| 工具 | `src/tools/fileReadTool.ts` `fileWriteTool.ts` `listDirTool.ts` | read/write/list,边界内解析;write 前走备份钩子 |
| 工具 | `src/tools/dangerousCommand.ts` `runCommandTool.ts` | run_command(workspace 为 cwd + 30s 超时 + 危险命令拒绝种子) |
| 工具 | `src/tools/generalTools.ts` | `buildGeneralRegistry()` 装 4 核心工具(= Python `registry.py` general 层) |
| 提示 | `src/harness/env.ts` | `computeEnvInfo`(`<env>` 块)+ `getIsGit` + `getGitStatus`(git 快照) |
| 提示 | `src/harness/systemPrompt.ts` | `buildSystemPrompt`(基座身份 + `<env>` + git 快照) |
| 循环 | `src/harness/fakeModel.ts` | `scriptedModel`(脚本化 fake,记录收到的 messages) |
| 循环 | `src/harness/loop.ts` | `runAgentLoop`(真 ReAct 主循环)+ `executeTool`(永不抛) |
| 服务器 | `src/server/index.ts`(改) | `/agent/hello` 改跑真循环 demo;`/health` 不变 |

**退役 W1 桩**:`helloLoop.ts`/`helloTool.ts` 及其测试已删(它们自带注释"真循环/真工具框架是 W2")。

## 关键决策（记给后窗,别重新纠结）
1. **消息用 OpenAI 兼容(非 cc-haha 的 Anthropic content-block)**。理由:我们模型出口是 OpenAI 兼容(MiMo/豆包/网关),现有 `loop.py` 就是 `role:tool` 回灌。`Message` = system/user/assistant(+toolCalls)/tool。W6 真模型适配器把 OpenAI 响应解析成 `AssistantStep`。
2. **主循环依赖注入一个小 `Model` 接口**(`step({messages,tools}) → AssistantStep`)。真模型出口 = W6;W2 用 `scriptedModel` 喂确定性 tool_call 序列驱动全部自动化测试。
3. **`<env>` 用 `<env>...</env>` 形态**(照 cc-haha `computeEnvInfo`),含 Working directory / Is git repo / Platform / Shell / OS Version。**刻意不含模型名/知识截止行**——白标铁律 + 模型身份是 W6。git 快照(`getGitStatus`)照 `context.ts` 单独一段附在系统提示后。
4. **路径边界 = resolve 后判 relative,不盲拒 `..`**。`a/../b` 停在区内合法、放行;只有逃出 root(`..` 开头 / 跨盘绝对)才抛 `WorkspaceBoundaryError`。比"含 `..` 就拒"更正确。
5. **备份钩子做成真的**:`write_file` 覆盖前把旧文件 copy 进 `<root>/.backups/<name>.<pathHash>.bak`(红线"改文件前可回滚")。完整 shadow-git(版本化/回滚 UI)后置。
6. **工具执行永不抛**:未知工具 / 入参非法 / 执行异常都转成"错误:…"文本回灌,循环继续、让模型自救(照 `loop.py`)。有专门测试验"工具抛错→循环继续→模型下一步收到错误文本"。
7. **不引新依赖**:全用 `node:` 内置(path/fs/child_process/os/crypto/util),无 zod/ajv。工具靠 `execute` 自校验必填参数并抛错,由循环回灌。

## W2 明确没做（留后窗,别以为漏了）
- **OS 真沙箱 + TOCTOU 补强**(UNC / `~user` / `$()` `${}` 展开 / 写操作禁 glob)→ **W3**。W2 只有应用层基础边界。
- **审批闸 / 权限三档 / 危险命令完整分类器**(可逆性·爆炸半径心智)→ **W4**。W2 的 `dangerousCommand` 只是灾难级(删根/提权/格式化/fork 炸弹)最小种子,红线兜底,非完整分类。
- **plan 模式 / todo / reminder / 压缩 / 完整轨迹 JSONL / 打转检测 / 子代理 / skills / hooks** → **W4**。
- **真模型出口 / 网关 / 内置 key** → **W6**。server 的 `/agent/hello` 用脚本化 demo model(真列工作区再收敛),不是真推理。

## 坑 / 注意
- **Bun 不在非交互 shell 的 PATH**:在 `~/.bun/bin/bun`,跑命令前 `export PATH="$HOME/.bun/bin:$PATH"`(或用完整路径)。
- **`noUncheckedIndexedAccess: true`**:数组/`.at()` 取值是 `T | undefined`,测试里用 `!`/可选链(如 `model.received[1]!.messages`)。
- **`import type` 擦除**:`Tool.ts` 里 `import type { Workspace }` 引用了尚未建的模块,`bun test` 单跑仍过(类型擦除),但完整 `tsc` 要等 Workspace 建完才 0 错——计划里把 Workspace(Task 3)排在 Tool(Task 1)之后、Task 3 收尾才跑全量 typecheck,是有意安排。
- **macOS `/tmp` 是 `/private/tmp` 软链**:`run_command` 的 `pwd` 测试要 `realpathSync(mkdtempSync(...))`,否则 workspace.root(`/tmp/...`)与 `pwd`(getcwd 返 `/private/tmp/...`)对不上。
- **run_command 用 `sh -c`(win `cmd /c`)**:跨平台;30s 默认超时防挂死;接了 `ctx.signal` 中断。

## ⚠️ 给后面窗口的硬约束（务必带走）
- **从 W5 业务翻译窗起,验收门加硬条件:先把对应的 Python 测试翻成 TS 测试、再让 TS 实现跑绿**,确保 5.7 万行 Python→TS 翻译不丢已修的 bug。
- **W2 / W3 / W4 是 harness(照 cc-haha)、不受此条约束**——harness 无对应 Python 测试可翻,照 cc-haha 行为写测试即可。
- 下一窗 = **W3 双层沙箱**(Mac/Linux 装 `@anthropic-ai/sandbox-runtime` + Windows app 护栏 + Job Object launcher)。W3 会在 W2 的 `pathBoundary`/`Workspace`/`run_command` 上补 OS 层与 TOCTOU,接口已留好扩展位。

## 复跑
```bash
cd ts && export PATH="$HOME/.bun/bin:$PATH"
bun test          # 43 pass / 0 fail / 12 files
bun run typecheck # exit 0
```
