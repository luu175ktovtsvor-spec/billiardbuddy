# 05 · cc-haha 行为对齐清单（可直接复制/抄/移植/改写施工版）

> 📌 状态:✅现行 · 2026-07-06 立 · 2026-07-07 校正口径 · **TS 内核行为对齐的逐窗施工依据**（配套主文档《TS-harness-重构-主开发文档-2026-07-05.md》§0.5 战略升级）
> 来源:5 路子代理源码级盘点 cc-haha（`~/Desktop/cc-haha-ref`）。判据 = 桌面 GUI 产品 / 不懂技术的台球老板 / 驱动 OpenAI 兼容国产模型（MiMo/豆包）/ 不是 Claude。
> 标注:借鉴价值 [必做 / 值得 / 改造后用 / 跳过 / 我们已领先] · 耦合 [纯逻辑 / 绑Claude / 绑终端TUI] · 路径根 = `~/Desktop/cc-haha-ref/`
> ⚠️ 迁移口径(owner 2026-07-07 更新):**CC-Haha 可直接复制/抄/移植/改写,效果对齐是唯一硬标准**。`~/Desktop/cc-haha-ref/LICENSE` 允许 use/copy/modify/distribute/publish copies;复杂边界先写行为对齐测试,实现可直接移植/改写到本项目模块里。**行为对齐(同输入同输出/同决策跑绿)= 证明效果一样的硬闸。**

## 三个战略结论（先读）

1. **cc-haha 最值钱的两样内核**:① 扩展/创造架构（技能=能力、台球=一个"包"，加能力=丢文件）；② 让循环在国产模型上不崩的"底盘"（proxy 层：消息配对清洗/错误回灌/流式对接/压缩熔断）。功能多是表象，这两样是内核。
2. **cc-haha 不是终端-only**:它有一整套 Electron 桌面 GUI（同栈）。UI 外壳不用抄（我们更贴小白 + 有 artifacts 持久化/评分它没有），但**内容管道**（从正文认产物→卡片→预览、选区→对话）它领先、要抄。
3. **我们已走一半**:`server/services/agent/skills.py` 已是忠实的 cc-haha 式技能系统，`server/skills/` 已有 24 个台球 SKILL.md。机制在 MiMo/豆包上已跑通。缺的是把 `billiards_mode` 硬编码收成"包"。

---

## 第一梯队 · 必抄

### ① 国产模型不崩底盘（proxy 层 · 最高优先 · 先做）
> cc-haha 内核全用 Anthropic content-block 格式，靠一个 2767 行 proxy 层（`src/server/proxy/`）把 OpenAI 兼容模型双向翻译进来。下列"不崩"机制**全在这层**。
- **消息配对清洗 `ensureToolResultPairing`/`normalizeMessagesForAPI`**（`src/utils/messages.ts:2004`）:补孤儿 tool_use、删孤儿 tool_result、去重 id。**不清洗国产模型上循环隔三差五 400 卡死。**· 纯逻辑 · 中
- **tool_result 紧贴 tool_use 重排**（`messages.ts:1496`）· 纯逻辑 · 小
- **工具错误一律回灌不崩循环**（`toolExecution.ts:337`）:未知工具名/参数错/执行崩全包 `<tool_use_error>` 喂回自救。国产模型幻觉工具名是常态。· 纯逻辑 · 小
- **Tool 基类 fail-closed 默认**（`Tool.ts:757`）· 纯逻辑 · 小
- **OpenAI 流式工具调用分片累积**（`openaiChatStreamToAnthropic.ts`）:按 index 建 Map、id+name 到齐才开块。⚠️ 有些国产模型不给 tool_call id 会静默丢工具调用→改成"有 name 就开、缺 id 自造 `call_{index}_{ts}`"。· 纯逻辑 · 小
- **reasoning_content 多方言归一**:`reasoning_content`(MiMo/豆包)/`reasoning`(GLM)/`thinking_blocks`(o系) 三选一。· 纯逻辑 · 小
- **工具参数字符串/对象容错 + {raw} 兜底**（`toolArguments.ts`）· 纯逻辑 · 小
- **压缩失败连续 3 次熔断**（`autoCompact.ts:70`）:线上有 session 连炸 3272 次、一天烧 25 万次 API。**对内置 owner key 是保命的。**· 纯逻辑 · 小
- **退出信号看 needsFollowUp、不信 finish_reason**（`query.ts:557`）· 纯逻辑 · 小
- **流卡死空闲超时 `withStreamIdleTimeout`**（`proxy/handler.ts:103`）· 纯逻辑 · 小

### ② 扩展/创造架构（owner 核心愿景）
- **统一原语 PromptCommand**（`types/command.ts:25`）:一个 md+frontmatter = 一个能力，skill/斜杠命令/MCP/子代理同一类型。· 纯逻辑 · 小
- **渐进式披露（清单→正文→文件）**（`SkillTool/prompt.ts`）:只注入"名字+描述"清单（≤1%上下文），调用才展开。**我们 skills.py 已有，TS 原样 carryover。**· 纯逻辑 · 小
- **共享目录加载器**（`markdownConfigLoader.ts`）· 纯逻辑 · 小
- **frontmatter→能力工厂**（`loadSkillsDir.ts:270`）· 纯逻辑 · 中
- **Agent 数据模型**（`AgentTool/loadAgentsDir.ts:542`）:`.md`→{prompt, tools子集, model, skills, memory}。**`billiards_mode` 硬编码的干净替代。**· 纯逻辑 · 中
- **agent 工具子集 `resolveAgentTools`**（`agentToolUtils.ts:124`）:`billiards_registry()` 的通用化版。· 纯逻辑 · 小
- **Plugin/Pack 三件套**（`plugin.json` manifest + 目录约定 + `builtinPlugins.ts` + `enabledPlugins` 开关）:台球从 `if billiards` 变成可挂载包，加行业=复制文件夹。· 纯逻辑/绑Claude · 小
- **🌟 skillify（会话→新技能）**（`skills/bundled/skillify.ts`）:老板做完一套操作一键存成 SKILL.md。护城河。· 绑Claude · 中
- **内置技能捎带参考文件**（`bundledSkills.ts` `files`/baseDir）:台球 57+72 知识 YAML 当技能参考文件，按需 Read。· 纯逻辑 · 小

### ③ 抗失忆栈 + 记忆
- **9 节结构化摘要 prompt**（`services/compact/prompt.ts:61`）:强制输出 用户意图/技术概念/文件代码/错误修复/已解决/所有用户消息/待办/当前工作/下一步。**防失忆的心脏，纯文本翻中文直接喂 MiMo/豆包。**· 纯逻辑 · 小
- **`<analysis>`草稿+`<summary>`正文分离**（`prompt.ts:31`）· 纯逻辑 · 小
- **分级压缩（能不压就不压）**:L1 删老工具结果→L2 删老消息→L3 保留窗口→L4 整段重写。· 纯逻辑 · 中
- **保留窗口算法（最少 10K+5 条带文本消息，上限 40K）**（`sessionMemoryCompact.ts:324`）:直接决定小白感知的"记性"。· 纯逻辑 · 中
- **压缩后自动重读最近 5 个文件**（`compact.ts:1447`）:治"改着报表突然忘了它长啥样"。· 纯逻辑 · 中
- **可压缩工具白名单**（`microCompact.ts:41`）:只清结果可重取的（Read/Bash/Grep/WebFetch），不碰对话文本。· 纯逻辑 · 小
- **超长工具结果落盘+2K 预览回喂**（`toolResultStorage.ts:137`）:一条 `find /` 能塞爆国产小窗口。Read 工具豁免不落盘（防死循环）。· 纯逻辑 · 中
- **记忆相关性 = LLM 选择题（零向量库）**（`findRelevantMemories.ts:77`）:扫记忆 frontmatter 拼清单，小模型做选择题挑 ≤5 个。**装机包不用背向量依赖。⚠️ 与现有 bge-zh 向量 RAG 是真实岔路，见决策点。**· 纯逻辑 · 中
- **记忆索引常驻 + 正文按需拉**（`memdir.ts:199`）· 纯逻辑 · 中
- **记忆老化警告（"47 天前+核对现状再当事实"）**（`memoryAge.ts`）:门店数据会变。· 纯逻辑 · 小

### ④ 改文件 + 回滚（canvas 地基）
- **编辑引擎三件套**:精确字符串替换 + 唯一性强校验（>1处没开 replace_all 就报错）+ 多编辑碰撞检测（`FileEditTool/utils.ts:262`）。· 纯逻辑 · 小
- **fileHistory 工业级备份/回滚**（`fileHistory.ts` 全 1115 行）:内容哈希备份、按对话轮一键回滚、回滚前预览、防大文件 OOM。**我们承诺的"改前备份可回滚"的现成强化版。**· 纯逻辑 · 中
- **读前置强制 + 陈旧检测**（`FileEditTool.ts:275,289`）:没读过不许改；改前比 mtime 防覆盖用户在别处的改动。· 纯逻辑 · 小
- **structuredPatch diff 引擎**（`utils/diff.ts:81`）:用 npm `diff` 库算 hunk，别自己写。· 纯逻辑 · 小
- **改动上下文片段回灌**（`utils.ts:417`）:改完取上下 4 行带行号回灌，省 token 又能自查。· 纯逻辑 · 小
- **🌟 引号归一化匹配 → 改中文全角标点**（`utils.ts:73`）:**字符表换成中文全角（，。""：），国产模型改中文文件的匹配救命稻草。**· 纯逻辑 · 中
- **semanticBoolean 宽松布尔**（`utils/semanticBoolean.ts`）:模型输 `"false"` 字符串正确 coerce。· 纯逻辑 · 小
- **行号前缀+反解析**（`utils/file.ts:290`）· 纯逻辑 · 小

### ⑤ 掌控层（plan/todo/steering/审批）
- **Plan 模式全套**:系统提醒双档（`messages.ts:3324`）+ 唯一可写=plan 文件（权限层真拦 `filesystem.ts:1502`）+ Interview 迭代式 + 强制收尾二选一。· 纯逻辑 · 中
- **ExitPlanMode = 审批工具**（`ExitPlanModeV2Tool.ts`）:`behavior:'ask'` 弹卡片等人点——**复用成我们的审批闸**。· 纯逻辑 · 小
- **Todo 全套**:全量替换 + 恰好一个 in_progress + **content/activeForm 双形态**（"正在跑测试"给用户看=天生为"显示管家正在…"）+ 10 轮没动就重注入。· 纯逻辑 · 小
- **system-reminder 注入范式**:`isMeta:true`（喂模型但对用户隐藏）+ 统一轮次计数节流器 + full/sparse 双档 + "永不向用户提及"。· 纯逻辑 · 小
- **steering（运行中插话）**:进程级队列、**在 tool_result 边界注入**（不然 API 报错）+ 按来源分级 + Esc 中断补合成 tool_result 配对。· 纯逻辑 · 中
- **危险动作分类表**（`yoloClassifier.ts:1397`）:**不可逆本地销毁 / 未授权持久化 / 数据外泄**——审批闸判据。· 纯逻辑 · 小
- **fail-closed（判不了就拦）** + **拒绝追踪（3连拒/20总拒→退回问人）**（`denialTracking.ts`）:最接近"打转自救"。· 纯逻辑 · 小
- ⚠️ CC 没有经典"重复调用检测器"，要更强打转检测得自己加。

### ⑥ 内容管道 / 预览层
- **正文→产物自动提取**（`desktop/src/lib/assistantOutputTargets.ts` + `AssistantOutputTargetCard.tsx` + `InlineImageGallery.tsx`）:模型只在大白话里"提到"海报/报表/图，UI 自动认出→卡片→点开进右面板。**无需工具协议，对国产模型完美。我们很可能缺这半截。**· 纯逻辑 · 中
- **选区/点选→反塞对话**（`WorkspacePanel.tsx` 选区 popover + `previewEvents.ts`/`selectionComposer.ts`）:渲染好的报表/文案里选一段、或海报上点一块→一键带截图+备注塞回对话。"改文案/评点报表/改海报某处"的核心闭环。· 纯逻辑 · 中
- **AskUserQuestion 选项卡 + 每选项挂效果图**（`AskUserQuestionTool.tsx`）:小白可点选项（旁边就是效果图）代替打字——"出 2-3 版一眼挑"。· 纯逻辑 · 中
- **权限应答"改参再放行 + 以后免问"**（`conversationService.ts:471`）· 纯逻辑 · 中
- **选位"截图优先、选择器兜底"**（`selectionComposer.ts`）· 纯逻辑 · 小

---

## 该给产品加的新工具（给用户"创造力"）
> 已有:本地读写改（沙箱+备份）、跑命令、web 查抓、生图、子代理、MCP、技能雏形。下面是**新增**。
1. **ScheduleCron 定时任务**:完全本地不需云，"每天 9 点整理营业数据发我""半小时后提醒"。**性价比第一。**· 必抄 · 中
2. **AskUserQuestion 问答变按钮**:老板打字慢，弹按钮选。**最贴"给不懂技术的人用"。**· 必抄 · 中
3. **Brief（主动消息）+ PushNotification（系统通知）**:后台干活→聊天主动冒一句→Mac 通知栏叫回来。· 必抄/值得 · 中
4. **🌟 WebBrowser 真浏览器操作**:**天花板最高**。美团/大众点评/抖音/小红书后台**没 API 只能真人点网页**——把 AI 从"只会读"升级到"真能替你操作"。底层 Playwright，必须包审批闸。· 值得 · 中大 · **当重点专题**
5. **Todo 任务清单卡**:极简版（一次提交整清单、同时一个 in_progress）。· 必抄 · 小
6. **ToolSearch（工具膨胀后）**:冷门工具 schema 延迟加载，省 MiMo/豆包 token。· 值得（后置）· 中

---

## 体验层（把"管家在干啥"用大白话露出来）
- **离场"你不在时"回顾卡**（`awaySummary.ts`）· 必抄 · 小
- **工具批次摘要用便宜模型异步生成、藏下轮流式里**（`query.ts:1419`）· 值得 · 中
- **SPINNER_VERBS 拟人状态词**→换中文（"在琢磨…/动手了…/查资料中…"）· 值得 · 小
- **prefetch：记忆/技能在模型流式时预取**（`query.ts:304`）· 值得 · 中

## Hooks（"发生X自动做Y" · 后端搬机器、前端只露大白话开关）
- **JSON 裁决协议**（`hooks.ts:492`）:一个格式表达"拦住/改参/塞提示/叫停"——审批闸通用化。· 必抄 · 中
- **PreToolUse 动态拦截/改写** · 必抄 · 中
- **SessionStart 注入 additionalContext**（`hooks.ts:630`）:**"挂台球包时自动追加人设+店脑"最干净落点。**· 必抄 · 中
- **27 事件目录**（选 5-6 个）· 值得 · 小

## MCP（接外部工具 · 模型无关 · 已用官方 SDK）
- **官方 SDK + transport 分派**（`client.ts:592`，留 stdio+http）· 必抄 · 中
- **`.mcp.json` 配置 + Windows `npx→cmd /c` 兜底**:老板复制一段 JSON 就能加工具。· 必抄 · 小
- **`mcp__server__tool` 命名归一**:正好满足 OpenAI function name 约束。· 必抄 · 小
- **inputSchema 原样透传 + annotations→只读/危险**:annotations 驱动审批闸分级。· 必抄 · 中
- **`.mcpb` 一文件装 server**:应用商店式装工具。· 值得 · 中

---

## 我们已领先 / 不用抄
- **artifacts 持久化 + 评分**（cc-haha 没有 artifact 概念）。
- **面向小白的内容预览**（我们更贴受众，外壳不用抄）。
- **审批签名 token + preview**；**SSE 流式**（12 事件已够用，只顺手拿重试倒计时/慢速提示）。

## 跳过（开发者专属 / 绑 Claude / 单机小白用不上）
- 工具:LSPTool、NotebookEdit、REPLTool、Team*、RemoteTrigger/SubscribePR、EnterWorktree（绑git，留内部开发用）、Tungsten/TerminalCapture、CtxInspect/OverflowTest。PowerShellTool 留作 Bash 安全框架的 Windows 分支。
- 机制:prompt-cache 字节对齐、thinking 签名、team memory 云同步、服务端上下文管理 API——绑 Claude/Anthropic 云。
- UI:ink TUI、vim 键位、终端彩色 diff、假终端 chrome。

---

## 两个要 owner 拍板的决策点
1. ✅ **已定（owner 2026-07-06 · 质量优先）：店脑记忆用 LLM 选择器**（cc-haha memdir，"理解意图 > 相似度"、Anthropic 亲选、便宜模型+按需+prefetch 控成本）；**台球运营专家 = 可挂载技能/领域包 + 包内向量定位**（不是纯向量捞碎片）。bge 保留（专家包内定位 + 未来记忆粗筛）。详见主文档 §6.1。
2. **`billiards_mode` → 收成"包"**:泛化成 `enabled_packs`，`compose_agent_system_prompt` 三段拼装改成"遍历 packs 追加人设 + SessionStart hook 注入"，`_build_agent_registry` 改成"遍历 packs 合并工具"。收益:加行业=复制文件夹、能卖领域包、配 skillify 让用户自己加。

⚠️ **红线**:`_SAFETY_REDLINE` 挂在"包"**之外**、永远注入——否则卸台球包会把红线一起卸掉。

---

## 最该抄的总排名（跨全部维度）
1. **国产模型不崩底盘（proxy 层）**——决定"真用不崩"，先做。
2. **扩展/创造架构（技能/Agent/Pack + skillify）**——owner 核心愿景，已走一半。
3. **抗失忆栈 + 记忆双件**——长任务+记性。
4. **改文件+回滚（编辑三件套 + fileHistory + 中文全角引号）**——canvas 地基。
5. **掌控层（Plan/ExitPlanMode=审批 + Todo双形态 + steering + 危险分类表）**。
6. **内容管道（正文认产物→卡片→预览 + 选区→对话 + 选项卡带效果图）**。
7. **新工具（ScheduleCron/AskUserQuestion/Brief+Push/WebBrowser/Todo）**。
