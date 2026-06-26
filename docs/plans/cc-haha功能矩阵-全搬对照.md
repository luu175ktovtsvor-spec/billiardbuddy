# cc-haha（Claude Code）功能矩阵 × 我们的状态（"全搬"权威对照表）

> 📌 状态:⚠️ 前提已超越(harness 审计 2026-06-26 后)。**"全搬 cc-haha"是当时 AI 改不对 + owner 不懂代码的应急**;现已升级为「对照官方文档校准、选择性搬」。本表作"还差什么"的进度参照仍有用,但**取舍/对齐以 `../references/harness缺口审计-对照ClaudeCode-2026-06-26.md` 为准**——它证明 cc-haha 是社区复刻、有自创/官方没有的东西(如技能 fork 子代理),**盲抄=过度工程**。表里标"❌未搬"的别无脑补,先看审计判它对这个单窗口老板产品有没有用。

> **目的**：把 Claude Code/cc-haha 的功能**全找出来**，逐项对照我们的状态，作为"全搬"的系统性进度表——一眼看清**还差什么**。配合 `通用Agent改造-0到6路线图.md`。
> **状态**：✅ 已搬（自有实现+测试）｜⚠️ 半成品/基础版｜❌ 未搬。
> **来源**：2026-06-21 五路并行调研（cc-haha 核心引擎 / 扩展系统 / 前端UI+文案 / ComputerUse测试 / 自有审计）+ 本会话持续实现。cc-haha 参考库（可直接抄用）：`~/Desktop/cc-haha-ref`。

## A · 前端 UI / 呈现（保配色，改文案与呈现）

| 功能 | cc-haha | 我们 | 备注 |
|---|---|---|---|
| 去客服腔的专业文案 | ✅ | ✅ | `agent-copy.ts` 集中文案；欢迎/placeholder 已换 |
| Spinner（动词库+计时+esc） | ✅ `✻`+200词 | ✅ | `agent-spinner.tsx`（中文动词库+计时+esc中断） |
| 权限模式 UI（三档） | ✅ 4档(含plan) | ⚠️ | 三档已照 CC（询问/自动接受编辑/完全访问）；**缺 plan 模式** |
| `/` 命令面板 | ✅ | ✅ | `slash-palette.tsx`（内置命令+技能，↑↓选） |
| 技能选择器 | ✅ | ✅ | `/` 面板 + **设置抽屉「扩展」面板**（列技能/插件/MCP） |
| 右侧预览（代码画布） | ✅ 文件/diff/产物 | ✅ | 海报/文案/**file·code 视图** + **diff 视图**（`diff-block.tsx` 行级+字符级高亮，AI 改本机文件给改前/改后确认）+ **HTML 渲染**（`html-edit-view.tsx`）均已做 |
| 工具调用呈现（⏺+进行/过去动词+⎿） | ✅ | ⚠️ | 已加 **⏺ 状态点**(灰运行/绿完成)+图标+标签+折叠结果；仍缺进行时/过去式动词、连续同类分组 |
| todo 列表（贴 spinner 下） | ✅ | ✅ | `todo_write` + 前端常驻清单卡（☐待办/◐进行中/☑完成） |
| thinking 折叠块 | ✅ | ✅ | 已做（`F.1`：显示模型"思考过程"，mimo `reasoning_content`，抄 cc-haha ThinkingBlock）+ `F.2` 深度思考开/关开关 |
| word-level diff | ✅ | ⚠️ | **文件/文档改写**已做字符级高亮（`diff-block.tsx` 的 `diffChars`）；**审批卡预览**仍是整段文本（`MacApprovalCard` 渲染 `ap.preview` 为纯文本，未接 DiffBlock）|
| 子 agent 彩色 chip + 可点开 transcript | ✅ | ❌ | |
| status line（底部状态栏） | ✅ | ⚠️ | 有顶栏"新会话/会话"；缺 git 分支/模型/用量状态行 |
| 上下文/成本指示器 | ✅ `N% until autocompact` | ⚠️ | 侧栏有本月花费；缺会话级上下文占用条 |
| 重试/降级横幅 | ✅ | ⚠️ | 后端有失败切档；前端缺"retrying 2/3 / 切非流式"提示条 |

## B · 工具集（cc-haha ~48 个）

| 域 | cc-haha 工具 | 我们 |
|---|---|---|
| 文件/代码 | FileRead/Write/Edit/**Glob/Grep** | ✅ read_file/write_file/edit_file/**edit_excel**/list_files/find_files/search_in_files |
| | NotebookEdit / LSP（语言诊断） | ❌ / ❌ |
| 执行 | Bash | ✅ run_command（黑名单+完全访问门控） |
| | PowerShell / REPL(VM) | ❌ / ❌ |
| Web | WebFetch / WebSearch | ✅ web_fetch / web_search |
| | WebBrowser(computer-use) | ❌（见 J） |
| 任务/计划 | TodoWrite | ✅ todo_write |
| | Task(Create/Get/Update/List) / EnterPlanMode/ExitPlanMode / VerifyPlanExecution | ❌ |
| 子agent/团队 | Agent | ⚠️ run_subagent（基础同步版） |
| | SendMessage/Team*/TaskStop/TaskOutput/ListPeers/Brief | ❌ |
| 技能/MCP | **Skill** / DiscoverSkills | ✅ skill / ⚠️(清单注入即等价) |
| | ToolSearch | ❌（工具不多，按需再做） |
| | ListMcpResources/ReadMcpResource/McpAuth | ❌ |
| 后台/定时/通知 | ScheduleCron(Create/Update/Delete/List) | ❌ |
| | **PushNotification**/RemoteTrigger/Monitor/Sleep/SubscribePR | ⚠️ notify✅(osascript 系统通知)，其余❌ |
| worktree | EnterWorktree/ExitWorktree | ❌ |
| 交互 | **AskUserQuestion** | ✅ ask_user_question |
| | Config/Snip/TerminalCapture/ReviewArtifact/SendUserFile | ❌ |
| 生图(我们扩展) | — | ✅ generate_image/make_poster（内置生图 key·BYOK 可覆盖；GPT Image-2 走美国机中转、国内走硅基/通义/即梦） |

## C · 命令系统（slash · cc-haha 内置 ~120）

- 自定义 `.claude/commands/*.md`：⚠️（技能管线可复用，待接 commands 目录）
- 内置命令：✅ `/new /clear /model /settings /goal /cost /agents /mcp /skills /plugins /context /export /help`（13 个接真动作）；✅ `/commit /review`（技能）；❌ 其余 cc-haha 内置多为 `/theme /vim /doctor /resume /teleport /share` 等 UI 面板或对我们 NA

## D · 权限模型

| 项 | cc-haha | 我们 |
|---|---|---|
| 模式 | default/acceptEdits/**plan**/bypass | ✅ ask/auto_files/**plan**/full（4档全；plan=只读探索不执行，3测试） |
| 规则 allow-ask-deny（`Bash(git *)` 通配） | ✅ | ❌（我们靠 approval_class + force_confirm，无规则语法） |
| force_confirm（bypass-immune） | ✅ | ✅ |
| Hook 拦截权限 | ✅ | ✅（PreToolUse 可拦） |
| ML 安全分类器 | ✅ | ❌（用黑名单+审批闸兜） |

## E · Hooks（cc-haha 27 事件 × 4 类型）

| 项 | cc-haha | 我们 |
|---|---|---|
| 进程内 Pre/Post/Stop | ✅ | ✅（Python 回调，故障安全） |
| 事件点 | 27 个（…） | ⚠️ 5 个(PreToolUse/PostToolUse/Stop/**UserPromptSubmit**/**SessionStart**，含注入上下文/拦截)；其余22❌ |
| 配置驱动（settings.json） | ✅ | ✅ `hooks`键(Pre/Post/Stop)+matcher+退出码2/JSON阻断，DESKTOP_CONFIG_HOOKS门控，6测试 |
| 类型 command/prompt/http/agent | ✅ | ⚠️ command✅；prompt/http/agent ❌ |
| `matcher` + `if` 权限语法 | ✅ | ❌ |

## F · 上下文 / 压缩 / 记忆

| 项 | cc-haha | 我们 |
|---|---|---|
| 三/四级压缩（snip/micro/collapse/autocompact） | ✅ | ✅（snip+microcompact+autocompact 三级+熔断） |
| token 预算续跑 | ✅ | ⚠️（有早停，无"续跑推进"） |
| system reminder 注入 | ✅ | ⚠️（注入店脑/选定文件；缺通用 `<system-reminder>` 机制） |
| git status / CLAUDE.md 注入 | ✅ | ❌（通用 Agent 缺；店脑画像有） |
| **memdir 持久文件记忆**（跨会话 .md + 检索 + 自动提取 + AutoDream） | ✅ | ❌（我们有店脑 remember，但非 cc 的 memdir 体系） |

## G · 编排 / 子 agent / teams

| 项 | cc-haha | 我们 |
|---|---|---|
| 同步 subagent | ✅ | ✅ run_subagent + 专家类型 |
| AgentDef 专家池（Explore/Plan/verification…） | ✅ | ✅ general-purpose/explore(只读)/plan(只读)，只读型机制上只给只读工具，4测试 |
| 异步后台 subagent + 进度 | ✅ | ❌ |
| Fork（缓存复用） | ✅ | ❌ |
| Coordinator 协调者模式 | ✅ | ❌ |
| Agent Teams（多终端邮箱协作） | ✅ | ❌（阶段7） |

## H · 后台任务 / 定时 / 目标 / 主动

| 项 | cc-haha | 我们 |
|---|---|---|
| 后台任务引擎 + 完成通知 | ✅ | ✅ `run_background`(审批闸·asyncio跑完→系统通知+输出落盘可读)，2测试 |
| Cron 定时任务工具 | ✅ | ✅ Cron-lite：`schedule_reminder`/`list_reminders`/`cancel_reminder` + 进程内loop每30s触发系统通知，3测试 |
| `/goal` 目标驱动（Stop-hook 评估续跑） | ✅ | ✅ `/goal`命令(设/清)+常驻 Stop hook(对照目标自检续跑)+前端，2测试 |
| Proactive 主动出击 | ✅ | ⚠️（每日草稿预生成） |

## I · 扩展系统

| 项 | cc-haha | 我们 |
|---|---|---|
| **Skills（SKILL.md）** | ✅ | ✅ **端到端**（加载/渐进披露/skill工具/slash/面板/2内置技能/18测试） |
| Output Styles | ✅ | ✅ 端到端（loader/系统提示注入/`GET /agent/output-styles`/工具条风格下拉/2内置风格,7测试） |
| Plugins + Marketplace | ✅ | ⚠️ 本地目录插件✅ + **install_plugin**(从 GitHub owner/repo 或 url `git clone` 安装→组件自动生效)✅；marketplace目录/npm·pip源/依赖闭包❌ |
| MCP 客户端 | ✅ | ✅ 官方 `mcp` SDK(stdio)：`.mcp.json`配置/发现/调用/状态/按readOnlyHint分级审批，接进registry，`GET /agent/mcp`，5测试 |

## J · Computer Use / 测试

| 项 | cc-haha/官方 | 我们 |
|---|---|---|
| `computer` 工具（操作电脑） | ✅ | ✅ computer_view(看屏只读)+computer_control(点击/键入/滚动,审批闸+force_confirm)，借本机pyautogui，9测试 |
| 真机验收测试器 | Linux Docker(Xvfb) | ✅ **desktop-control 已装+本会话实测可用**（截屏+点击+控窗） |
| 确定性 E2E 回归 | — | ⚠️ Playwright-Electron（web/ 已有库，待搭脚本） |

## K · 渠道 / 远程 / 编辑器

| 项 | cc-haha | 我们 |
|---|---|---|
| IM 适配（微信/TG/飞书/钉钉/WhatsApp） | ✅ adapters/ | ⚠️ **Telegram(长轮询) + 通用 webhook 端点(密钥保护)** 两条进入路径 + IM安全工具集(排除写改/命令/操作电脑)，10测试；飞书/微信/钉钉只需配 bot POST 到 webhook(内网穿透) |
| SSH 服务端 / remote / daemon | ✅ | ❌（阶段9） |
| vim 模式 / 自定义键位 | ✅ | ❌（杂项） |

---

## 还差什么 · 按优先级（驱动后续 0→6）

1. **阶段1 收尾**：~~Output Styles~~ ✅ 已；更多内置 slash 命令（/model /compact /context /cost /memory…，多为前端 UI 动作）；`.claude/commands/*.md` 自定义命令接入。
2. **门面补全（阶段0 尾）**：工具进行时/过去式动词 + ⏺/⎿ 字形 + 连续分组；word-level diff（文件改写已字符级高亮 ✅，审批卡预览仍纯文本待补）；~~thinking 折叠~~ ✅ 已（F.1/F.2）；~~todo 实时清单~~ ✅ 已；上下文占用条；status line。
3. **阶段2**：AgentDef 子代理专家池（Explore/Plan/verification）+ 异步后台任务 + `<task-notification>` 通知 + Cron 工具 + `/goal`。
4. **阶段3**：MCP 客户端（官方 Python SDK）。
5. **阶段4**：`computer` 工具（desktop-control 执行）+ Playwright-Electron 回归脚本。
6. **阶段5/6/7/8/9**：Plugins+Marketplace；配置化 Hook（27事件）+ ToolSearch；多终端 Teams；IM 适配；SSH/remote/daemon；vim/键位。
7. **机制补全**：plan 权限模式；规则 allow-ask-deny 语法；memdir 持久记忆；git/CLAUDE.md 注入 + 通用 system-reminder。

> 维护规则：每搬完一项，把对应行从 ❌/⚠️ 改 ✅ 并在路线图进度勾一笔。
