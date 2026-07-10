# 通用 Agent 改造 · 0→9 路线图（对标 cc-haha）

> 📌 状态:🗺️长期路线图/愿景 · 最后核对 2026-07-10
>
> **这份是长期愿景 + 阶段0→9 能力覆盖全景,不是当前施工权威。** 现行架构/状态以 `docs/当前架构与状态-总览.md` 为准,**逐模块施工进度与当前落地权威一律以 `docs/plans/TS-cc-haha-v0.4.5-内核迁移矩阵-2026-07-07.md` 为准**(§3.401/§3.405 有全 16 模块 cc 差异矩阵与本轮进度)。
> ℹ️ **本文已剥离已删 Python 老栈的实现细节与历史进度日志**(原引用的 `services/agent/`、`web/src`、pnpm/pytest、SQLite、pyautogui、croniter、`agent-copy.ts`、`docs/归档/*`、`docs/暂不做项-*` 均属已删老栈),只留阶段0→9 的 cc 能力覆盖全景供路线视角参考;某项能力是否落地、落到哪一步,一律查上面的迁移矩阵。
> 起源:2026-06-21 用户拍板战略转向(见下「背景」)。第一读者是 AI——保留它是为阶段能力覆盖的全景视角。

## 背景 / 战略转向（⚠️ 覆盖旧结论）

- 用户明确：把盒子做成**真正的通用型、偏代码/编程的 AI Agent**，**对标 Claude Code，cc-haha 里有的能力尽量覆盖到位**，前后端机制做齐，**保留现有配色**，旧东西可重做。
- **此方向覆盖**旧记忆/文档里「产品已成熟、cc-haha 待借机制是鸡肋别硬做」的保守结论（之前标"暂不做"的判断在新方向下一律作废；harness 缺口以 `docs/references/harness缺口审计-对照ClaudeCode-2026-06-26.md` 为准）。
- 台球知识 = **可挂载的台球运营专家**（延续 general-agent-reframe），不是产品边界。
- **⚠️ 全量对齐、不掺判断（用户强调）**：cc-haha 有的尽量**覆盖能力与边界行为**，别人怎么设计就先看明白；AI 不再自作主张列"跳过/鸡肋"或自创命名。之前标"跳过"的（IM 适配器/SSH/多终端 Teams/remote·daemon/vim）**也要做**。改对标 CC 的东西以 `~/Desktop/cc-haha-ref` 为源码规格;该库 LICENSE 允许复制/修改/发布,可直接复制/抄/移植/改写。

## 调研结论（5 路并行侦察 · 2026-06-21）

- **引擎内核已对标 CC**：~25 项硬机制（ReAct/工具+校验/3档权限+审批闸HMAC/Pre·Post·Stop Hook/microcompact+三级压缩/anti-spin/token预算早停/超大结果落盘/文件沙箱/run_command/子代理基础版/多模态/RAG/失败切档容灾(内置/BYOK 多档任意组合，BYOK=可选高级档·非默认)/prompt-cache纪律），30+ 测试钉死，前后端 SSE 链路完整无断点。
- **差距 = 生态/扩展层 + 前端专业门面**：Slash / Skills / Plugins / MCP / OutputStyles / ComputerUse / 后台任务通知 + 门面文案与呈现。
- **cc-haha 参考库**（**可直接复制/抄/移植/改写**）：`~/Desktop/cc-haha-ref`。金矿文件：
  - `desktop/src/i18n/locales/en.ts` + `zh.ts`（完整专业文案库，1946 行）
  - `docs/ui-clone/02-ui-design-spec.md`（配色/布局/呈现规范，施工图）
  - `docs/skills/`、`docs/agent/01·02·03`、`src/schemas/hooks.ts`、`src/utils/plugins/schemas.ts`、`src/services/mcp/types.ts`（各系统数据契约，按兼容生态的方向做契约对齐）

## 测试策略（用户问的 Computer Use 已抓官方文档核实）

- **确定性回归** → Playwright-for-Electron（`_electron` 拉起 app，IPC 直连+主进程断言，快）。
- **真人式验收** → 本机已装 `desktop-control`（截图+点击+打字）喂 Opus 4.8（本就支持 `computer-use-2025-11-24`），像新店长一样点一圈+对后端日志。
- **不用**官方 Computer Use Docker（Linux/Xvfb、非 Mac、定位是"AI 自主操作"非确定性测试框架）。
- 官方文档：`platform.claude.com/docs/en/docs/build-with-claude/computer-use`。

## 守的铁律（每阶段都守）

全内置模型 key（owner 提供·用户不填）/ 文件式存储无 SQL / 文件沙箱+改前备份 / 审批闸+不自动触达 / POS 只读 / 安全红线不可旁路 / prompt-cache 前缀纪律 / 同步+流式两入口对称 / **CC-Haha 可直接复制/抄/移植/改写**（按本项目结构落地，并用行为测试锁边界）。

---

## 阶段（每阶段 = 后端 + 前端组件 + 机制 + 测试 一起做，做完汇报）

### 阶段0 · 前端门面专业化（保配色）  ▶ 进行中
- **目标**：去掉"您好/有什么可以帮您"客服腔，换成**抄 WorkBuddy(腾讯 CodeBuddy)中文写法**的专业 coding-agent 文案与呈现；**只换文案与呈现模式，不动配色**。
- **权限模式对齐 CC（4 档，后端值 `ask/auto_files/plan/full`）**：① 逐项确认（default）② 自动接受修改（acceptEdits）③ 计划模式（plan，只读探索不执行）④ 跳过确认（bypassPermissions）。
- **前端**：
  - 集中文案模块（欢迎/空状态/placeholder/权限模式四档/spinner 动词库/工具进行时·过去式动词/审批·提问·错误措辞）——文案照 WorkBuddy 中文写法改写成我们语境。
  - 工具调用呈现：状态圆点（进行=灰/成功=绿/失败=红）+ 进行时·过去式动词 + 参数 + `⎿` 缩进结果；连续同类工具分组。
  - Spinner：动词库随机轮换 + 计时 + token + "esc/点击中断" + 卡顿(3s无token)变色。
  - thinking 默认折叠灰块；word-level diff；审批卡三档措辞（允许一次/本会话允许/拒绝；拒绝反馈框后续补）。
- **测试**：typecheck 全过；关键路径 Playwright 截图对照（进聊天→发消息→工具卡/审批卡）。
- **守**：配色不变；不破现有 SSE 消费链路（onToolCall/onToolResult 按 id 回填、成品卡/审批卡/提问卡逻辑）。

### 阶段1 · Slash 命令 + Skills + Output Styles（扩展总地基）
- **统一管线**：frontmatter(YAML) + markdown 解析器 → 目录扫描(`~/.claude/skills`、`<proj>/.claude/skills`、`.claude/commands`、`output-styles`) → 去重 → 注入。六系统复用此管线。
- **后端**：
  - 技能引擎：loader + frontmatter 解析 + 渐进式披露（每轮 `<system-reminder>` 注入"名字+description"清单，正文调用时才展开，预算≈上下文 1%）+ `Skill` 工具（inline 执行；fork 走 run_subagent）+ 条件激活(`paths:` glob)。
  - Slash 命令：内建命令注册表（`/help /compact /context /cost /clear /model /skills /mcp /agents /output-style /goal …`）+ 自定义 `.claude/commands/*.md`（复用 skill 管线）。
  - Output Styles：扫 md → 切/增补 system prompt；`settings.outputStyle`。
  - API：`GET /api/v1/skills`、`/skills/detail`、`GET /api/v1/commands`、`GET/PUT /api/v1/output-styles`。
- **前端**：`/` 触发命令面板（分组 Context/Project/Desktop/More）、技能选择器、输出风格切换；composer 里 `findSlashCommandPositions` 补全。
- **契约复刻**（兼容 CC 生态）：SKILL.md frontmatter 全字段（name/description/when_to_use/context inline·fork/allowed-tools/model/effort/paths/argument-hint/arguments/hooks…）；命令 frontmatter 子集；output-style frontmatter（name/description/keep-coding-instructions）。
- **测试**：技能发现/去重/渐进披露注入/inline 执行/`/命令` 路由 各有单测；前端命令面板 typecheck + Playwright。

### 阶段2 · 子代理专家池 + 后台任务+通知 + Cron + /goal
- 子代理：`AgentDef`（md/json）多专家池（general-purpose/Explore/Plan/verification）+ 工具白名单三层过滤 + 同步/异步后台两路径；子代理定义走 `.claude/agents/*.md`。
- 后台任务引擎：TaskState 落盘 + ProgressTracker + 输出落盘轮询 + 完成 `<task-notification>` 入队（立即返回 taskId + 独立 channel + 不复用 tool_use_id）。
- Cron：确定性调度器 + `CronCreate/Update/Delete/List` 工具，`.claude/scheduled_tasks.json`。
- `/goal`：注入 session 级 Stop hook（小模型评估"目标达成？"未达成回灌"还差什么"逼继续）+ token 预算续跑。
- **前端**：后台任务指示器卡（状态/进度/最近活动）、子代理彩色 chip + 可点开 transcript、定时任务列表。

### 阶段3 · MCP 客户端
- 用**官方 MCP SDK**：stdio + http(+sse) 连接 → tools 注入工具池（`mcp__server__tool` 命名 + 缓存稳定排序）→ prompts 转 skills。
- 配置：`.mcp.json`（contract 见 `src/services/mcp/types.ts`）+ scope/启停/去重；OAuth 后置。
- **前端**：`/mcp` 列 server + 连接状态（connected/needs-auth/failed/disabled）+ 增删改/重连。
- **守**：MCP/外部工具 key 也全内置（owner 提供、用户不配；优先 native 工具）。

### 阶段4 · Computer Use 能力 + 桌面测试编排
- **能力**：`computer` 工具（screenshot/click/type/key/scroll…）经 `desktop-control` 执行——"通用电脑执行器"（建文件夹/操作其他 app）。对外动作走审批闸。
- **测试编排**：① Playwright `_electron` 确定性 E2E（进聊天→审批卡 关键路径回归）；② desktop-control 截图喂 Opus 做真人验收脚本（agent loop，执行器=本机）。
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

## 进度与当前状态

> **历史进度勾选(Python 期)已整体移除**——那份逐条记录引用的 `services/agent/`、`web/src`、pnpm/pytest、SQLite、`docs/归档/*`、`docs/暂不做项-*` 均属已删老栈,留着只会误导。
>
> **阶段0→9 各能力当前落到哪一步,一律以施工权威为准:`docs/plans/TS-cc-haha-v0.4.5-内核迁移矩阵-2026-07-07.md`(§3.401/§3.405 有全 16 模块 cc 差异矩阵与本轮进度);现行架构/状态见 `docs/当前架构与状态-总览.md`。** 本文只保留阶段0→9 的能力覆盖全景,不再自带进度勾选。
