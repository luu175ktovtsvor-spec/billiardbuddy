# TS · cc-haha v0.4.5 内核迁移矩阵

> 📌 状态:✅现行 · 2026-07-07 新增 · 参考源 `~/Desktop/cc-haha-ref` = `NanmiCoder/cc-haha@a94e1a1` (`origin/main`, release notes `v0.4.5`)

## 0. 迁移口径

- **2026-07-07 口径校准**:当前直接在 `main` 上施工;旧 `ts-harness-rewrite`/`cc-haha-direct-port` 只代表历史阶段。目标是把本仓库做成 coding 能力很强的桌面 AI Agent 外壳,不是维护多个并行分支。
- **内核可直接复制/抄/移植/改写**：消息格式、provider/proxy、session/ws、权限、工具、压缩、skills/subagents/hooks/MCP、桌面 sidecar plumbing 逐块对齐;CC-Haha 许可允许 copy/modify/distribute/publish,实现可直接移植或改写。
- **外壳按产品取舍**：cc-haha 的开发者 UI、onboarding、项目选择器、终端式体验不作为我们主外壳；但其中代码改动、diff、审批、任务、内容管道等可直接复制/抄/移植/改写到我们的低噪桌面 UI 里。
- **发布口径**：CC-Haha 可直接复制/抄/移植/改写;WorkBuddy/Trae/Qoder 等闭源竞品只学公开证据、分析结论和产品取舍。所有关键能力仍用行为测试锁边界。
- 生图/视频不是 cc-haha 的壳功能，归我们自研模块，挂在 kernel tool/审批/媒体任务框架上。

## 1. v0.4.5 必搬增量

| 增量 | cc-haha 表面 | 我们的落点 | 状态 |
|---|---|---|---|
| provider 默认 direct proxy mode,显式 system proxy 才继承系统代理 | `server/services/networkSettings.ts`, proxy handler | `ts/src/model/networkSettings.ts` + `modelFactory` 网络 fetch 已落;`ProviderService` 持久化/active/test 已落 | ✅已落 |
| reasoning effort 透传 | `server/proxy/transform/effort.ts` | `ts/src/model/reasoningEffort.ts`, `ProxyModel`, `toOpenAiChatRequest` | ✅已落 |
| active provider runtime 首轮生效 | provider service + conversation prewarm | `/agent/run` 每请求按当前 env 生成真实 Model;provider service + prewarm 已落 | ✅已落 |
| model context window 不信响应 model | `utils/model/modelContextWindows.ts` | `ts/src/model/modelContextWindows.ts` | ✅轻量版已落 |
| bypassPermissions 保留 deny/必须交互工具 | `utils/permissions/permissions.ts` | `ts/src/permissions/resolve.ts` 已补:不越过 fatal/forceConfirm/requiresUserInteraction | ✅已落 |
| `/model`/Skill command history restore | command metadata/session replay | `/model` 状态/切换 + slash command 自动展开 + `command_invocation` event replay 已落 | ✅后端已落 |
| Markdown style 注入防护 | desktop renderer | `web/src/components/desktop/safe-markdown.tsx` 统一 URL 协议白名单 + 元素白名单;聊天流/右侧预览共用 | ✅已落 |
| Read 非 PDF 忽略 pages | `FileReadTool` | `ts/src/tools/fileReadTool.ts` schema 允许 pages,非 PDF 文本读取忽略 | ✅已落 |
| sidecar 大 transcript 内存压力 | server polling/hydrate | transcript 分页 + event 流式读取 + 显式 archive/summary 已落 | ✅后端已落 |
| Windows ARM64 package smoke | release workflow/sidecar native | W18 打包 | ⛔待做 |

## 2. 模块迁移矩阵

| 层 | cc-haha 源模块 | 我们的目标模块 | 迁移策略 | 当前状态 |
|---|---|---|---|---|
| Provider/runtime | `server/services/providerService.ts`, `providerRuntimeEnv.ts`, `providerPresets.json` | `ts/src/model/*`, `ts/src/server/services/providerService.ts`, `/providers` + `/api/providers` | 保存配置和运行时 env 分离;active provider 首轮必须先应用 | ✅基础 CRUD/active/test 已落 |
| Anthropic direct | Claude/Anthropic-compatible `/v1/messages` | `AnthropicMessagesModel` | 主路径直连 Anthropic content-block,不绕 OpenAI 翻译 | ✅基础可用 |
| OpenAI-compatible proxy | `server/proxy/**` | `ts/src/proxy/**` | 纯 OpenAI 端点兜底;工具配对、reasoning、usage、流卡死不崩 | ✅基础可用 |
| Network settings | `networkSettings.ts`, `utils/proxy.ts` | `ts/src/model/networkSettings.ts` | direct/system/manual;loopback 永远 no_proxy | ✅已落 |
| Session API | `server/api/sessions.ts`, `services/sessionService.ts` | `ts/src/server/services/sessionService.ts`, `/sessions/*` | JSONL transcript + metadata cache + event replay + history restore | 🟡metadata/transcript/event replay/command invocation 已落 |
| WebSocket turn runner | `server/ws/handler.ts`, conversation service | `ts/src/server/ws/*` + 当前 SSE `/agent/run` | user_message/prewarm/interrupt/replay 事件模型 | ✅SSE + WS run/replay/interrupt + prewarm + 旧前端 task SSE 兼容层已落 |
| Permissions | `utils/permissions/**`, command metadata | `ts/src/permissions/**`, `ts/src/tools/dangerousCommand.ts` | 五档模式、rule source、allow/deny/ask、bypass/dontAsk、命令风险元数据 | 🟡五档 + 结构化规则/更新 + default file ask + acceptEdits 敏感路径闸 + 会话权限记忆 + 危险前缀黑名单已落(§3.401);规则持久化落盘/UI/读命令路径边界仍待补 |
| Bash/File/LSP/PowerShell/REPL tools | `tools/BashTool/**`, `tools/PowerShellTool/**`, `tools/REPLTool/**`, `utils/powershell/**`, `FileReadTool/**`, `FileWriteTool/**`, `NotebookEditTool/**`, `tools/LSPTool/**` | `ts/src/tools/*` | Bash/PowerShell 解析与审批、REPL primitive 编排、sandbox、Read pages 容错、编辑 diff/回滚、notebook cell 编辑、符号/定义/引用入口 | ✅基础工具 + Bash 风险分类 + PowerShell 专用工具层/静态风险审批 + `REPL` 结构化批量 primitive 编排 + edit_file 读前置/陈旧检测/归一化匹配 + `NotebookEdit` + `LSP` fallback + fileHistory 链式快照/diff/restore 已落;PowerShell AST parser/规则语法、REPL VM/bridge/隐藏 primitive 模式仍待深化 |
| Context resilience | `services/compact/**`, query compaction | `ts/src/context/*`, `ts/src/memory/*` | 分级压缩、结构化摘要、大结果落盘、熔断 | 🟡W4c 基础 + session archive/summary + 九段结构化压缩 + 最近文件恢复 + 大工具结果落盘已落 |
| Skills/commands | `server/api/skills.ts`, `commands.ts`, Skill tools | `ts/src/skills/*`, `ts/src/commands/*` | discover/load/execute/历史恢复;skillify 是产品护城河 | ✅SKILL.md loader + command loader + 工作区 `.claude/.codex` commands + slash 自动展开/list/read/create_skill + `/model` 后端已落 |
| Subagents/tasks | `tools/AgentTool/**`, `tools/Task*Tool/**`, `tools/TaskOutputTool/**`, `tools/TaskStopTool/**`, `tools/SendMessageTool/**`, `tools/TeamCreateTool/**`, `tools/TeamDeleteTool/**`, `tools/ListPeersTool/**`, `utils/teammateMailbox.ts`, `utils/swarm/teamHelpers.ts`, `tools/EnterPlanModeTool/**`, `tools/ExitPlanModeTool/**`, `tools/VerifyPlanExecutionTool/**`, `tasks/**` | `ts/src/agents/*`, `ts/src/tasks/*`, `ts/src/tools/agentInteractionTools.ts`, `ts/src/tools/verifyPlanExecutionTool.ts` | 子代理、结构化任务列表、后台任务 drawer、任务输出隔离/停止、team/mailbox、计划模式进入/退出/验证门 | 🟡Agent .md loader/工具子集 + 基础 runner + `task_create/list/get/update` + `TaskOutput/TaskStop` + `TeamCreate/TeamDelete/SendMessage/ListPeers` 本地 team/mailbox 主路径 + `SendMessage` running/stopped background agent 路由 + background agent metadata sidecar resume + `EnterPlanMode/ExitPlanMode/VerifyPlanExecution` 计划链路 + 后台 task service/API/tool + 前端后台任务 drawer 已落;✅权限继承对齐 cc(父级放权优先/后台兜底 acceptEdits)+ SendMessage resume 上下文修复(§3.401);fork 类型后台代理 resume 仍会抛错待修 |
| Worktree | `tools/EnterWorktreeTool/**`, `tools/ExitWorktreeTool/**`, `utils/worktree.ts`, `utils/getWorktreePathsPortable.ts` | `ts/src/tools/worktreeTools.ts`, `ToolContext.worktreeSession` | git worktree 创建/进入、退出 keep/remove、删除前变更保护、会话工作区切换/恢复 | 🟡`EnterWorktree/ExitWorktree` 同名工具 + 真实 git worktree add/remove + dirty guard + 同 conversation 后续 turn 自动恢复 active worktree + `tool_search` 已落;hooks/tmux/磁盘 sessionStorage 待深化 |
| Hooks | `utils/hooks/**`, hook config, `goals/goalState.ts`, `commands/goal/*`, `query/stopHooks.ts` | `ts/src/hooks/*`, `ts/src/goals/goalState.ts`, `ts/src/harness/loop.ts`, `ts/src/server/index.ts` | PreTool/PostTool/Stop/UserPromptSubmit/SessionStart + `/goal` 长目标 | 🟡JSON 裁决 + PreTool/PostTool/SessionStart/UserPromptSubmit/Stop 主链已接;command/http/prompt/agent executor 已按 CC-Haha 行为移植;HTTP hook allowlist/env policy + SSRF DNS guard 已补;Stop hook blocking feedback 续跑已接;`/goal` set/clear/usage、本地 transcript anchor 恢复、Goal continuing/Goal marked complete 持久化已落 |
| MCP/plugins | `server/api/mcp.ts`, `plugins.ts`, MCP tools | `ts/src/mcp/*`, `ts/src/plugins/*` | 官方 SDK + secret redaction + Unicode server names | 🟡配置/manifest/命名/审批映射 + SDK tool/resource/prompt/elicitation/task/sampling bridge 已落;✅readOnlyHint 免审批后门已关(§3.401,所有 MCP 工具恒 requiresApproval);仍缺 http headers/OAuth 鉴权、.mcp.json 信任闸、plugin 运行时接入(现空壳)、多字段表单 UI |
| Desktop sidecar | `desktop/electron/services/sidecarManager.ts`, `serverRuntime.ts` | `ts/desktop/electron/services/*` | 等 `/health`、端口策略、tree kill、日志诊断、ARM64 | 🟡基础 sidecar 已落 |
| Image module | 无直接 cc-haha 对应 | `ts/src/media/image/*`, 前端 studio | 自研工具,接审批/媒体任务/provider | 🟡TS 文生图/参考图/改图网关直连已落;品牌包/贴图/OCR 待迁 |
| Video module | 无直接 cc-haha 对应 | `ts/src/media/video/*`, workbench | 真实素材剪辑,ffmpeg/离屏渲染 | 🟡AI 模型生成视频已删除;真实素材 auto_plan/render fallback 保留;VLM/ASR/高级模板待迁 |

## 3. 已在 2026-07-07 落地

- 新增 `ts/src/model/AnthropicMessagesModel.ts`:Anthropic `/messages` 直连,支持 text/tool_use SSE、`x-api-key`/`Authorization`、请求超时。
- 新增 `ts/src/model/providerConfig.ts` + `modelFactory.ts`:从 `ANTHROPIC_*` 或现有 `desktop/bundled.env` 网关变量生成 runtime provider。
- 新增 `ts/src/model/modelContextWindows.ts` 和 `reasoningEffort.ts`。
- `ProxyModel`/`toOpenAiChatRequest` 透传 `reasoning_effort`。
- 新增 `ts/scripts/smoke/model-live.smoke.ts`:真实模型 smoke,脱敏输出 provider summary。
- 验证: `cd ts && bun test` = 217 pass; `cd ts && bun run typecheck` clean。

## 3.1 2026-07-07 追加落地

- 新增 `ts/src/model/networkSettings.ts`:默认 direct proxy mode;显式 `NETWORK_PROXY_MODE=system` 才继承系统代理;`manual` 走手动代理;loopback 自动合入 `NO_PROXY`。
- `modelFactory` 接入 network-aware fetch;sidecar 启动前加载 `desktop/bundled.env` + `server/.env.bundled.local`。
- `/agent/run` 接真实 `createModelFromProviderConfig` + `runAgentLoop` + `Transcript`,不再只有 demo loop。
- `bypassPermissions` 权限语义补齐:普通审批可跳过,但 `fatal`/`forceConfirm`/`requiresUserInteraction` 仍拦。
- `read_file` 兼容模型给非 PDF 普通文件传 `pages`。
- 验证:`cd ts && bun test` = 229 pass;`bun run typecheck` clean;`bun run smoke:model` 用 MiMo v2.5 真 key 通过(tool call=true)。

## 3.2 2026-07-07 扩展/创造架构追加落地

- 新增 `ts/src/commands/frontmatter.ts` + `types.ts`:统一 md+frontmatter PromptCommand 解析基础。
- 新增 `ts/src/skills/skillLoader.ts`:扫描 `*/SKILL.md`,生成渐进式披露技能库;`list_skills` 只出清单,`read_skill` 按需展开正文;`/agent/run` 默认加载 `server/skills`。
- 新增 `ts/src/agents/agentLoader.ts`:加载 `.md` Agent 定义,支持 prompt/tools/model/skills/memory;`resolveAgentTools` 支持工具子集。
- 新增 `ts/src/hooks/hooks.ts`:JSON 裁决协议 allow/deny/modify/context;PreToolUse 已接入主循环,可拦截/改参/注入 context。
- 新增 `ts/src/mcp/config.ts` + `ts/src/plugins/pluginManifest.ts`:MCP 配置归一、Windows `npx→cmd /c`、`mcp__server__tool` 命名、annotations→审批类别、plugin manifest/enable 过滤。
- 验证:`cd ts && bun test` = 244 pass;`bun run typecheck` clean;`bun run smoke:model` MiMo tool call=true;`bun run build:sidecar` 通过。

## 3.3 2026-07-07 Provider service 追加落地

- 新增 `ts/src/server/services/providerService.ts`:provider CRUD、`providers.json` 原子持久化、active provider 切换、运行时 config 解析、测试接口摘要脱敏。
- `/providers` 与 `/api/providers` 已接入:list/create/get/update/delete/activate/clear/test;删除 active provider 会拒绝。
- `/agent/run` 改成 active provider 优先,没有 active provider 才回退 `.env`/bundled env;保证切换后的首轮请求即生效。
- 验证:`cd ts && bun test` = 253 pass;`bun run typecheck` clean;`bun run smoke:model` MiMo v2.5 通过(tool call=true)。

## 3.4 2026-07-07 File edit engine 追加落地

- 新增 `ts/src/tools/fileEditTool.ts`:`edit_file` 精确替换,默认要求唯一匹配,显式 `replace_all` 才全量替换。
- `read_file` 会记录 mtime/size 快照;`edit_file` 强制读前置,改前校验文件未被外部改动,避免覆盖用户编辑。
- `edit_file` 接 `Workspace.backup()` 改前备份,并回灌 `<edit_context>` 行号片段,方便模型自查下一步。
- 新增中文标点/引号归一化匹配,覆盖 `，。：“”‘’` 等中文文案常见替换失败场景。
- 验证:`cd ts && bun test` = 257 pass;`bun run typecheck` clean。

## 3.5 2026-07-07 Session/event replay 追加落地

- `SessionService` 新增 event JSONL:每条 SSE 事件持久化为 `{seq,ts,event}`,支持坏行跳过、`after` 增量读取、`limit` 限流。
- `/sessions/:id/events` 已接入 JSON replay;`/sessions/:id/events?format=sse` 支持按 SSE id/event/data 回放。
- `SessionMeta` 新增 `status` 与 `lastEventSeq`;`/agent/run` 标记 running/idle/failed,interrupt 标记 interrupted。
- `TurnRegistry` 新增 current-turn race guard:同 session 新 turn 启动后,旧 turn 迟到事件不再覆盖持久状态。
- `ModelStepInput.signal` 已接入 `ProxyModel` 与 `AnthropicMessagesModel`,`/sessions/:id/interrupt` 能取消正在等待的模型 fetch。
- 验证:`cd ts && bun test` = 260 pass;`bun run typecheck` clean。

## 3.6 2026-07-07 Transcript hydrate 分页追加落地

- `Transcript.loadPage()` 新增流式 JSONL 分页读取,不再需要为列表/恢复场景一次性 `readFile` 全量 transcript。
- `/sessions/:id/messages?after=N&limit=M` 已接入消息分页,返回 `{messages,nextSeq,hasMore}`。
- `/sessions/:id?includeMessages=0` 支持只取 metadata,前端会话列表/状态刷新可避开大历史 hydrate。
- 验证:`cd ts && bun test` = 261 pass;`bun run typecheck` clean。

## 3.7 2026-07-07 Hooks lifecycle 追加落地

- `ts/src/hooks/hooks.ts` 新增 `applySessionStartHooks`、`applyUserPromptSubmitHooks`、`applyPostToolUseHooks`。
- `SessionStart` additionalContext 会注入 system prompt,用于行业包/店脑/安全上下文启动时挂载。
- `UserPromptSubmit` 支持 modify/context/deny:可改写用户输入、追加上下文,deny 时不进模型直接收敛。
- `PostToolUse` additionalContext 会回灌进模型可见的 tool_result 内容,不是只做前端旁白。
- 验证:`cd ts && bun test` = 268 pass;`bun run typecheck` clean。

## 3.8 2026-07-07 Hooks config 追加落地

- 新增 `ts/src/hooks/hookConfig.ts`:从 JSON 配置加载静态 hook decisions,支持 `{hooks:[...]}` 与 `{rules:[...]}`。
- `/agent/run` 会加载 `hooksPath` 或默认 `server/hooks.json`,把配置转成 `HookRegistry` 注入主循环。
- 配置支持 `SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`Stop` 事件名、tool matcher、allow/deny/modify/context JSON 裁决。
- 验证:`cd ts && bun test` = 272 pass;`bun run typecheck` clean。

## 3.9 2026-07-07 Stop hook 追加落地

- 新增 `applyStopHooks`:模型正常收敛、max_turns 强制收敛、UserPromptSubmit deny 收敛都会触发 `Stop`。
- `Stop` additionalContext 会在 final 前作为 `context_note` 输出;deny/异常退化为警告上下文,不阻断已完成响应。
- 验证:`cd ts && bun test` = 275 pass;`bun run typecheck` clean。

## 3.10 2026-07-07 Subagent runner 追加落地

- 新增 `ts/src/agents/agentTool.ts`:`agent_task` 工具会按 Agent `.md` 定义 fork 隔离 `runAgentLoop`,只把子代理 final text 回传给父 Agent。
- 子代理系统提示会包入 `<subagent name="...">`,工具集按 Agent `tools` 字段裁剪,并过滤递归 `agent_task`。
- `/agent/run` 默认加载 `server/agents`,有 Agent 定义时自动把 `agent_task` 注册进工具池。
- 验证:`cd ts && bun test src/agents/agentTool.test.ts src/server/index.test.ts` 通过。

## 3.11 2026-07-07 MCP SDK tool bridge 追加落地

- 新增 `@modelcontextprotocol/sdk` + `zod` 依赖,以官方 TS SDK 连接 MCP server。
- 新增 `ts/src/mcp/client.ts`:支持 `.mcp.json` 归一配置后的 stdio/Streamable HTTP 连接、`tools/list` 分页、`tools/call` 执行、MCP content block 格式化、连接关闭和失败降级 warning。
- `/agent/run` 会读取 workspace `.mcp.json` 或显式 `mcpConfigPath`,把 MCP tools 注册进父 Agent 和子代理基础工具池;turn 结束时关闭 MCP 连接。
- 已覆盖真实 stdio JSON-RPC fixture 和 `/agent/run` 集成测试;resources/prompts/elicitation/task-based tool 仍留后续深接线。
- 验证:`cd ts && bun test src/mcp/client.test.ts src/mcp/config.test.ts src/server/index.test.ts`;`bun run typecheck` clean。

## 3.12 2026-07-07 FileHistory/restore 追加落地

- 新增 `ts/src/tools/fileHistory.ts`:write/edit/restore 前写入会话级 JSONL 快照,普通文本文件保存改前备份,大文件跳过并标记原因以防 OOM。
- 新增 `file_history` 工具查看当前 conversation 的文件快照;新增 `restore_file` 工具按 `snapshot_id` 或 latest 快照回滚,并用 `diff` 生成预览。
- `write_file`、`edit_file` 已在写入前调用 `recordFileSnapshot`;`restore_file` 自身回滚前也会再记录一次快照,可继续撤回。
- `restore_file` 标记 `destructive` + `forceConfirm`,即使 full/bypass 档也不能静默执行危险回滚。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts src/tools/generalTools.test.ts`;`bun run typecheck` clean。

## 3.13 2026-07-07 skillify/create_skill 追加落地

- `createSkillTools` 新增 `create_skill`:把已验证流程写成 `SKILL.md`,字段包括 `name/description/instructions/whenToUse/allowedTools/overwrite`。
- `/agent/run` 传入当前 `skillsRoot`,因此 `create_skill` 默认写入项目 `server/skills/<slug>/SKILL.md`;创建后同步更新当前内存 `SkillLibrary`,同一轮可被 `list_skills/read_skill` 看到。
- 已有技能默认拒绝覆盖;显式 `overwrite:true` 才允许重写。
- `create_skill` 标记为 `file` 审批类,避免模型静默改写技能库。
- 验证:`cd ts && bun test src/skills/skillLoader.test.ts src/server/index.test.ts`;`bun run typecheck` clean。

## 3.14 2026-07-07 WebSocket runner/replay 追加落地

- `/agent/run` 的 turn 装配抽成共享 `createTurnStream`:provider、skills、hooks、agents、MCP、transcript、event log 只走一套逻辑。
- 新增 `/agent/ws`:连接后返回 `ready`,客户端可发 `{type:"run"}` 启动 turn、`{type:"replay", after}` 回放事件、`{type:"interrupt"}` 中断当前 session。
- WS live 与 replay 都发送 `{type:"event", seq, ts, event}`,断线后 turn 继续落盘,新连接按 `after` 补齐。
- 验证:`cd ts && bun test src/server/index.test.ts`;`bun run typecheck` clean。

## 3.15 2026-07-07 Commands loader/API 追加落地

- 新增 `ts/src/commands/commandLoader.ts`:扫描 `server/commands/**/*.md`,统一解析 md+frontmatter 为 `PromptCommand`,支持 name/description/whenToUse/allowedTools/model。
- 新增 `list_commands`/`read_command` 渐进披露工具;`/agent/run` 默认加载 commands 并注册到同一工具池。
- 新增 `/commands` 与 `/api/commands/expand`:前端可列出斜杠命令并把命令展开成 prompt。
- 验证:`cd ts && bun test src/commands/commandLoader.test.ts src/server/index.test.ts src/tools/generalTools.test.ts`;`bun run typecheck` clean。

## 3.16 2026-07-07 Prewarm 追加落地

- 新增 `/agent/prewarm`:不打真实模型,只解析 active/env provider、构造 model adapter、加载 skills/commands/hooks/agents,可选 `includeMcp` 探测 MCP tools 后立即关闭连接。
- 支持传 `conversationId` 和 `workspaceRoot`,用于前端/桌面壳首屏提前创建 session metadata 并拿到能力计数。
- provider summary 全程脱敏;provider 缺失返回 503。
- 验证:`cd ts && bun test src/server/index.test.ts`;`bun run typecheck` clean。

## 3.17 2026-07-07 Session/commands/MCP 深接线追加落地

- `SessionService.appendEvent()` 改为优先使用 `SessionMeta.lastEventSeq` 递增,旧 metadata 缺失时才流式扫描 event JSONL 恢复最大 seq;`loadEvents()` 改为流式读取,避免长会话 replay/append 整文件进内存。
- slash command 自动展开已接 `/agent/run`:用户输入 `/name args` 会在进入模型前展开为命令 prompt,并写入 `command_invocation` event,支持 SSE/WS/session replay 恢复原始命令名和参数。
- `commandLoader` 支持 cc 风格 `/plugin:name.run` 命令名解析;`/api/commands/expand` 统一走同一规范化逻辑。
- MCP SDK bridge 新增 resources/prompts 只读工具:`list_mcp_resources`、`read_mcp_resource`、`list_mcp_prompts`、`read_mcp_prompt`;仍保持渐进披露,不在 turn 启动时注入正文。
- 验证:`cd ts && bun test` = 299 pass;`bun run typecheck` clean。

## 3.18 2026-07-07 Background task runner 后端追加落地

- 新增 `ts/src/tasks/taskService.ts`:后台任务 metadata + JSONL events + in-memory abort controller,支持 list/get/cancel/event replay。
- 新增 `list_background_tasks`、`read_background_task`、`cancel_background_task` 和 `start_background_agent_task` 工具;启动后台子代理标记 `spend` 审批类别。
- `/tasks`、`/tasks/:id`、`/tasks/:id/events`、`/tasks/:id/cancel` 后端 API 已接入,供后续前端 drawer 增量读取。
- 后台子代理复用 Agent `.md` 定义和工具子集,但不继承 parent turn 的 MCP 连接,避免父 turn 结束关闭连接后后台任务踩空。
- 验证:`cd ts && bun test` = 299 pass;`bun run typecheck` clean。

## 3.19 2026-07-07 `/model` 后端追加落地

- 新增 `/model` 与 `/api/model`:GET 返回当前 runtime provider 摘要、active provider、已保存 providers(全脱敏);POST/PATCH 支持 `{providerId}` 激活已有 provider,`env/default/空` 切回 env fallback。
- `/model` 复用 `ProviderService` 的 provider CRUD,保证 active provider 首轮生效路径一致。
- 验证:`cd ts && bun test src/server/index.test.ts`;`bun run typecheck` clean。

## 3.20 2026-07-07 Bash risk classifier 追加落地

- `Tool`/`resolvePermission` 新增动态 `isReadOnlyFor` 与 `approvalClassFor`,支持同一工具按入参区分只读/文件/外联/破坏性审批。
- `run_command` 接入 `classifyCommandRisk`: `ls/git status` 等只读命令在 ask/plan 下可直接执行;`echo > file/npm run build` 归 file;`curl/npm install` 归 outreach;`rm -rf build/git clean` 归 destructive;灾难级命令仍走 fatal 硬拒。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts src/permissions/resolve.test.ts`;`bun run typecheck` clean。

## 3.21 2026-07-07 FileHistory 链式快照追加落地

- `FileHistoryRecord` 新增 `sequence` 与 `previousId`,同一文件的 write/edit/restore 快照可串成链。
- `file_history` 新增 `include_diff`,可按 snapshot 输出 restore diff,供前端 diff 面板直接展示;坏快照会以 `snapshot_diff_error` 退化,不影响列表。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts`;`bun run typecheck` clean。

## 3.22 2026-07-07 前端 task SSE 兼容层追加落地

- 新增旧前端兼容路由:`POST /api/v1/agent/tasks`、`GET /api/v1/agent/tasks/:id/events`、`POST /api/v1/agent/tasks/:id/cancel`、`POST /api/v1/agent/tasks/:id/message`。
- 兼容层内部复用同一 `createTurnStream`,把 TS `AgentEvent` 映射成旧前端 `token/reasoning/tool_call/tool_result/final/done/context_note/todo_update` 字段形状,带 `offset/task_id/conversation_id` 支持断线续传。
- task message 会进入同 conversation 的 steering inbox,与 `runAgentLoop` 的 steering 安全点注入共用一条逻辑。
- 验证:`cd ts && bun test src/server/index.test.ts`;`bun run typecheck` clean。

## 3.23 2026-07-07 Transcript archive/summary 追加落地

- 新增 `POST /sessions/:id/archive`:拒绝 running session;先复制原 transcript JSONL 到 `transcript-archives`,再用当前 provider 对旧消息生成摘要,当前 transcript 保留「摘要 + 最近 N 条」。
- 归档复用 `compactPipeline`,不另写摘要 prompt;provider 缺失返回 503,消息不足返回 `archived:false`。
- 验证:`cd ts && bun test src/server/index.test.ts`;`bun run typecheck` clean。

## 3.24 2026-07-07 媒体任务兼容层/工具化追加落地

- 新增 `ts/src/media/mediaJobs.ts`:基于 `TaskService` 承载媒体任务 `kind/progress/stage/result`,支持 TS job 包一层旧 Python media job,通过 `MEDIA_BACKEND_URL`/`PYTHON_BACKEND_URL` 提交并轮询 `/api/v1/agent/media-jobs/:id`。
- 没配媒体后端时,`studio/generate` 与 Agent 生图工具生成本地 SVG 占位预览并明确标记 `local_preview`;视频/剪辑任务返回人话错误,不假装已出片。
- 新增 `ts/src/media/mediaTools.ts`:注册 `make_poster`、`generate_image`;图片走后台媒体任务,接入同一任务系统。
- TS server 新增旧前端兼容路由:`/api/v1/studio/generate|edit|expand`、`/api/v1/video-edit/inventory|auto_plan|auto_plan_v2|projects/:id/render|render_v2`、`/api/v1/agent/media-jobs/:id` 与 `/uploads/*` 本地预览产物。
- 验证:`cd ts && bun test src/media/mediaJobs.test.ts src/media/mediaTools.test.ts src/server/index.test.ts`;`bun run typecheck` clean。

## 3.25 2026-07-07 前端后台任务抽屉追加落地

- `web/src/lib/api.ts` 新增 TS `/tasks` 客户端方法:`listBackgroundTasks`、`getBackgroundTask`、`cancelBackgroundTask`,与现有 `getMediaJob/pollMediaJob` 并行保留。
- 新增 `web/src/components/desktop/background-tasks-panel.tsx`:展示后台 Agent task 与 media job 的标题、类型、状态、进度、阶段、结果缩略图/链接、错误和取消入口。
- `chat-shell` 顶栏新增「后台任务」入口,不重做主对话 UI,与「定时任务/店铺资料库/最近删除」同类抽屉。
- 验证:`cd web && pnpm exec tsc --noEmit`;`cd ts && bun test src/media/mediaJobs.test.ts src/media/mediaTools.test.ts src/server/index.test.ts`;`cd ts && bun run typecheck` clean。

## 3.26 2026-07-07 TaskService 元数据并发写修复

- 全量测试暴露 `TaskService.cancel()` 与 `appendEvent()` 并发写 `tasks.json` 时可能丢掉 `cancelled` 状态;根因是多个 `touch()` 各自读旧 index 再原子 rename,最后写入者覆盖前一个 patch。
- `TaskService` 新增 index 写入队列,`create()`/`touch()` 统一串行化 metadata 读改写;事件 JSONL 仍独立 append,但 `lastEventSeq/status/progress` 不再互相踩。
- 验证:`cd ts && bun test` = 308 pass;`cd web && pnpm exec tsc --noEmit`;`cd web && pnpm build` 通过(仅既有 `<img>`/hook lint warnings)。

## 3.27 2026-07-07 MCP elicitation/task/sampling 深接线追加落地

- `ts/src/mcp/client.ts` 的官方 SDK client 现在声明 form/url elicitation、客户端 task store 与 task request capability;form elicitation 可自动接受全默认值表单,缺少可安全填写的必填项时明确 decline,避免工具调用卡死。
- MCP 工具执行识别 `execution.taskSupport=required|optional`,优先走 `client.experimental.tasks.callToolStream()`,把 task created/status/progress 与最终 result 一起回灌给模型;optional task 在 server 不支持时回落普通 `callTool()`。
- `/agent/run` 给 MCP client 接入 sampling handler:server 反向请求 LLM 时复用当前 provider/model,但以无工具模式执行,不绕过主 Agent 权限闸。
- 定向 stdio fixture 已覆盖普通 tool、elicitation 默认值、sampling、required task tool、resources、prompts。
- 验证:`cd ts && bun test src/mcp/client.test.ts`;`cd ts && bun run typecheck` clean。

## 3.28 2026-07-07 媒体兼容路由补齐追加落地

- TS studio 兼容层新增 `GET /api/v1/studio/generation/:id` 的本地预览解析:无媒体后端时,本地 SVG preview 的 `local-*` generation id 能查回 `/uploads/posters/*.svg` URL,前端不再必须依赖 Python generations 表。
- `POST /api/v1/studio/storyboard` 在无媒体后端时返回结构化本地分镜占位(`shots/caption/local_preview/message`),保持创作工作区流程不断;有媒体后端时仍代理到 Python 真实分镜模型。
- 真实生图/视频/剪辑仍不假装完成:未配置媒体后端的重任务继续返回明确 503 或后台任务错误。
- 验证:`cd ts && bun test src/media/mediaJobs.test.ts src/server/index.test.ts`;`cd ts && bun run typecheck` clean。

## 3.29 2026-07-07 视频编辑同步兼容层追加落地

- 新增 `ts/src/media/videoEditProjects.ts`:按 Python `TimelineDoc` 口径读写 `uploads/edits/<project>/timeline.json`,实现 doc view、原子 ops、校验失败回滚、占位字幕、V2 feedback 的本地兼容响应。
- `/api/v1/video-edit/localfile` 已在 TS 本地支持视频 Range 流,修复无 Python 媒体后端时前端预览本机视频的同源加载缺口。
- `/api/v1/video-edit/projects/:project`、`/ops`、`/auto_caption`、`/recaption`、`/edit_feedback` 已接入:有媒体后端优先代理 Python 成熟实现;无媒体后端时只处理确定性时间轴文档层,重剪辑/渲染仍不假装完成。
- 验证:`cd ts && bun test src/server/index.test.ts`;`cd ts && bun run typecheck` clean。

## 3.30 2026-07-07 MCP elicitation 前端基础桥追加落地

- `AgentEvent` 新增 `ask_question`;legacy task SSE 会把 MCP elicitation 事件转成旧前端可识别的问题卡事件。
- `/agent/run` 的 MCP client 新增任务化 elicitation handler:表单有完整默认值时仍自动接受;缺必填时向当前后台任务发问题卡,等待用户通过运行中插话回复 JSON/单字段值;URL elicitation 支持允许/取消。
- `web/src/hooks/use-agent-chat.ts` 改为收到 `ask_question` 立即插入问题卡;`chat-thread` 问题卡支持自由输入 textarea,用户点击选项或提交表单文本都会走既有 `/api/v1/agent/tasks/:id/message` 通道,不新造一条交互链。
- 验证:`cd ts && bun test src/mcp/client.test.ts src/server/index.test.ts`;`cd ts && bun test`;`cd ts && bun run typecheck`;`cd web && pnpm exec tsc --noEmit` clean。

## 3.31 2026-07-07 内置命令包 + Python 兼容端点追加落地

- 新增 `server/commands/*.md` 内置命令包:`/help`、`/doctor`、`/model`、`/permissions`、`/context`、`/compact`、`/skills`、`/agents`、`/mcp`、`/plugins`、`/memory`、`/output-style`、`/cost`;全部走现有 command loader/`/agent/run` slash 展开,CC-Haha 相关实现可直接复制/抄/移植/改写。
- 前端 `/` 面板新增后端 commands 拉取:`api.listCommands()` + `DesktopComposer` 合并 `server/commands`;本地 UI 命令仍即时处理,后端 prompt command 填回输入框由主 Agent 执行。
- TS server 新增旧前端兼容端点:`/api/v1/agent/skills`、`/api/v1/agent/output-styles`、`/api/v1/agent/mcp`、`/api/v1/agent/mcp/presets`、`/api/v1/agent/mcp/add|remove|toggle`、`/api/v1/agent/plugins`、`/api/v1/agent/plugins/toggle|install`、`/api/v1/agent/execute`、`/api/v1/agent/reject`;审批确认复用 `executeApproved()` 和同一套工具注册表。
- 新增 `ts/src/mcp/configStore.ts`:桌面库 `.mcp.json` 原子写 add/remove/toggle;`normalizeMcpConfig` 保留 `disabled` 标记,主 MCP loader 跳过停用 server;`defaultMcpConfigPath` 加入 `DESKTOP_LIBRARY_DIR/.mcp.json` 与默认门店库路径。
- `ts/src/plugins/pluginLoader.ts` 补插件 list/toggle/install GitHub clone;桌面本地模式只扫/写门店库 plugins,不把开发者私有 `~/.claude` 插件暴露给老板面板。
- 新增 `ts/src/outputStyles/outputStyleLoader.ts` 与 `ts/src/plugins/pluginLoader.ts`;TS Agent 开始消费前端已传的 `output_style`、`goal`、`knowledge_packs`、`selected_files`、`deep_thinking`,注入 system prompt,避免新内核忽略台球工作台/输出风格/目标上下文。
- `ts/desktop/scripts/build-sidecar.ts` 修复交叉编译 Windows 目标时在 macOS 上误执行 `codesign` 的问题;仅 `*-apple-darwin` 目标做 ad-hoc 签名。
- 验证:`cd ts && bun run typecheck`;`cd web && pnpm exec tsc --noEmit`;`cd ts && bun test` = 314 pass;`cd web && pnpm build` 通过(仅既有 lint warnings);`bun run smoke:model` MiMo v2.5 真模型 tool call 通过;`bun run build:sidecar` Mac arm64 通过;`SIDECAR_TARGET_TRIPLE=x86_64-pc-windows-msvc bun run build:sidecar` Windows x64 sidecar 交叉构建通过。

## 3.32 2026-07-07 本地文件可达性对齐追加落地

- `Workspace` 新增 `allowedPaths` 与 `fullDiskAccess` 语义:工作区外文件/目录只要是用户通过前端 `selected_files` 明确选中的路径即可读写;`full_disk_access` 为 true 时允许绝对路径/相对越界路径解析到本机任意位置。
- TOCTOU 红线仍保留:UNC、`~user`、`$/%/=` shell 展开语法、写操作 glob 继续拒绝;不是简单拆掉边界。
- `/agent/run`、legacy task、审批执行、commands expand 统一使用 `workspaceFromBody()`,优先 `working_dir` 作为工作根,并接入 `selected_files`/`full_disk_access`;修复“前端选了桌面/下载文件,TS Agent 实际工具被工作区边界挡住”的问题。
- 新增集成测试:模型通过 `read_file` 读取工作区外但已选中的文件,工具结果可正常回灌。
- 验证:`cd ts && bun run typecheck`;`cd ts && bun test src/workspace/workspace.test.ts src/workspace/pathValidation.test.ts src/tools/fileTools.test.ts src/server/index.test.ts` = 62 pass。

## 3.33 2026-07-07 旧前端 Agent 数据面兼容层追加落地

- 新增 `ts/src/server/services/legacyAgentStore.ts`:用本地 JSON 原子持久化承接旧 Python 数据库里的轻量成品、效果反馈、软删成品、软删会话状态,不改动主 transcript JSONL 结构。
- TS server 补齐旧前端仍调用的数据面端点:`/api/v1/agent/chat`、`/api/v1/agent/conversations`、`/api/v1/agent/conversations/:id`、`/api/v1/agent/recent-artifacts`、`/api/v1/agent/saved-artifacts`、`/api/v1/agent/recent-artifacts/:id/rating`、`/api/v1/agent/deleted-items/*`、`/api/v1/agent/file-diff`、`/api/v1/agent/file-restore`、`/api/v1/agent/image/validate`、`/api/v1/agent/daily-drafts`。
- `/api/v1/agent/chat` 现在直接复用 `createTurnStream`,只把事件映射成旧前端 `data:{type,...}` SSE 形状;会话列表/详情从 `SessionService` + `Transcript` 投影,会话删除走软删,最近删除可恢复/彻底删除。
- `file-diff`/`file-restore` 支持显式本地 backup path,并拦截 `.env`/key/token/secret 类敏感路径;`image/validate` 做供应商/模型名温和校验,未知供应商不硬拦。
- `SessionService` 新增 `remove(id)` 用于最近删除里的彻底清理 transcript/event/index。
- 验证:`cd ts && bun test` = 321 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm build` 通过(仅既有 lint warnings);`cd ts && bun run smoke:model` MiMo v2.5 真模型 tool call 通过;`cd ts && bun run build:sidecar` Mac arm64 通过;`SIDECAR_TARGET_TRIPLE=x86_64-pc-windows-msvc bun run build:sidecar` Windows x64 sidecar 交叉构建通过。

## 3.34 2026-07-07 分支收敛 + Python 壳接口 TS 兜底追加落地

- 本地分支已收敛:删除 `ts-harness-rewrite` 分支指针;后续不再把 `cc-haha-direct-port` 当必需施工分支,当前按 owner 最新要求直接在 `main` 承接 TS/coding-agent 内核迁移;其它 image/video/batch 分支经审计均已在 `main`。
- 新增 `ts/src/tools/searchTools.ts`:`glob_files` 和 `grep_files` 进入默认工具池,补齐 coding-agent 找文件/搜代码的基础能力;默认跳过 `node_modules/.git/.next/dist/build/.agent-state` 等重目录,并跳过 `.env`/key/token/secret 类敏感文件。
- 新增 `ts/src/server/services/desktopDataStore.ts`:用本地 JSON 原子持久化承接店铺资料、BYOK 展示配置/配置档、店脑记忆、定时任务、店铺资料库状态、通知、dashboard 推荐等 Python 壳层数据。
- TS server 新增 Python 删除前的产品壳兜底端点:`/api/v1/auth/me`、`/api/v1/stores*`、`/api/v1/voice/transcribe`、`/api/v1/canvas/*`、`/api/v1/logs/client`、`/api/v1/store-memory*`、`/api/v1/scheduled-tasks*`、`/api/v1/store-docs*`、`/api/v1/dashboard/*`、`/api/v1/notifications`、`/api/v1/quota/cost`、`/api/v1/backup/export`。
- 壳层兜底目标是“不 404、不拖垮桌面主流程”:基础读写/JSON 状态已可用;Office 直接写回、语音转写、真实媒体渲染仍需后续真替代或保留 native sidecar,不能假装已完成。
- 验证:`cd ts && bun test` = 324 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm build` 通过(仅既有 lint warnings)。

## 3.35 2026-07-07 AskUserQuestion/ExitPlanMode 行为级迁移追加落地

- 新增 `ts/src/tools/agentInteractionTools.ts`:提供 `ask_user_question`/`AskUserQuestion` 与 `exit_plan`/`ExitPlanMode` 工具规格,保留我们自己的 schema/事件协议,CC-Haha 相关实现可直接复制/抄/移植/改写。
- `runAgentLoop` 对上述交互工具走专用分支:先发 `ask_question` 事件,再等待当前会话 `steerInbox` 的用户回复,把 `<user_answer>`、`<plan_approved>` 或 `<plan_needs_revision>` 作为 tool_result 回灌模型。
- `ExitPlanMode` 获得“批准并执行”后,当前回合从 `plan` 切到 `ask` 权限档,后续文件类/命令类动作仍继续走既有权限闸,不是无条件 bypass。
- 前端工具元数据新增“询问用户/提交计划”标签;旧前端 task SSE 已有问题卡通道可直接复用,并补集成测试覆盖 `/api/v1/agent/tasks/:id/message` 回答后模型下一轮收到答案。
- 验证:`cd ts && bun test src/harness/loop.test.ts src/tools/generalTools.test.ts`;`cd ts && bun test src/server/index.test.ts`;`cd ts && bun test` = 327 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm exec tsc --noEmit` clean。

## 3.36 2026-07-07 MCP/AskUser 专用表单 UI 追加落地

- `AgentEvent.ask_question` 扩展 `fields/url/option.preview`:旧客户端仍只看 `question/options/allowFreeform`,新桌面卡片可渲染结构化表单、URL 打开确认和选项预览。
- MCP form elicitation 会把 `requestedSchema.properties` 映射为 `AskQuestionField`:支持 text/textarea/number/boolean/select/multiselect、required、description、default、enum;提交后仍走同一 `/api/v1/agent/tasks/:id/message` 通道,以 JSON 回灌给 MCP handler。
- `MacQuestionCard` 新增字段表单渲染、必填校验、URL 外链按钮、选项 preview 预览框;没有 fields 的旧问题卡保持自由输入 textarea 行为。
- 验证:`cd ts && bun run typecheck`;`cd ts && bun test src/server/index.test.ts`;`cd ts && bun test` = 327 pass;`cd web && pnpm build` 通过(仅既有 `<img>`/hook warnings);`cd web && pnpm exec tsc --noEmit` clean。

## 3.37 2026-07-07 Canvas/Office 轻量本地替代追加落地

- TS `/api/v1/canvas/render` 不再只吐 txt/md:新增 HTML 渲染和最小 OOXML `.docx` 导出,`save-to-library` 可按二进制写入 docx。
- TS `/api/v1/canvas/doc-save` 对 `.txt/.md/.markdown/.html/.htm` 支持块级写回,写前在同目录 `.billiards-backups` 备份;当时 `.docx/.pptx` 仍明确 501,已在 3.38 补齐基础写回。
- TS `/api/v1/canvas/excel-edit` 对 `.csv` 支持 A1 单元格真写回,写前备份;当时 `.xlsx` 仍明确 501,已在 3.38 补齐基础写回。
- 验证:`cd ts && bun run typecheck`;`cd ts && bun test src/server/index.test.ts` = 34 pass。

## 3.38 2026-07-07 Office 二进制写回 + 语音端点真替代追加落地

- 新增 `ts/src/server/services/officeDocuments.ts`:TS 本地 ZIP/XML 读写 `.docx/.pptx/.xlsx`,支持 docx/pptx 文本块读取与原位写回、xlsx sheet 读取与 A1 单元格写回;所有写操作先写 `.billiards-backups`。
- `canvas/render` 新增最小 `.pptx/.xlsx` 导出;`canvas/doc-blocks|doc-save|sheet|excel-edit` 对 Office 二进制不再返回 501,旧前端可以走 TS 完成基础文档/表格编辑。
- 新增 `ts/src/server/services/voiceTranscription.ts`: `/api/v1/voice/transcribe` 不再空文本假成功;会保存上传音频,调用 `WHISPER_TRANSCRIBE_COMMAND` 或 `WHISPER_CLI/WHISPER_CPP_BIN`/PATH whisper.cpp runner,直接失败后可用 `FFMPEG_BIN` 转 16k wav 重试,最终失败按 Python 端语义返回 400/422。
- 注意:voice 端点逻辑已 TS 化,但装机版仍要把 whisper runner + 模型 + ffmpeg 资产打进/下载到桌面可发现路径,这属于打包验证,不是 HTTP 路由缺口。
- 验证:`cd ts && bun run typecheck`;`cd ts && bun test src/server/index.test.ts` = 35 pass。

## 3.39 2026-07-07 店铺资料库本地索引/检索追加落地

- 新增 `ts/src/server/services/storeDocsService.ts`:选定文件夹后递归扫描 `.txt/.md/.csv/.tsv/.json/.yaml/.docx/.pptx/.xlsx` 等常见资料,读取 Office 文本块/表格内容,分块写入本地 `store-docs-index.json`。
- `/api/v1/store-docs` 不再只是把状态置 ready:PUT 会真实索引并回填 `indexed_file_count/indexed_chunk_count/last_indexed_at`;`/reindex` 复用同一索引流程;新增 `/api/v1/store-docs/search` 返回带 `file_name/path/excerpt` 的出处片段。
- 新增 `search_store_docs` Agent 工具进入 TS registry,模型回答“你家合同/价目表/排班表/进货单”这类专有资料问题时可查用户本机文件夹,且与行业知识库/生成历史保持隔离。
- 口径:这是轻量本地关键词/短语检索,先保证 TS sidecar 不退化成“假资料库”;后续若要接 bge/网关 embedding,应只用于老板自己的资料侧,不把静态行业知识库改成重向量库。
- 验证:`cd ts && bun run typecheck`;`cd ts && bun test src/server/services/storeDocsService.test.ts src/server/index.test.ts` = 37 pass。

## 3.40 2026-07-07 主对话首屏收敛 + 文件改动实时预览追加落地

- 按竞品拆解里的 Work Buddy/Codex 方向重新收紧欢迎屏:`welcome-screen` 不再堆大卡片,快捷能力改成轻量 action,起手建议只保留 2 条;首次引导条去卡片化,整体配色继续遵循“无蓝、绿只作点缀、主操作中性”的已定口径。
- `chat-shell` 顶栏和欢迎屏入口统一为“知识库”,右侧抽屉保持“行业知识 / 店铺文件 / 门店记忆”三源分层;店铺文件检索与行业静态知识保持隔离。
- `edit_file`/`write_file` 工具结果新增 `<file_change path snapshot_id backup_path>` 元数据;前端 `use-agent-chat` 会在工具结果一到达时打开右侧 diff,对话步骤里的手动预览也复用同一 `backup_path` 恢复链路,不是等最终答复才展示。
- 视觉验证:Playwright 打开 `http://127.0.0.1:3000/dashboard/chat`,首屏只剩轻量引导、3 个文字入口、2 条建议和输入框;知识库抽屉打开正常,无业务 console error。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts`;`cd web && pnpm exec tsc --noEmit` clean。

## 3.41 2026-07-07 TS 文生图网关直连追加落地

- `MediaJobService` 新增直连图片网关路径:无 Python 媒体后端时,若 `OPENAI_BASE_URL/OPENAI_API_KEY/IMAGE_MODEL_NAME` 或 `QF_GATEWAY_URL/QF_GATEWAY_TOKEN` 可用,`studio/generate` 与 Agent 生图工具会直接调用 `/images/generations` 或 `/ark/images/generations`,不再只能生成 SVG 占位图。
- 网关返回的 `b64_json` 会保存到本机 `/uploads/posters/*.png`;网关返回 URL 时会尽力下载落本地,失败才保留远端 URL,避免成品依赖短期外链。
- 真实通道已配置但调用失败时会返回错误,不会静默退成本地占位图假装成功;只有完全未配置真实通道时才保留 `local_preview:true` 占位 fallback。
- 口径:这只补齐 TS 文生图真实路径;图生图、logo/二维码像素贴、角色化参考图路由、Seedream 参数校准仍属于 Image module 后续项。
- 验证:`cd ts && bun test src/media/mediaJobs.test.ts src/media/mediaTools.test.ts src/server/index.test.ts`;`cd ts && bun run typecheck` clean。

## 3.42 2026-07-09 CD/Seedance 2.0 生成视频全链路删除收口

- CD/Seedance 2.0 这类 AI 模型生成视频路径已从 TS 媒体任务、Agent 工具、Studio API、Python 服务、网关代理、桌面配置、前端入口和 E2E 断言删除;不保留禁用开关、兼容旧路由或 410 fallback。
- `MediaJobService` 不再包含 `i2v`/生成视频 kind,不再提交 `/contents/generations/tasks`,也不再读取 `VIDEO_BASE_URL/VIDEO_MODEL_NAME`;Python 侧同步删除 `video_service.py`、`ark_video.py`、`/studio/i2v`、`generate_video` 工具和相关测试。
- 前端删除图片到模型视频的 handoff、`studioI2v` API、设置抽屉模型标签、背景任务中的生成视频分类;只保留已有视频成品预览和真实素材剪辑工作台。
- 网关删除视频 submit/poll 透传和视频 quota/concurrency 配置;保留对话、生图、Seedream 生图、Ark chat/VLM、Amap 等仍在使用的通道。
- 口径:删除的是模型直接生成视频;`video_edit/*` 的真实素材 ffmpeg 渲染、字幕、转写、VLM 导演、时间线导出、`render_video` 和完整剪辑工作台仍属于 Video module 后续项。
- 残留扫描:`rg -n "studio_i2v|/studio/i2v|StudioI2vIn|studioI2v|generate_video|Seedance|seedance|VIDEO_BASE_URL|VIDEO_MODEL_NAME|BUNDLED_VIDEO_LABEL|图生视频|文生视频|做成视频|fromGen|doubao-seedance|contents/generations/tasks|GW_Q_VIDEO|GW_VIDEO" ...` 只剩阶段目标、迁移矩阵和删除说明文档;运行时代码、配置、网关和 E2E 脚本无旧入口。
- 验证:`cd ts && bun test src/media/mediaTools.test.ts src/media/mediaJobs.test.ts src/server/index.test.ts src/packs/domainPacks.test.ts` = 124 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm exec tsc --noEmit` clean;`bun test gateway/app.test.ts` = 9 pass;`cd server && uv run pytest tests/test_agent_builtin_tools.py tests/test_media_jobs_service.py tests/test_media_jobs_runner.py tests/test_studio_router.py tests/test_poster_path_guard.py tests/test_image_generation_handoff.py tests/test_agent_loop_model_timeout.py tests/test_media_job_notify.py tests/test_video_v2_units.py tests/test_video_v2_orchestration.py tests/test_video_edit_planners_footage_health.py tests/test_video_edit_tools.py -q` = 171 pass。

## 3.43 2026-07-07 TS-only 视频工作台本地方案/出片 fallback 追加落地

- `VideoEditProjectStore` 新增本地 `auto_plan/auto_plan_v2` fallback:无 Python 媒体后端时,会按用户选中的本机素材顺序生成可预览 timeline、caption 占位和 `local_preview:true` 结果,不再让视频工作台第一步直接失败。
- `VideoEditProjectStore.renderProject()` 新增窄版 ffmpeg 出片:按视频轨顺序裁剪片段、统一缩放/补边/fps、concat 成 `/uploads/videos/video_edit_*.mp4`;有字幕时生成 `.srt`,并尝试用 ffmpeg subtitles filter 烧录,不支持时返回 caveat。
- `MediaJobService.startVideoJob()` 的 `video_auto_plan/video_inventory/video_render` 在无媒体后端时会走上述 TS fallback;有 Python 媒体后端时仍优先代理成熟实现。
- 口径:这是 TS-only 可用性兜底,不是完整智能剪辑替代;真实 VLM 挑高光、口播 ASR/转写、音乐/响度、健康体检、模板离屏渲染和重剪辑策略仍需继续迁移。
- 验证:`cd ts && bun test src/server/index.test.ts src/media/mediaJobs.test.ts src/media/mediaTools.test.ts`;`cd ts && bun run typecheck` clean。

## 3.44 2026-07-07 TS 生图参考图/改图网关直连追加落地

- `MediaJobService` 的 TS 图片路径新增可反查的 `generation_ids`:本地占位图与真实网关图都会返回 `generation_ids`,`GET /api/v1/studio/generation/:id` 可解析 `local-*` 和 `direct-*` 到本机 `/uploads/posters/...`,工作室后续“要同款 / 改这张”不再断链。
- `studio/generate` 在无 Python 媒体后端时支持参考图:前端本次选中的 `reference_image_paths` 会作为 trusted paths 注入,转成 data URI;`reference_generation_ids` 会从本机作品库解析后并入参考图。Seedream/方舟走 `/ark/images/generations` JSON `image/input_images/sequential_image_generation`。
- `studio/edit` 在无 Python 媒体后端时支持 OpenAI-compatible `/images/edits` multipart:以 `source_generation_id` 解析底图,可选 trusted `mask_path`,并设置 `input_fidelity=high`;网关结果继续落本机 `/uploads/posters`。
- 安全口径:Agent 工具自己填的任意绝对路径不会被读取;只有 Studio 前端本次请求显式传入的参考图/蒙版路径会进入 `_trusted_image_paths`,`/uploads/...` 仍按作品库沙箱解析。
- 口径:这补齐 TS 参考图和基于已有图改图的真实通道;Python `poster_service` 的品牌参考包、logo/二维码像素或模型融合策略、中文硬文字 OCR 质检、Seedream/GPT 细粒度自动路由仍需继续迁移。
- 验证:`cd ts && bun test src/media/mediaJobs.test.ts src/server/index.test.ts`;`cd ts && bun run typecheck` clean。

## 3.45 2026-07-07 TS 门店品牌包注入追加落地

- `MediaJobService` 新增 TS-only 图片任务准备钩子:无 Python 媒体后端时,Studio 路由和 Agent 生图工具都会在启动任务前读取本地门店资料,统一补品牌 prompt 与参考素材。
- `/stores/me/logo`、`/stores/me/qrcode` 上传后的 `/uploads/...` 本地素材会自动并入 `reference_image_paths`,由 Seedream/方舟 JSON 路径转为 data URI 写入 `image/input_images`;绝对路径仍只接受本次前端显式 trusted refs,模型工具自己填的本机路径不会被读取。
- 品牌 prompt 会注入门店名、品牌风格、`brand_color`、logo/二维码角色说明;`print_mode=true` 且有本地二维码素材时,TS 会在网关图落盘后用 ffmpeg 右下角白底叠原始二维码,任务结果标记 `print_qr_overlay=ffmpeg/skipped/none`。
- 兼容口径:配置了 Python 媒体后端时 TS 品牌准备钩子旁路,旧后端继续按自己的 `poster_service` 品牌包逻辑处理,避免桌面本地 upload 根目录与旧后端不一致。
- 剩余口径:当前 TS overlay 不新增 native 图像库,也不解码后重生成二维码;如果老板给的二维码原图本身不可扫,仍需后续接 QR decoder/generator 或轻量图像库来追齐 Python 版“重生成真二维码”。
- 验证:`cd ts && bun test src/server/index.test.ts src/media/mediaJobs.test.ts` = 49 pass;`cd ts && bun run typecheck` clean。

## 3.46 2026-07-07 店铺资料库混合关键词排名追加落地

- `StoreDocsService.search()` 从简单词频加分升级为无依赖混合排名:完整短语命中、文件名命中、BM25 风格 IDF/词频饱和、chunk 长度归一、query term 覆盖率一起参与评分。
- 旧索引 JSON 结构不变,搜索时临时计算统计量;已有用户索引无需迁移,也不引入 embedding/native 依赖。
- 新增回归:重复“散客/会员”的噪声长文不能压过真正包含“散客转会员”完整短语的 SOP 文件,确保专有资料问答更接近“查原文出处”而不是机械词频。
- 口径:这是 TS 本地轻量 hybrid keyword,不是 Python/bge 级语义检索;后续若接本地 bge 或网关 embedding,应与这个关键词分数做 RRF/融合,继续只作用于老板自己的资料侧。
- 验证:`cd ts && bun test src/server/services/storeDocsService.test.ts src/server/index.test.ts` = 45 pass;`cd ts && bun run typecheck` clean。

## 3.47 2026-07-07 视频工作台本地素材 QC 追加落地

- `VideoEditProjectStore.createLocalPlan()` 在 TS fallback 下新增 ffprobe 轻量探测:读取本机素材真实时长、分辨率、fps、codec 与是否有音轨,并把结果写入 `footage_health/health_summary/warnings`。
- 本地 timeline 不再盲目把每段素材时长写成目标均分值:有探测结果时 `doc.media.*.duration` 使用真实素材时长,片段 `src_out` 只按目标剪辑长度截取且不会超过素材可用时长;ffprobe 缺失或远程素材不可探测时继续按旧默认时长兜底。
- 口播模式会对无音轨素材给出软提醒并把 `has_speech:false`,但不阻塞预览方案;前端视频工作台在右侧控制台展示“素材提醒”,风格沿用 Work Buddy/Codex 式克制提示,不加装饰挂件。
- `/video-edit/inventory` 与 `/auto_plan(_v2)` 的 TS fallback 现在还会返回轻量 `candidates`,旧前端若走 inventory 也能拿到候选段基础信息。
- 口径:这是无 Python/无 VLM 时的本地素材体检和可预览兜底;真正的高光挑选、ASR 转写、音乐响度、模板离屏渲染仍在后续 TS/native 迁移项里。
- 验证:`cd ts && bun test src/server/index.test.ts` 覆盖真实时长写 timeline 与口播无音轨提醒;前端类型检查待本轮总验证一起跑。

## 3.48 2026-07-07 Coding Agent 只读工具并行追加落地

- `runAgentLoop()` 不再把同一轮里的全部工具调用机械串行化:无 hook、无审批/动态风险函数、无用户交互的只读工具会进入并行批次,典型覆盖 `read_file/list_dir/glob_files/grep_files` 这类 coding 场景高频工具。
- 写文件、运行命令、审批类、`AskUserQuestion`、`ExitPlanMode`、带 hooks 的会话仍保持顺序执行;权限瀑布、same-call guard、todo/progress/reminder 语义不变。
- 并行批次的执行可以同时启动,但回灌给模型的 `tool_result` 仍按模型原始 tool_call 顺序排列,避免上下文顺序因竞速而漂移。
- 新增回归:两个慢只读工具必须同时启动,且第二轮模型看到的 tool_result 顺序仍为 A/B;权限与文件工具相关测试同步覆盖。
- 口径:这是对齐 CC-Haha/Claude Code 风格的行为级性能增强,相关实现可直接复制/抄/移植/改写;目标是让 coding agent 在读文件/搜代码/列目录这些高频动作上少等串行 IO。
- 验证:`cd ts && bun test src/harness/loop.test.ts src/permissions/resolve.test.ts src/tools/fileTools.test.ts`;`cd ts && bun run typecheck` clean。

## 3.49 2026-07-07 Coding Agent 批量读文件工具追加落地

- 新增默认工具 `read_many_files`:模型在 `glob_files/grep_files` 后可一次读取多份相关代码文件,减少“一个文件一个工具调用”的轮次损耗。
- 工具内置硬上限:最多 20 个文件、单文件默认 80KB/最高 200KB、总输出默认 300KB/最高 800KB;超限会标记 `truncated` 或 `skipped="total_limit"`,避免把大仓库一次塞爆上下文。
- 已读取文件会像 `read_file` 一样写入 `ctx.fileReads` 快照,所以后续 `edit_file` 仍能复用“先读、再校验 mtime/size、再改”的防覆盖链路。
- 错误按文件粒度返回,单个缺失文件不会让整批上下文读取失败;路径边界仍走 `Workspace.resolve(...,'read')`,越界/TOCTOU 防线不绕过。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts src/tools/generalTools.test.ts src/harness/loop.test.ts`;`cd ts && bun run typecheck` clean。

## 3.50 2026-07-07 Coding Agent 原子批量编辑工具追加落地

- 新增默认工具 `multi_edit_file`:同一文件内多个 string replacement 可在一次工具调用里完成,减少模型多轮 `edit_file` 往返,适合重命名、同步改 import/类型/调用点这类 coding 高频场景。
- 安全链路沿用 `edit_file`:必须先 `read_file/read_many_files`,写前校验 mtime/size,写前 `recordFileSnapshot()` + `workspace.backup()`,完成后返回 `<file_change ... backup_path=...>` 供右侧 diff/恢复链路实时打开。
- 工具按 edits 顺序在内存里试算,任一 edit 找不到或非 `replace_all` 下命中多处都会整体失败且不落盘;成功时只写一次文件、只产生一次历史快照。
- `file_history/restore_file` 已识别 `op:multi_edit_file`,可像单次编辑一样回滚。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts src/tools/generalTools.test.ts src/harness/loop.test.ts`;`cd ts && bun run typecheck` clean。

## 3.51 2026-07-07 Coding Agent 命令执行输出控制追加落地

- `run_command` 新增可选 `timeout_ms` 与 `max_output_bytes`:默认仍是 30s 超时,旧 `{ command }` 调用完全兼容;模型跑长测试/构建时可显式放宽超时或收紧日志预算。
- 命令输出改为有界 tail buffer,按 stdout/stderr 到达顺序保留合并尾部,默认 64KB、最高 1MB;大日志会明确标记 `输出截断:true`,优先留下最后的失败堆栈、测试摘要和编译错误。
- 结果文本统一为终端块可解析格式:包含 `命令/返回码/耗时/超时/中止/信号/输出截断` 元数据,超时 kill 后返回 `[退出码 -1]` 而不是模糊的 `[退出码 null]`。
- 权限与沙箱行为保持原口径:危险命令硬拒、动态审批仍只按 `command` 分类,沙箱包裹后的 argv/env 路径不变。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts src/tools/generalTools.test.ts` = 19 pass。

## 3.52 2026-07-07 Coding Agent 命令实时进度流追加落地

- Agent 事件集新增 `tool_progress`:TS loop 会给非并行工具执行挂 `ctx.progressEmit`,执行中事件带回原 `tool_call` id,前端可把增量回填到正确步骤。
- `run_command` 在 stdout/stderr 到达时实时推 progress chunk,前端既有 `LiveTerminalBlock` 不再空置;长测试/构建时用户能看到命令确实在跑。
- 并行只读批次仍不挂 progress 回调,避免多个工具同时写同一个进度槽导致步骤 id 串线;这与只读并行优化互不冲突。
- 实时输出同样做预算保护:后端最多按 `max_output_bytes` 推 live chunk 并给出省略提示,前端也把每个步骤的 live progress 限制在 64K 字符;最终 tool_result 继续用 tail buffer 保留失败尾部。
- 验证:`cd ts && bun test src/harness/loop.test.ts src/tools/runCommandTool.test.ts src/server/index.test.ts`;`cd ts && bun run typecheck`;`cd web && pnpm exec tsc --noEmit` clean。

## 3.53 2026-07-07 Coding Agent 命令进程组与环境隔离追加落地

- `run_command` 在 POSIX 下使用独立进程组启动命令,超时/中止时优先 `SIGKILL` 整个进程组,避免只杀 shell 而留下测试子进程、watcher 或构建孙进程。
- 子进程环境不再原样继承模型/网关密钥:会剥离 `*_API_KEY`、`*_TOKEN`、`*_SECRET`、`*_PASSWORD` 以及 `OPENAI/ANTHROPIC/ARK/QF_GATEWAY/VIDEO/IMAGE_*` 等 provider 变量;沙箱自身注入的 env 仍可叠加。
- Windows 路径保持原 `cmd /c` + 直接 kill 口径,不伪装 OS 级进程组能力;Windows Job Object 仍在后续真机 smoke 项里验证。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts` = 18 pass;`cd ts && bun run typecheck` clean。

## 3.54 2026-07-07 Coding Agent 大仓库检索输出预算追加落地

- `list_dir` 新增 `limit` 参数并默认限制 200 项、最高 1000 项;目录过大时返回明确截断提示,避免模型把 `node_modules` 同级大目录一次 dump 进上下文。
- `glob_files` 在达到文件上限时追加截断提示,让模型知道需要缩小 `pattern/path` 或提高 `limit`,而不是误以为仓库只有这些文件。
- `grep_files` 从逐文件串行读升级为 16 并发批次扫描,仍保持原 `path:line:text`/`path-line:text` 输出格式,并继续跳过 `.env`/key/token/secret 等敏感文件。
- `grep_files` 对超长单行做 2000 字符封顶,并在匹配行数或文件扫描上限命中时追加提示;大仓库里搜常见词不会再把上下文撑爆或静默丢尾部。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts src/tools/generalTools.test.ts src/harness/loop.test.ts` = 60 pass;`cd ts && bun run typecheck` clean。

## 3.55 2026-07-07 Coding Agent unified diff 补丁工具追加落地

- 新增默认工具 `patch_file`:模型可把复杂多行代码修改作为单文件 unified diff 一次应用,减少多个 `old_string` 拼接失败和多轮往返。
- 安全链路沿用文件编辑底座:必须先 `read_file/read_many_files`,写前校验 mtime/size,patch 按 hunk 精确上下文匹配,任一 hunk 失败则整体不落盘。
- 成功时只写一次文件,只生成一次 `recordFileSnapshot()` 与 `.backups` 备份,返回 `<file_change ... backup_path=...>` 和 `<patch_context>` 供右侧 diff/恢复链路实时打开。
- `file_history/restore_file` 已识别 `op:patch_file`;前端工具标签、自动文件改动预览和步骤详情预览同步识别 `patch_file` 与 `multi_edit_file`,不会漏掉 diff。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts src/tools/generalTools.test.ts src/harness/loop.test.ts` = 62 pass;`cd ts && bun run typecheck`;`cd web && pnpm exec tsc --noEmit` clean。

## 3.56 2026-07-07 Coding Agent 代码结构速览工具追加落地

- 新增默认工具 `code_outline`:模型可先对一个或多个代码文件提取 imports/use/from/require 与主要 symbols,再决定要不要 `read_file/read_many_files` 精读,减少大文件盲读。
- 工具最多一次处理 20 个文件、单文件只读前 400KB,每文件默认最多 120 个 symbol、最高 300 个;输出会标记 `truncated`,避免把长文件结构一次塞爆上下文。
- 轻量规则覆盖 TS/JS 的 `function/class/interface/type/enum/const/method`,Python 的 `class/def/async def`,以及 Rust/Go 的常见 `fn/struct/enum/trait/func/type`,不引入重型 AST 依赖。
- `code_outline` 不写入 `ctx.fileReads`,所以不会绕过 `edit_file/patch_file` 的“先精读再编辑”保护;它只作为导航工具。
- 前端工具标签新增“看代码结构”,步骤列表不再显示裸工具名。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts src/tools/generalTools.test.ts src/harness/loop.test.ts` = 64 pass;`cd ts && bun run typecheck` clean。

## 3.57 2026-07-07 Coding Agent 局部读文件追加落地

- `read_file` 新增可选 `start_line/end_line/max_bytes`:不传这些参数时仍返回原始完整文件,兼容旧模型调用;传行段后返回 `<file_chunk ...>` 元数据与精确片段内容。
- 省略 `end_line` 时默认只读 200 行,显式范围最多 1000 行;片段输出默认 120KB、最高 300KB,命中上限会标记 `truncated_bottom/truncated_bytes/truncated_range`。
- 局部读取仍记录整文件 mtime/size 到 `ctx.fileReads`,所以后续 `edit_file/multi_edit_file/patch_file` 继续要求先读、写前校验文件未被外部改动,不会绕开防覆盖链路。
- 这个能力和 `code_outline/grep_files` 组合后,模型可以先看结构/命中行,再只读相关代码段,减少大文件盲目全量 dump 对速度和上下文预算的伤害。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts src/tools/generalTools.test.ts src/harness/loop.test.ts` = 66 pass;`cd ts && bun run typecheck` clean。

## 3.58 2026-07-07 Coding Agent patch 失败诊断追加落地

- `patch_file` 保持原子 exact-context 语义不变,但 hunk 上下文不匹配时会返回更可操作的错误:当前行期望/实际、建议重新 `read_file { start_line,end_line }` 的局部范围。
- 如果期望行在文件其他位置出现,错误会列出最多 3 个候选行号;如果只是 trim 后一致,会提示“仅空白差异候选”,方便模型下一轮快速修正 hunk header 或上下文缩进。
- 失败路径仍不写文件、不创建 file history 快照、不刷新读快照;这只是诊断增强,不是 fuzzy apply,避免误改相似代码块。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts src/tools/generalTools.test.ts src/harness/loop.test.ts` = 67 pass;`cd ts && bun run typecheck` clean。

## 3.59 2026-07-07 Coding Agent literal 检索追加落地

- `grep_files` 新增 `literal` 参数:默认仍按 JavaScript regex 搜索,但 `literal:true` 会把 `.`、`(`、`[`、`*` 等正则元字符当普通文本处理。
- 非法 regex 自动退回 literal 的旧兼容口径保留;新增参数解决的是“合法但语义不想当 regex”的代码搜索场景,例如查 `foo.bar`、`useEffect(`、具体 JSX 片段。
- 并发扫描、敏感文件跳过、单文件 1MB 上限、长行截断和结果 limit 逻辑不变。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts src/tools/generalTools.test.ts src/harness/loop.test.ts` = 68 pass;`cd ts && bun run typecheck` clean。

## 3.60 2026-07-07 UI 时间线与设计文档状态校准

- 复核 `docs/references/竞品拆解/02-前端设计-配色与质感.md`、`03-文案话术与交互设计.md`、`04-对我们项目的借鉴-批判筛选.md` 与 `docs/design/桌面Agent-macOS设计规范.md`:确认 2026-07-05 owner 已拍板“走法 B”(砍蓝、绿点缀、主按钮/用户气泡中性)。
- 反查当前代码:`web/src/app/globals.css` 已有 `--app-*` token、`app-primary-action/app-active-neutral`;`rg` 未再发现 `#007AFF/#0a84ff` 主体系用色,欢迎屏也已按 Work Buddy/Codex 方向收成轻量 action + 2 条起手建议。
- 知识库抽屉现状与文档一致:入口统一叫“知识库”,内部按“行业知识 / 店铺文件 / 门店记忆”三源分层;店铺文件检索和行业静态知识保持隔离。
- 生图/视频工作台现状与主 UI 配色一致:主 CTA 走中性,绿只作图标/状态/焦点/选中点缀;视频工作台素材提醒用克制提示,无装饰挂件。
- 已把 7 月 5 日文档里“代码尚未落地/待施工”的旧备注改成 2026-07-07 已落地口径,避免后续会话被过期状态带偏。

## 3.61 2026-07-07 Coding Agent 项目诊断工具追加落地

- 新增默认工具 `project_diagnostics`:从给定 `path` 向上寻找最近 `package.json`,自动选择安全 `typecheck/check:types/lint/check` 脚本;`check:"test"` 必须显式请求。
- 工具只跑 package script,不接受模型拼任意命令;执行前会拒绝 `--fix/--write/--update/--watch`、重定向、安装/发布、网络/远程访问、明显文件写改/删除等副作用脚本。
- 输出带 `<project_diagnostics ...>` 元数据,包含 package/cwd/check/script/manager/exit_code/timed_out/truncated 与有界 tail output;默认 60s 超时、80KB 输出,最高 300s/500KB。
- 权限口径:自动/typecheck/lint 在 plan 档也可做只读探索;显式 test 按 file 类动作处理,`plan` 档跳过、`auto_files/full` 可放行,避免测试脚本暗写快照或缓存。
- 前端工具标签新增“跑项目诊断”,步骤列表不再显示裸工具名。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts src/tools/generalTools.test.ts src/harness/loop.test.ts` = 71 pass;`cd ts && bun run typecheck` clean。

## 3.62 2026-07-07 Coding Agent 验证纪律与审批 diff 收口

- 系统提示新增“改动后的验证”段:只要模型改了代码/配置/脚本/前端样式,收尾前应优先用 `project_diagnostics` 在改动文件附近跑安全 `typecheck/lint` auto 检查;有行为风险时再显式跑测试或聚焦命令。
- 验证失败/缺脚本/脚本被安全规则拒绝时,提示要求模型不能假装通过,必须说明未验证原因与残余风险;`systemPrompt.test.ts` 已锁住 `project_diagnostics`、`typecheck/lint` 与“别假装通过”约束。
- `project_diagnostics` lint 白名单补充 `next lint`,避免 Web/Next 包只有 lint 脚本时 auto 诊断找到脚本却误判为“不像静态检查命令”。
- `web/package.json` 固化 `typecheck: tsc --noEmit`,让 `project_diagnostics` 在 Web 文件附近也能优先跑类型检查,不再只能依赖手工 `pnpm exec tsc --noEmit`。
- 前端 `MacApprovalCard` 新增审批 preview diff 渲染:识别 unified diff hunk 后复用 `DiffBlock` 做行级+字符级高亮;普通审批文案仍保持原纯文本预览。
- 新增 `approval-preview-diff.ts` 与 Vitest 覆盖单 hunk、多 hunk 和普通文案不误判,与右侧 diff/文档 diff 共享同一视觉底座。
- 验证:`cd ts && bun test src/harness/systemPrompt.test.ts src/tools/generalTools.test.ts src/tools/fileTools.test.ts` = 42 pass;`cd ts && bun run typecheck`;`cd web && pnpm exec vitest run src/components/desktop/approval-preview-diff.test.ts src/components/desktop/safe-markdown.test.ts` = 5 pass;`cd web && pnpm run typecheck` clean。

## 3.63 2026-07-07 桌面 Agent 状态线基础版落地

- `DesktopChatShell` 新增输入区上方轻量 `AgentStatusLine`,把原先零散的“工作台/工作区”提示收成一条状态线,不再额外堆卡片。
- 状态线显示专家挂载、权限档、当前会话消息数、已挂附件数、当前工作区、本月用量和运行中状态;贴合 Codex/WorkBuddy 的低调状态栏方向,让代码修改场景下的权限/上下文一眼可见。
- 后续 3.67 已补 Git 分支摘要,3.71 已补真实 usage/token 上下文占用;未返回 usage 的 provider 不伪造 token 数字。
- 验证:`cd web && pnpm run typecheck` clean;Playwright 打开 `http://localhost:3100/dashboard/chat` 并截图核验,状态线位于输入框上方且未与欢迎内容/输入区重叠(临时截图产物已清理)。

## 3.64 2026-07-07 Coding Agent 项目指令注入基础版落地

- `buildSystemPrompt` 新增项目级指令加载:从当前 workspace 根目录读取 `AGENTS.md` 与 legacy 指令文件,包进 `<project_instruction>` 块注入系统提示,让 Agent 每轮能遵守仓库本身的工程规约。
- 指令注入带单文件 24KB 上限和 `truncated` 标记,避免大仓库指令文件把上下文撑爆;内容做 XML 转义,不破坏系统提示结构。
- 注入段明确项目指令不能覆盖系统身份、权限、安全、验证与用户最新要求,继续维持白标和审批闸优先级。
- 3.79 已补目录级动态合并:`read_file/read_many_files` 会按目标路径追加适用的子目录 `AGENTS.md/CLAUDE.md`,让后续 `edit_file/patch_file` 遵守更近目录规则。
- 验证:`cd ts && bun test src/harness/systemPrompt.test.ts src/server/index.test.ts` = 51 pass;`cd ts && bun run typecheck` clean。

## 3.65 2026-07-07 Workspace slash commands 追加落地

- `commandLoader` 新增多根合并入口:`server/commands` 作为内置命令根,当前 workspace 的 `.claude/commands` 与 `.codex/commands` 作为项目命令根,后加载的项目命令可覆盖同名内置命令。
- `/commands` 与 `/api/commands` 的 GET 现在读取 `working_dir`/`workspaceRoot` 查询参数,让前端 `/` 命令面板按当前项目展示自定义 prompt command,不再只看内置目录。
- `/agent/run`、`prewarm`、审批执行 registry 与 `/api/commands/expand` 统一走 `loadCommandsForWorkspace`,用户输入 `/name args` 时会从当前项目命令文件展开 prompt,并继续写入 `command_invocation` 事件用于 replay。
- `web/src/lib/api.ts` 的 `listCommands(workingDir)` 与 `DesktopComposer` 已接线:工作目录变化会重新拉取命令,保证切项目后 `/` 面板不残留旧项目命令。
- 验证:`cd ts && bun test src/commands/commandLoader.test.ts src/server/index.test.ts` = 50 pass。

## 3.66 2026-07-07 审批后文件改动预览收口

- 修复 ask 权限档下“用户确认文件修改后只显示原始 `<file_change>` 文本、不打开右侧 diff”的断点:审批执行返回 `file_change` 后会立即触发 `onFileChange`,右侧预览打开同一套改前/改后 diff。
- 审批后文件修改消息不再退化为普通文本,而是渲染成已完成的工具步骤;中间对话流保留可点开的修改记录,与自动执行路径的 `tool_result` 展示口径一致。
- 新增 `approved-tool-result-message.ts` 纯逻辑模块,把审批后命令/视频/文件修改结果的渲染路由固定下来,避免后续改 UI 时把文件 diff 回退成裸标签。
- 验证:`cd web && pnpm exec vitest run src/hooks/use-agent-chat.test.ts` = 2 pass;`cd web && pnpm run typecheck` clean。

## 3.67 2026-07-07 桌面状态线 Git 摘要追加落地

- 新增 `getWorkspaceGitStatus()` 与 `parseGitStatusPorcelain()`:通过 `git --no-optional-locks status --porcelain=v1 --branch` 解析当前工作区是否为 git 仓库、分支名、dirty、staged/unstaged/untracked 数量以及 ahead/behind,不把文件名暴露给状态线。
- 新增 `GET /api/v1/agent/workspace-status?working_dir=...`:桌面前端按当前工作目录获取轻量项目状态,和 coding agent 的实际工作根保持一致。
- `AgentStatusLine` 新增 Git chip:`main · 3改` / `main · clean` / `↑2 ↓1`,任务开始/结束与工作目录变化时刷新,让用户在代码修改后直接看到项目是否变脏。
- 视觉核验:本地打开 `http://localhost:3000/dashboard/chat`,状态线高度 24px、与输入框间距约 21px,未与欢迎内容或输入区重叠。
- 验证:`cd ts && bun test src/harness/env.test.ts src/server/index.test.ts` = 52 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm run typecheck` clean。

## 3.68 2026-07-07 店铺资料库可解释检索追加落地

- `StoreDocsService.search()` 返回结构化来源字段:`source_id`、`confidence`、`matched_terms`、`why`、`score` 与 `excerpt`,让模型和前端都能看到“为什么这段资料被召回”,避免只给一段无来源文本。
- `search_store_docs` 工具输出改为 `<store_doc_sources>` 包,提示模型回答时按 `S1/S2` 引用店铺文件;如果资料不足要明确说明,不把行业常识伪装成店铺文件事实。
- `StoreDocsPanel` 新增“试搜店铺文件”检索区:资料库 ready 后可直接搜关键词,结果显示来源编号、文件名、可信度、摘录和匹配词;这是实际检索入口,不是欢迎卡或装饰说明。
- 文案口径从“语义索引”改为“本地索引/检索”,诚实反映当前是关键词 + 短语 + 文件名混合排名;embedding/RRF 仍留后续升级。
- 验证:`cd ts && bun test src/server/services/storeDocsService.test.ts src/server/index.test.ts` = 50 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm run typecheck` clean。

## 3.69 2026-07-07 工具调用呈现收口

- `web/src/lib/agent-tools.ts` 新增 `toolActionText()`:工具步骤不再只显示名词标签,而是按 pending/running/done 显示“准备/正在/已…”动作文案;MCP/未知工具走“调用 …”口径,避免中文前缀贴到裸工具名上。
- `MacStepList` 将连续相同工具合成一组,组头显示动作、数量和关键参数摘要,展开后仍能逐条查看结果/终端输出/右侧预览入口;读文件、grep、批量命令等 coding 场景不再刷出一长串重复行。
- 运行中判定从“只有最后一步算运行中”改为“所有未完成步骤都算运行中”,并让 spinner 取最近的未完成步骤;只读并发批次时 UI 不会误显示某个仍在跑的步骤已经停了。
- 步骤行补充参数提示(`path/query/command/url/name` 等)并继续保留文件改动 diff、命令实时终端、普通结果折叠三条路径,不改后端 SSE 契约。
- 验证:`cd web && pnpm test` = 4 files / 9 tests pass;`cd web && pnpm run typecheck` clean;`git diff --check` clean。

## 3.70 2026-07-07 SSE 断线重连可见横幅追加落地

- `useAgentChat` 新增结构化 `retryStatus`:SSE 连接异常断开后,重连等待阶段显示 delay 与第 N/M 次尝试;实际重新发起订阅时切到“正在重连”状态。
- 一旦重连后收到任意新事件,横幅自动收起;正常 `done`、应用层 error、手动停止、切会话、新任务启动都会清理状态,不会把恢复提示写进历史消息。
- `DesktopChatThread` 在实时回答区渲染低调恢复横幅,长时间 coding/测试任务遇到网络抖动时,用户能看到系统在接续而不是误以为 Agent 卡死。
- 新增 `agent-retry-status.ts` 纯逻辑模块和 Vitest 覆盖等待/重连文案;后续 provider failover/切非流式事件可复用这个横幅入口,但当前尚未接完整后端降级事件。
- 验证:`cd web && pnpm test` = 4 files / 10 tests pass;`cd web && pnpm run typecheck` clean;`git diff --check` clean。

## 3.71 2026-07-07 上下文/usage 指示器追加落地

- `ModelUsage` 从 OpenAI-compatible proxy 与 Anthropic messages 适配器透传到 `AssistantStep`;只有 provider 明确返回 usage 时才携带,避免无 usage 响应被显示成假的 `0/0`。
- `runAgentLoop` 新增 `usage_update` 事件:累计 input/output/cache token,同时保留最新一步 input/output;server 按模型名和 `CLAUDE_CODE_MODEL_CONTEXT_WINDOWS` 推断窗口,给出约占比。
- legacy task SSE、`api.subscribeAgentTask()` 与 `useAgentChat` 已接线;`AgentStatusLine` 现在显示“上下文:≈N% · 本轮 X · 最新 Y · 缓存 Z”和独立“本月”成本 chip。
- 新增 `agent-usage-status.ts` formatter 与测试;模型无 usage 时前端保持 `—`,不虚构 token 数据。
- 验证:`cd ts && bun test` = 379 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm test` = 4 files / 12 tests pass;`cd web && pnpm run typecheck` clean;`git diff --check` clean。

## 3.72 2026-07-07 审批卡三档与本会话记忆追加落地

- `approval_request` 事件新增 `rememberable` 字段:仅普通可重复动作展示“本会话允许”;`forceConfirm`、必须人工交互、花钱、破坏性动作都不会出现记忆选项。
- 后端新增本会话 approved action 记录:用户点“本会话允许”后,只有同一 conversation 内工具名与参数完全相同的动作会自动执行;拒绝会清理对应记忆并继续写入 denial tracking。
- `executeApproved(..., remember)` 只在 token 校验通过且工具成功执行后记录记忆,避免把失败/伪造的审批写成长期放行。
- 前端审批卡统一为“拒绝 / 允许一次 / 本会话允许”,并保留具体动作 title;审批 diff 仍走结构化预览。拒绝后的反馈输入框尚未实现,继续留在阶段0待补。
- 验证:`cd ts && bun test src/harness/loop.test.ts src/permissions/denialTracking.test.ts`;`cd ts && bun run typecheck`;`cd web && pnpm test`;`cd web && pnpm run typecheck` 已在本轮局部跑通,最终全量验证见本轮收尾。

## 3.73 2026-07-07 同步子代理轨迹可见追加落地

- `agent_task` 在内部 `runAgentLoop` 运行时会把子代理开始、思考、工具调用、工具完成、结论汇成父工具的 `tool_progress(stream=subagent)`;不新增 SSE 类型,继续走既有任务重放和断线续传链路。
- 模型可见输出仍保持 `<agent_task agent="...">final</agent_task>`,不把子代理全量 transcript 塞回父模型上下文;UI 可见性和模型上下文预算解耦。
- 前端新增 `subagent-trace` 解析 helper 与测试,`agent_task` 结果不再 raw 展示 XML,而是在工具步骤下渲染“子代理 · agent · task”轨迹卡,可展开查看最近轨迹和最终结论;`start_background_agent_task` 也收成“后台子代理已启动”芯片,显示 task id/agent/status。
- 主对话里的后台任务芯片新增“查看过程”:点击直接打开右侧后台任务抽屉并定位到该 task;抽屉会调用 `/tasks/:id?includeEvents=1` 拉取事件流,用 `background-task-events` helper 格式化为可读轨迹。
- 工具文案补齐 `agent_task` / `start_background_agent_task`,执行过程会显示“正在分派子代理”,不再退回裸工具名。
- 剩余口径:后台子代理已有 task drawer、事件日志、主对话启动芯片和点击查看事件流;完成通知跳转仍可继续 polish。
- 验证:`cd ts && bun test src/agents/agentTool.test.ts src/harness/loop.test.ts`;`cd ts && bun run typecheck`;`cd web && pnpm test src/components/desktop/subagent-trace.test.ts src/components/desktop/background-task-events.test.ts src/lib/agent-tools.test.ts`;`cd web && pnpm run typecheck` clean。

## 3.74 2026-07-07 非流式模型降级可见追加落地

- `AssistantStep` 新增可选 `notices`,主循环统一转成 `context_note`;这条通道可复用给后续 provider failover/降级说明,不新增前端事件类型。
- `ProxyModel` 请求 OpenAI-compatible 网关时仍要求 `stream:true`;如果上游返回 200 JSON 非 SSE,会继续按完整响应解析,同时发出“供应商本轮没有按流式返回,已自动按完整响应接回。”低调提示。
- 若上游返回 200 但 body 连 JSON 都不可解析,仍保持既有安全降级为空 final,并补 `context_note` 说明“非流式但内容不可解析”,避免用户误以为 agent 静默卡死。
- 前端沿用已有 `context_note` 灰色内联条显示,不把它做成错误 toast;这是真实降级提示,不是假 failover。
- 验证:`cd ts && bun test src/proxy/ProxyModel.test.ts src/harness/loop.test.ts`;`cd ts && bun run typecheck` clean。

## 3.75 2026-07-07 provider fallback 可见降级追加落地

- 新增 `FallbackModel`:当 active saved provider 调用失败时,会按候选顺序尝试备用模型出口;本轮已接 active provider -> env provider,CC-Haha 相关策略可直接复制/抄/移植/改写。
- `ProviderService.resolveRuntimeConfigs()` 现在返回候选运行时列表:保存的 active provider 排第一,环境变量出口作为 distinct fallback;同一 apiFormat/baseUrl/model 会去重,避免重复打同一网关。
- `/agent/run`、会话归档压缩和 `/agent/prewarm` 统一使用候选 provider 构建模型;`/model` 与 prewarm 响应增加 `fallbackCount`,方便前端状态线后续显示“有备用出口”。
- fallback 成功时会把“哪个出口失败、已切到哪个备用出口”作为 `AssistantStep.notices` 进入 `context_note`;错误文案会脱敏 Bearer/api-key 等密钥片段,不会把 key 写进 SSE/history。
- fallback 在同一个 turn 内是 sticky 的:一旦备用出口成功,后续工具循环的 `model.step()` 会直接从该出口开始,避免 coding 任务里每轮都先等已失败的主出口超时。
- 前端 `AgentStatusLine` 已读取 `/api/model` 并在存在备用出口时显示“备用出口:N”轻量 chip;不新增欢迎卡或弹窗,保持 Work Buddy/Codex 式克制状态线。
- 当前策略仍是单轮线性 failover,3.77 已补多 saved provider 候选;provider 健康度缓存、指数退避和跨会话熔断仍属下一阶段 polish。
- 验证:`cd ts && bun test src/model/FallbackModel.test.ts src/server/services/providerService.test.ts src/server/index.test.ts` = 54 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm test`;`cd web && pnpm run typecheck` clean。

## 3.76 2026-07-07 旧 BYOK 设置到 ProviderService 兼容桥追加落地

- 旧前端 `/api/v1/stores/me/byok` 仍保留给设置抽屉高级区;保存文字模型配置时,TS server 现在会同步创建/更新固定 `byok-text` saved provider 并激活它。
- 只改 base/model 不重贴 key 时会沿用 `byok-text` 里已保存的 key;没有旧 provider 且没有新 key 时只保存展示配置,不伪造可用 provider。
- 这条桥避免“设置抽屉保存 BYOK,真实 Agent runtime 却仍走 env/旧 active provider”的架构割裂;当前高级 UI 仍默认隐藏,但接口语义已经和新内核对齐。
- 明文 key 只用于写 ProviderService,旧 BYOK 响应仍只返回 mask,测试锁住不把 key 回显到 JSON。
- 验证:`cd ts && bun test src/server/index.test.ts src/server/services/providerService.test.ts src/model/FallbackModel.test.ts` = 55 pass;`cd ts && bun run typecheck` clean。

## 3.77 2026-07-07 多 saved provider 候选 failover 追加落地

- `ProviderService.resolveRuntimeConfigs()` 现在在 active saved provider 之后,会按保存顺序加入其它 saved provider 作为备用候选,最后才追加 distinct env fallback。
- 同一 apiFormat/baseUrl/model 仍会去重:如果另一个 saved provider 或 env 指向同一运行目标,不会重复打同一个网关。
- 用户显式切到 env/default(`activeId=null`)时仍尊重选择,不会偷偷把已保存 provider 纳入候选链;这避免“我已经切回内置/环境变量,却又跑到旧 BYOK provider”的惊喜。
- `/agent/run` 集成测试已覆盖 primary saved provider 失败后先切 backup saved provider,且不会继续打 env;SSE 仍只输出脱敏失败原因和切换提示。
- 验证:`cd ts && bun test src/server/services/providerService.test.ts src/server/index.test.ts src/model/FallbackModel.test.ts` = 56 pass;`cd ts && bun run typecheck` clean。

## 3.78 2026-07-07 provider 健康冷却与跨回合少等追加落地

- `FallbackModelCandidate` 新增 `onFailure/onSuccess` hook,由 server 记录 provider 运行时健康状态;callback 故障不会影响模型输出或错误回灌。
- server 内存维护 provider 健康冷却:某出口失败后会短时间标记为 cooling,后续回合构建候选链时先尝试健康备用出口,冷却过期后自动恢复原顺序。
- 冷却不写入用户配置、不改变 active provider,只是当前 server 进程内的运行时排序优化;所有 provider 都在冷却时仍保持原始顺序,避免无出口可用时被过滤到 503。
- 如果 active provider 因最近失败被挪后,`/agent/run` 会先发 `context_note`:“模型出口…最近失败;本轮先尝试…”,继续保持可见降级,不静默换模型。
- 新增集成测试覆盖第一回合 primary 失败切 backup,第二回合直接从 backup 起步且不再打 primary;错误文案继续脱敏 Bearer/api-key。
- 验证:`cd ts && bun test src/model/FallbackModel.test.ts src/server/services/providerService.test.ts src/server/index.test.ts` = 57 pass;`cd ts && bun run typecheck` clean。

## 3.79 2026-07-07 目录级项目指令动态合并追加落地

- 新增 `ts/src/harness/projectInstructions.ts`:统一收集/截断/转义 `AGENTS.md` 与 legacy 指令文件,支持按目标路径从 workspace 根目录一路合并到文件所在目录。
- `buildSystemPrompt` 继续只注入根级项目指令,避免每轮把大仓库所有子目录规则塞进 system;目录级 override 改为在读取目标文件时动态补充。
- `read_file` 读取普通代码文件时,若上级目录存在适用的 `AGENTS.md/CLAUDE.md`,会在文件内容前追加 `<project_instruction>` 块;读取指令文件本身时不套娃。
- `read_many_files` 会对一批目标文件合并去重后的目录级指令,同一 `src/AGENTS.md` 只出现一次;后续 `edit_file/multi_edit_file/patch_file` 因为已有读前置保护,自然能在改动前看到这些规则。
- `write_file` 新建/覆盖目标若命中尚未展示过的目录级指令,会先安全暂停并把指令回灌给模型,要求按相同 path/content 重试;避免新建文件绕过子目录规约。
- 当前策略仍不扫描全仓库所有 instruction 文件,只按被读/被写目标路径注入,更贴近 coding agent 的上下文预算纪律。
- 验证:`cd ts && bun test src/harness/systemPrompt.test.ts src/tools/fileTools.test.ts` = 45 pass;`cd ts && bun run typecheck` clean。

## 3.80 2026-07-07 provider 健康状态线追加落地

- `/model` 与 `/api/model` 新增 `health[]` 与 `coolingCount`:每个候选 provider 返回 label/model/state/failureCount/cooldownMsRemaining/lastError,错误仍沿用脱敏文案。
- `/model.runtime` 现在反映“下一轮实际会优先尝试”的出口:如果 active provider 正在冷却,状态接口会显示健康备用出口,但 `activeId` 不变,不偷偷改用户配置。
- 前端 `AgentStatusLine` 在冷却存在时显示“出口冷却:N”轻量 chip,tooltip 写明失败次数、剩余秒数和脱敏原因;原“备用出口:N”继续保留。
- 设置抽屉“已内置、开箱即用”区新增简洁 AI 通道状态:普通用户只看到“正常/备用/冷却”,详细失败原因放 hover,不重新暴露高级模型配置表。
- 3.81 已把冷却状态从纯内存升级到独立 `provider-health.json`,仍不写 provider 配置、不自动换绑模型。
- 验证:`cd ts && bun test src/server/index.test.ts src/model/FallbackModel.test.ts src/server/services/providerService.test.ts` = 57 pass;`cd ts && bun run typecheck`;`cd web && pnpm exec vitest run src/hooks/model-health-status.test.ts src/components/desktop/approval-preview-diff.test.ts src/components/desktop/safe-markdown.test.ts` = 8 pass;`cd web && pnpm run typecheck` clean。

## 3.81 2026-07-07 provider 冷却跨重启持久化追加落地

- 新增 `ts/src/server/services/providerHealthStore.ts`:把 provider 失败次数、冷却截止时间、脱敏错误写入运行时 `provider-health.json`,与用户配置 `providers.json` 分离。
- server 重启后会读取 `provider-health.json`,如果 active provider 仍在冷却期,`/model.runtime` 和下一轮 `/agent/run` 会直接优先健康备用出口,避免长 coding 任务重启后又先等坏出口超时。
- 成功调用会清掉对应健康记录;过期冷却会在读取时自动清理;落盘失败只退化为当前进程记忆,不会影响对话。
- 集成测试覆盖:主 provider 失败后停 server、重启同一 `providerRoot`,下一轮直接打 backup,`providers.json` 不含冷却/错误字段,`provider-health.json` 不泄露 `sk-*`。
- 验证:`cd ts && bun test src/server/services/providerHealthStore.test.ts src/server/index.test.ts src/model/FallbackModel.test.ts src/server/services/providerService.test.ts` = 60 pass;`cd ts && bun run typecheck` clean。

## 3.82 2026-07-07 provider 健康手动复位与设置明细追加落地

- `ProviderHealthStore` 新增 `clear()` / `clearAll()`:可按 provider runtime key 精确移除冷却记录,也可批量清理当前运行时集合;仍只写 `provider-health.json`,不改 `providers.json`。
- 新增 `POST /api/model/health/clear` 与兼容 provider 路由 `/api/providers/:id/clear-health`:传 `{providerId}` / `{source}` / `{all:true}` 后清除对应冷却,并返回最新 `/model` 状态,前端无需自行猜排序。
- 设置抽屉“已内置、开箱即用”区新增折叠式“AI 通道详情”:默认仍只露一句健康状态;展开后可看主/备出口的就绪/冷却、脱敏失败原因和剩余冷却时间。
- 冷却行新增“重试”按钮:点击只允许该通道下一轮重新尝试,不会切换 active provider、不会改 key/model/baseUrl,也不会把失败密钥回显到 UI。
- 集成测试覆盖:primary 失败进入冷却后 `/model` 优先 backup;手动清除 primary 后 `/model.runtime` 回到 primary,`providers.json` 仍只含 provider 配置,响应不泄露 `sk-*`。
- 验证:`cd ts && bun test src/server/services/providerHealthStore.test.ts src/server/index.test.ts src/model/FallbackModel.test.ts src/server/services/providerService.test.ts` = 62 pass;`cd web && pnpm run typecheck` clean。

## 3.83 2026-07-07 店铺资料库语义扩展与 RRF 融合追加落地

- `StoreDocsService.search()` 在原有完整短语/文件名/BM25 排名外,新增无依赖 query profile:对门店资料常见问法做语义别名扩展,例如“黄金档台费”可召回资料里的“晚高峰收费 / 元/小时”。
- 排名改为两路融合:原词精确路保留高权重和完整短语 boost,语义扩展路低权重参与,再用 RRF 小幅融合排序;避免近义词召回把真正精确出处顶掉。
- `why` 现在区分“关键词命中”和“语义扩展命中”,前端/模型能看到为什么召回,不会把近义词命中伪装成原文精确命中。
- `matched_terms` 会合并直接命中词与语义扩展词,摘录定位也会优先落到真实命中的近义词附近,让老板试搜资料时更容易确认出处。
- 口径:这是本地、轻量、可解释的语义近似层,不是 bge/embedding;后续如接网关 embedding,仍应只作用于老板自己的资料侧,并继续与关键词/RRF 融合,不动静态行业策展知识库。
- 验证:`cd ts && bun test src/server/services/storeDocsService.test.ts` = 4 pass。

## 3.84 2026-07-07 print_mode Logo 安全区后处理追加落地

- `prepareStudioImageBody()` 在门店已上传 Logo 且 `print_mode=true` 时,除把 Logo 作为参考图给生图模型外,还会传 `_print_logo_path` 给 TS 媒体层。
- `MediaJobService.persistImageGenerationResult()` 新增 Logo 后处理:网关图落盘后先用 ffmpeg 把原始 Logo 叠到左上安全区(约 4% 边距、20% 画宽、白底留边),再叠右下二维码。
- 结果新增 `print_logo_overlay: ffmpeg/skipped/none`,与既有 `print_qr_overlay` 同口径;后处理失败只标 skipped,不让整张图任务失败。
- 这解决基础版“模型可能把 Logo 重绘糊/改字”的风险:印刷投放图至少能保留一份原始 Logo 像素级叠层;普通非 print_mode 创意图不强行盖 Logo。
- 剩余口径:二维码当前仍是原图叠层,未做 QR 解码后重生成;Logo 位置/尺寸目前是固定安全区策略,后续可继续做用户可调安全区/模板化落位。
- 验证:`cd ts && bun test src/media/mediaJobs.test.ts src/server/index.test.ts` = 60 pass;`cd ts && bun run typecheck` clean;`git diff --check` clean。

## 3.85 2026-07-07 print_mode QR 源图质检与边缘保真叠层追加落地

- `MediaJobService` 在 `print_mode=true` 且存在本地二维码素材时,会读取 PNG/JPEG/GIF/BMP/WebP 文件头,记录二维码源图宽高与质量状态。
- 低于 240px 的源图、明显非方形源图会在任务结果里返回 `print_qr_source_quality=warning`、`print_qr_source_warnings[]`、`print_qr_source_width/height`;无法读取尺寸时返回 `unknown`,但不阻断出图。
- 二维码 ffmpeg 叠层改为 `scale2ref(...:flags=neighbor)`,放大/缩放时尽量保留二维码硬边,避免默认插值把码点糊掉。
- 口径:这一步是“源图质量检查 + 原图边缘保真叠层”,不是 QR 解码/重新生成;如果用户上传的二维码内容本身不可扫或容错不足,仍需后续接 decoder/generator 或 native sidecar 重建真二维码。
- 验证:`cd ts && bun test src/media/mediaJobs.test.ts` = 8 pass;`cd ts && bun test src/media/mediaJobs.test.ts src/server/index.test.ts` = 61 pass;`cd ts && bun run typecheck` clean。

## 3.86 2026-07-07 TS 生图/改图自动路由追加落地

- `MediaJobService.directImageConfig()` 前新增纯 TS 路由层:请求显式传 `image_model/image_provider` 时尊重用户选择,但 `2:5` 易拉宝和 `5:2` 横幅仍强制走 Seedream 专属尺寸。
- 未显式选模型时,中文海报/硬文字要素/无明显信号默认走 `doubao-seedream-4-5-251128`;西文为主、`photorealistic/high fidelity/写实人像/复杂创意` 等场景走 `gpt-image-2`。
- 改图侧按 `edit_type` 或 prompt 粗略判断:错别字/改文字走 Seedream;换背景/加减元素等内容改动走 OpenAI-compatible edits,保留 `input_fidelity=high`。
- 打包默认同时存在 `IMAGE_MODEL_NAME=gpt-image-2` 与 `QF_GATEWAY_URL/QF_GATEWAY_TOKEN`,现在不会再把 env 的 GPT 当成前端手选;无 Seedream 网关时自动路由会退回 OpenAI-compatible,并在结果里写 `image_model_route_warning`。
- 自动路由到 OpenAI-compatible 且请求失败时,会用 Seedream 网关二跳重试;用户显式指定 GPT 时不偷偷切换,错误原因脱敏后写入 `image_model_route_warning`。
- Seedream JSON 生图请求新增轻量退避重试:429 或 5xx 默认最多重试 2 次,可用 `SEEDREAM_IMAGE_RETRIES/DESKTOP_IMAGE_429_RETRIES` 调整,避免短时限流直接让整次媒体任务失败。
- 结果新增 `image_model_route`、`requested_image_model`、`image_model_route_warning` 字段,方便前端/任务日志解释“为什么这张走了 Seedream/GPT”。
- 口径:这是旧 Python U2/U5 的可测路由规则迁移;当前二跳降级按整次媒体任务重试,还不是 Python 版“多张并发时单张失败单张降级”的完全同粒度实现。
- 验证:`cd ts && bun test src/media/mediaJobs.test.ts` = 14 pass;`cd ts && bun test src/media/mediaJobs.test.ts src/server/index.test.ts` = 67 pass;`cd ts && bun run typecheck` clean。

## 3.87 2026-07-07 provider 候选禁用与优先级排序追加落地

- `ProviderService` 的 saved provider 新增 `enabled` 字段,旧 `providers.json` 读取时默认 `enabled=true`,保证历史配置不迁移也能继续跑。
- `resolveRuntimeConfigs()` 只把 enabled 的 saved providers 放进候选链;禁用当前 active provider 时会自动把 active 切到下一个 enabled saved provider,只有用户显式清 active 才回到 env/default。
- 新增 provider 管理路由:`POST /api/providers/reorder` 调整 saved provider 顺序,`POST /api/providers/:id/enable|disable` 与 `PATCH /api/providers/:id/enabled` 控制候选是否参与;所有响应继续脱敏。
- `/api/model` 返回的 `providers[]` 带 enabled/order 信息;设置抽屉的折叠“AI 通道详情”里新增保存通道优先级列表,可上移/下移/启停 saved provider,默认仍不展开,不打扰普通用户。
- 这补齐了长 coding 任务里“某个慢/坏出口不该继续参与 failover”的手动治理能力;健康冷却仍是运行时优化,enabled/order 是用户显式配置。
- 验证:`cd ts && bun test src/server/services/providerService.test.ts src/server/index.test.ts` = 59 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm run typecheck` clean。

## 3.88 2026-07-07 print_mode QR 声明内容重建追加落地

- TS 媒体层新增纯 JS `qrcode` 依赖:当 `print_mode=true` 且请求/门店资料提供 `_print_qr_content`/`qrcode_text` 时,先生成 1024px、H 纠错、4 模块 quiet zone 的干净 PNG,再走既有 ffmpeg 右下角叠层。
- `MediaJobService` 结果新增 `print_qr_regeneration=generated/source_only/failed/none`;有内容且生成成功显示 `generated`,没有内容但有二维码图片时显示 `source_only`,生成失败会退回原图叠层并写 `print_qr_regeneration_warning`。
- 门店资料新增 `qrcode_text`;设置抽屉在“门店素材”里增加一个低噪输入框,保存后 Studio 品牌包会自动把它作为 `_print_qr_content` 传给媒体任务。上传收款码接口也可附带 `content`,但不带时不会清空已保存内容。
- 口径:这一步补齐“用户/前端明确知道二维码内容时的程序重建”;常见 PNG/JPEG 二维码图片视觉解码已在 3.93 追加补齐,但任意格式、模糊/遮挡二维码仍不能假装完整覆盖。
- 验证:`cd ts && bun test` = 410 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm test` = 21 pass;`cd web && pnpm run typecheck` clean;`git diff --check` clean。

## 3.89 2026-07-07 MCP/AskUser 表单答案脱 JSON + 多选视觉追加落地

- `MacQuestionCard` 现在真正尊重 `q.multi`:选项题多选时先勾选多个 chip 再提交,选中态带 `Check` 图标和 `aria-pressed`,单选仍保持点一下即提交。
- MCP/AskUser 字段表单提交时,后端仍收到原始 JSON 字符串,但前端用户气泡用字段 label 转成可读摘要,例如 `城市:上海 / 渠道:朋友圈、社群`,不再把 `{ "city": ... }` 裸露给用户。
- 新增 `question-answer-display.ts` 纯 helper 与 Vitest,覆盖 text/multiselect/boolean 字段的展示转换;`chat.send()` 继续用现有 `displayText` 通道,不污染模型历史和 steering 回声去重。
- 口径:结构化表单、URL、preview、多选和脱 JSON 已落;剩余只剩 URL allow/open/cancel 的桌面原生外链桥与更细的表单控件 polish。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/question-answer-display.test.ts`;`cd web && pnpm run typecheck`;`git diff --check` clean。

## 3.90 2026-07-07 视频本地出片响度标准化追加落地

- `TimelineDoc.media` 新增可选 `has_audio`;TS 本地 `auto_plan` 会把 ffprobe 的音轨探测结果持久化,旧 timeline 缺字段时 `renderProject()` 会在出片前兜底探测一次。
- `renderProject()` 在所有待出片片段都有音轨且未显式 `normalize_audio:false` 时,对每段转码加 `loudnorm=I=-16:TP=-1.5:LRA=11`,结果返回 `audio_loudness_normalized=true` 与 `audio_loudness_filter`。
- 如果任一片段没有音轨,渲染不会冒险套 audio filter,而是跳过响度标准化并在 `caveat` 写“部分片段没有音轨”;前端视频工作台已有 render caveat 区域会低调展示,不阻断看片。
- 口径:这补齐本地 ffmpeg 出片的基础响度治理;VLM 挑高光、ASR/字幕语义、音乐自动铺底、离屏模板渲染仍是后续 TS/native sidecar 硬门槛。
- 验证:`cd ts && bun test src/server/index.test.ts`;`cd ts && bun run typecheck`;`cd web && pnpm run typecheck`。

## 3.91 2026-07-07 sidecar 构建 smoke 与 native 插件缺口记录

- 新增 `qrcode` 纯 JS 依赖后,`cd ts && bun run build:sidecar` 仍可生成并 ad-hoc 签名 macOS arm64 sidecar:`backend-sidecar-aarch64-apple-darwin`。
- `SIDECAR_TARGET_TRIPLE=x86_64-pc-windows-msvc bun run build:sidecar` 通过,Windows x64 sidecar 可交叉构建;构建产物未进入 git 改动。
- `cd ts && bun run smoke:native` 仍失败:当前环境缺 `sharp`、`@huggingface/transformers`、`smart-whisper`;这不是本次 QR/视频改动引入的问题,而是 OCR/embedding/whisper native 资产发现与安装包验证缺口。
- 口径:sidecar 编译链通过不等于 Electron 安装包真机通过;Windows runner、ffmpeg/whisper/font/OCR/native 资产可发现性仍列在打包 smoke 后续项。
- 验证:`bun run build:sidecar` pass;`SIDECAR_TARGET_TRIPLE=x86_64-pc-windows-msvc bun run build:sidecar` pass;`bun run smoke:native` fail(缺上述 native 包)。

## 3.92 2026-07-07 文件修改流式跟随预览追加落地

- 前端新增 `file_pending` 预览状态:模型一发起 `write_file/edit_file/multi_edit_file/patch_file`,右侧预览立即显示正在修改的文件和路径;工具结果回来后同一面板自动切换为既有 diff 视图。
- 审批后执行也接入同一条链路:用户点“允许一次/本会话允许”后立即进入 pending,不再等后端工具跑完才看到右侧有反应。
- `<file_change ...>` 解析从 `useAgentChat` 抽到 `approved-tool-result-message.ts` 纯逻辑,统一 pending/diff artifact 生成;新增 Vitest 覆盖工具调用 pending 和完成 diff 两条路径。
- UI 口径保持 Work Buddy/Codex 式低噪:不增加台球装饰,不改整体配色,绿色只做状态点缀;底部定稿工具条在 pending 状态隐藏,避免文件尚未写完时出现错误操作。
- 验证:`cd web && pnpm exec vitest run src/hooks/use-agent-chat.test.ts`;`cd web && pnpm exec tsc --noEmit` clean。

## 3.93 2026-07-07 print_mode QR 图片视觉解码重建追加落地

- TS 媒体层新增纯 JS `jsqr/pngjs/jpeg-js`:当 `print_mode=true` 且只有 `_print_qr_path`/上传二维码图片、没有显式 `qrcode_text` 时,会尝试从 PNG/JPEG 源图视觉解码二维码内容。
- 解码成功后复用 3.88 的高纠错 QR 重建链路,生成干净 1024px PNG 再叠层;结果新增 `print_qr_regeneration_source=decoded_image`,显式内容路径则标 `declared`。
- 解码失败、格式不支持(WebP/GIF/BMP)、图片过大或内容过长都不会阻断任务:结果仍退回 `source_only/failed` + 原图叠层,并把原因写入 `print_qr_regeneration_warning`。
- 口径:这补齐“常见收款码/门店码 PNG/JPEG 上传图”的自动重建,不是 OCR/超分/模糊二维码修复;更复杂的 QR 质检仍可接 native sidecar/ZXing/OpenCV。
- 验证:`cd ts && bun test src/media/mediaJobs.test.ts` = 16 pass;`cd ts && bun test` = 411 pass;`cd ts && bun run typecheck` clean;`bun run build:sidecar` pass;`SIDECAR_TARGET_TRIPLE=x86_64-pc-windows-msvc bun run build:sidecar` pass;`bun run smoke:native` 仍 fail(缺 `sharp/@huggingface/transformers/smart-whisper`,与本次纯 JS QR 解码无关)。

## 3.94 2026-07-07 生图硬文字待核对元数据追加落地

- `MediaJobService` 新增硬文字需求提取:从 `poster_text` 结构化字段、prompt/`image_prompt` 引号内容和“写上/写着/主标题/副标题/文案”等短语里抽取需要逐字核对的中文海报文案。
- 直接生图和本地占位 fallback 的结果都会带 `hard_text_required`、`hard_text_expected`、`text_quality_status=pending_ocr`、`text_quality_warning/message`;Studio 前端沿用既有轻提示展示,不加大面积视觉噪音。
- 前端 API 类型补齐 `poster_text/print_mode/qrcode_text`,便于 Agent 工具或后续插件从同一生图接口传印刷/硬文字参数。
- 口径:这不是中文 OCR 识别完成,也不会宣称模型生成的字已经准确;它先把“哪些字必须核对”结构化到任务结果里,避免投放图静默带错字。真正的 OCR 校验、自动重出和逐图打分仍属 native/sidecar 后续项。
- 验证:`cd ts && bun test src/media/mediaJobs.test.ts` = 17 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm exec tsc --noEmit` clean。

## 3.95 2026-07-07 Provider 健康状态文案兜底追加落地

- 前端 `modelHealthStatusText()` 对后端返回的 provider `lastError` 做二次脱敏与压短:再次兜住 `Bearer ...`、`sk-*`、`api_key=...` 等 token-like 字符串,避免设置抽屉/状态 chip 把网关原始错误甩给用户。
- 冷却时间从机械秒数改成短提示:小于 60s 显示秒,超过 60s 显示“约 N 分钟后重试”,保持 Work Buddy/Codex 式低噪状态线。
- 口径:这不替代后端 `ProviderHealthStore` 的脱敏与冷却策略,只是前端展示层的最后一道保护。
- 验证:`cd web && pnpm exec vitest run src/hooks/model-health-status.test.ts`;`cd web && pnpm exec tsc --noEmit` clean。

## 3.96 2026-07-07 AskUser URL 安全打开 UI 追加落地

- `MacQuestionCard` 不再把 `ask_question.url` 裸渲染为直接可点的 `<a target="_blank">`;新增 `safeExternalQuestionUrl()` 只允许显式 `http/https` URL,拦截 `javascript:`、协议相对 URL 和本地相对路径。
- 提问卡里的链接改成“显示 URL + 打开链接 + 取消”的明确交互;打开使用 `window.open(..., noopener,noreferrer)`,取消会直接向 Agent/MCP 回答“取消”。
- 口径:这补齐 URL allow/open/cancel 的前端安全语义;真正的 Electron 主进程 `shell.openExternal` 原生桥仍可作为后续壳层 polish 接入。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/question-answer-display.test.ts`;`cd web && pnpm exec tsc --noEmit` clean。

## 3.97 2026-07-07 主对话首屏/知识库密度再收敛追加落地

- 按 `竞品拆解/02` 与 `04` 的 WorkBuddy/Codex 口径继续收紧主对话:欢迎区移除居中大号 `app-icon` 装饰,避免首屏出现蓝色球形“台球挂件”;侧栏保留小品牌标识即可。
- `BriefingCard` 从绿色大底 + 洞察卡片改成中性边框 + 行分隔列表,首屏今日建议最多 2 条,减少“看板式卡片堆叠”。
- `StoreDocsPanel` 顶部“行业知识 / 店铺文件 / 门店记忆”从三张独立卡片收成一个紧凑来源列表,更贴近“专有知识库问答来源分层”的工具面板形态。
- `web/next.config.js` 补齐 `/api/model` 与 `/api/providers` dev rewrites;此前 Next dev 下 provider 健康状态接口会 404,影响本地调试和状态线观察。
- 视觉验证:Playwright 打开 `http://127.0.0.1:3000/dashboard/chat`,知识库抽屉截图保存为 `output/playwright/store-docs-panel-2026-07-07-v2.png`;最新 console 仅 React DevTools 提示,无 `/api/model` 404;`curl http://127.0.0.1:3000/api/model` 与 `/api/providers` 均返回 200。
- 验证:`cd web && pnpm exec tsc --noEmit`;`cd web && pnpm exec vitest run src/components/desktop/question-answer-display.test.ts src/hooks/model-health-status.test.ts` clean。

## 3.98 2026-07-07 知识库来源卡片与媒体插件 UI 收敛追加落地

- `search_store_docs` 的工具结果不再按普通日志折叠成 XML 原文;新增 `store-doc-sources.ts` 解析 `<store_doc_sources>` 为 `S1/S2`、文件名、片段、可信度、命中词、原因、摘录与本机路径。
- `chat-thread` 对 `search_store_docs` 渲染专用“店铺资料来源”卡片:默认只露来源行,展开后看命中原因/摘录/路径,可直接打开原文到右侧预览;工具行补成“已查店铺资料”,更贴近专有知识库问答的可溯源体验。
- 生图工作室空态从 6 张独立场景卡收成单个紧凑示例列表,保留“点例子填入左侧输入框”的功能,但减少首屏卡片墙感。
- 视频工作台从生图带入的 handoff 区从绿色大底改成中性边框面板,并把“说大白话改”标题里的可见 emoji 换成 `MessageSquareText` 图标;媒体插件继续遵守主 UI 的中性主按钮 + 绿色点缀口径。
- 视觉验证:Playwright 打开 `http://127.0.0.1:3000/dashboard/studio` 与 `/dashboard/video`,截图保存为 `output/playwright/studio-empty-2026-07-07-v3.png`、`output/playwright/video-workspace-empty-2026-07-07-v3.png`;console 仅 React DevTools 提示。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/store-doc-sources.test.ts src/lib/agent-tools.test.ts`;`cd web && pnpm exec tsc --noEmit`;`cd web && pnpm test` = 27 pass;`git diff --check` clean。

## 3.99 2026-07-07 文件修改 pending 失败态追加落地

- 3.92 的 `file_pending` 预览继续保留,但文件工具如果最终没有返回 `<file_change>`(例如目录级 `AGENTS.md/CLAUDE.md` 暂停、plan 模式拒绝、陈旧读保护或其它工具错误),右侧预览不再卡在“正在修改”。
- `FileChangeArtifact` 新增 `file_error`:保留目标路径、工具名和失败原因;`DesktopPreviewPanel` 渲染“未修改”状态,说明没有写入文件,并隐藏底部定稿/改写工具条。
- `chat-shell` 的 preview 恢复校验同步支持 `file_error`,刷新页面不会把失败态误恢复成空预览。
- 验证:`cd web && pnpm exec vitest run src/hooks/use-agent-chat.test.ts`;`cd web && pnpm exec tsc --noEmit` clean。

## 3.100 2026-07-07 native smoke 默认 skipped / 严格模式追加落地

- `ts/scripts/smoke/native-plugins.smoke.ts` 不再在默认日常验证里因“刻意未安装的重依赖”直接红掉;`sharp`、`@huggingface/transformers`、`smart-whisper` 缺失时标 `skipped:true` 并退出 0。
- 严格验收仍保留硬失败:`NATIVE_SMOKE_REQUIRE_DEPS=1 bun run smoke:native` 会把缺包或运行失败视为 exit 1,用于真正挂载 OCR/embedding/whisper 或打包前 native 资产验收。
- `ts/docs/W1-native-plugin-findings.md` 同步记录双模式口径:W1 spike 结论仍是 Bun 1.3.14 能跑这些依赖,但主 deps 当前不保留重包,日常 smoke 只说明 skipped,不能等同于 native 功能已完整可用。
- 验证:`cd ts && bun run smoke:native` = 0/3 OK,3 skipped,exit 0;`cd ts && bun run typecheck` clean。

## 3.101 2026-07-07 压缩后最近文件上下文恢复追加落地

- 新增 `recentFileContext` 压缩恢复层:当主循环触发自动压缩或 provider 报 context overflow 后强制压缩时,会把本轮最近读过/改过的文件重新读取并插到摘要之后,避免长代码任务在 compaction 后忘掉关键文件内容。
- 恢复内容默认最多 5 个最近文件、单文件 12KB、总量 40KB;文件内容与路径均 XML 转义,并带 `changed_since_read`、`truncated`、`bytes/size` 元数据。
- `read_file/read_many_files` 与 `edit_file/multi_edit_file/patch_file` 更新 `fileReads` 时改为 delete+set,让 `Map` 顺序真实表达最近使用;编辑成功后记录写后快照,继续服务读前置保护和压缩恢复。
- 主循环压缩成功时如果恢复了文件,`context_note` 会追加“已恢复最近文件上下文”,前端可见但不增加新的重 UI;模型下一步真实收到 `[压缩后恢复的最近文件上下文]`。
- 口径:这是对齐“压缩后自动重读最近文件”的抗失忆能力,相关实现可直接复制/抄/移植/改写;不是把全仓库塞回上下文,大仓库仍应先 `grep_files/code_outline/read_many_files` 缩小范围。
- 验证:`cd ts && bun test src/context/recentFileContext.test.ts src/context/compaction.test.ts src/harness/loop.test.ts src/tools/fileTools.test.ts` = 85 pass;`cd ts && bun run typecheck` clean。

## 3.102 2026-07-07 九段结构化压缩摘要追加落地

- `compactPipeline` 的摘要系统提示从一句泛化 prompt 升级为九段结构化压缩:用户目标与硬约束、技术概念与架构判断、文件与代码状态、错误/失败/修复、已完成事项、用户原话要点、待办清单、当前工作现场、下一步建议。
- 新增 `<analysis>`/`<summary>` 分离协议:模型可在 analysis 标签里整理草稿,但系统只会提取 summary 正文回灌;无 summary 时会剥离 analysis,避免草稿噪音污染后续 coding 上下文。
- 压缩 prompt 明确要求保留真实路径、命令、测试结果、错误文本、接口名、模型/provider 名,并要求未知事项写未确认,减少长任务里最致命的“把约束概括没了”。
- 口径:这是对齐“9 节结构化摘要 prompt + 草稿/正文分离”的核心抗失忆能力,相关实现可直接复制/抄/移植/改写;仍不把隐式全量历史塞回去,只提升摘要的可继续执行性。
- 验证:`cd ts && bun test src/context/compaction.test.ts src/context/recentFileContext.test.ts src/harness/loop.test.ts` = 50 pass。

## 3.103 2026-07-07 大工具结果落盘 + 头尾预览回灌追加落地

- 新增 `toolResultStorage`:对白名单可重取工具(`run_command/project_diagnostics/grep_files/glob_files/list_dir/code_outline`)的大结果做上下文预算保护,默认超过 24K 字符时把全文写入会话 state 目录,模型和前端事件只接收 `<stored_tool_result>` 头尾预览。
- 预览默认 2K 字符,保留开头和结尾,适合测试/构建日志既看命令背景也看最后错误;XML 属性/正文均转义,同时记录 `chars/bytes/path/tool/call_id`。
- `read_file/read_many_files`、文件修改 diff、知识库来源卡片和媒体工具不进落盘白名单,避免破坏源码上下文、右侧 diff 预览和来源卡片解析。
- `startServer` 按会话传入 `stateRoot/tool-results/<conversationId>`,不会把缓存文件写进用户项目;直接调用 loop 时默认退到系统临时目录。
- 口径:这是对齐“超长工具结果落盘+2K 预览回喂”的上下文保护,相关实现可直接复制/抄/移植/改写;不是隐藏失败,需要全文时可按 path 查看或重新运行更窄命令。
- 验证:`cd ts && bun test src/context/toolResultStorage.test.ts src/context/compaction.test.ts src/context/recentFileContext.test.ts src/harness/loop.test.ts` = 53 pass;`cd ts && bun run typecheck` clean。

## 3.104 2026-07-07 Todo 单一进行中 + activeForm 追加落地

- `TodoItem` 新增 `activeForm`,用于把“实现功能”这类任务内容和“正在跑类型检查”这类用户可见进行时短句分开;`formatTodoChecklist()` 对 in_progress 优先展示 activeForm。
- `normalizeTodos()` 现在接受 `activeForm/active_form`,并保证最多一个 `in_progress`;若清单里没有进行中但有 pending,自动把第一条 pending 提升为 in_progress,避免长任务清单全是待办、看不出当前动作。
- 多个 `in_progress` 会保留第一个,后续降回 pending;全 done 清单不强行制造进行中。
- `parseProgressMarkdown()` 的未勾选第一项也会进入 in_progress,让模型通过 `task_progress` 内联清单时保持同一进度语义。
- `todo_write` 工具描述同步说明 `{ task, status, activeForm? }` 和自动归一规则,引导模型更稳定地更新进度。
- 验证:`cd ts && bun test src/types/todo.test.ts src/tools/todoTool.test.ts src/harness/loop.test.ts` = 50 pass。

## 3.105 2026-07-07 审批卡改参再放行追加落地

- `/api/v1/agent/execute` 新增 `approval_args`:后端用原始审批参数校验 token,但可以执行用户在审批卡里调整后的 `args`;执行前仍重新跑 `resolvePermission`,危险/硬拒规则不会绕过。
- `executeApproved()` 支持 `tokenArgs`,并在改参执行后按修改后的参数清 denial/记录本会话允许,避免“本会话允许”误记原参数。
- 前端 `MacApprovalCard` 新增折叠参数区,以 JSON 编辑当前工具参数;JSON 非对象或解析失败时禁用允许按钮,合法修改后会提示将按调整后的参数执行。
- `confirmApproval()` 的 pending 文件预览、完成 diff/工具步骤展示都改用最终执行参数,避免用户改了路径/内容后右侧预览仍指向旧参数。
- 口径:这补齐“权限应答改参再放行”的交互能力,CC-Haha 相关机制可直接复制/抄/移植/改写;它不是免审任意执行,仍要求原审批卡 token + 修改后参数过权限/危险校验。
- 验证:`cd ts && bun test src/harness/loop.test.ts` = 42 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm exec tsc --noEmit` clean。

## 3.106 2026-07-07 店脑记忆相关性注入 + 老化提醒追加落地

- 新增 `storeMemoryContext`:每轮 `/agent/run` 会读取本地门店记忆,按用户问题做轻量关键词/短语相关性选择,最多注入 5 条 `<store_memory_context>` 到 system prompt;不再只是面板里可见、模型实际用不到。
- 记忆选择必须有 query 关键词/短语命中,人工/新鲜度只做加分,避免把无关记忆塞进上下文;`pending` 候选不注入,工作区 scoped 记忆只在当前 `workingDir` 匹配时注入。
- `DesktopDataStore` 新增记忆 `created_at/updated_at/working_dir`;新增、编辑、确认都会更新时间,旧数据缺时间时以 `age_days="unknown"` 处理。
- 超过 30 天的记忆带 `age_warning`,提示价格、排班、活动、库存、合同等易变事实需要先核对现状;“记忆老化警告”相关机制可直接复制/抄/移植/改写。
- 口径:这不是向量库替代品,而是无依赖的本地店脑选择器;知识库文件仍走 `search_store_docs` 来源卡片,门店长期偏好/规则走 memory context。
- 验证:`cd ts && bun test src/memory/storeMemoryContext.test.ts src/server/services/storeDocsService.test.ts` = 7 pass;`cd ts && bun run typecheck` clean。

## 3.107 2026-07-07 店脑记忆路由级注入回归追加落地

- `src/server/index.test.ts` 新增 `/agent/run` 路由级测试:先通过 `/api/v1/store-memory` 写入当前工作区记忆、pending 候选和其它工作区记忆,再拦截 OpenAI-compatible 请求体里的 `system` 消息。
- 测试明确断言 `<store_memory_context>` 真实进入模型 system prompt,且 pending 候选和其它 `working_dir` 的同关键词记忆不会串入当前轮。
- 价值:补上 3.106 纯函数之外的集成闸,防止后续 provider、system prompt、桌面数据层重构时出现“面板看得到,模型实际用不到”的隐性退化。
- 验证:`cd ts && bun test src/server/index.test.ts -t "store memories"` = 1 pass。

## 3.108 2026-07-07 Plan 模式未批准不执行边界追加落地

- `src/harness/loop.test.ts` 新增 `ExitPlanMode revision keeps plan mode and blocks write tools`:当用户在计划卡选择/输入“修改计划”而非批准时,主循环保留 `permissionMode='plan'`。
- 后续模型即便继续幻觉调用 `write_file`,权限层仍返回 `[计划模式]` 跳过,并确认目标文件没有被创建。
- 价值:把“ExitPlanMode=审批工具”从只有批准路径扩成双向边界,防止国产模型在用户未批准计划后继续动手,也防止未来把 `ctx.permissionMode='ask'` 的降权逻辑放宽。
- 验证:`cd ts && bun test src/harness/loop.test.ts -t "ExitPlanMode"` = 2 pass。

## 3.109 2026-07-07 普通回答正文成品入口追加落地

- 新增 `assistant-output-targets`:对普通 assistant 文本做保守成品识别,只在头部明确出现朋友圈文案、活动方案、老板汇报、执行清单、短视频/剪辑脚本、生图/视频提示词等信号,或结构化标签足够明确时命中。
- `DesktopChatThread` 在普通回答命中成品且无图片/视频替身卡时,渲染一条中性小替身行,点击进入右侧 `content` 预览;普通解释继续按 Markdown 展示,不把主对话窗口变成卡片墙。
- 图片/视频正文入口仍优先走原有 `posterPreviewFromText/extractVideoUrl`,文本成品入口只补“非工具协议、非媒体链接”的内容管道半截。
- UI 口径:新增入口沿用白/深灰卡片、hairline 边框、绿色小图标点缀,没有新增蓝色或大面积绿色;`web/src` 颜色扫描未发现 `#007AFF/#0a84ff/#0052d9` 回流。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/assistant-output-targets.test.ts src/components/desktop/store-doc-sources.test.ts src/components/desktop/question-answer-display.test.ts` = 7 pass;`cd web && pnpm run typecheck` clean。

## 3.110 2026-07-07 本轮追加变更全量验证

- TS 全量:`cd ts && bun test` = 430 pass;`cd ts && bun run typecheck` clean。
- Web 全量:`cd web && pnpm test` = 31 pass;`cd web && pnpm run typecheck` clean。
- 工作区文本卫生:`git diff --check` clean。

## 3.111 2026-07-07 ToolSearch 长尾工具延迟披露追加落地

- 新增默认只读工具 `tool_search`:模型可用 `{ query/task, limit? }` 搜索隐藏或低频工具,返回匹配工具的名称、描述和 `input_schema`;主要用于 MCP、插件、媒体和未来行业包工具膨胀后的渐进披露。
- 新增 `visibleToolSpecs()` 延迟 schema 策略:当 registry 工具数不超过 32 时维持全量暴露;超过阈值时只暴露 coding 热工具、技能/命令索引、知识库搜索、子代理/后台任务、媒体入口、少量 MCP 工具和已通过 `tool_search` 揭示过的工具。
- 少量 MCP 工具(≤3)仍直接可见,避免“只装了一个 MCP 还得先搜索”的体验回退;MCP/插件工具很多时才进入搜索披露,降低每轮模型请求的 schema 噪音和 token 压力。
- 主循环在 `tool_search` 成功后把匹配工具加入 `revealedToolNames`,下一轮 `model.step()` 的工具列表真实包含这些 schema;隐藏工具仍保留在 registry,通过权限闸/执行链路统一执行。
- `tool_search` 从只读并行批次中排除,保证搜索结果稳定影响下一轮 schema;系统提示新增“工具发现”规则,要求模型需要长尾能力时先搜工具,不要凭记忆猜当前列表没有的工具名。
- 口径:这是对齐“ToolSearch/工具 schema 延迟加载”的性能能力,相关实现可直接复制/抄/移植/改写;不是删除工具,coding 主路径继续常驻 `read_file/read_many_files/grep_files/code_outline/project_diagnostics/edit_file/run_command` 等高频工具。
- 验证:`cd ts && bun test src/tools/toolSearchTool.test.ts src/tools/generalTools.test.ts src/harness/systemPrompt.test.ts src/harness/loop.test.ts -t "tool_search|工具发现|general registry contains|model-facing"` = 6 pass;`cd ts && bun test src/server/index.test.ts -t "exposes agent_task|loads workspace MCP tools|surfaces MCP elicitation|surfaces AskUserQuestion"` = 4 pass;`cd ts && bun run typecheck` clean。

## 3.112 2026-07-07 ToolSearch 追加后的 TS 全量验证

- TS 全量:`cd ts && bun test` = 434 pass;`cd ts && bun run typecheck` clean。
- 文本卫生:`git diff --check` clean。

## 3.113 2026-07-07 领域包 SessionStart 挂载追加落地

- 新增 `ts/src/packs/domainPacks.ts`:把 `knowledge_packs/enabled_packs/billiards_mode` 统一解析成可枚举领域包,当前内置 `billiards` 台球运营专家,支持中文/英文别名去重。
- `/agent/run` 不再在 `supportContext()` 里硬拼台球提示,而是把启用的领域包转成 `SessionStart` hook,由主循环统一注入 `<hook_context event="SessionStart">`;这让“台球=一个可挂载包”,而不是通用 coding agent 的固定身份。
- 新增 `/api/v1/agent/packs` 返回可用包元数据、默认启用建议和 suggested skills,给前端后续从硬编码 `knowledgePacks=["billiards"]` 迁到能力包选择器留出稳定接口。
- 兼容规则:显式传 `knowledge_packs: []` 保持通用模式;旧端只传 `billiards_mode:true` 时仍自动挂载台球包。
- 验证:`cd ts && bun test src/packs/domainPacks.test.ts` = 4 pass;`cd ts && bun test src/packs/domainPacks.test.ts src/hooks/hooks.test.ts src/server/index.test.ts -t "domain pack|enabled packs|legacy frontend capability|mounts enabled packs|SessionStart"` = 4 pass;`cd ts && bun run typecheck` clean。

## 3.114 2026-07-07 ToolSearch MCP 路由级懒披露回归追加落地

- `src/server/index.test.ts` 新增 `/agent/run` 集成测试:启动本地 MCP SDK fixture,注册 8 个 MCP 工具,让真实 server turn 装配走 `loadMcpToolsFromFile -> buildGeneralRegistry -> runAgentLoop`。
- 首轮模型请求断言只包含 `tool_search` 等热工具,不包含 `mcp__fixture__rare_invoice_import`,且 MCP 工具数 >3 时不会直接暴露任何 `mcp__*` schema。
- 模型调用 `tool_search` 后,第二轮模型请求真实包含匹配的 `mcp__fixture__rare_invoice_import` schema,并且 tool_search 结果进入消息回灌;这补上 3.111 只有 loop 层测试之外的 server 接线防退化闸。
- 验证:`cd ts && bun test src/server/index.test.ts -t "large MCP tool sets lazy|loads workspace MCP tools"` = 2 pass。

## 3.115 2026-07-07 前端领域包选择器接口化追加落地

- `web/src/lib/api.ts` 新增 `listKnowledgePacks()` 与 `KnowledgePackMeta`,消费 TS server 的 `/api/v1/agent/packs`。
- `DesktopComposer` 的专家列表改为 `knowledgePackOptions` prop,保留台球运营专家 fallback;UI 样式、勾选行为和“通用/专家”解释不变。
- `DesktopChatShell` 启动时拉取可挂载领域包,只把后端显式 `default_enabled:true` 的包转成首次启动默认挂载;当前内置 `billiards` 默认不自动挂载,首启保持通用 Agent。用户显式保存 `agent_knowledge_packs: []` 仍不会被覆盖。
- 这一步把“前端硬编码台球包”收成“后端声明专家能力包、前端只负责选择”,为后续多行业专家/插件式领域包铺路。
- 验证:`cd web && pnpm exec tsc --noEmit` clean;`cd ts && bun run typecheck` clean。

## 3.116 2026-07-07 本轮领域包/ToolSearch 追加后的全量验证

- TS 全量:`cd ts && bun test` = 440 pass;`cd ts && bun run typecheck` clean。
- Web 全量:`cd web && pnpm test` = 31 pass;`cd web && pnpm exec tsc --noEmit` clean。
- 工作区文本卫生:`git diff --check` clean。

## 3.117 2026-07-07 领域包推荐 skills 披露追加落地

- `list_skills` 工具新增 `{ query?, recommended_only?, limit? }` 输入,默认仍列全部技能;启用领域包时,包推荐技能会排在前面并带 `[推荐]` 标记。
- `DomainPack.suggestedSkills` 不再只给前端展示:`/agent/run` 会把启用包的推荐技能传给父 Agent、同步子代理和后台子代理的 registry,让 `list_skills({recommended_only:true})` 能只返回当前包推荐的已安装技能。
- `billiards` pack 的 SessionStart 上下文改为明确引导模型先用 `list_skills({recommended_only:true})`,再按需 `read_skill`,避免把行业知识和所有技能正文一次性塞进系统提示。
- 新增 `/agent/run` 集成测试:自定义 `skillsRoot` 同时安装 `daily-report` 和 `generic-helper`,模型调用 `list_skills({recommended_only:true})` 时只拿到 `daily-report [推荐]`,证明推荐链路真实穿过 server registry。
- 验证:`cd ts && bun test src/skills/skillLoader.test.ts src/packs/domainPacks.test.ts src/server/index.test.ts -t "list_skills|suggestedSkillNames|enabled pack recommendations|mounts enabled packs|legacy frontend capability"` = 5 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 443 pass;`git diff --check` clean。

## 3.118 2026-07-07 后台子代理完成通知/跳转追加落地

- `TaskService` 新增 `onSettled` 旁路回调,在任务最终态写入且 `done` 事件落盘后触发;回调失败不会反向污染任务状态。
- `start_background_agent_task` 创建任务时写入 `kind:"background_agent"` 与 `params.agent/task/context`,让 server/前端能把慢任务和普通媒体任务区分开。
- TS server 在后台子代理 completed/failed/cancelled 后写入持久通知中心:`kind:"background_task"`,并携带 `meta.taskId/status/conversationId/workspaceRoot/agent`;通知 id 改为基于现有最大 id 的单调递增,避免同毫秒多通知被 `after` 游标漏掉。
- `DesktopChatShell` 轮询通知时识别 `background_task`,系统通知照常弹,应用内额外出现带“查看”的中性 toast;点击后打开后台任务抽屉并展开对应任务事件流。
- Electron 原生通知桥新增点击回传:系统通知被点击时恢复/聚焦发起窗口,并把 `meta` 送回渲染进程,同样跳到对应后台任务。
- 验证:`cd ts && bun test src/tasks/taskService.test.ts src/tasks/taskTools.test.ts src/server/services/desktopDataStore.test.ts src/server/index.test.ts -t "TaskService|start_background_agent_task|notification|background subagent task"` = 6 pass;`cd web && pnpm exec vitest run src/components/desktop/notification-task-link.test.ts` = 2 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm exec tsc --noEmit` clean;`git diff --check` clean。

## 3.119 2026-07-07 本轮后台子代理通知追加后的全量验证

- TS 全量:`cd ts && bun test` = 446 pass;`cd ts && bun run typecheck` clean。
- Web 全量:`cd web && pnpm test` = 33 pass;`cd web && pnpm exec tsc --noEmit` clean。
- 工作区文本卫生:`git diff --check` clean。

## 3.120 2026-07-07 写入/回滚后的最近文件上下文补强

- `write_file` 成功写入后会记录该文件的最新 mtime/size 到 `ctx.fileReads`,让自动压缩或 context overflow 后的最近文件上下文恢复能带回模型刚创建/覆盖的文件。
- `restore_file` 回滚到已有快照后同步刷新最近文件快照;回滚“新建文件”快照导致文件删除时,会从最近文件集合移除该路径,避免压缩恢复旧内容。
- 读前置保护不变:`edit_file/multi_edit_file/patch_file` 仍要求先 `read_file/read_many_files` 且校验 mtime/size,本次只补“文件变更后的长上下文恢复”。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts src/context/recentFileContext.test.ts -t "write_file|restore_file|recent"` = 7 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 446 pass;`git diff --check` clean。

## 3.121 2026-07-07 压缩恢复最近文件时保留目录级指令

- `buildRecentFileContextMessage` 在恢复最近文件正文前,会合并这些文件适用的子目录 `AGENTS.md/CLAUDE.md` 指令;workspace 根指令仍由每轮 system prompt 注入,这里不重复塞根规则。
- 这解决长 coding 任务压缩后“文件正文恢复了,但更近目录规则丢了”的断点,尤其是 monorepo 子包/子应用里不同 lint/typecheck/导出约定的场景。
- 新增测试覆盖:最近文件在 `packages/app/src.ts`,根目录与 `packages/AGENTS.md` 同时存在时,恢复消息只带 `packages/AGENTS.md`,且位于 `<recent_file_context>` 前。
- 验证:`cd ts && bun test src/context/recentFileContext.test.ts` = 5 pass;`cd ts && bun test src/context/recentFileContext.test.ts src/context/compaction.test.ts src/harness/loop.test.ts -t "recent|compaction|overflow"` = 4 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 447 pass;`git diff --check` clean。

## 3.122 2026-07-07 媒体工作台 UI 跟随 Agent 走法 B 补齐

- 复核设计时间线:现行口径仍是 2026-07-05 owner 拍板的“走法 B”——砍蓝、绿只点缀、主按钮/选中态走中性;生图/视频作为插件式工作台也必须跟随这套体系,不能另起“偏绿/偏蓝”视觉。
- 生成工作室注释去掉“白底偏绿 macOS”旧口径,明确“中性主按钮 + 绿色小点缀”;首屏示例从卡片网格收成轻量列表,降低插件感。
- 视频工作台顶部改成与生成工作室一致的桌面标题栏 safe area,主背景收回中性;头部提示随“氛围片/口播”动态变化,避免固定显示错误模式;视频预览容器圆角收回 `rounded-lg`。
- 口径:媒体能力是 Agent 壳的延伸能力,不是第二套产品皮肤;后续新增生图/生视频按钮继续优先用 `app-primary-action/app-active-neutral`,绿只做图标、状态、焦点、轻提示。
- 验证:`cd web && pnpm exec tsc --noEmit` clean。

## 3.123 2026-07-07 后台任务/子代理事件流摘要折叠

- `SubagentTraceCard` 不再直接显示最后 14 条原始进度;新增 `summarizeSubagentProgressLines()`,把连续 `子代理 ... 进度:` 折成 `×N` 摘要,保留开始/调用/完成/结论等结构线。
- `BackgroundTasksPanel` 的事件过程改用 `formatBackgroundTaskEventLines()`:隐藏高频 `usage_update`,连续同工具同 id/stream 的 `tool_progress` 合并为一条范围摘要,最多显示最近 80 行并提示前面折叠数量。
- 展开正在运行/排队的后台任务时,事件流会以 1.5s 静默刷新,不会只停留在打开瞬间;手动打开仍显示读取状态,自动刷新不反复闪 loading。
- 这让长后台子代理/长命令输出回看更像 coding trace:关键节点可扫,实时噪声不再把“调用了什么、最后结论是什么”淹掉。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/subagent-trace.test.ts src/components/desktop/background-task-events.test.ts src/components/desktop/notification-task-link.test.ts` = 10 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.124 2026-07-07 Provider 接管态 UI 标识修正

- 设置抽屉“AI 通道详情 / 保存通道优先级”里,不再只按 `activeId` 给通道打“当前”标识;同时比对 `/api/model` 返回的真实 `runtime.providerId`。
- 正常情况下默认通道仍显示“当前”;当默认主出口冷却、备用出口接管时,默认通道显示“默认”,真正承接本轮请求的备用通道显示“接管中”。
- 这避免用户排障时误以为系统还在使用最近失败的主出口,也把 provider failover 的运行态从后台机制变成可解释状态。
- 验证:`cd web && pnpm exec vitest run src/hooks/model-health-status.test.ts` = 3 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.125 2026-07-07 Prewarm 跟随 Provider 冷却排序

- `/agent/prewarm` 原来直接拿 `ProviderService.resolveRuntimeConfigs()` 的第一个 runtime,会在主出口已冷却时仍报告/构建冷却中的默认出口;正式 `/agent/run` 却会先用备用出口,两条链路状态不一致。
- prewarm 现在复用 `orderRuntimeProvidersForAttempt()` 与 `providerHealthCallbacks`,返回的 `provider` 与真正下一轮对话一致;若主出口冷却,也会返回同样的红acted `notices`,说明本轮先尝试哪个备用出口。
- 新增回归:制造 primary 失败并跨重启保留 `provider-health.json` 后,`/agent/prewarm` 必须返回 Backup Provider、不能暴露 `primary-secret/sk-primary`,且不能触发任何模型请求。
- 验证:`cd ts && bun test src/server/index.test.ts -t "prewarm|provider health cooldown survives|POST /agent/run cools"` = 4 pass;`cd ts && bun run typecheck` clean。

## 3.126 2026-07-07 后台任务 Trace 搜索与失败节点定位

- `background-task-events` 新增 `buildBackgroundTaskTraceView()` 与 `findBackgroundTaskTraceMarkers()`:在已有进度折叠基础上,还能提取 `error/approval_request/ask_question/final` 以及工具输出里的失败提示,给长后台子代理/长命令任务一个可定位的关键节点列表。
- `BackgroundTasksPanel` 展开过程时新增轻量搜索框,可按工具名、`#seq`、命令片段或报错文本过滤;点击关键节点 chip 会自动过滤到对应序号,不用在 80 行折叠 trace 里手动翻坏点。
- 搜索发生在折叠后的 trace view 上,但折叠进度组的搜索索引保留了组内所有 chunk,所以即使 UI 只显示最后一段进度,也能搜到前面出现过的失败关键词。
- UI 口径:仍是 Work Buddy/Codex 式低噪工具面板,只加搜索和小 chip,不新增大卡片、不改主配色;红/橙只用于失败/警告状态,绿只用于状态/焦点点缀。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/background-task-events.test.ts src/components/desktop/subagent-trace.test.ts src/components/desktop/notification-task-link.test.ts` = 12 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.127 2026-07-07 同步 agent_task Trace 搜索与异常节点定位

- `subagent-trace` 复用同一思路新增 `buildSubagentTraceView()` 与 `findSubagentTraceMarkers()`:同步 `agent_task` 的进度折叠后仍保留组内原始 chunk 搜索索引,不会因为 UI 只显示最后一段进度而搜不到前面的失败关键词。
- `SubagentTraceCard` 在当前对话流内新增轻量搜索框和异常 chip;长同步子代理不用打开后台抽屉,也能按关键词或 `#序号` 定位到失败/超时/拒绝等异常进度。
- 搜索控件只在过程较长、有异常节点或正在过滤时出现,避免短子代理结果把主对话流变成工具面板;颜色仍沿用中性 + 绿色焦点 + 橙色异常提示。
- 价值:同步 `agent_task` 与后台任务都具备“折叠、搜索、坏点定位”的共同可观测性,后续做阶段/工具类型分组时可以继续在这两个纯逻辑 view 上扩展。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/subagent-trace.test.ts src/components/desktop/background-task-events.test.ts` = 11 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.128 2026-07-07 Provider 冷却分类与退避调参

- `ProviderHealthStore` 新增失败分类:`configuration`(401/403/404/invalid api key/not found 等)、`rate_limit`(429/quota/too many requests)、`transient`(5xx/超时/网络类默认)。健康文件继续只存脱敏错误,并兼容旧 entry 无分类字段。
- 冷却窗口从“一律 30s 起跳”调整为分类退避:临时失败 30s 起、最高 5 分钟;限流 2 分钟起、最高 15 分钟;配置类失败 10 分钟起、最高 60 分钟。用户修好 key 后仍可在设置抽屉手动“重试”清冷却。
- `/model` 健康状态透出 `failureCategory`;顶部健康文案和设置抽屉明细把冷却说明区分为“配置失败/限流/失败”和“配置冷却/限流冷却/冷却”,排障时不再把 key 配错和网络抖动混在一起。
- 口径:这只影响下一轮 provider 排序与用户可解释状态,不改变当前轮 failover 行为;所有错误提示继续脱敏,不会把 `Bearer/sk/api_key` 泄给前端或健康文件。
- 验证:`cd ts && bun test src/server/services/providerHealthStore.test.ts src/server/index.test.ts -t "provider health|prewarm|cooldown|health/clear"` = 6 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm exec vitest run src/hooks/model-health-status.test.ts` = 4 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.129 2026-07-07 领域包专属命令合并进 Agent 命令池

- `DomainPack` 新增 `commands`,当前台球运营专家内置 `/billiards:daily-ops` 与 `/billiards:content-plan` 两个 prompt command;pack 元数据同步暴露 `suggested_commands` 给前端/未来管理页。
- `commandLoader` 新增 `mergeCommandLibraries()` 与 `commandLibraryFromCommands()`,server 的命令装配顺序改为“内置命令 -> 领域包命令 -> 工作区 `.claude/.codex` 命令”,后者同名覆盖前者,确保用户项目自己的命令优先级最高。
- `/agent/run`、`/agent/prewarm`、审批执行 registry 和 `/commands`/`/api/commands/expand` 全部走同一合并逻辑;用户输入 `/billiards:content-plan 周末活动` 且启用 `knowledge_packs:["billiards"]` 时,模型实际收到领域包命令 prompt,并写入 `command_invocation` replay。
- 前端 `api.listCommands()` 与 `DesktopComposer` 会把当前 `knowledgePacks` 传给 `/api/commands`,所以 `/` 面板和正式运行的命令集合一致;未启用领域包时旧命令列表不受影响。
- 口径:这是领域包工具化的第一步,不把行业流程硬塞进 system prompt,而是沿用 commands/skills 渐进披露机制;CC-Haha 相关机制可直接复制/抄/移植/改写,后续若有真正行业专属工具,继续通过 pack registry 合并进工具池。
- 验证:`cd ts && bun test src/commands/commandLoader.test.ts src/packs/domainPacks.test.ts src/server/index.test.ts -t "command|domain pack|enabled pack|commands API"` = 15 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm exec tsc --noEmit` clean。

## 3.130 2026-07-07 项目指令 Scope 查询工具追加落地

- 新增只读工具 `list_project_instructions`:模型可在新建文件或改动陌生子目录前查询目标路径适用的项目/目录级指令;默认只列目录级规则,传 `include_workspace_root:true` 时也带根级规则。
- 工具支持尚未创建的新文件路径,使用 workspace `create` 边界校验,仍拒绝越界/glob 等危险路径;最多一次看 20 个目标,输出继续复用 `<project_instruction>` 格式和既有截断/转义逻辑。
- 调用成功后会把目标 scope 写入 `ctx.projectInstructionScopes`,所以模型刚查过 `src/AGENTS.md` 后马上 `write_file("src/new.ts")` 不会再被同一目录规则暂停一次;这让“先看规则再写”成为顺滑路径,而不是靠失败重试。
- `buildGeneralRegistry` 与 ToolSearch 热工具列表都纳入 `list_project_instructions`;系统提示“改动后的验证”段也明确提醒新建/改动陌生子目录前先用它查 scope。
- 口径:这不是替代 `read_file/read_many_files` 的代码上下文,而是把目录级项目指令的作用范围显式化,提升长 coding 任务、monorepo 子包和新文件创建时的规则遵守稳定性。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts src/tools/generalTools.test.ts src/harness/systemPrompt.test.ts src/tools/toolSearchTool.test.ts -t "list_project_instructions|general registry contains|改动后的验证|never leaks|白标|large registries"` = 6 pass;`cd ts && bun test src/harness/systemPrompt.test.ts` = 9 pass;`cd ts && bun run typecheck` clean。

## 3.131 2026-07-07 Trace 阶段分组与低噪可视化

- `background-task-events` 的 trace view 新增 `lineViews` 与 `phaseGroups`:在保持旧 `lines` 文本兼容的同时,为后台任务过程标注启动/思考/工具/进度/确认/提醒/收束/错误阶段,并把相邻同阶段合成轻量分组摘要。
- `subagent-trace` 同步新增 `lineViews` 与 `phaseGroups`:同步 `agent_task` 的启动、工具、进度、异常、收束阶段可被 UI 读取;连续进度折叠后仍保留异常阶段和原始 `#序号` 搜索索引。
- 后台任务抽屉和内联子代理卡片只渲染小号阶段 chip 与阶段汇总,不新增大卡片、不改变事件协议、不扩大模型上下文;长 coding trace 现在能一眼扫到“卡在确认/工具/异常/结论”的位置。
- 口径:这是在 3.126/3.127 搜索与坏点定位上的下一层可观察性 polish;后续若做统一 trace 面板,应复用这两个纯逻辑 view,而不是在 UI 里重新解析 raw event。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/background-task-events.test.ts src/components/desktop/subagent-trace.test.ts` = 13 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.132 2026-07-07 项目指令 Scope 前端可视化

- 新增 `project-instruction-scope` 解析器:把 `list_project_instructions` 返回的 `<project_instruction>` / `<project_instructions status="empty">` 解析成规则文件列表、截断状态、摘要和省略目标数,不在对话流里裸露 XML。
- `chat-thread` 对 `list_project_instructions` 渲染专用“项目规则 scope”小卡片:显示命中的 `AGENTS.md/CLAUDE.md`、是否截断和两行摘要;空 scope 只显示“没有命中目录级项目规则”,保持低噪 coding trace。
- `agent-tools` 新增工具展示文案“查项目规则”,步骤行从裸 `list_project_instructions` 收成“已查项目规则”,让用户能理解 Agent 在改陌生目录前做了规则核对。
- 口径:前端只是把后端 3.130 的 scope 查询结果可视化;不改变项目指令优先级、不注入额外规则、不把项目指令当成可编辑成品。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/project-instruction-scope.test.ts src/lib/agent-tools.test.ts` = 5 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.133 2026-07-07 领域包真实工具 Registry 合并

- `DomainPack` 新增 `tools?: Tool[]` 与 `createDomainPackTools()`:启用领域包后,包内真实工具会和通用工具、MCP、后台任务、媒体工具、店铺资料工具一起进入同一 `ToolRegistry`;通用模式不暴露这些领域工具。
- `billiards` 包新增只读工具 `billiards_ops_checklist`:用于经营/内容任务的事实核对、资料库来源提醒、媒体能力调用顺序约束;它不生成装饰 UI,只给 Agent 一个可测的台球门店运营核对入口。
- `/agent/run` 的主 registry、同步子代理底座、后台子代理底座和审批执行 registry 都接入 `domainPackTools`;`/agent/prewarm` 返回 `domainTools.count`;`/api/v1/agent/packs` 元数据新增 `suggested_tools`。
- ToolSearch 热工具白名单加入 `billiards_ops_checklist`,避免“SessionStart 提示可用,但首轮 schema 被延迟披露藏起来”的断点;未来行业包若工具很多,仍应只把核心入口放热区,长尾走 `tool_search`。
- 验证:`cd ts && bun test src/packs/domainPacks.test.ts src/server/index.test.ts -t "domain pack|enabled packs|billiards_ops_checklist|pack tools|mounts enabled packs|recommendations"` = 8 pass;`cd ts && bun run typecheck` clean。

## 3.134 2026-07-07 Provider 健康历史与排障可视化

- `ProviderHealthStore` 新增有界 `history` 队列(最近 80 条):记录 provider 失败、成功恢复、手动清冷却三类事件,包含脱敏错误、失败分类、失败次数和时间;仍与 `providers.json` 分离。
- `/model` / `/api/model` 新增 `healthHistory` 短列表(最近 8 条),与现有 `health[]/coolingCount/runtime` 同步返回;历史只用于解释排障,不改变 failover 排序或 active provider 配置。
- 设置抽屉 “AI 通道详情” 新增“最近排障记录”:显示通道名、失败/限流/配置失败/恢复/手动重试、时间与脱敏错误;默认仍折叠,不打扰普通用户。
- 安全口径:历史事件只接收 `sanitizeProviderError()` 后的错误摘要,路由级测试锁住 `/model` 不回显 `primary-secret/sk-primary`;手动清冷却只写健康文件历史,不修改 provider 配置。
- 验证:`cd ts && bun test src/server/services/providerHealthStore.test.ts` = 5 pass;`cd ts && bun test src/server/index.test.ts -t "cools down a recently failed primary provider|health/clear"` = 2 pass;`cd ts && bun run typecheck`;`cd web && pnpm exec tsc --noEmit` clean。

## 3.135 2026-07-07 Trace Window 通用纯逻辑抽象

- 新增 `web/src/components/desktop/trace-view.ts`:把 trace 搜索、折叠窗口、相邻 phase 分组抽成通用纯函数,后台任务和同步 `agent_task` 不再各自维护一套相似逻辑。
- `background-task-events` 仍负责把 SSE/task event 转成启动/思考/工具/进度/确认/提醒/收束/错误行;`subagent-trace` 仍负责把“子代理 …”文本转成启动/工具/进度/异常/收束行;两者统一复用 `buildTraceWindow()` 生成 `lines/lineViews/phaseGroups`。
- 行为保持兼容:旧 `lines` 文本、搜索命中、折叠提示、phase chip 和 markers 都不变,只收敛底层实现,为后续统一 trace 面板/跨任务过滤打地基。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/background-task-events.test.ts src/components/desktop/subagent-trace.test.ts` = 13 pass;`cd web && pnpm exec tsc --noEmit` clean;`git diff --check` clean。

## 3.136 2026-07-07 项目规则 Scope 状态线可见

- `workspace-status` 响应新增 `projectInstructions`:后端用同一套 `projectInstructions` loader 汇总工作区根级 `AGENTS.md/CLAUDE.md` 文件名、数量和截断状态;前端不用自己碰本机文件路径。
- 新增 `project-instruction-status` 纯逻辑:从历史消息和实时工具步骤里提取最近一次 `list_project_instructions` scope 查询结果,并与根级规则摘要合成一个低噪“规则”状态 chip。
- `AgentStatusLine` 新增“规则”chip:显示 `规则:根1 · scope1` / `规则:scope空` / `规则:无根级`,tooltip 展示具体规则文件和最近 scope 命中情况;不新增卡片墙,不改变项目指令优先级。
- 价值:用户在 coding/改文件时能持续看到 Agent 是否有根级项目规则、是否刚核对过陌生子目录 scope,不必翻工具结果才能确认规则加载状态。
- 验证:`cd ts && bun test src/server/index.test.ts -t "workspace status"`;`cd web && pnpm exec vitest run src/components/desktop/project-instruction-status.test.ts src/components/desktop/project-instruction-scope.test.ts`;`cd ts && bun run typecheck`;`cd web && pnpm exec tsc --noEmit` clean。

## 3.137 2026-07-07 ToolSearch 中文意图别名追加落地

- `tool_search` 新增稳定工具别名层:为核心 coding 工具、项目规则、诊断验证、文件回滚、知识库、子代理/后台任务、媒体入口等补中文/英文意图词,例如“跑类型检查”→`project_diagnostics`、“查引用”→`grep_files`、“回滚文件”→`restore_file`、“生图”→`generate_image`。
- 别名只参与搜索打分,不改变默认可见 schema、不扩权限、不让隐藏工具绕过 registry/审批链路;MCP 工具仍只加通用“插件/外部工具”类别名。
- 价值:在 lazy schema 模式下,中文模型或中文用户任务不必准确猜英文工具名,减少“明明有工具却搜不到”的长任务绕路。
- 验证:`cd ts && bun test src/tools/toolSearchTool.test.ts` = 3 pass;`cd ts && bun run typecheck` clean。

## 3.138 2026-07-07 Coding Agent grep_files files_only 影响面扫描追加落地

- `grep_files` 新增 `files_only?: boolean|string`:复用现有 glob 扫描、敏感文件跳过、literal/regex、大小写和文件大小限制,但命中后只返回相对文件路径,一文件一行。
- 默认行为保持兼容:不传 `files_only` 时仍返回 `path:line:text` 和 context 行;传 `files_only:true` 时每个文件内部只找首个命中,减少大仓库“先看影响面”阶段的上下文消耗。
- 截断提示区分“匹配文件”与“匹配行”,让模型能先 `grep_files files_only:true` 定位候选文件,再用 `read_many_files`/`code_outline` 精读,更贴近长任务 coding agent 的工具节奏。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts -t "grep_files"` = 4 pass。

## 3.139 2026-07-07 流式文件改动右侧预览焦点策略落地

- 新增 `web/src/components/desktop/preview-state.ts` 纯逻辑:统一处理右侧预览在文件写入/补丁/批量编辑流式事件中的焦点选择,避免策略散在 `chat-shell` JSX 回调里。
- 行为:文件 mutation 一开始立即显示 `file_pending`;同一路径完成后替换成 diff/error;如果一轮里连续改多个文件,较早文件的完成事件不会抢走较新仍在执行的 pending 预览,右侧始终优先展示当前正在改的文件。
- 中间对话流继续由 `liveSteps` 显示工具进度,右侧 artifact 专注显示当前文件的 pending/diff/error 三态,符合 Work Buddy/Codex 低噪工具流,不新增卡片墙。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/preview-state.test.ts src/hooks/use-agent-chat.test.ts` = 12 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.140 2026-07-07 配色时间线与媒体工作台文档口径清理

- 复扫现行设计规范、竞品拆解、README 与 E 批遗留台账:确认走法 B 仍是单一当前口径,即砍蓝 `#007AFF/#0a84ff`、绿 `#10a37f` 只作点缀、主按钮/用户气泡/选中态走中性。
- `docs/README.md` 不再写“当前实装仍是白底+绿+蓝 UI”;`docs/references/竞品拆解/02` 把早期“现状”改成 2026-07-05 诊断对象;`docs/模块修复-遗留与注意事项.md` 把 handoff 蓝色 polish 和视频 caveat 前端露出从未做项改成已由 TS 批次解决/剩真机验证。
- 代码复扫:生成工作室与视频工作台主按钮/选中态继续走 `app-primary-action/app-active-neutral`;`rg "#007AFF|#0a84ff" web docs ts desktop` 剩余命中只在历史/决策文本,不是现行 UI 代码。
- 验证:`git diff --check` clean。

## 3.141 2026-07-07 read_many_files ranges 批量行段读取落地

- `read_many_files` 新增 `ranges?: [{path,start_line?,end_line?,max_bytes?}]`:模型可以先用 `grep_files files_only:true` 或普通 `grep_files` 找影响面,再一次性读取多个文件的命中附近窗口,不用多轮 `read_file`。
- 旧 `paths` 行为保持兼容;`ranges` 存在时优先读取行段,复用 `read_file` 的 `<file_chunk>` 元数据、行数/字节截断标记、项目指令注入和“读过才能安全编辑”的 recent-file 快照。
- 批量读取会去重完全相同的 range,输出 `duplicates_omitted`;`omitted` 只表示超过 `MAX_MANY_FILES` 上限后被截掉的目标数,避免重复项与上限截断混淆。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts` = 41 pass;`cd ts && bun run typecheck` clean。

## 3.142 2026-07-07 店铺资料库来源结构化落地

- `search_store_docs` 保留原有 `<store_doc_sources>` 人类可读来源块,同时新增 `<store_doc_sources_json>` 结构化块,字段直接来自 `StoreDocHit[]`:source id、文件名、chunk、可信度、分数、匹配词、原因、摘录、路径。
- 前端 `parseStoreDocSources()` 现在优先解析 JSON 来源块,失败或历史会话没有 JSON 时再回退旧文本格式;来源卡不再依赖脆弱的中文行拆分作为唯一入口。
- 价值:专有知识库问答的“用了哪些店铺资料”更稳定,后续模型提示、工具输出文案、或来源展示样式微调,不容易把右侧/对话中的来源卡打坏。
- 验证:`cd ts && bun test src/server/services/storeDocsService.test.ts` = 4 pass;`cd web && pnpm exec vitest run src/components/desktop/store-doc-sources.test.ts` = 3 pass;`cd ts && bun run typecheck`;`cd web && pnpm exec tsc --noEmit` clean。

## 3.143 2026-07-07 patch_files 多文件原子补丁落地

- 新增默认工具 `patch_files`:模型可一次提交多个文件的 unified diff,先逐文件校验 fresh read、路径去重、hunk 计数和 exact context,全部通过后才开始写入;任一写入失败会尽力回滚已经写过的文件。
- 重复文件按 workspace resolve 后的绝对路径去重,避免 `src/a.ts` 与 `src/../src/a.ts` 这类等价路径绕过“同一文件 hunks 必须合并”的原子性保护。
- 成功结果返回 `<file_changes count="N">` 包裹多个 `<file_change path snapshot_id backup_path>`;每个文件都记录 `op:patch_files` 快照与 `.backups` 备份,继续接入 `file_history/restore_file` 和右侧 diff 预览链路。
- ToolSearch 热工具和中文别名加入 `patch_files`,前端工具标签、审批文案、pending/error/diff artifact 都识别多文件补丁;`patch_files` 发起时会用 `patches[0].path` 立即打开“正在应用多文件补丁”预览,不会因为参数没有顶层 `path` 而丢掉流式反馈。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts -t "patch_file|patch_files"` = 6 pass;`cd ts && bun test src/tools/fileTools.test.ts` = 44 pass;`cd ts && bun test src/tools/generalTools.test.ts src/tools/toolSearchTool.test.ts` = 6 pass;`cd web && pnpm exec vitest run src/hooks/use-agent-chat.test.ts src/lib/agent-tools.test.ts` = 10 pass;`cd ts && bun run typecheck`;`cd web && pnpm exec tsc --noEmit`;`git diff --check` clean。

## 3.144 2026-07-07 多文件改动右侧 diff 列表预览落地

- `fileArtifactFromToolResult()` 不再只取第一个 `<file_change>`:当工具结果包含多个文件改动时返回 `diff_list`,保留每个文件的 `path/backupPath`,单文件结果仍保持原 `diff` 兼容。
- 右侧预览新增 `diff_list`:顶部显示文件切换条,下方复用现有 `DiffPreview/DiffBlock`,用户可在一次跨文件补丁完成后逐个查看 diff、逐个恢复备份,不需要回到工具原文里找隐藏的第二/第三个文件。
- 流式焦点策略同步识别 `diff_list`:如果当前 pending 文件包含在完成的多文件 diff 里就替换为 diff 列表;如果是更早一批多文件 diff 完成,不会抢走更新的 pending 文件焦点。
- 对话步骤里的“打开”也识别多文件 `<file_change>` 结果,手动回看历史工具步骤时打开整组 diff,不是只看第一个文件。
- 验证:`cd web && pnpm exec vitest run src/hooks/use-agent-chat.test.ts src/components/desktop/preview-state.test.ts src/lib/agent-tools.test.ts` = 16 pass;`cd web && pnpm exec tsc --noEmit`;`git diff --check` clean。

## 3.145 2026-07-07 首屏今日简报去卡片化

- `BriefingCard` 从白底边框卡片改为无背景的分隔线列表:保留“今日店况”、两条建议、来源标签、去做/不感兴趣,但视觉上不再像一张主卡占据对话首屏。
- 目的:继续落实 Work Buddy/Codex 式低噪工具流,主对话区不靠卡片墙展示能力;店铺建议只是起手辅助,不抢输入框和对话主任务。
- 验证:`cd web && pnpm exec tsc --noEmit`;`git diff --check` clean;Playwright 真实页面截图 `output/playwright/chat-welcome-low-noise-2026-07-07.png` 确认首屏无明显重叠/空白,多文件 diff 截图 `output/playwright/diff-list-preview-2026-07-07.png` 与 `output/playwright/diff-list-preview-b-tab-2026-07-07.png` 确认右侧切换正常。

## 3.146 2026-07-07 系统提示补齐 coding 工具节奏

- `buildSystemPrompt()` 新增短段 `# Coding 工作流`:要求先用 `grep_files({files_only:true})/glob_files/code_outline` 扫影响面,再用 `read_file/read_many_files({ranges})` 精读必要窗口,避免大仓库里盲目 dump 文件。
- 编辑工具选择写进系统层:单处 `edit_file`、同文件多处 `multi_edit_file`、复杂 hunk `patch_file`、跨文件一组改动优先 `patch_files`;同时强调修改前必须先读目标文件、陌生目录先 `list_project_instructions({path})`。
- 价值:新工具不会只停留在 registry/schema 里,模型默认策略会更接近强 coding agent 的“先定位、再精读、成批原子改、最后验证”节奏。
- 验证:`cd ts && bun test src/harness/systemPrompt.test.ts` = 10 pass;`cd ts && bun run typecheck`;`git diff --check` clean。

## 3.147 2026-07-07 知识库 UI 文案与来源层级收敛

- `StoreDocsPanel` 的系统文案按 `03-文案话术与交互设计` 的“两套语域”收敛:系统层不再用“我帮你/没弄成”这类 AI 角色话术,改成“未设置/正在整理资料/整理失败/未找到相关片段”等可扫读状态。
- 店铺资料清除确认改成“清除店铺资料索引?”并明确“清除后将不再用于回答;原文件不会删除”,保持 Work Buddy 式“发生什么 + 后果/下一步”,避免用户误以为会删除本机文件。
- 对话里的店铺来源卡从“店铺资料来源”改为“引用的店铺文件”,展开后分层显示“引用原因 / 匹配词 / 摘录 / 路径与打开”,让专有知识库问答能清楚解释用了哪些店内文件,同时仍保持低噪工具流。
- `StoreMemoryPanel` 与设置抽屉里的记忆入口同步从“我的球房资料/AI 记的事/已记下/我确认的”等口吻收成“门店记忆/已保存/已确认/自动记录”,使用范围、空状态、待确认引导和保存提示都改为中性说明。
- `ScheduledTasksPanel` 清掉高曝光系统文案里的“帮你干一件事/要它干啥”,改为“自动执行一项任务/执行内容”,保持和 Codex/Work Buddy 的工具壳口吻一致。
- 新增 `system-copy-guard.test.ts`:源码级锁住知识库/门店记忆/定时任务/来源卡的关键文案和禁用旧词,避免后续 UI 改动把旧口吻带回来。
- 口径:行业知识、店铺文件、门店记忆继续分层呈现;这次只改 UI 文案和来源展示层级,不改变检索算法、来源解析、RRF/关键词融合或回答注入逻辑。

## 3.148 2026-07-07 grep_files 行号窗口输出追加落地

- `grep_files` 新增 `ranges?: true` 与 `range_context`:在影响面扫描后可直接输出 `<read_many_files_input>` JSON,模型不需要把 `path:line:text` 手工换算成 `read_many_files({ranges})` 参数。
- ranges 模式会按文件合并重叠/相邻窗口,保留 `<matched_lines>` 供模型知道命中行;默认窗口为命中行前后 20 行,最高 80 行,仍受原 `limit/include/path/literal/case_sensitive` 约束。
- 原有默认输出、`files_only:true`、context 行、敏感文件跳过、单文件大小上限、并发扫描和截断提示保持兼容;`ranges:true` 优先于 `files_only`。
- 系统提示同步更新 coding 工作流:大仓库先 `grep_files({files_only:true})/glob_files/code_outline` 定候选,需要命中附近代码窗口时用 `grep_files({ranges:true})` 直接接 `read_many_files({ranges})`。
- 价值:减少模型在大仓库里反复读错窗口、手算行号和多轮 `read_file` 的成本,让“先定位、再精读”的 coding 节奏更可靠。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts -t "grep_files|read_many_files"` = 8 pass;`cd ts && bun test src/harness/systemPrompt.test.ts` = 10 pass;`cd ts && bun run typecheck` clean。

## 3.149 2026-07-07 list_dir 递归项目树追加落地

- `list_dir` 新增 `recursive?: true` 与 `max_depth`:陌生项目可一次返回有界目录树,默认仍只列当前目录一层,兼容旧调用与旧测试。
- 递归模式默认深度 2、最高 5,总条目仍受 `limit`/`MAX_LIMIT` 保护;超过上限时给出“目录树超过 N 项”的截断提示,避免大仓库结构探索把上下文撑爆。
- 递归模式会跳过 `.git/.next/.turbo/node_modules/dist/build/coverage/.agent-state/.backups/.agent-file-history/desktop/binaries` 等重目录,用 `[skipped]` 标记,让模型知道目录存在但不继续展开。
- 系统提示同步更新 coding 工作流:陌生项目先 `list_dir({recursive:true,max_depth:2})` 看骨架,再用 `grep_files/glob_files/code_outline/read_many_files` 进入影响面定位和精读。
- ToolSearch 中文/英文别名补“递归目录/项目树/tree”,隐藏工具模式下也能用中文意图找到目录树能力。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts -t "list_dir|glob_files"` = 6 pass;`cd ts && bun test src/harness/systemPrompt.test.ts src/tools/toolSearchTool.test.ts` = 13 pass;`cd ts && bun run typecheck` clean。

## 3.150 2026-07-07 code_outline 符号窗口输出追加落地

- `code_outline` 新增 `ranges?: true` 与 `range_context`:在列出 imports/symbols 的同时,可输出 `<read_many_files_input>` JSON,直接精读符号附近窗口。
- ranges 模式按文件合并重叠/相邻符号窗口,并输出 `<symbol_lines>` 标记符号名与行号;默认窗口为符号行前后 20 行,最高 120 行。
- `code_outline({ranges:true})` 仍不写入 `ctx.fileReads`,不会绕过 `edit_file/patch_file` 的“先精读再编辑”保护;只有随后真正调用 `read_many_files` 才会记录读快照并解锁安全编辑。
- 系统提示同步更新 coding 工作流:命中附近代码窗口可用 `grep_files({ranges:true})` 或 `code_outline({ranges:true})` 直接生成 `read_many_files({ranges})` 输入。
- ToolSearch 别名补“符号窗口”,让中文意图也能找到这个结构导航能力。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts -t "code_outline|read_many_files"` = 7 pass;`cd ts && bun test src/harness/systemPrompt.test.ts src/tools/toolSearchTool.test.ts` = 13 pass;`cd ts && bun run typecheck` clean。

## 3.151 2026-07-07 git_status 只读改动查看工具落地

- 新增默认只读工具 `git_status`:输出当前 git 分支、`status --porcelain=v1 --branch`、`diff --stat`;可选 `include_diff:true` 输出有界 `git diff --no-ext-diff` 正文。
- 支持 `staged:true` 查看暂存区 diff,支持 `paths` 限定到 workspace-relative 路径;路径会先走 `Workspace.resolve(...,'read')`,再以 `--` 后 pathspec 传给 git,避免任意 pathspec/越界路径。
- diff 正文默认最多 80KB、最高 400KB,超过时在 `<diff ... truncated="true">` 标明;非 git 仓库返回 `<git_status is_git="false">` 而不是报错中断。
- 工具进入默认 registry、ToolSearch 热工具与中文别名;系统提示收尾阶段要求改完后用 `git_status({include_diff:true})` 或文件工具返回的 diff 检查实际改动,减少靠任意 shell 命令确认变更。
- 验证:`cd ts && bun test src/tools/gitStatusTool.test.ts src/tools/generalTools.test.ts src/tools/toolSearchTool.test.ts` = 10 pass;`cd ts && bun test src/harness/systemPrompt.test.ts` = 10 pass;`cd ts && bun run typecheck` clean。

## 3.152 2026-07-07 git_status 前端低噪展示落地

- 前端 `agent-tools` 新增 `git_status` 友好标签“查看 Git 改动”和图标,步骤行显示“正在/已查看 Git 改动”,不再暴露裸工具名。
- 新增 `git-status-result` 解析器:把 `<git_status>` 结果解析成 branch/status/diff stat/diff/truncated 等结构,测试覆盖普通 git diff、非 git 仓库和普通文本忽略。
- `chat-thread` 新增 Git 改动卡:默认只展示分支、状态、diff 统计和改动数量;diff 正文折叠展开,截断时显示“已截断”,避免把整段 patch 直接铺满对话流。
- 口径:右侧文件 diff 仍由文件工具 `<file_change>` 驱动;`git_status` 卡只负责改动总览和收尾核对,符合 Work Buddy/Codex 式低噪 trace。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/git-status-result.test.ts src/lib/agent-tools.test.ts` = 5 pass;`cd web && pnpm exec tsc --noEmit`;`git diff --check` clean。

## 3.153 2026-07-07 project_diagnostics 前端低噪展示落地

- 新增 `project-diagnostics-result` 解析器:把 `<project_diagnostics>` 的 completed/missing_package_json/missing_script/rejected 以及长结果 `<stored_tool_result tool="project_diagnostics">` 解析成结构化状态。
- `chat-thread` 新增项目诊断卡:默认只露出检查类型、package、脚本、包管理器、退出码/耗时和通过/失败/拦截状态;命令与输出折叠展示,避免 typecheck/lint/test 日志直接铺满对话流。
- 后端 `project_diagnostics` 拒绝不安全脚本时对脚本正文做 XML 转义,避免脚本里 `<`/`&`/重定向破坏工具结果结构,也让前端解析和模型回读稳定。
- 口径:诊断卡服务 coding agent 的“改动后可验证”闭环,与 `git_status` 改动总览互补;它不改变诊断脚本选择/审批策略,只降低流式展示噪声。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts -t "project_diagnostics"` = 4 pass;`cd web && pnpm exec vitest run src/components/desktop/project-diagnostics-result.test.ts src/components/desktop/git-status-result.test.ts src/lib/agent-tools.test.ts` = 10 pass;`cd ts && bun run typecheck`;`cd web && pnpm exec tsc --noEmit`;`git diff --check` clean。

## 3.154 2026-07-07 超长工具结果前端收纳卡落地

- 新增 `stored-tool-result` 解析器:读取 `<stored_tool_result>` 的 tool/call_id/chars/bytes/path/storage_error 与头尾预览,普通文本会忽略。
- `chat-thread` 新增通用“工具结果已收起”卡:对 `run_command/grep_files/glob_files/list_dir/code_outline` 等超长结果展示工具名、体量、完整结果路径和折叠头尾预览,不再让原始 XML 进入普通工具输出或终端块。
- `project_diagnostics` 仍走专用诊断卡,因为它需要显示退出码、脚本、通过/失败状态;通用卡只作为其他大结果的低噪兜底。
- 价值:大仓库搜索、递归目录、代码结构扫描和长命令输出可以落盘保护上下文,同时前端保持 Work Buddy/Codex 式简洁 trace。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/stored-tool-result.test.ts src/components/desktop/project-diagnostics-result.test.ts src/components/desktop/git-status-result.test.ts src/lib/agent-tools.test.ts` = 13 pass;`cd web && pnpm exec tsc --noEmit`;`git diff --check` clean。

## 3.155 2026-07-07 git_history 只读提交历史工具落地

- 新增默认只读工具 `git_history`:读取近期提交列表,可选 `include_patch:true` 查看某个 rev 的有界 `git show --patch`;支持 `paths` 限定到 workspace-relative 路径。
- `rev` 做保守校验:默认 `HEAD`,不能以 `-` 开头,不能包含空白、冒号、反斜杠或 NUL,避免把 option-like 参数传给 git;路径仍走 `Workspace.resolve(...,'read')` 和 `--` pathspec。
- patch 正文默认最多 80KB、最高 400KB;超限时停止 git 子进程并在 `<patch ... truncated="true">` 标记,避免历史 diff 撑爆上下文。
- 工具进入默认 registry、ToolSearch 热工具与中文别名;系统提示在“Coding 工作流”中要求做历史/回归分析时优先用 `git_history({paths})`,不靠任意 shell 乱翻。
- 前端工具文案新增“查看 Git 历史”,步骤行不暴露裸工具名;专用历史卡片待下一节接入。
- 验证:`cd ts && bun test src/tools/gitHistoryTool.test.ts src/tools/generalTools.test.ts src/tools/toolSearchTool.test.ts src/harness/systemPrompt.test.ts` = 21 pass;`cd web && pnpm exec vitest run src/lib/agent-tools.test.ts` = 2 pass;`cd ts && bun run typecheck`;`cd web && pnpm exec tsc --noEmit` clean。

## 3.156 2026-07-07 git_history 前端低噪展示落地

- 新增 `git-history-result` 解析器:把 `<git_history>` 解析成 rev/status/commits/patch/truncated/error/non-git 等结构。
- `chat-thread` 新增 Git 历史卡:默认展示 rev、commit 数、短 sha、标题、作者和日期;patch 正文折叠展开并显示截断标记。
- 非 Git、非法 rev、git log error 走同一张卡的警告文本,不再把 XML 或整段 patch 直接铺进普通工具输出。
- 口径:`git_status` 负责当前工作区改动,`git_history` 负责只读历史/回归分析;两张卡都服务 coding trace 的低噪可解释。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/git-history-result.test.ts src/components/desktop/git-status-result.test.ts src/lib/agent-tools.test.ts` = 8 pass;`cd web && pnpm exec tsc --noEmit`;`cd ts && bun run typecheck`;`git diff --check` clean。

## 3.157 2026-07-07 git_status 未跟踪文件预览补齐

- `git_status({include_diff:true})` 新增未跟踪文件预览:默认用 `git ls-files --others --exclude-standard` 找新文件,逐个走 workspace 读边界并只读取前 N 字节,在 `<untracked_files>` 里输出有界文本预览、大小、截断和 binary 标记。
- 新增 `include_untracked:false` 可关闭预览,`max_untracked_bytes` 控制总预览体量(默认 40KB,最高 200KB);staged diff 模式不混入未跟踪文件。
- 前端 `git-status-result` 解析 `<untracked_files>`;Git 改动卡新增折叠的“未跟踪文件 N 个”区域,只展开时显示新文件内容,避免新建文件在收尾核对时不可见。
- 价值:改完代码后的 `git_status({include_diff:true})` 现在能同时覆盖 tracked diff 和新建文件内容,更接近强 coding agent 的真实改动审阅闭环。
- 验证:`cd ts && bun test src/tools/gitStatusTool.test.ts src/tools/generalTools.test.ts` = 8 pass;`cd web && pnpm exec vitest run src/components/desktop/git-status-result.test.ts src/components/desktop/git-history-result.test.ts src/lib/agent-tools.test.ts` = 8 pass;追加 prefix read 后 `cd ts && bun test src/tools/gitStatusTool.test.ts` = 5 pass;`cd ts && bun run typecheck`;`cd web && pnpm exec tsc --noEmit`;`git diff --check` clean。

## 3.158 2026-07-07 本批 coding trace 聚合验证

- 聚合覆盖本批新增/改动的 `git_history`、`git_status`、`project_diagnostics`、默认 registry、ToolSearch、系统提示、前端 Git/诊断/超长结果解析器和工具标签。
- 验证:`cd ts && bun test src/tools/gitHistoryTool.test.ts src/tools/gitStatusTool.test.ts src/tools/generalTools.test.ts src/tools/toolSearchTool.test.ts src/harness/systemPrompt.test.ts src/tools/fileTools.test.ts -t "git_history|git_status|general registry contains|工具发现|Coding 工作流|project_diagnostics"` = 15 pass;`cd web && pnpm exec vitest run src/components/desktop/git-history-result.test.ts src/components/desktop/git-status-result.test.ts src/components/desktop/project-diagnostics-result.test.ts src/components/desktop/stored-tool-result.test.ts src/lib/agent-tools.test.ts` = 16 pass;`git diff --check` clean。

## 3.159 2026-07-07 Git 审阅结果纳入上下文落盘保护

- `toolResultStorage` 白名单补 `git_status` 与 `git_history`:大 diff、未跟踪文件预览和历史 patch 超过默认 24K 字符时写入会话 state 目录,模型/前端只接收 `<stored_tool_result>` 头尾预览。
- 口径:`git_status/git_history` 都是可重取只读工具,适合落盘保护;`read_file/read_many_files` 仍不落盘,避免模型为了拿源码上下文反复走文件读取。
- 前端已由 3.154 通用“工具结果已收起”卡兜底,因此 Git 审阅大结果不会退回裸 XML/长 patch 铺屏。
- 验证:`cd ts && bun test src/context/toolResultStorage.test.ts src/harness/loop.test.ts -t "tool result|stored_tool_result|大结果|Git 审阅"` = 3 pass;`cd ts && bun run typecheck`;`git diff --check` clean。

## 3.160 2026-07-07 多文件补丁流式预览补齐

- 前端新增 `file_pending_list` 预览状态:`patch_files` 一开始执行就把所有目标文件推到右侧预览,不再只显示第一个文件“正在修改”。
- `preview-state` 支持 pending list 与完成态 `diff_list` 的路径重叠判断:同一组多文件补丁完成后自动切到多文件 diff;如果旧文件较晚完成,不会抢走当前正在修改的另一组文件预览。
- 右侧 `PreviewPanel` 新增多文件 pending 视图:显示正在应用多文件补丁、文件总数和完整目标列表,完成后继续复用既有 `DiffListPreview`。
- 价值:代码修改的流式状态更接近强 coding agent 的真实工作台,用户能在工具执行中看清“正在动哪些文件”,而不是等结果落定才知道影响面。
- 验证:`cd web && pnpm exec vitest run src/hooks/use-agent-chat.test.ts src/components/desktop/preview-state.test.ts` = 16 pass;`cd web && pnpm exec tsc --noEmit`;`git diff --check` clean。

## 3.161 2026-07-07 超长工具结果安全回读工具落地

- 新增默认只读工具 `read_stored_tool_result`:专门读取 `<stored_tool_result path="...">` 指向的大工具结果,支持 `offset/max_bytes/tail` 有界窗口读取。
- 安全边界:工具只能读取当前会话 `toolResultStoreDir` 内文件;绝对路径和相对文件名都会做 realpath 检查,symlink 指向目录外会被拒绝,不会给模型任意读 tmp/系统文件的后门。
- `runAgentLoop` 把 `toolResultStoreDir` 注入 `ToolContext`,系统提示要求看到 `<stored_tool_result>` 且头尾预览不够时用该工具回读,不要改用 shell `cat` 任意路径。
- 默认 registry、ToolSearch、前端工具标签同步接入“读取长工具结果”,让 hidden schema 场景下也能用中文意图找到。
- 价值:3.154/3.159 的大结果落盘现在闭环完整,模型既不会被长 diff/日志撑爆上下文,也能在需要时安全取回关键窗口。
- 验证:`cd ts && bun test src/tools/storedToolResultTool.test.ts src/harness/loop.test.ts -t "stored|read_stored|oversized|大结果"` = 6 pass;`cd ts && bun test src/tools/generalTools.test.ts src/tools/toolSearchTool.test.ts src/harness/systemPrompt.test.ts` = 16 pass;`cd web && pnpm exec vitest run src/lib/agent-tools.test.ts` = 2 pass;`cd ts && bun run typecheck`;`cd web && pnpm exec tsc --noEmit`;`git diff --check` clean。

## 3.162 2026-07-07 长工具结果回读前端低噪展示落地

- 新增 `stored-tool-result-read` 解析器:把 `<stored_tool_result_read>` 解析成 status/path/size/offset/bytes/truncated/content。
- `chat-thread` 新增长工具结果窗口卡:默认只展示 path、窗口范围、读取状态和截断标记;具体内容折叠展开,避免回读大日志/patch 后又把原始 XML 铺满对话流。
- 失败态如 `missing_store_dir/rejected/missing/not_file` 也走同一卡片展示,让用户能看懂为什么不能回读。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/stored-tool-result-read.test.ts src/components/desktop/stored-tool-result.test.ts src/lib/agent-tools.test.ts` = 8 pass;`cd web && pnpm exec tsc --noEmit`;`git diff --check` clean。

## 3.163 2026-07-07 project_diagnostics 新文件路径定位补齐

- `project_diagnostics` 的起始路径解析改成“向上找最近已存在父级”:当模型准备新建 `packages/app/src/new-file.ts` 这类尚不存在的文件时,不会因为目标文件不存在而直接失败。
- 这让新增文件/新增目录场景也能命中最近 package 的 `typecheck/lint/check` 脚本,补齐强 coding agent 在动手后立刻验证的常见路径。
- 边界保持保守:解析过程仍被 workspace root 包住,越界或一路找不到已存在父级时退回工作区根,不扩大读写权限。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts -t "project_diagnostics"` = 5 pass;`cd ts && bun run typecheck` clean;`git diff --check` clean。

## 3.164 2026-07-07 project_diagnostics monorepo 包链补齐

- `project_diagnostics` 不再只停在最近 package:现在会从目标路径向上收集 package 链,优先用最近包的安全脚本;如果最近包只有 `build` 等非诊断脚本,会回退到上层 package 的 `typecheck/lint/check`。
- 包管理器识别也改为向上查找:子包没有锁文件时会继承根目录 `bun.lock/pnpm-lock.yaml/yarn.lock/package-lock.json` 或 `packageManager` 字段,避免 monorepo 子包误跑 `npm run`。
- 价值:新增文件、workspace 子包、根级统一诊断这三类高频 coding 场景都能自动走正确验证脚本,减少“工具显示缺脚本但项目其实可验证”的假阴性。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts -t "project_diagnostics"` = 7 pass;`cd ts && bun run typecheck` clean。

## 3.165 2026-07-07 project_diagnostics 编排型诊断脚本放行

- 安全脚本判定补充常见包管理器/编排器委派形态:例如 `bun run typecheck:inner`、`pnpm -r typecheck`、`turbo run lint`、`nx ... check` 这类诊断脚本不再被误判为“不像类型检查/静态检查命令”。
- 原有危险拦截仍保留:删除/移动/写文件命令、输出重定向、`sed/perl -i`、`--fix/--write/--update/--watch`、依赖安装/发布、网络/远程访问仍会被 `project_diagnostics` 拒绝,需要显式 `run_command` 审批。
- 价值:monorepo 根脚本通常只是把真实检查分发到子包;这次补齐后,Agent 在大仓库里更少遇到“明明有验证脚本却无法自动验证”的收尾断点。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts -t "project_diagnostics"` = 9 pass;`cd ts && bun run typecheck` clean。

## 3.166 2026-07-07 文件历史/恢复结果前端低噪展示

- 新增 `file-history-result` 与 `restore-file-result` 解析器:把 `file_history` 的快照行、`snapshot_diff`、`snapshot_diff_error` 以及 `restore_file`/`restore_preview` 结果拆成结构化数据。
- `chat-thread` 新增“文件历史”卡和“恢复文件”卡:默认只展示路径、快照 id、操作类型、seq/size/缺失前态等摘要;restore diff 和 snapshot diff 均折叠展开。
- 口径:文件修改链路现在从“改文件 -> 右侧 diff -> 看历史 -> 预览/恢复”都保持 Work Buddy/Codex 式低噪 trace,不再把 `<restore_file>` 或 `<snapshot_diff>` 原始块直接塞进普通工具结果。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/file-history-result.test.ts src/components/desktop/restore-file-result.test.ts src/lib/agent-tools.test.ts` = 6 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.167 2026-07-07 文件历史/恢复大 diff 纳入落盘保护

- `toolResultStorage` 白名单补 `file_history` 与 `restore_file`:带 `include_diff` 的历史快照、恢复预览/恢复结果如果超过阈值,会写入会话工具结果目录,上下文只保留头尾预览。
- 口径:`read_file/read_many_files` 仍不落盘,保持源码上下文工具的直接可见;回滚/审阅 diff 属于可回读结果,适合用 `read_stored_tool_result` 按窗口安全读取。
- 价值:代码修改链路的“看历史/回滚”不再因为大文件 diff 把模型上下文撑爆,也不会让前端重新铺满长 patch。
- 验证:`cd ts && bun test src/context/toolResultStorage.test.ts` = 3 pass;`cd ts && bun run typecheck` clean。

## 3.168 2026-07-07 文件历史/恢复 stored 形态专用展示

- `file-history-result` 与 `restore-file-result` 追加 `<stored_tool_result tool="file_history|restore_file">` 解析:大结果落盘后仍走文件历史/恢复专用卡,不退回通用“工具结果已收起”卡。
- 文件历史卡会从头尾预览里尽量提取可见快照行;恢复卡会显示“恢复结果已收起”、完整结果路径和可见 diff 预览,需要细看时再用长工具结果窗口读取。
- `toolResultStorage` 的模型提示文案同步改成“用 `read_stored_tool_result` 按窗口读取该 path”,避免模型看到磁盘 path 后改用 shell `cat` 任意路径。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/file-history-result.test.ts src/components/desktop/restore-file-result.test.ts` = 6 pass;`cd ts && bun test src/context/toolResultStorage.test.ts` = 3 pass;`cd web && pnpm exec tsc --noEmit`;`cd ts && bun run typecheck` clean。

## 3.169 2026-07-07 project_diagnostics 坏 package.json 结构化失败

- `project_diagnostics` 向上找 package 链时不再让坏 `package.json` 的 JSON parse 异常直接冒泡成普通工具错误;在找到可用诊断脚本之前遇到坏文件,会返回 `<project_diagnostics status="invalid_package_json" ...>`。
- 前端 `project-diagnostics-result` 同步识别 `invalid_package_json`,诊断卡显示“package.json 无效”和 parse error,不把错误状态裸露给普通结果块。
- 边界:如果最近子包已经有可用诊断脚本,更上层坏 package 不影响当前验证;如果目标子包自己的 package 坏了,不会静默回退根脚本假装验证通过。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts -t "project_diagnostics"` = 10 pass;`cd web && pnpm exec vitest run src/components/desktop/project-diagnostics-result.test.ts` = 6 pass;`cd ts && bun run typecheck`;`cd web && pnpm exec tsc --noEmit` clean。

## 3.170 2026-07-07 git_status 已暂存/未暂存一次审阅

- `git_status` 新增 `staged:"both"` 模式:一次输出工作区未暂存 `<diff>`、已暂存 `<staged_diff>`、对应 `<staged_diff_stat>` 和未跟踪文件预览,避免收尾只看到 unstaged diff 漏掉 staged 改动。
- 前端 `git-status-result` 与 Git 改动卡同步支持 staged diff:默认仍低噪折叠,需要时分开展开“diff”和“已暂存 diff”。
- 系统提示的 Coding 工作流收尾检查改成 `git_status({include_diff:true,staged:"both"})`,让模型默认一次看全已暂存/未暂存/未跟踪内容。
- 验证:`cd ts && bun test src/tools/gitStatusTool.test.ts src/harness/systemPrompt.test.ts` = 16 pass;`cd web && pnpm exec vitest run src/components/desktop/git-status-result.test.ts src/lib/agent-tools.test.ts` = 5 pass;`cd ts && bun run typecheck`;`cd web && pnpm exec tsc --noEmit` clean。

## 3.171 2026-07-07 Git 大结果落盘后保留专用卡

- `git-status-result` 与 `git-history-result` 追加 `<stored_tool_result tool="git_status|git_history">` 解析:Git diff/patch 超长落盘后,前端仍优先渲染 Git 改动卡/Git 历史卡,不退回通用长结果卡。
- Git 改动卡和 Git 历史卡会显示完整结果 path,并从头尾预览里尽量恢复 branch/status/commit/patch 元数据;需要细看时再用长工具结果窗口按 path 回读。
- `ToolStepRow` 的通用 stored 兜底排除已识别的 Git 专用卡,避免同一条大 Git 结果双渲染。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/git-status-result.test.ts src/components/desktop/git-history-result.test.ts src/lib/agent-tools.test.ts` = 10 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.172 2026-07-07 ToolSearch Git 全量审阅别名补齐

- `tool_search` 的 `git_status` 稳定别名补充“暂存 diff / 已暂存改动 / 全量改动审阅 / staged changes / staged diff”,让模型在 schema 懒加载场景也能找到 `git_status({include_diff:true,staged:"both"})` 这条收尾审阅路径。
- 回归测试新增“暂存 diff”“全量改动审阅”两类中文意图,确保不会被 `git_history` 或通用搜索工具抢走。
- 价值:3.170 的 staged/unstaged 一次审阅不只是工具参数存在,而是能被模型通过中文 coding 意图稳定发现并使用。
- 验证:`cd ts && bun test src/tools/toolSearchTool.test.ts src/harness/systemPrompt.test.ts` = 13 pass;`cd ts && bun run typecheck` clean。

## 3.173 2026-07-07 ToolSearch 回归追溯意图补齐

- `tool_search` 的 `git_history` 稳定别名补充“谁改的 / 为什么改 / 追溯修改 / 回归来源”,让模型在排查“这段代码为什么这样写、哪个提交引入回归”时更容易找到只读历史工具。
- 回归测试新增“这段代码谁改的”“追溯修改原因”两类自然语言查询,确保回归定位意图稳定命中 `git_history`。
- 价值:回归分析不再依赖模型记住工具名或直接 shell `git log`;它能通过中文排障意图发现受控、有界、可低噪展示的历史工具。
- 验证:`cd ts && bun test src/tools/toolSearchTool.test.ts` = 3 pass;`cd ts && bun run typecheck` clean。

## 3.174 2026-07-07 grep_files ranges 前端低噪展示

- 新增 `grep-ranges-result` 解析器与 `chat-thread` 专用卡:当 `grep_files({ranges:true})` 返回 `<grep_ranges>` 时,前端展示“代码搜索范围”摘要、命中数、范围数和前几个可精读行号窗口。
- `read_many_files({ranges})` JSON 输入与原始命中行默认折叠,截断提示单独以轻量警告露出;模型仍能从工具结果继续接 `read_many_files`,用户界面不再被 XML/JSON 原文刷屏。
- `ToolStepRow` 的通用结果披露和通用长结果卡会避开已识别的 grep ranges 专用形态,保持 Work Buddy/Codex 式低噪 trace。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/grep-ranges-result.test.ts src/lib/agent-tools.test.ts` = 4 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.175 2026-07-07 code_outline ranges 前端低噪展示

- 新增 `code-outline-ranges-result` 解析器与 `chat-thread` 专用卡:当 `code_outline({ranges:true})` 返回 `<read_many_files_input>` 和 `<symbol_lines>` 时,前端展示“代码结构范围”摘要、文件数、范围数和前几个符号窗口。
- `read_many_files({ranges})` JSON 与符号行默认折叠;超出文件数用轻量提示露出,避免结构扫描结果在对话流里铺满 XML。
- 同步修正 ranges 解析器数字属性边界:缺失的 `matches/ranges/range_context/omitted` 不再被 `Number("")` 误显示为 0。
- 价值:`grep_files({ranges:true})` 与 `code_outline({ranges:true})` 两条“先定位、再精读”的 coding 主路径在前端都保持低噪,更贴近 Work Buddy/Codex 的工具 trace 密度。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/grep-ranges-result.test.ts src/components/desktop/code-outline-ranges-result.test.ts src/lib/agent-tools.test.ts` = 7 pass;`cd web && pnpm exec tsc --noEmit` clean;`cd ts && bun test src/tools/fileTools.test.ts -t "grep_files|code_outline|read_many_files"` = 11 pass。

## 3.176 2026-07-07 MCP task trace 前端低噪展示

- 新增 `mcp-task-result` 解析器:把 `<mcp_task_trace>` 里的 `<mcp_task>` / `<mcp_progress>` 和后续 `<mcp_result>` 拆成 server/tool/status/progress/result 结构。
- `chat-thread` 对 `mcp__*` 工具新增“MCP 任务”卡:默认展示 server、tool、最终状态和一行结果预览;任务过程与完整结果均折叠,避免 MCP task/progress XML 进入普通结果块。
- 价值:MCP 作为外部工具生态入口,现在 task-based tool 的长过程也能保持和子代理/后台任务一致的低噪 trace,不再因为接入第三方能力而把 coding 对话流打散。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/mcp-task-result.test.ts src/lib/agent-tools.test.ts` = 4 pass;`cd web && pnpm exec tsc --noEmit` clean;`cd ts && bun test src/mcp/client.test.ts` = 1 pass;`git diff --check` clean。

## 3.177 2026-07-07 MCP 普通结果前端低噪展示

- `mcp-task-result` 同步扩展普通 `<mcp_result>` 解析:无 task trace 的 MCP 工具结果也会拆成 server/tool/isError/result。
- `chat-thread` 对普通 `mcp__*` 工具新增“MCP 结果”卡:默认只展示 server、tool、完成/错误状态和一行结果预览,完整结果折叠展开。
- 价值:MCP 普通工具和 task 工具都不再退回通用 raw result,外部工具生态接入后仍保持同一套低噪 coding trace。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/mcp-task-result.test.ts src/lib/agent-tools.test.ts` = 5 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.178 2026-07-07 MCP resource/prompt 前端低噪展示

- 新增 `mcp-resource-prompt-result` 解析器:覆盖 `<mcp_resources>`、`<mcp_resource_result>`、`<mcp_prompts>`、`<mcp_prompt>` 四类 MCP 能力结果。
- `chat-thread` 对 `list_mcp_resources/read_mcp_resource/list_mcp_prompts/read_mcp_prompt` 新增专用卡:列表默认只露 server、数量和前几项;资源正文与 prompt messages 折叠展开。
- 价值:MCP 不只是工具调用,也是外部知识源和 prompt 模板入口;资源/Prompt 结果专用展示后,接插件、接知识库和接 prompt 包都不会把原始 XML 泄进主对话流。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/mcp-resource-prompt-result.test.ts src/components/desktop/mcp-task-result.test.ts src/lib/agent-tools.test.ts` = 9 pass;`cd web && pnpm exec tsc --noEmit` clean;`cd ts && bun test src/mcp/client.test.ts` = 1 pass;`git diff --check` clean。

## 3.179 2026-07-07 provider 健康详情前端二次脱敏

- `model-health-status` 导出统一 `sanitizeModelHealthError()`,状态 chip、冷却详情行和最近排障历史共用同一套脱敏逻辑。
- `settings-drawer` 不再直接渲染 `lastError/history.error`;即使后端或外部网关把 `Bearer ...`、`sk-...`、`api_key=...` 原文塞进错误,前端详情也会二次遮蔽。
- 价值:provider failover/健康排障是长 coding 任务稳定性的核心入口,但不能因为“可解释”把用户或内置网关密钥露到 UI 里;这补齐了状态线 tooltip 与详情面板之间的安全一致性。
- 验证:`cd web && pnpm exec vitest run src/hooks/model-health-status.test.ts` = 5 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.180 2026-07-07 MCP 大结果落盘保护与 stored 专用展示

- `toolResultStorage` 默认可落盘工具补 `list_mcp_resources/read_mcp_resource/list_mcp_prompts/read_mcp_prompt`,并对动态 `mcp__*` 工具启用同一套大结果落盘保护。
- `read_file/read_many_files` 仍不落盘,保持源码上下文直读;本次只保护外部 MCP 工具、资源和 Prompt 这类可重取/可窗口回读结果。
- MCP 前端解析器同步支持 `<stored_tool_result tool="mcp__...|read_mcp_resource|read_mcp_prompt|...">` 的头尾预览,大结果落盘后仍优先渲染 MCP 任务/结果/资源/Prompt 专用卡,不退回通用长结果卡。
- 价值:插件生态接进来后,外部搜索、文档资源、Prompt 模板都可能返回大文本;这次补齐后不会把模型上下文和前端 trace 撑爆,需要细看时再用 `read_stored_tool_result` 按窗口回读。
- 验证:`cd ts && bun test src/context/toolResultStorage.test.ts` = 4 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm exec vitest run src/components/desktop/mcp-task-result.test.ts src/components/desktop/mcp-resource-prompt-result.test.ts src/components/desktop/stored-tool-result.test.ts src/lib/agent-tools.test.ts` = 14 pass;`cd web && pnpm exec tsc --noEmit` clean;`cd ts && bun test src/harness/loop.test.ts -t "oversized|stored_tool_result|大结果|tool result"` = 2 pass;`git diff --check` clean。

## 3.181 2026-07-07 ToolSearch MCP 资源/Prompt 入口稳定化

- `tool_search` 热工具白名单加入 `list_mcp_resources/read_mcp_resource/list_mcp_prompts/read_mcp_prompt`:工具数超过延迟 schema 阈值时,这些 MCP 索引入口仍会常驻可见。
- 动态 `mcp__*` 长尾工具仍按原策略隐藏,不会因为本次改动把所有外部工具 schema 一次塞进模型上下文;模型需要具体外部工具时仍通过 `tool_search` 渐进揭示。
- ToolSearch 别名补“列 MCP 资源 / 读取插件资源 / 查看 MCP prompt / 读 prompt 模板”等中文意图,让模型能稳定找到 MCP 知识源和 prompt 模板入口。
- 价值:3.176-3.180 已把 MCP 结果展示和大结果保护补齐,这次补“怎么发现入口”;插件/知识源生态不再依赖模型记住英文工具名。
- 验证:`cd ts && bun test src/tools/toolSearchTool.test.ts` = 4 pass;`cd ts && bun test src/harness/systemPrompt.test.ts src/tools/generalTools.test.ts` = 13 pass;`cd ts && bun run typecheck` clean。

## 3.182 2026-07-07 文件修改流式预览失败收敛

- `file_change` 属性解析改成完整属性名匹配,避免 `backup_path` 排在 `path` 前面时把备份路径误当目标文件,导致右侧 diff 打开错误对象。
- 审批执行文件修改时,如果 `executeAgentTool` 直接抛错,右侧预览不再停留在“正在修改”spinner,而是立刻切到 `file_error` 并显示失败原因。
- 价值:用户发起代码修改后,中间 trace 与右侧预览都必须有明确状态迁移:开始即 pending,成功即 diff,失败即错误态;不能留下无止境 loading 或错文件 diff。
- 验证:`cd web && pnpm exec vitest run src/hooks/use-agent-chat.test.ts src/components/desktop/preview-state.test.ts` = 17 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.183 2026-07-07 工作台不可用占位入口收敛

- `/dashboard/workbench` 移除“模板”占位 tab 和“筹备中”空面板,只保留已接通的“生图 / 视频”两个可用面板。
- 价值:生图、生视频作为 Agent 外壳的插件式延伸能力可以共用同一工作台,但不能露出不可用入口;这符合 Work Buddy/Codex 式低噪原则,也避免用户误以为产品半成品。
- 验证:`cd web && pnpm exec tsc --noEmit` clean。

## 3.184 2026-07-07 媒体工作台系统文案收敛

- `studio/page.tsx` 的空态、生成失败、保存/复制/蒙版/拼接失败文案从“没出来/没成功/重试一下”等聊天口吻收成“没有生成结果/保存失败/可以稍后再试”等系统层表达。
- `VideoWorkspace` 的进度和结果文案从“讲了啥/好了叫你/出片好了”收成“正在分析/完成后会通知你/成片已完成”,导出按钮统一为“导出成片”。
- 价值:继续执行 `03-文案话术与交互设计` 的两套语域原则:系统层状态像 Work Buddy/Codex 一样短、准、给下一步;AI 对话本身再保持口语化。
- 验证:`cd web && pnpm exec tsc --noEmit` clean。

## 3.185 2026-07-07 跨文件编辑失败预览终态补齐

- `fileArtifactFromToolResult()` 新增 `file_error_list`:多文件 `patch_files` 开始时右侧显示多个 pending 文件,失败时也保留完整路径集合和错误原因,不再压扁成第一个文件的单文件错误。
- `nextPreviewItem()` 与 `DesktopPreviewPanel` 同步支持多文件错误态:pending list 会被同路径 error list 替换;较新的无关 pending 仍不会被旧任务失败抢走焦点。
- 价值:跨文件代码修改必须有对称状态迁移:开始是多文件 pending,成功是 diff list,失败是多文件 error list。用户不会在多文件 patch 失败时误以为只动了某一个文件。
- 验证:`cd web && pnpm exec vitest run src/hooks/use-agent-chat.test.ts src/components/desktop/preview-state.test.ts` = 19 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.186 2026-07-07 read_many_files 重叠行段合并

- `read_many_files({ranges})` 对同一文件的重叠/相邻行段做二次合并,输出 `<read_many_files ... ranges_merged="N">`,避免模型手写或外部工具给出重复窗口时把同一段代码反复塞进上下文。
- 只合并明确带行号且未设置 `max_bytes` 的普通窗口;带字节裁剪的特殊窗口保持原样,避免改变显式裁剪语义。旧 `paths` 批量读与完全相同 range 去重行为保持兼容。
- 价值:进一步压低“搜索/结构扫描 -> 精读必要窗口 -> 安全编辑”的 token 与工具输出噪音,同时仍记录读快照,不绕过 `edit_file/patch_file` 的读前置保护。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts -t "read_many_files"` = 6 pass;`cd ts && bun run typecheck` clean。

## 3.187 2026-07-07 命令与诊断输出 ANSI/控制码清洗

- 新增 `outputSanitize` 共享工具:普通输出和流式输出都移除 ANSI/OSC/CSI 控制序列,保留可读文本,并把 `\r` 进度覆盖符规范成换行。
- `run_command` 的实时 `tool_progress` 和最终尾部日志统一走流式清洗器;即使 ANSI escape 被子进程 chunk 切开,也不会把半截控制码推到前端 trace 或模型上下文。
- `run_command` 最终结果改为按总尾部字节截断后再分流 stdout/stderr;前端已有 `TerminalBlock` 会把 `【错误输出】` 单独染成错误日志,失败命令不再被混进“标准输出”。
- `project_diagnostics` 输出同样按流式清洗后入 TailBuffer,并对 `<output>` 做 XML 文本转义,避免测试/lint 日志里的 `&`、`<`、颜色码破坏前端专用诊断卡片解析。
- `project_diagnostics` 运行期间新增低噪 `tool_progress`:先提示正在运行的诊断命令,再推清洗后的实时日志片段;前端现有非命令进度行会自动显示最后一行,长 typecheck/lint 不再只剩静止 spinner。
- `read_stored_tool_result` 回读落盘长结果窗口时也做 ANSI/控制码清洗,避免历史长日志或第三方工具结果通过回读路径重新污染上下文。
- 价值:验证链路是 coding agent 的核心反馈回路;日志必须短、准、可读,不能把终端颜色控制码或 XML 破碎文本泄进 UI 和下一轮模型上下文。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts src/tools/fileTools.test.ts src/tools/storedToolResultTool.test.ts` = 83 pass;`cd ts && bun run typecheck` clean。

## 3.188 2026-07-07 门店记忆补充面板配色收敛

- `StoreMemoryPanel` 的“快速补充门店资料”从绿色浅底卡片收成中性边框/中性底,只保留图标与成功状态用 `#10a37f` 点缀。
- 价值:继续执行 Work Buddy/Codex 式低噪知识库 UI 口径;行业知识、店铺文件、门店记忆都属于同一知识库抽屉,不能在局部出现“绿色功能卡”破坏走法 B。
- 验证:`cd web && pnpm exec tsc --noEmit` clean。

## 3.189 2026-07-07 审批执行长结果落盘保护补齐

- `executeApproved()` 接入 `maybeStoreToolResult`:用户在审批卡点“确认”后,如果执行结果过长,返回给前端和模型续接的也是 `<stored_tool_result>` 头尾预览,不再把整段命令/诊断日志直接塞进主对话。
- `/api/v1/agent/execute` 为审批执行上下文传入当前会话的 `tool-results/<conversationId>` 目录;后续模型需要细看时,仍能用 `read_stored_tool_result` 在同一会话范围内安全回读。
- 价值:自动执行路径和审批后执行路径的上下文预算规则统一。coding agent 常见的“用户确认跑测试/跑构建/跑脚本”不会因为一次长日志把对话流、前端和下一轮模型上下文撑爆。
- 验证:`cd ts && bun test src/harness/loop.test.ts` = 46 pass;`cd ts && bun test src/server/index.test.ts -t "agent/execute"` = 2 pass;`cd ts && bun run typecheck` clean。

## 3.190 2026-07-07 审批长结果前端专用卡补齐

- `approvedToolResultMessage()` 识别 `<stored_tool_result>` 后不再把结果当普通 `run_command` 终端消息渲染,而是回到工具步骤路径,复用既有 `StoredToolResultCard`。
- 价值:后端 3.189 把审批长日志收成头尾预览后,前端也必须保持低噪;用户不会在批准命令后看到一整段 raw XML,而是看到可展开/可回读的长结果卡。
- 验证:`cd web && pnpm exec vitest run src/hooks/use-agent-chat.test.ts` = 10 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.191 2026-07-07 write_file 覆盖读前置保护补齐

- `write_file` 新建文件仍可直接执行;但目标已存在时,必须先通过 `read_file/read_many_files` 留下当前 mtime/size 快照,否则拒绝覆盖并提示先读取目标文件。
- 覆盖前会复核文件仍是普通文件,且 mtime/size 与最近读快照一致;如果用户或外部进程在读取后改过文件,本次全量写入会被拒绝,避免旧上下文覆盖新内容。
- 成功写入后继续记录 `<file_change path snapshot_id backup_path>` 和最新 `ctx.fileReads` 快照,所以模型刚创建/覆盖的文件在同一轮后续编辑、压缩恢复和右侧 diff 预览里仍能顺滑衔接。
- 价值:`edit_file/patch_file` 已有读前置保护,这次补上全量覆盖路径;coding agent 不能让 `write_file` 成为绕过安全编辑协议的后门。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts -t "write_file"` = 7 pass;`cd ts && bun test src/tools/fileTools.test.ts` = 59 pass;`cd ts && bun run typecheck` clean。

## 3.192 2026-07-07 git_status 大 diff 流式截断

- `git_status` 的有界 diff 读取从 `execFile` maxBuffer 改为 `spawn` 流式收集:只保留上限内 stdout 前缀,但持续消费子进程输出,避免超大 diff 直接变成 `stdout maxBuffer` 错误文本。
- staged/worktree diff、超多未跟踪文件列表等走同一条 bounded buffer 路径;模型仍能通过 `truncated="true"` 判断需要缩小路径或增加预算。
- 价值:改完代码后的自检是 coding agent 的收尾主路径;大仓库或大改动时,`git_status({include_diff:true})` 必须稳定返回可读前缀和截断信号,不能在最需要检查 diff 的时候失败成进程 buffer 错误。
- 验证:`cd ts && bun test src/tools/gitStatusTool.test.ts` = 7 pass;`cd ts && bun run typecheck` clean。

## 3.193 2026-07-07 文件预览 pending/diff 路径归一

- `nextPreviewItem()` 的文件改动匹配从字符串完全相等扩成标准化路径匹配:统一 `/` 分隔、去掉 `./` 与尾斜杠,并允许绝对路径与工作区相对路径按目录边界尾段匹配。
- 仍不做 basename 级别模糊匹配,避免 `src/a.ts` 和 `packages/other/a.ts` 这类不同文件被误合并。
- 价值:工具开始时的 pending 往往来自模型参数,完成后的 diff 来自后端 `<file_change>`;二者一个可能是绝对路径、一个可能是相对路径。归一后右侧预览能稳定从“正在修改”切到 diff/error,不留下假 loading。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/preview-state.test.ts` = 12 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.194 2026-07-07 主聊天欢迎屏起手卡收敛

- `WelcomeScreen` 移除台球/通用 starter card 数据和首屏卡片网格;主对话空状态只保留标题副文案、轻量快捷 action、必要的店况简报和最近作品/任务。
- 生图工作台内部仍保留场景草稿,但它是“填入生成表单、等用户改”的工作台控件,不再和主聊天首屏的 ReAct 起手卡混在一起。
- 价值:落实 Work Buddy/Codex 式低噪入口。主对话窗口应优先服务输入、代码修改、工具 trace 和右侧预览,不应该像模板市场一样在首屏堆卡片;媒体能力作为插件式延伸,放回对应工作台承载。
- 验证:`cd web && pnpm exec tsc --noEmit` clean。

## 3.195 2026-07-07 git_status 单路径参数容错

- `git_status` 的 `paths` 入参从只接受数组扩成 `string | string[]`;模型如果传 `{paths:"src/a.ts"}` 也能按单路径 scope 状态和 diff。
- JSON schema 同步标注 array/string 双形态,但仍会通过 workspace resolver 归一成仓库相对 pathspec,不会放宽越界路径。
- 价值:收尾自检工具要尽量接住低风险参数偏差。模型完成代码修改后,不应因为一个单路径字符串和数组的差异跳过 diff 检查。
- 验证:`cd ts && bun test src/tools/gitStatusTool.test.ts` = 9 pass;`cd ts && bun run typecheck` clean。

## 3.196 2026-07-07 git_status diff 禁用彩色输出

- `git_status` 的 diff/stat 命令统一加 `--no-color`,即使仓库或用户全局配置 `color.ui=always`,返回的 `<diff>` / `<diff_stat>` 也不会带 ANSI 控制码。
- 覆盖 worktree diff、staged diff 和 staged/worktree both 模式;这与 3.187 的命令/诊断日志清洗保持同一条低噪输出规则。
- 价值:diff 是模型自检和前端 Git 卡片的核心内容,必须是纯文本。颜色控制码不应污染 XML、前端展示或下一轮模型上下文。
- 验证:`cd ts && bun test src/tools/gitStatusTool.test.ts` = 9 pass;`cd ts && bun run typecheck` clean。

## 3.197 2026-07-07 主聊天首屏简报低噪收敛与完整链路验收

- `BriefingCard` 从“多条洞察列表”收成首屏最多 1 条可执行建议;保留 `今日店况`、来源标签和一个 `去做`,其余建议交给后续对话展开,避免主对话入口重新变成卡片看板。
- 完整本地链路验收方式已校准:当前 TS server 用 `bun run desktop/sidecars/backend-sidecar.ts server --host 127.0.0.1 --port 8851`,Next 用 `API_PROXY_URL=http://127.0.0.1:8851 pnpm --dir web dev --hostname 127.0.0.1 --port 3000`;此前只开前端会被 `/auth/me` 代理到旧端口挡住。
- 浏览器验收结果: `/dashboard/chat` 无“本地身份加载失败”,无 starter card 文案,`去做` 数量为 1;`/dashboard/workbench?panel=video` 可直接打开视频面板,只有“生图/视频”两个 tab,无“模板/筹备中”,未发现 `#007AFF`/蓝色候选样式。
- 价值:这次不是只靠 typecheck 推断 UI;主聊天首屏、媒体工作台 tab、视频工作台入口都在 TS 后端 + Next 正确代理下实际跑过,继续贴近 Work Buddy/Codex 式低噪入口。
- 验证:`cd web && pnpm exec tsc --noEmit` clean;浏览器只读 DOM 检查通过。

## 3.198 2026-07-07 web dev 默认代理切到 TS sidecar

- `web/next.config.js` 的默认 `API_PROXY_URL` 从旧 `http://localhost:8000` 改为 `http://127.0.0.1:8850`;源码开发时只要先跑 TS sidecar,直接 `pnpm dev` 就会代理到当前 TS 后端。
- 打包桌面仍不受影响:`desktop/scripts/build_frontend.js` 会显式传入自己的 `API_PROXY_URL`,旧 Python 打包链路或后续 TS 打包链路都由打包脚本决定,不是靠 Next 默认值。
- 价值:当前主线目标已经转向 TS/coding-agent 内核;开发和验收默认不应再指向旧 Python 端口,否则会出现“本地身份加载失败”这类假 UI 问题,干扰真实前端验收。
- 验证:`cd web && pnpm exec tsc --noEmit` clean。

## 3.199 2026-07-07 project_diagnostics 附近测试候选

- `project_diagnostics` 在安全 typecheck/lint/auto 诊断结果里新增 `<test_suggestions>`:基于同一 package chain 找到安全 `test` 脚本,再从被改文件附近查找 `.test/.spec`、`__tests__`、Python `test_*/_test.py` 等候选文件。
- 建议只作为元数据返回,不会自动执行测试;若 `test` 脚本含 `--watch`、`--fix`、重定向、安装/发布、远程访问等风险内容,候选区块会被省略,继续保持显式测试审批边界。
- 扫描有上限:最多 5 条建议、800 个目录项、4 层深度,并跳过 `node_modules/.git/.next/dist/build/coverage/output/.backups`,避免大仓库因为找测试拖慢 coding 主链路。
- 前端 `ProjectDiagnosticsCard` 解析并低噪展示一行“附近测试”,让用户和模型都能看到下一步聚焦验证路径,但不在工具 trace 里堆按钮或卡片。
- 系统提示的“改动后的验证”段同步要求:看到附近测试候选时,优先当作下一步聚焦验证线索,但不能把候选当成已执行结果。
- 价值:强 coding agent 不只是能改文件,还要能快速选对验证半径。这个增强让“先跑安全静态检查,再按邻近测试补行为验证”更自然,减少大仓库里只跑全量或漏测的情况。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts -t "project_diagnostics"` = 15 pass;`cd ts && bun test src/tools/fileTools.test.ts` = 62 pass;`cd ts && bun test src/harness/systemPrompt.test.ts` = 10 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm exec vitest run src/components/desktop/project-diagnostics-result.test.ts` = 6 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.200 2026-07-07 git_status 结构化 summary

- `git_status` 输出新增 `<summary>` 元数据,从 porcelain status 直接统计 `files/staged/worktree/untracked/modified/added/deleted/renamed/copied/conflicted/clean`,不额外跑 git 命令。
- `MM` 这类同一文件同时有暂存和未暂存改动时,`staged/worktree` 各计 1,但 `modified` 只按文件计 1,避免类别统计虚高。
- 前端 `GitStatusCard` 解析 summary 后在顶部低噪展示“文件 / 暂存 / 未暂存 / 未跟踪 / 冲突”chip;header badge 也改用结构化文件数,而不是从 status 文本粗略数行。
- 价值:收尾自检时,模型和用户都需要先知道改动规模和风险形态,再决定看 diff、跑测试或拆小 scope。结构化 summary 让大仓库 diff 不再只能靠扫 raw porcelain 文本判断。
- 验证:`cd ts && bun test src/tools/gitStatusTool.test.ts` = 9 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm exec vitest run src/components/desktop/git-status-result.test.ts` = 4 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.201 2026-07-07 project_diagnostics 聚焦测试执行入口

- `project_diagnostics` schema 新增 `test_paths:string|string[]`:只有 `check:"test"` 时生效,会把路径解析为当前 workspace 内路径,再要求落在选中的 package 目录下且真实存在。
- 运行命令从 `manager run test` 扩成 `manager run test -- <safe quoted paths>`;shell 参数只来自 workspace/package 校验后的相对路径,避免模型把任意 shell 拼接塞进诊断工具。
- 结果新增 `<test_targets>` 元数据;前端 `ProjectDiagnosticsCard` 低噪显示“测试范围”,并识别 `invalid_test_path` 状态。无效路径不会执行 package test 脚本。
- 系统提示同步要求:看到附近测试候选后,优先把它当作 `test_paths` 聚焦验证线索,不要把候选当作已执行结果;工具搜索也补了“聚焦测试/附近测试”别名。
- 价值:这把 3.199 的“建议你跑这个测试”变成同一安全诊断工具内的“可审批、可追踪、可截断、可解析”的聚焦测试执行路径,减少模型退回任意 `run_command` 的概率。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts -t "project_diagnostics"` = 17 pass;`cd ts && bun test src/tools/fileTools.test.ts` = 64 pass;`cd ts && bun test src/harness/systemPrompt.test.ts src/tools/toolSearchTool.test.ts` = 14 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm exec vitest run src/components/desktop/project-diagnostics-result.test.ts` = 7 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.202 2026-07-07 run_command 子目录 cwd 参数

- `run_command` schema 新增 `cwd:string`:默认仍在 workspace root 执行,传入时会经 workspace resolver 校验并确认是目录,不能越界、不能指向普通文件。
- `spawn` 的工作目录改用解析后的 `cwd`;sandbox 包裹命令和普通 shell 命令都走同一目录参数,不改变原有危险命令拦截、权限分类、超时、输出尾部截断和实时日志清洗逻辑。
- 系统提示同步要求:需要在 `ts`、`web` 等子包里跑命令时,优先用 `run_command({cwd:"子目录",command:"..."})`,减少 `cd ... && ...` 这类 shell 拼接。
- 价值:monorepo/多子包验证是 coding agent 高频路径。结构化 cwd 能降低命令注入面和模型拼错工作目录的概率,也让审批卡里的动作范围更清楚。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts` = 23 pass;`cd ts && bun test src/harness/systemPrompt.test.ts` = 10 pass;`cd ts && bun run typecheck` clean。

## 3.203 2026-07-07 grep_files 文件级/多 scope 搜索

- `grep_files` 的 `path` 从只适合目录扩成 `string|string[]`,并新增 `paths:string[]`;每个 scope 都可以是 workspace 内文件或目录,目录继续按 `include` glob 扫描,文件会直接进入搜索列表。
- 多个 scope 会去重并共用 `MAX_GREP_FILES` 上限;敏感文件过滤统一按 workspace 相对路径判断,不再依赖某个搜索 base。
- 系统提示同步要求:只想搜少数文件时直接用 `grep_files({path/paths:[...]})`,不要退回 shell grep 或把文件当目录误传。
- 价值:真实 coding 常见“只在这 2 个文件里查调用/查常量/查旧接口”。文件级 scope 能减少无关扫描、降低输出噪音,也让 `grep_files({ranges:true}) -> read_many_files({ranges})` 的精读链路更稳定。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts -t "grep_files"` = 7 pass;`cd ts && bun test src/tools/fileTools.test.ts` = 66 pass;`cd ts && bun test src/harness/systemPrompt.test.ts` = 10 pass;`cd ts && bun run typecheck` clean。

## 3.204 2026-07-07 read_many_files 单值容错

- `read_many_files.paths` 从只接受数组扩成 `string|string[]`;模型传 `{paths:"src/a.ts"}` 时会按单文件批量读处理,仍记录读快照并触发后续安全编辑保护。
- `read_many_files.ranges` 从只接受数组扩成 `range|range[]`;模型从 `grep_files/code_outline` 复制单个窗口时,不用因为少包一层数组导致工具失败。
- 系统提示同步说明:单值可接住低风险参数偏差,但多文件/多窗口仍建议用数组。
- 价值:精读工具是“搜索/结构扫描 -> 必要窗口 -> 安全编辑”的核心桥。接住单值入参可以减少模型在小改动里反复修正工具参数,让 coding loop 更顺。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts -t "read_many_files"` = 8 pass;`cd ts && bun test src/tools/fileTools.test.ts` = 68 pass;`cd ts && bun test src/harness/systemPrompt.test.ts` = 10 pass;`cd ts && bun run typecheck` clean。

## 3.205 2026-07-07 restore_file dry_run 只读权限

- `Tool` 权限接口新增 `forceConfirmFor(input,ctx)`,允许同一个工具按入参区分“只预览”和“真正执行”,并保持真实危险动作在 `full/bypassPermissions` 下也必须弹确认。
- `restore_file({dry_run:true})` 现在走动态只读路径:可在 plan/ask 中直接生成恢复 diff 预览,不再把预览动作当 destructive 审批卡阻塞。
- `restore_file` 真正恢复文件时仍是 `destructive`、`requiresApprovalFor=true`、`forceConfirmFor=true`,所以不会因为提升 dry-run 体验而放松真实回滚/删除文件的安全边界。
- 价值:文件回滚是 coding agent 的救援路径。用户和模型需要先低摩擦看清“会改成什么”,再对真正恢复做强确认;预览和执行混成一个危险动作会拖慢排障,但真实恢复自动放行又会破坏信任。
- 验证:`cd ts && bun test src/permissions/resolve.test.ts` = 13 pass;`cd ts && bun test src/tools/fileTools.test.ts -t "restore_file|file_history"` = 4 pass;`cd ts && bun run typecheck` clean。

## 3.206 2026-07-07 restore_file 右侧恢复对比闭环

- `restore_file` 真正执行时会把“恢复前当前版本”的历史备份路径写入 `<restore_file ... backup_path="...">`,前端不再需要猜最近备份才能打开右侧 diff。
- 前端文件变更状态机把 `restore_file` 纳入 mutation 工具:真实恢复开始时右侧显示“正在恢复文件”,完成后切到“文件恢复对比”;失败时用同一套 file_error 终态替换 pending。
- `restore_file({dry_run:true})` 不触发右侧 pending/diff,只保留 trace 里的恢复预览卡,避免用户把纯预览误认为文件已经在修改。
- 价值:用户提到的“流式显示细节”不只适用于 edit/patch,也适用于回滚救援路径。恢复动作必须在中间 trace 和右侧预览之间形成清楚的 pending -> diff/error 迁移,否则改坏后自救会显得不可靠。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts -t "restore_file|file_history"` = 4 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm exec vitest run src/hooks/use-agent-chat.test.ts` = 10 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.207 2026-07-07 file_history 多文件范围查询

- `file_history.path` 从单字符串扩成 `string|string[]`,并新增 `paths:string[]`;多文件补丁后可一次查看多个目标文件的快照,不必逐个调用历史工具。
- 多路径仍逐项走 workspace resolver 校验和去重过滤,输出继续沿用现有快照行格式,前端 `FileHistoryCard` 无需改动即可展示多文件历史。
- `tool_search` 为 `file_history/restore_file` 补“多文件历史/批量备份记录/多文件回滚”等别名,让模型在多文件修复语境下更容易找对工具。
- 价值:多文件编辑是强 coding agent 的常态。历史查询如果只能单文件,回滚前审阅会变成多轮工具噪音;多 scope 查询让“查历史 -> dry-run 预览 -> 恢复”更贴近真实补丁工作流。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts -t "file_history|restore_file|patch_files applies"` = 5 pass;`cd ts && bun test src/tools/toolSearchTool.test.ts` = 4 pass;`cd ts && bun run typecheck` clean。

## 3.208 2026-07-07 欢迎屏最近项去卡片化

- `WelcomeScreen` 的“最近作品 / 任务”从两列卡片网格收成分隔线列表行:保留打开、可恢复提示、摘要和删除操作,但不再用白卡/绿底卡片铺首屏。
- 删除入口从卡片按钮内部的 `span role="button"` 改成独立 icon button,避免嵌套交互控件,键鼠行为更接近桌面工具列表。
- 价值:用户明确要求主对话窗口不要在前面展示太多卡片,也不要用“台球挂件”式装饰。欢迎屏应服务输入、最近上下文和工具流,最近项是辅助列表,不是作品看板。
- 验证:`cd web && pnpm exec tsc --noEmit` clean。
- 2026-07-08 复核:该过渡方案已被 3.368 取代,欢迎屏不再展示最近作品/任务列表;只保留 `继续上次工作` 这种单一恢复入口。

## 3.209 2026-07-07 主入口文案 coding-agent 化

- `WELCOME` 标题、副文案和输入框 placeholder 从“帮你把电脑上的事办完/写文案/做海报”收成“改代码、查资料、整理文件、跑测试、看报表”优先,媒体能力作为延伸能力继续保留。
- `/help` 示例补上“改代码并跑相关测试”“查报错来源并给修改方案”,把 coding loop 放到能力列表前面;“台球房来答”改成“挂载台球运营专家”,强调它是可选专家而不是主壳身份。
- 价值:当前目标是强 coding agent 外壳,主入口文案必须先让用户相信它能处理代码、文件、测试和资料,再承接生图/生视频/门店知识等插件式能力。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/system-copy-guard.test.ts` = 4 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.210 2026-07-07 首次引导条同步 coding 口径

- `OnboardingBanner` 的首次提示从“写文案、做图、剪视频、整理文件”改为“改代码、跑测试、整理文件、查资料”,和主欢迎文案保持同一优先级。
- 第二步从“挑一张下面的卡片”改为“在输入框里描述任务”,避免主聊天已经去卡片化后,首次引导仍暗示有场景卡入口。
- 价值:首屏最上方的 onboarding 比欢迎标题更先进入视线,如果它仍是生活助理/卡片引导口径,会削弱强 coding agent 外壳的第一印象。
- 验证:`cd web && pnpm exec tsc --noEmit` clean;浏览器打开 `http://127.0.0.1:3001/dashboard/chat` 确认无 auth 错误、主欢迎标题/副文案/placeholder 为新版,旧 onboarding 文案不再出现在 DOM。

## 3.211 2026-07-07 审批参数编辑后预览失效保护

- `approval-preview-diff` 新增 `approvalPreviewState()`:把审批预览分成 none/text/diff/stale 四态,其中 stale 专门表示“用户已改 JSON 参数,原预览不再对应将执行动作”。
- `MacApprovalCard` 在参数编辑后不再继续展示旧 diff/text 预览,改为提示“参数已调整,原预览已失效;确认前请重新核对参数”。执行后仍由实际工具结果进入 trace 和右侧预览。
- 价值:强 coding agent 的审批卡不能让用户基于旧 diff 批准新参数,尤其是 `restore_file` 的 `path/snapshot_id` 或诊断工具的 `test_paths` 被手动调整时。预览失效必须显式呈现,否则确认链路会给用户错误安全感。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/approval-preview-diff.test.ts` = 4 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.212 2026-07-07 审批修改参数的 API 契约测试

- `/api/v1/agent/execute` 增加测试覆盖 `approval_args`:审批 token 仍按原参数校验,实际执行使用用户在审批卡里调整后的 `args`。
- 同测反向锁住:如果前端只带“旧 token + 新 args”但不带 `approval_args`,服务器必须返回“审批校验失败”,不能让前端篡改参数绕过审批。
- 价值:3.211 解决了 UI 里的旧预览误导,这一步把前后端契约也锁住。以后重构审批接口时,不能丢掉“原审批参数用于验签、修改后参数用于执行”的安全边界。
- 验证:`cd ts && bun test src/server/index.test.ts -t "agent/execute"` = 3 pass;`cd ts && bun test src/harness/loop.test.ts -t "executeApproved"` = 4 pass;`cd ts && bun run typecheck` clean。

## 3.213 2026-07-07 右侧预览多文件错误态可恢复

- `isRestorablePreview()` 从 `chat-shell` 移到 `preview-state`,和 `nextPreviewItem()` 共用同一份文件预览状态规则。
- 持久化恢复补齐 `file_error_list`:多文件 patch/restore 失败后,刷新或切回会话仍能保留右侧“多个文件未修改”的终态,不再掉回空预览。
- 价值:用户关注“中间和右边的预览版会不会实时显示”。实时显示不只包含成功 diff,也包含失败终态;多文件失败如果刷新后消失,会让用户误以为状态未记录或任务还在悬空。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/preview-state.test.ts` = 13 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.214 2026-07-07 命令/测试审批前执行计划预览

- `run_command.previewFor()` 新增只读预览:审批卡会显示将执行的 `command`、workspace-relative `cwd`、风险分类、timeout 和输出截断上限;`cwd` 无效时预览直接标明错误。
- `project_diagnostics.previewFor()` 新增测试诊断执行计划:在不运行脚本的前提下解析 nearest package、脚本名、package manager、最终命令和 `test_paths` 聚焦范围。
- 价值:强 coding agent 经常需要跑构建、测试和脚本。确认前如果只看到“需要确认”,用户无法判断范围;现在审批卡先给出实际命令和目录,确认动作更接近 Codex/Work Buddy 的低噪可审阅工具流。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts -t "preview|permission"` = 2 pass;`cd ts && bun test src/tools/fileTools.test.ts -t "project_diagnostics.*preview|project_diagnostics runs explicit focused test paths"` = 2 pass;`cd ts && bun run typecheck` clean。

## 3.215 2026-07-07 审批执行计划前端低噪展示

- `approval-preview-diff` 从只识别 diff/text 扩成 `plan` 状态,可解析 `<run_command_preview>` 和 `<project_diagnostics_preview>` 两类执行计划;参数一旦被用户编辑,仍优先进入 stale 状态,不展示过期计划。
- 审批卡前端把 raw XML/text 计划改成紧凑摘要:命令、cwd、风险、package、脚本、最终命令、测试范围、timeout 和输出上限分行展示,异常状态显示“缺少脚本/路径无效/已拦截”等可读标签。
- 聚焦测试范围用 chip 展示具体 `test_paths`;缺失 package/script、invalid path、rejected 等非 ready 状态保留原因、可用脚本或脚本内容,让用户审批前能判断“为什么不能/不该执行”。
- 价值:后端 3.214 已能生成计划,但前端如果仍展示原始标签文本,用户审阅负担很高。低噪结构化展示把 coding agent 高频的“跑命令/跑测试”确认流变成可扫读、可追责的工具面板,更接近 Work Buddy/Codex 的工程化体验。
- 验证:`cd web && pnpm exec vitest run src/components/desktop/approval-preview-diff.test.ts` = 7 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.216 2026-07-07 重复工具调用动态阈值

- `stuckDetector` 不再用单一 `MAX_SAME_CALL=5`:核心 coding 工具(`read_file/list_dir/grep_files/edit_file/run_command/project_diagnostics/git_status/tool_search` 等)同工具同参数连续 4 次即触发软提醒/硬回灌,更早阻止基础读写链路原地打转。
- MCP 和未知扩展工具使用 40 次高阈值,避免把插件/批处理工具的合法重复调用误判为死循环;未来扩展工具可继续走高阈值,核心工具要纳入 `CORE_STUCK_GUARD_TOOLS` 才启用低阈值。
- `runAgentLoop` 的并行只读批次也接入动态阈值:核心工具达到阈值时不再继续执行,直接回灌“连续重复调用已达到上限”;扩展工具仍保留更长容忍窗口。
- 价值:强 coding agent 的稳定性不只靠模型能力,还要靠底盘及时阻止“反复读同一文件/列同一目录/跑同一命令”的 token 烧穿路径。基础工具低阈值 + 扩展工具高阈值比一刀切更贴近真实工程任务。
- 验证:`cd ts && bun test src/harness/stuckDetector.test.ts` = 6 pass;`cd ts && bun test src/harness/loop.test.ts -t "hard guard|parallelizes safe read-only"` = 2 pass;`cd ts && bun run typecheck` clean。

## 3.217 2026-07-07 命令风险分类管道补强

- `classifyCommandRisk()` 的 segment 切分从 `&&/;` 扩到 `|/||`:例如 `ls | curl ...` 不再因为第一段是 `ls` 被误判为只读,而是按管道各段取最大风险,最终归类为 outreach。
- `git push --force/--force-with-lease/--mirror/-f`、`git reset --hard`、`git branch -D` 现在归 destructive,进入更强审批分级;普通 `rg TODO | head` 仍保持 read。
- 价值:coding agent 会频繁生成 shell 管道和 git 命令。风险分类如果只看开头命令,会把“只读前置 + 网络/ destructive 后段”的复合命令放错审批档;这一步让 run_command 的审批预览和 permission class 更可信。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts -t "classifyCommandRisk|dynamic permission|preview|dangerousCommand"` = 8 pass;`cd ts && bun run typecheck` clean。

## 3.218 2026-07-07 源码注释口径收口

- 清理 `ts/src` 内“逻辑照 cc-haha/具体源码路径/照某文件”的实现注释,改成“Anthropic content-block / OpenAI-compatible proxy / 行为边界 / 可直接移植改写”的清晰表述;运行逻辑不变。
- 保留行为目标和测试语义,文档口径明确 CC-Haha 可直接复制/抄/移植/改写;让 main 分支更适合后续交付、打包和公开审计。
- 价值:用户目标是做强 coding agent,长期可用的 main 分支要同时做到可抄、可验、可维护;行为对齐落实为代码、测试和产品边界。
- 验证:`rg -n "cc-haha|逻辑照|照 cc-haha|src/server/proxy|src/utils/messages" ts/src -g "*.ts"` 无命中;`cd ts && bun test src/proxy/messagePairing.test.ts src/proxy/streamAccumulate.test.ts src/proxy/openaiChatToAnthropic.test.ts src/proxy/toOpenAiChatRequest.test.ts src/proxy/toolArguments.test.ts` = 40 pass;`cd ts && bun test src/proxy/toOpenAiChatRequest.test.ts` = 6 pass;`cd ts && bun run typecheck` clean。

## 3.219 2026-07-07 店铺资料库文件范围检索

- `StoreDocsService.search()` 新增 `paths/path` scope:可按已索引文件的绝对路径、相对后缀或文件名缩小候选 chunk,默认搜索行为不变;scope 只过滤本地索引,不读取任意新文件,不扩大文件权限面。
- `search_store_docs` 工具 schema 增加 `path`/`paths`,模型在用户明确说“只看合同/排班/某个文件”时可限定来源;限定范围内无命中时返回“没有在指定店铺文件范围内找到相关内容”,避免把其它店铺文件或行业常识混成该文件事实。
- `/api/v1/store-docs/search` 和前端 `api.searchStoreDocs()` 同步支持 scope;`StoreDocsPanel` 的试搜结果可点“只查此文件”,面板用低噪 chip 显示当前限定文件并可清除。
- 价值:专有知识库问答的可信度不仅是“有来源”,还要能尊重用户指定资料范围。合同、价目表、排班表这类文件事实经常互相冲突或时效不同,限定文件检索能减少错引和过度泛化。
- 验证:`cd ts && bun test src/server/services/storeDocsService.test.ts` = 6 pass;`cd ts && bun test src/server/index.test.ts -t "desktop product compatibility endpoints"` = 1 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm exec tsc --noEmit` clean。

## 3.220 2026-07-07 autocompact 冷却与防重压护栏

- `compactPipeline()` 新增自动压缩护栏:`AUTOCOMPACT_COOLDOWN_MS=30000`、`lastCompactionAtMs`、`lastCompactedMessageCount`;非强制自动压缩在冷却期内不再重复摘要,成功压缩后如果没有新增消息也不会拿同一段历史继续压。
- `runAgentLoop()` 在压缩成功并恢复最近文件上下文后记录压缩时间与当前消息数;下一轮常规 `maybeCompact(false)` 会遵守冷却和“无新历史不压”。`force=true` 的上下文溢出救援仍绕过护栏,避免真正超窗时无法自救。
- 价值:用户要求大项目“慢慢啃”,长 coding 任务必然会接近上下文窗口。自动压缩如果压完又压,会浪费模型调用、打乱现场感,甚至把刚恢复的最近文件上下文再次折进去;冷却 + 无新增历史防抖让长任务更稳、更省 token。
- 验证:`cd ts && bun test src/context/compaction.test.ts` = 8 pass;`cd ts && bun test src/harness/loop.test.ts -t "compaction"` = 2 pass;`cd ts && bun run typecheck` clean。

## 3.221 2026-07-07 输入框专家挂载与资料库拆分

- `billiards` 领域包公开名从历史“台球包”口径改成“台球运营专家”,保持 id/alias/commands/tools 不变;SessionStart 仍把它作为可挂载专家注入,不改变通用 coding agent 底座身份。
- `DesktopComposer` 新增常驻“专家: …”小胶囊,`+` 菜单第一段就是“通用 Agent / 台球运营专家”选择;用户能把专家挂载到输入流里,不再把这件事藏在旧入口文案里。
- `AgentStatusLine`、`StoreDocsPanel`、欢迎页快捷入口同步改口径:专家挂载负责“懂行”,店铺资料库负责“懂你家/带来源检索”,两者在前端分层呈现,避免把专有知识库、领域专家和主 Agent 身份混成一个概念。
- 文档入口和竞品拆解口径同步收口:主 UI 学 Work Buddy/Codex 的低噪工具流,不做台球挂件或首屏卡片墙;CC-Haha 可直接复制/抄/移植/改写,验证仍靠行为测试和产品红线。
- 验证:`cd ts && bun test src/packs/domainPacks.test.ts src/server/index.test.ts -t "domain pack|enabled packs|commands API|expands enabled"` = 9 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm run typecheck` clean。

## 3.222 2026-07-07 Codex 式工作区目录树

- `/api/v1/agent/workspace-status` 在原有 Git/项目指令摘要外,新增受限深度的 `tree`:默认 2 层、最多 120 项,跳过 `.git/node_modules/.next/dist/build/output` 等重目录,让前端能看到当前工作区结构而不是只保存一个路径字符串。
- `DesktopSidebar` 新增“工作区”目录预览:显示当前文件夹名、打开/切换入口和前两层文件树;空目录、读取失败、大目录截断都有低噪状态,不把它做成欢迎卡片墙。
- `AgentStatusLine` 和 `DesktopComposer` 文案统一到“工作区”;用户通过系统弹窗新建或选择文件夹后,这个目录同时成为前端目录树和模型 `working_dir`。
- 价值:对齐 Codex/Claude Code 的“打开文件夹就是当前项目”心智。coding agent 的核心场景不是只把成品存到某处,而是围绕一个目录读代码、改文件、跑测试、看 Git 状态和项目指令。
- 验证:`cd ts && bun test src/server/index.test.ts -t "workspace status"` = 1 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm run typecheck` clean。

## 3.223 2026-07-07 CC-Haha TaskCreate/List/Get/Update 结构化任务列表

- 对照源:`~/Desktop/cc-haha-ref/src/tools/TaskCreateTool/TaskCreateTool.ts`、`TaskListTool.ts`、`TaskGetTool.ts`、`TaskUpdateTool.ts` 与 `src/utils/tasks.ts`。CC-Haha 的 task list 是 Agent 回合内维护计划/阻塞关系的结构化状态,不同于我们已有的后台异步任务。
- 新增 `ts/src/tasks/taskListService.ts`:按 conversation/workspace scope 持久化 `pending/in_progress/completed` 任务,支持 `subject/description/activeForm/owner/blocks/blockedBy/metadata`,并用 scope 写队列避免同一任务列表并发覆盖。
- 新增 `ts/src/tasks/taskListTools.ts`:注册 `task_create`、`task_list`、`task_get`、`task_update`,兼容 `taskId/task_id`、`activeForm/active_form`、`addBlockedBy/add_blocked_by`;`task_update status:"deleted"` 会清理相关阻塞边。
- `runAgentLoop()` 把 `task_create/task_update` 视为进度更新工具,执行后立即发 `todo_update`,让前端在 coding 流程里实时看到结构化计划变化;`tool_search` 补上 TaskCreate/TaskList/TaskGet/TaskUpdate 中英文别名。
- `/agent/run`、`/agent/ws` 和 legacy `/api/v1/agent/execute` 的工具装配已挂入这套结构化 task 工具,并与已有 `list/read/cancel_background_task` 并存,不混淆“计划任务列表”和“后台任务执行器”。
- 验证:`cd ts && bun test src/tasks/taskListService.test.ts src/tasks/taskListTools.test.ts src/tasks/taskTools.test.ts` = 5 pass;`cd ts && bun test src/tools/toolSearchTool.test.ts` = 4 pass;`cd ts && bun test src/server/index.test.ts -t "tasks|agent run|tool|workspace status|WS /agent/ws"` = 10 pass;`cd ts && bun run typecheck` clean。

## 3.224 2026-07-08 CC-Haha NotebookEdit 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/NotebookEditTool/NotebookEditTool.ts`、`prompt.ts` 与 `src/utils/notebook.ts`。关键行为:只编辑 `.ipynb`,支持 `replace/insert/delete`,可用真实 cell id 或 `cell-N` 索引定位,insert 可无 cell_id 插到开头,并强制 read-before-edit 与 stale read 拦截。
- 新增 `ts/src/tools/notebookEditTool.ts`:注册 CC-Haha 同名工具 `NotebookEdit`,支持 `notebook_path/path`、`cell_id/cellId`、`new_source/newSource`、`cell_type/cellType`、`edit_mode/editMode`;修改 code cell 时清空 outputs 并重置 `execution_count`,markdown cell 会移除 code-only 字段。
- `NotebookEdit` 接入现有 `Workspace` 写边界、`ctx.fileReads` 读前置快照、`recordFileSnapshot()` 和 `restore_file`;工具结果输出 `<file_change>` 与 `<notebook_edit>` 标签,右侧预览/文件历史链路可沿用现有 file-change 解析。
- `buildGeneralRegistry()` 默认挂载 `NotebookEdit`;`tool_search` 增加 “编辑 notebook/修改 ipynb/Jupyter notebook” 等别名,大工具集懒加载时模型仍能发现 notebook 编辑能力。
- 验证:`cd ts && bun test src/tools/notebookEditTool.test.ts src/tools/generalTools.test.ts src/tools/toolSearchTool.test.ts src/tools/fileTools.test.ts -t "NotebookEdit|file_history|restore_file|general registry|tool_search"` = 14 pass;`cd ts && bun run typecheck` clean。

## 3.225 2026-07-08 CC-Haha VerifyPlanExecution 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/VerifyPlanExecutionTool/**`、`src/utils/attachments.ts` 的 `verify_plan_reminder`、`src/state/AppStateStore.ts` 的 `pendingPlanVerification`、`src/screens/REPL.tsx` 的计划退出状态写入、`src/utils/messages.ts` 的提醒文案、`src/utils/hooks/execAgentHook.ts` 的 stop-condition 验证 prompt。注意:参考仓里的 `VerifyPlanExecutionTool.ts/constants.ts` 是 feature-gated stub,所以本轮复制的是周边可见行为链路,不是把空 stub 当实现。
- 新增 `ts/src/tools/verifyPlanExecutionTool.ts`:注册 CC-Haha 同名工具 `VerifyPlanExecution` 和兼容名 `verify_plan_execution`;工具要求提交 `status` 与 `evidence/checks`,pass 但没有命令输出、诊断、文件读取、截图或人工检查等可复核证据时返回 `status="needs_evidence"`。
- `ExitPlanMode` 批准后在 `ToolContext.pendingPlanVerification` 里保存计划,并在工具结果里要求完成实施后直接调用 `VerifyPlanExecution`;主循环统计批准后的工具调用,超过阈值会通过 `<system-reminder>` 注入验证提醒。
- 主循环在模型试图最终收尾时检查 pending plan:若已执行工具但还未完成 `VerifyPlanExecution`,会回灌“先验证再总结”的提醒并继续一轮,防止 coding agent 用一句总结跳过验收。
- `buildGeneralRegistry()` 默认挂载 `VerifyPlanExecution`;`tool_search` 增加“验证计划/计划执行校验/收工前验证”等别名,懒加载工具场景也能找到。
- 验证:`cd ts && bun test src/tools/verifyPlanExecutionTool.test.ts src/tools/generalTools.test.ts src/tools/toolSearchTool.test.ts src/harness/loop.test.ts -t "VerifyPlanExecution|ExitPlanMode|general registry|tool_search|approved plan"` = 12 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 541 pass,0 fail。

## 3.226 2026-07-08 CC-Haha EnterPlanMode 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/EnterPlanModeTool/EnterPlanModeTool.ts`、`prompt.ts`、`constants.ts`。关键行为:工具名 `EnterPlanMode`,只读,请求进入 plan mode;进入后模型应只读探索、设计方案,不得写文件,最终用 `ExitPlanMode` 提交计划。
- `ts/src/tools/agentInteractionTools.ts` 新增 `enter_plan` 与 `EnterPlanMode` 两个规格,兼容 CC-Haha 同名工具;工具会向用户发起进入计划模式确认,批准后把当前 `ToolContext.permissionMode` 切到 `plan`,拒绝/超时则保持原权限档。
- `runAgentLoop()` 特判 `EnterPlanMode`:批准后回灌 CC-Haha 同语义的 plan-mode 操作说明;后续 `write_file/edit_file/run_command` 等非只读工具会被现有 plan 权限闸拦截,不是只改一个 UI 状态。
- `buildGeneralRegistry()` 默认挂载 `EnterPlanMode`;`tool_search` 增加“进入计划模式/先规划/设计方案”等别名,模型在长任务前能发现并使用它。
- 验证:`cd ts && bun test src/tools/generalTools.test.ts src/tools/toolSearchTool.test.ts src/harness/loop.test.ts -t "EnterPlanMode|ExitPlanMode|general registry|tool_search"` = 11 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 543 pass,0 fail。

## 3.227 2026-07-08 CC-Haha LSPTool 协议迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/LSPTool/LSPTool.ts`、`schemas.ts`、`formatters.ts`、`prompt.ts`、`symbolContext.ts`。关键协议:工具名 `LSP`,操作包括 `goToDefinition/findReferences/hover/documentSymbol/workspaceSymbol/goToImplementation/prepareCallHierarchy/incomingCalls/outgoingCalls`,位置统一用编辑器 1-based `line/character`。
- 当前 TS 仓库没有 CC-Haha 的 `services/lsp/manager` 与 language-server 生命周期,所以本轮先迁移工具协议与可观察结果格式,并实现本地符号 fallback:通过工作区代码扫描提供 document/workspace symbols、定义候选、引用分组、hover 说明与调用层级线索。
- 新增 `ts/src/tools/lspTool.ts`:保持 `LSP` 同名工具、只读权限、10MB 文件上限、重目录跳过、结果包 `<lsp operation="..." mode="fallback">`;未来接入真正 LSP manager 时可保留工具 schema 与 formatter,替换内部 resolver。
- `buildGeneralRegistry()` 默认挂载 `LSP`;`tool_search` 增加“语言服务/跳转定义/查引用/hover/符号搜索/调用层级”等别名,大工具集懒加载时模型仍能发现代码智能能力。
- 验证:`cd ts && bun test src/tools/lspTool.test.ts src/tools/generalTools.test.ts src/tools/toolSearchTool.test.ts -t "LSP|general registry|tool_search"` = 10 pass;`cd ts && bun run typecheck` clean。

## 3.228 2026-07-08 CC-Haha PowerShellTool 工具层迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/PowerShellTool/PowerShellTool.tsx`、`powershellPermissions.ts`、`powershellSecurity.ts`、`readOnlyValidation.ts`、`pathValidation.ts`、`destructiveCommandWarning.ts`、`commandSemantics.ts`、`prompt.ts`、`toolName.ts` 与 `~/Desktop/cc-haha-ref/src/utils/powershell/parser.ts`。关键协议:工具名必须保留为 `PowerShell`,并且 PowerShell 命令不能只套 `run_command`,要有 PowerShell 专用只读/写入/外联/破坏性分类。
- 新增 `ts/src/tools/powerShellTool.ts`:注册 CC-Haha 同名工具 `PowerShell`,支持 `command/cwd/timeout_ms/max_output_bytes/description`;默认工作区 cwd,执行时探测 `pwsh`/`powershell`,未安装时返回明确安装/平台提示,不伪造执行成功。
- 已迁移一层静态 PowerShell 语义:常见别名 canonicalize(`ls/cat/rm/iwr/irm` 等)、只读 cmdlet allowlist、写入 cmdlet、外联 cmdlet、危险 git 操作、`Invoke-Expression`、EncodedCommand、download cradle、BITS/certutil、`Add-Type`、COM、`Start-Process -Verb RunAs`、`ForEach-Object -MemberName`、模块加载等风险提示;灾难级 `Clear-Disk/Format-Volume/Stop-Computer/Restart-Computer` 与根目录/通配删除走 fatal。
- 接入当前权限瀑布:只读 PowerShell 在 ask/plan 可直接执行;文件类可在 `auto_files` 放行;外联要审批;破坏性/可疑命令 `forceConfirm`,即使 `full` 也弹确认;`bypassPermissions` 不越过 fatal。
- `buildGeneralRegistry()` 默认挂载 `PowerShell`;`tool_search` 增加 “PowerShell/pwsh/Windows 命令/PowerShell 终端” 等别名,懒加载工具场景也能发现 Windows/PowerShell 专用执行入口。
- 口径:本轮是 CC-Haha PowerShellTool 的可运行工具层与静态安全语义迁移;完整 `utils/powershell/parser.ts` 那套基于 PowerShell AST 的权限规则、路径级 deny/allow 细粒度匹配和 background task 行为还需继续复制/移植/改写。
- 验证:`cd ts && bun test src/tools/powerShellTool.test.ts src/tools/generalTools.test.ts src/tools/toolSearchTool.test.ts -t "PowerShell|general registry|tool_search"` = 16 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 557 pass,0 fail。

## 3.229 2026-07-08 CC-Haha EnterWorktree/ExitWorktree 工具层迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/EnterWorktreeTool/EnterWorktreeTool.ts`、`prompt.ts`、`constants.ts`、`~/Desktop/cc-haha-ref/src/tools/ExitWorktreeTool/ExitWorktreeTool.ts`、`prompt.ts`、`constants.ts`、`~/Desktop/cc-haha-ref/src/utils/worktree.ts`、`getWorktreePathsPortable.ts`。关键行为:工具名必须保留 `EnterWorktree/ExitWorktree`,并且 Exit 删除前必须统计未提交文件和创建后新增 commit,无法证明安全时不能直接删。
- 新增 `ts/src/tools/worktreeTools.ts`:保留 CC-Haha 同名工具,实现 slug 校验、`.claude/worktrees/<slug>` 路径、`worktree-<slug>` 分支、`.git/info/exclude` 写入、`git worktree add -B`、已有同名 worktree 恢复、`git worktree list --porcelain` portable 读取。
- `EnterWorktree` 创建后会把当前 `ToolContext.workspace` 切到 worktree root,并登记 `ctx.worktreeSession` 与 conversationId 进程内会话态;后续 `read_file/edit_file/run_command/git_status` 等工具自然落在隔离工作区。`ExitWorktree` 的 `keep` 会恢复原 workspace 并保留目录/分支;`remove` 会删除 worktree 与本地分支。
- 新增跨轮恢复:server 在 turn setup/buildSystemPrompt/commands/MCP 装配前通过 `workspaceForActiveWorktree()` 把同 conversation 的 workspace root 解析到 active worktree;`runAgentLoop()` 创建 `ToolContext` 时再用 `activateWorktreeSessionForContext()` 兜底,并注入短 `<system-reminder>` 告知当前工具工作区。已覆盖“两轮 agent loop:第一轮 EnterWorktree,第二轮前端仍传原目录但 write_file 实际写入 worktree”的测试。
- 安全口径:进入 worktree 是 `file` 审批类;`remove` 是 `destructive + forceConfirm`;有未提交文件或创建后新增 commit 时,未传 `discard_changes:true` 会拒绝并要求确认。无活动 EnterWorktree 状态时 ExitWorktree 是 no-op,不会误删手工创建或历史会话 worktree。
- `buildGeneralRegistry()` 默认挂载 `EnterWorktree/ExitWorktree`;`tool_search` 增加“创建/进入/退出/删除 worktree、隔离工作区、git worktree”等别名。
- 口径:本轮是可运行 git worktree 工具层迁移;CC-Haha 的 WorktreeCreate/WorktreeRemove hooks、tmux session、跨进程 `sessionStorage` 恢复、settings.local 复制、sparse checkout、symlinkDirectories 和 `.worktreeinclude` 复制仍需继续复制/移植/改写。
- 验证:`cd ts && bun test src/tools/worktreeTools.test.ts src/tools/generalTools.test.ts src/tools/toolSearchTool.test.ts -t "Worktree|worktree|active worktree|runAgentLoop|general registry|tool_search"` = 14 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 565 pass,0 fail。

## 3.230 2026-07-08 CC-Haha REPLTool primitive 编排迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/REPLTool/constants.ts`、`primitiveTools.ts`、`REPLTool.ts`、`src/tools.ts`、`src/hooks/useMergedTools.ts`、`src/state/AppStateStore.ts` 的 `replContext` 记录。关键发现:公开参考仓里的 `REPLTool.ts` 是 feature-gated stub,但 `constants.ts` 明确 `REPL_TOOL_NAME='REPL'`、`REPL_ONLY_TOOLS` 会隐藏 FileRead/FileWrite/FileEdit/Glob/Grep/Bash/NotebookEdit/Agent,`primitiveTools.ts` 则把这些工具作为 REPL VM 内部 primitive 暴露。
- 新增 `ts/src/tools/replTool.ts`:注册 CC-Haha 同名工具 `REPL`,输入为 `{ steps:[{tool,input,id?}], stop_on_error?, max_steps?, max_output_chars? }`,不是 JS eval,而是按顺序调用当前 `ToolRegistry` 里的真实 primitive coding tools。
- REPL primitive 首批覆盖 `read_file/read_many_files/write_file/edit_file/multi_edit_file/patch_file/patch_files/list_dir/glob_files/grep_files/code_outline/git_status/git_history/NotebookEdit/LSP/read_stored_tool_result/project_diagnostics/PowerShell/run_command/agent_task/start_background_agent_task/list_background_tasks/read_background_task/cancel_background_task`;递归 `REPL`、`tool_search`、计划/询问类交互工具不允许塞进批处理。
- 权限口径:外层 `REPL` 动态判断只读/需审批/forceConfirm/userInteraction/fatal;未审批时内部 `run_command` 等需要确认的步骤只返回 pending,不会执行。用户批准整批 `REPL` 后,内部步骤用同一套工具执行,但 `fatal`、`forceConfirm`、`requiresUserInteraction` 仍由原工具保护,不能被批量工具绕过。
- `executeApproved()` 新增临时 `ctx.approvedToolExecution` 标记,只在用户批准的顶层动作执行期间存在;REPL 用它识别“这一批参数已被确认”,执行完或失败后立即恢复,避免权限状态污染后续工具。
- `buildGeneralRegistry()` 默认挂载 `REPL`;`tool_search` 增加 “REPL/批量工具/工具编排/多步代码操作/primitive tools” 等别名,大工具集懒加载时模型仍能发现批量编排入口。
- 口径:本轮迁移的是 CC-Haha REPL 模式中“primitive tools 只能经 REPL 编排”的可运行工具层。完整 REPL VM context、display-side virtual tool message、bridge remote control、默认隐藏 primitive tools 的模式切换仍需继续复制/移植/改写,不能把当前结构化 batch tool 误标为最终全量 REPL。
- 验证:`bun test ts/src/tools/replTool.test.ts ts/src/tools/generalTools.test.ts ts/src/tools/toolSearchTool.test.ts` = 12 pass;`cd ts && bun run typecheck` clean。

## 3.231 2026-07-08 CC-Haha TaskOutput/TaskStop 工具迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/TaskOutputTool/TaskOutputTool.tsx`、`constants.ts`、`~/Desktop/cc-haha-ref/src/tools/TaskStopTool/TaskStopTool.ts`、`prompt.ts`。关键行为:`TaskOutput` 通过 `task_id` 读取后台 shell/agent/remote task 输出,支持 `block` 等待与 `timeout`;`TaskStop` 通过 `task_id` 停止运行中的后台任务,兼容旧 `shell_id` 参数。
- `ts/src/tasks/taskTools.ts` 新增 CC-Haha 同名工具 `TaskOutput`:复用现有 `TaskService` 任务索引与 event JSONL,返回 `<retrieval_status>success|timeout|not_ready</retrieval_status>`、`<task_id>`、`<task_type>`、`<status>`、`<description>`、`<output>`、`<error>`。`block=false` 不阻塞读取当前状态;`block=true` 按 100ms 轮询等待完成,`timeout` 上限 600000ms。
- `TaskOutput` 是只读工具,并加入 `toolResultStorage` 白名单与 `REPL` primitive,长后台日志不会直接撑爆模型上下文,模型也能在 REPL 批量编排中读取任务输出。
- `ts/src/tasks/taskTools.ts` 新增 CC-Haha 同名工具 `TaskStop`:支持 `{task_id}` 和兼容 `{shell_id}`,调用 `TaskService.cancel()` 中止运行/排队任务,返回 `<task_stopped>` 结构。停止后台任务设置为 `destructive + forceConfirm`,即使 `full` 模式也要显式确认,避免模型静默杀掉仍有价值的后台子代理。
- `tool_search` 增加 “读取任务输出/后台任务输出/查看任务日志/TaskOutput” 与 “停止任务/取消任务/中断任务/TaskStop” 等别名,长尾工具懒加载时模型仍能发现这两个 CC-Haha 兼容入口。
- 口径:本轮迁移的是后台任务读取与停止工具层;CC-Haha 的 `SendMessage/ListPeers/TeamCreate/TeamDelete` 涉及 teammate mailbox、UDS inbox、remote bridge 与 team 文件,需要作为下一组继续复制/移植/改写。
- 验证:`bun test ts/src/tasks/taskTools.test.ts ts/src/tasks/taskService.test.ts` = 7 pass;`cd ts && bun run typecheck` clean。

## 3.232 2026-07-08 CC-Haha SendMessage/TeamCreate/TeamDelete/ListPeers 本地 team-mailbox 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/SendMessageTool/SendMessageTool.ts`、`prompt.ts`、`constants.ts`、`~/Desktop/cc-haha-ref/src/tools/TeamCreateTool/TeamCreateTool.ts`、`~/Desktop/cc-haha-ref/src/tools/TeamDeleteTool/TeamDeleteTool.ts`、`~/Desktop/cc-haha-ref/src/utils/teammateMailbox.ts`、`~/Desktop/cc-haha-ref/src/utils/swarm/teamHelpers.ts`、`~/Desktop/cc-haha-ref/src/utils/teammate.ts`。关键行为:team 文件保存成员/leader,mailbox 以 `inboxes/{agent}.json` 落盘并带锁写入,`SendMessage` 支持直接消息、`*` 广播、shutdown/plan approval 结构化协议,`TeamDelete` 遇到活跃非 leader 成员必须拒绝清理。
- 新增 `ts/src/tasks/teamService.ts`:在当前桌面项目状态根 `.agent-state/teams` 下实现 CC-Haha 同构目录:`teams/{team}/config.json`、`teams/{team}/inboxes/{agent}.json`、`active-team.json`。实现 team 文件读写、active team 恢复、mailbox 读写、未读计数、mark/read/clear、文件锁目录 + 进程内队列,避免同进程/多进程并发写坏 inbox JSON。
- 新增 `ts/src/tasks/teamTools.ts`:注册 CC-Haha 同名工具 `TeamCreate`、`TeamDelete`、`SendMessage`、`ListPeers`。`TeamCreate` 创建 leader 成员 `team-lead@{team}` 并写 active-team;`SendMessage` 普通字符串消息要求 `summary`,直接写 recipient inbox,`to:"*"` 广播给非 leader 成员;结构化消息支持 `shutdown_request`、`shutdown_response`、`plan_approval_response`;`ListPeers` 读取成员与未读数;`TeamDelete` 是 `destructive + forceConfirm`,且有活跃成员时返回拒绝。
- server registry 已接入 `createTeamTools(teams)`:主会话、MCP/命令装配路径、后台/base registry 都能看到这组工具。`tool_search` 增加 “创建团队/清理团队/给代理发消息/查看团队成员/agent swarm/team members” 等别名,大工具集懒加载时模型能按中文意图发现 CC-Haha team 工具。
- 口径:本轮完成的是 CC-Haha team/mailbox 的本地文件状态主路径,不是完整 swarm runtime。公开参考仓里的 `ListPeersTool` 仍是 feature-gated stub;UDS inbox、Remote Control bridge、真实 in-process/tmux teammate runner、pane backend、队友自动轮询/唤醒/退出、Brief 仍需继续复制/移植/改写,不能把当前本地 mailbox 误标为完整多机/多进程 swarm。
- 验证:`bun test ts/src/tasks/teamTools.test.ts ts/src/tools/toolSearchTool.test.ts` = 8 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 577 pass,0 fail。

## 3.233 2026-07-08 CC-Haha teammate mailbox 自动上下文递送迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/attachments.ts` 的 `getTeammateMailboxAttachments()`、`~/Desktop/cc-haha-ref/src/hooks/useInboxPoller.ts`、`~/Desktop/cc-haha-ref/src/constants/xml.ts`。关键行为:unread mailbox 里的普通队友消息会以 `<teammate-message teammate_id="...">` 自动进入下一轮模型上下文;结构化协议消息必须过滤出来,保留给 inbox poller/权限/关机/计划审批专门处理,不能被普通上下文消费后标记已读。
- `ts/src/tasks/teamService.ts` 新增 `TEAMMATE_MESSAGE_TAG='teammate-message'`、`isStructuredProtocolMessage()`、`formatTeammateMessages()`、`markMessagesAsReadByPredicate()` 与 `buildInboxContext()`。`buildInboxContext()` 默认读取 active team 的 `team-lead` inbox,过滤普通 unread 消息、去重、格式化为 CC-Haha 同名 XML tag,并只把这些普通消息标记已读。
- `ts/src/harness/loop.ts` 新增可选 `teamInbox` 注入点;server 主 `/agent/run` 路径传入 `TeamService`,模型第一步 user content 会自动带上未读队友消息。这样 `SendMessage` 不再只是写 JSON 文件,而是能在下一轮主对话里被模型实际看到。
- `ts/src/tasks/teamTools.ts` 的 `ListPeers include_inbox` 输出同步改为 CC-Haha 的 `<teammate-message>` 连字符 tag,不再使用临时下划线 tag。
- 口径:当前完成的是“下一轮自动递送普通 mailbox 消息”。CC-Haha 的实时 `useInboxPoller` idle 立即提交、busy 时 AppState.inbox 排队、mid-turn attachment、permission/sandbox/shutdown 专门队列、in-process teammate 等待下一 prompt/abort 仍需继续复制/移植/改写。
- 验证:`bun test ts/src/harness/loop.test.ts ts/src/tasks/teamTools.test.ts` = 54 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 578 pass,0 fail。

## 3.234 2026-07-08 CC-Haha SendMessage -> running background agent 路由迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tasks/LocalAgentTask/LocalAgentTask.tsx` 的 `pendingMessages/queuePendingMessage/drainPendingMessages`、`~/Desktop/cc-haha-ref/src/tools/SendMessageTool/SendMessageTool.ts` 的 active local agent 路由、`~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` 的 `agentNameRegistry` 注册。关键行为:`SendMessage({to:name})` 先命中运行中的 local agent,把消息排到下一工具轮;命中失败才回落到普通 team mailbox。
- `ts/src/tasks/taskService.ts` 新增运行中 task 的 `liveSteerInboxes`:后台任务可 `attachSteerInbox()`,外部可 `queueSteerMessage()`;投递时追加一条 task event,`TaskOutput`/任务抽屉能看到消息已排队。任务结束/取消时自动清理 live inbox,避免 stale target。
- `ts/src/tasks/taskTools.ts` 的 `start_background_agent_task` 为每个后台 agent loop 挂载 `steerInbox`,并传给 `runAgentLoop()`。这让后台 agent 在工具批次后或准备收尾前能收到 `SendMessage` 注入的用户补充,与 CC-Haha running agent pending message 语义一致。
- `ts/src/tasks/teamTools.ts` 的 `SendMessage` 在普通字符串消息且 `to !== "*"` 时,先通过 `TaskService.findRunningBackgroundAgent()` 按 task id 或 `params.agent` 查找同 conversation 的 running `background_agent`;命中后调用 `queueSteerMessage()` 并返回 “next tool round” 结果,不再写 mailbox。未命中时仍走 team mailbox。
- 口径:当前完成的是 running background agent 的消息排队与下一轮注入。CC-Haha 对 stopped/evicted agent 的 `resumeAgentBackground()`、磁盘 transcript 重建等仍需继续复制/移植/改写;agent name registry 与多同名歧义已在 3.237 追加。
- 验证:`bun test ts/src/tasks/taskTools.test.ts ts/src/tasks/teamTools.test.ts` = 10 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 580 pass,0 fail。

## 3.235 2026-07-08 CC-Haha SendMessage -> stopped background agent 续跑迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/SendMessageTool/SendMessageTool.ts` 的 stopped/evicted local agent 分支、`~/Desktop/cc-haha-ref/src/tools/AgentTool/resumeAgent.ts`、`~/Desktop/cc-haha-ref/src/tasks/LocalAgentTask/LocalAgentTask.tsx`。关键行为:普通 `SendMessage({to:name,message})` 命中 stopped local agent 时不能只写 mailbox,要尝试后台续跑;CC-Haha 完整版会读 agent transcript/metadata、过滤未闭合 tool_use、重建 content replacement 和 worktree 后继续同一个 agent。
- `ts/src/tasks/taskService.ts` 新增 `findBackgroundAgent()`:按 task id 或 `params.agent` 查找同 conversation 的 `background_agent`,可指定 `queued/running/completed/failed/cancelled` 状态集合;`findRunningBackgroundAgent()` 改为它的 running 特化,保持 running 路由优先。
- `ts/src/tasks/taskService.ts` 新增 task 级 transcript 入口:`task-transcripts/transcripts/{task}.jsonl`;`start_background_agent_task` 每次运行都会把 Anthropic messages 轨迹写进对应 task transcript,不再只留 event JSONL。
- `ts/src/tasks/taskTools.ts` 将后台 agent 启动抽成 `startBackgroundAgentRun()`,并新增 `resumeBackgroundAgentTask()`:被续跑的 stopped/completed/failed/cancelled task 会创建一个新的后台 task,写入 `resumed_from`、`resume_source:"SendMessage"`、`previous_status`、`replayed_messages`,同时读取旧 task transcript 作为新 run 的初始历史,再把原任务、原上下文和新消息放进 resumed run 的 user message;原 task event 追加“已续跑为新 task”的可观察记录。
- 续跑 workspace 语义继续对齐 CC-Haha `resumedWorktreePath`:若旧 task 的 `workspaceRoot` 仍存在,续跑 task 会在旧 workspace root 里运行,并把 `resumed_workspace_root` 写进 params;若旧目录已不存在,则安全退回当前 workspace,并记录 `resume_workspace_missing`。
- `ts/src/tasks/teamTools.ts` 的 `SendMessage` 普通字符串路由顺序已贴近 CC-Haha:running background agent -> stopped/completed/failed/cancelled background agent 续跑 -> team mailbox。续跑成功不写 mailbox;续跑失败返回 `success:false` 和原因,避免模型以为消息已可靠投递。
- `ts/src/server/index.ts` 通过延迟绑定 `BackgroundAgentTaskOptions` 把 `resumeBackgroundAgentTask()` 接进主 `/agent/run` registry,既避免 `teamTools`/`backgroundBaseRegistry` 构建循环,又让续跑任务复用同一套 background tools、系统提示、权限模式、workspace 和模型配置。
- 口径:当前完成的是“停止态消息自动创建续跑 background task + 跨 task transcript replay + 原 workspaceRoot 恢复”的可运行等价层;仍不是 CC-Haha 的同 agent id 原地 full restore。agent metadata sidecar 与 worktree mtime 保活已在 3.238 追加;仍需继续复制/移植/改写:同 agent id 原地恢复、tool result/content replacement 重建、evicted task 从 transcript 直接恢复。
- 验证:`bun test ts/src/tasks/taskTools.test.ts ts/src/tasks/teamTools.test.ts` = 12 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 582 pass,0 fail。

## 3.236 2026-07-08 专家挂载默认通用口径修正

- 对照当前目标:本产品底座必须先是强 coding agent,台球运营只是可挂载领域专家;因此 `billiards` 领域包从 `default_enabled:true` 改为 `false`,避免首启自动把台球上下文注入通用代码/文件任务。
- `DesktopComposer`/`DesktopChatShell` fallback 同步改为默认通用 Agent;专家菜单仍保留“通用 Agent / 台球运营专家”,用户主动选择后继续通过 `knowledge_packs:["billiards"]` 进入 TS 内核。
- `DesktopComposer` 去掉“专家挂载会随本轮对话发送给内核”的显性教程文字,菜单只保留专家名和短能力标签,更贴近 Work Buddy/Codex 低噪工具流。
- 兼容口径不变:旧端显式传 `billiards_mode:true` 仍会挂载台球包;用户保存过 `agent_knowledge_packs:["billiards"]` 也仍会恢复台球专家。这里改的是“默认”,不是删除专家能力。

## 3.237 2026-07-08 CC-Haha background agent name registry 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` 的 `name` 入参和 `agentNameRegistry.set(name, agentId)`,以及 `~/Desktop/cc-haha-ref/src/tools/SendMessageTool/SendMessageTool.ts` 的 `agentNameRegistry.get(input.to) -> task -> queuePendingMessage/resumeAgentBackground` 路由。
- `start_background_agent_task` 新增可选 `name`:启动后台子代理时写入 task params,返回 `<background_task_started ... name="...">`;这个 name 是给 `SendMessage({to:name})` 使用的实例名,用于区分同一 agent 类型的多个后台任务。
- `TaskService.resolveBackgroundAgentTarget()` 新增三段解析:先精确 task id,再自定义 `name`,最后才用唯一 `params.agent` 类型兜底。若同一 conversation 里有多个同类型 background agent,`SendMessage({to:"researcher"})` 会返回 `ambiguous:true` 和候选 task 列表,要求模型改用 task id 或自定义 name,避免误投递到最新任务。
- `SendMessage` running/stopped 两条路径都改用该解析器:自定义 name 可投递到运行中 agent 的 steer inbox,也可续跑 stopped/completed/failed/cancelled agent;同类型多任务不会回落到普通 mailbox 造成假成功。
- 口径:本轮完成的是 CC-Haha `name -> agentId` 注册语义在 task params/index 上的可运行等价层,并额外补了同类型歧义保护。metadata sidecar 已在 3.238 承接跨重启字段恢复,索引丢失后的 sidecar 枚举已在 3.240 承接;仍需继续复制/移植/改写:真正同 agent id 原地恢复、跨进程/重启后 registry 的更强恢复。
- 验证:`bun test src/tasks/taskTools.test.ts src/tasks/teamTools.test.ts` = 13 pass;`cd ts && bun run typecheck` clean。

## 3.238 2026-07-08 CC-Haha agent metadata sidecar resume 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/runAgent.ts`、`resumeAgent.ts`、`~/Desktop/cc-haha-ref/src/utils/sessionStorage.ts`。关键行为:subagent 启动前把 transcript 与 `.meta.json` sidecar 写到磁盘;恢复时并行读取 transcript/metadata,用 metadata 还原 agentType、description、worktreePath,并在 worktree 仍存在时 `utimes` 保活。
- `ts/src/tasks/taskService.ts` 新增 `BackgroundAgentMetadata`、`backgroundAgentMetadataPath()`、`writeBackgroundAgentMetadata()`、`readBackgroundAgentMetadata()`:sidecar 存在 `task-transcripts/transcripts/{task}.meta.json`,用原子 tmp+rename 写入,读取坏 JSON/缺文件时返回 `null`,不拖垮任务恢复。
- `TaskService.resolveBackgroundAgentTarget()` 现在会用 sidecar 参与 `name` 和 `agent/agentType` 解析。即使旧 `tasks.json` 没有 `params.agent/name`,`SendMessage({to:name})` 也能从 `.meta.json` 找到 stopped background agent 并走续跑,不会假成功写进普通 mailbox。
- `startBackgroundAgentRun()` 在 task 创建后 fire-and-forget 写 sidecar,记录 `agent/agentType/name/task/context/description/conversationId/workspaceRoot/worktreePath`;写入失败不阻塞后台 agent,对齐 CC-Haha persistence failure 不反向污染运行态的口径。
- `resumeBackgroundAgentTask()` 先读 sidecar,优先用 metadata 选择原 agent、原实例名、原 task/context 和 workspace/worktree。若 `worktreePath` 仍存在,续跑切回该目录并更新 mtime;若 worktree 消失,安全退回可用 workspace 并记录 `resume_worktree_missing`。续跑任务会保留原 `name`,后续 `SendMessage` 仍能投递到新任务。
- 测试覆盖:metadata sidecar 读写/坏文件容错、resolver 从 sidecar 匹配、后台 agent 启动写 sidecar、`tasks.json` 缺 `params.agent` 时 `SendMessage` 仍按 sidecar 恢复 stopped agent。
- 验证:`cd ts && bun test src/tasks/taskService.test.ts src/tasks/taskTools.test.ts src/tasks/teamTools.test.ts` = 18 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 585 pass,0 fail;`git diff --check` clean。

## 3.239 2026-07-08 CC-Haha resume transcript 坏尾巴清洗迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/resumeAgent.ts` 调用的 `filterUnresolvedToolUses()`、`filterWhitespaceOnlyAssistantMessages()`、`filterOrphanedThinkingOnlyMessages()`。关键行为:恢复 stopped/evicted agent 时,不能把中断时留下的半截 tool_use、空白 assistant 或孤儿 thinking-only assistant 原样喂回模型。
- `ts/src/tasks/taskTools.ts` 新增 `sanitizeBackgroundAgentResumeMessages()`:在本项目 Anthropic block 消息模型上做等价核心清洗。未配到 `tool_result` 的 assistant tool_use 消息会在 resume 前丢弃;纯空白 assistant 与 thinking-only assistant 也会丢弃。
- `resumeBackgroundAgentTask()` 读取旧 task transcript 后会先通过该清洗函数,再作为新 run 的 `initialMessages` 接续;`replayed_messages` 记录清洗后的可重放消息数,避免把坏尾巴算成已恢复上下文。
- 测试覆盖:构造 `tool_use` 缺 result、空白 assistant、thinking-only assistant 与已配对 tool_use/result 的混合 transcript,断言只保留安全可重放消息;现有 stopped agent 续跑用例保持通过。
- 口径:这一步补齐的是 CC-Haha resume 前的 transcript sanitation 核心行为;索引丢失时只凭磁盘 sidecar/transcript 定位并续跑已在 3.240 追加,大工具结果目录继承/回读已在 3.241 追加。`reconstructForSubagentResume()` 更完整的 contentReplacement record 重建、同 agent id 原地恢复仍需继续复制/移植/改写。
- 验证:`cd ts && bun test src/tasks/taskTools.test.ts src/tasks/teamTools.test.ts` = 15 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 586 pass,0 fail;`git diff --check` clean。

## 3.240 2026-07-08 CC-Haha orphan metadata/transcript 恢复迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/sessionStorage.ts` 的 `getAgentTranscriptPath()` / `.meta.json` sidecar 设计,以及 `resumeAgent.ts` 对 stopped/evicted agent 通过磁盘 transcript+metadata 恢复的路径。关键行为:后台 agent 的可恢复性不能只依赖内存 registry 或 `tasks.json` 索引。
- `ts/src/tasks/taskService.ts` 新增 `listBackgroundAgentMetadata()`:扫描 `task-transcripts/transcripts/*.meta.json`,逐个容错读取 metadata,坏文件/临时文件/非法 id 跳过。`resolveBackgroundAgentTarget()` 现在会在 stopped 状态解析时把没有 index entry 的 sidecar 合成为 `completed` background task,参与 task id、custom `name`、`agent` 三段匹配。
- `SendMessage` 的 stopped agent 路径因此可以在 `tasks.json` 缺失旧任务时继续命中 `.meta.json`,再由 `resumeBackgroundAgentTask()` 读取同 id transcript 并创建新的 background task;消息不会假成功落到普通 mailbox。
- 合成 task 的 `params.recovered_from_metadata=true`,便于后续 trace/调试识别来源;running 路由不读取 orphan sidecar,避免把磁盘旧任务误当活任务。
- 测试覆盖:`TaskService` 在空 index 下从 sidecar 解析 target,且 running 状态不误命中;`SendMessage` 完全不创建旧 task,只写 sidecar+transcript,仍能按 `name` 续跑 stopped agent 并把历史消息带入模型。
- 口径:这一步完成的是“索引丢失/进程重启后,靠磁盘 sidecar + transcript 找回 stopped background agent 并创建续跑任务”的可运行等价层。大工具结果目录继承/回读已在 3.241 追加;仍不是 CC-Haha 的同 agent id 原地恢复,更完整的 contentReplacement record 重建仍需继续复制/移植/改写。
- 验证:`cd ts && bun test src/tasks/taskService.test.ts src/tasks/taskTools.test.ts src/tasks/teamTools.test.ts` = 21 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 588 pass,0 fail;`git diff --check` clean。

## 3.241 2026-07-08 CC-Haha resume 大工具结果回读迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/resumeAgent.ts` 的 `reconstructForSubagentResume()` 调用,以及 `~/Desktop/cc-haha-ref/src/utils/toolResultStorage.ts` 的 content replacement / large tool result 存储设计。关键行为:后台 agent resume 后,历史 transcript 里的大工具结果占位不能变成死链接;模型必须还能通过工具回读旧的大日志、大 diff、大 MCP 输出。
- `ts/src/tasks/taskService.ts` 新增 `backgroundAgentToolResultStoreDir(taskId)`,并把 `toolResultStoreDir` 写入 `BackgroundAgentMetadata`。每个 background agent 有稳定 `task-tool-results/{taskId}` 目录,不是临时 `adhoc` 目录。
- `startBackgroundAgentRun()` 现在把稳定 `toolResultStoreDir` 传进 `runAgentLoop()`,因此后台 agent 内部的 `run_command/project_diagnostics/git_status/TaskOutput/MCP` 等大结果会写到可控目录,`read_stored_tool_result` 在同一后台 run 内可读。
- `resumeBackgroundAgentTask()` 会优先继承旧 metadata/params 中的 `toolResultStoreDir`;续跑任务继续使用旧目录。这样旧 transcript 里的 `<stored_tool_result path="...">` 在新 run 里仍在 `ctx.toolResultStoreDir` 边界内,不会被 `read_stored_tool_result` 拒绝。
- 测试覆盖:构造 stopped background agent 的旧 transcript,其中 tool_result 只包含 `<stored_tool_result path="...">` 预览;续跑后模型第一步调用 `read_stored_tool_result`,断言能读到旧目录里的 `TAIL`,且新 task metadata 保留同一个 `toolResultStoreDir`。
- 口径:这一步是本项目现有大工具结果落盘机制下,对 CC-Haha contentReplacement resume 的可运行等价层。仍未实现 CC-Haha 原版的同 agent id 原地恢复、contentReplacementRecord 全量重建和更复杂的替换状态合并。
- 验证:`cd ts && bun test src/tasks/taskService.test.ts src/tasks/taskTools.test.ts src/tasks/teamTools.test.ts src/context/toolResultStorage.test.ts src/tools/storedToolResultTool.test.ts` = 31 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 589 pass,0 fail;`git diff --check` clean。

## 3.242 2026-07-08 CC-Haha same agentId 稳定寻址迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/resumeAgent.ts` 与 `~/Desktop/cc-haha-ref/src/tools/SendMessageTool/SendMessageTool.ts`。关键行为:CC-Haha resume 用原 `agentId` 注册/恢复;后续 `SendMessage({to:agentId})` 继续命中同一个 agent,不会从最老 transcript 反复 fork。
- 本项目仍保留“续跑创建新 background task”的任务抽屉模型,但 `TaskService.resolveBackgroundAgentTarget()` 现在会沿 `params.resumed_from` 追踪最新后代。若用户/模型继续对旧 task id 发送消息,解析会优先返回最新 running/completed descendant,而不是旧 root task。
- running 路由收益:旧 task id 若已有 running 续跑后代,`SendMessage` 会排队到最新 running task 的 steer inbox;stopped 路由收益:旧 task id 若最新后代已完成,下一次续跑会从最新后代 transcript 继续,避免多次从 root transcript fork 出平行分支。
- 测试覆盖:`TaskService` 在旧 id + running descendant 时解析到 running 后代,在后代 completed 后解析到 latest completed 后代;`SendMessage` 连续两次发给最老 task id,第二次 `resumed_from` 必须等于第一次续跑出的 task id。
- 口径:这一步补齐的是 CC-Haha same-agent-id 稳定寻址的可运行等价层,不改变现有任务抽屉“一次续跑一个新 task”的 UI/历史模型。真正同一个 task id 原地覆盖运行、原 AppState task slot 复用仍需继续复制/移植/改写。
- 验证:`cd ts && bun test src/tasks/taskService.test.ts src/tasks/taskTools.test.ts src/tasks/teamTools.test.ts` = 24 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 591 pass,0 fail;`git diff --check` clean。

## 3.243 2026-07-08 CC-Haha same agentId 输出/停止连续性迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tasks/LocalAgentTask/LocalAgentTask.tsx`、`~/Desktop/cc-haha-ref/src/tools/TaskOutputTool/TaskOutputTool.tsx`、`~/Desktop/cc-haha-ref/src/tools/TaskStopTool/TaskStopTool.ts`。关键行为:CC-Haha local agent resume 继续使用同一个 `agentId`,因此 `TaskOutput`/`TaskStop`/任务面板面对的是同一条任务身份;不会出现 `SendMessage` 已续跑到后代,但读取输出或停止任务仍停留在最老 root task 的割裂体验。
- `ts/src/tasks/taskTools.ts` 新增 task 引用解析层:`read_background_task`、`TaskOutput`、`cancel_background_task`、`TaskStop` 会先通过 `TaskService.resolveBackgroundAgentTarget()` 把旧 background task id 解析到最新 running/completed descendant,再读取事件、等待完成或取消实际任务。非 background task 仍按原 `tasks.get(id)` 直读。
- 输出侧兼容:若请求 id 被解析到后代,`read_background_task` 的 `<background_task>` 增加 `requested_id`, `TaskOutput` 与 `TaskStop` 增加 `<requested_task_id>`;模型能知道“用户传的是旧 id,实际命中的是最新续跑任务”,同时仍保留 CC-Haha 风格的 `<task_id>/<status>/<output>` 主结构。
- 停止侧收益:对旧 root id 调 `cancel_background_task` 或 `TaskStop`,若最新后代仍在 running/queued,会取消最新后代而不是误报 root 已完成不可停;这补上 3.242 只覆盖 `SendMessage` 路由、未覆盖 output/stop 工具的缺口。
- 测试覆盖:`TaskOutput`/`read_background_task` 对旧 id 读到 latest descendant 的最新结论且不返回 root 旧结论;`cancel_background_task`/`TaskStop` 对旧 id 成功取消 running descendant 并返回 requested id 映射。
- 口径:这一步继续逼近 CC-Haha same-agent-id 的使用体验,但仍保留当前“一次续跑一个新 task”的持久历史模型。真正原地复用同一 task slot、UI 侧将链路合并成单一任务行、完整 contentReplacementRecord 重建仍需继续复制/移植/改写。
- 验证:`cd ts && bun test src/tasks/taskService.test.ts src/tasks/taskTools.test.ts src/tasks/teamTools.test.ts` = 26 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 593 pass,0 fail;`git diff --check` clean。

## 3.244 2026-07-08 CC-Haha same agentId 前端任务 API 连续性迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tasks/LocalAgentTask/LocalAgentTask.tsx` 的同 `agentId` task slot、`TaskOutputTool` 对任意 task id 读取统一输出的行为。关键缺口:3.243 已让模型工具层按旧 id 读/停最新 descendant,但前端后台任务抽屉走 `/tasks/:id`、`/tasks/:id/events`、`/tasks/:id/cancel`,此前仍会直读旧 root。
- `ts/src/server/index.ts` 新增 `/tasks` 端点级 task alias 解析:`GET /tasks/:oldId?includeEvents=1` 与 `GET /tasks/:oldId/events` 会先通过 `TaskService.resolveBackgroundAgentTarget()` 找 latest descendant,返回最新 task/events,并在响应中附带 `requestedTaskId/resolvedTaskId`。普通 task id 不受影响。
- `POST /tasks/:oldId/cancel` 同样先解析 running/queued descendant,再取消实际 task;若没有 live descendant,仍保持原来的 `{ok:true,cancelled:false}` 风格,不把旧 completed root 误报成已取消。
- `web/src/lib/api.ts` 增加 `BackgroundTaskDetailResponse` 的 alias 字段;`BackgroundTasksPanel` 加载旧 id 事件时会把事件同时缓存到 requested/resolved id,并自动展开 resolved task,避免通知或旧链接定位到 root 后看不到最新事件。
- 测试覆盖:预置 root+latest background agent 链路后,`/tasks/:root?includeEvents=1` 和 `/tasks/:root/events` 都返回 latest id/latest 事件,且不返回 root 旧结论。前端类型检查覆盖 alias 字段与面板状态更新。
- 口径:这一步把 same-agent-id 的可运行等价层从模型工具扩展到前端任务 API/抽屉。任务列表是否把 root/descendant 合并成单行、通知是否按链路去重、真正原地复用同一 task id 仍需继续复制/移植/改写。
- 验证:`cd ts && bun test src/server/index.test.ts src/tasks/taskService.test.ts src/tasks/taskTools.test.ts src/tasks/teamTools.test.ts` = 93 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm exec tsc --noEmit` clean;`cd ts && bun test` = 594 pass,0 fail;`cd web && pnpm test` = 113 pass,0 fail;`git diff --check` clean。

## 3.245 2026-07-08 CC-Haha same agentId 任务列表折叠迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tasks/LocalAgentTask/LocalAgentTask.tsx` 的同 `agentId` AppState task slot。关键行为:CC-Haha resume 后仍是同一个 agent/task 身份,任务面板不会把 root task 和每次 resumed descendant 都显示成多条独立子代理。
- `ts/src/tasks/taskService.ts` 新增 `TaskListOptions.collapseResumedBackgroundAgents`:底层历史默认仍保留完整 task index;显式开启时,会先按 `params.resumed_from` 找出 background agent 续跑链路,隐藏已被后代继承的 ancestor,只列出当前 leaf task。非 background task 不受影响。
- `list_background_tasks` 现在默认使用折叠视图。模型查看后台任务时不会被旧 root completed task 干扰;若最新 leaf 是 running,`status:completed` 不再把 root 当“可继续读取”的当前任务列出来,更贴近同 slot 的状态语义。
- `/tasks` 前端列表同样使用折叠视图。后台任务抽屉保留完整历史可通过旧 id 解析读取,但常规列表只呈现最新 leaf,减少 UI 噪声,更接近 Codex/CC-Haha 的单任务感知。
- 测试覆盖:`TaskService.list({collapseResumedBackgroundAgents:true})` 保留 leaf/普通任务并隐藏 ancestor;`list_background_tasks` 只列 latest leaf;`/tasks?conversationId=...` 只返回 latest descendant,而 `/tasks/:oldId` 与 `/events` 仍能按旧 id 解析到最新任务。
- 口径:这一步完成的是任务列表层面的 same-agent-id 可运行等价。通知去重、任务行中展示 resume chain/旧 id 别名、真正原地复用同一 task id 仍需继续复制/移植/改写。
- 验证:`cd ts && bun test src/server/index.test.ts src/tasks/taskService.test.ts src/tasks/taskTools.test.ts src/tasks/teamTools.test.ts` = 95 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 596 pass,0 fail;`cd web && pnpm exec tsc --noEmit && pnpm test` = typecheck clean + 113 pass,0 fail;`git diff --check` clean。

## 3.246 2026-07-08 CC-Haha 大工具结果空值/稳定落盘迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/toolResultStorage.ts`。关键行为:空 `tool_result` 不能原样作为空内容塞回模型,否则部分模型会把尾部误判为 turn 结束;同一个 `tool_use_id` 的大结果落盘路径要稳定,历史 replay/resume 时不能反复制造新文件或改变模型看到的替换文本。
- `ts/src/context/toolResultStorage.ts` 的 `maybeStoreToolResult()` 现在对空白输出返回 `(${tool} completed with no output)`,与 CC-Haha 的 empty result marker 行为对齐,避免 run_command/REPL/MCP 等工具 silent success 时给模型一个空 tool_result。
- 大工具结果落盘文件名从时间戳+随机后缀改成 `${tool_use_id}-${tool}.txt`;如果同一 call id 的文件已存在,按 CC-Haha `wx/EEXIST` 口径复用现有文件并生成同样的 `<stored_tool_result path="...">` 预览,不重复写入。
- 这会增强 3.241 的 resume 大结果回读:后台 agent 续跑、compaction 或历史重放时,旧 `<stored_tool_result>` 指向的文件更稳定,`read_stored_tool_result` 的边界仍限制在当前 session/background agent 的 `toolResultStoreDir` 内。
- 测试覆盖:空白工具输出回灌完成标记且不落盘;同一 `tool_use_id` 的大结果连续处理两次只生成一个稳定文件;现有 stored result 回读、后台 agent 续跑继承 store dir、loop 大结果落盘测试保持通过。
- 口径:这一步补的是 CC-Haha per-tool 大结果存储的稳定性细节。完整 per-message aggregate `ContentReplacementState`、`ContentReplacementRecord` 序列化和 `reconstructContentReplacementState()` 仍需继续复制/移植/改写。
- 验证:`cd ts && bun test src/context/toolResultStorage.test.ts src/harness/loop.test.ts src/tools/storedToolResultTool.test.ts src/tasks/teamTools.test.ts` = 73 pass;`cd ts && bun run typecheck` clean。

## 3.247 2026-07-08 CC-Haha ContentReplacementState / aggregate tool_result budget 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/toolResultStorage.ts` 的 `ContentReplacementState`、`ContentReplacementRecord`、`enforceToolResultBudget()`、`applyToolResultBudget()`、`reconstructContentReplacementState()`。关键行为:不只处理单个超大工具输出,还要处理同一条 user followup 里多个中等 `tool_result` 合计过大导致模型上下文被顶爆的场景。
- `ts/src/context/toolResultStorage.ts` 新增 message-level aggregate budget,默认按 CC-Haha `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000` 口径;每条 API-level user message 独立评估,优先替换最大的 fresh tool result,已 seen 的结果冻结决策,已 replaced 的结果按 Map 字节级重放。
- 新增 `ContentReplacementRecord` sidecar: `ts/src/memory/transcript.ts` 为每个 transcript 维护 `${conversationId}.content-replacements.jsonl`;新替换记录追加写入,加载历史时跳过坏行,恢复时用 record 直接重建 `replacement` 字符串,避免 resume 后模板/路径/预览细节变化造成模型可见前缀漂移。
- `runAgentLoop()` 在首次模型调用前重建 replacement state,在每批工具结果回灌后执行 `applyToolResultBudget()`;替换后的 `<stored_tool_result>` 会进入模型实际消息和 transcript,后台 agent resume/SendMessage 复用 transcript 时能继续看到稳定预览并通过 `read_stored_tool_result` 回读全文。
- 保护口径: `read_file/read_many_files` 暂按 CC-Haha Read/代码上下文工具思路跳过 aggregate 落盘,避免模型为了理解源码反复通过 stored-result 回读代码;这类工具仍由自身 focused read/max token/compaction 约束。
- 测试覆盖:多个中等 `tool_result` 合计超预算时只替换最大 fresh 结果;sidecar record 可重建并字节级重放旧替换;主循环两个自定义只读工具合计超过 200K 时只落盘最大结果、写 replacement sidecar、transcript 保存稳定 `<stored_tool_result>`。
- 口径:这一步补齐 CC-Haha aggregate 大结果上下文稳定层。后续仍要继续复制/移植/改写 AgentTool sidechain 更完整的 metadata/worktree/同 id 原地复用链路,以及 UI 里对 stored result / background trace 的低噪展示。
- 验证:`cd ts && bun test src/context/toolResultStorage.test.ts src/harness/loop.test.ts` = 59 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 601 pass,0 fail;`cd web && pnpm exec tsc --noEmit && pnpm test` = typecheck clean + 113 pass,0 fail;`git diff --check` clean;旧禁用措辞扫描无命中。

## 3.248 2026-07-08 CC-Haha AgentTool sidechain transcript 底座迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/runAgent.ts` 与 `~/Desktop/cc-haha-ref/src/utils/sessionStorage.ts` 的 `recordSidechainTranscript()`、`writeAgentMetadata()`、`getAgentTranscriptPath()`。关键行为:子代理不是一次性黑盒函数调用,而应有独立 agent id、sidechain transcript、metadata 和工具结果目录,以便后续 resume、审计、进度总结、stored result 回读都能站住。
- `ts/src/agents/agentTool.ts` 的同步 `agent_task` 新增可选 `sidechainRoot`:每次运行生成 `agent_<parent>_<agent>_<uuid>` id,创建独立 `Transcript`,写 `.meta.json`,并给子代理 loop 传入独立 `toolResultStoreDir`。返回语义保持低噪,仍只把 `<agent_task>` 最终结论回给父代理。
- `ts/src/server/index.ts` 在真实桌面 `/agent/run` 构建 `agent_task` 时接入 `join(stateRoot,'agent-task-sidechains')`,使前端会话里的同步子代理也有持久 sidechain,不是只在测试中启用。
- 与 3.247 联动:子代理内部的大工具结果批次会走同一套 aggregate budget 和 `ContentReplacementRecord` sidecar;即使是同步 `agent_task`,它自己的大日志/大 diff 也不会直接撑爆父会话上下文,并且可通过 sidechain tool-result store 回读。
- 测试覆盖:普通 `agent_task` 运行后生成主 transcript 与 metadata;大工具结果批次触发 sidechain `.content-replacements.jsonl`、主 transcript 保存 `<stored_tool_result>`、全文落到独立 `tool-results/<agentId>` 目录;原有子代理返回值、工具过滤、多 agent 校验不回归。
- 口径:这一步补的是同步 AgentTool 的 sidechain 底座。CC-Haha 的完整 async LocalAgentTask 注册、同一 agentId resume、MCP frontmatter、hooks 作用域、worktree isolation、prompt-cache 进度总结等仍需继续复制/移植/改写;后台 agent 侧已有一部分,但还要统一到更接近 CC-Haha 的模型。
- 验证:`cd ts && bun test src/agents/agentTool.test.ts src/harness/loop.test.ts src/context/toolResultStorage.test.ts` = 63 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 602 pass,0 fail;`cd web && pnpm exec tsc --noEmit && pnpm test` = typecheck clean + 113 pass,0 fail;`git diff --check` clean;旧禁用措辞扫描无命中。

## 3.249 2026-07-08 CC-Haha AgentTool sidechain 可发现/可读取出口迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/sessionStorage.ts` 的 `getAgentTranscript(agentId)`、`extractAgentIdsFromMessages()` 与 `ContentReplacementEntry(agentId)`。关键行为:sidechain transcript 不能只是落盘副产物,必须能被 agent id 定位并回读,否则后续 resume、审计、UI trace 与大结果回读都没有稳定入口。
- `agent_task` 返回 XML 现在带 `agent_id` 属性:`<agent_task agent="..." agent_id="...">`;父代理、前端 trace helper、后续工具都能拿这个 id 作为同步子代理轨迹句柄。前端 `parseAgentTaskResult()` / `buildSubagentTrace()` 同步保留 `agentId`,不再只展示 agent 名称和 final text。
- 新增只读工具 `list_agent_task_sidechains` 与 `read_agent_task_sidechain`:前者可按 `parent_conversation_id` 列最近同步子代理 sidechain metadata,后者按 `agent_id` 分页读取 transcript,同时报告 `content_replacements` 数量与 cursor,用于继续读取长轨迹。
- `/agent/run` 的真实工具池在有 agents 时挂载这两个工具,并加入 `tool_search` hot list 与中文别名(“读子代理轨迹/读取子代理 transcript/agent sidechain”等),大工具池懒加载时模型也能找到。
- 读取边界: `agent_id` 限制在安全 segment,`Transcript.loadPage()` 分页读取 JSONL,metadata 坏/缺不拖垮 transcript 读取;输出保持 XML,其中 text/tool_use/tool_result 分块转义,不会执行路径或越权读取任意文件。
- 测试覆盖:`agent_task` 返回 `agent_id` 并可用 `read_agent_task_sidechain` 读回子代理工具结果;`list_agent_task_sidechains` 可按父 conversation 过滤并列出 task;server `/agent/run` 暴露新工具;前端 trace parser 保留 `agentId`;`tool_search` 聚焦测试不回归。
- 口径:这一步把同步 sidechain 从“写得到”推进到“找得到、读得到”。CC-Haha 的 stopped async agent 同 id 原地 resume、sidechain worktree restore、agent progress summary 与完整 UI transcript drill-in 仍需继续复制/移植/改写。
- 验证:`cd ts && bun test src/agents/agentTool.test.ts src/tools/toolSearchTool.test.ts src/harness/loop.test.ts src/context/toolResultStorage.test.ts` = 67 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm exec vitest run src/components/desktop/subagent-trace.test.ts && pnpm exec tsc --noEmit` = 7 pass + typecheck clean;`cd ts && bun test src/server/index.test.ts -t "exposes agent_task"` = 1 pass;`cd ts && bun test` = 602 pass,0 fail;`cd web && pnpm exec tsc --noEmit && pnpm test` = typecheck clean + 113 pass,0 fail;`git diff --check` clean;旧禁用措辞扫描无命中。

## 3.250 2026-07-08 CC-Haha AgentTool sidechain 大结果回读闭环迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/runAgent.ts`、`~/Desktop/cc-haha-ref/src/utils/sessionStorage.ts`、`~/Desktop/cc-haha-ref/src/utils/toolResultStorage.ts`。关键行为:子代理 sidechain 里的 `<stored_tool_result path="...">` 不能只停留在 transcript 预览,必须能按 `agent_id` 定位对应 tool-result store 并做有界回读,否则大日志/大 diff/大 MCP 结果在同步子代理里会变成死链接。
- 新增只读工具 `read_agent_task_stored_result`:输入 `{ agent_id, path, offset?, max_bytes?, tail? }`,先读取 sidechain metadata/预期目录,再把读取边界收口到 `agent-task-sidechains/tool-results/<agent_id>`。即使 metadata 被篡改成目录外路径,也会回落到预期目录并用 realpath containment 拒绝越界/软链逃逸。
- `read_agent_task_stored_result` 复用 `read_stored_tool_result` 的安全窗口读取辅助逻辑:默认 120KB、最大 500KB、支持 tail/offset、清洗 ANSI 控制序列,输出仍是 `<stored_tool_result_read ...>`,前端可以复用原长结果读取卡。
- 工具可发现性同步补齐:加入 `tool_search` hot list 与中文别名(“读取子代理长结果/读取子代理工具结果/sidechain stored result”),并加入 `REPL` primitive,让模型可以在批处理里先读 sidechain 再回读对应大结果窗口。
- 前端低噪展示同步: `read_agent_task_stored_result` 进入共享工具文案“读取子代理长结果”;`StoredToolResultRead` 解析器保留 `agent_id`;`DesktopChatThread` 对该工具复用长工具结果读取卡,避免把回读 XML 当普通原文堆到对话里。
- 测试覆盖:同步子代理里两个大工具结果合计超预算后,sidechain transcript 保存 `<stored_tool_result>`,全文落到 `tool-results/<agentId>`;`read_agent_task_stored_result({agent_id,path,tail:true})` 能读到 `A-TAIL` 且不泄露头部;目录外绝对路径被 `status="rejected"` 拒绝;server `/agent/run` 暴露新工具;`tool_search` 可通过中文意图命中新工具;前端 parser/tool label 不回归。
- 口径:这一步把同步 AgentTool 的 sidechain stored-result 从“可落盘、可看到占位”推进到“可由模型安全按窗口回读”。CC-Haha 的 async LocalAgentTask 原地续跑、sidechain worktree restore、agent MCP frontmatter、hooks 作用域、prompt-cache 进度总结、前端完整 transcript drill-in 仍需继续复制/移植/改写。
- 验证:`cd ts && bun test src/agents/agentTool.test.ts src/tools/toolSearchTool.test.ts src/tools/storedToolResultTool.test.ts` = 13 pass;`cd ts && bun test src/agents/agentTool.test.ts src/tools/toolSearchTool.test.ts src/tools/storedToolResultTool.test.ts src/tools/replTool.test.ts src/server/index.test.ts -t "exposes agent_task|agent_task|tool_search|read_stored_tool_result|REPL"` = 20 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm exec tsc --noEmit` clean;`cd web && pnpm exec vitest run src/lib/agent-tools.test.ts src/components/desktop/stored-tool-result-read.test.ts` = 5 pass;`cd ts && bun test` = 602 pass,0 fail;`cd web && pnpm test` = 113 pass,0 fail;`git diff --check` clean;旧禁用措辞扫描无命中。

## 3.251 2026-07-08 CC-Haha AgentTool worktree isolation 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` 的 `isolation:"worktree"`、`createAgentWorktree()`、`cleanupWorktreeIfNeeded()` 以及 `~/Desktop/cc-haha-ref/src/tools/AgentTool/resumeAgent.ts` 的 resumed worktree mtime 保活。关键行为:子代理做代码修改时应能在隔离 git worktree 中运行,干净则自动清理,有未提交文件或新增 commit 则保留路径并能被后续续跑恢复。
- `ts/src/tools/worktreeTools.ts` 抽出 `createIsolatedAgentWorktree()`:复用既有 CC-Haha worktree slug/路径/branch/exclude 逻辑,按 agent/task id 生成 `.claude/worktrees/agent-*`,并提供 `cleanupIfClean()` 统一统计 changed files / commits 后 clean remove、dirty keep。
- `agent_task` 新增 `isolation:"worktree"` 入参:同步子代理会在 isolated worktree 里执行其工具集,`write_file/edit_file/run_command/git_status` 等都看到 worktree workspace;sidechain metadata 记录 `worktreePath`;返回 XML 附加 `<agent_worktree status="removed_clean|kept">`。干净工作区自动删除,有变更则保留路径给用户/后续流程检查。
- `start_background_agent_task` 新增同名 `isolation:"worktree"` 入参:后台子代理启动时先创建 isolated worktree,runner 在 worktree workspace/sandbox 中执行;metadata 初始写入 worktreePath,完成时 clean 删除并清空 metadata 路径,dirty 保留路径。`SendMessage` 触发的 `resumeBackgroundAgentTask()` 会继承旧 metadata 的 `worktreePath`,新续跑 task 继续在同一 worktree 里运行并刷新 mtime。
- 工具发现补强:`tool_search` 增加“子代理隔离工作区/子代理 worktree/后台 agent worktree”等别名,让模型在大工具池懒加载时能找到 `agent_task` / `start_background_agent_task` 的 isolation 能力,不是只找到手动 `EnterWorktree`。
- 测试覆盖:同步 `agent_task({isolation:"worktree"})` 写入 `worker.txt` 后主仓库无该文件、worktree 保留并写进 sidechain metadata;后台 `start_background_agent_task({isolation:"worktree"})` 写文件后 metadata 记录 worktreePath,随后 `resumeBackgroundAgentTask()` 续跑能在同一 worktree 里 `read_file` 读到旧文件;既有 `EnterWorktree/ExitWorktree` 行为不回归。
- 口径:这一步把 CC-Haha AgentTool 的 worktree isolation 主行为迁进同步/后台子代理。仍待继续复制/移植/改写:worktree hook 事件、settings.local/`.worktreeinclude`/symlinkDirectories/sparse checkout、跨进程 worktree sessionStorage、async LocalAgentTask 同 agent id 原地 resume 与 UI drill-in。
- 验证:`cd ts && bun test src/tools/worktreeTools.test.ts src/agents/agentTool.test.ts src/tasks/taskTools.test.ts` = 23 pass;`cd ts && bun test src/tools/worktreeTools.test.ts src/agents/agentTool.test.ts src/tasks/taskTools.test.ts src/tools/toolSearchTool.test.ts` = 27 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 604 pass,0 fail;`cd web && pnpm exec tsc --noEmit` clean;`cd web && pnpm test` = 113 pass,0 fail;`git diff --check` clean;旧禁用措辞扫描无命中。

## 3.252 2026-07-08 CC-Haha async LocalAgentTask 稳定 agent id 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tasks/LocalAgentTask/LocalAgentTask.tsx`、`~/Desktop/cc-haha-ref/src/tools/AgentTool/resumeAgent.ts`、`~/Desktop/cc-haha-ref/src/tools/SendMessageTool/SendMessageTool.ts`。关键行为:CC-Haha 后台/异步子代理不是一次性 task,而是围绕同一个 `agentId` 继续注册、收消息、读输出、恢复 metadata/worktree/tool-result store。
- `ts/src/tasks/taskService.ts` 的 `BackgroundAgentMetadata` 新增 `agentId`,兼容磁盘字段 `agentId/agent_id`;`resolveBackgroundAgentTarget()` 现在按“旧 root -> latest descendant、精确 task id、稳定 agent_id、自定义 name、唯一 agent type”解析。这样既保留现有 task 事件隔离,又把 CC-Haha 的稳定代理身份补上。
- `start_background_agent_task` 初次启动时把初始 task id 作为稳定 `agent_id` 写入 task params 与 metadata,返回 `<background_task_started ... agent_id="...">`;`resumeBackgroundAgentTask()` 读取旧 metadata/params 后继承同一 `agent_id`,新 run 继续写入同一身份,并保留 3.251 的 worktree/tool-result store 继承。
- `SendMessage` 对 running/stopped background agent 的 JSON 返回新增 `agent_id`;模型后续可以直接 `SendMessage({to:agent_id})`、`TaskOutput({task_id:agent_id})` 或 `read_background_task({task_id:agent_id})`,解析会自动命中最新 run,避免连续续跑后只能记住最新 task id 的割裂体验。
- `read_background_task`、`TaskOutput`、`TaskStop` 输出增加 `agent_id`/`agent_id="..."`;server `/tasks/:id`、`/tasks/:id/events` 与 legacy `/api/v1/agent/tasks/:id/events|message|cancel` 也接入同一 alias 解析,返回 `agentId/requestedTaskId/resolvedTaskId` 或 `agent_id/requested_task_id/resolved_task_id`。前端 `parseBackgroundTaskStarted()` 保留 `agentId`,后台启动卡低噪显示稳定 id。
- 口径:这一步是 CC-Haha “同一 agent 身份”在当前 TS/Web 任务抽屉模型里的可运行等价层。我们仍保留每次 resume 一个新 task 来隔离 event JSONL 与 UI 历史;真正完全同 `agentId` 原地复用同一 task slot、prompt-cache progress summary、agent content replacement full restore、UDS/remote teammate bridge 还要继续复制/移植/改写。
- 验证:`cd ts && bun test src/tasks/taskService.test.ts src/tasks/taskTools.test.ts src/tasks/teamTools.test.ts src/server/index.test.ts` = 100 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm exec tsc --noEmit` clean;`cd web && pnpm exec vitest run src/components/desktop/subagent-trace.test.ts` = 7 pass。

## 3.253 2026-07-08 CC-Haha Agent frontmatter 行为字段迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/loadAgentsDir.ts`、`runAgent.ts`、`AgentTool.tsx`。关键行为:Agent `.md` 不是只给 prompt,还会声明工具白/黑名单、权限模式、最大轮次、初始提示、默认后台、默认 worktree isolation 等行为约束;这些字段直接决定 coding subagent 是否能按角色安全分工。
- `ts/src/agents/agentLoader.ts` 新增解析字段:`disallowedTools`、`permissionMode`、`maxTurns`、`initialPrompt`、`background`、`isolation:"worktree"`。`tools:"*"`/缺省按 CC-Haha 口径视为全量工具,再用 `disallowedTools` 排除;非法 permission/isolation/maxTurns 不生效,不污染 agent。
- 同步 `agent_task` 现在会真实使用这些字段: `initialPrompt` 预置到子代理首轮 user message;`permissionMode` 覆盖子代理工具权限;`maxTurns` 覆盖 loop 轮次;`isolation:"worktree"` 作为默认隔离策略;`disallowedTools` 从 resolved tool pool 中剔除。`background:true` 且 server 注入 background runner 时,同步 `agent_task` 会返回 `<background_task_started ...>` 并把任务交给后台子代理执行。
- `start_background_agent_task` 同样使用 agent 定义默认值:后台 run 会继承 `initialPrompt`、`permissionMode`、`maxTurns`、`isolation:"worktree"` 和工具黑名单,并在 task params 记录 `permission_mode/max_turns/isolation` 便于 UI/审计定位。
- server `/agent/run` 创建 `agent_task` 时接入 `startBackgroundAgentRun()` 委托,让 agent 文件里的 `background:true` 在真实桌面路径中可运行,而不是只在测试中存在。
- 测试覆盖:`loadAgentsDir` 解析新增 frontmatter 字段;`resolveAgentTools` 支持全量+黑名单与子集+黑名单;同步 `agent_task` 验证 initialPrompt、permissionMode、maxTurns、default worktree、disallowedTools、background:true;后台 `start_background_agent_task` 验证同样的 prompt/权限/工具/轮次默认值。
- 口径:这一步补齐无需新连接生命周期的 CC-Haha Agent frontmatter 行为字段。仍需继续复制/移植/改写:agent-specific `mcpServers` 初始化/required MCP filtering、frontmatter hooks/SubagentStart/SubagentStop scope、effort/model override 到真实 provider、agent memory snapshot、remote isolation。
- 验证:`cd ts && bun test src/agents/agentLoader.test.ts src/agents/agentTool.test.ts src/tasks/taskTools.test.ts` = 21 pass;`cd ts && bun run typecheck` clean。

## 3.254 2026-07-08 CC-Haha Agent 级 MCP frontmatter 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/loadAgentsDir.ts` 的 `mcpServers/requiredMcpServers` 解析与 `filterAgentsByMcpRequirements()`,以及 `~/Desktop/cc-haha-ref/src/tools/AgentTool/runAgent.ts` 的 `initializeAgentMcpServers()`。关键行为:agent 可以声明自己专属 MCP server,也可以要求某类 MCP server 已连接并暴露工具,这些工具只在该 agent 运行期间加入工具池并在结束后清理。
- `ts/src/commands/frontmatter.ts` 的 markdown frontmatter 解析升级为优先使用 Bun 内置 YAML,失败时回落旧轻量 key/value 解析;这样 agent 文件可直接写 CC-Haha 风格的多行 `mcpServers:` YAML 数组/对象,同时不破坏 commands/skills/output-style 现有 frontmatter。
- `ts/src/agents/agentLoader.ts` 新增 `AgentMcpServerSpec`、`mcpServers`、`requiredMcpServers/required_mcp_servers`。`mcpServers` 支持字符串引用已配置 server,也支持 inline `{ serverName: { command/args/url/env } }` 定义;`requiredMcpServers` 按 CC-Haha 口径作为 case-insensitive server 名称 pattern。
- 新增 `ts/src/agents/agentMcp.ts`:把 agent frontmatter spec 解析成现有 `McpServerConfig`,复用 `connectMcpServers()` 连接 stdio/HTTP MCP server,把 agent MCP tools 与基础工具池按名称去重合并,根据工具名/描述提取可用 server 名并执行 required MCP 校验,结束时 `closeMcpConnections()` 清理 agent 私有连接。
- 同步 `agent_task` 和后台 `start_background_agent_task` 都接入 agent MCP runtime。同步子代理会在 sidechain/worktree workspace 内连接 agent MCP,把 warning 作为子代理进度输出;后台子代理会独立连接并把 warning 写入 task event,避免复用父 turn 即将关闭的 MCP 连接。server `/agent/run` 会把当前 `mcpConfigPath`、elicitation handler、sampling handler 传给 agent MCP runtime,所以真实路径里的 MCP 表单问答/反向 sampling 也能工作。
- 测试覆盖:`loadAgentsDir` 解析多行 YAML `mcpServers/requiredMcpServers`;同步 `agent_task` 用临时 stdio MCP fixture 注入 `mcp__agent_fixture__agent_echo` 并回灌工具结果;required MCP 缺失时硬拒;后台 `start_background_agent_task` 用独立 stdio MCP fixture 注入工具并完成后台任务。完整 TS 测试覆盖 frontmatter parser 升级未破坏其他 loader。
- 口径:这一步补齐 CC-Haha agent-specific MCP 的当前 TS 可运行等价层。仍需继续复制/移植/改写:agent/frontmatter hooks、SubagentStart/SubagentStop hook scope、agent memory snapshot、effort/model override 到真实 provider、同 `agent_id` 原地 task slot、完整 agent progress summary/prompt-cache。
- 验证:`cd ts && bun test src/agents/agentLoader.test.ts src/agents/agentTool.test.ts src/tasks/taskTools.test.ts` = 24 pass;`cd ts && bun run typecheck` clean;`cd ts && bun test` = 614 pass,0 fail。

## 3.255 2026-07-08 CC-Haha Agent frontmatter hooks / SubagentStart/SubagentStop 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/hooks/registerFrontmatterHooks.ts`、`~/Desktop/cc-haha-ref/src/tools/AgentTool/runAgent.ts`、`~/Desktop/cc-haha-ref/src/utils/hooks.ts` 与 `~/Desktop/cc-haha-ref/src/schemas/hooks.ts`。关键行为:agent/skill frontmatter 里的 hooks 要注册到当前 agent 生命周期,子代理启动前触发 `SubagentStart`,子代理结束时触发 `SubagentStop`;agent frontmatter 里声明的 `Stop` 需要自动转成 `SubagentStop`。
- `ts/src/hooks/hooks.ts` 新增 `SubagentStart/SubagentStop` 事件、`agentId/agentType` payload、agentType matcher 与 `mergeHookRegistries()`。`applySubagentStartHooks()` 会收集 additional context;`applyStopHooks()` 在传入 subagent 身份时改派发 `SubagentStop`,并在 context_note 中保留事件名。
- `ts/src/hooks/hookConfig.ts` 支持 CC-Haha frontmatter 风格结构:`hooks: { EventName: [{ matcher, hooks: [...] }] }`,同时保留旧 `{hooks:[...]}` / `{rules:[...]}` 静态 JSON decision 格式。agent frontmatter 模式会把 `Stop` 规范化成 `SubagentStop`。`command` hook 已按 CC-Haha 口径把 JSON payload 写入 stdin,解析 stdout 中的 `{action:...}` 或 `hookSpecificOutput.additionalContext/updatedInput`,exit code 2 视为 blocking deny。
- `ts/src/agents/agentLoader.ts` 新增 agent `hooks` 字段解析;同步 `agent_task` 和后台 `start_background_agent_task` 会合并全局/domain-pack hooks 与 agent frontmatter hooks,运行前执行 `SubagentStart`,把返回上下文注入子代理首轮模型消息,并把 `agent_id/agent_type` 传给 loop 的 `SubagentStop`。
- `/agent/run` 真实路径把本轮主会话 hook registry 传给同步/后台 agent options,因此项目 hooks、领域包 SessionStart hooks 与 agent frontmatter hooks 在子代理里合并生效,不是只在测试路径可用。
- 测试覆盖:CC-Haha event-map frontmatter hooks 解析与 agent `Stop -> SubagentStop` 转换;command hook stdin/stdout 协议;`SubagentStart/SubagentStop` 按 `agentType` matcher 派发;`loadAgentsDir` 读取 hooks;同步 `agent_task` 注入启动 hook context 并在 final 前输出 SubagentStop context;后台 agent 把启动/收尾 hook 写入 task events。
- 口径:这一步完成 agent frontmatter hooks 生命周期主链和 `command` executor 的可运行迁移。`prompt`/`http`/`agent` hook executor 当时仍保留注册与匹配并输出明确 context 提醒,后续继续按 CC-Haha `execPromptHook`、`execHttpHook`、`execAgentHook` 复制/移植/改写。
- 验证:`cd ts && bun test src/hooks/hooks.test.ts src/hooks/hookConfig.test.ts src/agents/agentLoader.test.ts src/agents/agentTool.test.ts src/tasks/taskTools.test.ts` = 40 pass;`cd ts && bun run typecheck` clean。

## 3.256 2026-07-08 CC-Haha HTTP hook executor 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/hooks/execHttpHook.ts` 与 `~/Desktop/cc-haha-ref/src/schemas/hooks.ts` / `entrypoints/sdk/coreSchemas.ts`。关键行为:`type:"http"` hook 要把 hook input JSON POST 到配置 URL,支持 headers 中的受控 env var 插值,按 timeout/abort 中断,响应体继续按 hook JSON output / hookSpecificOutput 解释。
- `ts/src/hooks/hookConfig.ts` 的 frontmatter hook normalizer 现在对 `type:"http"` 生成真实 `HookRule.handler`,而不是占位 context。执行时发送 CC-Haha 风格 payload:`hook_event_name/session_id/cwd/permission_mode/tool_name/tool_input/tool_response/prompt/agent_id/agent_type`。
- HTTP executor 支持 `timeout` 秒级配置、`allowedEnvVars` 白名单插值 `$VAR`/`${VAR}` 到 header value,并剥离 CR/LF/NUL 防止 header 注入。未列入 allowlist 的 env 引用会替换为空字符串,避免把本机密钥从项目 hook 配置里无意带出去。
- 安全边界:只允许 `http:` / `https:` URL,禁自动重定向(`redirect:"manual"`),非 2xx 作为非阻塞 context warning 回灌;fetch/network 错误也作为非阻塞 warning;timeout 或父 signal abort 按 deny 处理,与 command hook 的 blocking timeout 口径一致。
- 响应解析:兼容本项目 `{action:"context"|"deny"|"modify"|"allow"}` 简洁 JSON,也兼容 CC-Haha `decision:"approve"|"block"` 与 `hookSpecificOutput.additionalContext/updatedInput`。空响应不产生 decision,非 JSON 响应作为 additional context。
- 测试覆盖:本地 HTTP server 断言 POST payload、`Authorization: Bearer $HOOK_TEST_TOKEN` 只在 `allowedEnvVars` 中插值、未允许 env header 置空;`hookSpecificOutput.additionalContext` 可解析;HTTP 500 返回非阻塞 warning。
- 口径:这一步补齐 HTTP hook executor 的当前 TS 可运行等价层。当时仍需继续复制/移植/改写 prompt/agent hook executor;prompt 已在 3.257 补齐,当前剩余 agent hook executor、CC-Haha 全局 `allowedHttpHookUrls/httpHookAllowedEnvVars` settings policy、SSRF DNS guard、sandbox network proxy/系统代理绕过策略。
- 验证:`cd ts && bun test src/hooks/hookConfig.test.ts` = 7 pass;`cd ts && bun test src/hooks/hooks.test.ts src/hooks/hookConfig.test.ts src/agents/agentLoader.test.ts src/agents/agentTool.test.ts src/tasks/taskTools.test.ts` = 42 pass;`cd ts && bun run typecheck` clean。

## 3.257 2026-07-08 CC-Haha prompt hook executor 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/hooks/execPromptHook.ts`、`hookHelpers.ts` 与 `goals/goalState.ts`。关键行为:`type:"prompt"` hook 要用非流式模型做 JSON 判定,替换/追加 `$ARGUMENTS`,并把 `/goal` evaluator 的异常输出视为必须继续工作的阻断信号。
- `ts/src/hooks/hookConfig.ts` 不再把 `type:"prompt"` 作为占位提示,而是生成真实 `HookRule.handler`:构造 CC-Haha 风格 payload,把处理后的 prompt 作为 user message 喂给当前模型,并要求模型只返回 `{"ok":true}` 或 `{"ok":false,"reason":"..."}`。
- `ToolContext` 新增当前会话 `model`,主 `runAgentLoop` 创建上下文时注入;主会话、同步子代理和后台子代理复制上下文时都能真实跑 prompt hook,而不是只保留 frontmatter 注册。
- prompt hook 返回 `ok:true` 映射为 `allow`;`ok:false` 映射为 `deny`;普通非法 JSON/schema 错误降级成非阻塞 `context`;`<cc-haha-goal-hook>` evaluator 的非法输出、超时或模型不可用会阻断并要求继续完成 goal,对齐 CC-Haha `/goal` 防早停策略。
- 参数替换兼容 CC-Haha `addArgumentsToPrompt`:支持 `$ARGUMENTS`、`$ARGUMENTS[0]`、`$0` 和没有占位符时追加 `ARGUMENTS: ...`;当前未引入 shell-quote 依赖,用轻量 quote-aware 解析覆盖 hook JSON 输入场景。
- 口径:这一步补齐 prompt hook executor 的当前 TS 可运行等价层。后续 `/goal` 状态持久化与 stopHooks 继续工作编排已在 3.261 补齐;剩余继续复制/移植/改写:更完整的 hook settings policy。
- 验证:`cd ts && bun test src/hooks/hookConfig.test.ts src/hooks/hooks.test.ts` = 21 pass;`cd ts && bun run typecheck` clean。

## 3.258 2026-07-08 CC-Haha agent hook executor 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/hooks/execAgentHook.ts` 与 `hookHelpers.ts`。关键行为:`type:"agent"` hook 不是单步 LLM 判定,而是启动一个临时 verifier agent,允许它用工具检查代码/历史,最后必须用 `StructuredOutput` 返回 `{ok, reason?}`。
- `ToolContext` 新增当前会话 `registry`,主 `runAgentLoop` 创建上下文时注入;`ts/src/hooks/hookConfig.ts` 的 agent hook executor 现在可从当前工具池派生受限 verifier registry,而不是输出“待移植”占位。
- 新增 hook 内部 `StructuredOutput` 工具:模型调用它时捕获 `{ok, reason?}`;`ok:true` 映射 `allow`, `ok:false` 映射 `deny: Agent hook condition was not met: ...`。没有结构化输出时按 CC-Haha 口径取消,不把普通 final 当成功。
- 工具边界按 CC-Haha verifier 思路收窄:仅允许 `read_file/read_many_files/list_dir/glob_files/grep_files/code_outline/git_status/git_history/LSP/list_project_instructions/project_diagnostics/read_stored_tool_result` 这类只读检查/诊断入口;不暴露写文件、子代理、AskUser、Plan、VerifyPlanExecution、媒体/花钱等工具,避免 hook agent 变成新的执行入口。
- agent hook 复用 `addArgumentsToPrompt` 处理 `$ARGUMENTS`,默认 60s timeout、最多 50 turn;内部 `runAgentLoop` 用 `permissionMode:"plan"` 进一步保证即使误暴露可写工具也会被权限层跳过。
- 测试覆盖:agent hook 用 `StructuredOutput({ok:true})` 放行;`ok:false` 阻断;可先调用允许的 `read_file` 再结构化输出;缺少当前工具 registry 时返回非阻塞 context 且不打模型。
- 口径:这一步补齐 CC-Haha `execAgentHook.ts` 的当前 TS 可运行等价层。后续 HTTP SSRF/DNS guard 已在 3.259 补齐,`/goal` 状态持久化与 stopHooks 继续工作编排已在 3.261 补齐;剩余继续复制/移植/改写:hook settings policy、同 agent id 原地 task slot、agent progress summary/prompt-cache。
- 验证:`cd ts && bun test src/hooks/hookConfig.test.ts src/hooks/hooks.test.ts` = 25 pass;`cd ts && bun run typecheck` clean。

## 3.259 2026-07-08 CC-Haha HTTP hook policy / SSRF guard 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/hooks/execHttpHook.ts`、`ssrfGuard.ts`、`utils/settings/types.ts`。关键行为:HTTP hook 支持全局 `allowedHttpHookUrls` URL pattern allowlist、`httpHookAllowedEnvVars` 与每条 hook `allowedEnvVars` 求交集、header 值清洗 CR/LF/NUL,并用 DNS `lookup` guard 阻断私网/metadata 地址。
- 新增 `ts/src/hooks/ssrfGuard.ts`:按 CC-Haha 地址策略允许 loopback,阻断 `0.0.0.0/8`、`10/8`、`100.64/10`、`169.254/16`、`172.16/12`、`192.168/16`、IPv6 unspecified/ULA/link-local 以及 IPv4-mapped IPv6 私网地址;`ssrfGuardedLookup` 在真实连接 lookup 阶段校验所有解析结果,避免 DNS rebinding 窗口。
- `runHttpHook` 从 `fetch` 改成 `node:http/node:https.request`,把 `ssrfGuardedLookup` 接到请求本身;仍保留 loopback 本地 hook 场景、manual redirect 等价行为、timeout/abort 非阻塞错误口径。
- `normalizeHookRegistry` 新增 registry 级 `httpPolicy`,并支持 hooks JSON 顶层 CC-Haha 同名字段 `allowedHttpHookUrls`、`httpHookAllowedEnvVars`;环境变量 `HTTP_HOOK_ALLOWED_URLS`、`HTTP_HOOK_ALLOWED_ENV_VARS` 作为无配置服务端兜底入口。
- 测试覆盖:SSRF 地址表、blocked IP literal lookup、loopback lookup、URL policy 命中/空数组阻断、hooks JSON 顶层 policy 生效、env allowlist 交集和 header injection 清洗、metadata IP HTTP hook 阻断。
- 口径:这一步补齐 HTTP hook 安全链的当前 TS 可运行等价层。后续 `/goal` 状态持久化与 stopHooks 继续工作编排已在 3.261 补齐;剩余 hooks 方向继续复制/移植/改写:sandbox network proxy/系统代理绕过策略如后续引入代理层再接。
- 验证:`cd ts && bun test src/hooks/ssrfGuard.test.ts src/hooks/hookConfig.test.ts src/hooks/hooks.test.ts` = 32 pass;`cd ts && bun run typecheck` clean。

## 3.260 2026-07-08 CC-Haha Stop hook blocking continuation 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/query/stopHooks.ts`、`src/query.ts`、`src/utils/hooks.ts#getStopHookMessage`。关键行为:Stop/SubagentStop hook 的 blocking error 不是普通告警,而是生成 `Stop hook feedback:\n...` user message 回灌模型,让模型继续完成缺失工作;CC-Haha 用 `stopHookActive` 标记二次进入,避免目标 hook/阻断 hook 语义混乱。
- `ts/src/hooks/hooks.ts` 的 `HookPayload` 新增 `stopHookActive`;`applyStopHooks` 现在把 `deny` 聚合为 `blockingFeedback`,格式对齐 CC-Haha `getStopHookMessage`,不再把 Stop deny 降级成“警告上下文”后直接收尾。
- `ts/src/harness/loop.ts` 三个收尾出口已接续跑:普通 final、UserPromptSubmit deny 后的收敛 final、max-turn forced final。若 Stop hook 返回 blocking feedback,loop 会把反馈包成 system reminder user message 追加到 transcript,标记 `stopHookActive=true`,并继续模型循环;普通 final 场景额外扩一轮上限,避免刚好踩到 maxTurns 时假收尾。
- 测试覆盖:Stop hook deny 回灌 feedback 并触发第二次 `model.step`;第二轮模型输入能看到 `Stop hook feedback`;二次 Stop hook payload 带 `stopHookActive:true`;SubagentStop deny 也变成 `SubagentStop hook feedback`。
- 口径:这一步补齐 Stop hook 阻断续跑的当前 TS 可运行等价层,直接支撑 `/goal` 这类长期目标不会因为 `ok:false` 提前 final。后续 CC-Haha `goals/goalState.ts` 的 `/goal` 命令、transcript anchor 恢复、Goal continuing/Goal marked complete 本地命令输出已在 3.261 补齐。
- 验证:`cd ts && bun test src/hooks/hooks.test.ts src/harness/loop.test.ts src/hooks/hookConfig.test.ts` = 81 pass;`cd ts && bun run typecheck` clean。

## 3.261 2026-07-08 CC-Haha `/goal` 命令与状态恢复迁移

- 对照源:`~/Desktop/cc-haha-ref/src/goals/goalState.ts`、`src/commands/goal/goal.tsx`、`src/query/stopHooks.ts`、`src/server/ws/handler.ts`。关键行为:`/goal <condition>` 是本地命令,先写 `Goal set: ...` transcript anchor,再继续让模型工作;`/goal clear` 和 usage error 只输出本地结果,不调用模型;Stop hook `ok:false` 续跑时写 `Goal continuing: ...`,最终 `ok:true` 写 `Goal marked complete.` 并清理当前目标。
- 新增 `ts/src/goals/goalState.ts`:移植 `parseGoalCommand`、thread-scoped goal map、`<cc-haha-goal-hook>` prompt hook、目标 objective 提取、CC-Haha 两条消息 transcript anchor 恢复,并兼容当前 TS server 把 command-name 与 stdout 放在同一条消息里的紧凑 anchor。
- `ts/src/server/index.ts` 把 `/goal` 作为内建本地 slash command 处理,不再落到普通 workspace/domain command 扩展:写入 `<command-name>/goal</command-name>` 与 `<local-command-stdout>...</local-command-stdout>`;SSE/WS/session replay 仍复用现有 `command_invocation` + `context_note` + `final/done` 事件契约。
- `ts/src/harness/loop.ts` 在 Stop hook 收尾分支写回 CC-Haha 风格 goal 状态 anchor:阻断续跑时追加 `Goal continuing: ...` 并保存 transcript;goal evaluator 放行时追加 `Goal marked complete.`、清掉 in-memory goal,避免下一轮继续被同一目标牵住。写入条件用 goal registry 标记约束,避免普通 Stop hook 被误识别成目标完成。
- 测试覆盖:goal parser/恢复/状态格式;generated hook registry ownership;Stop hook `ok:false -> ok:true` 的 continuation/completion transcript anchor;`POST /agent/run` 的 `/goal set` 继续模型 turn、`/goal clear` 不调模型、usage error 不调模型。
- 验证:`cd ts && bun test src/goals/goalState.test.ts src/harness/loop.test.ts src/server/index.test.ts --timeout 40000` = 130 pass;`cd ts && bun run typecheck` clean。

## 3.262 2026-07-08 CC-Haha 后台子代理进度阶段迁移

- 对照源:`~/Desktop/cc-haha-ref/src/services/AgentSummary/agentSummary.ts`、`src/tasks/LocalAgentTask/LocalAgentTask.tsx`、`src/tools/AgentTool/AgentTool.tsx` 与 `src/tools/AgentTool/agentToolUtils.ts`。关键行为:后台/异步子代理运行时不能只是 task 卡片静止等待,需要把最近活动写入 task progress/summary,让 coding trace 在 UI 上持续可见。
- `startBackgroundAgentRun()` 新增后台 agent progress reporter:把 `thinking/tool_call/tool_progress/tool_result/approval_request/ask_question/final` 归纳成短阶段文案,并更新 `TaskMeta.progress/stage`。前端后台任务抽屉原本已经读取 `task.stage/task.progress`,因此无需新增协议即可显示“调用哪个工具/正在输出什么/是否等待确认”。
- 事件日志仍保留原始 `tool_call/tool_progress/tool_result/final` 流,progress reporter 直接 `touch()` metadata,不额外写 `context_note`,避免后台任务 trace 出现重复噪声。进度值只作为运行态扫描提示,完成仍由 `TaskService.run()` 统一落到 `progress:100`。
- 口径:这一步先迁移 CC-Haha `AgentProgress` 的确定性活动追踪层;`AgentSummary` 那种每 30 秒 fork 一次模型、依赖 prompt-cache safe params 的 LLM 摘要还需等当前 TS fork/cache 参数链补齐后继续复制/移植/改写,避免为了形式相似引入不稳定 summarizer。
- 测试覆盖:后台子代理调用长工具时,任务 metadata 在运行中实时变成工具 progress 阶段,完成后进度到 100,事件日志仍只包含原始 agent events,不会多出重复 `context_note`。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/taskTools.test.ts --timeout 40000` = 15 pass;`cd ts && bun test --timeout 60000` = 651 pass。

## 3.263 2026-07-08 CC-Haha SendUserMessage/Brief 输出通道迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BriefTool/BriefTool.ts`、`prompt.ts`、`attachments.ts`。关键行为:Brief 在 CC-Haha 中不是普通闲聊文案,而是模型明确给用户看的输出通道;主名为 `SendUserMessage`,旧别名为 `Brief`,入参为 `message/attachments/status`,附件需要校验存在且是普通文件。
- 新增 `ts/src/tools/briefTool.ts`:提供 `SendUserMessage` 与 `Brief` 兼容工具,支持 markdown message、`status:"normal"|"proactive"`、workspace/allowed path 内附件解析、附件 size 与图片扩展名识别,返回稳定 `<user_message_delivered>` 结构。路径解析走现有 `Workspace.resolve(...,"read")`,越界附件直接拒绝。
- 通用工具池默认注册 `SendUserMessage/Brief`;`tool_search` 热工具与中文/英文别名加入“给用户发消息/回复用户/用户可见消息/Brief/message user”,让大工具池懒加载时也能发现这条可见输出通道。
- 前端工具文案新增 `SendUserMessage/Brief` 低噪标签“发送用户消息”,避免桌面对话流直接暴露原始工具名;真正专用消息卡/Brief-only 视图仍留后续 UI polish。
- 口径:这一步迁移的是 CC-Haha Brief 的本地工具协议和可运行输出层;不迁入 GrowthBook entitlement、assistant-mode opt-in、private_api 附件上传和 Brief-only 终端 UI。前端目前先走普通工具结果展示,后续可继续做 Work Buddy/Codex 风格的低噪专用消息卡。
- 测试覆盖:SendUserMessage 附件解析/图片识别/结构化输出;Brief legacy alias;缺失 status 与越界附件拒绝;通用 registry 工具清单与 tool_search 意图命中。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tools/briefTool.test.ts src/tools/generalTools.test.ts src/tools/toolSearchTool.test.ts --timeout 40000` = 10 pass;`cd ts && bun test --timeout 60000` = 654 pass;`cd web && pnpm exec vitest run src/lib/agent-tools.test.ts` = 2 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.264 2026-07-08 CC-Haha agent memory / snapshot 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/agentMemory.ts`、`agentMemorySnapshot.ts`、`loadAgentsDir.ts`、`src/memdir/memdir.ts`。关键行为:agent frontmatter 的 `memory` 是 `user/project/local` scope,会给子代理追加 Persistent Agent Memory system prompt,创建/读取对应记忆目录,并在 restricted `tools` 配置下自动补 Read/Write/Edit;`user` scope 还会从项目 `.claude/agent-memory-snapshots/<agent>/snapshot.json` 初始化本地/用户记忆。
- 新增 `ts/src/agents/agentMemory.ts`:实现 `AgentMemoryScope`、`parseAgentMemoryScope()`、三种记忆目录、`MEMORY.md` 截断加载、snapshot 初始化/替换元数据、`workspaceWithAgentMemory()`。`memory:true` 作为本仓库旧格式兼容映射到 `user`,新 agent 文件按 CC-Haha 口径推荐写 `memory:user|project|local`。
- `ts/src/agents/agentLoader.ts` 把 `AgentDefinition.memory` 从 boolean 升级为 scope;加载 `.md` agent 时解析 CC-Haha memory 字段,如果 agent 工具白名单存在则自动注入 `read_file/write_file/edit_file`;`resolveAgentTools()` 也加了一层兜底,避免手写 AgentDefinition 时 memory agent 被白名单漏掉记忆工具。
- `agent_task` 与 `start_background_agent_task` 现在都会在运行前构建 agent memory prompt,把 `MEMORY.md` 内容放入 `<subagent>`/`<background_subagent>` 系统提示之后;同时通过 `Workspace.withAllowedPaths()` 把记忆目录加入子代理 workspace allowlist,使 `user` scope 这种工作区外路径也能安全读写,不只是“看见但写不进去”。
- `Workspace` 新增 `withAllowedPaths()` 保留原 selected files/full disk/backup hook,再追加 agent memory 路径;这是对齐 CC-Haha filesystem carve-out 的当前 TS 可运行等价层。
- 口径:这一步完成 CC-Haha agent memory 主链和 snapshot 初始化的可运行迁移。暂未复制 GrowthBook/analytics/Kairos/team memory/更新快照交互弹窗;`prompt-update` 目前只检测到有更新而不打断用户弹选择,后续如果做 agent 管理 UI 再接。AgentTool/LocalAgentTask 仍需继续复制/移植/改写同 `agent_id` 原地 task slot、content replacement full restore、forked progress summary/prompt-cache、UDS/remote teammate bridge。
- 测试覆盖:frontmatter `memory:user/project` 与旧 `memory:true` 兼容;restricted tools 自动补记忆读写工具;同步 `agent_task` 加载 user memory prompt 且能写入工作区外 user memory 目录;后台 agent 从 project snapshot 初始化 user memory 并注入系统提示;workspace allowlist 追加不丢已有授权。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/agents/agentLoader.test.ts src/agents/agentTool.test.ts src/tasks/taskTools.test.ts src/workspace/workspace.test.ts --timeout 40000` = 38 pass。

## 3.265 2026-07-08 CC-Haha background agent resume content replacement 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/resumeAgent.ts`、`src/utils/toolResultStorage.ts#reconstructForSubagentResume`、`src/utils/sessionStorage.ts#recordSidechainTranscript`。关键行为:后台/异步子代理被 `SendMessage` 续跑时,不能只 replay 旧 messages;还要恢复 sidechain 的 content replacement records,否则旧的大 tool_result 可能在新上下文里恢复成原始巨量内容,破坏 prompt-cache 稳定性并挤爆上下文。
- `ts/src/memory/transcript.ts` 新增 `seedContentReplacementRecords()`:允许在创建续跑 task 时把旧 `.content-replacements.jsonl` 记录原样种到新 task transcript sidecar,保持 replacement 字符串字节级一致。
- `resumeBackgroundAgentTask()` 现在同时读取旧 transcript messages 与旧 content replacement records;`startBackgroundAgentRun()` 新增可选 `initialContentReplacementRecords`,在 `tasks.start()` 前写入新 task sidecar,避免后台 runner 先加载 transcript 后 seed records 的竞态。
- 运行效果:新后台 task 的 `runAgentLoop()` 启动时会从新 sidecar 加载 inherited replacements,`reconstructContentReplacementState()` 能按旧决策把 replay 的 tool_result 重新替换为 `<stored_tool_result ...>` 预览,而不是把原始大结果喂回模型。
- 口径:这一步补齐的是 CC-Haha resume replacement-state 持久恢复线;当前 TS 仍保留“每次 resume 创建新 task、稳定 `agent_id` 指向旧身份”的模型。真正完全同 `agentId` 原地复用同一 task slot、fork parent live replacements gap-fill、UI panel retain/disk bootstrap 仍需继续复制/移植/改写。
- 测试覆盖:`SendMessage resume inherits content replacement records before replaying transcript` 构造旧 task 原始大结果 + sidecar replacement,续跑首轮断言模型只看到 `<stored_tool_result>` 预览而不是 raw 大内容,并断言新 task sidecar 继承旧 records;既有 inherited stored result access 继续覆盖旧 tool-result store 可读。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/teamTools.test.ts src/tasks/taskTools.test.ts --timeout 40000` = 30 pass。

## 3.266 2026-07-08 CC-Haha TaskCreate/TaskList/TaskGet/TaskUpdate 工具名兼容迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/TaskCreateTool/constants.ts`、`TaskListTool/constants.ts`、`TaskGetTool/constants.ts`、`TaskUpdateTool/constants.ts` 与四个 `Task*Tool.ts`。关键事实:CC-Haha 的结构化任务工具真实名称是 `TaskCreate/TaskList/TaskGet/TaskUpdate`,不是本仓库早先落地的 `task_create/task_list/task_get/task_update`。
- `ts/src/tasks/taskListTools.ts` 现在同时注册 lowercase 与 PascalCase 两套入口;PascalCase 是同一工具对象的 CC-Haha 兼容 alias,共享同一个 `TaskListService`、同一个 conversation/workspace scope、同一套 `taskId/task_id` 与 `activeForm/active_form` 兼容逻辑。口径:这类 CC-Haha 工具名可以直接抄/直接移植,但实现必须接到当前 TS runtime 的 registry、workspace 与持久化层。
- `runAgentLoop()` 把 `TaskCreate/TaskUpdate` 与 `task_create/task_update` 一样视为进度更新工具,执行后立即发 `todo_update`;这保证模型按 CC-Haha prompt 习惯调用 PascalCase 工具时,前端中间/右侧的结构化任务进度仍能实时刷新。
- `tool_search` 热工具与别名补齐 PascalCase 任务工具,大工具集懒加载时能通过“创建结构化任务/查看任务列表/读取任务详情/完成任务状态”等中文意图召回 CC-Haha 同名工具。
- 前端共享工具元数据新增 `task_*` 与 `Task*` 文案,桌面对话流显示“创建任务/查看任务列表/查看任务详情/更新任务”,避免 coding trace 中裸露不友好的英文内部工具名。
- 测试覆盖:PascalCase alias 可创建/列出/更新同一任务列表,lowercase 可读取 alias 写入的状态;`TaskCreate/TaskUpdate` 在 agent loop 中发出两次 `todo_update`;`tool_search` 可召回四个 PascalCase 任务工具;前端 `toolActionText` 渲染两套任务工具名。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/taskListTools.test.ts src/harness/loop.test.ts src/tools/toolSearchTool.test.ts --timeout 40000` = 61 pass;`cd ts && bun test --timeout 60000` = 661 pass;`cd web && pnpm exec vitest run src/lib/agent-tools.test.ts` = 2 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.267 2026-07-08 CC-Haha background agent 原任务槽续跑迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tasks/LocalAgentTask/LocalAgentTask.tsx` 与 `src/utils/task/framework.ts`。关键行为:CC-Haha 的 `resumeAgentBackground` 不是每次生成一个全新的 panel task,而是用同一个 `agentId/taskId` 重新注册任务状态;`registerTask()` 发现同 id 已存在时会保留 panel UI state,把新运行替换进原槽。
- `startBackgroundAgentRun()` 新增内部 `replaceTaskId` 入口,`SendMessage` 续跑已停止/已完成后台 agent 时复用当前解析到的 task id;`TaskService.start()` 原本已支持同 id 在 settled 后再次启动,因此事件日志继续追加、transcript baseline 继续保护历史、tool-result store 仍沿用稳定 agent 目录。
- `resumeBackgroundAgentTask()` 不再在 task params 中制造 `resumed_from: previousTask.id` 自环;调用返回体仍保留 `resumed_from` 给 `SendMessage` 用户态协议说明“这是续跑”,但后台任务本体现在就是同一个槽位。旧历史 resume-chain 仍由 `resolveBackgroundAgentTarget()` 兼容解析到最新 leaf,不会破坏既有数据。
- 运行效果:后台 agent 首次完成后,用户再 `SendMessage` 给同一 agent/name/stable agent id,前端任务列表不再出现一个新后台任务卡;同一个 task id 会回到 running,完成后 result/stage/metadata 更新为最新回合。`TaskOutput/read_background_task` 读取同 id 可看到追加事件和最新 final。
- 测试覆盖:worktree 隔离续跑仍在原 worktree 读写;普通 stopped agent、旧 task id、stable agent id、metadata sidecar 恢复、orphan metadata 恢复、stored tool result 继承、content replacement 继承全部在同一 task id 上完成;TaskService 旧 resume-chain 解析测试保留,保障历史兼容。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/taskTools.test.ts src/tasks/teamTools.test.ts src/tasks/taskService.test.ts --timeout 40000` = 38 pass。

## 3.268 2026-07-08 CC-Haha AgentOutputTool/BashOutputTool 旧名兼容迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/TaskOutputTool/TaskOutputTool.tsx`。关键行为:CC-Haha 的 `TaskOutputTool` 除主名 `TaskOutput` 外,还声明旧名 alias `AgentOutputTool`、`BashOutputTool`;历史 prompt 或模型记忆可能仍按旧名读取后台代理/命令输出。
- `createTaskTools()` 现在注册 `AgentOutputTool` 与 `BashOutputTool` 两个浅 alias,共享 `TaskOutput` 的执行逻辑、schema、只读属性和 task id 解析层;因此旧名同样支持 `block/timeout/limit`、稳定 agent id、旧 task id 到最新/原槽任务的解析。
- `tool_search` 热工具与中英文别名补齐两个旧名,可通过“读取代理输出/读取命令输出/agent output/bash output”召回;大工具集懒加载时不会因为只暴露 `TaskOutput` 而漏掉旧 prompt 习惯。
- 前端工具文案新增 `AgentOutputTool`/`BashOutputTool`,桌面 trace 低噪显示“读取代理输出/读取命令输出”,不裸露旧内部工具名。
- 测试覆盖:`AgentOutputTool` 与 `BashOutputTool` 读取同一后台任务输出,其中 `AgentOutputTool` 与 `TaskOutput` 字节级一致;`tool_search` 能按中文意图召回旧名;前端 `toolActionText` 渲染旧名。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/taskTools.test.ts src/tools/toolSearchTool.test.ts --timeout 40000` = 21 pass;`cd web && pnpm exec vitest run src/lib/agent-tools.test.ts` = 2 pass;`cd web && pnpm exec tsc --noEmit` clean。

## 3.269 2026-07-08 CC-Haha content replacement parent gap-fill 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/Tool.ts`、`src/utils/forkedAgent.ts#createSubagentContext`、`src/utils/toolResultStorage.ts#reconstructForSubagentResume` 与 `src/tools/AgentTool/resumeAgent.ts`。关键行为:content replacement state 是 `ToolUseContext` 的线程态;fork/子代理默认 clone 父状态,后台续跑则用 sidechain records 加父线程 live replacements 做 gap-fill。
- `ToolContext` 新增 `contentReplacementState`;`runAgentLoop()` 创建/重建 replacement state 后挂入上下文,并支持调用方显式传入状态。这样主循环、同步 `agent_task`、后台 agent 与 hooks/工具共享同一轮的上下文裁剪决策,不再只靠 transcript sidecar 间接恢复。
- 同步 `agent_task` 启动时 clone 父 replacement state,并传入子代理 loop;后台 `startBackgroundAgentRun()` 普通启动同样 clone 父状态,`SendMessage` 续跑则用 `reconstructContentReplacementState(initialMessages, initialRecords, parentState.replacements)` 重建,补齐 CC-Haha 注释里的 fork parent live replacements gap-fill。
- 运行效果:如果 fork/后台子代理原始 sidechain 没有记录父级 inherited replacement,但父会话当前 state 仍知道某个 `tool_use_id -> <stored_tool_result>` 映射,续跑 replay 历史 transcript 时会继续把原始大 `tool_result` 替换成同一预览,避免把巨量内容重新塞回模型上下文和破坏 prompt-cache prefix。
- 测试覆盖:新增 `SendMessage resume gap-fills parent content replacement state when sidecar records are missing`,构造旧 transcript 只有原始大结果、无 sidecar record,但父 `contentReplacementState.replacements` 有同 id replacement;续跑首轮断言模型只看到 `<stored_tool_result>` 预览、不看到 raw 大内容,且不会伪造新的 sidecar record。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/context/toolResultStorage.test.ts src/harness/loop.test.ts src/tasks/teamTools.test.ts src/tasks/taskTools.test.ts --timeout 50000` = 94 pass。

## 3.270 2026-07-08 CC-Haha AgentSummary 后台进度摘要迁移

- 对照源:`~/Desktop/cc-haha-ref/src/services/AgentSummary/agentSummary.ts`、`src/tools/AgentTool/agentToolUtils.ts#runAsyncAgentLifecycle`、`src/tools/AgentTool/runAgent.ts#onCacheSafeParams` 与 `src/tasks/LocalAgentTask/LocalAgentTask.tsx#updateAgentSummary`。关键行为:后台 agent 运行时除 deterministic `stage/progress` 外,还要周期性 fork 当前 agent 上下文,用同一套 system/tools/messages prefix 生成 3-5 词的进行中摘要,写回 task progress summary。
- 新增 `ts/src/tasks/agentSummary.ts`:提供 `startAgentSummarization()` 定时器,每次从 `runAgentLoop` 暴露的 snapshot 读取 system/messages/tools,追加 CC-Haha 同口径 summary prompt,调用同一 `Model.step()` 生成短摘要;摘要请求保留工具 schema 以维持 cache-safe 前缀,但 prompt 明确 `Do not use tools`,若模型仍返回 tool_calls 则不写 summary。
- `runAgentLoop()` 新增 `onSummarySnapshot` 回调,在每次真实 model.step 前吐出当前 system、messages 和 `visibleToolSpecs()` 结果;后台 agent runner 把该 snapshot 交给 summarizer,避免从 transcript 异步重读导致时序滞后,也为后续更完整的 fork/cache 参数链保留稳定入口。
- `TaskMeta` 新增持久化 `summary`;`TaskService.touch()`/index 校验/API JSON 都保留该字段。`list_background_tasks` 与 `read_background_task` 会把 summary/stage 返给模型;前端后台任务面板在运行中优先展示 `task.summary`,完成后仍展示最终 result/error。
- 口径:这一步迁移 CC-Haha AgentSummary 的可运行核心:周期 summary、cache-safe system/tools/messages snapshot、任务元数据保留和 UI 展示。尚未复制 SDK-only progress event gate、Perfetto/prompt-cache break telemetry、真正独立 `runForkedAgent()` 工具拒绝 callback;下一步继续复制/移植/改写 UDS/remote teammate bridge 与更深 fork worker。
- 测试覆盖:后台 agent 首轮工具完成、第二轮模型调用挂起时,1ms summary tick 写回 `TaskMeta.summary`;断言 summary 请求 system 与 tools 等于主 agent 第二次请求,末尾 prompt 含 `Do not use tools`;`read_background_task` 输出 `<summary>`;TaskService 跨实例持久化 summary/stage。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/taskService.test.ts src/tasks/taskTools.test.ts --timeout 50000` = 27 pass。

## 3.271 2026-07-08 CC-Haha ListPeers 队友发现元数据迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/SendMessageTool/SendMessageTool.ts`、`prompt.ts`、`src/utils/swarm/teamHelpers.ts`、`src/utils/teammateMailbox.ts` 与 `src/utils/peerAddress.ts`。公开参考树里的 `ListPeersTool` 本身是 feature-gated stub,所以本轮按 `SendMessage` 的真实路由需求反推队友发现输出:模型必须知道可投递目标、team lead、session/worktree/backend、未读 inbox 与当前跨 session 能力边界。
- `TeamService.listPeers()` 从薄列表升级为 `PeerListInfo`:返回 `teamFilePath/leadAgentId/leadSessionId/description/createdAt/isActiveTeam`,每个 peer 保留 `agentId/name/agentType/color/cwd/worktreePath/sessionId/tmuxPaneId/backendType/isLead/isActive/unreadMessages/subscriptions/joinedAt/mode`。这些字段对应 CC-Haha team file 里的真实成员状态,后续 UDS/bridge 或前端队友/专家面板可以直接复用。
- `ListPeers` 工具输出保留旧的人类可读 `- name (agentId)` 行,新增 `<peer ... />` 结构化 XML 属性和可解析 `<peers_json>` 块。`<peers_json>` 里包含 `send_message.local_targets`、`broadcast_target:"*"` 与 `cross_session_targets_enabled:false`,明确当前 runtime 只完成本地 team/mailbox 与 background-agent 路由,不会误导模型用尚未接通的 `uds:`/`bridge:`。
- `include_inbox` 支持原 snake_case 和 `includeInbox` 驼峰别名;开启后按 peer 输出 `<inbox peer="..." unread_messages="...">` 并复用 CC-Haha `<teammate-message>` 包壳,保证未读消息内容与后续自动注入 inbox context 的格式一致。
- 口径:这一步迁移的是队友发现/路由元数据层,不是完整跨 session peer registry。UDS socket 发现、Remote Control bridge session 枚举、跨机权限确认、`SendMessage` 对 `uds:`/`bridge:` 的真实投递仍需继续复制/移植/改写,但工具输出协议已经给下一步留好字段。
- 测试覆盖:`ListPeers exposes structured peer metadata and inbox previews` 锁住 lead session、backend、session/worktree、mode、subscriptions、inbox preview 与 `<peers_json>`;`ListPeers returns a parseable empty peer set without an active team` 保证没有 active team 时仍返回可解析空集合,避免模型误判工具失败。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/teamTools.test.ts --timeout 40000` = 17 pass。

## 3.272 2026-07-08 CC-Haha UDS SendMessage 出站投递迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/SendMessageTool/SendMessageTool.ts` 与 `src/utils/peerAddress.ts`。公开参考树里的 `udsClient.ts` / `udsMessaging.ts` 是 generated stub,但 `SendMessageTool` 的真实分支仍给出可观察行为:plain string 可发 `uds:<socket-path>` 或旧式裸 socket path,不要求 `summary`;结构化消息不能跨 session;`bridge:<session-id>` 需要 Remote Control handle 和显式权限。
- 新增 `ts/src/tasks/peerAddress.ts`:移植 `parseAddress` 语义为 `parsePeerAddress()`,识别 `uds:`、`bridge:`、旧式绝对 socket path 和普通 teammate name。这样 `SendMessage` 不再把 `uds:/tmp/x.sock` 误判成包含 `@` 的非法 teammate 名,也为后续 ListPeers peer registry/接收端复用同一地址解析层。
- 新增 `ts/src/tasks/udsClient.ts`:用 `node:net.createConnection()` 实现 `sendToUdsSocket(socketPath,message)`,带 5s timeout 和明确空 target 校验。`SendMessage` 在 plain string + UDS target 时直接投递本机 Unix socket,返回 `routing.sender/target/summary/content`;UDS 路径不写本地 mailbox,对齐 CC-Haha “跨 session 消息 enqueue 到对端”的方向。
- `SendMessage` 行为同步:plain UDS 不再要求 summary;`bridge:` 仍返回 “Remote Control is not connected” 明确错误,不伪装成功;`uds:` 的结构化 `shutdown_request/plan_approval_response` 等直接拒绝为 `structured messages cannot be sent cross-session - only plain text`。`ListPeers` 的 `<peers_json>.send_message` 同步改成 `cross_session_targets_enabled:true / uds_targets_enabled:true / bridge_targets_enabled:false`,让模型知道当前可用的是本机 UDS 出站,不是 remote bridge。
- 口径:这一步完成 UDS 出站投递客户端,不是完整 UDS inbox server/peer discovery。后续仍需继续复制/移植/改写:默认 socket path、接收端 `<cross-session-message from="...">` 注入、`/peers`/ListPeers socket 发现、Remote Control bridge session 枚举、bridge 权限确认与真实投递。
- 测试覆盖:`SendMessage sends plain text to UDS cross-session peers without summary` 用真实 Unix socket 断言收到消息且没有 mailbox fallback;`SendMessage accepts legacy bare UDS socket paths and rejects cross-session structured messages` 锁住旧地址兼容、结构化跨 session 拒绝和 bridge 未连接错误;`peerAddress.test.ts` 锁住地址解析。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/teamTools.test.ts src/tasks/peerAddress.test.ts --timeout 40000` = 20 pass。

## 3.273 2026-07-08 CC-Haha UDS inbox 接收注入迁移

- 对照源:`~/Desktop/cc-haha-ref/src/setup.ts`、`src/tools/SendMessageTool/prompt.ts`、`src/constants/xml.ts` 与 `src/utils/peerAddress.ts`。关键行为:UDS peer 发来的 plain text 不能变成无来源普通用户话,而应作为 `<cross-session-message from="...">` 注入,让模型可复制 `from` 地址回复。
- 新增 `ts/src/tasks/crossSessionMessages.ts`:定义 `CROSS_SESSION_MESSAGE_TAG` 和 `formatCrossSessionMessage(from,message)`,统一 XML 转义和包壳,输出 `<cross-session-message from="uds:/path.sock">...</cross-session-message>`。
- 新增 `ts/src/tasks/udsInbox.ts`:实现 `startUdsInbox({socketPath,inbox})`,用 `node:net.createServer()` 监听本机 Unix socket,收到完整文本后推入当前会话 `steerInbox`。启动前会创建目录并清理同名旧 socket,关闭时会 close server 并删除 socket,避免陈旧 socket 干扰下一轮。
- `/agent/run` 支持 `messagingSocketPath` / `messaging_socket_path` / `udsMessagingSocketPath` / `uds_messaging_socket_path`,并兼容 `CLAUDE_CODE_MESSAGING_SOCKET` 环境变量。turn 生命周期内自动启动 UDS inbox,收到消息后走现有 steering 安全点进入 `runAgentLoop`;turn 结束后关闭并删除 socket。启动失败只发 `context_note` warning,不让主 turn 崩掉。
- 运行效果:外部本机会话可 `SendMessage({to:"uds:/path.sock", message:"..."})` 投递到当前 `/agent/run`;当前模型若正要收尾,会被 steering 打断并在下一轮看到 `[用户补充/纠偏] <cross-session-message from="uds:/path.sock">...`。这补上了 UDS “发出去”后的接收半边,但仍不是完整 peer registry。
- 口径:本轮完成 UDS inbox 接收和模型上下文注入,仍需继续复制/移植/改写:默认 socket path 生成/展示、`/peers`/ListPeers 本机 socket 发现、跨进程生命周期注册、Remote Control bridge session 枚举、bridge 权限确认与真实投递。
- 测试覆盖:`udsInbox.test.ts` 用真实 socket 断言消息进入 inbox;`loop.test.ts` 断言 `<cross-session-message>` 包壳保留到下一轮模型 messages;`server/index.test.ts` 用 `/agent/run + messagingSocketPath + sendToUdsSocket()` 跑完整 SSE 生命周期,断言出现 steering、最终完成且 socket 被清理。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/udsInbox.test.ts src/tasks/crossSessionMessages.test.ts src/harness/loop.test.ts src/server/index.test.ts --timeout 60000` = 129 pass。

## 3.274 2026-07-08 CC-Haha UDS peer discovery / ListPeers socket 展示迁移

- 对照源:`~/Desktop/cc-haha-ref/src/setup.ts`、`src/main.tsx` 的 `--messaging-socket-path` / 默认 socket 生命周期、`src/tools/SendMessageTool/prompt.ts` 与 `src/utils/peerAddress.ts`。公开参考树里的 `udsMessaging.ts` / `/commands/peers` 是 generated stub,但调用点已明确目标:默认 inbox 是被动可投递 peer,显式 socket path 才改变 stream-json replay 行为,模型需要能从 peers 输出拿到 `uds:/...sock` 地址。
- 新增 `ts/src/tasks/udsPeerRegistry.ts`:在 `.agent-state/uds-peers/peers.json` 维护活跃 UDS peer,记录 `id/socketPath/target/conversationId/workspaceRoot/pid/explicit/source/registeredAt/updatedAt`;写入使用 lock dir,避免多个本机会话同时注册互相覆盖;`list()` 会 stat socket 并自动修剪失效 peer,不把死 socket 暴露给模型。
- `/agent/run` 现在即使没有传 `messagingSocketPath` 也会生成短默认 socket path,启动 `startUdsInbox()` 并注册到 `UdsPeerRegistry`;传入显式 `messagingSocketPath` / 环境变量时仍沿用该路径并标记 `explicit:true`。turn 结束时先 unregister,再关闭并删除 socket,保持默认 inbox 的被动生命周期。
- `ListPeers` 接入 UDS registry:XML `<peers>` 新增 `local_peer_count/uds_peer_count`,每个 UDS peer 输出 `<peer backend_type="uds" target="uds:/path.sock" socket_path="..." ... />`;`<peers_json>` 新增 `uds_peers`、`send_message.uds_targets`、`send_message.all_targets`。这样模型可先 `ListPeers`,再用 `SendMessage({to:"uds:/path.sock",message:"..."})` 真实投递到另一个本机会话。
- 口径:这一步补齐 UDS peer discovery/ListPeers socket 展示的可运行等价层。尚未迁移 Remote Control bridge session 枚举、bridge 权限确认与真实远端投递;默认 socket 的跨进程发现已落,但完整 `/peers` slash command UI 仍可继续做前端/命令层封装。
- 测试覆盖:`udsPeerRegistry.test.ts` 用真实 socket 断言注册、可投递、关闭后自动修剪;`teamTools.test.ts` 断言空 team 也能列出 UDS peer 的 XML/JSON/targets;`server/index.test.ts` 让模型在 `/agent/run` 中调用 `ListPeers`,断言默认 UDS inbox 出现在 SSE tool_result 且 turn 结束后 registry 被清理。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/udsPeerRegistry.test.ts src/tasks/teamTools.test.ts src/server/index.test.ts --timeout 60000` = 95 pass。

## 3.275 2026-07-08 CC-Haha Remote Control bridge peer registry / SendMessage 安全骨架迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/SendMessageTool/SendMessageTool.ts`、`prompt.ts`、`src/bridge/bridgeMessaging.ts`、`src/bridge/replBridgeHandle.ts`、`src/remote/RemoteSessionManager.ts` 与 `src/bridge/types.ts`。关键行为:`bridge:session_id` 是 Remote Control 跨机器 peer,必须通过 `ListPeers` 发现;只能发 plain text;发送前需要显式用户同意;bridge handle/active 状态掉线时返回失败,不能假成功。
- 新增 `ts/src/tasks/bridgePeerRegistry.ts`:在 `.agent-state/bridge-peers/peers.json` 维护已知 Remote Control peer,记录 `sessionId/target/label/workspaceRoot/machineName/status/inboundEnabled/lastError/registeredAt/updatedAt`;写入同样使用 lock dir。这个 registry 是后续真实 Remote Control worker / WebSocket transport 的落点,先把发现协议和状态面稳定下来。
- `ListPeers` 接入 bridge registry:XML `<peers>` 新增 `bridge_peer_count`,每个 bridge peer 输出 `<peer backend_type="bridge" target="bridge:session_id" status="..." inbound_enabled="..." ... />`;`<peers_json>` 新增 `bridge_peers`、`send_message.bridge_targets`、`send_message.all_targets`,并且只有存在 `status:"connected" && inboundEnabled:true` 的 peer 时 `bridge_targets_enabled` 才为 true。
- `SendMessage` 的 `bridge:` plain text 路径迁移 CC-Haha 安全语义:工具权限层对 bridge target 设置 `requiresApprovalFor + approvalClass:"outreach" + forceConfirmFor`,因此 full/bypass 自动档也必须弹确认;执行层查 registry,未发现 peer 返回 `success:false` + “Remote Control is not connected”,outbound-only/断线状态返回结构化失败;只有注入了真实 `sendBridgeMessage` transport 且 peer connected 时才返回成功。
- `/api/v1/agent/bridge/peers` 新增本地管理接口:GET 列出 bridge peers,POST 注册/更新 peer,`PATCH /api/v1/agent/bridge/peers/:sessionId` 更新状态,DELETE 删除。前端或后续 Remote Control sidecar 可先写入这个 registry,模型主 loop 与直接 execute 工具都会读同一份状态。
- 口径:这一步完成 Remote Control bridge 的发现/权限/状态骨架,不是完整 CCR/Claude WebSocket 远端投递。真实 `SessionsWebSocket`、HTTP session event POST、permission request/response 转发、inbound attachment 解析、bridge reconnect/heartbeat/worker spawn 仍需继续复制/移植/改写。
- 测试覆盖:`bridgePeerRegistry.test.ts` 覆盖持久化、状态更新、删除和 session id 校验;`teamTools.test.ts` 覆盖 bridge peer 出现在 XML/JSON/targets、plain bridge send 经 fake transport 成功、未连接/出站-only 结构化失败、bridge target 在 full 模式仍 ask;`server/index.test.ts` 覆盖 bridge peer API 以及 `/agent/run` 中模型调用 `ListPeers` 能看到 bridge target。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/bridgePeerRegistry.test.ts src/tasks/teamTools.test.ts src/server/index.test.ts --timeout 60000` = 100 pass。

## 3.276 2026-07-08 CC-Haha Remote Control event / permission outbox 状态面迁移

- 对照源:`~/Desktop/cc-haha-ref/src/remote/RemoteSessionManager.ts`、`src/remote/SessionsWebSocket.ts`、`src/remote/remotePermissionBridge.ts`、`src/remote/sdkMessageAdapter.ts`、`src/bridge/remoteBridgeCore.ts`、`src/bridge/bridgeMessaging.ts`、`src/bridge/bridgePermissionCallbacks.ts`、`src/bridge/types.ts` 与 `src/entrypoints/sdk/controlSchemas.ts`。关键行为:WebSocket 收到 SDK/control 消息;`control_request.can_use_tool` 进入待确认;`control_cancel_request` 取消待确认;用户 allow/deny 后生成 `control_response` 事件,由 transport 发回远端。
- 新增 `ts/src/tasks/bridgeRemoteState.ts`:在 `.agent-state/bridge-remote/state.json` 持久化 Remote Control 事件流、pending permission requests 和 control_response outbox。事件记录 `seq/sessionId/kind/type/payload/receivedAt`;权限记录 `requestId/toolName/toolUseId/input/permissionSuggestions/blockedPath/decisionReason/title/displayName/agentId/description/status/response`;outbox 记录 queued/sent,避免前端点了允许但 transport 是否已发出不可追踪。
- `/api/v1/agent/bridge/sessions/:sessionId/events` 新增 GET/POST:POST 可接收真实 WebSocket/sidecar 转来的 SDK/control payload;GET 支持 `after/limit` 拉取远端事件。`control_request.can_use_tool` 会自动创建 pending permission;`control_cancel_request` 会把对应 pending 标为 `cancelled`。
- `/api/v1/agent/bridge/sessions/:sessionId/permissions` 新增 GET,支持 `status=pending|allowed|denied|cancelled`;`POST /permissions/:requestId/respond` 写入 allow/deny 结果并生成 `control_response` outbox payload,字段按 CC-Haha/SDK 协议保留 `{type:"control_response", response:{subtype:"success", request_id, response:{behavior,...}}}`。
- `/api/v1/agent/bridge/sessions/:sessionId/outbox` 新增 GET,支持 `status=queued|sent`;`POST /outbox/:outboxId/sent` 让后续真实 transport 在 HTTP/WebSocket 投递成功后确认。这样 Remote Control transport 可以可靠做 queued -> sent,不会把 queued 状态伪装成 delivered。
- 口径:这一步补齐真实 Remote Control transport 必需的内核状态面和前端审批面,仍不是完整 CCR/Claude WebSocket 连接。下一步继续复制/移植/改写 `SessionsWebSocket` 订阅、HTTP session event POST、OAuth/bridge credentials、401 recovery、heartbeat/reconnect、permission response 真投递和 inbound attachment 解析。
- 测试覆盖:`bridgeRemoteState.test.ts` 覆盖 SDK 事件持久化、`can_use_tool` pending、allow response outbox、queued -> sent、cancel request、非法 id/payload 校验;`server/index.test.ts` 覆盖 `/events` -> pending permission -> `/respond` -> queued outbox -> sent 的完整本地 API 链路。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/bridgeRemoteState.test.ts src/tasks/teamTools.test.ts src/tasks/bridgePeerRegistry.test.ts src/server/index.test.ts --timeout 60000` focused clean。

## 3.277 2026-07-08 CC-Haha Remote Control Sessions API transport 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/teleport/api.ts` 的 `sendEventToRemoteSession()`、`src/bridge/bridgeApi.ts` 的 `sendPermissionResponseEvent()`、`src/bridge/codeSessionApi.ts` 的 `/bridge` credentials 响应类型、`src/bridge/remoteBridgeCore.ts` 的 worker_jwt / control_response 投递语义。关键行为:Remote Control user message 和 permission response 都走 `POST /v1/sessions/:sessionId/events` 且 body 为 `{events:[...]}`;user message event 含 `uuid/session_id/type:"user"/parent_tool_use_id:null/message:{role:"user",content}`;permission response event 保留 `control_response` payload。
- 新增 `ts/src/tasks/bridgeRemoteTransport.ts`:实现可注入 fetch 的 Sessions API transport,支持 `sendUserMessage()` 和 `sendOutboxItem()`。默认 header 对齐 CC-Haha OAuth 路径:`Authorization: Bearer ...`、`Content-Type: application/json`、`anthropic-version: 2023-06-01`、`anthropic-beta: ccr-byoc-2025-07-29`、可选 `x-organization-uuid`;同时允许 `betaHeader:""` 给 worker/JWT 风格投递关掉 beta header。base URL 安全限制为 HTTPS 或 localhost HTTP,避免误把 token 发到明文远端。
- `SendMessage bridge:` 真投递接线:server 在 `/agent/run` 与 `/api/v1/agent/execute` 的 `createTeamTools()` 中从 `bridge_remote` 请求体或 `BRIDGE_REMOTE_BASE_URL/BRIDGE_REMOTE_TOKEN/BRIDGE_REMOTE_ORG_UUID` 等环境变量解析 transport,注入 `sendBridgeMessage`。因此审批通过后的 `SendMessage({to:"bridge:session_id",message:"..."})` 会真实 POST 到远端 Session Events API;若未配置 transport,仍按上一轮安全语义返回 “transport is not connected”。
- permission outbox 真投递接线:新增 `POST /api/v1/agent/bridge/sessions/:sessionId/outbox/flush`,读取 queued outbox,用同一个 transport POST `control_response` event,成功后自动 `markOutboxSent`;失败保留 queued 并返回逐项错误,方便重试,不把 queued 伪装成 delivered。
- 安全口径:主 loop 里的 bridge SendMessage 仍然 `forceConfirm`,即使 `permissionMode:"bypassPermissions"` 也只发 `approval_request`,不会静默跨机器发送。真实发送由前端/调用方带 approval token 走 `/api/v1/agent/execute` 后触发,这点与 CC-Haha 的 cross-machine consent 语义一致。
- 口径:这一步把 Remote Control 的 HTTP event 投递半边打通,仍不是完整 CCR/Claude WebSocket worker。下一步继续复制/移植/改写 `SessionsWebSocket` 订阅、`/v1/code/sessions/:id/bridge` OAuth -> worker_jwt credential 交换、401 recovery、heartbeat/reconnect、inbound attachment 解析、SDK message -> 前端流式渲染。
- 测试覆盖:`bridgeRemoteTransport.test.ts` 覆盖 user event POST body/header、control_response outbox POST、远端 4xx/不安全 base URL 失败、env 配置解析;`server/index.test.ts` 覆盖 `/api/v1/agent/execute` 审批后 bridge SendMessage 真 POST、`/outbox/flush` 真 POST 并标记 sent、`/agent/run` 在 bridge target 上仍弹审批且不绕过 forceConfirm。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/bridgeRemoteTransport.test.ts src/tasks/bridgeRemoteState.test.ts src/tasks/teamTools.test.ts src/tasks/bridgePeerRegistry.test.ts src/server/index.test.ts --timeout 60000` focused clean。

## 3.278 2026-07-08 CC-Haha SessionsWebSocket 订阅 / RemoteSessionManager 接收半边迁移

- 对照源:`~/Desktop/cc-haha-ref/src/remote/SessionsWebSocket.ts` 与 `src/remote/RemoteSessionManager.ts`。关键行为:连接 `wss://.../v1/sessions/ws/:sessionId/subscribe?organization_uuid=...`;用 `Authorization: Bearer ...` 与 `anthropic-version: 2023-06-01` 鉴权;收到任何带 string `type` 的 SDK/control 消息都交给上层;`control_request.can_use_tool` 进入 pending permission;`control_cancel_request` 取消;4003 永久关闭不重连;4001 有有限重试;普通 transient close 做有限重连;连接期间 ping 保活。
- 新增 `ts/src/tasks/bridgeRemoteSubscriber.ts`:实现可注入 WebSocket 构造器的 `BridgeRemoteSubscriber`,支持 `connect()/close()/reconnect()/sendControlResponse()/isConnected()`。订阅消息直接写入上一轮的 `BridgeRemoteState.ingestEvent()`,因此 SDK message、control_request、control_cancel_request 都会落到 `/events`/`/permissions` 查询面;连接状态同步到 `BridgePeerRegistry`,连接中为 `connecting`,打开后 `connected + inboundEnabled:true`,永久关闭为 `error`,耗尽重试为 `disconnected`。
- 新增 server API:`POST /api/v1/agent/bridge/sessions/:sessionId/subscribe` 从 `bridge_remote` body 或 env 解析 base URL/token/org,启动 subscriber;`DELETE /api/v1/agent/bridge/sessions/:sessionId/subscribe` 停止并清理;`GET /api/v1/agent/bridge/subscribers` 列出当前订阅和 connected 状态。server stop 时会 close 所有 subscriber,避免桌面进程关闭后留下远端连接。
- 口径:这一步把 Remote Control 的 WebSocket 接收半边接到 TS 内核状态面,仍不是完整 CCR worker。下一步继续复制/移植/改写 `/v1/code/sessions/:id/bridge` OAuth -> worker_jwt credential 交换、SSE/CCR client worker transport、401 recovery、heartbeat/reconnect lease、inbound attachment 解析、SDK message -> 前端实时渲染。
- 测试覆盖:`bridgeRemoteSubscriber.test.ts` 覆盖 WebSocket URL/header、SDK/control message 落盘、pending permission、4001 重连、4003 永久关闭、connected-only control response 发送;`server/index.test.ts` 覆盖 subscribe API 启动后 fake WebSocket control_request 自动进入 pending permission、subscriber list 展示 connected、DELETE 停止连接。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/bridgeRemoteSubscriber.test.ts src/tasks/bridgeRemoteState.test.ts src/tasks/bridgePeerRegistry.test.ts src/server/index.test.ts --timeout 60000` focused clean。

## 3.279 2026-07-08 CC-Haha code session / bridge credential 交换迁移

- 对照源:`~/Desktop/cc-haha-ref/src/bridge/codeSessionApi.ts` 与 `src/bridge/remoteBridgeCore.ts`。关键行为:先 `POST /v1/code/sessions` 创建 `cse_*` code session,body 必须含 `{title, bridge:{}, tags?}`;再 `POST /v1/code/sessions/:sessionId/bridge` 用 OAuth token 换 `{worker_jwt, api_base_url, expires_in, worker_epoch}`;`worker_epoch` 可为 protojson string 或 number,必须是 safe integer;`/bridge` 每次调用就是 server-side register/bump epoch。
- 新增 `ts/src/tasks/bridgeCodeSessionClient.ts`:实现可注入 fetch 的 code-session client,header 对齐 CC-Haha OAuth 路径 `Authorization: Bearer ...`、`Content-Type: application/json`、`anthropic-version: 2023-06-01`;支持可选 `X-Trusted-Device-Token`;校验 `session.id` 必须 `cse_` 开头;解析 `worker_jwt/api_base_url/expires_in/worker_epoch` 为 TS 内部 camelCase credential。
- 扩展 `BridgeRemoteState`:新增 `storeCredentials()/getCredentials()`,在 `.agent-state/bridge-remote/state.json` 持久化每个 session 的最新 `workerJwt/apiBaseUrl/expiresIn/workerEpoch/fetchedAt/expiresAt`。这给下一步 SSE/CCR worker transport、401 recovery、proactive refresh 留出稳定状态面,不是只把 credential 作为一次性 HTTP 返回值。
- 新增 server API:`POST /api/v1/agent/bridge/code-sessions` 创建 code session 并注册 `bridge:cse_*` peer 为 `outbound_only`;`POST /api/v1/agent/bridge/code-sessions/:sessionId/credentials` 调 `/bridge` 获取并持久化 worker credential;`GET /api/v1/agent/bridge/code-sessions/:sessionId/credentials` 查询当前持久化 credential。请求体复用 `bridge_remote` / env 配置,与前几轮 transport/subscriber 配置保持一致。
- 口径:这一步完成 Remote Control v2 worker 的 credential exchange 前置链路。下一步继续复制/移植/改写 `createV2ReplTransport` 相关 SSETransport + CCRClient 写入、heartbeat、state/delivery upload、401 recovery、epoch mismatch 重建、SDK message -> 前端流式渲染和 inbound attachment 解析。
- 测试覆盖:`bridgeCodeSessionClient.test.ts` 覆盖 create body/header、`/bridge` trusted device header、worker_epoch string 解析、malformed session/credential 和不安全 base URL;`bridgeRemoteState.test.ts` 覆盖 credential 持久化/覆盖/读取;`server/index.test.ts` 覆盖 code-session 创建 -> credential fetch -> persisted GET -> peer registry 的完整 API 链路。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/bridgeCodeSessionClient.test.ts src/tasks/bridgeRemoteState.test.ts src/tasks/bridgeRemoteTransport.test.ts src/tasks/bridgeRemoteSubscriber.test.ts src/tasks/bridgePeerRegistry.test.ts src/server/index.test.ts --timeout 60000` = 98 pass。

## 3.280 2026-07-08 CC-Haha CCR worker HTTP transport / heartbeat / state upload 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/cli/transports/ccrClient.ts`、`src/cli/transports/SerialBatchEventUploader.ts`、`src/cli/transports/WorkerStateUploader.ts`、`src/bridge/replBridgeTransport.ts` 与 `src/bridge/workSecret.ts`。关键行为:`api_base_url + /v1/code/sessions/:id` 派生 worker session URL;所有 worker 写入都带 `worker_epoch`;初始化 `PUT /worker` 置 `idle` 并清 `pending_action/task_summary`;`POST /worker/events` 上传客户端事件;`POST /worker/internal-events` 写内部 transcript/compaction;`POST /worker/events/delivery` 写 received/processing/processed;`POST /worker/heartbeat` 保活;409 epoch mismatch 要关闭 worker 而不是继续心跳。
- 新增 `ts/src/tasks/bridgeWorkerUploaders.ts`:复制/移植/改写 CC-Haha 的 serial batch uploader 与 worker state coalescing uploader。事件 uploader 支持 batch size、byte cap、backpressure、retry-after、flush、close、drop counter;state uploader 对 `worker_status/external_metadata/internal_metadata` 做 coalesce,metadata 按 RFC 7396 一层 merge,避免频繁 PUT /worker。
- 新增 `ts/src/tasks/bridgeWorkerClient.ts`:实现 `BridgeWorkerClient`,用上一轮持久化 credential 启动 CCR worker HTTP transport。支持 `initialize()/writeEvent()/writeInternalEvent()/reportState()/reportMetadata()/reportDelivery()/sendHeartbeatNow()/flush()/close()`;header 对齐 `Authorization: Bearer worker_jwt`、`Content-Type: application/json`、`anthropic-version: 2023-06-01`;base URL 仍限制 HTTPS 或 localhost HTTP。
- 流式细节:迁移 `stream_event` buffer 与 text_delta coalescing。`message_start` 记录 active message id,同 content block 的多个 `content_block_delta.text_delta` 会在 flush 时合并成 full-so-far snapshot,不是碎片 delta;完整 `assistant` message 到达后清 accumulator。这是后续前端实时显示/重连恢复不闪烁、不丢前文的基础。
- 新增 server API:`POST /api/v1/agent/bridge/code-sessions/:id/worker` 从已存 credential 启动 worker client;`GET/DELETE /worker` 查询/停止;`POST /worker/event`、`/worker/internal-event`、`/worker/state`、`/worker/metadata`、`/worker/delivery`、`/worker/heartbeat`、`/worker/flush` 暴露 worker HTTP protocol 层。server stop 会 close 所有 worker,避免心跳 timer 泄漏。
- 口径:这一步完成 CCR worker 的 HTTP 写入、状态、heartbeat、delivery 层,仍不是完整 `createV2ReplTransport`:还缺 SSETransport 读流、Last-Event-ID/from_sequence_num 恢复、401/403 token expiry recovery/proactive refresh、epoch mismatch 后用新 `/bridge` credential rebuild transport、inbound attachments -> 本地 prompt 注入、SDK message -> 前端实时渲染。
- 测试覆盖:`bridgeWorkerUploaders.test.ts` 覆盖批量 retry/flush、state metadata coalesce;`bridgeWorkerClient.test.ts` 覆盖 session URL、init/heartbeat/state/events/internal-events/delivery body/header、stream text_delta full snapshot、409 epoch mismatch callback;`server/index.test.ts` 覆盖 credential -> worker start -> event/state/delivery/heartbeat/flush -> fake remote endpoint 的完整 API 链路。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/bridgeWorkerUploaders.test.ts src/tasks/bridgeWorkerClient.test.ts src/tasks/bridgeCodeSessionClient.test.ts src/tasks/bridgeRemoteState.test.ts src/tasks/bridgeRemoteSubscriber.test.ts src/tasks/bridgePeerRegistry.test.ts src/server/index.test.ts --timeout 60000` = 101 pass。

## 3.281 2026-07-08 CC-Haha SSETransport worker read stream 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/cli/transports/SSETransport.ts` 与 `src/bridge/replBridgeTransport.ts`。关键行为:从 `api_base_url/v1/code/sessions/:id/worker/events/stream` 打开 SSE;带 `Authorization: Bearer worker_jwt`、`Accept: text/event-stream`、`anthropic-version: 2023-06-01`;重建连接时带 `from_sequence_num` query 和 `Last-Event-ID`;只处理 `event: client_event`;解析 `StreamClientEvent.payload`;维护 `lastSequenceNum` 与近端去重集合;401/403/404 是 permanent close。
- 新增 `ts/src/tasks/bridgeWorkerStream.ts`:实现 `parseBridgeSseFrames()`、`buildBridgeWorkerStreamUrl()` 和 `BridgeWorkerStream`。stream 会读 `ReadableStream<Uint8Array>`,增量解析 SSE frame,遇到 `client_event` 后把 payload 写入 `BridgeRemoteState.ingestEvent()`,并通过 `BridgeWorkerClient.reportDelivery()` 自动上报 `received` 与 `processed`。连接结束或 liveness timeout 会按指数退避重连;permanent HTTP code 直接 close。
- server worker 生命周期接线:`POST /api/v1/agent/bridge/code-sessions/:id/worker` 启动 worker HTTP client 后默认打开 read stream,也可通过 `stream:false` / `read_stream:false` 只启写入半边;`GET /worker` 现在返回 stream `state/lastSequenceNum`;`DELETE /worker` 和 server stop 会同时关闭 stream 与 worker,避免 SSE fetch 和 heartbeat timer 泄漏。
- 数据面效果:远端 CCR 发来的 `control_request`/SDK message 会进入同一个 `.agent-state/bridge-remote/state.json`,因此已有 `/events`、`/permissions`、permission outbox、前端审批面都能复用;`control_request.can_use_tool` 自动进入 pending permission。这是前端流式实时显示和权限 UI 的上游接收层。
- 口径:这一步完成 worker SSE read stream,仍未完成 401/proactive refresh 的 `/bridge` credential rebuild、epoch mismatch 后 transport rebuild、inbound file attachment 下载/解析、以及 SDK message -> 主对话窗口/中间预览/右侧预览的实时渲染编排。
- 测试覆盖:`bridgeWorkerStream.test.ts` 覆盖 SSE comment/id/event/data 解析、URL/header/from_sequence_num/Last-Event-ID、client_event -> state + delivery ack、lastSequenceNum、401 permanent close;`server/index.test.ts` 覆盖 worker start 后 fake SSE `control_request` 自动进入 pending permission、delivery processed 上报、GET worker 返回 stream sequence。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/bridgeWorkerStream.test.ts src/tasks/bridgeWorkerClient.test.ts src/tasks/bridgeWorkerUploaders.test.ts src/tasks/bridgeRemoteState.test.ts src/server/index.test.ts --timeout 60000` = 97 pass。

## 3.282 2026-07-08 CC-Haha worker credential refresh / epoch rebuild 控制面迁移

- 对照源:`~/Desktop/cc-haha-ref/src/bridge/remoteBridgeCore.ts` 的 `rebuildTransport()`、401 recovery 与 proactive refresh 逻辑。关键行为:每次 `/v1/code/sessions/:id/bridge` 都会 bump server-side `worker_epoch`;因此 refresh/recovery 不能只替换 JWT,必须关闭旧 worker/stream,保留旧 SSE `lastSequenceNum`,用新 `worker_jwt/api_base_url/worker_epoch` 重建 worker client + SSE stream,并用 `from_sequence_num` 恢复读流。
- server 内部新增统一 `startBridgeWorker()` helper:`POST /worker` 初次启动、手动 refresh、后续 epoch mismatch recovery 都走同一套逻辑。helper 会关闭旧 stream/worker,读取上一条 stream 的 `lastSequenceNum`,初始化新 `BridgeWorkerClient`,再按旧 sequence 启动 `BridgeWorkerStream`,最后更新 bridge peer 为 `connected + inboundEnabled:true`。
- 新增 `POST /api/v1/agent/bridge/code-sessions/:id/worker/refresh`:从请求体或 env 的 `bridge_remote` OAuth 配置重新调用 `/bridge`,持久化 fresh credential,然后 rebuild worker/stream。返回 `workerEpoch/refreshStatus/initStatus/initialSequenceNum`,方便前端或 sidecar 明确知道这次是不是换了 epoch 并从哪个 sequence 恢复。
- 401/403 stream permanent close 与 epoch mismatch 已接到同一状态面:stream close 401/403 会关闭 worker、删除 maps、把 peer 标 `error`;worker 409 epoch mismatch 也会关闭 stream/worker 并标 `worker epoch mismatch`。自动 OAuth/keychain refresh scheduler 尚未接入,但 rebuild 的核心入口已经可由前端/sidecar/后续 scheduler 调用。
- 测试覆盖:`server/index.test.ts` 新增 refresh 链路:先启动 worker + SSE seq=1,再 `worker/refresh` 返回新 `worker_epoch=14 / worker.jwt.2`,断言新 `PUT /worker` 使用 epoch 14、新 SSE URL 带 `from_sequence_num=1` 和新 Authorization,最终 stream 推进到 seq=2。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/bridgeWorkerStream.test.ts src/tasks/bridgeWorkerClient.test.ts src/tasks/bridgeWorkerUploaders.test.ts src/tasks/bridgeCodeSessionClient.test.ts src/tasks/bridgeRemoteState.test.ts src/server/index.test.ts --timeout 60000` = 101 pass。

## 3.283 2026-07-08 CC-Haha inbound user message / file attachment 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/bridge/inboundMessages.ts`、`src/bridge/inboundAttachments.ts`、`src/hooks/useReplBridge.tsx` 的 `handleInboundMessage()`、以及 `src/cli/print.ts` 的 bridge replay/inbound user message 分支。关键行为:只处理 `type:"user"`;提取 `message.content` 与 `uuid`;空 content 跳过;base64 image block 若缺 `source.media_type` 则用 `source.mediaType` 或图片头推断补齐;`file_attachments` 里的 `{file_uuid,file_name}` 通过 OAuth `GET /api/oauth/files/:uuid/content` 下载到本机 session uploads;将 `@"absolute/path"` 前缀加到 string content 或最后一个 text block;没有 text block 时追加 text block;入站 prompt 入队时保留 `bridgeOrigin:true` 与 `skipSlashCommands:true`。
- 新增 `ts/src/tasks/bridgeInboundMessages.ts`:移植并 TS 化 `extractInboundMessageFields()`、`normalizeImageBlocks()`、`extractInboundAttachments()`、`sanitizeFileName()`、`resolveInboundAttachments()`、`prependPathRefs()`、`resolveInboundUserMessage()`。下载层使用可注入 `FetchLike`,base URL 仍限制 HTTPS 或 localhost HTTP;附件写入 `.agent-state/bridge-uploads/:sessionId/`,文件名按 CC-Haha 的 basename + safe chars + uuid 前 8 位前缀规则处理,失败 best-effort 跳过该附件但不丢用户消息。
- 内核消息类型正式支持 image content block:`ts/src/types/message.ts` 新增 `{type:"image",source:{type:"base64",media_type,data}}`;`AnthropicMessagesModel` 可原样透传 image block;OpenAI-compatible proxy 已有 data URI 转换分支,本轮补齐类型地基;compaction 估算对 image block 做上限计数,避免 base64 大图让压缩估算失真。
- `BridgeRemoteState` 新增 `inboundMessages` 队列与 `storeInboundMessage()/listInboundMessages()`:记录 `seq/sessionId/eventSeq/uuid/content/attachments/resolvedPaths/prefix/bridgeOrigin/skipSlashCommands/receivedAt`,并按 `uuid` 去重替换同一入站消息,保留最多 500 条。这样前端或后续主 agent queue 不再需要重新解析 raw SDK event,可以直接消费 resolved prompt。
- `BridgeWorkerStream` 与 `BridgeRemoteSubscriber` 接入入站解析:收到 user SDK payload 后仍先写原始 `/events`,再尽力调用 `resolveInboundUserMessage()` 并写入 inbound 队列;worker SSE 路径会用 worker start body/env 里的 `bridge_remote` OAuth base URL/token 下载附件;WebSocket subscriber 路径直接复用 subscriber config 的 base URL/token。delivery ack 仍会在解析完成后上报 processed,避免远端误判未处理。
- 新增 server API:`GET /api/v1/agent/bridge/sessions/:sessionId/inbound` 按 `after/limit` 拉取已解析入站 prompt;`POST /api/v1/agent/bridge/sessions/:sessionId/inbound/resolve` 可手动 resolve 一个 SDK user event,默认写队列,也可 `store:false` 只返回 resolved 内容。这个接口给前端调试、sidecar 接入和下一步主 agent queue 注入留下明确边界。
- 口径:这一步完成 CC-Haha inbound user message 与 file attachment 的可运行内核迁移,并把 Remote Control SSE/WebSocket 接收半边接到 resolved prompt 队列。尚未把该队列自动喂进当前 `/agent/run` 主对话 turn,也尚未完成主对话窗口/中间文件 diff/右侧预览的实时流式渲染编排;下一步继续复制/移植/改写 inbound prompt -> agent queue、SDK message -> 前端实时渲染、OAuth 自动 refresh scheduler。
- 测试覆盖:`bridgeInboundMessages.test.ts` 覆盖非 user 跳过、空 content 跳过、`mediaType` -> `media_type`、PNG/JPEG/GIF/WebP 推断基础、attachment shape 校验、OAuth header 下载、文件名净化与 quoted refs、string/最后 text block/no-text block 前缀规则、bridge queue flags;`bridgeRemoteState.test.ts` 覆盖 inbound 队列持久化与 uuid 去重;`bridgeWorkerStream.test.ts`/`bridgeRemoteSubscriber.test.ts` 确认既有事件/权限链路不回归;`server/index.test.ts` 覆盖 `/inbound/resolve` 下载附件并保存、worker SSE user event 自动写入 inbound 队列并上报 delivery processed。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/bridgeInboundMessages.test.ts src/tasks/bridgeRemoteState.test.ts src/tasks/bridgeWorkerStream.test.ts src/tasks/bridgeRemoteSubscriber.test.ts src/server/index.test.ts --timeout 60000` = 104 pass。

## 3.284 2026-07-08 CC-Haha inbound prompt -> agent queue / steering 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/hooks/useReplBridge.tsx` 的 `handleInboundMessage()` 与 `src/cli/print.ts` 的 inbound user message `enqueue({mode:"prompt", value: await resolveAndPrepend(...), uuid, skipSlashCommands:true, bridgeOrigin:true})`。关键行为:远端 user prompt 不应只落库展示,而要进入本地 agent 执行队列;若当前会话忙,按安全点排队为补充消息;若空闲,应能启动一轮新 agent loop。content 可以是 string 或 content block array,图片 block 不能被降级成纯文本。
- `runAgentLoop()` 新增 `userContent?: ContentBlock[]`:普通 `/agent/run` 仍使用 string 输入,但 bridge inbound 可把 resolved `ContentBlock[]` 原样交给模型。hook 仍以 `userMessage` preview 运行,真正 user message 由 `additionalContext + teamInbox + userContent` 组成,因此 `@"path"` 附件引用、最后 text block 位置和 base64 image block 都能保真进入 Anthropic/OpenAI-compatible model adapter。
- `TurnRegistry` 新增 `isRunning(sessionId)`,server 新增 `dispatchBridgeInboundToAgent()`。入站 resolved prompt 如果带 `conversationId` 且该会话正在跑,会写入 `steerInboxes` 并追加 `steering` 事件;如果会话空闲且 `auto_run:true`,会创建 `kind:"bridge_inbound"` 的 legacy task,复用 `createTurnStream()` 启动本地 agent loop,前端可通过既有 `/api/v1/agent/tasks/:id/events` 读取流式事件。没有 `conversationId/auto_run` 时仍只保存 inbound 队列,保持调试/手动消费路径。
- `/api/v1/agent/bridge/sessions/:sessionId/inbound/resolve` 扩展 dispatch 返回:`dispatch.mode` 可能为 `stored`、`steering` 或 `task`;`auto_run:true` 返回 `task_id/status`,running 会话返回 `queued`。`BridgeWorkerStream` 和 `BridgeRemoteSubscriber` 的自动解析路径也接入 `onResolved`,启动 worker/subscriber 时 body 里的 `conversationId/auto_run/working_dir/permissionMode` 会随 inbound prompt 传到 dispatch 层。
- 命令安全口径:bridge inbound 自动运行时先以 `skipSlashCommands:true + bridgeOrigin:true` 入队,最初阶段只按纯文本处理,后续第 3.287 节已按 CC-Haha `isBridgeSafeCommand()` 补齐白名单覆盖,允许安全 prompt command 展开,仍拦截未授权本地命令。
- 口径:这一步把 inbound resolved prompt 从“可查询队列”推进到“可进入 agent loop/运行中会话 steering”的可运行链路。OAuth 自动 refresh scheduler、SDK assistant/tool stream 对齐到主对话窗口事件流和 bridge-safe slash command 白名单后续已落;前端中间文件 diff/右侧预览的细颗粒实时渲染仍要继续 polish。
- 测试覆盖:`harness/loop.test.ts` 新增 explicit user content block 保真测试,断言 image block 和 text block 原样进入模型消息;`server/index.test.ts` 覆盖 `/inbound/resolve auto_run:true` 创建 bridge inbound task、事件流完成、模型请求含 data:image 与 `@"path"` 附件文本;覆盖 running conversation 时 `/inbound/resolve` 返回 `mode:"steering"`,远端补充进入当前任务事件流并驱动第二轮模型。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/harness/loop.test.ts src/tasks/bridgeInboundMessages.test.ts src/tasks/bridgeRemoteState.test.ts src/tasks/bridgeWorkerStream.test.ts src/tasks/bridgeRemoteSubscriber.test.ts src/server/index.test.ts --timeout 60000` = 162 pass。

## 3.285 2026-07-08 CC-Haha worker OAuth/JWT 自动刷新 scheduler 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/bridge/jwtUtils.ts` 与 `src/bridge/remoteBridgeCore.ts` 的 `createTokenRefreshScheduler()`、proactive refresh、401 recovery 与 `rebuildTransport()`。关键行为:`/bridge` 返回的 `expires_in` 决定下一次刷新时间;默认提前 5 分钟刷新,但最短延迟 clamp 到 30s,避免短 TTL 或测试 buffer 造成 tight loop;每次 `/bridge` 都会 bump `worker_epoch`,因此自动刷新和 SSE 401 恢复都必须重建 worker client + SSE stream,不能只换 JWT。
- 新增 `ts/src/tasks/bridgeWorkerRefreshScheduler.ts`:实现可测试的 `BridgeWorkerRefreshScheduler`,支持 `scheduleFromExpiresIn()`、`refreshNow(cause)`、`cancel()`、`getStatus()`;内置 in-flight guard、generation stale guard、失败重试、最大连续失败上限和 timer cancel。cause 明确区分 `proactive_refresh`、`auth_401_recovery`、`manual_refresh`,便于前端/日志判断刷新来源。
- server worker 生命周期接入自动刷新:初次 `POST /worker` 在 worker init 成功后、SSE connect 前根据 `bridge_remote` OAuth 配置创建 scheduler;到期后重新调用 `/v1/code/sessions/:id/bridge`,持久化 fresh credential,关闭旧 worker/stream,保留旧 stream `lastSequenceNum`,用新 `worker_jwt/api_base_url/worker_epoch` 重建并从旧 sequence 恢复。`GET /worker` 新增 `refresh` 状态,包含 enabled/inFlight/nextRefreshAt/lastRefreshAt/lastError/lastCause。
- 401/403 SSE close 现在优先走同一 scheduler recovery:如果 stream 因 worker JWT 过期返回 401/403,server 会把 peer 标为 `connecting`,调用 `refreshNow("auth_401_recovery")`,成功后恢复为 connected 并继续读流;只有缺少 scheduler 或 refresh 失败时才关闭 worker 并标 error。手动 `/worker/refresh` 也复用同一 fetch/store/rebuild helper,避免手动和自动路径语义分叉。
- 生命周期清理:worker DELETE、epoch mismatch、server stop 会 cancel scheduler 并 close stream/worker,避免长时间桌面进程里留下 heartbeat/SSE/refresh timer。scheduler timer 默认 `unref()`,不阻塞进程退出;失败重试最多 3 次,保留 lastError 供前端状态线或调试面板展示。
- 口径:这一步补齐 CC-Haha Remote Control 长连接最关键的自动 refresh/recovery 链路。SDK assistant/tool stream 投影与 bridge-safe slash command 白名单后续已落;前端中间文件 diff/右侧预览的细颗粒实时渲染仍要继续 polish,并继续补真正独立 fork worker 与 prompt-cache break telemetry。
- 测试覆盖:`bridgeWorkerRefreshScheduler.test.ts` 覆盖 expires_in + 5min buffer + 30s floor、cancel、in-flight 跳过、成功后重排、失败 retry cap;`server/index.test.ts` 覆盖 worker 启动后自动 proactive refresh 到新 epoch 且 SSE 从旧 `from_sequence_num` 恢复,以及 stream 401 时自动 `/bridge` refresh 而不是直接丢 worker。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/bridgeWorkerRefreshScheduler.test.ts src/server/index.test.ts --timeout 60000` = 92 pass。

## 3.286 2026-07-08 CC-Haha SDK message -> 前端实时事件流投影迁移

- 对照源:`~/Desktop/cc-haha-ref/src/remote/sdkMessageAdapter.ts`、`src/bridge/bridgeMessaging.ts` 与 `src/entrypoints/sdk/coreSchemas.ts`。关键行为:Remote Control 收到的 SDK assistant/stream/result/system/tool_progress 不应该只落到 bridge state,还要转换成 REPL/前端可显示的实时事件;user prompt 仍走 inbound queue/steering,避免 prompt echo 在主对话窗口重复显示。
- 新增 `ts/src/tasks/bridgeSdkEventProjection.ts`:把 CC-Haha SDKMessage 显示语义翻译成当前 TS 前端已支持的 `AgentEvent`。`assistant.message.content` 里的 text/thinking/tool_use 分别转 `final/thinking/tool_call`;`stream_event.content_block_delta.text_delta` 转 `thinking`;`content_block_start.tool_use` 转 `tool_call`;user tool_result 转 `tool_result`;result success 转 `final`;system init/status/compact/api_retry/streaming_fallback 转低噪 `context_note`;tool_progress 转 `tool_progress`。
- worker SSE 路径接入实时投影:`BridgeWorkerStream` 收到 `client_event` 后仍先写 `BridgeRemoteState` 和 delivery ack,再通过 server 的 `projectBridgeEventToConversation()` 追加到 `SessionService` event JSONL。启动 `/worker` 时只要 body 带 `conversationId`/`conversation_id`,前端既有 `/sessions/:id/events`、WS replay 和 legacy task stream 就能看到远端 assistant/tool 流,不需要额外轮询 bridge state。
- WebSocket subscriber 路径接入同一投影:`BridgeRemoteSubscriberDeps` 新增 `onEvent`,server 的 `/subscribe` 用同一个 helper 投影 assistant/system/tool_progress。这样 SessionsWebSocket 订阅与 CCR worker SSE 两条 Remote Control 接收路径都能把远端执行过程落到同一 conversation event timeline。
- 安全/显示口径:user SDK message 默认不投影为前端 steering,仍由 inbound resolver 保留 `bridgeOrigin:true` 与 `skipSlashCommands:true` 后进入本地 agent queue;只有 tool_result 型 user 消息会转成 `tool_result`,匹配 CC-Haha adapter 对远端 tool result 的显示语义。未知 SDK 类型保持忽略,避免新 server 事件把前端渲染打乱。
- 口径:这一步补齐“远端 assistant/tool stream 能实时进入主会话事件流”的后端协议层。bridge-safe slash command 白名单后续已落;前端 UI 仍可继续做更精细的中间 diff/右侧预览同步、远端来源徽标、工具折叠 polish,真正独立 fork worker 仍是下一步。
- 测试覆盖:`bridgeSdkEventProjection.test.ts` 覆盖 assistant blocks、stream delta、tool_use、tool_result、status/result 和 user text 默认忽略;`server/index.test.ts` 覆盖 worker SSE 收到 stream_event + assistant 后写入 conversation `thinking/tool_call/final`,以及 subscriber WebSocket 收到 assistant 后写入 conversation `final`。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/bridgeSdkEventProjection.test.ts src/tasks/bridgeWorkerRefreshScheduler.test.ts src/tasks/bridgeWorkerStream.test.ts src/tasks/bridgeWorkerClient.test.ts src/tasks/bridgeWorkerUploaders.test.ts src/tasks/bridgeCodeSessionClient.test.ts src/tasks/bridgeRemoteState.test.ts src/tasks/bridgeRemoteSubscriber.test.ts src/tasks/bridgeInboundMessages.test.ts src/server/index.test.ts --timeout 60000` = 126 pass。

## 3.287 2026-07-08 CC-Haha bridge-safe slash command 白名单迁移

- 对照源:`~/Desktop/cc-haha-ref/src/commands.ts` 的 `BRIDGE_SAFE_COMMANDS`、`isBridgeSafeCommand()`、`filterCommandsForRemoteMode()` 与 `src/utils/processUserInput/processUserInput.ts` 的 `bridgeOrigin + skipSlashCommands` 覆盖逻辑。关键行为:Remote Control 入站 prompt 仍默认带 `skipSlashCommands:true`,但若命中 `isBridgeSafeCommand()` 允许的命令,可以清除 skip 并按 slash command 执行;已知但不安全的 local/local-jsx 命令返回 “isn't available over Remote Control”,未知 `/foo` 仍按普通文本给模型。
- 新增 `ts/src/commands/commandLoader.ts` 的 bridge-safe 命令 gate:`prompt` 命令一律允许展开,`local-jsx` 一律拦截,`local` 命令只允许 `compact/clear/cost/summary/release-notes/files` 这类 CC-Haha 白名单名字。当前 TS 项目只有 markdown/domain-pack prompt commands 与服务端内建 `/goal` local command,因此 `/goal` 在 bridge inbound 中被视为已知但不安全的 local command,不会被远端清除或设置本机会话目标。
- server 主 turn 解析从粗粒度 `skipCommandParsing:true` 改为 `skipSlashCommands + bridgeOrigin` gate:bridge inbound auto-run 会保留 resolved prompt 的 `bridgeOrigin:true/skipSlashCommands:true`;若远端发 `/daily-report 今天` 这类 prompt command,会展开为命令 prompt 并写入 `command_invocation`;若远端发 `/goal clear`,直接返回不可用提示且不调用模型、不写入 `<command-name>/goal</command-name>` transcript;未知 slash 保持普通用户文本。
- `/commands` API 新增远端过滤口径:`GET /commands?bridge_origin=true` / `remote_control=true` 返回 `filterBridgeSafeCommands()` 后的 public commands。当前能暴露的是 prompt command,后续若接入更多 local/local-jsx command registry,同一 gate 会保证 Remote Control 初始化列表不会广告不安全命令。
- 口径:这一步完成 CC-Haha Remote Control inbound slash command 安全语义迁移,不是放开所有远端命令。后续若把更多 CC-Haha local command 真迁过来,必须先登记类型并继续走 `isBridgeSafeCommand()` gate;前端仍可继续做远端来源徽标、命令不可用提示样式和中间 diff/右侧预览实时同步。
- 测试覆盖:`commandLoader.test.ts` 覆盖 prompt/local/local-jsx gate 与 local 白名单;`server/index.test.ts` 覆盖 bridge inbound auto-run 展开 `/daily-report` prompt command、拦截 `/goal clear` 且不调用模型、不改 transcript,以及 `/commands?bridge_origin=true` 返回 bridge-safe command 列表。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/commands/commandLoader.test.ts src/tasks/bridgeInboundMessages.test.ts src/tasks/bridgeRemoteState.test.ts src/server/index.test.ts --timeout 60000` = 112 pass。

## 3.288 2026-07-08 CC-Haha prompt-cache break telemetry 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/services/api/promptCacheBreakDetection.ts`、`src/services/compact/compact.ts`、`src/services/compact/autoCompact.ts` 与 `src/services/compact/microCompact.ts`。关键行为:模型调用前记录 system/tools/model 的稳定 hash,模型响应后用 `cache_read_input_tokens` 的显著下降确认是否真发生 cache break;system prompt、tool schema、model 变化要解释原因;compaction/cache deletion 会重置或跳过 baseline,避免把正常上下文裁剪误报成坏 cache。
- 新增 `ts/src/context/promptCacheBreakDetection.ts`:实现当前 TS 内核可运行的两段式检测。按 `conversationId` 跟踪 system hash、tools hash、per-tool schema hash、tool 名集合、system 字符数、model 名、上一轮 cache read tokens 和 pending changes;阈值对齐 CC-Haha:cache read 下降超过 5% 且绝对 drop >= 2000 才报。MCP 工具名统一脱敏为 `mcp`,避免把用户配置路径或服务名写进会话事件。
- `runAgentLoop()` 接入检测:每次 `model.step()` 前调用 `recordPromptCacheState()`,每次 usage 返回后调用 `checkPromptCacheBreak()`,命中时发 `context_note`:`[PROMPT CACHE BREAK] ... cache read: old -> new ...`。server 主路径把真实 `providerRuntime.config.model` 传入 `modelName`,因此诊断能区分模型变化;测试/子代理没有显式 modelName 时用 Model 构造名兜底。检测只在有 `conversationId` 的会话生效,避免一次性临时调用互相污染。
- compaction 语义对齐:主 loop `compactPipeline()` 确认 `didCompact` 后调用 `notifyPromptCacheCompaction()`,清空该会话 cache read baseline 和 pending changes。这样压缩、最近文件上下文恢复、大工具结果落盘等正常上下文维护不会被误报为 prompt-cache break。
- 口径:这一步迁移的是 CC-Haha 的 prompt-cache break 诊断/telemetry 层,不是 Anthropic 服务端 prompt cache 策略本身,也不是外部 BQ/Perfetto 埋点。当前落点是会话 `context_note`,前端可继续做折叠、状态线 chip 或诊断面板;真正独立 fork worker 仍需继续复制/移植/改写。
- 测试覆盖:`promptCacheBreakDetection.test.ts` 覆盖 tool schema 变化原因、小幅下降忽略、compaction baseline reset、MCP 名称脱敏;`harness/loop.test.ts` 覆盖同一 conversation 两轮调用后 cache read 大幅下降时发出 `[PROMPT CACHE BREAK]` context note。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/context/promptCacheBreakDetection.test.ts src/harness/loop.test.ts src/agents/agentTool.test.ts src/tasks/taskTools.test.ts src/server/index.test.ts src/proxy/usage.test.ts --timeout 60000` = 185 pass。

## 3.289 2026-07-08 CC-Haha AgentTool run_in_background 入口迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` 与 `src/tasks/LocalAgentTask/LocalAgentTask.tsx`。关键行为:Agent 工具本身支持 `run_in_background:true`,会注册后台 agent task 并立即返回 `async_launched/background_task_started` 类结果;可选 `name` 会写入 agent name registry,后续 `SendMessage({to:name})` 能继续 steering,不需要模型改走另一套工具名。
- `ts/src/agents/agentTool.ts` 的 `agent_task` 入参新增 `run_in_background` 与 `name`;显式 `run_in_background:true` 或 agent frontmatter `background:true` 都会复用 `startBackgroundAgentRun()` 后台生命周期,继承已有 task transcript、stable `agent_id`、worktree isolation、metadata sidecar、`TaskOutput`、`SendMessage` 路由与续跑能力。没有后台 runner 时直接报错,避免把用户以为已经后台化的长任务悄悄同步阻塞。
- 返回 XML 与后台工具保持一致:`<background_task_started id="..." agent="..." name="..." agent_id="..." status="queued">`,让前端 trace/chip、任务列表和远端/本地模型都能按同一结构解析。`runInBackground` 作为内部兼容别名接收,模型可见 schema 保持 CC-Haha 的 `run_in_background` 命名。
- `tool_search` 补充 `run_in_background`、`异步子代理`、`named subagent` 等别名,使大工具池懒加载时模型能直接找回 `agent_task` 的 CC-Haha 后台入口,而不是误以为只能调用独立的 `start_background_agent_task`。
- 口径:这一步补齐的是 AgentTool 显式后台启动入口,不是完整 fork worker。CC-Haha 的 foreground-to-background race、fork child cache-identical prompt/tool prefix、local denial isolation 和真正独立 worker runner 还要继续逐块复制/移植/改写。
- 测试覆盖:`agentTool.test.ts` 覆盖 `run_in_background:true + name + isolation` 参数下发、返回 `name/agent_id`、既有 `background:true` 行为不回归;`toolSearchTool.test.ts` 覆盖 `run_in_background named subagent` 能找到 `agent_task`;后台 task/SendMessage/server focused suite 覆盖现有后台生命周期不回归。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/agents/agentTool.test.ts src/tools/toolSearchTool.test.ts --timeout 60000` = 16 pass;`cd ts && bun test src/tasks/taskTools.test.ts src/tasks/teamTools.test.ts src/server/index.test.ts -t "background agent|SendMessage|agent_task|background subagent|POST /agent/run exposes agent_task" --timeout 60000` = 35 pass;`git diff --check` clean。

## 3.290 2026-07-08 CC-Haha subagent local denial tracking 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/forkedAgent.ts` 与 `src/utils/permissions/denialTracking.ts`。关键行为:子代理通过 `createSubagentContext()` 获得独立 mutable state,其中 async/isolated subagent 使用 `localDenialTracking:createDenialTrackingState()`,避免子代理审批拒绝次数、记住审批状态污染父会话,也避免父会话拒绝历史误伤子代理。
- `ts/src/permissions/denialTracking.ts` 新增 `DenialTrackingState` 与 local API:`createDenialTrackingState()`、`recordLocalDenial()`、`clearLocalDenial()`、`recordLocalApproval()`、`clearLocalApproval()`、`shouldLocalAutoApprove()`、`shouldLocalStopAsking()`。全局 conversationId store 保持不变,主会话跨 HTTP 请求的审批记忆继续按原语义工作。
- `ToolContext` 与 `runAgentLoop()` 新增 `localDenialTracking`。审批 gate、`executeApproved()`、`handleReject()` 都优先使用 local state;未传 local state 时回退到现有 conversationId store。这样同步子代理、后台子代理、恢复 run 可以显式拥有本地审批记忆,而主会话仍可跨请求累计拒绝/记住审批。
- `agent_task` 与 `start_background_agent_task` 的子代理 loop 显式传入新的 `createDenialTrackingState()`。这把“子代理独立权限/拒绝状态”从依赖 agent id 字符串隔离,升级成明确上下文能力,更接近 CC-Haha `createSubagentContext()` 的状态边界。
- 口径:这一步迁移的是 subagent permission/denial mutable-state isolation,不是完整 fork child cache-identical prefix 或 foreground-to-background race。下一步仍要继续复制/移植/改写真正 fork worker、cache-safe params 生命周期和更细的 foreground task handoff。
- 测试覆盖:`denialTracking.test.ts` 覆盖 local state 阈值、approval 记忆和隔离;`loop.test.ts` 覆盖父会话拒绝两次后 local state 仍会弹自己的审批,local state 自身拒绝两次后 fallback,新 local state 不受影响;`agentTool.test.ts` 覆盖真实 `agent_task` 路径不会继承父会话拒绝历史;`taskTools/teamTools` focused suite 覆盖后台 agent 与 SendMessage 续跑不回归。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/permissions/denialTracking.test.ts src/harness/loop.test.ts src/agents/agentTool.test.ts src/tasks/taskTools.test.ts src/tasks/teamTools.test.ts --timeout 60000` = 119 pass。

## 3.291 2026-07-08 CC-Haha fork child message builder 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/forkSubagent.ts` 与 `src/constants/xml.ts`。关键行为:fork child 要继承父 assistant message 的完整 content,为每个 `tool_use` 补相同 placeholder `tool_result`,再追加带 `<fork-boilerplate>` 的 child directive;只有最后 directive 文本因任务不同而变化,前缀尽量保持 cache-identical。
- 新增 `ts/src/agents/forkSubagent.ts`:提供 `FORK_SUBAGENT_TYPE`、`FORK_BOILERPLATE_TAG`、`FORK_DIRECTIVE_PREFIX`、`buildForkedMessages()`、`buildChildMessage()`、`isInForkChild()`、`buildWorktreeNotice()`。实现按当前 TS 内部 `Message/ContentBlock` 结构适配:保留 assistant 的 thinking/text/tool_use 块,生成同序 placeholder tool_result 块和 directive text 块。
- 递归保护地基:新增 `isInForkChild()` 检测 user 消息里的 `<fork-boilerplate>`,后续 AgentTool 真接入 fork path 时可拒绝 fork child 再 fork,对齐 CC-Haha “fork children keep Agent tool for cache-identical tool defs, but call-time rejects recursive fork”的语义。
- worktree fork 地基:新增 `buildWorktreeNotice(parentCwd, worktreeCwd)`,告诉 fork child 把继承上下文里的父路径翻译到隔离 worktree,并在编辑前重读文件。后续接入 `agent_task`/fork path 的 worktree isolation 时可直接复用。
- 口径:这一步迁移的是 fork child prompt/message 构造和递归识别基础件,不是完整 `FORK_SUBAGENT` gate、schema 省略 `subagent_type`、useExactTools/cache-safe params 或后台生命周期。下一步继续把它接入 AgentTool 调用路径和 cache-safe snapshot。
- 测试覆盖:`forkSubagent.test.ts` 覆盖完整 assistant message 保留、placeholder tool_result 顺序、directive tag/prefix、无 tool_use fallback、fork child 检测和 worktree notice;`agentTool.test.ts` focused suite 确认既有 agent_task 不回归。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/agents/forkSubagent.test.ts src/agents/agentTool.test.ts --timeout 60000` = 17 pass。

## 3.292 2026-07-08 CC-Haha fork recursive guard 运行时接入

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` 的 fork path guard 与 `~/Desktop/cc-haha-ref/src/tools/AgentTool/runAgent.ts` 的 `toolUseContext.messages` 传递。关键行为:fork child 为了保持 cache-identical tool definitions 会继续看到 Agent 工具,但运行时必须检测 `<fork-boilerplate>` 并拒绝再次开子代理,要求 fork child 直接用当前工具完成任务。
- `ToolContext` 新增 `messages?: Message[]`,由 `runAgentLoop()` 在 assistant tool_use 消息写入历史后、逐个工具执行前刷新为当前消息快照。这样工具执行层可以看到“模型调用这个工具时的父上下文”,为 fork guard、后续 cache-safe snapshot、worktree notice 注入和更细的 agent runtime 策略留下真实通道。
- `agent_task` 入口接入 `isInForkChild(ctx.messages)`:命中 fork boilerplate 时直接抛出“不能再次启动 agent_task”的工具错误,由主 loop 包成 `tool_use_error` 回灌模型。这个实现对齐 CC-Haha call-time reject 的核心语义,不会仅靠 prompt 约束模型自觉遵守。
- 口径:这一步完成的是 fork child 递归保护的运行时接入和当前消息快照通道,不是完整 `FORK_SUBAGENT` 隐式 schema/gate、父 assistant message 自动 fork、useExactTools/cache-safe params 或统一后台 fork lifecycle。下一步继续把 `buildForkedMessages()` 接入 `agent_task`/后台 agent 调用路径,并处理 parent rendered system prompt 与 exact tool pool。
- 测试覆盖:`loop.test.ts` 新增工具执行可见当前消息快照测试;`agentTool.test.ts` 新增 fork child 历史中模型调用 `agent_task` 时返回工具错误、不会真的再开子代理;`forkSubagent.test.ts` 保持 builder/detector 单元覆盖。
- 验证:`cd ts && bun test src/agents/forkSubagent.test.ts src/agents/agentTool.test.ts src/harness/loop.test.ts --timeout 60000` = 77 pass。

## 3.293 2026-07-08 CC-Haha explicit fork_context AgentTool 运行时迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` 的 `isForkPath` 参数组装与 `~/Desktop/cc-haha-ref/src/tools/AgentTool/runAgent.ts` 的 `forkContextMessages/useExactTools/override.systemPrompt`。关键行为:fork child 不能只拿一条 task 文本,必须继承父 system prompt、父 conversation history、当前 assistant tool_use、placeholder tool_result 和父 exact tool pool,这样 prompt-cache 前缀和工具定义尽量一致。
- `ToolContext` 新增 `systemPrompt?: string`,由 `runAgentLoop()` 在 SessionStart hook 注入后写入;`runAgentLoop()` 新增 `skipUserMessage` 入口,允许调用方直接从已构造的 `initialMessages` 继续跑,避免 fork child 又被追加一条普通 user task message。
- `forkSubagent.ts` 新增 `ForkRunContext` 与 `buildForkRunContext(ctx,directive)`:从当前工具上下文里取父 system prompt、父 registry exact tools、最近 assistant tool_use 消息和此前历史,生成 `[...parentPrefix, assistant(tool_use...), user(placeholder tool_results..., directive)]`。
- `agent_task` 新增显式 `fork_context`/`forkContext` 入参。设置后使用 synthetic `fork` agent,同步路径继承父 system/messages/tools 并走已有 sidechain/transcript/tool-result/MCP/hook/denial isolation;后台路径通过 `startBackgroundAgentRun(...,{forkContext})` 保持同样的 fork 请求形状,任务 params 只持久化 `fork_context:true`,不会把函数型 Tool 对象写进任务 JSON。
- `start_background_agent_task` 在 fork child 消息历史中也会拒绝递归启动,补齐本仓库除 `agent_task` 以外的后台子代理入口保护。这样 fork child 保留父 exact tool pool 时不会绕过第 3.292 节的 AgentTool guard。
- 口径:这一步完成的是“显式 fork_context”可运行路径,不是 CC-Haha 完整 `FORK_SUBAGENT` gate、`subagent_type` 省略自动 fork、foreground-to-background race、parent rendered system prompt byte-exact fallback、querySource 标记或完整 cache-safe params 生命周期。保留显式开关是为了不破坏当前单 agent 默认选择语义;后续应在 feature gate 下迁移省略 agent 的隐式 fork。
- 测试覆盖:`forkSubagent.test.ts` 覆盖 `buildForkRunContext()` 继承 parent system/tools/history;`loop.test.ts` 覆盖 prepared initial messages 不追加普通 user message;`agentTool.test.ts` 覆盖同步 `agent_task fork_context` 的子模型首轮请求含 parent system/messages/exact tools;`taskTools.test.ts` 覆盖 `agent_task run_in_background + fork_context` 经后台 runner 后仍保留同样 fork 请求形状。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/agents/forkSubagent.test.ts src/agents/agentTool.test.ts src/harness/loop.test.ts src/tasks/taskTools.test.ts --timeout 60000` = 99 pass。

## 3.294 2026-07-08 CC-Haha implicit fork gate 受控迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/forkSubagent.ts#isForkSubagentEnabled()` 与 `~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` 的 schema/gate 行为。关键行为:fork gate 开启时,省略 agent/subagent_type 会触发 fork path,并隐藏不适合该模式的 `run_in_background` 等字段;fork gate 关闭时保持普通子代理选择语义。
- `forkSubagent.ts` 新增 `isForkSubagentEnabled(env)`,当前 TS 通过显式环境变量 `DESKTOP_AGENT_FORK_SUBAGENT=1` 或 `CC_HAHA_FORK_SUBAGENT=true` 开启。默认关闭,避免直接改变现有用户“单 agent 时省略 agent 默认选唯一 agent”的行为。
- `agent_task` 在 fork gate 开启且输入省略 `agent` 时自动走 synthetic `fork` agent,复用第 3.293 节的 `buildForkRunContext()` 并强制后台启动,对齐 CC-Haha “fork 子任务统一后台 task-notification 模式”的方向。显式传 `agent` 仍走普通 agent,保留可控回退。
- fork gate 开启时 `agent_task` schema 只暴露 `task/context/isolation`,隐藏 `agent/name/run_in_background/fork_context`,让模型看到的工具表面更接近 CC-Haha fork 实验下的 Agent 工具;gate 关闭时 schema 保持既有字段。
- 口径:这一步迁移的是受控隐式 fork gate 和 schema 收敛,不是最终默认全量开启。仍未完成 CC-Haha 的 bun feature flag、non-interactive/coordinator 排除、querySource 标记、foreground-to-background race、byte-exact rendered system prompt、AgentSummary cache-safe params 生命周期和 `/fork` slash command。
- 测试覆盖:`forkSubagent.test.ts` 覆盖 env gate opt-in;`agentTool.test.ts` 覆盖 gate off 时单 agent 默认不变、gate on 时 schema 隐藏字段且省略 agent 自动后台 fork,并携带父 system/messages/exact tools。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/agents/forkSubagent.test.ts src/agents/agentTool.test.ts src/tasks/taskTools.test.ts --timeout 60000` = 42 pass。

## 3.295 2026-07-08 CC-Haha fork querySource 身份标记迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` 的 `toolUseContext.options.querySource === agent:builtin:fork` guard 与 `~/Desktop/cc-haha-ref/src/tools/AgentTool/runAgent.ts` 的 `useExactTools && { querySource }` 传递。关键行为:fork child 保留 Agent 工具以维持 tool definitions,但即使 fork boilerplate 被压缩,仍要靠稳定运行来源识别自己并拒绝二次开子代理。
- `forkSubagent.ts` 新增 `FORK_QUERY_SOURCE = agent:builtin:fork` 与 `isForkQuerySource()`,并让 `buildForkRunContext()` 返回同一标记。这个标记不依赖消息文本,用于补足第 3.292 节的 message-scan fallback。
- `RunAgentLoopOptions` 与 `ToolContext` 新增 `querySource?: string`;同步 `agent_task fork_context` 与后台 `startBackgroundAgentRun(...,{forkContext})` 都会把 `forkContext.querySource` 传进 child loop,因此 child 内部工具执行时能看到稳定 fork 身份。
- `agent_task` 与 `start_background_agent_task` 的 recursive guard 改为 `isForkQuerySource(ctx.querySource) || isInForkChild(ctx.messages)`,对齐 CC-Haha “primary querySource, message fallback”的方向。这样压缩/摘要删掉 `<fork-boilerplate>` 后,child 仍不能绕过 guard 再启动子代理。
- 口径:这一步完成的是 fork child 身份标记和 guard 稳定性,不是完整 cache-safe params 生命周期。仍未完成 foreground-to-background race、byte-exact rendered system prompt、AgentSummary cache-safe params 生命周期、non-interactive/coordinator gate 排除和 `/fork` slash command。
- 测试覆盖:`forkSubagent.test.ts` 覆盖 `FORK_QUERY_SOURCE` 与 `buildForkRunContext()` 产出;`loop.test.ts` 覆盖 `querySource` 真实传入工具上下文;`agentTool.test.ts` 覆盖无 boilerplate 但有 `agent:builtin:fork` 时拒绝递归 `agent_task`;`taskTools.test.ts` 覆盖同条件下拒绝 `start_background_agent_task`。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/agents/forkSubagent.test.ts src/harness/loop.test.ts src/agents/agentTool.test.ts src/tasks/taskTools.test.ts --timeout 60000` = 106 pass;`git diff --check` clean。

## 3.296 2026-07-08 CC-Haha AgentSummary cache-safe params 生命周期迁移

- 对照源:`~/Desktop/cc-haha-ref/src/services/AgentSummary/agentSummary.ts` 与 `~/Desktop/cc-haha-ref/src/tools/AgentTool/runAgent.ts` 的 `onCacheSafeParams()`。关键行为:后台 agent 进度摘要不能用空工具/新 system 另起请求,而是复用 agent 已构造好的 system/tools/messages 前缀;每次摘要前从最新 transcript/messages 重建 `forkContextMessages`,避免 timer 长期 pin 初始 fork messages。
- `ts/src/tasks/agentSummary.ts` 新增 `AgentCacheSafeParams { system, tools, forkContextMessages }`。`startAgentSummarization()` 现在保存 base params(system/tools) 与最新 `forkContextMessages`,每次 summary tick 先清洗未完成 tool_use/空 assistant/thinking-only 消息,再拼接 summary prompt,继续携带完整 tools 以保持 cache key 形状。
- 后台 agent 仍通过 `runAgentLoop(... onSummarySnapshot)` 更新摘要参数,但 summary controller 不再持有整份旧 snapshot 对象;`updateSnapshot()` 只替换 base params 与最新 fork context。这个方向贴近 CC-Haha “drop forkContextMessages from closure; rebuild each tick from transcript”的生命周期,也为后续把 transcript sidecar 作为摘要来源留下接口形状。
- `taskTools.test.ts` 增强后台摘要断言:summary 请求必须看到主 agent 第二轮的 assistant/tool_result 上下文,证明摘要不是只基于启动时消息。新增 `agentSummary.test.ts` 直接覆盖 AgentSummary 用最新 clean fork context 重建请求、过滤未完成 tool_use、保留最新 system/tools。
- 口径:这一步完成的是 AgentSummary cache-safe params 显式化与最新 fork context 生命周期,不是完整 CC-Haha `runForkedAgent()`。仍未完成 foreground-to-background race、byte-exact rendered system prompt、non-interactive/coordinator gate 排除、真正独立 fork worker 和 `/fork` slash command。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/agentSummary.test.ts src/tasks/taskTools.test.ts -t "AgentSummary|cache-safe progress summaries" --timeout 60000` = 2 pass。

## 3.297 2026-07-08 CC-Haha rendered system prompt byte-exact 继承迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` 与 `~/Desktop/cc-haha-ref/src/tools/AgentTool/resumeAgent.ts` 的 `toolUseContext.renderedSystemPrompt` 优先路径。关键行为:fork child 要继承父会话已经渲染并发给模型的 system prompt 字节;只有缺少该字段时才 fallback 重建,否则动态上下文/feature gate/hook 注入可能改变 prompt cache 前缀。
- `ToolContext` 新增 `renderedSystemPrompt?: string`;`runAgentLoop()` 初始化时先填入原始 system prompt,在 worktree restore 与 SessionStart hook 注入后同步为最终 `system`。工具执行层因此能同时看到当前 `systemPrompt` 与 byte-exact `renderedSystemPrompt`。
- `buildForkRunContext()` 改为优先使用 `ctx.renderedSystemPrompt ?? ctx.systemPrompt`,让同步 `agent_task fork_context` 和后台 fork path 都继承父模型实际看到的 system prompt。这样父会话的 SessionStart/domain pack/动态 hook context 不会在 fork child 中丢失或被重新拼出不同字节。
- 测试覆盖:`forkSubagent.test.ts` 覆盖 rendered prompt 优先于 fallback prompt;`loop.test.ts` 覆盖 SessionStart 注入后工具上下文里的 `renderedSystemPrompt` 与最终 system 一致;`agentTool.test.ts` 覆盖真实 `agent_task fork_context` child 首轮请求包含父级 SessionStart 动态上下文。
- 口径:这一步完成的是 rendered system prompt byte-exact 继承通道,不是完整 foreground-to-background race、non-interactive/coordinator gate 排除、真正独立 fork worker 或 `/fork` slash command。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/agents/forkSubagent.test.ts src/harness/loop.test.ts src/agents/agentTool.test.ts --timeout 60000` = 88 pass。

## 3.298 2026-07-08 CC-Haha foreground-to-background handoff registry 地基迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` 的 `registerAgentForeground()`、`backgroundSignal`、`cancelAutoBackground` 与前台 sync agent 可被 `backgroundAll()` 接管的 race 结构。关键行为:同步 agent 启动后先登记一个前台 task id,外部或自动计时可以发出 background signal,AgentTool 之后用同一 task id 继续后台生命周期。
- `TaskService` 新增 `registerForegroundAgent(input,{autoBackgroundMs?})`,创建 `kind:background_agent` 的 queued foreground meta,写入 `agent/agent_id/task/name/context/foreground:true` 参数,并返回 `{ task, backgroundSignal, requestBackground, cancelAutoBackground }`。`requestForegroundAgentBackground(id)` 会把 meta 切到 `running`、标记 `foreground:false/is_backgrounded:true`、写入 context_note 并 resolve signal。
- 新增 `unregisterForegroundAgent(id)`:同步 agent 如果没有 handoff 就清理 foreground registry,并把仍处于 queued foreground 的 meta 收口为 completed/progress 100,避免留下悬空前台登记。request 后会释放 registry,重复 request 明确报 `not registered`。
- 测试覆盖:`taskService.test.ts` 覆盖 foreground agent 注册、background signal resolve、meta/status/params 转换、事件记录、重复 request 防重入,以及未 handoff 时 unregister 清理 queued foreground task。
- 口径:这一步迁移的是 foreground-to-background handoff 的 TaskService 底座,不是完整 AgentTool race 接入。下一步仍要把同步 `agent_task` 的 iterator loop 注册成 foreground task,在 `backgroundSignal` 和下一条模型消息之间 race,并在 handoff 后用同一 task id 继续后台 run。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/taskService.test.ts --timeout 60000` = 11 pass。

## 3.299 2026-07-08 CC-Haha AgentTool foreground registration 生命周期接入

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` 的同步 AgentTool 启动阶段:进入 sync agent loop 前立即 `registerAgentForeground()`,结束或失败时 `cancelAutoBackground()` + `unregisterAgentForeground()`,并避免未后台化的 foreground task 残留。
- `ts/src/agents/agentTool.ts` 新增 `registerForegroundAgent/unregisterForegroundAgent` 可选 hook。同步 `agent_task` 在确定稳定 `agentId` 后登记 foreground task,把 `agent/task/context/name/title/agentId` 下发给任务层;正常完成、模型失败、MCP/worktree 阶段失败都会进入同一 `finally` 清理。清理异常只写 subagent progress,不会阻断 MCP close 或 worktree cleanup。
- `ts/src/server/index.ts` 的真实 `/agent/run` 创建 `agent_task` 时已经把 hook 接到 `TaskService.registerForegroundAgent()` 和 `unregisterForegroundAgent()`。主服务不把可能超长的 `agent_id` 当 task id,而是让 TaskService 生成 task id,同时把稳定 `agent_id` 写入 params,为后续同一身份 handoff continuation 留下元数据。
- 测试覆盖:`agentTool.test.ts` 覆盖同步子代理正常完成会登记 foreground lifecycle、取消自动后台、注销 task,以及子代理失败时仍清理;`server/index.test.ts` 覆盖真实 `/agent/run` 调用 `agent_task` 后 `/tasks?conversationId=...` 能看到 completed foreground background_agent 记录和稳定 `agent_id`。
- 口径:这一步完成的是 AgentTool foreground registration 生命周期和主服务运行路径接入,不是完整 foreground-to-background race。下一步仍要把 `backgroundSignal` 与 `agentIterator.next()` race 起来,并在 handoff 后用同一 task id 接续后台 run、进度摘要、通知和 worktree 生命周期。

## 3.300 2026-07-08 CC-Haha foreground-to-background race 接管入口迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` 的 `Promise.race([agentIterator.next(), backgroundSignal])` 和 `LocalAgentTask.backgroundAgentTask()`。关键行为:同步 agent 已经登记为 foreground task 后,外部 background 操作应打断同步等待,用同一 task id 切到后台,父 loop 立即拿到 async/background started 结果继续执行。
- `agent_task` 同步路径现在在 subagent loop 内创建一次 `backgroundPromise`,每轮用它和 `agentIterator.next()` race。`backgroundSignal` 赢时会把当前 iterator 用 1s 超时收口,避免模型/MCP 清理卡住 handoff,然后调用 `handoffForegroundAgent()` 并返回 `<background_task_started ... status="running">`。已 handoff 的 foreground task 不再走 `unregisterForegroundAgent()`,也不会清理 worktree,避免把后台接管的 task 或工作区提前收掉。
- `startBackgroundAgentRun()` 新增显式 `handoffTaskId`。它只允许接管已经被 `TaskService.requestForegroundAgentBackground()` 标记为 `params.is_backgrounded === true` 的 foreground `background_agent`;普通 queued/running task 仍拒绝覆盖。接管时沿用同一 task id,合并 `foreground:false/is_backgrounded:true/foreground_handoff:true/agent_id` params,并复用既有后台 runner 的 transcript、metadata、summary、notification 与 SendMessage 接收能力。
- server 新增真实触发入口:`POST /tasks/:id/background` 与 legacy `POST /api/v1/agent/tasks/:id/background`,调用 `TaskService.requestForegroundAgentBackground()` 解析 foreground signal。`/agent/run` 创建 `agent_task` 时已把 `handoffForegroundAgent()` 接到 `startBackgroundAgentRun(...,{handoffTaskId})`,因此前端或快捷键可通过 task id 触发同 task id 后台接管。
- 测试覆盖:`agentTool.test.ts` 覆盖 background signal 赢过同步模型响应时返回 running background task、不调用 unregister;`taskTools.test.ts` 覆盖后台 runner 接管已 backgrounded foreground task id、保留稳定 `agent_id` 并完成 result/metadata;`server/index.test.ts` 覆盖真实 `/agent/run` + `/tasks/:id/background` 端到端 handoff。
- 口径:这一步完成的是 foreground-to-background race 的可触发接管入口和同 task id 后台 runner 接续,还不是 CC-Haha 完全等价的“复用已产生的前台消息继续跑”。当前后台接管会从后台 runner 的 task prompt 重新进入同一任务;worktree handoff 也仍需继续迁移为复用已经创建的 foreground worktree/cleanup ownership。下一步要继续复制/移植/改写前台 agent 已产生消息的 continuation、progress tracker 继承、AgentSummary snapshot 继承和 worktree handoff 复用。

## 3.301 2026-07-08 CC-Haha foreground handoff continuation snapshot 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` 中 handoff 后后台 `runAgent()` 继续消费 `agentMessages` 的结构。关键行为:前台 agent 已经完成的 tool_use/tool_result 不能在切后台后重复执行,后台 runner 必须带着前台已有 messages 继续跑。
- `runAgentLoop()` 的 `AgentLoopSnapshot` 新增 `contentReplacementState`。每次模型 step 前通过既有 `onSummarySnapshot` 输出 `{system,messages,tools,contentReplacementState}`,让 AgentTool 能拿到最新已压缩/已落盘替换状态的 messages snapshot,并把 tool-result replacement 状态一起交给后台 continuation。
- `agent_task` foreground handoff 现在把最新 `handoffSnapshot.messages` 与 `contentReplacementState` 传给 `handoffForegroundAgent()`。`startBackgroundAgentRun()` 接到 `input.initialMessages` 后会以这些 messages 为起点,设置 `skipUserMessage:true`,避免后台 runner 再追加一条重复 task user message;有 fork handoff snapshot 时也不再重复拼一次 `forkContext.initialMessages`。
- `TaskService`/后台 runner 仍沿用同 task id、metadata、transcript、tool-result store 与 SendMessage inbox。这样前台已经执行过的工具结果会作为后台首轮模型请求的历史上下文,后台可以直接继续下一步推理,而不是从头重跑任务。
- 测试覆盖:`agentTool.test.ts` 让前台先执行 `mark_step` 工具,再 background,断言 handoff input 带 user/tool_use/tool_result 三段 messages 和 contentReplacementState;`taskTools.test.ts` 断言 `startBackgroundAgentRun(...,{handoffTaskId})` 使用传入 handoff messages,不会重复追加普通 task prompt;`server/index.test.ts` 端到端断言真实 OpenAI chat 请求里的后台模型能看到前台 `list_dir` tool_call 及对应 tool result。
- 口径:这一步完成的是前台已产生 messages 的 handoff continuation snapshot,比 3.300 的“接管入口”更接近 CC-Haha;仍未完成 progress tracker/token usage 继承、foreground summarizer 到 background summarizer 的无缝转移、worktree handoff 复用和后台接管时的已运行 MCP/session cleanup 精细化。

## 3.302 2026-07-08 CC-Haha foreground handoff progress seed 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` handoff 后用已有 `agentMessages` 重建 `createProgressTracker()` 的逻辑。关键行为:前台 agent 已经完成过 tool_use/tool_result 时,后台 task 不应该从 0/启动阶段重新展示,否则用户会误以为任务重新开始。
- `startBackgroundAgentRun()` 在 `handoffTaskId + input.initialMessages` 存在时,会从 handoff messages 计算初始进度 seed:已看到的 tool_use 数、已完成的 tool_result 数和最近 stage。接管同一 task id 时写入 `progress/stage` 与 `params.handoff_tool_uses`,并保留 `foreground:false/is_backgrounded:true/foreground_handoff:true`。
- 后台 progress reporter 现在可从非 5 的 initial progress 起步。若 handoff 已有前台进度,后台 runner 不再立刻写“启动子代理”覆盖 stage,而是从“已接续前台进度:xxx 完成”继续递增;后续新后台事件仍按原进度模型更新到最终 completed/progress 100。
- 测试覆盖:`taskTools.test.ts` 断言 handoff 后 task 初始 progress > 0、stage 包含已接续前台工具完成、params 记录 `handoff_tool_uses:1`;`server/index.test.ts` 端到端断言真实 `/agent/run` + `/tasks/:id/background` 完成后 task params 保留 `handoff_tool_uses`。
- 口径:这一步完成的是 handoff 的轻量 progress seed 和工具数继承,不是完整 CC-Haha token usage tracker。仍未完成 token usage 精确继承、foreground/background AgentSummary 无缝转移、worktree handoff 复用和后台接管时的已运行 MCP/session cleanup 精细化。

## 3.303 2026-07-08 CC-Haha foreground handoff AgentSummary snapshot 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` handoff 时把前台 `agentMessages` 与 cache-safe params 交给后台 summarizer 的结构,以及 `~/Desktop/cc-haha-ref/src/services/AgentSummary/agentSummary.ts` 只保留 base params、每轮用最新消息重建 fork context 的生命周期。关键行为:用户把前台 agent 切到后台后,后台 task 的 summary 不应等后台 loop 第一轮模型请求之后才有上下文,而应立即继承前台最后一次模型请求前的 system/tools/messages snapshot。
- `agent_task` 的 handoff input 新增 `summarySnapshot`,直接携带前台 `runAgentLoop()` 已确认的 `{system,messages,tools,contentReplacementState}`。这份 snapshot 与第 3.301 节的 continuation messages 同源,因此包含前台已执行的 tool_use/tool_result,也保留前台实际可见工具列表和渲染后的 system prompt。
- `startBackgroundAgentRun()` 启动后台 `AgentSummary` 后会先用 `input.summarySnapshot` 调一次 `summarizer.updateSnapshot()`,再进入后台 SubagentStart hooks 和主 loop。这样即使后台主 loop 被 hook/MCP/启动阶段阻塞,summary timer 也能基于前台 handoff snapshot 先生成进行中摘要;后台 loop 后续仍会通过 `onSummarySnapshot` 用最新消息覆盖它。
- 测试覆盖:`agentTool.test.ts` 断言 foreground race handoff input 现在同时带 initialMessages、contentReplacementState 与 summarySnapshot,且 summarySnapshot 的 tools/system/messages 来自前台 agent loop;`taskTools.test.ts` 新增阻塞 SubagentStart hook 的 handoff summary 测试,证明后台主 loop 尚未前进时 summary 已用前台 snapshot 写回 task。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/agentSummary.test.ts src/tasks/taskTools.test.ts src/agents/agentTool.test.ts src/tasks/taskService.test.ts --timeout 60000` = 55 pass;`cd ts && bun test src/server/index.test.ts -t "exposes agent_task|background a foreground agent_task|notifies when a background subagent" --timeout 60000` = 3 pass。
- 口径:这一步完成的是 foreground/background AgentSummary handoff snapshot 继承,不是完整 CC-Haha token usage tracker 或 worktree ownership transfer。仍未完成 token usage 精确继承、foreground worktree 复用/清理权转移、handoff 时已运行 MCP/session cleanup 精细化和真正独立 fork worker。

## 3.304 2026-07-08 CC-Haha foreground handoff token usage tracker 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tasks/LocalAgentTask/LocalAgentTask.tsx#createProgressTracker/updateProgressFromMessage/getTokenCountFromTracker` 与 `~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` handoff 后用已有 `agentMessages` 重建 tracker 的逻辑。关键行为:Claude/Anthropic usage 里的 input 是当前上下文规模,不能按轮累加;前台切后台后,后台 usage 还必须继承前台累计 output/tool use,否则用户看到的后台成本和进度会像从 0 重启。
- `runAgentLoop()` 的 `usage_update` 口径改为 CC-Haha tracker 语义:`input_tokens/last_input_tokens` 表示当前这轮 input + cache read/create,`output_tokens` 表示累计 output,`total_tokens` 表示当前 input + 累计 output。新增 `initialUsage` 入参,后台 continuation 可把前台累计 output seed 进去,下一轮模型 usage 到来时继续累计而不是归零。
- `agent_task` foreground race 现在记录最新 `usage_update` 并通过 handoff input 的 `usageSnapshot` 传给 `startBackgroundAgentRun()`。后台 runner 启动时先把 seed usage 写入同 task id 的 params,随后每个后台 `usage_update` 覆盖为最新 usage summary;`tool_call` 后会刷新 `tool_uses`,避免事件顺序导致 usage 中工具数滞后一轮。
- `TaskOutput` / `read_background_task` 现在会从 `task.params.usage` 输出 CC-Haha 兼容 `<usage>` 段,包含 `total_tokens/input_tokens/output_tokens/last_*`、cache 字段、`tool_uses` 和 `duration_ms`。这样模型后续读取后台任务时能看到继承后的 usage,不是只能在事件流里翻历史。
- 测试覆盖:`loop.test.ts` 更新为 CC-Haha usage 口径并新增 `initialUsage` 继承测试;`agentTool.test.ts` 断言 foreground handoff input 带 usageSnapshot;`taskTools.test.ts` 断言 handoff 后后台 usage 继承前台 output、继续合并后台 usage,并在 `read_background_task` 与 `TaskOutput` 中输出 `<usage>`。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/harness/loop.test.ts src/tasks/taskTools.test.ts src/agents/agentTool.test.ts src/tasks/taskService.test.ts --timeout 60000` = 117 pass;`cd ts && bun test src/server/index.test.ts -t "exposes agent_task|background a foreground agent_task|notifies when a background subagent" --timeout 60000` = 3 pass。
- 口径:这一步完成的是 foreground/background token usage tracker 继承和 TaskOutput usage 露出,不是 worktree ownership transfer。仍未完成 foreground worktree 复用/清理权转移、handoff 时已运行 MCP/session cleanup 精细化和真正独立 fork worker。

## 3.305 2026-07-08 CC-Haha foreground handoff worktree ownership 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` 里 `worktreeInfo` 在前台 sync agent 与 backgrounded closure 之间共享、`cleanupWorktreeIfNeeded()` 只在后台完成/取消/失败后运行的结构。关键行为:前台 agent 已经在隔离 worktree 里读写文件时,切后台不能新建第二个 worktree,否则后台继续写到另一个目录,用户看到的文件状态会断裂。
- `ts/src/tools/worktreeTools.ts` 新增 `agentWorktreeFromSession(session)`,把已有 `WorktreeSession` 包装成可 cleanup 的 `AgentWorktree`,复用原来的 dirty-file/commit 检测和 clean worktree 删除逻辑。
- `agent_task` foreground handoff input 新增 `handoffWorktreeSession`。同步 agent 若以 `isolation:"worktree"` 运行,background signal 赢时会把前台创建的 worktree session 传给后台 runner;前台 `finally` 仍因 `wasBackgrounded` 跳过 cleanup,避免提前删除后台要继续使用的目录。
- `startBackgroundAgentRun()` 接到 `input.handoffWorktreeSession` 时优先 `agentWorktreeFromSession()` 并把后台 workspace/MCP/runtime metadata 都指向同一路径,不会再调用 `createIsolatedAgentWorktree()` 创建第二个 worktree。后台完成后仍由既有 cleanup/metadata 流程处理:clean 则移除,dirty 则保留并写回 metadata worktreePath。
- 测试覆盖:`agentTool.test.ts` 新增前台 worktree handoff 测试,断言 handoff input 携带 worktree session 且前台写入只在 worktree 内;`taskTools.test.ts` 新增后台 runner 复用 foreground worktree 测试,断言后台写入同一路径、主仓库未污染、metadata 指向前台 worktree,并记录 continued foreground worktree note。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/agents/agentTool.test.ts src/tasks/taskTools.test.ts src/tools/worktreeTools.test.ts --timeout 60000` = 53 pass;`cd ts && bun test src/server/index.test.ts -t "exposes agent_task|background a foreground agent_task|notifies when a background subagent" --timeout 60000` = 3 pass。
- 口径:这一步完成的是 foreground/background worktree 路径复用与 cleanup ownership 转移,不是 handoff 时已运行 MCP/session cleanup 的所有细枝末节。仍未完成 handoff MCP/session cleanup 精细化和真正独立 fork worker。

## 3.306 2026-07-08 CC-Haha foreground handoff MCP/session cleanup 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` 的 backgrounded closure。关键行为:前台 sync agent 切后台时先 `agentIterator.return(undefined)` 收口,让前台 runAgent 的 finally 释放 MCP connections、session hooks、prompt cache tracking 等运行时资源,再启动后台 continuation,并用 1s timeout 防止清理卡死 handoff。
- `agent_task` 现在在 `backgroundSignal` 赢得 race 后,先继续用 1s timeout 关闭前台 `agentIterator`,随后立即关闭前台 `agentMcp` runtime,把引用置空,再调用 `handoffForegroundAgent()`。这样后台 runner 不会在前台 MCP/session 仍由外层 finally 才开始释放时抢先启动。
- 新增 `closeAgentMcpForHandoff()` 专用路径:handoff 前的 MCP close 也有 1s timeout 且吞掉 close 异常,保证和 CC-Haha 一样“不因清理卡死而阻塞后台接管”。非 handoff 的同步 agent 仍由原来的 finally 完整 close MCP runtime,不改变普通完成/失败路径。
- `AgentTaskToolOptions` 新增内部 `loadAgentMcpRuntime` 注入点,只用于测试和未来 runtime 编排替换;生产默认仍走 `agentMcp.ts` 的真实 MCP loader。测试用 fake runtime 明确断言 `handoffForegroundAgent()` 被调用时 MCP close 已完成,并避免 finally 二次 close。
- 测试覆盖:`agentTool.test.ts` 新增 foreground MCP handoff close-order 测试,让前台 agent 已执行一次工具后被切后台,断言顺序为 MCP close start -> MCP close end -> handoff start。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/agents/agentTool.test.ts src/tasks/taskTools.test.ts src/tasks/taskService.test.ts --timeout 60000` = 57 pass;`cd ts && bun test src/server/index.test.ts -t "exposes agent_task|background a foreground agent_task|notifies when a background subagent" --timeout 60000` = 3 pass;`git diff --check` clean;禁词扫描 clean。
- 口径:这一步完成的是 foreground handoff 前台 iterator/MCP runtime 清理顺序,不是完整独立 fork worker。下一步继续复制/移植/改写真正独立 fork worker,并继续做前端远端来源/中间 diff/右侧预览的细颗粒 polish。

## 3.307 2026-07-08 CC-Haha fork worker worktree notice 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` 的 `isForkPath && worktreeInfo` 分支与 `~/Desktop/cc-haha-ref/src/tools/AgentTool/forkSubagent.ts#buildWorktreeNotice()`。关键行为:fork child 继承父会话完整上下文,但如果 child 实际运行在隔离 worktree,父上下文里的绝对/相对路径都指向父工作区;必须显式提醒 child 把路径翻译到 worktree root,并在编辑前重读文件。
- `startBackgroundAgentRun()` 现在在 `forkContext + isolation:"worktree"` 创建到 `agentWorktree` 后,把 `buildWorktreeNotice(ctx.workspace.root, agentWorktree.session.worktreePath)` 作为 user message 追加到 fork initial messages 之后。顺序对齐 CC-Haha:先继承父上下文和 fork directive,再追加 worktree notice,让最新上下文覆盖路径解释。
- handoff continuation 不重复追加该 notice:如果已有 `handoffInitialMessages`,后台接管走前台 snapshot,避免在 foreground handoff 后人为改写已发生的上下文。普通后台 agent worktree 行为不变,仍只写 isolated worktree context_note。
- 测试覆盖:`taskTools.test.ts` 新增真实 `agent_task -> startBackgroundAgentRun -> runAgentLoop` 链路测试,在 git 仓库内启动 `fork_context + run_in_background + isolation:"worktree"`,断言 child 模型首轮请求里 worktree notice 位于 directive 之后,且包含父 root、`.claude/worktrees` 路径、路径翻译和重读文件提醒。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/taskTools.test.ts --timeout 60000` = 24 pass;`cd ts && bun test src/server/index.test.ts -t "exposes agent_task|background a foreground agent_task|notifies when a background subagent" --timeout 60000` = 3 pass;`git diff --check` clean;禁词扫描 clean。
- 口径:这一步完成的是 fork worker 在隔离 worktree 下的路径上下文修正,不是完整 `/fork` slash command 或 CC-Haha feature gate 全量复刻。下一步继续复制/移植/改写真正独立 fork worker 的 `/fork` 入口、force-async gate 细节和 prompt 指南。

## 3.308 2026-07-08 CC-Haha fork force-async gate 与 prompt 指南迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/AgentTool/AgentTool.tsx` 的 `forceAsync = isForkSubagentEnabled()` 与 `shouldRunAsync` 组合,以及 `~/Desktop/cc-haha-ref/src/tools/AgentTool/prompt.ts` 的 `When to fork` / `Writing a fork prompt` 指南。关键行为:fork gate 开启后,不是只有省略 agent 的 fork 走后台,而是所有 Agent 调用统一 async;同时模型需要知道何时 fork、fork 后不要偷看后台输出、不要臆造结果、fork prompt 要写成 directive。
- `agent_task` 现在在 fork gate 开启时无条件 `wantsBackground=true`。显式传入 `agent:"researcher"` 这类专用 agent 时也会走 `startBackgroundAgent()`,不再同步占住父 loop;省略 agent 仍走 inherited-context fork path 并传 `ForkRunContext`。
- `forkSubagent.ts` 新增 `forkAgentToolDescription()`,把 CC-Haha 的核心 fork 使用纪律压缩进工具描述:什么时候 fork、什么时候指定 fresh agent、不要 read/tail 后台输出、不要预测 fork 结果、任务要写清 scope/输出/是否可改代码、fork gate 开启时所有 agent_task 都后台运行。
- 测试覆盖:`agentTool.test.ts` 增强 implicit fork gate 测试,断言 schema 仍隐藏 agent/run_in_background 字段且工具描述包含 `When to fork`、不要 tail 输出和 force-async 规则;新增显式 specialized agent 测试,证明 fork gate 开启时即使输入 `agent:"researcher"` 也只启动后台 task,不会触发同步模型 loop,且不会构造 fork context。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/agents/forkSubagent.test.ts src/agents/agentTool.test.ts src/tasks/taskTools.test.ts --timeout 60000` = 56 pass;`cd ts && bun test src/server/index.test.ts -t "exposes agent_task|background a foreground agent_task|notifies when a background subagent" --timeout 60000` = 3 pass;`git diff --check` clean;禁词扫描 clean。
- 口径:这一步完成的是 fork gate 的 force-async 运行时语义和工具层 prompt 指南,不是完整 `/fork` slash command。下一步继续复制/移植/改写 slash command 入口,让用户可以直接 `/fork <directive>` 触发同一 inherited-context 后台 worker。

## 3.309 2026-07-08 CC-Haha `/fork <directive>` 后台 worker 入口迁移

- 对照源:`~/Desktop/cc-haha-ref/src/commands.ts` 的 `FORK_SUBAGENT` gated `/fork` 注册、`~/Desktop/cc-haha-ref/src/utils/processUserInput/processSlashCommand.tsx` 的 forked slash command 执行入口,以及 `~/Desktop/cc-haha-ref/src/tools/AgentTool/forkSubagent.ts` 的 inherited-context worker 语义。关键行为:用户直接输入 `/fork <directive>` 时,不应把它当普通 prompt 交给模型猜工具调用,而应由命令入口启动继承父上下文的后台 fork worker。
- 新增 `ts/src/commands/builtinCommands.ts`:fork gate 开启时注册 built-in `/fork`,命令列表和 `/api/commands/expand` 都能看到 `allowedTools:["agent_task"]` 与 fork directive 指南。server 的命令加载现在合并文件命令、built-in 命令、领域包命令和 workspace 命令,并统一传入 `opts.env` 控制 gate。
- `/agent/run` 现在识别 built-in `/fork` 并在进入主模型循环前直接调用 `startBackgroundAgentRun(...,{ forkContext })`。`ForkRunContext` 来自当前 transcript、最终 system prompt 和完整工具注册表;返回 `<background_task_started ... agent="fork">`,写入 `command_invocation` 事件和 transcript,并在 task params 中标记 `fork_context:true` 与 `slash_command:"fork"`。
- 修复 `buildForkRunContext()` 的直接命令场景:当父会话最后一条 assistant 没有 tool_use 时,现在保留完整父消息再追加 fork directive,避免直接 `/fork` 丢掉最近 assistant 结论。已有 tool_use 的 fork path 仍保持 placeholder tool_result 前缀,继续最大化 cache 命中。
- 测试覆盖:`server/index.test.ts` 覆盖 fork gate 下 `/commands` 列出 built-in `/fork`、expand 包含 `agent_task` 指南,以及真实 `/agent/run` 输入 `/fork 审计 parser 边界` 会直接启动后台 fork worker、父上下文进入 child 首轮请求、外层不走普通 prompt;`forkSubagent.test.ts` 覆盖无 tool_use assistant 的上下文保留。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/commands/commandLoader.test.ts src/agents/forkSubagent.test.ts src/agents/agentTool.test.ts src/tasks/taskTools.test.ts --timeout 60000` = 63 pass;`cd ts && bun test src/server/index.test.ts -t "commands API|expands slash commands|workspace slash commands|starts built-in /fork|exposes agent_task|notifies when a background subagent|background a foreground agent_task" --timeout 60000` = 11 pass。
- 口径:这一步完成的是用户可直接使用的 `/fork <directive>` 后台 fork worker 入口,并复用既有 inherited-context、递归防护、后台通知、worktree notice 与任务系统。后续仍要继续迁移 CC-Haha 的通用 `context:fork` prompt command executor,让其它 slash command/skill 也能声明 fork 执行模式。

## 3.310 2026-07-08 CC-Haha `context: fork` prompt command executor 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/types/command.ts` 的 `PromptCommand.context?: 'inline' | 'fork'`、`agent?: string`,以及 `~/Desktop/cc-haha-ref/src/utils/processUserInput/processSlashCommand.tsx` 遇到 `command.context === 'fork'` 后进入 `executeForkedSlashCommand()` 的分支。关键语义:这是把命令展开后的 prompt 放到独立 command worker 里执行,不是 `/fork` 那条继承父完整对话的 inherited worker。
- `PromptCommand` 类型、markdown command loader 与 `SKILL.md` loader 现在都读取 `context: fork|inline` 和 `agent` frontmatter;`publicCommand()` 也会把这些字段暴露给前端/命令面板。这样命令、技能和领域包后续可以共享同一套声明字段,不再只靠正文提示模型自己拆分。
- `startBackgroundAgentRun()` 新增内部 `agentOverride` 入口,只给 server 直接执行器传临时 agent 用,不改变普通 `agent_task` 的 agent 选择/校验。`context: fork` 命令若 frontmatter 指定的 agent 存在,就用该 agent;否则创建 `command-<name>` 临时 worker,给全工具池、独立 transcript、后台通知、summary/MCP/task 管理。
- `/agent/run` 在主模型循环前识别 `matchedCommand.context === 'fork'`,直接用已展开的 command prompt 启动后台 command worker,记录 `command_invocation` 事件和 transcript,返回 `<background_task_started ... agent="command-...">`,并在 task params 标记 `command_context:"fork"` 与 `slash_command:<name>`。父会话历史不会进入 command worker,保持 CC-Haha 的独立上下文/独立 token budget 口径。
- 测试覆盖:`commandLoader.test.ts` 与 `skillLoader.test.ts` 覆盖 frontmatter 字段解析和公开;`server/index.test.ts` 覆盖真实 `/agent/run` 执行 `context: fork` slash command 时不把命令正文塞进主模型,而是启动后台 command worker,worker 首轮请求包含展开后的命令 prompt/参数且不包含父会话历史;`taskTools/agentTool/forkSubagent` 回归覆盖普通后台 agent 与 `/fork` 未被 `agentOverride` 影响。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/commands/commandLoader.test.ts src/skills/skillLoader.test.ts --timeout 60000` = 10 pass;`cd ts && bun test src/server/index.test.ts -t "context fork slash commands|commands API|expands slash commands|starts built-in /fork" --timeout 60000` = 8 pass;`cd ts && bun test src/tasks/taskTools.test.ts src/agents/agentTool.test.ts src/agents/forkSubagent.test.ts --timeout 60000` = 57 pass;`git diff --check` clean;禁词扫描 clean。
- 口径:这一步完成的是 prompt command 的 `context: fork` 后台执行器和 frontmatter 声明链路。后续仍要把 SkillTool 式主动 skill 调用也接到同一个执行器,并继续做 command agent 的 allowedTools 权限语义、进度 UI drill-in 和前端命令面板标识。

## 3.311 2026-07-08 CC-Haha SkillTool 主动调用与 `context: fork` 技能执行迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/SkillTool/SkillTool.ts` 的 `SkillTool.call({ skill,args })`、inline/fork 双路径,以及 `executeForkedSkill()` 里把 skill prompt 放入独立 agent 运行的结构。关键行为:模型不仅能 `list_skills/read_skill`,还要能主动“执行”某个 skill;当 skill 声明 `context: fork` 时,执行应走独立 worker,不把父会话历史和主模型 token budget 混进去。
- `createSkillTools()` 新增 `use_skill` 工具,输入对齐 CC-Haha 主字段 `{ skill,args? }`,并兼容 `{ name,args? }`。普通 inline skill 返回展开后的 skill prompt,让当前模型继续按 skill 指南执行;`read_skill` 仍保持只读渐进披露,不被偷换成执行动作。
- `buildGeneralRegistry()` 新增 `executeSkill` 回调透传。主 server 给 `use_skill` 注入执行器:若 skill.context 不是 `fork`,返回展开 prompt;若为 `fork`,用上一节的 prompt worker 机制创建 `skill-<name>` 临时 worker,调用 `startBackgroundAgentRun(...,{ agentOverride })`,写入 task params `skill:<name>` 与 `skill_context:"fork"`。
- `use_skill` 加入 `tool_search` 热工具和中英文别名,确保大工具池懒加载时它仍是模型首轮可见的一等执行工具,不会只藏在 `tool_search` 后面。后台 worker 继续复用任务系统、通知、MCP、summary、transcript、TaskOutput/AgentOutputTool 回读能力。
- 测试覆盖:`skillLoader.test.ts` 覆盖 `use_skill` inline 展开和 args 注入;`server/index.test.ts` 覆盖真实 `/agent/run` 中模型调用 `use_skill({skill:"poster-maker"})`,当该 skill 声明 `context: fork` 时启动后台 `skill-poster-maker` worker,worker 首轮请求包含 skill prompt/args 且不包含父会话历史;`toolSearchTool.test.ts` 覆盖 `use_skill` 进入可见/可搜工具池;`taskTools/agentTool/forkSubagent` 回归确认普通后台 agent 与 inherited fork 未受影响。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/server/index.test.ts -t "context fork skills|pack recommendations|context fork slash commands|starts built-in /fork" --timeout 60000` = 4 pass;`cd ts && bun test src/commands/commandLoader.test.ts src/skills/skillLoader.test.ts src/tools/toolSearchTool.test.ts --timeout 60000` = 15 pass;`cd ts && bun test src/tasks/taskTools.test.ts src/agents/agentTool.test.ts src/agents/forkSubagent.test.ts --timeout 60000` = 57 pass。
- 口径:这一步完成的是模型主动调用 skill 的执行工具与 `context: fork` 技能后台 worker。后续仍要继续迁移 CC-Haha SkillTool 的权限/allow/deny 规则语义、allowedTools 注入、进度消息 drill-in 和 invoked skill 压缩恢复。

## 3.312 2026-07-08 CC-Haha SkillTool allowedTools 注入语义迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/SkillTool/SkillTool.ts` 里 inline SkillTool 返回 `allowedTools` 并通过 contextModifier 扩展 `alwaysAllowRules.command`,以及 `~/Desktop/cc-haha-ref/src/utils/forkedAgent.ts` 的 `createGetAppStateWithAllowedTools()` / `prepareForkedCommandContext()`。关键行为:skill/command frontmatter 声明的 allowedTools 不能只作为展示字段存在,执行时也要进入 worker 的实际工具边界。
- 新增 `ts/src/commands/allowedTools.ts`,集中归一化 imported skill/command manifests 的工具名。支持 `Read -> read_file/read_many_files`、`Grep -> grep_files`、`Glob -> glob_files`、`Edit -> edit_file`、`MultiEdit -> multi_edit_file`、`Write -> write_file`、`Bash(...) -> run_command`、`Task -> agent_task` 等常用映射;未知工具名原样保留,避免误伤 MCP/插件工具。
- markdown command loader 与 `SKILL.md` loader 现在读取 frontmatter 后立即归一化 `allowedTools/allowed_tools`。这样直接搬来的 skill/command 不必先手改工具名,前端公开字段、`list_skills` 搜索、`publicCommand()` 和 worker 执行都会看到 TS 可用的工具名。
- `use_skill` inline 执行现在通过 `<skill_allowed_tools>` block 暴露技能声明的 allowed tools;`read_skill` 仍保持纯只读披露。主 server 的 `executeSkill` 同步使用这个格式,保证模型主动执行 inline skill 时能看到技能工具边界。
- `context: fork` skill/command 的临时 worker agent 现在把 `allowedTools` 转成 `agent.tools` 白名单传给 `startBackgroundAgentRun()`。若 frontmatter 指定了已有 agent,也会以该 agent 为底座叠加本次 skill/command 的工具白名单;`*` 仍表示不收窄工具池。真实 worker 首轮模型请求中的 tool schema 会被缩到 allowedTools,不是只在 task params 里记录。
- 测试覆盖:`skillLoader.test.ts` 覆盖 `use_skill` 输出 `<skill_allowed_tools>` 且 `Read/Bash(...)` 归一化;`commandLoader.test.ts` 覆盖 slash command frontmatter 的同名归一化;`server/index.test.ts` 覆盖 `context: fork` skill 和 slash command worker 的模型请求 tool list 真的被缩到 `read_file`。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/server/index.test.ts -t "context fork skills|pack recommendations|context fork slash commands|starts built-in /fork" --timeout 60000` = 4 pass;`cd ts && bun test src/commands/commandLoader.test.ts src/skills/skillLoader.test.ts src/tools/toolSearchTool.test.ts --timeout 60000` = 15 pass;`cd ts && bun test src/tasks/taskTools.test.ts src/agents/agentTool.test.ts src/agents/forkSubagent.test.ts --timeout 60000` = 57 pass;`git diff --check` clean;禁词扫描 clean。
- 口径:这一步完成的是 SkillTool/command `allowedTools` 的声明归一化、inline 可见性和 fork worker 实际工具白名单。仍未完成 invoked skill 跨压缩恢复、会话级 always-allow 权限上下文、以及前端 drill-in 对 worker 事件/allowed tool 边界的可视化。

## 3.313 2026-07-08 CC-Haha invoked skill 压缩恢复迁移

- 对照源:`~/Desktop/cc-haha-ref/src/bootstrap/state.ts` 的 `addInvokedSkill/getInvokedSkillsForAgent`, `~/Desktop/cc-haha-ref/src/services/compact/compact.ts` 的 `createSkillAttachmentIfNeeded()`,以及 `~/Desktop/cc-haha-ref/src/utils/conversationRecovery.ts` 的 `restoreSkillStateFromMessages()`。关键行为:SkillTool 真正执行过的 skill 必须跨压缩保留,否则摘要后模型只记得“用了一个技能”,但丢掉技能正文/约束/工作流。
- 新增 `ts/src/skills/invokedSkills.ts`,按 `conversationId`/background agent stable id 作为 scope 记录 `{skillName, skillPath, content, invokedAt}`。这对齐 CC 的 agentId 隔离思路:主会话、后台 worker、sidechain 不互相泄露 invoked skill 状态。
- `use_skill` 默认执行和 server 注入的 `executeSkill` 都会在展开 skill prompt 后调用 `recordInvokedSkill()`。`read_skill` 仍然只读披露,不会登记为“已执行技能”;`context: fork` skill 也会记录展开后的技能内容,保证父会话压缩后仍知道这次 skill worker 的执行说明。
- TS 内部没有 attachment message 类型,因此恢复载体采用普通 user text block:`<invoked_skills><invoked_skill ...>...</invoked_skill></invoked_skills>`。`createInvokedSkillsMessage()` 按最近调用优先、单技能 16k chars、总计 48k chars 裁剪;`restoreInvokedSkillsFromMessages()` 可从已有 transcript 文本块重建状态,支持 resume 后再次压缩。
- `compactPipeline()` 新增 `postSummaryMessages` 插槽,把摘要后必须保留的上下文插在 `[此前对话摘要]` 后、recent messages 前。`runAgentLoop()` 每次压缩时把当前 scope 的 invoked skills 注入该插槽,然后继续沿用既有最近文件上下文恢复;`archiveSession()` 也会先从 transcript 恢复 invoked skills,再把它们写入手动归档压缩结果。
- 测试覆盖:`invokedSkills.test.ts` 覆盖 scope 隔离、压缩消息格式和从消息恢复;`skillLoader.test.ts` 覆盖 `use_skill` 执行后登记 invoked skill;`compaction.test.ts` 覆盖 `postSummaryMessages` 被插在摘要后;`loop.test.ts -t compaction` 回归自动压缩和最近文件恢复不受影响。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/skills/invokedSkills.test.ts src/skills/skillLoader.test.ts src/context/compaction.test.ts src/harness/loop.test.ts --timeout 60000` = 77 pass;`cd ts && bun test src/server/index.test.ts -t "context fork skills|pack recommendations|context fork slash commands|starts built-in /fork|archive" --timeout 60000` = 5 pass;`cd ts && bun test src/tasks/taskTools.test.ts src/agents/agentTool.test.ts src/agents/forkSubagent.test.ts --timeout 60000` = 57 pass。
- 口径:这一步完成的是 invoked skill 的执行登记、压缩后消息注入、resume/归档时从 transcript 恢复。仍未完成 CC 的会话级 always-allow permission context、skill hooks 的完整注册/恢复、以及前端 worker drill-in 对 invoked skill/allowed tools 的可视化。

## 3.314 2026-07-08 CC-Haha allowedTools 会话级权限上下文迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/SkillTool/SkillTool.ts` 的 inline `contextModifier()` 把 skill `allowedTools` 合入 `toolPermissionContext.alwaysAllowRules.command`,以及 `~/Desktop/cc-haha-ref/src/utils/processUserInput/processSlashCommand.tsx` 返回 `allowedTools` 给主 loop。关键行为:inline skill/command 的 allowedTools 不能只改变提示词,还必须影响后续工具审批。
- `ToolContext` 新增 `sessionAllowedTools?: Set<string>`,`commands/allowedTools.ts` 新增 `addAllowedToolsToContext()`。`runAgentLoop()` 支持 `initialAllowedTools`,用于普通 slash command 进入主 loop 前注入 frontmatter allowedTools;`use_skill` inline 执行成功后动态把 skill allowedTools 追加到同一个 ctx。
- `resolvePermission()` 新增 `sessionAllowedTool` 决策原因。顺序保持保守红线:仍先检查 fatal、plan mode、无需审批动作、forceConfirm、requiresUserInteraction;只有普通 requiresApproval 动作才会被 sessionAllowedTools 放行。也就是说 skill/command 授权不会越过危险命令硬拒、计划模式、必须用户交互或强确认动作。
- `context: fork` skill/command 不走父会话 `sessionAllowedTools`,继续使用 3.312 的 worker `agent.tools` 白名单;这避免 fork worker 的工具授权泄漏回父会话。普通 slash command 若声明 `allowedTools: [Bash]`,server 会把归一化后的 `run_command` 传给 `runAgentLoop(initialAllowedTools)`。
- 测试覆盖:`resolve.test.ts` 覆盖 sessionAllowedTools 放行普通审批且不越过 plan/fatal/forceConfirm/userInteraction;`skillLoader.test.ts` 覆盖 `use_skill` 后 ctx 中出现 `read_file/read_many_files/run_command`;`loop.test.ts` 覆盖 ask 档下先 `use_skill(allowedTools:[Bash])` 后 `run_command` 写文件无需 approval_request;`server/index.test.ts` 覆盖 slash command `allowedTools:[Bash]` 经 `/agent/run` 进入主 loop 并放行后续 `run_command`。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/permissions/resolve.test.ts src/permissions/types.test.ts src/skills/skillLoader.test.ts src/commands/commandLoader.test.ts src/harness/loop.test.ts src/server/index.test.ts -t "sessionAllowedTools|use_skill|allowedTools grants|slash command allowedTools|context fork skills|context fork slash commands|starts built-in /fork|expands slash commands" --timeout 60000` = 8 pass;`cd ts && bun test src/tasks/taskTools.test.ts src/agents/agentTool.test.ts src/agents/forkSubagent.test.ts src/tools/replTool.test.ts --timeout 60000` = 62 pass。
- 口径:这一步完成的是 inline SkillTool/slash command 的会话级 always-allow 等价语义,但只覆盖工具名级授权;尚未复制 CC 对 `Bash(git:*)` 这类命令参数级 allow rule 的精细匹配,也未完成 skill hooks 的恢复和前端 drill-in 可视化。

## 3.315 2026-07-08 CC-Haha `Bash(...)` 参数级 allowedTools 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/permissions/permissionSetup.ts` 的 `parseToolListFromCLI()` 与 `allowedTools` 中 `Bash(git:*)` 这类参数级命令规则。关键行为:映射到 TS 时不能把 `Bash(git:*)` 简化成全量 `run_command` 放行,否则 skill/command 会获得比声明更宽的 shell 权限。
- `PromptCommand` 新增 `allowedToolRules?: string[]`,command loader 与 `SKILL.md` loader 同时保存 raw frontmatter 规则和 normalized `allowedTools`。normalized `allowedTools` 仍用于前端展示、工具可见性和 fork worker `agent.tools`;raw `allowedToolRules` 用于会话权限匹配。
- `addAllowedToolsToContext()` 现在识别 `Bash(<pattern>)`:不再把它加入 `sessionAllowedTools` 的全量工具名集合,而是写入 `sessionAllowedToolRules:[{tool:"run_command",commandPattern:<pattern>}]`。未带参数的 `Bash` 仍按工具名级规则放行 `run_command`。
- `resolvePermission()` 在普通审批前检查参数级规则。当前支持 `run_command` 的 `command` 前缀匹配:`git:*` 匹配 `git status --short`,`printf:*` 匹配 `printf ok > file`;不匹配的 shell 命令继续走 ask/auto_files/full 原权限瀑布。fatal、plan、forceConfirm、requiresUserInteraction 仍在参数级 allowed rule 之前。
- 测试覆盖:`resolve.test.ts` 覆盖 `Bash(git:*)` 等价规则只放行 `git ...` 不放行 `printf ...`;`commandLoader.test.ts`/`skillLoader.test.ts` 覆盖 raw `allowedToolRules` 不丢失;`loop.test.ts` 和 `server/index.test.ts` 把之前的 `Bash` 改成 `Bash(printf:*)`,证明 inline skill 与 slash command 只靠参数级规则即可在 ask 档放行匹配命令。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/permissions/resolve.test.ts src/permissions/types.test.ts src/commands/commandLoader.test.ts src/skills/skillLoader.test.ts src/harness/loop.test.ts src/server/index.test.ts -t "sessionAllowedTools|use_skill|allowedTools grants|slash command allowedTools|context fork skills|context fork slash commands|starts built-in /fork|expands slash commands|loadCommandsDir|loadSkillsDir" --timeout 60000` = 10 pass;`cd ts && bun test src/tasks/taskTools.test.ts src/agents/agentTool.test.ts src/agents/forkSubagent.test.ts src/tools/replTool.test.ts --timeout 60000` = 62 pass。
- 口径:这一步完成的是 `Bash(...)` 参数级 allowedTools 的最小等价迁移。仍未覆盖更复杂 shell glob/多命令解析、非 Bash 工具的参数级规则、skill hooks 完整恢复和前端 worker drill-in 可视化。

## 3.316 2026-07-08 CC-Haha skill frontmatter hooks 注册与恢复迁移

- 对照源:`~/Desktop/cc-haha-ref/src/skills/loadSkillsDir.ts` 的 `parseHooksFromFrontmatter()`、`~/Desktop/cc-haha-ref/src/utils/processUserInput/processSlashCommand.tsx` 的 `registerSkillHooks()` 调用点,以及 `~/Desktop/cc-haha-ref/src/utils/hooks/registerSkillHooks.ts` 的 session hook 注册语义。关键行为:执行 skill 不能只展开正文和 allowedTools,还要把 `hooks` frontmatter 注册为当前会话可继续触发的 hook。
- `PromptCommand` 新增 `hooks?: HookRegistry`, `SKILL.md` loader 现在用既有 `normalizeHookRegistry()` 解析 skill frontmatter 的 event map/rules/hooks 格式。这样直接搬来的 skill 能复用 command/http/prompt/agent hook executor、PreToolUse/PostToolUse/Stop/UserPromptSubmit/SessionStart/SubagentStart/SubagentStop 事件和 agent Stop -> SubagentStop 既有语义。
- `use_skill` inline 执行现在在记录 invoked skill、注入 allowedTools 后,继续把 skill hooks 合入 `ToolContext.sessionHooks`。`runAgentLoop()` 新增动态 hooks 合并:SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop 触发点、只读并行判定和 Stop hook goal 逻辑都会读取“基础 hooks + 当前会话 skill hooks”,因此同一批 tool calls 内先 `use_skill`、后 `write_file` 也会立刻被 skill hook 改写或拦截。
- server 侧新增 conversationId 隔离的 `sessionSkillHooks` 映射,`runAgentLoop()` 支持 `initialSessionHooks/onSessionHooksChanged`。inline skill 注册出的 hooks 会保存到当前 conversation,下一轮 `/agent/run` 继续合并,贴近 CC-Haha 的 session-scoped hook 行为,同时不会把全局 hooks、goal hooks 或其它 conversation 的 hooks 混进去。
- `context: fork` skill/command worker 的临时 agent 现在也会携带 prompt command 的 hooks;如果 frontmatter 指定已有 agent,则把已有 agent hooks 与 skill hooks 合并。这样 fork skill worker 启动时能收到 skill 的 SubagentStart/SubagentStop/Stop 等 hook 上下文,而不是只继承 agent 本身的 hooks。
- `normalizeHookRegistry()` 新增 `once: true` 支持:静态 decision、command/http/prompt/agent hook 首次成功返回决策后不再触发,对齐 CC-Haha `registerSkillHooks()` 里 one-shot hook 执行后移除的语义。
- 测试覆盖:`skillLoader.test.ts` 覆盖 `SKILL.md` frontmatter hooks 解析;`loop.test.ts` 覆盖同一 tool-call 批次内 inline `use_skill` 注册 hook 后拦截后续 `write_file`;`server/index.test.ts` 覆盖 fork skill worker 接收 SubagentStart hook,以及 inline skill hook 跨 `/agent/run` turn 按 conversationId 持久化;`hookConfig.test.ts` 覆盖 `once: true` hook 第二次不再触发。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/hooks/hookConfig.test.ts src/skills/skillLoader.test.ts src/harness/loop.test.ts src/server/index.test.ts -t "frontmatter event map|once hooks|loadSkillsDir|inline use_skill registers skill hooks|inline use_skill allowedTools|context fork skills|persists inline skill hooks" --timeout 60000` = 7 pass;`cd ts && bun test src/hooks/hookConfig.test.ts src/hooks/hooks.test.ts src/agents/agentTool.test.ts src/tasks/taskTools.test.ts -t "frontmatter|hooks|SubagentStart|SubagentStop|runs agent frontmatter|once hooks" --timeout 60000` = 10 pass;`git diff --check` clean;禁词扫描 clean。
- 口径:这一步完成的是 skill frontmatter hooks 的解析、inline 注册、同轮即时生效、跨 turn session 恢复、fork worker 合并和 `once` 语义。仍未覆盖更复杂参数级 allowedTools、非 Bash 参数规则、插件 trust gate 的细粒度开关和前端 worker drill-in 可视化。

## 3.317 2026-07-08 CC-Haha permission rule parser 与 shell wildcard allowedTools 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/permissions/permissionSetup.ts` 的 `parseToolListFromCLI()`、`~/Desktop/cc-haha-ref/src/utils/permissions/permissionRuleParser.ts` 的 `permissionRuleValueFromString()`、以及 `~/Desktop/cc-haha-ref/src/utils/permissions/shellRuleMatching.ts` 的 exact/prefix/wildcard matcher。关键行为:allowedTools 里的 `Tool(content)` 不能只用正则粗拆,括号内空格/逗号、转义括号、`Bash(git status *)` wildcard、`Bash(git status)` exact 都要按 permission rule 语义处理。
- 新增 `ts/src/permissions/permissionRules.ts`,移植核心 parser:支持 `Tool`、`Tool(*)`、`Tool(content)`、转义括号 `\\(`/`\\)`,并把 CLI/frontmatter 字符串按空格或逗号切分,但保留括号内部的空格/逗号。这样 `allowedTools: 'Read Bash(git status *) Bash(node -e "a,b")'` 会拆成三条规则,而不是一个坏字符串。
- shell matcher 从单一 `prefix:*` 扩展为三类:exact (`git status` 只匹配裸命令)、legacy prefix (`git:*` 匹配 `git ...`)、wildcard (`git status *` 匹配 `git status` 和 `git status --short`)。`\*` 保持字面 exact 语义,不误当 wildcard。
- `commands/allowedTools.ts` 现在用 permission rule parser 提取 toolName,再做 CC 名称到 TS 工具名映射。`Bash(...)` 和 `PowerShell(...)` 都会写入 `ToolContext.sessionAllowedToolRules` 的 `{tool, ruleContent}`;无 `ruleContent` 的 `Bash`/`PowerShell` 仍是工具级 allow。
- `resolvePermission()` 的 session 参数级规则现在复用 shell matcher,支持 `run_command` 与 `PowerShell` 两个 shell 工具;原有红线顺序不变: fatal、plan、forceConfirm、requiresUserInteraction 仍先于 allowedTools,不会被 skill/command 授权绕过。
- command/skill loader 改用 `allowedToolRulesFromFrontmatter()`,frontmatter 的数组和字符串都走同一套 CC-style list parser。normalized `allowedTools` 仍用于工具展示和 fork worker 工具白名单,raw `allowedToolRules` 用于会话 permission matching。
- 测试覆盖:`permissionRules.test.ts` 覆盖转义括号、`Tool(*)`、括号内空格/逗号保留、exact/prefix/wildcard/`\*` 字面规则;`resolve.test.ts` 覆盖 `run_command` 的 exact/wildcard 与 `PowerShell(Get-ChildItem *)`;`commandLoader.test.ts` 覆盖 space-separated allowedTools frontmatter;`skillLoader/harness/server` 回归覆盖 inline skill 与 slash command allowedTools 仍能放行匹配命令。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/permissions/permissionRules.test.ts src/permissions/resolve.test.ts src/commands/commandLoader.test.ts src/skills/skillLoader.test.ts --timeout 60000` = 31 pass;`cd ts && bun test src/harness/loop.test.ts src/server/index.test.ts -t "allowedTools|context fork skills|context fork slash commands|starts built-in /fork" --timeout 60000` = 5 pass。
- 口径:这一步完成的是 allowedTools/permission rule 的 parser、frontmatter 字符串切分、Bash/PowerShell exact/prefix/wildcard shell 规则。仍未搬完整 Bash 安全分析器的 compound-command 子命令拆分、wrapper/env-var 规范化、deny/ask rule 优先级,也未覆盖文件工具的 path-scoped permission rules 和前端 worker drill-in 可视化。

## 3.318 2026-07-08 CC-Haha context fork worker allowedTools session permissions 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/forkedAgent.ts#createGetAppStateWithAllowedTools/prepareForkedCommandContext` 与 `~/Desktop/cc-haha-ref/src/tools/AgentTool/runAgent.ts` 的 allowedTools session 规则注入。关键行为:`context: fork` command/skill worker 的 `allowedTools` 不能只收窄模型可见工具 schema,还必须进入 worker 自己的权限上下文,否则 ask 档下匹配声明的 shell/file 动作仍会卡审批。
- `AgentDefinition` 新增内部 `allowedToolRules?: string[]`,专门承载从 command/skill frontmatter 保留下来的 raw permission rules。server 构造临时 fork worker agent 时,把 `prompt.allowedToolRules ?? prompt.allowedTools` 放入该字段;若 frontmatter 指定已有 agent,也在叠加 worker 工具白名单和 hooks 时同步带上这次 command/skill 的 permission rules。
- `startBackgroundAgentRun()` 与同步 `agent_task` 子代理入口现在都会把 `agent.allowedToolRules` 传给 `runAgentLoop(initialAllowedTools)`。这样 background command worker、background skill worker 和 foreground/sync subagent 走同一条会话级 allowedTools 注入链路,复用 3.314-3.317 的工具名/参数级规则匹配,不会另造一套审批旁路。
- 新增端到端回归:创建 `context: fork` slash command,frontmatter 声明 `allowedTools:["Bash(printf:*)"]`,server 在 `permissionMode:"ask"` 下让 worker 调用 `run_command` 写文件。断言文件成功写入、task 完成、事件流没有 `approval_request`,证明 fork worker 的 session permission 真实生效。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tasks/taskTools.test.ts src/agents/agentTool.test.ts src/server/index.test.ts -t "allowedTools|context fork|agent frontmatter|start_background_agent_task|agent_task honors" --timeout 60000` = 16 pass;`cd ts && bun test src/tasks/taskTools.test.ts src/agents/agentTool.test.ts src/server/index.test.ts --timeout 60000` = 149 pass。
- 口径:这一步补齐的是 fork worker 的 session-level allowedTools 权限注入,使 3.312 的“工具白名单”不再停留在可见 schema 层。仍未搬完整 Bash 安全分析器的 compound-command 子命令拆分、wrapper/env-var 规范化、deny/ask rule 优先级、文件工具 path-scoped permission rules,也未完成前端 worker drill-in 对 allowed tool 边界的可视化。

## 3.319 2026-07-08 CC-Haha Bash allowedTools wrapper/env/compound matching 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/bashPermissions.ts#stripSafeWrappers/filterRulesByContentsMatchingInput/bashToolCheckPermission` 与 `~/Desktop/cc-haha-ref/src/utils/bash/commands.ts#splitCommand_DEPRECATED`。关键行为:`Bash(git:*)` 这类 allow rule 不能直接拿整条 shell 字符串做 `startsWith`,否则 `git status && curl ...` 会被单条 git 规则误放行;同时 `NODE_ENV=test npm run build`、`timeout 10 npm run build` 这类安全前缀又应该能匹配用户声明的 `Bash(npm run *)`。
- `permissionRules.ts` 新增 TS 版轻量 shell permission normalizer:复制 CC-Haha safe env allowlist 的外部可用部分,只剥离无代码执行能力的 leading env var;移植 `timeout/time/nice/stdbuf/nohup` safe wrapper pattern,且保持 CC-Haha 的两阶段语义:wrapper 之后不再剥离 env var,避免 `nohup NODE_ENV=test npm run build` 被错误当成 `npm run build`。
- 新增 `splitShellCommandsForPermission()` 和 `shellCommandAllowedByPermissionRules()`。prefix/wildcard 规则不再匹配未拆分的 compound command;复合命令必须每个子命令各自命中某条 allow rule,例如 `git status && printf ok` 只有同时声明 `Bash(git:*)` 和 `Bash(printf:*)` 才会放行。exact 规则仍可精确匹配整条命令。
- `resolvePermission()` 对 `run_command` 的 sessionAllowedToolRules 从“任意一条规则匹配整条 command 即放行”改为“整组 Bash 规则共同判定”。PowerShell 规则暂时保持上一阶段 exact/wildcard matcher,不套用 Bash wrapper/env/compound 逻辑。
- 测试覆盖:`permissionRules.test.ts` 覆盖 safe env、unsafe `PATH`、安全 wrapper、恶意 timeout flag 不剥离、quoted `&&` 不误拆、compound command 必须逐子命令匹配;`resolve.test.ts` 覆盖 ask 档下 `NODE_ENV=test npm run build`/`timeout 10 ...` 放行,`PATH=...`/`timeout -k$(id)` 不放行,以及单条 `git:*` 不能放行 `git status && printf ok`;`runCommandTool.test.ts` 回归确认 run_command 动态权限不回退。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/permissions/permissionRules.test.ts src/permissions/resolve.test.ts --timeout 60000` = 22 pass;`cd ts && bun test src/commands/commandLoader.test.ts src/skills/skillLoader.test.ts src/harness/loop.test.ts src/server/index.test.ts -t "allowedTools|sessionAllowedTools|slash command allowedTools|context fork command allowedTools|inline use_skill allowedTools|loadCommandsDir parses space-separated" --timeout 60000` = 4 pass;`cd ts && bun test src/tools/runCommandTool.test.ts src/permissions/permissionRules.test.ts src/permissions/resolve.test.ts --timeout 60000` = 46 pass。
- 口径:这一步完成的是 Bash allowedTools 规则匹配层的 wrapper/env-var 规范化和 compound-command 逐子命令 gate,不是完整 CC-Haha tree-sitter AST 安全分析器。仍未搬 `parseForSecurityFromAst/checkSemantics`、heredoc/command-substitution classifier、deny/ask rule 配置面、sed/path constraints 的全部语义、文件工具 path-scoped permission rules 和前端 allowed tool drill-in。

## 3.320 2026-07-08 CC-Haha 文件工具 path-scoped allowedTools 边界迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/permissions/filesystem.ts#pathInAllowedWorkingPath`、`~/Desktop/cc-haha-ref/src/utils/permissions/pathValidation.ts#isPathAllowed`、`~/Desktop/cc-haha-ref/src/components/permissions/FilePermissionDialog/usePermissionHandler.ts` 与 sandbox adapter 中 `Read(...)`/`Edit(...)` 规则进入 allowRead/allowWrite 的路径。关键行为:`Read(/some/dir/**)`、`Edit(~/.claude/**)` 这类 ruleContent 不能只作为字符串保存在 sessionAllowedToolRules;文件工具解析路径时必须能把它当作受限的边界例外。
- 新增 `ts/src/permissions/filePathRules.ts`:先调用原 `Workspace.resolve()` 保持工作区内路径原行为;只有命中 `WorkspaceBoundaryError` 时,才用当前 session 的 path-scoped rule 判断外部绝对目标是否允许。规则支持 exact path、workspace-relative path、`~` 展开和常用 glob/`/**` 目录递归;仍复用现有 `normalizeRequestedPathForValidation()` 拦截 UNC、`$`/`%`/`=` 展开和写操作 glob。
- `read_file/read_many_files` 现在接受 `Read(path-rule)` 声明的外部文件;`write_file` 接受 `Write(path-rule)`;`edit_file/patch_file/patch_files` 接受 `Edit(path-rule)`,且 `patch_file(path-rule)`/`patch_files(path-rule)` 也能直接命中 TS 工具名;`multi_edit_file` 接受 `MultiEdit(path-rule)`;`NotebookEdit` 接受 `NotebookEdit(path-rule)`;`list_dir/glob_files/grep_files` 分别接受 `LS/Glob/Grep(path-rule)`。这保持 alias 粒度,不会把 `Read(...)` 偷渡成 `Write(...)`。
- 搜索工具在工作区外命中时输出绝对路径,避免把外部文件显示成 `../../tmp/...` 这种误导路径。工作区内输出仍保持原来的相对路径。
- 测试覆盖:`fileTools.test.ts` 新增端到端测试:无 rule 时外部 `read_file` 越界;加入 `Read(external/**)` 后 `read_file/read_many_files` 可读但 `write_file` 仍越界;加入 `Write/Edit/MultiEdit/NotebookEdit/LS/Glob/Grep` 后对应工具分别可写、可改、可批量改、可改 notebook、可列目录、可 glob、可 grep,同时覆盖 `Edit(...)` 授权 `patch_file/patch_files` 和 `patch_file(...)` 直接工具名规则。并保留 71 个文件工具全量回归。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tools/fileTools.test.ts --timeout 60000` = 71 pass;`cd ts && bun test src/tools/notebookEditTool.test.ts --timeout 60000` = 4 pass;`cd ts && bun test src/commands/commandLoader.test.ts src/skills/skillLoader.test.ts src/permissions/permissionRules.test.ts src/permissions/resolve.test.ts --timeout 60000` = 34 pass。
- 口径:这一步完成的是 CC-style `Tool(path/**)` 对 TS 文件工具 Workspace 边界的最小真实接入,不是完整 CC-Haha 文件权限系统。仍未搬持久化 allow/deny/ask rules UI、shadowed rule detection、managed settings、sandbox filesystem allow/deny 合并、symlink realpath 双向校验、dangerous file auto-edit 分类器和前端 allowed tool drill-in。

## 3.321 2026-07-08 CC-Haha Bash 子命令上限与退出码语义迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/bashPermissions.ts#MAX_SUBCOMMANDS_FOR_SECURITY_CHECK` 与 `~/Desktop/cc-haha-ref/src/tools/BashTool/commandSemantics.ts`。关键行为:复合命令权限检查不能在超宽 `cmd && cmd && ...` 输入上无限展开;同时 coding 常用命令的退出码不能一概按错误解释。
- `ts/src/permissions/permissionRules.ts` 新增 `MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50` 并接入 `shellCommandAllowedByPermissionRules()`:单条 exact 规则仍可精确匹配整条命令,但 prefix/wildcard 规则对 compound command 的逐子命令共同放行在超过 50 个子命令时失败关闭为不放行。这样 ask 档下极端 compound 不会被 allowedTools 自动批准,继续回到原权限瀑布。
- 新增 `ts/src/tools/commandSemantics.ts`,迁移 CC-Haha 的命令结果语义表:`grep/rg` 的退出码 1 表示 no matches,`diff` 的 1 表示 files differ,`find` 的 1 表示部分目录不可访问,`test`/`[` 的 1 表示条件为假;只有这些命令的真正错误码才标为 error。
- `run_command` 结果格式现在按 `interpretCommandResult()` 决定是否追加 `[退出码 N]` 错误标记,并在非错误语义的非零退出码上显示 `语义：...`。这让模型在代码搜索、diff 比较和条件判断时不会把正常控制流误判成工具失败,减少无意义重试。
- 测试覆盖:`permissionRules.test.ts` 覆盖 51 个 `printf ok` 子命令即使每段都匹配 `Bash(printf:*)` 也不会自动放行;`runCommandTool.test.ts` 覆盖 `printf ... | grep zzz` 与 `diff a b` 返回码 1 时显示语义信息且不出现 `[退出码 1]`,同时普通 `exit 3` 和 stderr 失败格式保持原样。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/permissions/permissionRules.test.ts src/permissions/resolve.test.ts --timeout 60000` = 22 pass;`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 60000` = 25 pass。
- 口径:这一步补的是 Bash 权限匹配的性能/安全上限和命令执行结果解释,不是完整 CC-Haha tree-sitter AST 安全分析器。仍未搬 `parseForSecurityFromAst/checkSemantics`、heredoc/command-substitution classifier、sed/path constraints 全语义、deny/ask 持久化规则和前端 Bash permission drill-in。

## 3.322 2026-07-08 CC-Haha Bash substitution 风险分类迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/bashSecurity.ts#COMMAND_SUBSTITUTION_PATTERNS` 与 safe heredoc substitution gate。关键行为:`echo $(curl ...)`、`cat <(...)`、`${...}`、Zsh `=cmd` 等 shell expansion 不能因为外层命令是 `echo/cat` 就被当作只读命令自动放行。
- `ts/src/tools/dangerousCommand.ts` 新增 `hasShellExpansionRisk()`:扫描单引号之外、未反斜杠转义的 `$()`、`${}`、`$[]`、`<()`、`>()`、`=()`、Zsh equals expansion、Zsh glob qualifier/always block 和 PowerShell block comment marker。单引号内字面文本和 `\$(...)` 不触发,避免把文档化字符串误判成真实 shell expansion。
- `classifyCommandRisk()` 现在把存在 shell expansion 的命令初始风险提升为 `outreach`,再与原有分段分类取最大风险。这样 `echo $(curl https://...)` 在 `ask/auto_files` 下会走 outreach 审批,而 `rm -rf build $(...)` 仍会被 destructive 分类覆盖,不会因为 substitution 风险先命中而降级。
- 测试覆盖:`runCommandTool.test.ts` 覆盖 `$()`、process substitution、`${}`、Zsh `=cmd` 风险命中,覆盖单引号和反斜杠转义不命中,并验证 `auto_files` 下 `echo $(curl ...)` 会以 outreach 弹审批而不是只读放行。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 60000` = 26 pass;`cd ts && bun test src/permissions/permissionRules.test.ts src/permissions/resolve.test.ts --timeout 60000` = 22 pass。
- 口径:这一步完成的是 substitution 风险分类和审批升级,不是完整 CC-Haha safe heredoc 白名单、AST command substitution 收集、quoted newline/comment desync/brace expansion 全检查或 sed/path constraints。

## 3.323 2026-07-08 CC-Haha Bash 输出重定向路径护栏迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/pathValidation.ts#validateOutputRedirections/checkPathConstraints` 与 `~/Desktop/cc-haha-ref/src/utils/bash/commands.ts#extractOutputRedirections`。关键行为:shell 写入目标不能只按外层命令分类;`echo hi > /tmp/out`、`echo hi > ../out` 或 `cd sub && echo hi > out` 不应在 `auto_files` 档被当作普通工作区文件写入静默放行。
- `ts/src/tools/dangerousCommand.ts` 新增 `shellOutputRedirectionNeedsApproval(command,{root,cwd})`:扫描未引用/未转义的 `>`、`>>`、`2>`、`>|`、`>!` 目标,忽略 fd-to-fd 和 `/dev/null`,支持带引号的空格文件名。目标包含 shell expansion/glob、解析到工作区外、或命令中存在 `cd` 复合写入时返回 true。
- `run_command` 的权限风险计算新增 `effectiveCommandRisk()`:保留原 `classifyCommandRisk()` 的 read/file/outreach/destructive,但当输出重定向路径需要显式确认时提升为 outreach。结果是 `echo hi > note.txt` 仍走 file 风险并可被 `auto_files` 放行,而外部绝对路径、`../` 越界路径和 `cd ... && > out` 会在 `auto_files` 下弹审批。
- 测试覆盖:`runCommandTool.test.ts` 覆盖工作区内重定向、stderr 重定向、`/dev/null`、绝对外部路径、`../` 越界、`$HOME` expansion、带空格文件名和 compound `cd` 场景;同时验证 `resolvePermission()` 在 `auto_files` 下对外部/compound 重定向给出 outreach approvalClass。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 60000` = 27 pass;`cd ts && bun test src/permissions/permissionRules.test.ts src/permissions/resolve.test.ts --timeout 60000` = 22 pass。
- 口径:这一步完成的是 Bash 输出重定向路径的审批升级护栏,不是完整 CC-Haha pathValidation。仍未搬 AST-derived redirects、命令 argv 级路径读写分类、sed allowlist/path constraints、git bare repo/cd RCE gate、deny/ask 持久化规则和前端 Bash permission drill-in。

## 3.324 2026-07-08 CC-Haha Bash `find` 只读守卫迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 `find` allowlist regex。关键行为:`find` 只有纯搜索/打印类表达式能被看作只读;`-delete` 会删除文件,`-exec/-execdir/-ok/-okdir` 会执行子命令,`-fprint/-fprint0/-fls/-fprintf` 会写输出文件,不能因为外层命令名是 `find` 就被 `ask/auto_files` 静默放行。
- `ts/src/tools/dangerousCommand.ts` 新增 `tokenizeShellWords()` 与 `classifyFindCommand()`:复用已有 shell word 读取逻辑做轻量 token 化,先于通用只读命令表识别 `find`。`find . -print` 保持 read;`find . -delete` 升为 destructive;`find . -exec ...`、`find . -ok ...` 升为 outreach;`find . -fprint out` 升为 file。
- `run_command` 的动态权限因此能按真实动作进入审批瀑布:`auto_files` 可放行只写文件输出类 `-fprint`,但会对 destructive/outreach 类 `find` 弹审批,避免把高风险 `find` 表达式误当作只读搜索。
- 测试覆盖:`runCommandTool.test.ts` 覆盖 `find . -print`、`-delete`、`-exec curl ...`、`-ok cat ...`、`-fprint found.txt` 的风险分类,并验证 `resolvePermission()` 在 `ask/auto_files` 下分别得到 allow、destructive ask、outreach ask 与 file allow。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 60000` = 27 pass;`cd ts && bun test src/permissions/permissionRules.test.ts src/permissions/resolve.test.ts --timeout 60000` = 22 pass。
- 口径:这一步完成的是 CC-Haha `find` 只读排除表到 TS 风险/审批层的迁移,不是完整 readOnlyValidation flag parser。仍未搬完整 Bash AST 安全分析器、safe heredoc allowlist、argv 级 path constraints、sed allowlist/path constraints、deny/ask 持久化规则和前端 Bash permission drill-in。

## 3.325 2026-07-08 CC-Haha Bash parser-hardening 风险门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/bashSecurity.ts` 的 legacy validators 与 `~/Desktop/cc-haha-ref/src/utils/bash/shellQuote.ts#hasShellQuoteSingleQuoteBug`。关键行为:只读外壳命令中出现 backtick substitution、IFS、`/proc/*/environ`、隐藏换行/CR、Unicode/control whitespace、backslash-escaped whitespace/operator、brace expansion、mid-word hash 或 Zsh 高危 builtin 时,不能因为外层是 `echo/cat/ls` 就被当作 read 自动放行。
- `ts/src/tools/dangerousCommand.ts` 新增 `hasShellParserRisk()`:迁移上述不依赖 tree-sitter 的 parser/misparse 风险探测,并在 `classifyCommandRisk()` 初始风险中与 `hasShellExpansionRisk()` 一起把命令提升为 `outreach`。`rm -rf ...` 这类 destructive 仍由后续分段分类覆盖为 destructive,不会被降级。
- 具体覆盖:未转义反引号、`$IFS`/`${...IFS...}`、`/proc/self/environ`/`/proc/*/environ`、CR 在双引号外、未引用换行分隔命令、quoted newline 后 `#` 行、shell-quote single-quote backslash differential、`\ ` / `\;` 等解析差异、Unicode whitespace、`a#b` mid-word hash、`{a,b}`/`{1..3}` brace expansion、`zmodload/emulate/sysopen/.../fc -e` 等 Zsh 风险命令。
- 测试覆盖:`runCommandTool.test.ts` 新增 `shell parser hardening mirrors Bash misparse safety gates`,覆盖正/反例:escaped backtick 不触发、双引号/单引号内 escaped whitespace 不触发、空格后 backslash-newline continuation 不触发、quoted normal multiline 不触发、escaped/quoted brace 不触发;并验证 `cat /proc/self/environ`、换行拼接 `curl`、backtick substitution 在 `auto_files` 下都会给出 outreach ask。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 60000` = 28 pass;`cd ts && bun test src/permissions/permissionRules.test.ts src/permissions/resolve.test.ts --timeout 60000` = 22 pass。
- 口径:这一步补齐的是 Bash parser-hardening 的轻量风险门,不是完整 CC-Haha `parseForSecurityFromAst/checkSemantics`、safe heredoc allowlist、tree-sitter quote context divergence、malformed shell-quote token injection、obfuscated flags、jq/system、git commit early allow 或 argv/path constraints。

## 3.326 2026-07-08 CC-Haha Bash jq/flag/malformed syntax guard 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/bashSecurity.ts#validateJqCommand/validateObfuscatedFlags/validateMalformedTokenInjection` 与 `~/Desktop/cc-haha-ref/src/utils/bash/shellQuote.ts#hasMalformedTokens`。关键行为:`jq` 的 `system()`、`-f/--from-file/--rawfile/--slurpfile/-L/--library-path`、ANSI-C/locale quoting、空 quote 拼接 flag、quoted flag 和 malformed token 不能落进普通 file 风险,否则 `auto_files` 会误放行带代码执行/敏感文件读取/解析绕过风险的 shell。
- `ts/src/tools/dangerousCommand.ts` 新增无依赖 guard:普通 `jq '.x' file.json` 分类为 read;危险 `jq` 函数/flag 升为 outreach;`hasShellParserRisk()` 继续覆盖 `$'...'`、`$"..."`、`''-flag`、`""-flag`、`"-"exec`、flag word 内 quote、带命令分隔符且分段后出现 unbalanced quote/brace/paren/bracket 的 malformed token 迹象。
- 这一步没有给 TS 增加 `shell-quote` 依赖,而是用现有轻量 shell word parser 和 quote-state scanner 迁移 CC-Haha 的主要安全语义。`cut -d","` 保留为非 parser-risk,避免把常见分隔符命令误升级。
- 测试覆盖:`runCommandTool.test.ts` 覆盖普通 `jq` read allow、`jq system()`/`jq -f`/`jq --rawfile` outreach、`find . $'-exec' ...`/`find . ""-exec ...`/`find . "-"exec ...` outreach、`echo {"hi":"hi;evil"}` malformed syntax outreach,以及 `auto_files` 下对应命令都要求 outreach ask。
- 验证:`cd ts && bun run typecheck` clean;`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 60000` = 28 pass;`cd ts && bun test src/permissions/permissionRules.test.ts src/permissions/resolve.test.ts --timeout 60000` = 22 pass。
- 口径:这一步完成的是 jq/obfuscated flag/malformed syntax 的无依赖风险迁移,不是完整 CC-Haha shell-quote token stream、tree-sitter AST security、obfuscated flag 全部边角、git commit early allow、jq path validation 或 argv/path constraints。

## 3.327 2026-07-08 Python 耦合地图生成器退场

- 目标:按“等价迁移一块、验证一块、删除一块”的节奏继续删 Python,先处理仍在活文档/skill/守栏里被引用的耦合地图机械生成器,避免删除后留下断链。
- 新增 `scripts/build_coupling_map.mjs`:纯 Node 实现 `api.ts` 前端调用抽取、`server/api/v1/router.py` + 子路由抽取、service 粗粒度识别、前后端端点匹配、Markdown 自动块渲染和 `--write` 写回。排序从 JS `localeCompare` 改为显式码点比较,保证与旧 Python 输出稳定对齐。
- 新增 `ts/src/scripts/buildCouplingMap.test.ts`:用 Bun 守住路径参数规范化、真实活接线、后端路由函数抽取和 `docs/耦合地图与改动检查清单.md` 自动块新鲜度,替代旧 pytest 守栏。
- 删除旧 Python 生成器与旧 pytest 守栏;活文档和 `.claude/skills/coupling-map/SKILL.md` 已切到 `node scripts/build_coupling_map.mjs --write` 与 `cd ts && bun test src/scripts/buildCouplingMap.test.ts`。`docs/plans/` 中仍属现行计划的旧命令引用也已同步更新,归档文档不翻动。
- 验证:旧 Python 输出与 `node scripts/build_coupling_map.mjs > /tmp/coupling_map_node.out` 对比仅生成器文件名行从 Python 版改为 Node 版;`node --check scripts/build_coupling_map.mjs` clean;`node scripts/build_coupling_map.mjs --write` = 无变化;`cd ts && bun test src/scripts/buildCouplingMap.test.ts --timeout 60000` = 4 pass;`cd ts && bun run typecheck` clean;`git diff --check` clean;禁词扫描 clean;Python 文件数降到 400。
- 口径:这一步删除的是确定性文档生成/守栏链路里的 Python,不是媒体、语音、Office、视频剪辑等仍需 TS/native sidecar 继续承接的产品 Python。后续继续按“有等价实现 + 有测试 + 有活文档切换”逐块删除。

## 3.328 2026-07-08 CC-Haha Bash readOnlyValidation 常用命令 allowlist 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 `COMMAND_ALLOWLIST`、`ps` BSD env modifier guard、以及 `~/Desktop/cc-haha-ref/src/tools/BashTool/sedValidation.ts` 的 sed 严格 allowlist。关键行为:读码常用命令不能因为不在最小 read 表里一律变成 file 审批,但带写文件/环境变量泄露/危险 sed script 的参数也不能被当作 read 自动放行。
- `ts/src/tools/dangerousCommand.ts` 新增轻量 read-only flag parser:支持长 flag `--flag=value`、短 flag 组合、短 flag attached arg、需要参数的 flag 类型校验,并引入 `file/sort/base64/ps` 的安全 flag 子集。`sort -nr`、`sort -k1,1`、`file --mime-type`、`base64 --decode`、`ps aux`、`ps -ef` 进入 read 风险;`sort -o`、`file --output`、`base64 -o` 继续归 file;`ps auxe` 因 BSD `e` 暴露进程环境变量升为 outreach。
- `sed` 新增 CC-style 严格读 allowlist:允许 `sed -n '1,20p' file`、`sed -n -e '1p;2p' file` 和无文件参数的 stdout-only substitution;`sed -i`、`sed -n '1,20w out' file` 等继续归 file。为支持 sed 分号表达式,`classifyCommandRisk()` 的命令分段改为 quote-aware;malformed-token 风险检查仍保留原激进分段,并只对已通过 sed allowlist 的读命令开例外。
- 测试覆盖:`runCommandTool.test.ts` 覆盖上述 read/file/outreach 分类和 `ask/auto_files` 权限瀑布;同时保留 parser-hardening 中 `echo {"hi":"hi;evil"}` malformed 反例,证明 quote-aware 执行分段没有削弱 malformed-token guard。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 60000` = 28 pass;`cd ts && bun test src/permissions/permissionRules.test.ts src/permissions/resolve.test.ts --timeout 60000` = 22 pass;`cd ts && bun run typecheck` clean。
- 口径:这一步迁移的是 readOnlyValidation 中常见读码命令的 flag allowlist 和 sed/ps 两个高风险边界,不是完整 CC-Haha 全命令 allowlist、Docker/gh/pyright/git 全 flag map、AST path constraints、sed 全模式或 shell parser 全量替代。下一步继续搬完整 Bash tree-sitter 安全分析器和更细 argv/path constraints。

## 3.329 2026-07-08 CC-Haha Bash `cd` + `git` bare repo 安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 与 `~/Desktop/cc-haha-ref/src/tools/BashTool/bashPermissions.ts` 的 compound `cd` + `git` gate,以及 `isNormalizedGitCommand()/isNormalizedCdCommand()`。关键行为:`cd sub && git status` 不能被拆成“cd=file + git=read”后在 `auto_files` 档静默放行,因为目标目录可伪造 bare git repo/fsmonitor/hooks 触发 git 副作用。
- `ts/src/tools/dangerousCommand.ts` 新增 `shellCdGitNeedsApproval()`:用 quote-aware `splitSegments()` 分段,复用 `stripSafeShellWrappers()` 归一安全 env/wrapper,识别 `cd/pushd/popd` 与 `git`、`xargs ... git`。只要同一复合命令同时包含目录切换和 git 子命令,初始风险升为 `outreach`;普通 `git status --short` 仍保持 read,`cd sub && echo ok` 仍保持 file。
- 测试覆盖:`runCommandTool.test.ts` 新增 `compound cd plus git mirrors bare repo safety gate`,覆盖 `cd sub && git status`、`FORCE_COLOR=1 cd sub && git status`、`pushd sub && git diff`、`cd sub && xargs git status` 正例,以及 quoted 字符串反例;权限瀑布覆盖 `auto_files` 下 `cd sub && git status --short` 会以 outreach ask。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 60000` = 29 pass;`cd ts && bun run typecheck` clean。
- 口径:这一步补的是 CC-Haha bare repo 防绕过里的 `cd` + `git` 复合命令安全门,不是完整 bare repo 结构探测、git-internal path 写入检测、sandbox 原始 cwd 比对或完整 pathValidation。后续继续搬 `commandWritesToGitInternalPaths()`、bare repo cwd 检测和 AST path constraints。

## 3.330 2026-07-08 CC-Haha Bash git-internal 写入 + git 安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts#commandWritesToGitInternalPaths`、`extractWritePathsFromSubcommand()` 与 `GIT_INTERNAL_PATTERNS`。关键行为:同一复合命令先创建 bare repo 内部结构(`HEAD`、`objects/`、`refs/`、`hooks/`)再运行 git,会绕过单次检查并触发 git hooks/fsmonitor 等副作用,不能在 `auto_files` 档静默放行。
- `ts/src/tools/dangerousCommand.ts` 新增 `shellGitInternalWriteNeedsApproval()`:先确认复合命令中存在 git-like 子命令,再扫描创建类命令 `mkdir/touch/cp/mv` 的目标和输出重定向目标。命中 `HEAD`、`objects`、`refs`、`hooks` 及其子路径时,整条命令初始风险升为 `outreach`。
- 行为边界:没有 git 的 `printf ... > hooks/pre-commit` 仍只是 file 风险;`rm -rf hooks && git status` 不属于“创建 git internal path 后跑 git”的门,不在本步骤扩大处理。这个边界保持和 CC-Haha 的 `NON_CREATING_WRITE_COMMANDS` 思路一致。
- 测试覆盖:`runCommandTool.test.ts` 覆盖 `mkdir -p objects refs hooks && touch HEAD && git status`、`printf ... > hooks/pre-commit && git status`、`cp hook.sh hooks/pre-commit && xargs git status` 正例,以及无 git、删除类命令反例;权限瀑布覆盖 `auto_files` 下写 hook 后跑 git 会以 outreach ask。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 60000` = 30 pass;`cd ts && bun run typecheck` clean。
- 口径:这一步补的是 CC-Haha bare repo 防绕过中的 git-internal 写入检测,不是完整 PATH_EXTRACTORS、全部写命令、bare repo cwd 结构探测、sandbox 原始 cwd 比对或完整 AST path constraints。下一步继续搬 bare repo cwd 检测和更细 pathValidation。

## 3.331 2026-07-08 CC-Haha Bash bare repo cwd git 安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/git.ts#isCurrentDirectoryBareGitRepo` 与 `~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 git cwd gate。关键行为:当前工作目录没有有效 `.git/HEAD`,却存在 bare repo 指标 `HEAD`、`objects/` 或 `refs/` 时,运行 git 可能把 cwd 当 git dir 并触发 hooks/fsmonitor 等副作用,不能当 read 静默放行。
- `ts/src/tools/dangerousCommand.ts` 新增 `shellBareGitRepoCwdNeedsApproval(command,cwd)`:先确认命令里有 git-like 子命令,再按 CC-Haha 语义判断 cwd。若 `.git` 是文件(正常 worktree/submodule)或 `.git/HEAD` 是普通文件(正常 repo),不升级;否则只要 cwd 中 `HEAD` 文件、`objects/` 目录或 `refs/` 目录任一存在,即升级为 `outreach`。
- `run_command` 的 `effectiveCommandRisk()` 现在会把 resolved cwd 传给该 gate,所以 `git status` 在可疑 cwd 下会进入 outreach ask;普通 workspace 和正常 `.git/HEAD` repo 不受影响。
- 测试覆盖:`runCommandTool.test.ts` 新增 `git in bare-looking cwd mirrors bare repo safety gate`,覆盖无指标 false、cwd `HEAD` true、非 git 命令 false、正常 `.git/HEAD` 优先 false;权限瀑布覆盖 `auto_files` 下 bare-looking cwd 中 `git status --short` 会以 outreach ask。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 60000` = 31 pass;`cd ts && bun run typecheck` clean。
- 口径:这一步补的是 CC-Haha bare repo cwd 探测的 TS run_command 接入,不是完整 sandbox 原始 cwd 比对、PowerShell 对齐、PATH_EXTRACTORS 或 AST path constraints。下一步继续搬更细 pathValidation 和完整 Bash tree-sitter 安全分析器。

## 3.332 2026-07-08 Python 图标构建脚本退场

- 目标:继续按“有等价实现 + 有验证 + 活文档切换”删除旧 Python,先处理 `desktop/scripts/make_rounded_icon.py` 这种不承载产品运行时的构建辅助脚本,避免为了删 Python 影响 agent/媒体活链。
- 新增 `desktop/scripts/make_rounded_icon.mjs`:用 Node + `pngjs` 读取 `desktop/build/icon-source.png`,按原 1024 画布、824 图标本体、185 圆角半径生成带透明边距的 macOS 图标 PNG;内置 bilinear resize 与 4x4 supersampling 圆角 alpha,不再依赖 PIL。
- `desktop/package.json` 新增 `npm run icon:rounded`,并把 `pngjs` 锁进 `desktop/package-lock.json` devDependency;`docs/苹果与Windows-签名与分发.md` 的图标重生成命令已切到 Node。
- 删除旧 `desktop/scripts/make_rounded_icon.py`,不保留 Python/Node 双轨入口。
- 验证:`cd desktop && node --check scripts/make_rounded_icon.mjs` clean;`cd desktop && npm run icon:rounded -- --out /tmp/billiards-rounded-icon.png` 成功;`file`/`sips` 确认输出为 1024x1024 RGBA PNG;像素检查确认外角 alpha=0、中心 alpha=255;旧 Python 命令引用扫描无命中。
- 口径:这一步删除的是桌面图标构建辅助 Python。`server/` 后端、媒体/OCR/语音/视频链、`gateway`、`dataeye` 等仍是活链,必须等 TS/Node/native 等价实现和测试齐全后分批删除。

## 3.333 2026-07-08 CC-Haha Bash sandbox original cwd git 安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 中 `SandboxManager.isSandboxingEnabled() && getCwd() !== getOriginalCwd()` 的 git gate。关键行为:OS 沙箱开启时,只有 original cwd 的写保护结构能覆盖某些 git/bare repo 绕过;如果命令通过 `cwd` 跑到子目录,即便当前检查时还不像 bare repo,也不能把 `git status` 这类命令当 read 静默放行。
- `ts/src/tools/dangerousCommand.ts` 新增 `shellSandboxedGitCwdNeedsApproval(command,{root,cwd,sandboxActive})`:沙箱未激活或 cwd 等于 workspace root 时不升级;沙箱激活且 cwd 不等于 root 时,识别 `git` 和 `xargs ... git` 子命令并升级为 `outreach`。
- `run_command` 的 `effectiveCommandRisk()` 现在把 `ctx.sandbox?.isOsSandboxActive()`、resolved cwd 和 workspace root 一起传入该 gate,所以 `run_command({command:"git status --short",cwd:"sub"})` 在 OS 沙箱激活时会进入 outreach ask;未启用沙箱时仍保持 read。
- 测试覆盖:`runCommandTool.test.ts` 新增 `git outside original cwd while sandboxed mirrors cwd safety gate`,覆盖 root/cwd、sandbox on/off、`xargs git` 和非 git 反例;权限瀑布覆盖 `auto_files` 下 sandbox 激活 + 子目录 git 会 ask/outreach,非 sandbox 同命令保持 allow。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 60000` = 32 pass;`cd ts && bun run typecheck` clean。
- 口径:这一步补的是 CC-Haha bare repo 绕过防线中的 sandbox original cwd git gate,不是完整 sandbox config 合并、自动 sandbox 放行策略、PowerShell 对齐、PATH_EXTRACTORS 或完整 Bash tree-sitter 安全分析器。

## 3.334 2026-07-08 CC-Haha Bash incomplete command fragment 安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/bashSecurity.ts#validateIncompleteCommands`。关键行为:以 tab 开头、以 flag 开头或以 shell operator 开头的内容通常是续行/片段,不能被 `run_command` 当作完整命令按普通 file/read 风险处理;否则 `auto_files` 可能把 `-rf /tmp` 这类片段误当可逆文件动作放行。
- `ts/src/tools/dangerousCommand.ts` 新增 `hasIncompleteShellFragmentRisk()`,并接入 `hasShellParserRisk()`:覆盖 `\t...`、`-...`、`&&...`、`||...`、`;...`、`>...`、`>>...`、`<...` 起手片段,统一升级为 `outreach`。
- 测试覆盖:`runCommandTool.test.ts` 在 shell parser hardening 中新增 tab/flag/operator/redirection 起手正例,并保留 `printf ok -- -rf` 反例,避免误伤正常命令里的 dash 参数;权限瀑布覆盖 `auto_files` 下 `-rf /tmp` 会 ask/outreach。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 60000` = 32 pass;`cd ts && bun run typecheck` clean。
- 口径:这一步补的是 CC-Haha Bash security legacy validator 中的 incomplete command fragment gate,不是完整 tree-sitter AST parser、safe heredoc early allow、git commit early allow 或完整 pathValidation。

## 3.335 2026-07-08 CC-Haha Bash comment quote desync 安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/bashSecurity.ts#validateCommentQuoteDesync`。关键行为:legacy/fallback quote tracking 遇到未引用 `#` 注释后,如果注释正文里继续出现 `'` 或 `"`,后续基于字符串的 quote stripping / path validation 可能失步;这种命令不能在 `auto_files` 下静默放行。
- `ts/src/tools/dangerousCommand.ts` 新增 `hasCommentQuoteDesyncRisk()`,并接入 `hasShellParserRisk()`:逐字符跟踪单引号、双引号和反斜杠,只在未引用、未转义的 `#` 后本行注释正文包含 quote 字符时升级为 `outreach`。
- 测试覆盖:`runCommandTool.test.ts` 新增 `echo ok # "comment quote"` 和 `echo ok # 'comment quote'` 正例,保留普通注释、引号内 `#`、`printf "%s" "# literal arg"` 反例;权限瀑布覆盖 `auto_files` 下 comment quote desync 会 ask/outreach。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 60000` = 32 pass;`cd ts && bun run typecheck` clean。
- 口径:这一步补的是 CC-Haha Bash security legacy validator 中的 comment quote desync gate,不是完整 tree-sitter AST quote context、safe heredoc early allow、git commit early allow 或完整 pathValidation。

## 3.336 2026-07-08 CC-Haha Bash input redirection 安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/bashSecurity.ts#validateRedirections` 的输入重定向分支。关键行为:`cat < ~/.ssh/id_rsa` 这类命令会绕过普通文件读取工具的路径边界,不应在 `auto_files` 下被当作 read 或 file 静默放行。
- `ts/src/tools/dangerousCommand.ts` 新增 `hasInputRedirectionRisk()`,并接入 `hasShellParserRisk()`:逐字符跟踪单引号、双引号和反斜杠,只对未引用、未转义的 `<` 升级为 `outreach`;`<(` process substitution 仍由已有 shell expansion gate 覆盖。
- 测试覆盖:`runCommandTool.test.ts` 新增 `cat < ~/.ssh/id_rsa`、`cat < secrets.txt` 正例,以及双/单引号内 `<` 反例;权限瀑布覆盖 `auto_files` 下输入重定向会 ask/outreach。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 60000` = 32 pass;`cd ts && bun run typecheck` clean。
- 口径:这一步补的是 CC-Haha Bash redirection validator 的输入重定向安全门。输出重定向已经由 TS `shellOutputRedirectionNeedsApproval()` 做工作区/`cd` 护栏;完整 AST redirect target、here-doc/here-string 和 pathValidation 仍需继续迁移。

## 3.337 2026-07-08 Python prompt pack 构建脚本退场

- 目标:继续按“有等价实现 + 调用链切换 + 兼容验证”删除旧 Python,先处理桌面打包期 prompt 加密构建脚本,不碰仍在承载运行时功能的 FastAPI/媒体链。
- 新增 `desktop/scripts/build_prompts_pack.js`:纯 Node 读取 `server/prompts/**/*.yaml`,生成 Fernet v0 token 格式的 `server/prompts.enc`,AES-128-CBC + HMAC-SHA256 key split 与 Python `cryptography.fernet.Fernet` 兼容。
- `desktop/scripts/build_backend.js` 改为用 Node 生成 Fernet key 并调用 Node prompt pack 构建器,不再为这一小步拉起 `uv run python scripts/build_prompts_pack.py`;`desktop/package.json` 显式声明 `js-yaml` devDependency。
- 删除旧 `server/scripts/build_prompts_pack.py`;`desktop/README.md` 与 TS 主文档同步当前 159 个 prompt 模板口径,避免继续沿用旧硬编码数字。
- 兼容细节:Node 打包器加入 PyYAML EOF block-scalar chomp 兼容,覆盖少数 YAML 文件缺文件末尾换行时 Python `safe_load` 对最后一个 `|` block 的裁剪行为,保证加密包对象与旧 Python 解析一致。
- 验证:`PROMPTS_PACK_KEY=<tmp> node desktop/scripts/build_prompts_pack.js` 成功生成 159 模板;同一 key 下 Python `Fernet.decrypt(server/prompts.enc)` + `json.loads` 后与 `yaml.safe_load(server/prompts/**/*.yaml)` 全量对象比对 `OBJECT_MATCH 159`;`node --check desktop/scripts/build_prompts_pack.js desktop/scripts/build_backend.js` clean。
- 口径:这一步删除的是桌面打包期 prompt pack 构建 Python。`server/services/ai/prompt_pack.py` 运行时解密、FastAPI 后端、`video_edit/*`、`gateway`、`dataeye` 等仍是活链,必须等 TS/Node/native 等价实现与测试齐全后分批退场。

## 3.338 2026-07-08 CC-Haha Bash git commit message 安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/bashSecurity.ts#validateGitCommit`。关键行为:`git commit -m "..."` 可以按普通文件类命令处理,但 message 内双引号 command substitution 与 message 以 `-` 起头都不能在 `auto_files` 下静默放行。
- TS 既有全局 `hasShellExpansionRisk()` / `hasShellParserRisk()` 已覆盖 `git commit -m "$(whoami)"`、反引号和 `${HOME}`;本步补齐缺口:新增 `hasGitCommitMessageRisk()`,识别 `git commit -m/--message` 的 quoted message,对 `---` 等 dash 起头内容升级为 `outreach`。
- 实现边界:只在 `git commit` 的 message 参数上触发,不把普通 `echo "---"` 或单引号里的 `$(literal)` 误判;保留 safe wrapper/env 归一化,与 Bash allowedTools/permission rule 的 shell 归一化一致。
- 测试覆盖:`runCommandTool.test.ts` 覆盖 safe commit、`git commit -m "---"`、`git commit --message='---'`、双引号 substitution 正例、单引号 literal 反例;权限瀑布覆盖 `auto_files` 下 dash message 会 ask/outreach,普通 safe message 仍 allow。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 60000` = 32 pass;`cd ts && bun run typecheck` clean。
- 口径:这一步补的是 CC-Haha `validateGitCommit` 中 message 内容风险门。它不是完整 early-allow 复刻,也不替代后续完整 Bash tree-sitter 安全分析器、git commit remainder redirect passthrough 和 pathValidation。

## 3.339 2026-07-08 CC-Haha Bash safe heredoc substitution 例外迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/bashSecurity.ts#isSafeHeredoc` 与 `stripSafeHeredocSubstitutions()`。关键行为:`echo $(cat <<'EOF' ... EOF)` 这种 quoted delimiter heredoc body 是 literal 文本,不应因为 `$(`/换行被一律升到 `outreach`,否则 coding agent 常见多行文本传参会过度弹审批。
- `ts/src/tools/dangerousCommand.ts` 新增 safe heredoc range finder:只接受 `$(cat <<'DELIM' ... DELIM)` 或 escaped delimiter,要求 opening line 无额外内容、按 bash line-based 规则命中第一个 closing delimiter、禁止嵌套匹配、禁止 heredoc substitution 出现在命令名位置。
- `hasShellExpansionRisk()`、`hasShellParserRisk()` 和 `classifyCommandRisk()` 会先 strip 已验证的 safe heredoc substitution,再继续跑剩余命令的 expansion/parser/分段风险分类;所以 `echo $(cat <<'EOF'...)` 可保持 read/allow,但 `$(cat <<'EOF'...)`、未引用 delimiter、后接 `; curl`、`zmodload ... $(cat <<'EOF'...)` 仍会升级为 `outreach`。
- 测试覆盖:`runCommandTool.test.ts` 增加 safe heredoc read/allow、prefix arg read、command-name position outreach、unquoted heredoc body substitution outreach、suffix shell operator outreach 和 permission waterfall 覆盖。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 60000` = 32 pass;`cd ts && bun run typecheck` clean。
- 口径:这一步迁移的是 CC-Haha safe heredoc substitution 例外,不是泛化所有 heredoc、不是完整 tree-sitter heredoc AST,也不改变普通 `cat <<'EOF'` 多行命令的风险门。

## 3.340 2026-07-08 Bash runtime `env` wrapper 风险分类补齐

- 对照 CC-Haha Bash precommand/env 归一化思路继续补 TS 风险分类缺口。问题:`env curl https://...`、`env FOO=bar zmodload zsh/system` 当前被 `classifySegment()` 当成 base command `env`,落到 read/file 默认路径,会绕过 outreach/zsh 危险命令分类。
- `ts/src/tools/dangerousCommand.ts` 新增 `stripRuntimeEnvWrapper()`:仅在风险分类内部剥离 runtime `env` wrapper、`-i/--ignore-environment`、`--unset/-u`、`--chdir/-C`、`--split-string/-S` 和 env assignments,再对真实子命令做风险分类与 zsh dangerous gate。
- 行为边界:不把 `env` 加进 allowedTools 的 `stripSafeShellWrappers()`,避免把 `Bash(curl:*)` 等规则匹配范围隐式放宽;这是 run_command 风险分类修补,不是 shell permission rule 放行策略改动。
- 测试覆盖:`env curl`、`env -i FOO=bar curl` -> outreach;`env FOO=bar zmodload` -> parser/outreach;`env rm -rf build` -> destructive;`env git status --short` 与 `env -- ls -la` 保持 read。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 60000` = 32 pass;`cd ts && bun run typecheck` clean。
- 口径:这一步补的是 runtime wrapper 风险分类漏洞,不是完整 shell wrapper AST 归一化、env `-S` 子命令二次解析或 permission rule wrapper 扩展。

## 3.341 2026-07-08 Bash runtime `env -S` 动态重解析门

- 复查 3.340 后发现 `env -S "curl https://..."` 与 `env --split-string="..."` 仍会被当作 `env` 参数处理,没有落到真实子命令风险分类。`env -S` 会在运行时重新拆分字符串,属于动态重解析入口,不能在 `auto_files` 下静默执行。
- `ts/src/tools/dangerousCommand.ts` 新增 `hasRuntimeEnvSplitStringRisk()`:识别 `env -S`、`env --split-string`、`env --split-string=...`,在 parser/risk 分类中统一升级为 `outreach`,不尝试复刻 GNU env 的 split-string 解析器。
- 测试覆盖:`env -S "curl https://example.com"`、`env --split-string="curl https://example.com"`、`env -S "zmodload zsh/system"` 进入 parser/outreach;普通 `env git status --short` 保持 read。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 60000` = 32 pass;`cd ts && bun run typecheck` clean。
- 口径:这一步补的是 `env -S` 动态重解析安全门,不是把 `env -S rm -rf build` 精细分类为 destructive;当前统一 outreach,由用户确认后再执行。

## 3.342 2026-07-08 Python 知识 manifest 生成脚本退场

- 目标:继续按“能接住调用链再删”的策略减少旧 Python,本步处理只生成 `docs/知识manifest.md` 的离线文档脚本,不碰 FastAPI 运行时、媒体链、生图/视频链或发布器。
- 新增 `scripts/gen_knowledge_manifest.mjs`:纯 Node 读取 `server/prompts/**/*.yaml`,并从 `server/services/content_service.py` 静态提取 `CORE_KNOWLEDGE_KEYS` / `KNOWLEDGE_KEYWORDS` 字面量,渲染同一份知识覆盖矩阵。
- 删除旧 `server/scripts/gen_knowledge_manifest.py`;`server/services/knowledge_manifest.py` 注释同步为 Node 生成器消费,Python 侧机器可读 `build_manifest()` 和 `server/tests/test_knowledge_manifest.py` 继续保留作运行时/测试守门。
- 兼容细节:Node 生成器复用 prompt pack 构建器的 PyYAML EOF block-scalar chomp 兼容逻辑,避免少数无文件末尾换行的 YAML 在 JS/Python 解析时发生尾换行差异。
- 验证:`node scripts/gen_knowledge_manifest.mjs` 成功生成 `docs/知识manifest.md`;`node --check scripts/gen_knowledge_manifest.mjs` clean;Python 源文件数量从 398 降到 397。
- 口径:这一步删除的是离线文档生成入口。`server/services/knowledge_manifest.py`、`content_service.py`、PromptEngine、知识注入和 RAG/召回仍是活链,必须等 TS/Node 等价实现与测试齐全后再分批退场。

## 3.343 2026-07-08 CC-Haha Bash `date` 只读安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 `date` command allowlist。关键行为:`date -s/--set` 可改系统时间,`date -f/--file` 可批量读日期并设置时间,裸位置参数 `MMDDhhmm...` 也可设置系统时间,不能被 `auto_files` 当只读静默放行。
- TS 原逻辑把 `date` 放在泛 read regex 中,导致 `date -s tomorrow`、`date --set=tomorrow`、`date -f dates.txt`、`date 010112002030` 都会被误判为 read。
- `ts/src/tools/dangerousCommand.ts` 新增 `classifyDateCommand()`:只允许无参、`+format` 位置参数、`-u/--utc`、`-d/--date`、`-r/--reference`、`-I/--iso-8601`、`-R/--rfc-email`、`--rfc-3339`、`--debug/help/version` 等展示类参数;其余 flag 或非 `+` 位置参数统一升级为 `outreach`。
- 测试覆盖:`date`、`date +%F`、`date -u +%FT%TZ`、`date -d tomorrow +%F` 保持 read/allow;`date -s tomorrow`、`date --set=tomorrow`、`date -f dates.txt`、`date --file=dates.txt`、裸数字日期位置参数进入 outreach/ask。
- 口径:这一步补的是 CC-Haha read-only allowlist 中 `date` 的状态修改风险门,不是完整迁移 hostname/chflags/fc/jq regex 或全量 COMMAND_ALLOWLIST。

## 3.344 2026-07-08 CC-Haha Bash jq env/run-tests 安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` jq regex 与 `bashSecurity.ts#validateJqCommand`。关键行为:除 `-f/--from-file`、`--rawfile`、`--slurpfile`、`-L/--library-path`、`system()` 外,`jq --run-tests` 会执行 jq 测试文件,`env` builtin / `$ENV` object 可读取进程环境变量,不应被当成普通 read。
- `ts/src/tools/dangerousCommand.ts` 的 `classifyJqCommand()` 补齐 `--run-tests`/`--run-tests=...`、`\benv\b`、`$ENV` 风险分类,统一升级为 `outreach`。
- 测试覆盖:`jq --run-tests tests.jq`、`jq 'env.PATH' data.json`、`jq '$ENV.PATH' data.json` 进入 outreach;权限瀑布覆盖 `auto_files` 下 `$ENV` 会 ask/outreach,普通 `jq '.name' package.json` 仍 allow。
- 口径:这一步补的是 CC-Haha jq read-only regex 的剩余高风险项,不是完整 pathValidation 或 shell AST quote/path 分析。

## 3.345 2026-07-08 CC-Haha Bash `node -v --run` 安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 Node version regex 注释。关键行为:`node -v --run <task>` 会先处理 `--run` 并执行 `package.json` scripts,不能因为带了 `-v` 就当作只读版本查询。
- TS 新增 `classifyNodeCommand()`:仅 `node -v` / `node --version` 精确归为 read;只要出现 `--run` 或 `--run=...` 就升级为 `outreach`;其它 node 命令保持 `file`,不扩大 read 放行面。
- 测试覆盖:`node -v`、`node --version` 保持 read/allow;`node -v --run build`、`node --run=test -v` 进入 outreach,`auto_files` 下会 ask/outreach。
- 口径:这一步补的是 CC-Haha Node version regex 的 parser-order 风险门,不是完整 Node CLI 参数解析器或 npm/bun/yarn script policy。

## 3.346 2026-07-08 CC-Haha Bash `hostname` 只读安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 `hostname` allowlist。关键行为:`hostname <name>` 会设置系统 hostname,`-F/--file` 从文件设置 hostname,`-b/--boot` 设置默认 hostname,不能被 `auto_files` 当 file 类静默放行。
- TS 新增 `classifyHostnameCommand()`:仅无参和 `-f/--fqdn/--long`、`-s/--short`、`-i/--ip-address`、`-I/--all-ip-addresses`、`-a/--alias`、`-d/--domain`、`-A/--all-fqdns`、`-v/--verbose`、`-h/--help`、`-V/--version` 等展示类 flag 归为 read;任何位置参数或未列入 flag 统一升级为 `outreach`。
- 测试覆盖:`hostname`、`hostname -f`、`hostname --all-ip-addresses` 保持 read/allow;`hostname new-name`、`hostname -F hosts.txt`、`hostname --file hosts.txt` 进入 outreach,`auto_files` 下会 ask/outreach。
- 口径:这一步补的是 CC-Haha hostname 状态修改风险门,不是完整迁移 info/lsof/pgrep 等 COMMAND_ALLOWLIST。

## 3.347 2026-07-08 CC-Haha Bash `info` 输出/配置安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 `info` allowlist。关键行为:`info -o/--output` 会写文件,`--dribble` 记录按键,`--init-file` 加载外部配置,`--restore` 回放按键,不能被 `auto_files` 当 file 类静默放行。
- TS 新增 `classifyInfoCommand()`:仅 `-f/--file`、`-d/--directory`、`-n/--node`、`-a/--all`、`-k/--apropos`、`-w/--where`、`--location`、`--show-options`、`--vi-keys`、`--subnodes`、help/version 等导航/展示参数归为 read;其它参数统一升级为 `outreach`。
- 测试覆盖:`info --where bash`、`info -f coreutils date` 保持 read/allow;`info -o out.txt bash`、`info --output=out.txt bash`、`info --init-file init.info bash` 进入 outreach,`auto_files` 下会 ask/outreach。
- 口径:这一步补的是 CC-Haha info command 的写文件/配置加载风险门,不是完整迁移 lsof/pgrep/fd/docker/gh 等全量 allowlist。

## 3.348 2026-07-08 CC-Haha Bash `lsof` 文件写入安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 `lsof` allowlist。关键行为:`-D` 会 build/update device cache file,`+m`/`+m<path>` 会创建 mount supplement file,不能被 `auto_files` 当 file 类静默放行。
- TS 新增 `classifyLsofCommand()`:复刻 CC 中的 lsof 查询类 safe flags,并额外拦截 `+m` 前缀;未列入 flag 或 `-D` 统一升级为 `outreach`。
- 测试覆盖:`lsof -nP -i`、`lsof -p 123` 保持 read/allow;`lsof -D cache`、`lsof +m/tmp/mounts` 进入 outreach,`auto_files` 下会 ask/outreach。
- 口径:这一步补的是 CC-Haha lsof 写缓存/补充文件风险门,不是完整迁移 pgrep/pkill/fd/docker/gh 等全量 allowlist。

## 3.349 2026-07-08 CC-Haha Bash `pgrep`/process action 安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 `pgrep` allowlist。关键行为:`pgrep` 查询进程可按 safe flag 归为 read,但 `kill`/`pkill`/`killall` 会终止进程,必须走 destructive 审批。
- TS 新增 `classifyPgrepCommand()`:复刻 CC 中 `pgrep` 的 safe flags,支持 `-fl`、`--full`、用户/会话/pidfile/runstates/ns 等查询参数;未列入 flag 统一升级为 `outreach`。
- TS 新增 `classifyProcessActionCommand()`:把 `kill`、`pkill`、`killall` 统一归为 `destructive`,避免它们在 `auto_files` 下被当作普通 file 命令执行。
- 同步修复 Bash 分段风险合并顺序:输出重定向现在只作为最低 file 风险,不会把 `curl ... > out` 降成 file,也不会把 `kill 123 > out` 降成 file。命令自身的 outreach/destructive 风险始终优先。
- 测试覆盖:`pgrep -fl node`、`pgrep --full node` 保持 read/allow;`pgrep --unknown node` 进入 outreach;`pkill node`、`kill 123`、`killall node` 进入 destructive;重定向组合 `curl ... > out` 保持 outreach,`kill 123 > out` 保持 destructive。
- 口径:这一步补的是 CC-Haha process command allowlist/kill 类危险动作门,不是完整迁移 fd/docker/gh/完整 tree-sitter AST 安全分析器。

## 3.350 2026-07-08 Python 真实模型 smoke 入口退场

- 目标:继续按“有 TS/Node 等价入口再删”的节奏退休旧 Python。本步处理 `server/scripts/smoke_agent.py`,它只是手工跑一次真实模型 + 工具调用的 smoke 入口,不属于生产 FastAPI、媒体链或发布器运行时。
- 已有 TS 等价入口:`ts/scripts/smoke/model-live.smoke.ts` + `cd ts && bun run smoke:model`,默认读取桌面/服务端 env 文件,创建 smoke 专用 `echo_text` 工具并强制模型先调用工具再 final,用于验证真实模型连通与 tool call 链路。
- 删除旧 `server/scripts/smoke_agent.py`,避免文档/人员继续从 Python 旧 Agent loop 做 smoke,把真实模型连通验证收敛到 TS coding-agent 内核。
- 验证口径:`bun run smoke:model` 需要真实模型 key,本步默认只把脚本纳入 typecheck/静态检查;有 key 的真机验收继续跑 `cd ts && bun run smoke:model`。
- 口径:这一步删除的是旧手工 smoke 入口,不是删除 Python FastAPI 运行时、server eval 体系、媒体/OCR/视频链;当时尚未处理的旧 publisher 自动发布链已在 3.366 明确退场。

## 3.351 2026-07-08 CC-Haha Bash `tree` 写文件安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 `tree` allowlist。关键行为:`tree -o/--output` 会写文件;`tree -R` 在 HTML 模式和 depth 边界下会生成 `00Tree.html`,不能被当作只读目录浏览。
- TS 新增 `classifyTreeCommand()`:复刻 CC 中 `tree` 的目录浏览/显示/filter safe flags,保留 `tree . -L 2`、`tree -H . -L 2` 为 read;未列入 flag 包括 `-o`、`--output`、`-R` 统一升级为 `outreach`。
- 行为边界:这里不把 `tree` 放进通用 read-only 表后回落 file,而是单独 classifier,确保写入型/递归 HTML 写入型参数在 `auto_files` 下会 ask/outreach,不会静默执行。
- 测试覆盖:`tree . -L 2` 与 `tree -H . -L 2` read/allow;`tree -o out.html .`、`tree -R -H . -L 2` outreach/ask。
- 口径:这一步补的是 CC-Haha `tree` 写文件风险门,不是完整迁移 man/help/netstat/checksum/docker/gh 等剩余 COMMAND_ALLOWLIST。

## 3.352 2026-07-08 CC-Haha Bash `man/help/netstat` 只读安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 `man`、`help`、`netstat` allowlist。关键行为:`man -P` 可指定 pager 并触发任意命令风险;`help` 只允许 bash builtin help 的安全 flag,避免被 alias 到 man 后继承危险 pager 参数;`netstat` 只允许展示/过滤/统计类参数。
- TS 新增 `classifyNamedReadOnlyCommand()` 以及 `classifyManCommand()`、`classifyHelpCommand()`、`classifyNetstatCommand()`:安全 flag + 位置参数保持 read;未列入 flag 统一升级为 `outreach`,不落到默认 file。
- 测试覆盖:`man ls`、`help -m cd`、`netstat -an` read/allow;`man -P sh ls`、`help -P ls`、`netstat --tcp` outreach/ask。
- 口径:这一步补的是 CC-Haha 常用系统查询命令的 flag 安全门,不是完整迁移 checksum/docker/gh/fd/pyright 等剩余 COMMAND_ALLOWLIST。

## 3.353 2026-07-08 CC-Haha Bash checksum 只读安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 `sha256sum`、`sha1sum`、`md5sum` allowlist。关键行为:checksum 命令是 coding agent 常用读命令,但只应允许 hash 计算/校验/输出格式类 flag,未知 flag 不能落到默认 file 静默放行。
- TS 新增 `classifyChecksumCommand()`:复用 `classifyNamedReadOnlyCommand()` 覆盖 `sha256sum`、`sha1sum`、`md5sum`,允许 `-b/-t/-c/--check/--ignore-missing/--quiet/--status/--strict/-w/--warn/--tag/-z/--zero/help/version` 等 CC safe flags。
- 测试覆盖:`sha256sum package.tgz`、`sha256sum -c sums.txt`、`sha1sum --check sums.txt` read/allow;`md5sum --output sums.txt package.tgz`、`sha256sum --output sums.txt package.tgz` outreach/ask。
- 口径:这一步补的是 CC-Haha checksum read-only allowlist,不是完整迁移 docker/gh/fd/pyright 等剩余 COMMAND_ALLOWLIST。

## 3.354 2026-07-08 CC-Haha Bash `ss` socket 查询安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 `ss` allowlist。关键行为:`ss` 是 netstat 等价的 socket 查询工具,但 `-K/--kill` 会关闭 socket,`-D/--diag` 会把诊断数据写文件,`-F/--filter` 读取外部过滤表达式,都不能静默放行。
- TS 新增 `classifySsCommand()`:允许 `-tan` 这类组合短 flag、`--tcp/--listening`、family/query/socket/context/bpf/events 等 CC safe flags;未列入 flag 包括 `-K`、`--kill`、`--diag`、`-F` 统一升级为 `outreach`。
- 测试覆盖:`ss -tan`、`ss --tcp --listening` read/allow;`ss -K dst :80`、`ss --diag dump.bin` outreach/ask。
- 口径:这一步补的是 CC-Haha `ss` read-only allowlist,不是完整迁移 tput/fd/docker/gh/pyright 等剩余 COMMAND_ALLOWLIST。

## 3.355 2026-07-08 CC-Haha Bash `tput` capability 安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 `tput` allowlist 和 dangerous capability callback。关键行为:`tput cols` 这类查询是 read,但 `init/reset/clear/smcup/rmcup/pfkey/pfloc/...` 等 capability 会改终端状态、清屏或触发本地字符串执行风险;`-S` 从 stdin 读 capability 名,也不能静默放行。
- TS 新增 `classifyTputCommand()`:只允许 `-T`、`-V`、`-x` safe flags,并检查位置 capability 名;`-S` 和组合短 flag `-xS` 统一升级为 `outreach`。
- 测试覆盖:`tput cols`、`tput -T xterm cols` read/allow;`tput clear`、`tput -S`、`tput -xS cols` outreach/ask。
- 口径:这一步补的是 CC-Haha `tput` terminal capability 风险门,不是完整迁移 fd/docker/gh/pyright 等剩余 COMMAND_ALLOWLIST。

## 3.356 2026-07-08 CC-Haha Bash `fd/fdfind` 搜索安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 `FD_SAFE_FLAGS`。关键行为:`fd`/`fdfind` 是 coding agent 常用本地文件搜索命令,但 `-x/--exec` 和 `-X/--exec-batch` 会对搜索结果执行任意命令;`-l/--list-details` 内部执行 `ls`,存在 PATH hijack 风险,不能静默放行。
- TS 新增 `classifyFdCommand()`:复刻 CC 的 safe flags,覆盖 `fd` 与 Debian/Ubuntu 名称 `fdfind`;允许 hidden/no-ignore/glob/type/extension/depth/size/exclude/threads/search-path 等查询参数;未列入 flag 统一升级为 `outreach`。
- 测试覆盖:`fd -H -e ts dangerousCommand`、`fdfind --type f package` read/allow;`fd -x rm {}`、`fd --exec-batch rm`、`fd -l package` outreach/ask。
- 口径:这一步补的是 CC-Haha `fd/fdfind` read-only allowlist,不是完整迁移 docker/gh/pyright 等剩余 COMMAND_ALLOWLIST。

## 3.357 2026-07-08 CC-Haha Bash `pyright` 静态检查安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/shell/readOnlyCommandValidation.ts` 的 `PYRIGHT_READ_ONLY_COMMANDS`。关键行为:`pyright` 本地静态检查是 coding agent 常用验证命令,但 `--watch/-w` 会进入常驻监听,不能作为 read 静默放行。
- TS 新增 `classifyPyrightCommand()`:允许 `--project/-p`、`--outputjson`、python version/platform、typeshed/venv path、level/stats/verbose/version/dependencies/warnings 等 CC safe flags;未列入 flag 包括 `--watch/-w` 统一升级为 `outreach`。
- 测试覆盖:`pyright --project .`、`pyright --outputjson --warnings` read/allow;`pyright --watch` outreach/ask。
- 口径:这一步补的是 CC-Haha `pyright` read-only allowlist,不是完整迁移 docker/gh 等网络/容器相关 COMMAND_ALLOWLIST。

## 3.358 2026-07-08 CC-Haha Bash Docker 只读查询安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/shell/readOnlyCommandValidation.ts` 的 `DOCKER_READ_ONLY_COMMANDS` 和 `EXTERNAL_READONLY_COMMANDS`。关键行为:`docker ps/images/logs/inspect` 是 coding agent 常用容器排查读命令,但 `docker exec/stop/rm` 等会执行或改变容器状态,不能静默放行。
- TS 新增 `classifyDockerCommand()`:保留 `docker ps`、`docker images` 为 read;`docker logs` 只允许 `--follow/-f`、`--tail/-n`、`--timestamps/-t`、`--since`、`--until`、`--details`;`docker inspect` 只允许 `--format/-f`、`--type`、`--size/-s`;其他 Docker 子命令或未知 flag 统一升级为 `outreach`。
- 同步新增 Docker runtime env 护栏:`DOCKER_HOST`、`DOCKER_CONFIG` 等 `DOCKER_*` 前缀在 `VAR=value docker ...` 或 `env VAR=value docker ...` 形式下进入 `outreach`,避免把远端 daemon/config 改写伪装成本地 read 查询。
- 测试覆盖:`docker ps`、`docker images`、`docker logs --tail 100 app`、`docker logs -ft --since 1h app`、`docker inspect --format '{{.State.Status}}' app`、`docker inspect --type container app` read/allow;`docker exec app sh`、`docker logs --output out.txt app`、`env DOCKER_HOST=... docker ps`、`DOCKER_CONFIG=... docker images` outreach/ask。
- 口径:这一步补的是 CC-Haha Docker read-only allowlist 和 endpoint/config env 风险门,不是迁移 gh ant-only 网络命令或完整 tree-sitter AST 安全分析器。

## 3.359 2026-07-08 TS agent `edit_excel` 表格编辑工具迁移

- 目标:继续把文件工具链收敛到 TS coding-agent 内核,补上旧 Python agent/eval 中已有的表格编辑能力,让报表/CSV/XLSX 修改不再只依赖后端画布接口或 Python live eval。
- TS 新增 agent 级 `edit_excel` 工具,支持 `{ path, cell, value, sheet? }` 和 `{ path, changes:[...] }`,覆盖 `.csv` 与 `.xlsx`,并走 `resolveToolPath()`、workspace backup、`file_history` 快照、读后缓存刷新等统一文件编辑语义。
- 复用并抽出 `officeDocuments` 的 CSV/XLSX 编辑实现:画布 `/api/v1/canvas/excel-edit` 与 agent 工具共享同一套 cell 写回逻辑,保留 CSV 空文件/新文件从空表开始填格子的兼容行为。
- 前端同步把 `edit_excel` 纳入文件 mutation 流:工具审批 pending 显示“正在修改报表文件”,右侧预览 pending 文案切到表格预览,完成后复用现有本地文件 artifact/表格预览路径。
- 权限同步:CC 风格 `Edit` allowedTools alias 现在包含 `edit_excel`,slash command/skill frontmatter 授权编辑文件时也能授权报表修改。
- `server/evals/file_exec_live_test.py` 在下一步 3.360 中已删除:该 live eval 覆盖的 `read_file -> edit_file`、`edit_excel`、`write_file`、`run_command` 执行链路已由 TS harness 接住。
- 验证覆盖:TS 文件工具测试覆盖 CSV/XLSX 改格与 file history;registry 测试覆盖默认工具注册;command 测试覆盖 `Edit` alias;web hook 测试覆盖 pending/result artifact。

## 3.360 2026-07-08 旧 Python 文件执行 live eval 退场

- 删除 `server/evals/file_exec_live_test.py`:它依赖旧 Python FastAPI/DB/MiMo/live eval 壳子来验证执行类工具,与当前“coding agent 内核向 TS 收敛”的目标重复,且会让后续人员误以为 Python agent loop 仍是主路径。
- TS 新增 `runs file execution scenario through TS agent loop...` harness 用例,从 `runAgentLoop()` 走模型 tool call、权限闸、工具执行、结果回灌全链路,覆盖旧脚本的核心执行面:`read_file` 后 `edit_file` 改文案、`edit_excel` 改 XLSX、`write_file` 写执行记录、`run_command` 只读列目录核对。
- 该测试使用 `permissionMode:"full"` 模拟旧脚本非交互执行模式,但仍保留工具层 fatal/危险命令硬拒和 `edit_file` 读前置保护,不会退化成绕过内核安全。
- Python 文件数降到 394。仍不动生产 Python FastAPI、媒体/OCR/语音/ffmpeg/发布器链路;这些必须等 TS/native sidecar 等价链路、调用点切换和真实 smoke 通过后再删。

## 3.361 2026-07-08 旧 Python agent 工具真模型 E2E 退场

- 删除 `server/evals/agent_tools_e2e.py`:该脚本用旧 Python agent registry + MiMo 真模型验证 list/find/search/read/write/edit/run/edit_excel 等工具选择,与 TS coding-agent 主路径重复。
- TS 新增 `ts/scripts/smoke/agent-tools-live.smoke.ts` 和 `bun run smoke:agent-tools`:用真实模型、`buildGeneralRegistry()`、临时工作区和 `runAgentLoop()` 验证模型能实际调用 `read_file`、`write_file`、`edit_file`、`edit_excel`、`run_command`,并核对文件/表格真实落盘结果。
- smoke 默认读取 `../desktop/bundled.env` 与 `../server/.env.bundled.local`,只输出脱敏 provider summary 和工具结果摘要;没有真 key 时不进普通 `bun test`,避免日常开发误烧模型额度。
- `server/evals/README.md` 已更新退场边界:内容质量/北极星/业务场景 Python eval 暂留,命令安全/工具权限/文件执行类回归继续往 TS 测试和 TS smoke 集中收敛。
- Python 文件数降到 393。

## 3.362 2026-07-08 CC 权限模式/acceptEdits 语义对齐(历史记录,已被 3.399 修正)

> 2026-07-09 修正:本节“四档”和“default 文件类直接 allow”的判断已被 3.399 覆盖。cc 当前外部模式包含 `dontAsk`;default 未命中 allow 规则时应对 file 类动作 ask,`acceptEdits` 才自动接受编辑。

- 当时对照源:`~/Desktop/cc-haha-ref/src/types/permissions.ts` 与 `src/tools/BashTool/modeValidation.ts`;后续复核确认 cc 当前外部模式应包含 `dontAsk`,详见 3.399。
- 当时曾把 `approvalClass:"file"` 在 default 也直接 allow;该旧差异已撤销。当前 default 未命中 allow 规则时 ask,`acceptEdits/auto_files` 才放行 file 类动作。
- 当时 `echo hi > note.txt` 在默认档直接执行;当前行为已改为 default ask、acceptEdits allow;外联/不可逆/强确认继续 ask/deny。
- 前端权限文案已在 3.399 同步为 default 改动先问、acceptEdits 自动接受编辑。
- 兼容边界:旧 API/旧 localStorage/旧 agent frontmatter 仍接受 `ask/auto_files/full`,但会归一到 `default/acceptEdits/bypassPermissions`;新前端和新文档展示 CC 五档名。

## 3.363 2026-07-08 旧 Python harness 轨迹 eval 退场

- 删除 `server/evals/harness_eval.py`:该脚本用旧 Python agent loop + 真模型跑文件读写、危险命令、Prompt 注入、沙箱越界等轨迹对抗,与当前 TS coding-agent 主路径重复。
- TS harness 补齐旧脚本最关键的组合轨迹断言:`read_file` 读到带恶意指令的文件后,模型即便继续发起 `run_command rm -rf /`,也会被权限瀑布的 fatal 硬拒拦下并作为 `tool_result` 回灌;原工作区文件保持存在。
- TS harness 同步覆盖工作区边界:模型尝试 `read_file /etc/hosts` 时不会读取系统文件,而是把越界错误作为 `is_error` tool result 回灌给模型,避免旧 Python eval 中“沙箱外被挡/未读到”的验收点丢失。
- `server/evals/README.md` 已把 `harness_eval.py` 加入已退役清单,明确 coding-agent 命令安全/工具权限/文件执行/轨迹对抗继续集中到 TS 测试和 TS smoke。
- Python 文件数降到 392。`server/evals/architecture_live_test.py` 还牵到旧 FastAPI/真实业务问答链路,暂不删除;必须等 TS API/知识库/业务问答等价 smoke 接住后再退场。`server/evals/agent_full_scenario_test.py` 在 3.367 已由 TS agent-tools smoke 接住后删除。

## 3.364 2026-07-08 CC 权限命名兼容落地(历史记录,已被 3.399 修正)

> 2026-07-09 修正:本节“四档”已被 3.399 覆盖为外部五档;旧值 `ask/auto_files/full` 仍作为兼容别名,但新 UI/API/内核类型包含 `dontAsk`。

- 统一权限归一化层后续已扩为 CC 外部五档:`default/acceptEdits/plan/bypassPermissions/dontAsk`,并兼容旧值 `ask -> default`、`auto_files -> acceptEdits`、`full -> bypassPermissions`。
- TS server、Agent frontmatter、主循环、计划模式退出、队友计划审批响应都以 canonical CC 模式运行。旧请求体、旧会话、旧 frontmatter 继续可读,但内部决策和新输出统一为 CC 名称。
- 前端输入区权限菜单保存/发送 `default/acceptEdits/plan/bypassPermissions/dontAsk`;读取旧 localStorage 时自动迁移旧三档,避免用户升级后偏好丢失。
- `/permissions` 命令文档应同步成 CC 五档口径,强调审批闸由模式、规则、路径和强确认共同决定。
- 旧 Python 线的 `full` 自动花费次数闸不再保留在 TS 权限内核中:`bypassPermissions` 跳过普通确认;真实不能自动执行的动作必须显式标 `forceConfirm` 或 `requiresUserInteraction`。

## 3.365 2026-07-08 CC 工作目录/全盘访问运行语义落地

- 对照源:`~/Desktop/cc-haha-ref/src/types/permissions.ts` 的 `AdditionalWorkingDirectory`、`src/tools/BashTool/pathValidation.ts` 的 allowed directories、`src/constants/prompts.ts` 的 primary/additional working directories 提示。关键行为:选定项目文件夹是默认 cwd,但 Agent 仍可在获授权范围内访问其它本机路径。
- 桌面前端现在默认随请求传 `full_disk_access:true`:用户选择/新建的 `working_dir` 继续作为目录树根、命令默认 cwd、项目指令和工作记忆 scope;同时绝对路径读取/编辑不再被误限制在当前工作区,满足“让它去桌面或其它地方找东西也能找到”的本地桌面语义。
- `run_command` 工具描述同步:默认 cwd 是选定工作区;`cwd` 可是工作区相对路径或已授权绝对路径,桌面全盘会话允许从外部目录执行。危险命令、网络/安装/发布、不可逆动作仍由 Bash 风险分类和权限闸处理。
- 回归测试新增 `/agent/run keeps working_dir as command cwd while desktop full disk can read external absolute paths`:同一轮模型先执行 `pwd` 验证 cwd 为 `working_dir`,再 `read_file` 读取工作区外绝对路径,确保 UI 文案、请求参数和后端 Workspace 行为一致。
- 与 `selected_files` 的关系:显式选中文件仍作为窄授权兼容路径保留;桌面默认全盘是本地壳的常态,`selected_files` 主要服务附件/素材和非全盘请求的精确授权。

## 3.366 2026-07-08 平台发布 RPA 退场

- 根据当前目标第 12 点“对外发布:不发布”,删除旧桌面平台发布链路:`desktop/src/publish.js`、`desktop/publisher/*.py`、`desktop/scripts/build_publisher.js`、`desktop/resources/publisher-bin` 占位全部退场。
- Electron 主进程移除 `publish:*` IPC handler 和 `publish.dispose()`;preload 不再暴露 `window.electron.publish`;Web 类型声明删除 `PublishContent/PublishPlatform/LoginStatus` 和 publish bridge。
- 打包配置移除 `publisher`、`publisher-bin` extraResources 与 asarUnpack,避免安装包继续携带 Python RPA worker 或给用户制造“可发布”的暗示。
- 前端成品卡删除 `SHOW_PUBLISH` dead branch 与 `onPublish` prop;成品只支持打开右侧画布、复制、保存/导出,不提供平台发布按钮。
- 文档口径同步:当前产品不内置平台发布 RPA;生图、生视频、剪辑产物是给用户检查、保存或导出的本地成品。自动更新配置 `desktop/package.json build.publish` 是安装包更新源,不属于用户内容平台发布,保留。
- Python tracked 文件数提交后从 392 降到 382。仍不动 FastAPI/媒体/OCR/语音/视频编辑等活链,这些继续按 TS/Node/native 等价链路接住后再分批退场。

## 3.367 2026-07-08 旧 Python BYOK/Agent 场景 smoke 退场

- 删除 `server/evals/_byok_api_test.py` 与 `server/evals/_byok_e2e.py`:这两份是早期临时 BYOK 真连接脚本,已被 TS provider 配置解析、provider 持久化/failover 测试和 `bun run smoke:model` 覆盖。新路径不会依赖 Python FastAPI 临时脚本来证明模型连通。
- 删除 `server/evals/agent_full_scenario_test.py`:该脚本用旧 Python Agent loop + MiMo 真模型对本地物料目录做读写场景,与当前 TS coding-agent 主路径重复;真实工具链 smoke 已收敛到 `ts/scripts/smoke/agent-tools-live.smoke.ts`,覆盖 `read_file`、`write_file`、`edit_file`、`edit_excel`、`run_command` 真落盘链路。
- `server/evals/README.md` 同步退场边界:旧 Python eval 只保留尚无 TS 等价的内容质量/北极星/业务场景评测;命令安全、工具权限、文件执行、轨迹对抗、provider/BYOK 连通继续进入 TS 测试和 TS smoke。
- `ts/src/harness/prompts.ts` 移除旧平台发布授权例子,改成群发/强推这类真实高风险动作,避免用户目标第 12 点“对外发布:不发布”之后仍在 coding-agent 内核提示里暗示平台发布功能。
- Python tracked 文件数提交后从 382 降到 379。剩余 Python 仍按“TS/Node/native 等价实现 + 调用点切换 + 测试/smoke 通过”逐块退场,不直接删除仍在运行的 FastAPI/媒体/OCR/语音/视频编辑链路。

## 3.368 2026-07-08 欢迎屏低噪入口与专家挂载收敛

- 按 owner 关于“主要对话窗口前面不要展示很多卡片”的反馈,删除欢迎屏 `最近作品 / 任务` 列表:空态只保留标题、极短说明、轻量快捷入口和必要的一条店况/报表提示。最近会话仍在侧栏,继续上次工作仍用单一 `继续上次工作` action,不再把作品/任务铺在主输入前。
- `WelcomeScreen` 移除 `recentItems/onOpenRecent/onDeleteRecent` props,`DesktopChatShell` 删除对应打开/删除最近作品的欢迎屏分支;成品查看仍由右侧 preview、对话成品卡、最近删除/恢复链路承担,不再污染主对话入口。
- 空态文案从功能说明改成短句:“说清目标就行;需要你拍板的地方我会停下来问。” 输入框 placeholder 改成 “说任务,或输入 /”,避免在输入区继续解释功能。
- 专家挂载保持在 composer 常驻 `专家:通用 Agent/台球运营专家` 入口和 `+` 菜单里,符合 Work Buddy 式“选择专家后挂载到输入流”的做法;店铺资料库仍从顶栏/资料库面板进入,与专家包分开呈现。
- 设计规范同步:欢迎区不能堆卡片墙,也不展示最近作品/任务列表;输入区文档更新为 CC 权限模式与专家挂载口径。竞品筛选文档把后台任务例子从“发布”改成“生视频”,保持“对外发布:不发布”的当前目标。

## 3.369 2026-07-08 CC Bash `xargs` 只读安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 `xargs` allowlist、`SAFE_TARGET_COMMANDS_FOR_XARGS`,以及 `src/utils/shell/readOnlyCommandValidation.ts` 的 flag-walking parser differential 防护。
- `run_command` 风险分类新增 `xargs` 专用只读门:只有 `echo/printf/wc/grep/head/tail` 这类纯输出/读取目标会归为 `read`;`curl/sh` 等目标命令直接归为 `outreach`,交由审批闸处理。
- 保留 CC 的关键安全边界:`-I {}`、`-E EOF`、`-n/-P/-L/-s/-0/-t/-r/-x/-d` 可验证;`-E=` 空值附着、`-rI` 这类可能让 validator 与 GNU xargs 参数消费不同步的写法不自动放行。
- 新增回归覆盖 `xargs grep needle`、`xargs -0 -n 5 head`、`xargs -I {} grep needle {}` 直接 read,以及 `xargs curl ...`、`xargs sh -c id`、`xargs -E= EOF echo foo`、`xargs -rI echo sh -c id` 升级为 outreach。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts src/permissions/resolve.test.ts --timeout 120000` = 50 pass。

## 3.370 2026-07-08 CC Git read-only map 片段迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/shell/readOnlyCommandValidation.ts` 的 `GIT_READ_ONLY_COMMANDS`,先迁入 coding 高频且原 TS 粗正则覆盖不足的一组: `git merge-base/rev-list/cat-file/for-each-ref/describe/blame/shortlog/reflog/stash list/stash show/worktree list/branch/tag`。
- `run_command` 新增 Git 多词命令最长优先匹配与 flag allowlist 校验,避免把 `git stash show -p` 误判成写入型 `stash`,也避免把未知 Git 子命令误当 read。
- 保留 CC 的 branch/tag/ref 安全边界:`git branch --list`、`git tag --list` 是 read;`git branch new-topic`、`git tag v1.0.0` 会归为 file,plan 档拒绝。`git reflog show --all` 是 read,`git reflog expire --all` 归为 file。
- 补 `$` 与 brace expansion 风险门:只在命中 Git read-only 白名单后检查参数,不会抢走 `git commit -m '$(literal)'` 这类非 read-only 命令的既有 file 分类。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts src/permissions/resolve.test.ts --timeout 120000` = 50 pass。

## 3.371 2026-07-08 CC `grep`/`rg` 搜索命令安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 `grep` allowlist 与 `~/Desktop/cc-haha-ref/src/utils/shell/readOnlyCommandValidation.ts` 的 `RIPGREP_READ_ONLY_COMMANDS`。
- `run_command` 不再用最后的粗正则把任意 `rg/grep` 都归为 read;现在必须先通过安全 flag allowlist。常用 `rg -n -C2 TODO -g *.ts src`、`rg --json --stats TODO src`、`grep -R -n --include *.ts TODO src` 仍是 read。
- `rg --pre bash`、`rg --pre-glob ...`、`grep --mmap ...` 等未在 CC allowlist 内的参数归为 file,在 plan 档会被拒绝,避免搜索命令变成外部预处理器/不明执行路径。
- 继续复用已有 `$`/parser 风险门;`rg`/`grep` 的参数若带 shell expansion 或换行注入仍按 outreach 处理。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts src/permissions/resolve.test.ts --timeout 120000` = 50 pass。

## 3.372 2026-07-08 CC Git 核心 read-only map 补齐

- 继续对照 `GIT_READ_ONLY_COMMANDS`,把 `git diff/log/show/status/ls-files/config --get/remote/remote show/git grep/ls-remote/rev-parse` 并入 TS 同一张 Git read-only map,不再靠末尾粗正则放行。
- 常用 coding 查询保持 read:`git diff --stat --cached`、`git log --oneline --max-count 5`、`git show --format=short HEAD`、`git status --porcelain=v1 --branch`、`git ls-files --others --exclude-standard`、`git grep -n TODO -- ts`。
- 写入/外联风险参数收口:`git diff --output=/tmp/patch.diff`、`git log --output=/tmp/log.txt`、`git grep --open-files-in-pager TODO` 归 file;`git remote add ...`、`git remote show https://...`、`git ls-remote https://...` 不再静默 read。
- 删除最后的 `git status|diff|log|show|rev-parse|ls-files|grep|remote -v` 粗兜底,后续 Git read-only 都必须走 allowlist + callback。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts src/permissions/resolve.test.ts --timeout 120000` = 50 pass。

## 3.373 2026-07-08 CC Git `rev-parse` map 一致性补漏

- 复核 3.372 后发现文档已声明 `git rev-parse` 并入 Git read-only map,但代码实际遗漏该条;本轮按 CC 配置补齐 `git rev-parse` safeFlags。
- `git rev-parse --show-toplevel`、`git rev-parse --verify --short HEAD` 归 read;未知写入风格参数如 `git rev-parse --output=/tmp/rev.txt HEAD` 归 file。
- 该补漏保持“文档和实现一致”的迁移口径,后续所有声称已迁移的 CC 命令都要有代码与测试双证据。

## 3.374 2026-07-08 旧 Python Agent eval/probe 退场

- 删除 `server/evals/run_agent_eval.py` 与 `server/evals/agent_cases.yaml`:这套旧 Python eval 评的是 Python agent loop 的工具选择、审批闸和编排质量;当前 coding-agent 主链已迁到 TS `runAgentLoop()`、权限五档、Bash/Git 安全门和 `smoke:agent-tools`,继续保留会把旧 Python agent loop 误认成主路径。
- 删除 `server/evals/_stability_probe.py`:文件头已标注“用完即删”,它只是对北极星场景重复跑 N 次的临时探针;后续稳定性看 `run_northstar_eval.py --categories ... --tag ...` 多次报告对比,不再单独留 Python 脚本。
- 保留 `run_northstar_eval.py`、`knowledge_routing_harness.py`、`architecture_live_test.py`:它们还覆盖业务内容质量、知识路由和旧 FastAPI 真实业务问答链路,在 TS/native 等价 smoke 接住前不能删除。
- Python tracked 文件数从 379 降到 377。后续删除顺序仍是:离线脚本/旧 eval -> 已被 TS 入口覆盖的边角服务 -> 媒体/OCR/语音/视频/RAG 活链;每一批都必须先有 TS/Node/native 等价实现、调用点切换和测试/smoke 证据。

## 3.375 2026-07-09 CC Bash 敏感读路径审批门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/pathValidation.ts` 的按命令抽取路径并走统一 path validator 思路,先把 TS `run_command` 中最危险的“读类命令显式读取凭据文件”补成审批门。
- 新增 `shellSensitiveReadNeedsApproval()`:识别 `cat/head/tail/wc/grep/rg/find/sed/stat/file/sha*sum/base64/...` 等读类命令中的 `.env*`、`~/.ssh/*`、`id_rsa/id_ed25519`、`*.pem/*.key/*.p12/*.pfx`、secret/token/password/credential/api-key/private-key 命名路径。
- 行为边界:`cat ~/.ssh/id_rsa`、`cat .env`、`grep TOKEN .env`、`rg TOKEN .env`、`wc -c ~/.ssh/id_rsa`、`find ~/.ssh -type f` 升级为 `outreach` 审批;`cat package.json`、`rg TODO src`、`cat src/tokenizer.ts` 保持 read/allow,不打断正常 coding 查询。
- 审批卡文案会明确显示“可能读取敏感凭据文件”,而不是泛泛说网络外联;确认后仍可执行,不硬禁,保持 CC 风格的强能力 + 明确授权边界。

## 3.376 2026-07-09 旧 Python Agent harness 付费评测退场

- 删除 `server/tests/eval_agent_harness.py`:该脚本用旧 Python `services.agent.loop` + 真模型评测工具选择、多步文件操作、长输出、autocompact 和防空转;这些都属于 coding-agent 内核行为,当前主链已由 TS `runAgentLoop()`、`src/harness/loop.test.ts`、权限测试、文件工具测试与 `bun run smoke:agent-tools` 承接。
- 删除 `scripts/test.sh --eval-agent` 入口,避免后续把旧 Python Agent loop 当成仍需付费回归的主路径。`scripts/test.sh --eval` 仍保留给店脑/北极星类业务内容质量验收,因为那部分还没有完整 TS 等价。
- `server/evals/README.md` 和根入口文档同步退场边界:Agent 循环行为、命令安全、工具权限、文件执行、provider 连通继续往 TS 测试和 TS smoke 收敛;Python 侧仅暂留内容质量/知识路由/旧 FastAPI 真实业务问答链路。
- Python tracked 文件数从 377 降到 376。剩余 Python 删除顺序不变:先清离线脚本/旧 eval,再清已被 TS/native 入口覆盖的边角服务,最后才动仍在真实运行的 FastAPI、媒体、OCR、语音、RAG 和视频链路。

## 3.377 2026-07-09 CC Bash dangerous removal path guard 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/pathValidation.ts` 的 `checkDangerousRemovalPaths()`、`filterOutFlags()` 与 `~/Desktop/cc-haha-ref/src/utils/permissions/pathValidation.ts` 的 `isDangerousRemovalPath()`。
- 新增 `shellDangerousRemovalNeedsApproval()`:对 `rm/rmdir` 先抽取路径参数,正确处理 POSIX `--` 结束参数;路径命中根目录、home、根目录直属子目录、Windows 盘符根/直属子目录、`*` 或 `.../*` 风险形态时升级为 `destructive` 审批。
- 关键行为:`rm -- /`、`rmdir /`、`rm -f /tmp`、`rm -f ~`、`rm node_modules/*`、`rm C:/Windows` 都进入 destructive 审批;`rm -f build/cache` 与 `rm -- -not-a-flag.txt` 仍保持普通 file 风险,不干扰日常 coding 清理。
- `run_command` 动态权限接入实际 cwd 后再跑危险删除路径判断,避免相对路径在非工作区 cwd 下误判。灾难级 `rm -rf /` 等仍由 `isDangerousCommand()` 硬拒,本轮补的是 CC 风格“不能被自动放行、但可由用户明确审批”的危险路径层。

## 3.378 2026-07-09 CC Bash `mv/cp` flags 手动确认门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/pathValidation.ts` 的 `COMMAND_VALIDATOR`:CC 对 `mv/cp` 带任意 flag 的命令直接要求人工确认,因为 `--target-directory=PATH`、`-t PATH` 等参数会绕过普通源/目标路径抽取。
- 新增 `shellMvCpFlagsNeedApproval()`:识别 `mv`/`cp` 带 `-` 或 `--` flag 的命令,包括 `env FOO=bar mv -t /tmp source.txt` 这类安全 wrapper 后的真实命令。
- 行为边界:`cp source.txt target.txt`、`mv source.txt target.txt` 仍是普通 file 风险,在执行档可直接做;`cp --target-directory=/tmp source.txt`、`cp -t /tmp source.txt`、`mv -f source.txt target.txt`、`mv -t /tmp source.txt` 升级为 outreach 审批,避免被 file 类自动放行。
- 这一步不是禁止 `mv/cp` 使用 flags,而是把“路径无法可靠验证”的形态交给用户确认,与 CC 的强能力 + 明确授权边界一致。

## 3.379 2026-07-09 CC Bash compound `cd` + write 手动确认门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/pathValidation.ts` 的 `compoundCommandHasCd && operationType !== 'read'` 守卫:CC 对先 `cd/pushd/popd` 再执行写操作的复合命令要求人工确认,因为后续相对路径已经不再基于原 cwd。
- 新增 `shellCdWriteNeedsApproval()`:识别复合命令中同时存在 `cd/pushd/popd` 与写类动作,覆盖 `mv/cp/rm/mkdir/rmdir/touch/chmod/chown/ln/tee`、输出重定向、`sed/perl -i` 和写类 git 子命令。
- 行为边界:`cd sub && ls -la`、`cd sub && grep TODO file.txt` 保持只读;`cd sub && mv a b`、`cd sub && rm file.txt`、`pushd sub && touch note.txt`、`cd sub && sed -i ...` 升级为 outreach 审批。
- 这一步补的是路径解析正确性,不是扩大“所有 cd 命令都要审批”。纯读探索仍保持 coding agent 的低摩擦体验。

## 3.380 2026-07-09 CC Bash `git diff --no-index` 敏感路径门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/pathValidation.ts` 的 `git diff --no-index` 特判:该命令允许比较仓库外任意两个文件,不能只按普通 Git read-only allowlist 看待。
- 新增 `gitDiffNoIndexSensitivePathNeedsApproval()`:抽取 `git diff --no-index` 的两个路径参数,正确处理 `--` 与 `-S/-G/-O` 等带值选项;路径命中 `.env*`、`~/.ssh/*`、私钥、token/password/credential 命名时升级为 outreach 审批。
- 行为边界:`git diff --no-index before.txt after.txt` 仍是 read;`git diff --no-index .env package.json`、`git diff --no-index -- ~/.ssh/id_rsa package.json`、`git diff --no-index -S needle -- .env package.json` 都会弹 outreach 审批。
- 这一步先补敏感凭据读取门,不是完整文件系统 allow/deny path validator。后续仍需继续迁移 CC 的 AST path constraints、权限规则持久化和更完整的任意路径读写确认。

## 3.381 2026-07-09 旧 Python 辅助脚本即时退场

- 删除旧 gzip 样例 Python 生成器:它不属于运行中的 FastAPI/dataeye 接收端,已经有等价 Node 脚本接住。
- 新增 `dataeye/tests/make_sample.mjs`:生成同形状 `sample.json.gz`,覆盖 `event/gen/trace/store` 四类样例;README 与部署 runbook 冒烟命令同步改为 `node dataeye/tests/make_sample.mjs`。
- 验证:Node 生成 gzip 后解压校验 machine_id 与 batch kind;当时保留的接收端 Python 契约测试已在 3.390 迁到 `cd dataeye && bun test tests/receiver.test.ts`。
- 这一步落实“旧 Python 有等价替代就立刻删”的规则;`server/main.py`、媒体/语音/OCR/RAG/视频链路、业务质量 eval 在 TS/native 等价链路和 smoke 接住前继续保留,避免把活产品砍坏。

## 3.382 2026-07-09 CC Bash safe wrapper stripping 迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/pathValidation.ts` / `bashPermissions.ts` 的 safe-wrapper stripping:CC 会先剥 `timeout/time/nice/stdbuf/nohup/env` 这类安全包装,再对真实子命令做路径/审批判断。
- 新增 `stripShellClassificationWrappers()`:统一用于敏感读取、危险删除、`mv/cp` flag、`git diff --no-index` 和主 `classifySegment`。`nice rm -f /tmp`、`stdbuf -o0 rm -f /tmp`、`nohup -- rm -f /tmp`、`timeout --signal TERM 5 rm -f /tmp` 不再因为外层 wrapper 漏过 destructive 分类。
- 保持 fail-closed:`env -S` / `--split-string` / `--chdir` 这类会改变 argv 或 cwd 的形式不剥掉,继续走 parser-risk / outreach;普通 `time git status --short` 仍保持 read。
- 这一步补的是 CC 的路径验证对称性:安全包装本身不是审批对象,真实子命令才是审批对象。

## 3.383 2026-07-09 CC Bash `stdbuf` wrapper 参数形态补齐

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/pathValidation.ts` 的 `skipStdbufFlags()`:CC argv 路径支持 `stdbuf -o0 cmd`、`stdbuf -o 0 cmd`、`stdbuf --output=0 cmd` 这三类安全 wrapper 形态。
- 扩大 TS `stripSafeShellWrappers()` 的 `stdbuf` 匹配:`stdbuf -o 0 npm run build` 和 `stdbuf --output=0 npm run build` 能归一到真实命令,permission rule 匹配和 Bash 风险分类都看到子命令。
- 行为边界:`stdbuf -o 0 rm -f /tmp`、`stdbuf --output=0 rm -f /tmp` 判 destructive;这不是放宽审批,而是避免 wrapper 遮蔽真实子命令。

## 3.384 2026-07-09 CC Bash permission rule fixed-point wrapper/env 匹配

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/bashPermissions.ts` 的 `commandsToTry` fixed-point 迭代:CC 会反复剥 safe wrappers 与环境变量前缀,直到命令候选不再变化,以处理 `nohup NODE_ENV=test timeout 5 cmd` 这类交错包装。
- TS `commandCandidatesForPermissionRule()` 改为固定点候选生成:`nohup NODE_ENV=test timeout 5 npm run build` 可以匹配 `npm run *`;这让用户已授权的真实命令在多层安全 wrapper 下仍能命中。
- 行为边界:allow rule 仍只剥安全 env var。`nohup PATH=/tmp timeout 5 npm run build` 不匹配 `npm run *`,避免任意 env var 扩大 allow rule。

## 3.385 2026-07-09 CC `git ls-remote --server-option` 外联门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/shell/readOnlyCommandValidation.ts` 的 `git ls-remote` 注释和 `~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 URL guard:CC 明确把 `--server-option`/`-o` 排除出只读安全 flag,因为它会把任意字符串发给远端 Git server。
- TS `classifyGitReadOnlyCommand()` 新增 `gitLsRemoteHasServerOption()` 专项门:`git ls-remote --server-option=secret origin`、`git ls-remote -o secret origin`、`git ls-remote -osecret origin` 升级为 `outreach` 审批。
- 普通 `git ls-remote --get-url` 仍是 `read`;URL/SSH remote 参数仍按既有 guard 归 `file` 风险。这一步只拦能外传任意字符串的 server-option,不扩大所有 unknown Git flag 的审批面。

## 3.386 2026-07-09 CC `gh` 网络查询外联门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/shell/readOnlyCommandValidation.ts` 的 `GH_READ_ONLY_COMMANDS` 与 `ghIsDangerousCallback`:CC 对 GitHub CLI 的 `--repo/-R`、URL、`HOST/OWNER/REPO` 形态做额外防外传校验。
- TS 当前产品口径更收紧:审批闸只要涉及外部网络/账号就问,所以不把 `gh pr view/list` 降成本机 `read`;本轮改为统一识别 `gh/glab` 命令族,除 `--version/version/--help/help/-h` 这种本机帮助外,其它 `gh run list`、`gh workflow view`、`gh label list`、`gh search repos`、`glab mr list` 全部归 `outreach`。
- 价值:补上此前正则只覆盖 `api/auth/repo/pr/issue/release` 的缺口,避免 GitHub/GitLab CLI 的 workflow/run/search/label 等网络查询在 default/acceptEdits 下被当普通 file 风险放行;同时保持本机版本/帮助查询不打断 coding 流。

## 3.387 2026-07-09 CC Pyright `--` parser-differential 门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/shell/readOnlyCommandValidation.ts` 的 `PYRIGHT_READ_ONLY_COMMANDS`:CC 明确设置 `respectsDoubleDash:false`,因为 pyright 把 `--` 当路径而不是 POSIX end-of-options。
- TS `classifyNamedReadOnlyCommand()` 现在可接完整 `ReadOnlyCommandConfig`;`classifyPyrightCommand()` 传入 `respectsDoubleDash:false`。
- 行为边界:`pyright --project .`、`pyright --outputjson --warnings` 仍是 `read`;`pyright --watch`、`pyright -- --watch`、`pyright -- --createstub os` 都归 `outreach`,避免 `--` 后的写文件/常驻类 flag 被误当只读路径。

## 3.388 2026-07-09 CC string flag 参数防注入门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/shell/readOnlyCommandValidation.ts` 的 `validateFlags()` 防线:CC 对 `string` 类型 flag 参数做 defense-in-depth,默认拒绝以 `-` 开头的参数值,防止“某个 flag 实际不吃参数”时把下一段危险 flag 注入进真实命令。
- TS `flagArgMatches()` 新增 `flag/config` 上下文:string 参数若以 `-` 开头会拒绝;保留 Git `--sort -refname` 这类明确安全的反向排序例外。
- 行为边界:`git log --format --output=/tmp/log.txt` 不再误判 `read`,降到 `file`;`rg --glob --pre=bash TODO src`、`fd --type --exec-batch rm` 这类包含执行能力的注入形态归 `outreach`;`git for-each-ref --sort -refname refs/heads` 保持 `read`。

## 3.389 2026-07-09 CC Git 全局配置/执行路径门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 regex 兜底:CC 对 Git 命令里的 `-c`、`--exec-path`、`--config-env` 做额外拦截,因为它们可以注入 `core.fsmonitor`、`diff.external`、`core.gitProxy` 或替换 Git 查找可执行文件的目录。
- TS 新增 `gitGlobalOptionNeedsApproval()`:任何 `git` 命令出现 `-c`/`-c...`、`--exec-path[=...]`、`--config-env[=...]` 都归 `outreach` 审批。
- 行为边界:`git status --porcelain=v1 --branch` 保持 `read`;`git -c core.fsmonitor=evil status --short`、`git -ccore.fsmonitor=evil status --short`、`git --exec-path=/tmp status --short`、`git --config-env=core.fsmonitor=EVIL status --short` 都进入 `outreach`,避免被 file 类自动放行。

## 3.390 2026-07-09 dataeye 接收端 Python 退役

- 删除 `dataeye/receiver/app.py`、`dataeye/receiver/db.py`、`dataeye/receiver/requirements.txt` 与 `dataeye/tests/test_receiver.py`:接收端从 FastAPI/asyncpg 迁到 Bun/TS,不再需要独立 Python venv。
- 新增 `dataeye/receiver/app.ts`、`db.ts`、`path.ts` 与 `tests/receiver.test.ts`:保留原 `/health`、`POST /ingest`、Bearer 令牌、gzip 解压、256MB 解压上限、raw_inbox 幂等、`event/gen/store/trace` 整理、trace 正文路径分量清洗与 commonpath 复核。
- 部署同步:systemd 模板从 `uvicorn app:app` 改成 `bun run receiver/app.ts --host 127.0.0.1 --port 9100`;README/runbook 的本地测试与冒烟命令改成 Bun。
- 验证:`cd dataeye && bun test tests/receiver.test.ts` 通过 21 项。当时 `dataeye/board/app.py` 仍是独立只读看板,未在本轮混删;已在 3.393 由 TS 看板接住后退役。

## 3.391 2026-07-09 CC xargs optional lowercase flag regression guard

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 xargs 注释:CC 明确移除 lowercase `-i`/`-e`,因为 GNU getopt 的 optional-attached-arg 语义会让 validator 与真实 xargs 对目标命令位置判断不一致。
- TS 实现此前已未把 `-i`/`-e` 放入 `XARGS_SAFE_FLAGS`;本轮新增回归测试钉住 CC 注释里的攻击形态:`xargs -it tail a@evil.com`、`xargs -e EOF echo foo`、`xargs -i{} grep needle {}` 都必须归 `outreach`。
- 同时确认安全替代形态保持低摩擦:`xargs -r -I {} grep needle {}` 与 `xargs -E EOF echo foo` 仍为 `read`。这一步是防未来回退,不是扩大所有 xargs 的审批面。
- 验证:`cd ts && bun test src/tools/runCommandTool.test.ts --timeout 120000` 通过 37 项。

## 3.392 2026-07-09 CC env/printenv 环境输出安全门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 System info regex 注释:CC 已把 `env` 和 `printenv` 从只读白名单移除,原因是它们会暴露敏感环境变量。
- TS 风险分类新增 `environmentCommandNeedsApproval()`:裸 `env`、`env -0`、`printenv`、`printenv PATH`、`FOO=bar env`、`FOO=bar printenv` 统一升为 `outreach`,避免在 `auto_files` 下静默泄漏 provider/API token。
- 行为边界:作为 runtime wrapper 的安全形态仍按真实子命令分类,例如 `env git status --short` 保持 `read`;`env --chdir/-C`、`env -S/--split-string` 这类改变 cwd 或重解析 argv 的形态继续升为 `outreach`。
- 测试覆盖:`runCommandTool.test.ts` 覆盖环境输出命令的 classify 与 permission 瀑布,并确认 `env git status --short` 在 `ask` 模式仍能直接 allow。

## 3.393 2026-07-09 dataeye 只读看板 Python 退役

- 删除 `dataeye/board/app.py`:它是 dataeye 里最后一个独立 FastAPI 小入口;本轮用 Bun/TS 等价接住后再删,没有直接砍运行链路。
- 新增 `dataeye/board/app.ts`:保留 `/board`、`/board/generations`、`/board/transcripts`、`/board/cost`、`/board/events`、`/board/healthz` 路径契约,继续只读查 Postgres,保持北京时间切日、30 天趋势、好评/差评 pill、HTML 转义和自动刷新。
- 新增 `dataeye/tests/board.test.ts` 与 `dataeye/deploy/dataeye-board.service`;nginx 模板从 3001/Metabase 占位改为反代 `127.0.0.1:9200` 的 Bun 看板。README/runbook/遗留文档同步为 receiver + board 双 Bun 服务。
- 验证:`cd dataeye && bun test tests/receiver.test.ts tests/board.test.ts` 覆盖接收端与看板;看板测试注入假 `BoardDb`,不需要真 PG。

## 3.394 2026-07-09 CC git reflog 写子命令审批门迁移

- 对照源:`~/Desktop/cc-haha-ref/src/utils/shell/readOnlyCommandValidation.ts` 的 `git reflog` allowlist 注释:CC 明确阻断 `git reflog expire/delete/exists`,因为这些 positional subcommand 会写 `.git/logs/**`;只有裸 `git reflog` 和 `git reflog show` 是只读。
- TS 原先已识别这些子命令,但返回 `file`,在 `acceptEdits/auto_files` 下可能被当本机文件动作直接放行。本轮把 `matched.config.isDangerous` 从 `file` 升为 `outreach`,使 `git reflog expire --all`、`git reflog delete HEAD@{0}`、`git reflog exists HEAD` 都进入审批。
- 行为边界:`git reflog show --all` 保持 `read`;普通未列入安全 flag 的 git 读命令仍按现有 `file` 风险处理,这一步只收紧 CC 标注为危险的 read-only allowlist callback。
- 测试覆盖:`runCommandTool.test.ts` 新增 classify 与 `auto_files` 权限瀑布断言。

## 3.395 2026-07-09 CC git diff pickaxe required-arg regression guard

- 对照源:`~/Desktop/cc-haha-ref/src/utils/shell/readOnlyCommandValidation.ts` 的 `git diff` 注释:CC 明确把 `-S/-G/-O` 设为 required string,防止 validator 与 git getopt 对 `--` 的消费不同步。
- TS 实现此前已把 `git diff` 的 `-S/-G/-O` 标成 `string`;本轮新增回归测试钉住攻击形态:`git diff -S -- --output=/tmp/pwned`、`git diff -G -- --output=/tmp/pwned`、`git diff -O -- --output=/tmp/pwned` 都必须降为 `file`,不能被误判为 `read`。
- 行为边界:正常 `git diff -S needle -- package.json` 保持 `read`;这一步是防未来回退,不是扩大普通 diff 查询审批面。

## 3.396 2026-07-09 CC output redirection expansion guard

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/pathValidation.ts` 的 output redirection 检查:CC 对重定向目标中的 shell expansion syntax 要求审批,因为 `$VAR`/`%VAR%`/glob 等目标无法稳定验证最终落点。
- TS 已有 `shellOutputRedirectionNeedsApproval()` 与 `redirectionTargetNeedsApproval()` 主逻辑,本轮补回归测试锁住文字目标与展开目标的差异:`note.txt`、`"space name.txt"` 保持不审批;`"$HOME/out.txt"`、`'$HOME/out.txt'`、`${HOME}/out.txt`、`%TEMP%/out.txt`、`out*.txt` 都必须进入审批。
- 这与 process substitution 门一起覆盖 CC Bash path validation 的两条关键旁路:写入目标不可解析时要问用户,不能让模型在 `acceptEdits/auto_files` 下静默写到工作区外或特殊路径。
- Python 退役节奏同步写入 `docs/当前目标与文档口径-2026-07-07.md`:旧 Python 不是先删后补,而是按 dataeye receiver/board 的模式逐块接管、切入口、补测试、再删并提交;仍在真实链路里的 FastAPI 主后端、媒体重链路、OCR/语音/RAG/打包入口放到接管后或最后退。

## 3.397 2026-07-09 CC grep/rg newline pattern guard

- 对照源:`~/Desktop/cc-haha-ref/src/tools/BashTool/readOnlyValidation.ts` 的 grep/rg guard:CC 明确阻断 `grep`/`rg` 命令中的真实 `\n`/`\r`,避免 pattern、分段和 shell-quote 行式处理出现差异。
- TS 只读 allowlist 原先会把 `grep "foo\nbar" file.txt`、`rg "foo\nbar" src` 当成 `read`;本轮在 `classifyReadOnlyAllowlistedCommand()` 里对 `grep`/`rg` 原始 segment 含换行/回车的形态直接升为 `outreach`。
- 行为边界:字面反斜杠 pattern `grep "foo\\nbar" file.txt` 仍保持 `read`;只有真实换行/回车进入审批,不扩大到 safe heredoc 或普通多行文本参数的其它工具。
- 测试覆盖:`runCommandTool.test.ts` 新增 `grep`/`rg` 真实换行、真实回车和 `-e` pattern 的 classify 回归。

## 3.398 2026-07-09 网关 FastAPI Python 退役

- 删除 `gateway/app.py`:国内总闸不再维护 FastAPI/uvicorn 版本,避免同一网关同时存在 Python 与 TS 两条部署口径。
- 新增 `gateway/app.ts`:用 Bun/TS 保留路径契约与安全边界,包括 `/healthz`、`/admin/usage`、MiMo `/v1/chat/completions` 流式透传、GPT `/v1/images/generations|edits`、ARK 视觉/文本、Seedream 原生生图、AMAP 通用代理、app token 鉴权、每日配额、令牌桶排队、并发信号量和 SQLite 用量记录。
- 新增 `gateway/app.test.ts`:测试注入 `MemoryUsageStore` 与假上游 fetch,覆盖缺/错令牌不打上游、对话流式消费后记账、图片每日配额、multipart content-type 保留、ARK chat/Seedream 分配额记账、AMAP key 注入、缺可选 key 返回 503、admin usage。
- 部署同步:`gateway/deploy.sh` 从 Python venv + `uvicorn app:app` 改为 Bun + systemd 直跑 `/opt/qfgw/app.ts`;`gateway/README.md`、密钥部署清单、活台账和代码注释改为 `gateway/app.ts`。Python 文件数降到 365。
- 验证:`bun test gateway/app.test.ts` 9 项通过;`cd ts && bun run typecheck` 通过。

## 3.399 2026-07-09 CC 权限五档 + 结构化规则瀑布迁移

本轮先按 cc 当前源码建立差异矩阵,再迁移确定性内核块。目标不是“审批只卡高风险动作”的口号,而是让 TS 权限上下文能承载 cc 的 mode/rule/update 语义。

| 源能力 | cc 源位置 | 本项目迁移前 | 本轮落点 | 状态 | 测试/验收 | 未完成原因 | 后续路径 |
|---|---|---|---|---|---|---|---|
| 外部权限模式 | `~/Desktop/cc-haha-ref/src/types/permissions.ts`, `src/utils/permissions/PermissionMode.ts` | `CanonicalPermissionMode` 只有 `default/acceptEdits/plan/bypassPermissions`;旧 `ask/auto_files/full` 兼容 | `ts/src/permissions/types.ts`, `canonical.ts`, Web `PermissionMode` 增加 `dontAsk`;旧三档继续兼容 | ✅已落 | `types.test.ts`, `resolve.test.ts`;`cd ts && bun run typecheck`;`cd web && pnpm exec tsc --noEmit` | cc 内部 gated `auto/bubble` 未启用 | 后续单独评估 auto classifier/bubble 是否需要产品化 |
| `dontAsk` 行为 | `src/utils/permissions/permissions.ts` 的 ask -> deny transformation | 未实现;未知值会回落 default | `resolvePermission()` 在 `dontAsk` 下把所有 ask 转 deny;无审批需求的只读/普通工具仍 allow | ✅已落 | `resolve.test.ts` 覆盖需确认动作直接 deny | UI 只展示模式,还没有规则管理说明卡 | 后续审批卡/权限面板补更细文案 |
| PermissionRule source/behavior | `src/types/permissions.ts`, `src/utils/permissions/permissions.ts` | 只有 `sessionAllowedTools/sessionAllowedToolRules`,缺 `source` 和 allow/deny/ask 三类统一规则 | 新增 `PermissionRuleSource/PermissionRule/PermissionBehavior`;`ToolContext.permissionRules`;deny 优先、ask 普通模式强制提示、allow 放行 | ✅已落 | `resolve.test.ts` 覆盖 deny/ask/allow 优先级与 Bash 别名内容规则 | settings 持久化/UI 列表未接 | 迁移 `permissionsLoader.ts`、规则删除/展示、managed policy |
| PermissionUpdate | `src/utils/permissions/PermissionUpdate.ts`, `PermissionUpdateSchema.ts` | 无结构化 add/replace/remove/setMode/addDirectories 入口 | 新增 `ts/src/permissions/permissionUpdate.ts`,支持内存态 add/replace/remove rules、setMode、add/remove directories | ✅地基已落 | `permissionUpdate.test.ts` | 只做内存态,未写 settings 文件 | 后续接设置源、审批卡“本会话允许/总是允许/总是询问/拒绝” |
| 规则字符串往返 | `src/utils/permissions/permissionRuleParser.ts`, `shellRuleMatching.ts` | 有 parse,缺 `permissionRuleValueToString` | 新增 escape/toString round-trip;保留 `Bash(git:*)`、通配、括号转义 | ✅已落 | `permissionRules.test.ts` | legacy tool alias 表仍是小集合 | 后续补 `AgentOutputTool/BashOutputTool` 等全部旧名兼容 |
| default vs acceptEdits 文件类语义 | `src/utils/permissions/permissions.ts`, `src/tools/BashTool/modeValidation.ts` | 旧 TS 在 default 也直接 allow `approvalClass:"file"` | default 未命中 allow 规则时 ask;`acceptEdits/auto_files` 才放行 file 类;`bypassPermissions` 仍跳过普通 ask | ✅已落 | `resolve.test.ts`, `runCommandTool.test.ts` | 文件工具 path-scoped allow/deny 仍未全量复刻 | 迁移 `pathValidation.ts`、文件工具读前置/目录授权/UI diff 规则源 |
| Bash rule alias + wrapper 后真实命令 | `src/tools/BashTool/bashPermissions.ts`, `src/utils/permissions/shellRuleMatching.ts` | `sessionAllowedToolRules` 已支持 wrapper/env fixed-point;结构化规则不支持 `Bash` 别名 | `permissionRules` 支持 `Bash(...)` 匹配 `run_command`;继续复用现有 shell matcher | ✅已落 | `resolve.test.ts`, `permissionRules.test.ts` | 尚未全量 tree-sitter AST permission checker | 后续继续迁移完整 Bash parser/security analyzer |
| `cd` + 只读命令分类 | `src/tools/BashTool/pathValidation.ts` 的 `compoundCommandHasCd && operationType !== read` | default file 放行掩盖了 `cd sub` 被分类成 file 的问题 | `cd/pushd/popd` 自身归 read;`cd + 写动作` 仍由 `shellCdWriteNeedsApproval()` 升级审批 | ✅已落 | `runCommandTool.test.ts` | 仍未接 cc AST 级路径约束 | 后续 tree-sitter 分析器接入后复核 |

- 代码变更:`ts/src/permissions/types.ts`, `canonical.ts`, `permissionRules.ts`, `permissionUpdate.ts`, `resolve.ts`, `ts/src/tools/Tool.ts`, `ts/src/tools/dangerousCommand.ts`, `web/src/hooks/use-agent-chat.ts`, `web/src/lib/agent-copy.ts`, `web/src/lib/api.ts`, `web/src/components/desktop/desktop-composer.tsx`。
- 行为边界:`default` 档 `echo hi > note.txt` 现在 ask;`acceptEdits/auto_files` 仍 allow;`dontAsk` 对 `curl`/写文件/ask rule 直接 deny;deny rule 即使在 `bypassPermissions` 也 deny;ask rule 在 `bypassPermissions` 下被普通旁路跳过,与 cc 当前源码一致。
- 验证:`cd ts && bun test src/permissions/types.test.ts src/permissions/permissionRules.test.ts src/permissions/permissionUpdate.test.ts src/permissions/resolve.test.ts src/tools/runCommandTool.test.ts src/tools/powerShellTool.test.ts --timeout 120000` = 76 pass;`cd ts && bun run typecheck` 通过;`cd web && pnpm exec tsc --noEmit` 通过。
- 未跑:UI E2E/真机手动验收未跑;本轮是权限内核和菜单类型/文案变更,后续前端审批卡/权限面板改动时补浏览器验收。

## 3.400 2026-07-09 CC AdditionalWorkingDirectory + 文件写改默认审批收口

本轮继续按 cc 当前源码对齐权限/审批,重点补上 3.399 地基之后仍缺的“额外工作目录”运行语义和文件工具默认审批。用户纠偏后,媒体侧只保留已删除 CD/Seedance 2.0 生成视频链路的口径,不再围绕生成视频开新实现。

| 源能力 | cc 源位置 | 本项目迁移前 | 本轮落点 | 状态 | 测试/验收 | 未完成原因 | 后续路径 |
|---|---|---|---|---|---|---|---|
| AdditionalWorkingDirectory 参与工作区判定 | `~/Desktop/cc-haha-ref/src/utils/permissions/filesystem.ts:682-722`, `pathValidation.ts:178` | `PermissionUpdate.addDirectories` 只进入上下文,文件/命令路径仍主要按 `Workspace.root` 判定 | `ts/src/permissions/filePathRules.ts` 新增 `resolvePathWithAdditionalWorkingDirectories()`;文件工具和 `run_command.cwd` 都能使用 session additional dirs | ✅已落 | `fileTools.test.ts`, `runCommandTool.test.ts` 覆盖 add/remove 后读文件与 cwd 执行 | 只接内存态 context,未接 settings/UI 持久化 | 后续把审批卡“允许此目录”与设置页目录列表接入同一 update |
| symlink/realpath 双路径检查 | `~/Desktop/cc-haha-ref/src/utils/fsOperations.ts:getPathsForPermissionCheck`, `filesystem.ts:pathInAllowedWorkingPath` | 字面路径包含即可放行,授权目录内 symlink 指向外部时可能误放行 | 迁入简化版 `getPathsForPermissionCheck`:检查原路径、symlink 链、最深存在祖先和 final realpath;目标所有路径都必须落在某个授权工作目录路径内 | ✅已落 | 新增 “AdditionalWorkingDirectory checks symlink-resolved paths” 回归 | 仍未把该 helper 抽成全仓 shared path validator,`Workspace.allowedPaths` 旧机制尚未同步 | 后续统一 `Workspace.resolve/allowedPaths/sessionPathRuleAllows` 的 realpath 策略 |
| 文件写改工具默认审批 | `~/Desktop/cc-haha-ref/src/utils/permissions/permissions.ts`, `pathValidation.ts:isPathAllowed` | `write_file/edit_file/patch/notebook/edit_excel` 工具本身未声明 `file` 审批类,依赖外层或直接执行 | `write_file/edit_file/multi_edit_file/patch_file/patch_files/NotebookEdit/edit_excel` 统一 `requiresApproval + approvalClass:"file"`;default ask,acceptEdits allow | ✅已落 | `fileTools.test.ts` 覆盖全部写改工具 default/acceptEdits 决策 | 前端审批卡还未展示“本会话允许此目录/总是允许”细分按钮 | 后续接 cc permission suggestion/update UI |
| 活文档权限/视频口径修正 | 阶段目标 §3.2, cc 权限五档源码 | `CLAUDE.md` 仍写“只有高风险动作审批”“文件直接做”和生图台 `i2v` | `CLAUDE.md` 改为 cc 五档/file 类审批;现状改为真实素材剪辑,删除视频生成模型 key/i2v 口径 | ✅已落 | 残留扫描只剩阶段目标、迁移矩阵、删除说明与历史归档 | 历史归档仍保留旧计划原文 | 历史文档只可回查,不再作为施工口径 |

- 代码变更:`ts/src/permissions/filePathRules.ts`, `ts/src/tools/runCommandTool.ts`, `ts/src/tools/fileWriteTool.ts`, `ts/src/tools/fileEditTool.ts`, `ts/src/tools/notebookEditTool.ts`, `ts/src/tools/spreadsheetTool.ts`, `ts/src/tools/fileTools.test.ts`, `ts/src/tools/runCommandTool.test.ts`, `CLAUDE.md`。
- 行为边界:额外目录授予后,`read_file/write_file/edit_file` 可访问该目录;撤销后恢复越界拒绝。`run_command.cwd` 可设为已授予目录,未授予时 preview 显示 cwd 无效并回到工作区。授权目录内 symlink 指向外部时仍拒绝,授权目录本身是 symlink 时可按真实目录访问。
- 残留扫描:`rg -n "BUNDLED_VIDEO_LABEL|VIDEO_BASE_URL|VIDEO_MODEL_NAME|Seedance|seedance|generate_video|studioI2v|/studio/i2v|i2v|t2v|图生视频|文生视频|让这张图动起来|用这张图生成视频|doubao-seedance|contents/generations/tasks|GW_Q_VIDEO|GW_VIDEO" desktop gateway server web ts/src CLAUDE.md docs/当前目标与文档口径-2026-07-07.md docs/plans ...` 只剩阶段目标、迁移矩阵、删除说明和历史归档;本地 ignored `desktop/bundled.env` 已移除 Seedance/`VIDEO_*` 配置,仅保留真实素材剪辑 VLM/导演网关。
- 验证:`cd ts && bun test src/tools/fileTools.test.ts src/tools/runCommandTool.test.ts src/permissions/permissionUpdate.test.ts src/permissions/resolve.test.ts --timeout 120000` = 137 pass;`cd ts && bun run typecheck` 通过。
- 未跑:`cd web && pnpm exec tsc --noEmit` 未跑,本轮未改 Web 源码;Python/server/gateway 测试未跑,本轮不触碰这些运行链路;真机/UI E2E 未跑,需要等权限审批卡/设置页继续接线后再补。

## 3.401 2026-07-09 全 16 模块 cc 差异复核 + 内核安全对齐(本轮)

> 方法:16 个子代理逐模块以 cc-haha-ref **当前源码**为规格源、本项目 **当前源码**为现状做差异审计,**不采信**旧迁移矩阵/`ts/docs/W4a-*.md` 记录的"已完成/Delta",分类 aligned/gap/deviation/out-of-scope。审计发现均由主窗口按 cc 源码亲验后再动手(纠正过审计的口误,例如 acceptEdits 危险文件清单里 cc 实际**不含** `.env`/`.ssh`,只含 `.git/.vscode/.idea/.claude` 目录与 shell/git/mcp/claude 配置文件)。

### A. 全 16 模块对齐结论

| 模块 | 对齐度 | 最高优先级 gap/deviation(未做的) | 需 owner 决策 |
|---|---|---|---|
| 权限模型 PermissionMode/Behavior/Result | 高(核心瀑布对齐+测试) | ✅本轮补:acceptEdits 敏感路径闸 | plan 硬拒绝 vs cc 软拦截可人工覆盖(倾向 keep-delta) |
| 权限规则 PermissionRule/Update/作用域 | 中 | 规则持久化落盘(userSettings/projectSettings/localSettings 只有类型、重启即丢) | 是否要 settings.json 式持久化 + 权限管理 UI |
| 命令分类器/审批/denial | 高 | permissionExplainer(审批卡风险解释)、destructiveCommandWarning(12 条提示) | — |
| Bash/PowerShell 路径与安全校验 | 中(危险模式对齐,读路径边界缺) | 读命令(cat/ls/grep/…)路径工作目录边界校验;PowerShell 未接 OS 沙箱;UNC 拦截 | — |
| 文件工具 read/write/edit/patch | 中高(写侧对齐/超出,读侧弱) | 图片/PDF/notebook 视觉 content-block 通道(架构级);整文件读无大小上限;UTF-16/BOM;危险设备路径 | — |
| 工作区/沙箱/路径护栏 | 中(app 层护栏扎实,OS 沙箱未接线) | **OS 沙箱从未在生产入口启用**(ctx.sandbox 恒 undefined);工作区主边界不解析 symlink(内部 symlink 可逃逸) | 沙箱是否默认开 + 网络白名单策略 |
| 工具执行循环/schema/流式 | 中高 | 工具入参 schema 校验闸(cc zod safeParse);token 级流式+边流边执行;max_turns 可辨识事件;并行只读并发上限 | 流式是否本轮做(前端体验对标核心) |
| 上下文压缩/恢复/落盘 | 中高 | 摘要请求自身超限的收缩重试(否则溢出会硬崩);autocompact 只信字符估算不看真实 token usage | — |
| Hooks 事件系统 | 中(骨架+SSRF+续跑对齐) | PreToolUse hook 的 allow/ask 决策 + deny>ask>allow 聚合;matcher 管道/正则语法;多 hook 并发 | — |
| Skills/Commands | 中 | $ARGUMENTS/$1 占位符替换;正文内嵌 `!`shell``;bundled skills 注册;paths 条件化;command hooks/命名空间 | — |
| 子代理/任务/后台任务 | 高(持久化+匹配超集) | ✅本轮补:权限继承(父级放权优先/后台兜底 acceptEdits);fork 类型后台代理 resume 抛错 | TaskStop forceConfirm 是否 keep-delta |
| MCP/Plugins | 中 | ✅本轮补:readOnlyHint 免审批后门;仍缺 http headers/OAuth 鉴权、.mcp.json 信任闸(RCE 面)、plugin 运行时接入(现为空壳) | — |
| Provider/runtime/proxy | 高(转换/failover 对齐/超出) | 瞬时错误重试退避(429/5xx,现一次失败即切/判败);流空闲超时(默认 60s 与 aiRequestTimeoutMs 脱钩;Anthropic 流无超时) | — |
| Trace/logging+错误恢复+stuck | 中高(工具/denial/stuck 扎实) | 模型调用重试退避;SSE 中途 error 帧识别(现静默吞成截断空响应);harness debug 日志落盘 | — |
| Session/transcript/重放 | 中高 | transcript 逐条落盘 vs 整 turn 收尾(中断丢整轮工具历史);主会话 resume 未接清洗/中断检测 | — |
| 前端低噪工具流 | 中高(骨架对齐) | ⚠️审计对象是**当前 web/+Python 旧栈**:工具失败态无红色区分、"本会话允许"死代码、审批卡编辑参数后签名必失败、命令输出未默认折叠 | **目标壳取舍:web/+Python vs ts/+ts-desktop** |

out-of-scope(cc 有、本项目桌面/免登录/全本地定位不迁移):auto/bubble 权限模式与分类器信任退化、bypassPermissions 远程 GrowthBook 熔断、getNextPermissionMode 键盘循环、IDE push 式诊断、内部 ant 遥测、SSH/swarm/PR 订阅/teleport/remote managed settings、OpenAI Responses API(当前内置/BYOK 均 chat completions)。

### B. 本轮已迁移(按提交)

| 提交 | 能力块 | 测试 |
|---|---|---|
| `9ff2c67` | cc 会话权限记忆(PermissionUpdate)+ plan 批准切 acceptEdits + 修 4 个陈旧权限测试 | loop/server/fileTools/permissions 全绿 |
| `54180dc` | i2v 删除后刷新耦合地图(修 coupling map 基线失败) | buildCouplingMap 4/4 |
| `ecc8009` | 修 SendMessage 恢复后台代理丢 resume 上下文(5cb5c4c 回归) | teamTools 23/23、taskTools |
| `9c40369` | acceptEdits 自动放行前过 cc checkPathSafetyForAutoEdit 敏感路径闸 | autoEditSafety 11 例 |
| `a564ac1` | 关闭 MCP readOnlyHint 免审批后门(对齐 cc MCPTool 恒 passthrough→ask) | mcp/config 更正断言 |
| `d5fe598` | 子代理权限继承对齐 cc(父级放权优先/后台兜底 acceptEdits)+ 危险前缀(sudo/bash -c)不生成会话放行规则 | agentTool/taskTools + approvalSuggestions 新测试 |
| `e14b464` | 模型调用瞬时错误(429/5xx/网络抖动)退避重试基础设施(opt-in,移植 cc withRetry) | fetchRetry 9 例 + ProxyModel 集成 2 例 |

全量:`cd ts && bun test` = 874 pass / 0 fail;`bun run typecheck` 通过;`smoke:sandbox`/`smoke:sqlite` 通过;`build:sidecar` exit 0;`cd web && npx tsc --noEmit` 通过。

### C. 剩余高优先级 backlog(按 coding-agent 内核价值排序)

**P0(安全/稳定)** —— 2026-07-09 更新:1/2/3 已落,4 待专轮
1. ✅OS 沙箱接线进生产入口默认开(`07f4bd4`):server 构造 `new Sandbox({enabled:true})` 注入 `ctx.sandbox`,优雅降级(缺依赖/异常退明文),QF_OS_SANDBOX=0 可关。smoke 证明写围栏真生效。
2. ✅工作区主边界 symlink 解析(`783d2e4`):`workspace.resolve` 复用下沉的 `symlinkResolve.pathContainedInRoots`,堵区内 symlink 指向区外逃逸。
3. ✅`.mcp.json` 工作区级信任闸(`f909d7c`):未信任的 `<root>/.mcp.json` 默认不连(防 RCE),显式/已信任/app 级配置放行,GET/POST/DELETE /agent/mcp/trust 批准。剩:远程 http headers/OAuth 鉴权。
4. ⛔读命令(cat/ls/grep/find/...)路径工作区边界校验 + UNC 拦截:`dangerousCommand.ts` 已有路径提取但只按敏感文件名判、不按工作区边界判;近 4000 行、需逐段对齐,留专轮(移植 cc `checkPathConstraints`/`PATH_EXTRACTORS`)。

**P1(可靠性/正确性)**
5. 模型调用重试退避:✅重试基础设施已落地(`ts/src/model/fetchRetry.ts`,opt-in,默认不改 failover 时序);**待续**:是否默认开启(需 owner 定 failover-vs-retry 延迟取舍)、SSE 中途 error 帧识别(现静默吞成截断空响应)、流空闲超时跟随 `aiRequestTimeoutMs`(现 60s 与之脱钩)。
6. 上下文压缩:摘要请求自身超限的收缩重试(防硬崩)+ autocompact 用"字符估算 vs 真实 token usage 取大"。
7. 工具入参 schema 校验闸(权限判定前统一 `<tool_use_error>InputValidationError`)。
8. 规则持久化落盘(cc `permissionsLoader`/`persistPermissionUpdate`;让"本会话允许"可选升级为跨重启持久化)。
9. fork 类型后台代理 resume 修复(`resumeBackgroundAgentTask` 重建 fork 合成 AgentDefinition)。
10. transcript 逐轮落盘 + 主会话 resume 接 `sanitizeBackgroundAgentResumeMessages` 清洗与中断检测。

**P2(能力面/体验)**
11. Hooks:PreToolUse allow/ask 决策 + matcher 管道/正则语法 + 多 hook 并发。
12. Skills/Commands:$ARGUMENTS 占位符替换、正文内嵌 shell、bundled skills、命令 hooks/命名空间。
13. 文件读:整文件字节上限 + 危险设备路径 + UTF-16/BOM;图片/PDF 视觉 content-block(架构级,晚做代价高)。
14. token 级流式 + 边流边执行工具(前端打字机体验,对标 Claude Code 核心)。
15. Plugin 运行时接入(启用插件的 skills/.mcp.json/hooks 合并进会话,现为空壳)。
16. permissionExplainer + destructiveCommandWarning 审批卡增强。

**owner 拍板结论(2026-07-09)**
- ✅**前端目标壳 = `ts/` + ts-desktop**:前端 §9 低噪工具流的 HIGH 项(失败态红色、本会话允许真功能、审批卡编辑参数签名、命令输出默认折叠、拒绝反馈)一律在 **TS/ts-desktop 侧新建并对齐已迁移的 TS 内核**;`web/`+Python 旧栈只做维持、按节奏退役,不在旧栈上补这些 HIGH(否则和 TS 内核漂移)。
- ✅**OS 沙箱 = 接线 + 默认开**:生产入口(server/desktop 主进程)构造 `new Sandbox({enabled:true})` 注入 `ctx.sandbox` 并**默认启用**;必须同时补依赖探测(`checkDependencies`,Linux 缺 bwrap/socat 时)+ `wrapCommand` try/catch 优雅降级到明文执行(避免默认开在缺依赖环境崩),并给网络白名单最简策略(别让"沙箱=网络全放行")。真机 seatbelt/bwrap 验证列入打包 smoke。
- ✅**下一步方向 = P0 安全一组**:工作区主边界 symlink 解析 + 读命令路径工作区边界 + `.mcp.json` 信任闸。
- 仍待拍板:plan 模式硬拒绝 vs 可人工覆盖;规则是否落盘持久化 + 权限管理 UI;模型重试是否默认开(failover-vs-retry 延迟取舍)。

### D. 本轮验证与未跑
- 已跑:`bun test`(863 pass/0 fail)、`bun run typecheck`、`smoke:sandbox/sqlite`、`build:sidecar`、`web tsc`。
- 未跑:Python/server/gateway 测试(本轮不触碰旧栈运行链路);真机打包 E2E、真实模型/生图/剪辑 smoke(需 key/真机);前端浏览器 UI 验证(本轮未改 web 源码,仅 chat-thread 一处 tooltip 文案随 9ff2c67)。

## 3.402 2026-07-09 桌面 App 架构对标(owner:架构层面对齐 cc-haha)

> owner 口径:本项目本质是 cc-haha 型桌面 coding agent,前端 UI 长相可自定,但**架构层面(连接/存储/桌面壳/打包/配置/项目会话)对标 cc-haha**。子代理逐维度对照结论:

**✅ 已对齐**
- **存储**(`b087332`):文件式 JSONL transcript(`transcripts/<id>.jsonl`)+ JSON 元信息(`sessions.json`/`tasks.json`/`*.meta.json`),**无 SQL 数据库**——与 cc-haha(`<sessionId>.jsonl` + `.meta.json`)同构。老 SQLite 是 Python 台球域数据,已随 server/ 删。
- **连接架构**(`c98af29`/`931cf61`):WS 双向(`/agent/ws`)+ 事件流 + seq+after 全量重放(比 cc 仅补挂起权限请求**更优**,保留)+ 中断 + **插话/审批走同一条 WS**(steer/approve/reject/ping)+ **审批闭环写回 transcript**(修复"审批后模型看不见工具结果"的协议真断裂)。cc 双跳(浏览器↔server↔spawn CLI 子进程)的 control_request/SDKMessage IPC 精细分型属其架构选择,本项目单跳不照抄字面协议,客户端可见契约已对齐。
- **Provider 配置 CRUD**:`providerService.ts` 与 cc 字段/CRUD/reorder/delete-guard-active/两段式测试高度对齐(本维度最扎实)。
- **sidecar 原语**:`ts/desktop/electron/services/sidecarManager.ts` 端口预留/TCP 等待/spawn/kill 逐段抄 cc。

**❌ 未对齐(分两类)**

后端侧(先做):
1. **项目/会话组织**:cc 多项目 App——按 `sanitizePath(cwd)` 分桶存目录、`listSessionsImpl` 跨项目/worktree 感知、`recent-projects` 聚合选择器、会话 fork;本项目单节点(一份扁平 `sessions.json` + `workspaceRoot` 字段标归属),无"项目"组织层、无最近项目、无会话分支。
2. **配置基座**:cc 有分层用户设置文件 + `/api/settings` REST + 网络设置持久化 + provider 预设库;本项目只有 provider 一柱,其余设置基座缺。

前端/桌面壳(后端做完再补):
3. **桌面壳 Electron 层**:ts-desktop 仅 sidecarManager,`main.ts`/`preload`/窗口管理/集中 IPC 白名单 + payload 校验/原生能力(托盘/菜单/窗口状态持久化/外链协议白名单 + 可执行文件拦截/导航守卫)全空——照 cc 服务拆分骨架从零建,同时迁入老壳产品特有能力(文件沙箱选择器/截图问 AI/TTS/全局热键/多工作台/开机自启,cc 无);排除 cc 编码 agent 专属(PTY 终端/WebContentsView 预览/trace 窗/portable 模式)。
4. **sidecar 生命周期上层**:cc `serverRuntime.ts`(ElectronServerRuntime)+ `main.ts` app 生命周期挂钩,本项目缺(无 electron/main.ts)。
5. **打包/分发/自动更新**:electron-builder 配置(mac dmg/win nsis 签名)+ 跨平台 CI 出包矩阵 + electron-updater 状态机全空(sidecar 单文件编译脚本已对齐)。

## 4. 下一批代码顺序

1. **CC-Haha AgentTool/LocalAgentTask 继续补齐**:稳定 `agent_id`、sidechain transcript、stored-result 回读、worktree isolation、frontmatter 行为字段、agent-specific MCP、frontmatter hooks、SubagentStart/SubagentStop 主链、command/http/prompt/agent hook executor、HTTP hook allowlist/env policy/SSRF、Stop hook blocking continuation、`/goal` 命令/持久化恢复、后台 agent 确定性进度阶段、`SendUserMessage/Brief` 输出通道、agent memory / snapshot、后台续跑 content replacement records 继承、同 agent id 原任务槽续跑、`AgentOutputTool/BashOutputTool` 旧名兼容、parent live replacements gap-fill、AgentSummary 周期摘要、ListPeers 队友发现元数据、UDS SendMessage 出站投递、UDS inbox 接收注入、UDS peer discovery/ListPeers socket 展示、Remote Control bridge peer registry/SendMessage 安全骨架、Remote Control event/permission outbox 状态面、Remote Control Sessions API HTTP transport、SessionsWebSocket 订阅接收半边、code session / bridge credential exchange、CCR worker HTTP/heartbeat/state/delivery、SSE worker read stream、worker credential refresh/epoch rebuild 控制面、inbound user message/file attachment resolved prompt 队列、inbound prompt -> agent queue/steering、OAuth/JWT 自动 refresh scheduler、SDK message -> 前端实时事件流投影、bridge-safe slash command 白名单、prompt-cache break telemetry、AgentTool `run_in_background` 显式后台入口、subagent local denial tracking、fork child message builder、fork recursive guard 运行时接入、显式 fork_context AgentTool 运行时、受控 implicit fork gate、fork querySource 身份标记、AgentSummary cache-safe params 生命周期、rendered system prompt byte-exact 继承、foreground handoff registry 地基、AgentTool foreground registration lifecycle、foreground-to-background race 接管入口、foreground handoff continuation snapshot、foreground handoff progress seed、foreground handoff AgentSummary snapshot、foreground handoff token usage tracker、foreground handoff worktree ownership、foreground handoff MCP/session cleanup、fork worker worktree notice、fork force-async gate 与 prompt 指南、`/fork <directive>` 后台 worker 入口、`context:fork` prompt command executor、SkillTool 主动调用 `context:fork`、SkillTool allowedTools 归一化/worker 白名单、invoked skill 压缩恢复、allowedTools 会话级权限上下文、`Bash(...)` 参数级 allowedTools、skill frontmatter hooks 注册/恢复/`once`、permission rule parser 与 Bash/PowerShell wildcard shell allowedTools、context fork worker allowedTools session permissions、Bash allowedTools wrapper/env/compound matching、文件工具 path-scoped allowedTools 边界、Bash 子命令上限/退出码语义、Bash substitution 风险分类、Bash 输出重定向路径护栏、Bash `find` 只读守卫、Bash parser-hardening 风险门、Bash jq/flag/malformed syntax guard、Bash readOnlyValidation 常用命令 allowlist、Bash `cd`+`git` bare repo 安全门、Bash git-internal 写入安全门、Bash bare repo cwd git 安全门、Bash sandbox original cwd git 安全门、Bash incomplete command fragment 安全门、Bash comment quote desync 安全门、Bash input redirection 安全门已落;下一步继续复制/移植/改写完整 Bash tree-sitter 安全分析器、文件权限持久化/deny/ask/UI/sandbox 合并、插件 trust gate 细粒度开关和 command/skill worker drill-in,并做前端远端来源/中间 diff/右侧预览的细颗粒 polish。
2. **后台子代理事件流/UI drill-in polish**:同步 `agent_task` 轨迹、后台启动 chip、完成通知与点击跳转、事件过滤/摘要折叠、trace 搜索/失败节点/phase 分组已落;下一步做统一 trace 面板、按 `agent_id` 过滤/跳转、sidechain transcript drill-in。
3. **provider failover 策略 polish**:active saved -> saved fallbacks -> env fallback、失败原因 `context_note`、sticky fallback、状态线备用出口/冷却 chip、设置抽屉简洁健康状态/折叠明细、旧 BYOK -> ProviderService 兼容桥、provider 健康冷却、跨重启持久化、手动清冷却、保存通道启停/排序、默认/接管中状态区分、prewarm 跟随冷却排序、冷却分类退避、最近排障历史已落;下一步只剩完整高级 provider 管理页与更深的趋势/导出排障。
4. **领域包/知识库前端 polish**:`billiards` 已从硬编码 supportContext 收到 SessionStart pack,前端选择器已读 `/api/v1/agent/packs`,`list_skills` 已支持 pack 推荐/过滤,pack prompt commands 已合并进命令池;下一步把知识库 Q&A 做成更接近 Codex/Work Buddy 的低噪来源面板和专家挂载入口。
5. **目录级项目指令 / 长上下文 polish**:多层合并、读文件动态注入、`write_file` 首次暂停、前端 file pending 失败态、九段结构化压缩、压缩后最近文件上下文恢复、大工具结果落盘、写入/回滚后刷新最近文件快照、压缩恢复时带回子目录项目指令、显式 `list_project_instructions` scope 查询、前端 scope 卡片与状态线规则 chip 已落;下一步可补更细的规则 scope 过滤/跳转。
6. **媒体真迁移/旧 Python 分批退场**:旧 Python 从现在起按“TS/Node/native 等价链路已接住、调用点已切换、测试/smoke 已覆盖”逐块删除。优先删离线脚本和文档生成器,再删已有 TS 入口覆盖的服务边角,最后才动生图/语音/OCR/ffmpeg 这些真实运行链路。TS 文生图、参考图、改图、门店品牌包注入、Seedream/GPT 生图/改图自动路由、OpenAI 失败二跳 Seedream、Seedream 短限流重试、`print_mode` 原始二维码 ffmpeg 叠层、QR 源图质检/边缘保真叠层、QR 声明内容重建、PNG/JPEG QR 视觉解码重建、Logo 左上安全区 ffmpeg 叠层、硬文字待核对元数据、视频工作台本地方案/窄版 ffmpeg 出片、基础响度标准化已落,但 `poster_service` 的中文硬文字 OCR 真识别/自动重出、任意格式/模糊二维码增强识别,以及 `video_edit/*` 的 VLM 挑高光/ASR/音乐自动铺底/健康体检/模板离屏渲染仍需 TS/native sidecar 替代;不能把本地 fallback 当完整智能创作完成。
7. **店铺资料库语义升级**:TS 已有本地索引、`search_store_docs`、BM25/短语/文件名混合关键词排名、无依赖语义扩展、RRF 融合、前端来源卡片、店脑记忆相关性注入与老化提醒;若要更接近 Python bge 效果,下一步接本地 embedding 或网关 embedding,继续用 RRF/融合保留关键词精确命中,并保留 source_type 隔离。
8. **语音/Office 打包验证**:TS 已能处理 `/voice/transcribe` 与 `.docx/.pptx/.xlsx` 基础编辑;sidecar macOS arm64 / Windows x64 交叉构建已过;`smoke:native` 默认会把未安装的 `sharp/@huggingface/transformers/smart-whisper` 标 skipped,严格 native 验收需先安装依赖并设置 `NATIVE_SMOKE_REQUIRE_DEPS=1`;删 Python 前仍要确认 whisper runner/model/ffmpeg/OCR/font/native 资产在 macOS/Windows 安装包里可发现、可执行,并跑真实音频 smoke。
9. **MCP/AskUser 高级交互 polish**:结构化表单/URL 安全打开/preview、多选视觉、表单回答用户气泡脱 JSON 已落;后续只剩 URL 打开的桌面原生外链桥和更细的控件 polish。
10. **Windows/打包 smoke**:sidecar Windows x64 交叉构建已过;仍需 Windows runner/真机验证 Electron 安装包、离屏渲染、ffmpeg/whisper/OCR/font 资产和 ARM64 包完整链路。
