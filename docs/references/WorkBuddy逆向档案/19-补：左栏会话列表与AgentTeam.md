# 19-补：左栏会话列表 结构 与 Agent Team

> **第二轮穷尽补齐**（2026-07-10）。归属：**App 外壳 = WorkBuddy** 侧（左导航栏会话列表）。
> **可信度**：这个构建**没混淆变量名 + 保留 JSX + 保留中文注释**，几乎能当源码读，可信度极高。
> CSS 注释原话：`conversation-list 样式（v0.2 重构）设计参照：ardot 设计稿 1178:1「终端=Mac」左侧 sidebar；全部使用 --wb-* token`。
> **务实取舍**：见第 15 节。

取证：`connector-CvFT3fv6.js`（左栏主逻辑）、`src-B23Qt8vp.js`（新/经典侧栏切换）、`index-BneTCe4u.js`（会话上限弹窗）、`connector-C7gGcGMD.css`、`zh-cn-DvYPcElp.js`。

---

## 0. 关键结论（纠正第一版档案的误判）
1. **owner 列的 5 个分区，桌面本地版实际只有 3 个**：`置顶任务` → `任务` → `空间`。"工作空间""助理任务"是云/网页版分区，桌面 local 不渲染。
2. **"试用新侧栏/经典侧栏"切换的是"右侧制品面板"（SidebarNext/DetailPanel），不是左栏**——但机制值得抄（见 §2）。
3. **Agent Team 侧栏子会话树（`conversation-team-tree`/团队卡片）在发货 JS 里查不到渲染代码**（CSS+i18n 完整但组件疑 feature-flag 关闭）。**真正发货、用户能看到的 Agent Team UI 是"聊天区顶部的成员横条 team-member-bar"**（见 §9）。

---

## 1. 左栏整体骨架（`.conversation-list`，展开 264 / 收起 48）
宽度是 JS 内联 `style={{width:`${width}px`}}`。自上而下：
```
.conversation-list  (bg --wb-sidebar-bg; flex column; transition width .25s)
├ .conversation-list-topbar  高40 pad 0 12 靠右 -webkit-app-region:drag  (mac: padding-left:80px 让位红绿灯)
│  └ actions(gap4): 收起侧栏 SidebarCollapseIcon(32×32) + 搜索(32×32) + 筛选触发(仅 local，右上角 hasFilter 时 6px 红点)
├ .conversation-list-header  pad 0 12 16 12
│  ├ logo-row(高20): a.logo(暗/亮两张) + version-badge「v{productVersion}」  点 logo=新建任务
│  └ tabs(role=tablist gap2)  ← 导航图标区,用 style{order:N} 动态排序【详见 04-08】
├ .conversation-list-content  flex1 overflow-y auto pad 0 12  6px 悬浮滚动条
│  └ PinnedSection / 任务 section / 空间 section / loadingMore
└ .conversation-list-footer  pad 12 16 12 12  → UserMenu(宽100%)
```
**收起态（48px）**：top(40)常显 logo(18×18) hover 变展开图标；header-collapsed=新建任务图标(Tooltip 右侧"新建任务")+`TaskListPopover`（收起态 hover 悬浮完整任务列表，§10b）；图标按钮 32×32 radius8 active `--wb-bg-active`；footer 竖排。

## 2. 「试用新侧栏/回到经典侧栏」切换机制（切的是右侧面板）
- 存储 `localStorage["agent-sidebar-mode"]` ∈ `legacy|next`，**默认 `next`**。优先级 `?sidebarMode=` > storage > `window.PRODUCT_FEATURES.SidebarModeDefault` > `next`。
- `setSidebarMode(mode)`：写 localStorage + `dispatchEvent("agent-sidebar-mode-change",{detail:mode})`（同 tab storage 事件不触发，故用自定义事件）。
- `SidebarModeToggle`：`<Button size=small variant=outline>`，label `sidebar.mode.toggleToNext`="试用新侧栏"/`toggleToLegacy`="回到经典侧栏"。
- **务实建议**：我们左右各只做一套，这个 toggle **可整块砍**。

## 3. 筛选面板 `TaskFilterMenu`（状态·时间 多选）
Popover `.task-filter-popover`（宽240 radius16 pad8 白底阴影）→ `.task-filter-menu`（flex column gap8）两段 section + 分隔线 + 重置：
**状态段**（`filter.status`"筛选状态"，单选存数组 `sessionStatus:[]`）：null 全部状态 / working 进行中 / completed 已完成 / failed 失败 / pending 待处理 / planning 规划中。
**时间段**（`filter.date`"筛选时间"，单值 date）：null 全部时间 / Today 今天 / Last 7 days 最近 7 天 / Last 30 days 最近 30 天。（i18n 有 yesterday/customRange 但 `dateOptions` 没用，只 4 档。）
行为：`handleStatusSelect(null)`=清空；点已选=取消；点未选=覆盖（等效单选）。选中项右侧 CheckIcon（`--selected` 显示+加粗+bg）。底部分隔线 + `重置筛选条件`（`filter.clearAll`，无筛选时 `--disabled` opacity.4）。筛选生效时 topbar 按钮亮 6px 红点。空结果分区内显"没有匹配的任务"（`conversation.section.noFilterResult`）。每 option `height:32 pad3 8 radius8 font14/22`。

## 4. `SectionHeader`（分区标题，本地模式用）
`.conversation-section-label`（onClick=onToggle；pad4 12 radius8 hover bg）：`-text`「{标题}(N)」12px/600 色 `--wb-todo-menu-text-heading` + 折叠三角（展开 rotate0/收起 rotate-90）+ 可选"折叠所有/展开所有工作空间"按钮（仅 groups 段，平时 opacity0 hover 现）+ 可选"每区新建"按钮（tasks→"新建任务"NewTaskIconV2 / workspace→"新建工作空间"FolderAddIcon，平时 opacity0 hover 现）。**本地模式渲染 SectionHeader 没传 onAdd**（任务/空间段头部无 + 按钮，onAdd 是组件能力但本地视图未接线，**我们可直接在段头挂 + 号**）。

## 5. 分区结构（`LocalSectionView`，桌面本地真实顺序）
**`PinnedSection` → `任务` section → `空间` section → loadingMore**。数据来自 `useTaskGrouping` 的 `taskBlocks`（kind ∈ independent|expert|project|workspace|cloudAssistant）。
- **置顶任务**「置顶任务(N)」（§8）。
- **任务 section**：「任务(totalCount)」内容=independentBlocks 逐个 AgentCard + ShowMoreButton。空+筛选→"没有匹配的任务"。
- **空间 section**：**「空间(groupBlocks.length)」**（标签字面"空间"不是"工作空间"！）。头部带"折叠/展开所有工作空间"。内容=各分组 `CollapsibleSection`（§6）。
- 每段/组超 **5 条**（`SHOW_MORE_THRESHOLD=5`）折叠，ShowMoreButton："查看更多(N)"/"收起"。
- 展开/折叠+showAll+每组折叠 全部持久化 `localStorage["wb:conversation-list:expanded-state"]`（按账号 `:u:{uid}` 隔离），默认全展开。

## 6. 分组卡（`CollapsibleSection`，空间段内）
每种 kind 一个可折叠分组，图标+标题+悬浮的更多菜单+新建任务按钮。折叠态存 `groupCollapsedMap[groupKey]`。子项 AgentCard 传 `isGroupChild:true` 缩进 36px。
- expert 专家组：专家头像/ExpertIconV2，tooltip=职业。
- project 项目组：ProjectFilledIconV2，标题可内联改名，customButton=WorkspaceMoreMenu(rename/delete/leave 按 role)+新建任务。删除/离开走确认 Modal。
- workspace 工作目录组：WbFolderIcon，title=displayName tooltip=cwd，更多菜单=`打开文件夹`+`从列表中移除`（→ adapter.deleteSession）；新建任务先 `checkFolderExists(cwd)` 校验（§12）。
- cloudAssistant 云助理组：助理头像/ClawIconV2，子项 `isCloudAssistantChild`。
`跳转联动`：`jumpToConversationId` 变化自动展开对应分区并滚进视野。

## 7. 会话卡 `AgentCard`（cardProps 已拿全）
外层 `ConversationCardWithTeamMembers`（data-conversation-id；本地模式无团队快照会 `ensureTeamRuntime(conv.id)` 重试≤3 次）。className `conversation-agent-card` + `--standalone/--group-child/...`。
**cardProps**：`title`；`titleTag`=来源 chip（workbuddy-mp→绿"小程序"/workbuddy-app→蓝"App"）；`time`=`formatRelativeTime`（刚刚/{n}分钟前/小时前/天前/年前）；状态 `status`（有活跃成员/未 idle→强制 working）、`statusText=taskStatus.{status}.label`、`tag=getStatusTag`（只 pending 返回"待确认"）；`selected`；`editable`（双击内联改名，乐观更新+失败回滚）；悬浮操作按钮（16×16 hover 现）：置顶/取消置顶（tooltip"置顶"/"取消置顶"，子会话不可置顶）、归档（仅 completed/failed/terminated 可，否则 disabled reason"任务进行中，无法归档"）、更多菜单 contextMenuItems（每动作前 `await checkFolderExists`）。`compact:true`。
**状态标签全表**：planning 规划中/working 执行中/pending 等待输入(tag 待确认)/completed 已完成/terminated 异常中断/failed|error 执行失败/archived 已归档（各带 description 做 tooltip）。
**卡片视觉**：`.conversation-agent-card` radius8 pad4 12 hover bg `--wb-todo-menu-bg-hover` selected `--wb-todo-menu-bg-active`；title 13/22 常态400 hover/selected 600；time 12/20；未读点 6px `--wb-accent-unread`；状态图标 16×16（completed=6px 实心点、error=红感叹号、working=转圈）；状态 tag 高20 radius6 黑底白字 11px 带小圆点，hover 让位给 time。

## 8. 置顶区 `PinnedSection`（可拖拽排序）
`pinnedConversations.length===0` 时整段不渲染。「置顶任务(N)」列表 `.conversation-pinned-list`，每项 cursor:grab（`usePinnedDrag` 指针事件重排→`onReorderPinned`，拖拽态 class）。>5 显 ShowMore。置顶项来自工作区时带 `originalSection="workspaces"`+workspaceName。置顶图标 swap（默认/hover 两态）。

## 9. Agent Team（成员横条=发货态；侧栏树/团队卡片=未发货态）
**9a. 已发货 · 聊天区顶部「团队成员横条」`team-member-bar`（真实可见）**
`hasTeam && members.length>0` 才显。横向可滚（隐藏滚动条+左右渐隐遮罩）。主理人槽 `leaderName = leaderInfo?.name||"主会话"`，`leaderSelected = !viewingMemberId`。每成员：头像+状态图标（spinner 转圈/`--completed`√色 #4caf50/`--failed`×bg #f44336）。**收起态**：叠头像(20px 圆-6px 重叠)+chevron 点开展开。点成员→`viewingMemberId=member`→主会话切到看该成员子会话。**返回主会话**：看成员子会话时输入框上浮 `.team-member-return-main-button`"↩ 返回主会话继续对话"，点击 `setViewingMemberId(null)`（pad8 20 1px 边 radius20 13/500）。
**9b. 未发货（CSS+i18n 齐全，JS 0 渲染）· 侧栏 Agent Team 子会话树 + 团队卡片**
`conversation-team-tree`（grid 0fr↔1fr 展开动画 240ms）挂在会话卡下；`.conversation-team-member`（min-h38 pad6 5）：序号+title+状态标签（completed 灰/failed 红/`-pending-permission`⚠"待授权"tooltip"{count}个工具待授权"）+运行中转圈。团队卡片 i18n：`团队卡片`/`专家团`/`成员`/`{count}人`/`Agent Team`。**大厂自己都没发货，建议不做**（最多会话卡下平铺子任务）。

## 10. 历史提问 + 收起态任务弹层
**10a. 历史提问 `workbuddy-prompt-list`（聊天顶栏，非左栏）**：ghost 图标 Tooltip"历史提问"。点击浮层（fixed bottom）：header"历史提问(N)"+truncated 时 notice"会话记录较长，仅展示最近 {count} 条…"；body 列所有 user prompt（单行省略）点击 `onJumpToMessage`。宽284 max-h260 radius12 z10000。
**10b. 收起态任务弹层 `TaskListPopover`（左栏 48px 态）**：hover"任务列表"浮层（Portal fixed `left=rect.right+8`）。分组：任务 group 平铺 + 工作空间 group（可折叠子组）。ConversationItem：状态图标+标题+未读红点(8px #EF4444)。min240 max320 max-h400 暗底 #1F1F1F。

## 11. 会话数达上限弹窗（云端限制）
新建时 `ClientError.code===10105` → `LazyConfirmDialog`（单按钮）：title"会话数量已达上限" content"您已达到最大会话数量限制，请先归档或删除一些会话后再创建新会话。" 按钮"知道了"。**纯本地免登录版通常无此限制，可不做。** 另有"正在创建会话，请稍后再试"。

## 12. 工作目录已删提示（`checkFolderExists`）
`checkFolderExists(path,toastMessage)`：非绝对路径→true；非 local 或无 `adapter.checkPathExists`→true；`checkPathExists===false`→toast warning + return false。会话动作前调用，目录不在弹 warning 中止。文案 `conversation.cwdNotExist`="该对话的工作目录可能已被重命名或删除"。

## 13. 常量/持久化/埋点
`SHOW_MORE_THRESHOLD=5`；折叠态 `localStorage["wb:conversation-list:expanded-state"]`（`:u:{uid}`）；新经典侧栏 `localStorage["agent-sidebar-mode"]` 默认 next；新建任务埋点 `agent_new_task_button_clicked`；搜索/筛选 `conversation_list_search`/`conversation_list_task_filter`。

## 14. 分区/操作文案总表（白标替换品牌，文案可留）
置顶任务/任务/空间/工作空间(云)/助理任务(云) · 新建任务/新建工作空间/折叠所有工作空间/没有匹配的任务/暂无任务/点击上方按钮开始新任务/未命名 · 搜索任务/最近任务/查看更多/收起/知道了 · 筛选状态(全部/进行中/已完成/失败/待处理/规划中) 筛选时间(全部/今天/最近7天/最近30天) 重置筛选条件 · 重命名/更多/删除任务/分享任务/打开文件夹/从列表中移除/保存到工作空间/归档/置顶/取消置顶 · 移除工作空间「确认后将从列表中移除工作空间，请确认是否移除？」 · 状态：规划中/执行中/等待输入(待确认)/已完成/异常中断/执行失败/已归档 · Agent Team：团队卡片/专家团/成员/{count}人/主理人/团队成员/已完成工作/执行失败/待授权/返回主会话继续对话。

---

## 15. 务实取舍标注（必做 / 可简化 / 暂不做）

**必做**：三分区（置顶/任务/空间-按工作目录分组）+ 筛选面板（状态多选+时间）+ 搜索 + 会话卡（改名/删除/置顶/归档/打开文件夹/右键菜单）+ 收起 48px + 目录已删 toast + 每段/组 5 条折叠。结构清晰、直接对标。

**可务实简化/砍**：
- 新/经典侧栏 toggle（只做一套）；云侧"工作空间/助理任务"分区、会话上限弹窗（远端能力）。
- 项目组 role/permissions 三态菜单→单用户本地退化成简单 rename/delete；cloudAssistant 组、来源 chip（小程序/App）无多端来源就删。

**Agent Team**：保留 §9a 聊天顶部成员横条 + 返回主会话（对上子代理）；§9b 侧栏子会话树/团队卡片**大厂自己都没发货，建议不做**（最多会话卡下平铺子任务）。

**白标**：logo(暗/亮双图)、版本徽标、`--wb-*`/`--cb-*` token 全换我们的；`workbuddy-*`/`cb-*` class 前缀分发前 scrub。

---

## 盲区
1. Agent Team 侧栏树+团队卡片：CSS+i18n 完整但发货 JS 0 渲染引用（feature-flag 或惰性 chunk 未打包），渲染时机/点击效果读不到，按 CSS+i18n 反推。
2. 导航 tabs 具体项与顺序走 menu 配置 + `PRODUCT_FEATURES`，属 04-08 切片，只给骨架。
3. AgentCard 最内层 DOM 由 `src-CMgU1OQk.js` 导出，拿到完整 cardProps+外层 CSS，内部 CSS-module 哈希类未逐一展开。
4. "试用新侧栏"到底切谁：机制 100% 读到，但 SidebarModeToggle 发货 JS 未见渲染，判断切右侧面板，没 100% 证实不影响左栏，需真机点确认。
5. usePinnedDrag/useTaskGrouping 完整派生逻辑未逐行展开（对"照着开发"够用）。
6. 未真机验证（构建未混淆、可信度高，但没跑起来）。
