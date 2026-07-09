# cc-haha 主对话框「展示」逆向（消息区渲染 · 照着开发级）

> **边界铁律（owner 两图定死）**：**主对话框 = 消息内容区**（消息气泡 / 工具卡 / 思考块 / 流式 / 文件读取行号 / diff 结果的呈现）→ **照这个 cc-haha 做**；app 外壳（左栏 / 顶栏 / 输入框外框 / 设置 / 各导航视图 / 弹层 / 加油站积分 / 深浅切换）→ **照 WorkBuddy 做**（见同目录 `WorkBuddy逆向档案/`）。
> **技术栈**：React + Zustand（chatStore）+ Tailwind（CSS 变量主题）。**不是 vanilla。** 依赖需装：`react-diff-viewer-continued`、`prism-react-renderer`（可选 `react-shiki`）、`lucide-react`、`marked`、`DOMPurify`、`diff`、`highlight.js`、Material Symbols Outlined 字体。
> **只抄交互/结构，颜色和文案保持我们自己的。**
> 所有路径根 `/Users/swl/Desktop/cc-haha-ref/desktop/src/`。

---

## 0. 全景数据流（先懂这个，别的都好说）

WebSocket 长连推 `ServerMessage`（`types/chat.ts:76-120`）→ `stores/chatStore.ts` reduce 成每 session 状态 → `components/chat/MessageList.tsx` 把 `messages:UIMessage[]` 编译成 `RenderItem[]` 再渲染。

**UIMessage 判别联合**（`types/chat.ts:268-331`，主对话框能出现的类型）：`user_text`/`assistant_text`/`thinking`/`tool_use`（含 `toolName/toolUseId/input/parentToolUseId/isPending/status/partialInput`）/`tool_result`（含 `toolUseId/content/isError/parentToolUseId`）/`permission_request`/`error`/`system`/`task_summary`/`compact_summary`/`goal_event`/`memory_event`/`background_task`。

**WS 事件流**：`content_start`(text|tool_use) → `content_delta`(text 增量 / toolInput 增量) → `tool_use_complete` → `tool_result`；另有 `thinking`、`status`(state+verb)、`message_complete`(usage)、`api_retry`、`streaming_fallback`。

**ChatState 状态机**（`chatStore.ts:129`）：`'idle'|'thinking'|'compacting'|'tool_executing'|'streaming'|'permission_pending'`——决定显示哪种"正在忙"提示。关键 session 字段：`streamingText`（正在打字的正文，还没落成一条 message）、`streamingToolInput`/每条 tool_use 的 `partialInput`（工具入参流式累积）、`activeThinkingId`（当前正在增长的思考块 id）、`streamingResponseChars`（÷4 估算 token）、`elapsedSeconds`（秒表）、`statusVerb`（服务器动词）、`apiRetry`/`streamingFallback`。

**我们的落地**：后端已对齐 cc-haha，UIMessage/ServerMessage 这套判别联合可直接照抄当前端契约。工具卡渲染只依赖 `toolName/input/result{content,isError}/isPending/partialInput/status`，与后端解耦得很干净。

---

## 1. 编译层：MessageList.buildRenderModel（折叠/分组核心算法·必抄）

`MessageList.tsx:562-665` `buildRenderModel(messages, activeAskUserQuestionToolUseId)` 产出 `{renderItems, toolResultMap, childToolCallsByParent}`：
- **RenderItem 两种**：`{kind:'tool_group', toolCalls[], id}` 或 `{kind:'message', message}`。
- **tool_result 不单独渲染**：先建 `toolResultMap: Map<toolUseId, ToolResult>`；属于已知 tool_use 的 tool_result 直接 `continue` 跳过——**内联到对应工具卡里，不占独立一行**。只有"孤儿"tool_result 才走独立显示。
- **子 agent 的工具挂到父下**：tool_use 带 `parentToolUseId` 时 `appendChildToolCall(childToolCallsByParent, parentId, msg)`，由父 Agent 卡递归渲染。
- **连续工具折成组**：根级 tool_use 累积进 `pendingToolCalls`；遇任何非工具消息就 `flushGroup()`（推成一个 `tool_group`）。**Agent 与非 Agent 不混组**（不一致时先 flush）。
- **AskUserQuestion 特殊**：不进组，做"只保留最后一个未解决的问"的去重。

**这就是"工具卡怎么折叠"的答案**：不是每个工具一张卡，而是「一段连续工具动作」折成一张可展开的组卡，组头显示汇总动词。

## 2. 分发层：MessageBlock（按类型渲染，`MessageList.tsx:2108-2259`）
`switch(message.type)`：user_text→`<UserMessage>`；assistant_text→`<AssistantMessage>`；thinking→`<ThinkingBlock isActive={id===activeThinkingId}>`；tool_use→（AskUserQuestion 特判否则）`<ToolCallBlock>`（孤儿单工具）；tool_result(孤儿)→`<ToolResultBlock standalone>`；error→红底圆角框；system→居中灰字；task_summary→`<InlineTaskSummary>`。
**主渲染 JSX**（`2006-2068`）：外层 `overflow-y-auto` 滚动容器，内层 `mx-auto max-w-[860px]`（对话最大宽 860px 居中）。末尾追加：流式 assistant 气泡、压缩分割线、StreamingIndicator。右下角"跳到最新"浮钮。列表用了虚拟化（长会话才启用），**初版可不做虚拟化，直接 map**。

---

## 3. 三种气泡/块

### 3.1 用户气泡 `UserMessage.tsx`
- `flex justify-end`（靠右），气泡 `max-w-[82%] sm:78% lg:72%`。
- 气泡 `bg-[var(--color-surface-user-msg)]`、**无边框**、`px-4 py-3 text-sm`、`whitespace-pre-wrap break-words`（纯文本保留换行，**不走 markdown**）。
- **圆角不对称** `borderRadius:'18px 4px 18px 18px'`（右上角切 4px，"从右上冒出"方向感）。
- 上方可选 `<AttachmentGallery variant="message">`；hover 才出 `<MessageActionBar align="end">`（复制/分支/时间戳）。

### 3.2 AI 气泡 `AssistantMessage.tsx`
- `flex justify-start`（靠左）。
- **两种版式**（`shouldUseDocumentLayout`）：含代码块/标题/列表/表格，或 ≥2 段落/≥8 行 → `document` 版式（`w-full max-w-full` 铺满 860px）；否则 `bubble` 版式（`max-w-[88%] sm:80% lg:72%`）。**聪明设计**：短回复走窄气泡像聊天，长文档铺满像文章。
- 气泡 `rounded-[20px] rounded-tl-[8px]`（左上角切 8px，与用户气泡镜像）、`border border-[var(--color-border)]/60 bg-[var(--color-surface)]`、`px-4 py-3 text-sm shadow-sm`。
- 内容走 `<MarkdownRenderer variant={document|default} streaming>`（§9）+ 内联 InlineImageGallery/InlineVideoGallery（非流式时才出）。
- **流式结尾闪烁光标**：`<span class="animate-shimmer h-4 w-0.5 bg-[var(--color-brand)]">`；流式期间不渲染画廊、不抽取产物卡。
- 下方 `outputTargets`：非流式时从正文抽"产物文件"渲染成 `AssistantOutputTargetCard`（最多3个）。**可后置。**

### 3.3 思考块 `ThinkingBlock.tsx`（88 行，含内联 `<style>` keyframes 可直接搬）
- 一行折叠按钮：三角 `▸/▾`（字符非图标）+ 斜体 label；label = isActive"Thinking"（我们中文"思考中"）/ 完成"Thought"（"已思考"）。isActive 时 label 后接 `.thinking-dots`（`::after` 动画循环 `. .. ...` 1.4s）。
- **默认折叠**。展开体 `max-h-[300px] overflow-y-auto`、`border/40`、`bg-surface-container-lowest`、`text-[11px]`，走 `MarkdownRenderer variant="compact" streaming={isActive}`。
- **流式自动滚到底**（`expanded && isActive` 时 `scrollTop=scrollHeight`）+ 末尾闪烁竖条 `.thinking-cursor`（2px 宽，1s step-end 闪）。
- `isActive` 由 MessageList 的 `activeThinkingId` 决定；清空后从"Thinking"变"Thought"、光标消失。

---

## 4. 流式打字（三条独立通道 + 忙碌指示器，别只做一个）

**(A) 正文流 — AssistantMessage**：`MessageList.tsx:2044` `{streamingText.trim() && <AssistantMessage content={streamingText} isStreaming={chatState==='streaming'} />}`。isStreaming 时末尾闪烁竖条光标。
**(B) delta 节流（关键性能点，必抄）**（`chatStore.ts:386-445,1743-1804`）：content_delta 不是来一个字设一次 state。用 per-session buffer + **50ms** `setTimeout` flush：50ms 内 delta 攒一起一次性 `streamingText += text`。工具入参 delta 同款独立 buffer + 50ms flush。**这是"打字机"手感来源**——不是逐字，是 50ms 一批，既顺滑又不每字符重渲染整棵树。**必抄，否则长回复卡。**
**(C) 工具入参流 — Write 边写边显示**（见 §6 partialInput）。
**(D) 忙碌指示器 StreamingIndicator** `components/chat/StreamingIndicator.tsx`：
- 挂载条件（`MessageList.tsx:2056`）：`chatState==='tool_executing' || (chatState==='thinking' && !activeThinkingId)`（工具执行中，或刚发消息还没等到第一个思考 delta 的空窗）。
- 常态：胶囊 `rounded-full border/40 bg-surface-container-low px-3 py-1`，内含 `✦`（brand 色 `animate-shimmer`）+ 动词"{verb}..."（statusVerb 或按 state 兜底：thinking→Thinking / compacting→Compacting / tool_executing→Running / 否则 Working）+ 秒表（`<60s`→`Ns`，否则 `Xm Ys`）+ `· ↓ {tokens}`（`streamingResponseChars/4`，>0 时）。
- **api_retry 横幅**：琥珀色警示，`RefreshCw` 旋转 + "重试第 X/Y 次" + HTTP 状态徽章 + 倒计时（1s tick 递减）。
- **streaming_fallback**：中性轻提示（非流式降级）。

---

## 5. 审批卡 PermissionDialog（"改文件前先弹审批"核心，`components/chat/PermissionDialog.tsx`）

主对话框里内联渲染（`MessageList.tsx:2201`，`case 'permission_request'`）。**三段：Header / 详情 / 动作按钮。两态：pending（亮）vs responded（置灰 opacity-70）。**
- **isPending 判定**：`pendingPermission?.requestId===requestId`（同 requestId 才亮，历史审批卡置灰只读）。
- **Header**：左圆角色块图标（按工具类型取色：Bash=terminal/warning、Edit=edit_note/brand、Write=edit_document/success…）。标题 `getPermissionTitle`：Edit/Write→"Allow Claude to {toolName} {fileName}?"（**白标把 Claude 换掉**），Bash→"Allow Claude to run this command?"。右侧状态徽章：pending 琥珀"Awaiting approval"+闪点 `animate-pulse-dot`；responded 灰"Responded"。
- **详情区**：有预览时（Edit/Write/Bash）先显示文件路径 chip（`folder_open`+mono 路径），再显示预览：**Edit → `<DiffViewer oldString newString>`；Write → `<DiffViewer oldString="" newString={content}>`（全绿新增）；Bash → 终端风格 `pre` `$ 命令`**。**这就是"改文件必须可见"：审批阶段就把 diff 摆出来。** 无预览工具显示 `details.primary` + "Show full input"折叠原始 JSON。
- **动作按钮**（仅 pending）：`Allow`（primary check）/ `Allow for session`（ghost verified，`{rule:'always'}`）/ 弹簧 / `Deny`（danger close）。点击 `respondToPermission(sessionId, requestId, allowed, opts?)`。
- **ExitPlanMode 特例**：标题"Ready to code?"，body `PlanPreviewCard`（计划 markdown + 请求的权限），反馈 textarea + `Approve plan` / `Keep planning`（deny + textarea 作 denyMessage）。
- **协议**：Server `permission_request {requestId, toolName, toolUseId?, input, description?}`；Client `permission_response {requestId, allowed, rule?, updatedInput?, denyMessage?, permissionUpdates?}`（permissionUpdates 支持 addRules/setMode/addDirectories）。响应后 `pendingPermission=null`、`chatState = allowed ? 'tool_executing' : 'idle'`。

---

## 6. 工具卡 —— 折叠头 + 展开体（最该抄的核心）

### 6.1 单个工具卡 `ToolCallBlock.tsx`（835 行）
一张卡 = **一行折叠头 + 可选展开体**。外壳 `overflow-hidden rounded-lg border/50 bg-[var(--color-surface-container-lowest)]`。
**折叠头**（button，从左到右）：
1. **工具图标**（material-symbols，`TOOL_ICONS`）：Bash→terminal、Read→description、Write→edit_document、Edit→edit_note、Glob→search、Grep→find_in_page、Agent→smart_toy、WebSearch→travel_explore、WebFetch→cloud_download、Skill→auto_awesome，兜底 build。
2. **工具名**（11px 粗）。
3. **主摘要**：有 file_path 显示文件名（`filePath.split('/').pop()`）；否则 `getToolSummary`——Bash 显示命令、Read"Read file contents"、Glob/Grep 显示 pattern、Edit"N lines changed"、Write"N lines created"。
4. **右侧状态区**（互斥优先级）：pending→`LoaderCircle` 转圈 + "Preparing edit/Generating content" + 实时字数（liveStats 边流边数行/字）；stopped→`CircleStop`+"Stopped"；有结果→`getToolResultSummary`（错误显示首行截72字；非Bash显示"N lines output"；**Bash 结果摘要返回空串**）；出错额外红 `error` 图标。
5. **展开箭头**（expandable 才显 `expand_more/less`）。
**expandable 判定**：`hasEditPreview || hasWritePreview || hasResultDetails || (isPending && partialInput)`。**默认折叠**（只 ExitPlanMode 默认展开）。
**展开体 = renderPreview + renderDetails**：
- **Edit** → `<DiffViewer filePath oldString newString>` + 结果输出。
- **Write** → `<DiffViewer oldString="" newString={content}>`（全增行 diff）+ 结果输出。
- **Bash** → `<TerminalChrome>` 里 `$ {command}` + 结果输出。
- **Read** → 只返回结果输出。
- `renderResultOutput`：带头部（"Tool Output"/"Error Output" + CopyButton）；错误红字 `<pre>`，正常 `<CodeViewer language="plaintext" maxLines={18}>`。
- **流式 Write** → `renderWriterPreview`：从 `partialInput` 增量解析 `content` 字段（手写 partial-JSON 解析器 `extractPartialJsonStringField`），只显示**最新 120 行 / 30000 字符**（`WRITER_PREVIEW_MAX_LINES/CHARS`），头部"Showing latest X of Y lines"。防止边写边刷爆。
- **流式其它** → `renderPartialInput`（半截 JSON 尽量格式化用 CodeViewer 显示）——**"边流边显示工具入参"的关键**。

**⚠️ 重要现实（照抄前必看，见 §12）**：`getVisibleResultText` 对 **Bash/Read/Edit/Write 非错误时 return null**——即 cc-haha 主对话框**故意隐藏 Bash 的 stdout 和 Read 的文件正文**（只给一句"N lines output"摘要或文件名，正文只在出错时显示）。这是它"保持对话整洁"的取舍。

### 6.2 工具卡分组 `ToolCallGroup.tsx`（1089 行）
主对话框不是一条工具一张卡平铺，而是**先编组再折叠**（§1 buildRenderModel）。四种渲染：
1. **单条**（length===1）→ 直接 `ToolCallTree`（不套组壳）。
2. **多条 ToolCallGroupMulti** → 可折叠组头：折叠时显示汇总动词（`generateSummary`+`TOOL_VERBS`，如"Read 3 files, ran 2 commands, edited a file"）+ 状态图标（成功 check/错误 error/运行中 brand 闪点）。**运行中或有嵌套子调用时自动展开**，跑完可收起。
3. **Agent 组 AgentToolGroup** → 竖直时间线（左侧竖线 + 圆点节点），每个 `AgentCallCard`（图标+description+"View result"弹 Modal+状态徽标；状态 starting/running/done/failed/stopped）。子调用嵌套缩进 + 左竖线递归。
4. **Memory 活动组** → 读写 `/memory/*.md` 的特殊卡。

### 6.3 独立工具结果 `ToolResultBlock.tsx`
只在 tool_result 没被 ToolCallBlock 内联收纳时（standalone）才独立显示：折叠头 error/check_circle + "{tool} result" + SUCCESS/ERROR 徽章；折叠显示前 200 字符预览，展开全文（错误红 mono pre，正常 CodeViewer plaintext）。

---

## 7. Diff 呈现 `DiffViewer.tsx`（159 行）

- 依赖 `react-diff-viewer-continued`：**单栏**（`splitView={false}`）+ **词级对比**（`DiffMethod.WORDS`）+ **显示行号**（`hideLineNumbers={false}`）+ `useDarkTheme` 跟随 `uiStore.theme`。语法高亮用 `prism-react-renderer`（`renderContent` 回调，主题 `warmSyntaxTheme` 全 CSS 变量 `--color-code-*`），语言由扩展名推断 `inferLanguage`。
- **头部**：文件路径（mono 截断）+ `+N`（绿药丸）`-N`（红药丸）增删统计（按行 diff 数出来）+ Copy path。
- **diff 体**：`max-h-[400px] overflow-auto`，**行号槽默认开**——**这是主对话框里唯一稳定出现的"带行号"呈现**（Edit/Write 的变更）。配色走 `--color-diff-*`。
- 复用于三处：ToolCallBlock 的 Edit/Write 展开预览、PermissionDialog 的审批预览、右侧工作区 diff tab。
- **落地**：装 `react-diff-viewer-continued` + `prism-react-renderer` 直接抄，配色换我们变量。

---

## 8. 命令终端外壳 `TerminalChrome.tsx`（35 行，极简直接抄）
macOS 风终端窗：`rounded-2xl`，标题栏三个红黄绿"红绿灯"圆点（`--color-terminal-danger/warning/accent`）+ 标题（mono 小字）。内容区 `bg-[var(--color-terminal-bg)]`（深色 #1E1E1E）。Bash 卡里包一行 `$ command`（`$` 用绿色 accent）。

## 9. 代码/行号查看器 `CodeViewer.tsx`（329 行）
- **双引擎**：优先动态 import `react-shiki`（能力探测，老 Safari 降级），加载前/失败用 `prism-react-renderer` 兜底。**务实简化：我们可只用 prism 单引擎**，砍掉整个 shiki 懒加载逻辑（~190 行）。
- 头部：语言标签 + 行数"N lines" + Copy。代码区 `max-h-[420px] overflow-auto bg-[var(--color-code-bg)]`，`font-mono 12px lineHeight 1.3`。
- **行号**：`showLineNumbers` 时每行左侧序号 span；`effectiveShowLineNumbers = showLineNumbers && language && language!=='text'`（**纯文本不显示行号**）。
- **截断/展开**：超 `maxLines`（默认20）折叠，底部"Show N more lines"/"Collapse"。
- **谁开了行号**（grep 全仓）：只有 **Trace/调试详情面板**（TraceDetail/LlmCallDetail/ToolDetail/MessageDetail，`language="json" showLineNumbers`）和 SkillDetail。**主对话框的工具结果一律 `language="plaintext"` 不带行号**；MarkdownRenderer 里的代码块也不带行号。→ 见 §12 的取舍澄清。

## 10. Markdown 渲染 `markdown/MarkdownRenderer.tsx`（569 行）
- 引擎 `marked`（gfm+breaks）→ 自定义 renderer 把 ```代码块``` 抽成占位 `<div data-codeblock-id>`，正文其余 `DOMPurify.sanitize` 后 `dangerouslySetInnerHTML`，代码块位置插入真正的 `<CodeViewer>`（**代码块不走 innerHTML 而是 React 组件**，才有高亮/复制/折叠）。
- **数学公式**：`extractMath` 抠 `$...$`/`$$...$$`/`\(\)`/`\[\]` 交 katex（避开代码围栏内 `$`）。**用不上可砍。**
- **Mermaid**：mermaid 语言或像流程图 → `<MermaidRenderer>`，流式先占位。**可后置/砍。**
- **三种版式** `variant`：default / document（大字距、h2 带下划线，长回复）/ compact（小字，thinking 和 agent 结果）。对应三套 tailwind `prose-*` 类可直接拷。
- **性能**：解析结果按内容哈希缓存（finalized/streaming 两个 LRU）；流式与终态分开缓存。表格自动包 `overflow-x-auto`、外链强制 `target=_blank`。行内 `code` `bg-[var(--color-code-bg)] border px-1.5 py-0.5 rounded-md`。
- **落地**：marked + DOMPurify + prism 主链必抄（AI 回复几乎都是 markdown）。katex/mermaid 按需。

## 11. 其它内联卡（次要）
- `MessageActionBar.tsx`：hover 才浮现（`opacity-0 group-hover:opacity-100`），复制 + 分支（GitFork，从这条 branch 出新会话）+ 相对时间戳。
- `InlineTaskSummary.tsx`：TODO 清单卡，头部"已完成 done/total"，每项 material 图标（空圈/进行中/绿勾）+ `#id` + 标题（完成的划删除线）。
- 中间居中卡/分割线：`CompactStatusDivider`（压缩）、`GoalEventCard/GoalContinuationDivider`（目标）、`MemoryEventCard`（记忆保存）、`BackgroundTaskEventCard`（后台任务）。**可后置的高级能力。**

## 12. ★配色变量（结构照抄、值换我们的）
`theme/globals.css` 分组：
- **气泡**：`--color-surface`（AI 气泡底）、`--color-surface-user-msg`（用户气泡底）、`--color-border`、`--color-text-primary/secondary/tertiary`、`--color-brand`（=primary，流式光标/闪点/思考）。
- **代码**：`--color-code-bg/fg/comment/string/keyword/function/number/property/type/parameter/punctuation/inserted/deleted`（一整套语法色）。
- **diff**：`--color-diff-added-bg/word/gutter/text`、`-removed-*`、`-highlight-*`、`-title-*`。
- **终端**：`--color-terminal-header/bg/border/fg/muted/accent/danger/warning`（深色固定值）。
- **记忆/目标**：`--color-memory-accent/surface/border`（绿松石）。
- 字体 `--font-mono: 'JetBrains Mono'`。
- 图标：**material-symbols-outlined**（工具/箭头/状态）+ **lucide-react**（LoaderCircle/CircleStop/ChevronDown 等）混用，需引入两套。
- **动画 keyframes**（`globals.css:1364`，直接搬）：`shimmer`（1.5s ease-in-out）、`pulse-dot`（1.5s）、`spin`（1s linear）；`.animate-shimmer`/`.animate-pulse-dot`/`.animate-spin`。思考块 `thinking-cursor-blink`（1s step-end）+ `thinking-dots`（1.4s）在 ThinkingBlock 内联。

**关键阈值**（照填）：delta flush **50ms**；思考框 max-h300；diff max-h400；CodeViewer max-h420/maxLines20；Writer 预览 last120行/30000字；改动卡折叠 >5 files；ToolResult 预览 200 字符；token 估算 chars/4。

---

## 13. ★★「必抄 vs 可简化 vs 要向 owner 澄清」清单

**必抄（cc 观感灵魂 = 必做）**：
- buildRenderModel 折叠算法（连续工具成组、result 内联工具卡、子调用挂父）。
- 用户/AI 气泡镜像圆角 + AI 双版式（bubble/document 自动切）。
- 50ms delta 节流（打字机手感）。
- ToolCallBlock 折叠头信息密度（图标+名+摘要+右状态+箭头）+ 默认折叠 + 展开看 diff/结果。
- ThinkingBlock 折叠（Thinking↔Thought + 流式光标 + 自动滚底）。
- StreamingIndicator 胶囊（动词+秒表+token）+ api_retry 横幅。
- **PermissionDialog 三态三按钮 + Edit/Write 内联 DiffViewer**（改文件审批阶段就摆 diff）。
- DiffViewer（单栏词级 + 加减徽章 + 行号槽）——Edit/Write 展开主体。
- CodeViewer（Prism 单引擎即可）+ TerminalChrome。
- MarkdownRenderer（marked + DOMPurify + CodeViewer 主链）。

**可务实简化/后置/砍**：
- CodeViewer 的 shiki 懒加载双引擎 → 只留 Prism。
- Write 边写边预览的 partial-JSON 增量解析 → 先只在 tool_use_complete 后显示完整 diff。
- 子 Agent 全套（AgentToolGroup/AgentCallCard/ToolCallTree 子分支/agent 结果解析器）——无子 agent 能力就砍。
- 记忆/目标/后台任务/压缩 事件卡（无对应后端就砍）。
- Plan 模式特化卡、AskUserQuestion 去重、AssistantOutputTargetCard 产物卡、划词加入对话、katex/mermaid、虚拟化列表、消息分支(branch)、CurrentTurnChangeCard 回合改动卡。

**★要向 owner 澄清的取舍（重要）**：cc-haha 主对话框**故意隐藏 Bash stdout 和 Read 文件正文**（只给"N lines output"摘要，正文只在出错时显示），真正"带行号读文件"的完整呈现它**并没有做在对话流里**（行号只在 Edit/Write 的 diff 槽 + Trace 调试面板出现）。owner 任务写的"命令/输出展示、文件读取带行号"若要比 cc 更完整地展示，需要我们**主动加**（比如把 Bash 结果也塞进 renderResultOutput、Read 结果用 CodeViewer 带行号显示）——这是**超出 cc-haha 现状的产品决策，建议先确认要不要做**。

---

## 盲区（诚实标注）
1. 只读了前端渲染层，没读 chatStore/sessionRuntimeStore 如何从 WebSocket 事件累积 streamingText/activeThinkingId/构造 UIMessage（状态管理切片，不在本切片范围，但事件层已交叉确认）。
2. 没实际跑起来截图验证观感，padding/圆角/配色从 className 抠出，像素级需真机验证。
3. 第三方库确切版本没查 package.json（发现于 import，能装但版本需核）。
4. Bash/Read 结果隐藏基于 `getVisibleResultText` 静态逻辑，是否有别路径（后端把 Read 结果转成别的消息类型）绕过它没全链路追。
5. 虚拟滚动/自动跟随滚动那套（MessageList ~600 行中段）只读了阈值与入口，没读完全部滚动补偿逻辑——要 1:1 复刻滚动手感需另开一轮。
6. docs/ui-clone/ 下设计文档没读（优先扒真代码）。
