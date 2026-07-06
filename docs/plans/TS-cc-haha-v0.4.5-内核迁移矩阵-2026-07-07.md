# TS · cc-haha v0.4.5 内核迁移矩阵

> 📌 状态:✅现行 · 2026-07-07 新增 · 参考源 `~/Desktop/cc-haha-ref` = `NanmiCoder/cc-haha@a94e1a1` (`origin/main`, release notes `v0.4.5`)

## 0. 迁移口径

- 本分支 `ts-harness-rewrite` 专门做 Claude Code/cc-haha imitation kernel；质量达标后替换旧 Python 线。
- **内核行为全搬**：消息格式、provider/proxy、session/ws、权限、工具、压缩、skills/subagents/hooks/MCP、桌面 sidecar plumbing 逐块行为对齐。
- **外壳不搬**：cc-haha 的开发者 UI、onboarding、项目选择器、终端式体验不进产品；我们的 UI 面向小白老板/通用桌面用户。
- **发布口径**：不要把受限源码整文件原样并入发布树；用行为测试锁边界，在我们自己的模块结构里实现。
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
| Markdown style 注入防护 | desktop renderer | 前端 W16/W17 | ⛔待做 |
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
| Permissions | `utils/permissions/**`, command metadata | `ts/src/permissions/**`, `ts/src/tools/dangerousCommand.ts` | bypass/ask/deny/必须交互,命令风险元数据 | 🟡bypass/基础审批已落 |
| Bash/File tools | `tools/BashTool/**`, `FileReadTool/**`, `FileWriteTool/**` | `ts/src/tools/*` | Bash 解析、sandbox、Read pages 容错、编辑 diff/回滚 | ✅基础工具 + Bash 风险分类 + edit_file 读前置/陈旧检测/归一化匹配 + fileHistory 链式快照/diff/restore 已落 |
| Context resilience | `services/compact/**`, query compaction | `ts/src/context/*`, `ts/src/memory/*` | 分级压缩、结构化摘要、大结果落盘、熔断 | 🟡W4c 基础 + session archive/summary 已落 |
| Skills/commands | `server/api/skills.ts`, `commands.ts`, Skill tools | `ts/src/skills/*`, `ts/src/commands/*` | discover/load/execute/历史恢复;skillify 是产品护城河 | ✅SKILL.md loader + command loader + slash 自动展开/list/read/create_skill + `/model` 后端已落 |
| Subagents/tasks | `tools/AgentTool/**`, `tasks/**` | `ts/src/agents/*`, `ts/src/tasks/*` | 子代理、后台任务 drawer、任务输出隔离 | 🟡Agent .md loader/工具子集 + 基础 runner + 后台 task service/API/tool + 前端后台任务 drawer 已落 |
| Hooks | `utils/hooks/**`, hook config | `ts/src/hooks/*` | PreTool/PostTool/Stop/UserPromptSubmit/SessionStart | 🟡JSON 裁决 + PreTool/PostTool/SessionStart/UserPromptSubmit 已接主循环 |
| MCP/plugins | `server/api/mcp.ts`, `plugins.ts`, MCP tools | `ts/src/mcp/*`, `ts/src/plugins/*` | 官方 SDK + secret redaction + Unicode server names | 🟡配置/manifest/命名/审批映射 + SDK tool/resource/prompt/elicitation/task/sampling bridge 已落;MCP elicitation 基础问答桥已落,专用多字段表单 UI 待补 |
| Desktop sidecar | `desktop/electron/services/sidecarManager.ts`, `serverRuntime.ts` | `ts/desktop/electron/services/*` | 等 `/health`、端口策略、tree kill、日志诊断、ARM64 | 🟡基础 sidecar 已落 |
| Image module | 无直接 cc-haha 对应 | `ts/src/media/image/*`, 前端 studio | 自研工具,接审批/媒体任务/provider | ⛔待做 |
| Video module | 无直接 cc-haha 对应 | `ts/src/media/video/*`, workbench | 自研剪辑/生视频,ffmpeg/Seedance/离屏渲染 | ⛔待做 |

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
- `/model` 不复制 provider CRUD,仍复用 `ProviderService`,保证 active provider 首轮生效路径一致。
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
- 新增 `ts/src/media/mediaTools.ts`:注册 `make_poster`、`generate_image`、`generate_video`;图片走后台媒体任务,视频标记 `spend + forceConfirm`,接入同一审批/任务系统。
- TS server 新增旧前端兼容路由:`/api/v1/studio/generate|edit|i2v|expand`、`/api/v1/video-edit/inventory|auto_plan|auto_plan_v2|projects/:id/render|render_v2`、`/api/v1/agent/media-jobs/:id` 与 `/uploads/*` 本地预览产物。
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

- 新增 `server/commands/*.md` 内置命令包:`/help`、`/doctor`、`/model`、`/permissions`、`/context`、`/compact`、`/skills`、`/agents`、`/mcp`、`/plugins`、`/memory`、`/output-style`、`/cost`;全部走现有 command loader/`/agent/run` slash 展开,不复制受限来源代码。
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

- 本地分支已收敛:删除 `ts-harness-rewrite` 分支指针,后续只在 `cc-haha-direct-port` 承接 TS/coding-agent 内核迁移,完成后再整体 merge `main`;其它 image/video/batch 分支经审计均已在 `main`。
- 新增 `ts/src/tools/searchTools.ts`:`glob_files` 和 `grep_files` 进入默认工具池,补齐 coding-agent 找文件/搜代码的基础能力;默认跳过 `node_modules/.git/.next/dist/build/.agent-state` 等重目录,并跳过 `.env`/key/token/secret 类敏感文件。
- 新增 `ts/src/server/services/desktopDataStore.ts`:用本地 JSON 原子持久化承接店铺资料、BYOK 展示配置/配置档、店脑记忆、定时任务、店铺资料库状态、通知、dashboard 推荐等 Python 壳层数据。
- TS server 新增 Python 删除前的产品壳兜底端点:`/api/v1/auth/me`、`/api/v1/stores*`、`/api/v1/voice/transcribe`、`/api/v1/canvas/*`、`/api/v1/logs/client`、`/api/v1/store-memory*`、`/api/v1/scheduled-tasks*`、`/api/v1/store-docs*`、`/api/v1/dashboard/*`、`/api/v1/notifications`、`/api/v1/quota/cost`、`/api/v1/backup/export`。
- 壳层兜底目标是“不 404、不拖垮桌面主流程”:基础读写/JSON 状态已可用;Office 直接写回、语音转写、真实媒体渲染仍需后续真替代或保留 native sidecar,不能假装已完成。
- 验证:`cd ts && bun test` = 324 pass;`cd ts && bun run typecheck` clean;`cd web && pnpm build` 通过(仅既有 lint warnings)。

## 3.35 2026-07-07 AskUserQuestion/ExitPlanMode 行为级迁移追加落地

- 新增 `ts/src/tools/agentInteractionTools.ts`:提供 `ask_user_question`/`AskUserQuestion` 与 `exit_plan`/`ExitPlanMode` 工具规格,保留我们自己的 schema/事件协议,不复制受限来源实现。
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

## 4. 下一批代码顺序

1. **媒体真迁移/删 Python 前最后硬门槛**:真实 `poster_service`、`video_service`、`video_edit/*` 仍需 TS/native sidecar 替代;现在已有兼容/桥接层、本地占位 fallback 和 video-edit 同步文档层,但真实生图/生视频/剪辑渲染不能假装完成。
2. **语音/Office 打包验证**:TS 已能处理 `/voice/transcribe` 与 `.docx/.pptx/.xlsx` 基础编辑;删 Python 前仍要确认 whisper runner/model/ffmpeg 在 macOS/Windows 安装包里可发现、可执行,并跑真实音频 smoke。
3. **MCP/AskUser 高级交互 polish**:结构化表单/URL/preview 已落;后续只剩更细的多选视觉、表单回答在用户气泡里的脱 JSON 展示、以及 URL allow/open/cancel 的桌面原生外链桥。
4. **Windows/打包 smoke**:sidecar Windows x64 交叉构建已过;仍需 Windows runner/真机验证 Electron 安装包、离屏渲染、ffmpeg/whisper/font 资产和 ARM64 包完整链路。
