# Codex 浏览器批注 · 「基于此调整」

> 📌 状态:✅现行 · 最后核对 2026-07-11
> 记录 Codex 桌面版右侧「实时浏览器 + 可视化批注 / 设计修改」功能的真实实现。
> 逆向来源:解包本机 `ChatGPT.app`(`.vite/build/comment-preload.js`,332 KB)+ 开源 `openai/codex` 协议。标 ✅ = 真实代码;标 🔶 = 按结构推断。

## 1. 功能

Codex 桌面右侧内置一个实时浏览器(渲染目标网页/应用)。进入批注模式后:

1. 鼠标悬停,页面 DOM 元素被自动结构化框出,弹出该元素的 element-metadata(tag、字体等)。
2. 点某点、或拖框选一块区域,落一个 marker(图钉)并自动截图该区域。
3. 弹出编辑器输入指令(或直接改元素文字/样式当草稿)。
4. 「区域截图 + 输入的话 + 页面 url」打包回传给模型。

## 2. 实证字符串(comment-preload.js)

关键词命中:`comment ×135`、`region ×36`、`rect ×96`、`marker ×64`、`selection ×66`、`pin ×16`、`screenshot ×12`、`element ×265`。

| 字符串 | 说明 |
|---|---|
| `codex-browser-sidebar-comments-root` | 批注挂在浏览器侧栏 |
| `browser-sidebar-runtime-create-comment-at-point` | 点某点建批注 |
| `Selected browser region` / `hover-box region-box` / `posted-region-highlight` | 框选区域 / 悬停高亮框 / 已提交区域高亮 |
| `browser-sidebar-runtime-capture-text-selection` / `browser text selection` | 选中文字批注 |
| `browser-sidebar-runtime-comment-screenshot-ready` / `clear-comment-screenshot` | 区域截图 |
| `marker draft-marker` / `marker saved-marker` / `marker-label` | 图钉标记:草稿态 / 已保存态 / 标签 |
| `element-metadata-cell` `element-metadata-label/tag/value` / `elementMetadata.font` | 悬停元素弹结构化元数据 |
| `browser-sidebar-runtime-open-editor` / `open-comment-preview` / `focus-editor` | 打开编辑器 / 预览 |
| `codex_desktop:browser-sidebar-runtime-message` / `codex_desktop:message-for-view` | 浏览器视图 ↔ 主进程 ↔ agent 的 IPC 通道 |

## 3. 设计修改器(design modifier)

除批注留言外,可直接在渲染界面上改设计当草稿,再由模型落地成代码改动。实证字符串:

| 字符串 | 说明 |
|---|---|
| `browser-sidebar-runtime-open-design-editor` / `open-design-editor-at-point` | 打开设计编辑器(可定位到某点) |
| `browser-sidebar-runtime-design-modifier-state` | 设计修改器状态机 |
| `browser-sidebar-runtime-design-scrub-changed` | 拖动/微调(scrub)改设计 |
| `codex-browser-design-draft-style` | 改的样式当草稿样式贴上预览 |
| `data-codex-browser-design-original-text` | 记住元素原文 |
| `data-codex-browser-design-group` | 设计改动分组 |

两条路径:(a) 打字说需求;(b) 直接改元素文字/样式。两者都打包给模型改代码。

## 4. 回传机制

引擎协议载荷类型(✅ `openai/codex`):

```ts
// codex-rs/app-server-protocol/schema/typescript/v2/AppScreenshot.ts
export type AppScreenshot = { url: string | null, fileId: string | null, userPrompt: string };
```

- `url` —— 批注所在页面。
- `fileId` —— 区域截图上传后的文件 id。
- `userPrompt` —— 输入的指令。

链路:浏览器视图点框输入 → `comment-preload` 截图 + 收集指令 → 经 `codex_desktop:browser-sidebar-runtime-message` IPC 给主进程 → 组成 `AppScreenshot{url,fileId,userPrompt}` → 走 app-server 协议(SQ 提交)塞给引擎 → 引擎把「截图(fileId)+ 指令」作为一轮 `UserTurn` 的多模态输入喂给模型。🔶精确拼接顺序按协议语义 + IPC 通道名推断。

## 5. 归属

- UI + 交互(点框/截图/marker/编辑器/设计草稿)在桌面壳侧:开源 `codex-rs` 无 browser/comment 批注 crate;桌面依赖 `browser-api` / `browser-backend-common` / `browser-common` 撑内置浏览器,`comment-preload.js` 撑批注层。✅
- 回传载荷 + 喂模型在引擎侧:协议提供 `AppScreenshot` 类型 + `realtime-webrtc`,多模态输入(image + text)由 core 循环喂给 Responses API。✅

## 6. 右侧预览板的其它能力

来源:引擎 `codex-rs/app-server-protocol/schema/typescript/v2/`(513 个协议类型)。

**代码 diff**:`TurnDiffUpdatedNotification`(一轮累计 diff)、`FileChangePatchUpdatedNotification` / `FileChangeOutputDeltaNotification` / `FileUpdateChange` / `PatchChangeKind` / `PatchApplyStatus`(文件改动流式更新)、`FileChangeRequestApprovalParams` / `FileChangeApprovalDecision`(改文件前审批)。

**审阅 + 风险审查**:`ReviewStartParams/Response` / `ReviewTarget` / `ReviewDelivery` / `AppReview` / `AutoReviewDecisionSource`(发起代码审阅);`GuardianApprovalReview` / `GuardianRiskLevel` / `GuardianWarningNotification` / `GuardianCommandSource`(风险等级 + 审查告警)。

**实时 App 预览**:`AppScreenshot` / `AppInfo` / `AppMetadata` / `AppSummary` / `AppBranding` / `AppTemplateSummary` / `AppsListParams` / `AppToolApproval`(右侧渲染实时网页/迷你应用,批注/设计修改叠其上)。桌面 `browser-api`/`browser-common` + 引擎 `realtime-webrtc`。

**交互式终端**:`CommandExecOutputDeltaNotification` / `CommandExecOutputStream`(stdout 流式);`CommandExecWriteParams`(写 stdin)/ `CommandExecResizeParams`(resize)/ `CommandExecTerminateParams`(终止)/ `TerminalInteractionNotification`。

**计划/待办**:`TurnPlanStep` / `TurnPlanStepStatus` / `TurnPlanUpdatedNotification` / `PlanDeltaNotification`。

**文件树 + 实时监听**:`FsReadDirectory` / `FsWatchParams` / `FsChangedNotification` / `FsGetMetadata`。

**线程操作**:`ThreadForkParams`(从某轮分叉)/ `ThreadRollbackParams`(回滚到某轮)/ `ThreadResumeParams` / `ThreadInjectItemsParams` / `ThreadArchiveParams` / `ThreadDeleteParams` / `ThreadSetNameParams` / `ThreadGoalSetParams` / `ThreadSearchResult`。

**实时语音**:`ThreadRealtimeStartTransport` / `ThreadRealtimeAudioChunk` / `ThreadRealtimeTranscriptDeltaNotification` / `ThreadRealtimeOutputAudioDeltaNotification` / `ThreadRealtimeSdpNotification`(WebRTC 音频进+转写+音频出)。

**推理流/记忆引用**:`ReasoningSummaryTextDeltaNotification` / `ReasoningTextDeltaNotification` / `ReasoningEffortOption`;`MemoryCitation` / `MemoryCitationEntry`。

**定时任务**:`ScheduledTaskSchedule` / `ScheduledTaskSummary` / `ScheduledTaskWeekday`。

**插件/技能/钩子/MCP**:`PluginList/Install/Share` / `SkillsList` / `HooksList` / `McpServerStatus` / `MarketplaceAdd`。

## 边界

- ✅实证:批注/区域/marker/截图/设计修改器的事件名(`comment-preload.js`)、`AppScreenshot` 协议(开源仓库)、浏览器依赖(桌面 package.json)、右侧板协议类型(app-server-protocol schema)。
- 🔶推断:`AppScreenshot` 与 `comment-preload` 的精确拼接顺序(bundle 是 minified,未逐行还原)。
- 桌面 v26.707.31428(2026-07 本机),会随版本变。
