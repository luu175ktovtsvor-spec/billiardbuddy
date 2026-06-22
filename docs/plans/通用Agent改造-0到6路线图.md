# 通用 Agent 改造 · 0→6 路线图（对标 Claude Code）

> **接手先读这里。** 本文件 = 把「台球房运营助手」重构成「通用型·偏代码 AI Agent」（对标 Claude Code）的**权威路线图 + 进度**。配合 `CLAUDE.md` + `交接-给新会话/现状与待办.md`。
> 起源：2026-06-21 用户拍板战略转向（见下「背景」）。第一读者是 AI——写清范围、契约、验证方式。

## 背景 / 战略转向（⚠️ 覆盖旧结论）

- 用户明确：把盒子做成**真正的通用型、偏代码/编程的 AI Agent**，**对标 Claude Code，cc-haha 里有的能力尽量全搬**，前后端机制做齐，**保留现有配色**，旧东西可重做。
- **此方向覆盖**旧记忆/文档里「产品已成熟、cc-haha 待借机制是鸡肋别硬做」的保守结论（`docs/learn-claude-code借鉴改造记录.md` 里 SH-5/7/10 标"暂不做"的判断在新方向下作废）。
- 台球知识 = **可 @挂载的知识库主题**（延续 general-agent-reframe），不是产品边界。
- **⚠️ 全搬、不掺判断（用户强调）**：cc-haha 有的尽量**全搬**，别人怎么设计就怎么设计；AI 不再自作主张列"跳过/鸡肋"或自创命名。之前标"跳过"的（IM 适配器/SSH/多终端 Teams/remote·daemon/vim）**也要做**。改对标 CC 的东西先去 `~/Desktop/cc-haha-ref` 看原样、照搬。

## 调研结论（5 路并行侦察 · 2026-06-21）

- **引擎内核已对标 CC**：~25 项硬机制（ReAct/工具+校验/3档权限+审批闸HMAC/Pre·Post·Stop Hook/microcompact+三级压缩/anti-spin/token预算早停/超大结果落盘/文件沙箱/run_command/子代理基础版/多模态/RAG/失败切BYOK档/prompt-cache纪律），30+ 测试钉死，前后端 SSE 链路完整无断点。
- **差距 = 生态/扩展层 + 前端专业门面**：Slash / Skills / Plugins / MCP / OutputStyles / ComputerUse / 后台任务通知 + 门面文案与呈现。
- **cc-haha 参考库**（**可直接抄用**）：`~/Desktop/cc-haha-ref`。金矿文件：
  - `desktop/src/i18n/locales/en.ts` + `zh.ts`（完整专业文案库，1946 行）
  - `docs/ui-clone/02-ui-design-spec.md`（配色/布局/呈现规范，施工图）
  - `docs/skills/`、`docs/agent/01·02·03`、`src/schemas/hooks.ts`、`src/utils/plugins/schemas.ts`、`src/services/mcp/types.ts`（各系统数据契约，原样复刻以兼容生态）

## 测试策略（用户问的 Computer Use 已抓官方文档核实）

- **确定性回归** → Playwright-for-Electron（`web/` 已有 playwright，`_electron` 拉起 app，IPC 直连+主进程断言，快）。
- **真人式验收** → 本机已装 `desktop-control`（截图+点击+打字）喂 Opus 4.8（本就支持 `computer-use-2025-11-24`），像新店长一样点一圈+对后端日志。
- **不用**官方 Computer Use Docker（Linux/Xvfb、非 Mac、定位是"AI 自主操作"非确定性测试框架）。
- 官方文档：`platform.claude.com/docs/en/docs/build-with-claude/computer-use`。

## 守的铁律（每阶段都守）

纯 BYOK（没配即空 key 不回退）/ SQLite 兼容（PG 专属 SQL 按方言兜底）/ 文件沙箱+改前备份 / 审批闸+不自动触达 / POS 只读 / 安全红线不可旁路 / prompt-cache 前缀纪律 / 同步+流式两入口对称 / **可抄 cc-haha 源码**（搬进来按本项目结构整合）。

---

## 阶段（每阶段 = 后端 + 前端组件 + 机制 + 测试 一起做，做完汇报）

### 阶段0 · 前端门面专业化（保配色）  ▶ 进行中
- **目标**：去掉"您好/有什么可以帮您"客服腔，换成 Claude Code 式专业 coding-agent 文案与呈现；**只换文案与呈现模式，不动配色**。
- **权限模式照搬 CC（3 档，后端值 `ask/auto_files/full` 不变，只改显示文案）**：① 询问权限（default）② 自动接受编辑（acceptEdits）③ 完全访问模式（bypassPermissions）。
- **前端**：
  - 新建集中文案模块 `web/src/lib/agent-copy.ts`（欢迎/空状态/placeholder/权限模式三档/spinner 动词库/工具进行时·过去式动词/审批·提问·错误措辞）——参考 cc-haha i18n，改写成我们语境。
  - 工具调用呈现：状态圆点（进行=灰/成功=绿/失败=红）+ 进行时·过去式动词 + 参数 + `⎿` 缩进结果；连续同类工具分组。
  - Spinner：动词库随机轮换 + 计时 + token + "esc/点击中断" + 卡顿(3s无token)变色。
  - thinking 默认折叠灰块；word-level diff；审批卡三档措辞（允许一次/本会话允许/拒绝+反馈框）。
- **改动文件**：`welcome-screen.tsx`、`desktop-composer.tsx`、`chat-thread.tsx`、`chat-shell.tsx`（用 `agent-copy.ts`）。
- **测试**：`pnpm exec tsc --noEmit` 全过；关键路径 Playwright 截图对照（登录→进聊天→发消息→工具卡/审批卡）。
- **守**：配色不变；不破现有 SSE 消费链路（onToolCall/onToolResult 按 id 回填、成品卡/审批卡/提问卡逻辑）。

### 阶段1 · Slash 命令 + Skills + Output Styles（扩展总地基）
- **统一管线**：frontmatter(YAML) + markdown 解析器 → 目录扫描(`~/.claude/skills`、`<proj>/.claude/skills`、`.claude/commands`、`output-styles`) → 去重 → 注入。六系统复用此管线。
- **后端**：
  - `services/agent/skills/`：loader + frontmatter 解析 + 渐进式披露（每轮 `<system-reminder>` 注入"名字+description"清单，正文调用时才展开，预算≈上下文 1%）+ `Skill` 工具（inline 执行；fork 走 run_subagent）+ 条件激活(`paths:` glob)。
  - Slash 命令：内建命令注册表（`/help /compact /context /cost /clear /model /skills /mcp /agents /output-style /goal …`）+ 自定义 `.claude/commands/*.md`（复用 skill 管线）。
  - Output Styles：扫 md → 切/增补 system prompt；`settings.outputStyle`。
  - API：`GET /api/v1/skills`、`/skills/detail`、`GET /api/v1/commands`、`GET/PUT /api/v1/output-styles`。
- **前端**：`/` 触发命令面板（分组 Context/Project/Desktop/More）、技能选择器、输出风格切换；composer 里 `findSlashCommandPositions` 补全。
- **契约复刻**（兼容 CC 生态）：SKILL.md frontmatter 全字段（name/description/when_to_use/context inline·fork/allowed-tools/model/effort/paths/argument-hint/arguments/hooks…）；命令 frontmatter 子集；output-style frontmatter（name/description/keep-coding-instructions）。
- **测试**：技能发现/去重/渐进披露注入/inline 执行/`/命令` 路由 各 pytest；前端命令面板 tsc + Playwright。

### 阶段2 · 子代理专家池 + 后台任务+通知 + Cron + /goal
- 子代理：`AgentDef`（md/json）多专家池（general-purpose/Explore/Plan/verification）+ 工具白名单三层过滤 + 同步/异步后台两路径；`prompts/agents/*.yaml` 或 `.claude/agents/*.md`。
- 后台任务引擎：TaskState 落 SQLite + ProgressTracker + 输出落盘轮询 + 完成 `<task-notification>` 入队（**落地 learn-claude-code Task5**：立即返回 taskId + 独立 channel + 不复用 tool_use_id）。
- Cron：`croniter`/APScheduler，`CronCreate/Update/Delete/List` 工具，`.claude/scheduled_tasks.json`。
- `/goal`：注入 session 级 Stop hook（小模型评估"目标达成？"未达成回灌"还差什么"逼继续）+ token 预算续跑。
- **前端**：后台任务指示器卡（状态/进度/最近活动）、子代理彩色 chip + 可点开 transcript、定时任务列表。

### 阶段3 · MCP 客户端
- 用**官方 MCP Python SDK**：stdio + http(+sse) 连接 → tools 注入工具池（`mcp__server__tool` 命名 + 缓存稳定排序）→ prompts 转 skills。
- 配置：`.mcp.json`（contract 见 `src/services/mcp/types.ts`）+ scope/启停/去重；OAuth 后置。
- **前端**：`/mcp` 列 server + 连接状态（connected/needs-auth/failed/disabled）+ 增删改/重连。
- **守**：MCP server key 仍走 BYOK 思路（用户自配，不内置）。

### 阶段4 · Computer Use 能力 + 桌面测试编排
- **能力**：`computer` 工具（screenshot/click/type/key/scroll…）经 `desktop-control`(pyautogui+osascript) 执行——"通用电脑执行器"（建文件夹/操作其他 app）。对外动作走审批闸。
- **测试编排**：① Playwright `_electron` 确定性 E2E（登录→聊天→审批卡 关键路径回归）；② desktop-control 截图喂 Opus 做真人验收脚本（agent loop，执行器=本机）。
- **守**：操作真桌面=高风险，默认需"完全访问模式"+审批；macOS 辅助功能/屏幕录制授权引导。

### 阶段5 · Plugins + Marketplace
- 插件 = 目录 + `plugin.json`（contract 见 `src/utils/plugins/schemas.ts`）：可装 commands/agents/skills/hooks/output-styles/mcpServers。
- 先支持：本地目录插件 + 内置插件 + 单 github 源；marketplace.json/依赖闭包/npm-pip/autoUpdate/信任对话 逐步加。
- **前端**：`/plugin` 管理（启停/更新/卸载）+ marketplace 浏览。

### 阶段6 · 配置驱动 Hook 扩展 + ToolSearch 渐进披露
- Hook：扩展事件点（SessionStart/UserPromptSubmit/PreCompact/SubagentStop…）+ 外部 `settings.json` 配置驱动（command/prompt/http/agent 四类型 + matcher + `if` 权限语法）。contract 见 `src/schemas/hooks.ts`。
- ToolSearch：工具延迟加载（只暴露名字+searchHint，`ToolSearch(query)` 按需取 schema）——**MCP/插件接入后工具会膨胀，此时才划算**。

### 阶段7 · 多终端 Agent Teams（多 agent 协作）
tmux/iTerm2 多终端后端 + 文件锁邮箱（proper-lockfile）+ 收件箱轮询 + 权限同步 + 广播；`~/.claude/teams/<name>/config.json`。对标 cc-haha `src/utils/swarm/`、`src/utils/teammateMailbox.ts`。

### 阶段8 · IM 渠道适配器
微信 / Telegram / 飞书 / 钉钉 / WhatsApp 适配器（对标 cc-haha `adapters/`）：把 agent 接到 IM 通道，消息进出 + 审批闸（不自动群发红线仍守）。

### 阶段9 · SSH 服务端 + remote/daemon 远程
SSH 服务端 + 远程触发 + 守护进程（对标 cc-haha `src/ssh`、`src/daemon`、`src/remote`），让 agent 可远程驱动。

### 杂项 · vim 模式 + 自定义键位
输入区 vim 编辑模式 + 可自定义键位（对标 `src/vim`、`src/keybindings`），并入合适阶段。

---

## 进度

- [x] 调研（5 路并行：CC 核心引擎 / 扩展系统 / 前端UI+文案 / ComputerUse测试 / 自有现状审计）— 2026-06-21
- [x] **完整功能矩阵** `docs/plans/cc-haha功能矩阵-全搬对照.md`（全功能×我们状态，驱动"全搬"）— 2026-06-21
- [x] **plan 计划模式**（权限 4 档全，只读探索不执行，3测试）+ 工具 **⏺ 状态点**（灰运行/绿完成）— 2026-06-21
- [x] **打包 + 真机启动验证**（2026-06-21）：修打包脚本（带上内置 skills/output-styles 数据目录 + 补 hooks_config/im_telegram/output_styles 的 hidden-import）→ **后端 PyInstaller ✓ + 前端 standalone ✓ + electron-builder → dmg ✓**（`dist/台球运营管家-0.2.0-arm64.dmg` 241M，未签名）→ **启动打包 app：前台=台球运营管家、PyInstaller 后端 8077 在服务、前端渲染登录页（配色完好）**。warn 无漏我新增模块、内置技能/风格已进 `_internal/`。**+ 直跑打包后端二进制 → 注册(201) + curl：`/agent/skills` 真返回内置 commit/review、`/output-styles` 真返回 concise/explanatory(source:bundled)、`/plugins`/`/mcp` 全 200** —— 打包运行时端点 + 内置内容加载 + 前后端衔接数据源验证通过。**+ 真机可视化验收（desktop-control 真人走查）✓**：装包后台跑→注册→UI 登录→进**新门面**（"新会话"/CC式副标题/"完全访问模式"/"默认风格"/新 placeholder 全渲染正确）→`/help` 命令面板弹出、列出命令+真实技能（带"命令/技能"徽标）。**⚠️ 过程中逮出静态检查全漏的真 bug**：`build_frontend.js` 只拷贝不构建、漏设 `API_PROXY_URL` → 前端 next.config rewrites 反代默认到 **8000**（后端在 8077）→ 登录 **500**、前后端衔接断。**已修**：build_frontend.js 改为自带 `pnpm build`(烘入 `API_PROXY_URL=http://127.0.0.1:8077`) → 重建前端 + 重打 dmg → curl 前端 3100 login 返 token、UI 登录通、门面/`/`面板正确。**这就是"Computer Use 式真机测试"的价值**（正是用户强调的"前后端衔接别出问题"）。待：AI 生成全流程（需 BYOK key，人在场时走一遍）
- [~] 阶段0 前端门面专业化（保配色）— 进行中。已:`agent-copy.ts`文案库 / 权限三档照CC(询问权限·自动接受编辑·完全访问模式) / `agent-spinner.tsx`(✻+动词库+计时+esc中断) / 欢迎页去客服腔 / esc中断接线 / **右侧预览扩成代码画布(file·code视图 + 步骤"⤢右侧打开")**。待:工具进行时·过去式动词 + word-level diff + 审批三档措辞(Yes / Yes不再询问 / No+反馈)
- [~] 阶段1 Slash + Skills + Output Styles — 已:**Skills 端到端**(frontmatter解析/多源加载去重/渐进披露注入/`skill`工具/`/name`slash展开/`GET /agent/skills`/前端`/`命令面板/2内置技能commit·review) + **Output Styles 端到端**(loader/系统提示注入/`GET /agent/output-styles`/工具条风格下拉/2内置风格explanatory·concise) — 后端 **499 测试全绿**、前端 tsc 绿。待:更多内置命令(/model·/compact·/context·/cost…) + `.claude/commands/*.md` 自定义命令
- [x] 阶段2 子代理专家池 + 后台任务+通知 + Cron + /goal — **全做**：子代理专家池(general-purpose/explore/plan) + notify 通知 + /goal 目标驱动 + **run_background 后台任务**(审批闸·跑完系统通知+输出落盘) + **Cron-lite 定时提醒**(schedule_reminder/list/cancel + 进程内loop)。13+测试
- [x] 阶段3 **MCP 客户端** — 官方 `mcp` SDK(stdio) / `.mcp.json`配置发现 / 调用 / 状态 / 按readOnlyHint分级审批 / 接进registry / `GET /agent/mcp` / 5测试
- [~] 阶段4 Computer Use 能力 + 桌面测试编排 — 已:**computer_view/computer_control 工具**(看屏只读 + 点击/键入/滚动走审批闸+force_confirm,9测试) + desktop-control 实测可用(截屏/识别前台app/控屏)。待:Playwright-Electron 回归脚本 + 截图喂模型(多模态工具结果)
- [~] 阶段5 Plugins + Marketplace — 已:**本地目录插件**(plugin.json + skills/output-styles/.mcp.json 约定；启用插件组件自动并入 skills/风格/MCP 加载器 → 直接出现在`/`面板·风格下拉·MCP列表；`GET /agent/plugins`；7测试)。待:marketplace + 远程源(github/npm/pip) + 依赖/启停UI
- [~] 阶段6 配置化 Hook 扩展 + ToolSearch 渐进披露 — 已:**配置驱动 Hooks**(settings.json command型 Pre/Post/Stop + matcher + 退出码2/JSON阻断,自门控DESKTOP_CONFIG_HOOKS,6测试)。待:更多事件(SessionStart/UserPromptSubmit…) + prompt/http/agent型 + ToolSearch
- [ ] 阶段7 多终端 Agent Teams（tmux/iTerm2 邮箱协作）
- [~] 阶段8 IM 渠道适配器 — 已:**Telegram 适配器**(stdlib无依赖长轮询/收发/IM安全工具集排除写改命令操作电脑/allowed名单/接lifespan,7测试)，确立适配器框架(poll/parse/send + agent_runner)。待:飞书/微信/钉钉照此加 + 前端渠道状态展示
- [ ] 阶段9 SSH 服务端 + remote/daemon 远程
- [ ] 杂项 vim 模式 + 自定义键位
