# 🚧 审计 · 补漏掉的后端地基维度 —— WorkBuddy 前端所牵扯的「后端地基」施工总账

> **这份文档解决什么**：我们一直对照 cc-haha 补后端，漏了一整个维度——「效仿 WorkBuddy 前端」那些产品面板背后要的后端地基（存储/API/引擎/服务）。
> 本文穷尽 WorkBuddy 每个前端面板 → 反推它能跑起来后端必须先有什么 → 查 cc-haha 有没有（可复用）+ 查我们 `ts/src` 有没有 → 标出「一直没打的后端地基」。
> **性质**：只读审计，不改代码。诚实标注，没打的不说成有。
> 素材来源：4 区逆向审计（助理Dashboard/项目协同/AgentTeam、自动化定时/资料库灵感、专家技能连接器/预览/文件版本、语音TTS/消息中心/记忆/欢迎屏）。

---

## 0. 分工澄清：哪些抄 cc-haha 内核、哪些抄 WorkBuddy 产品面板

一句话：**cc-haha = AI 大脑 / coding-agent 内核 / 后端底盘；WorkBuddy = 前端外壳 / 配色 / 文案 / 产品面板**。
一直漏的就是——WorkBuddy 产品面板背后也需要后端地基，而这些地基 cc 未必有，得我们自己打。

| 维度 | 效仿谁 | 说明 |
|------|--------|------|
| coding-agent 内核（harness/loop、工具族、权限五档、content-block） | **cc-haha** | 机制照抄，直接对齐 |
| 子代理 / 团队运行时（teammate、mailbox、后台派单 Task） | **cc-haha** | 我们已基本对齐 |
| 记忆底座（memdir、MEMORY.md 分层注入） | **cc-haha** | 底座有，面板契约层缺 |
| 技能 / MCP 加载与信任闸 | **cc-haha** | 加载与信任已对齐，安装态/市场是 WB 的 |
| **助理 Dashboard（云助理卡片网格 / 创建向导 / 助理详情）** | **WorkBuddy** | cc 无面向前端的 roster，地基要新打 |
| **项目协同（项目实体 / 成员角色 / 看板 / 网盘 / 活动流）** | **WorkBuddy** | cc 无「项目」抽象，地基要新打 |
| **自动化定时（真调度引擎 / 运行历史 / 模板库）** | **WorkBuddy 面板 + cc 引擎** | 面板是 WB 的，调度引擎 cc-haha 有整套可复用 |
| **资料库 / 灵感 feed / 案例库 / 兴趣画像** | **WorkBuddy** | cc 完全没有，纯新打（店铺 RAG 我们已有） |
| **文件版本管理（git 自动版本化 / commit 时间线 / 回滚重置）** | **WorkBuddy** | cc 只侦测手动 commit，自动版本化要新打 |
| **朗读 TTS / 消息中心通知列表** | **WorkBuddy** | cc 无，要新打（ASR 我们已有） |
| **个性化（语气/自定义指令/三模式欢迎屏）** | **WorkBuddy** | 注入通道 cc 有，持久化与模板映射要新打 |
| 配色 / 文案 / UI 交互 | WorkBuddy（配色文案）+ cc（交互机制） | 前端三分法，不在本文范围 |

---

## 1. 全景现状总表（WorkBuddy 每个前端面板 → 后端地基 → 现状）

状态口径：`✅ 我们已有` / `♻️ cc 可复用` / `🔴 缺·要新打`。

### 1.1 助理 Dashboard + 项目协同 + AgentTeam

| 面板 / 功能 | 要的后端地基 | 现状 | 优先级 |
|------|------|------|------|
| 聊天顶部团队成员横条 / AgentTeam runtime | team 运行时（成员快照/lead/子会话/活跃态） | ✅ `teamService.ts`（members/listPeers/isActive/isLead） | P1 |
| AgentTeam 团队创建/解散/成员增删 | TeamCreate/Delete + 成员增删 + 单团队约束 | ✅ `teamTools.ts` + `teamService` | P1 |
| @助理协作 / 广播 / 结构化协议 | 文件式 mailbox + @路由 + 广播 + 结构化消息 | ✅ `teamTools.SendMessage` + `writeToMailbox` | P1 |
| 一句话派单 → 丢后台跑 | 后台执行原语（起 agent/task id/轮询/取消/steer） | ✅ `taskService.ts`+`taskTools.ts` + `/api/v1/agent/tasks` | P1 |
| 内存记忆开关 | 助理级持久记忆（每助理 MEMORY.md 可开关） | ✅ `agentMemory.ts` | P1 |
| **云助理卡片网格（列表+计数+状态胶囊）** | 助理档案 roster 持久化 + 列表/状态查询 REST | 🔴 `agentLoader` 只读加载 3 个 bundled，无 roster 存储、无列表接口 | **P1** |
| **创建助理向导（昵称/职业/头像/职责写盘+查重）** | 助理建档写盘 API + `create_agent` 工具 + 合规查重 | 🔴 无 create_agent；仅 create_skill 可作蓝本 | **P1** |
| **编辑档案 / 删除助理** | 助理档案 update/delete REST + 占用校验 | 🔴 无（agentLoader 只读，无 CRUD） | **P1** |
| **总控云助理编排（拆任务→分派→@协作）** | orchestrator：自动拆解+分派+回收进展 | 🔴 原语齐（task/team/agent），缺「自动拆解分派」胶水层；cc `coordinatorMode.ts` 可参考，worker 是桩 | **P1** |
| 助理事件总线（roster/会话变更驱动前端刷新） | roster/会话变更领域事件推送（SSE/WS） | 🔴 有 SSE 会话流，无 roster/会话列表变更事件 | P2 |
| 助理详情·任务概览卡 | 按助理聚合任务统计 API | 🔴 数据在（metadata 存 agent_id），缺聚合查询 | P2 |
| 助理详情·对话任务表格 | 按 agentId 聚合会话/任务索引 + 来源标 + 删除 | 🔴 数据在，缺「按助理归组列会话」视图 | P2 |
| 助理详情·右侧助理竖排 rail | roster + 每助理会话列表 + 会话状态 | 🔴 无（依赖 roster+会话聚合两块） | P2 |
| 助理详情·能力配置卡 | 助理 manifest 存储 + 按 agentId 查询 | 🔴 frontmatter 可承载字段，缺 manifest 读写 REST | P2 |
| 绑定 IM 渠道（微信/企微/钉钉/飞书/QQ/邮件） | IM 绑定 + 入站 webhook + 出站推送 | 🔴 无公众 IM 接入；bridge* 是跨机传输可借鉴 | P2 |
| 配额上限 / 发布可见范围 / 公开审核 | 配额 + 可见范围 + 审核（SaaS 多租户） | 🔴 无；**本地单用户可整块砍** | P2 |
| 左栏会话三分区（置顶/任务/空间，kind 分组） | 会话分组存储（kind + pinned + 分组派生） | 🔴 `sessionService` 只按 workspaceRoot 聚合，无 kind/置顶 | **P1** |
| 左栏会话卡操作（置顶/归档/重命名/删除/打开文件夹） | 会话元数据 pinned/archived + cwd 存在性校验 | 🔴 有 title/status，缺 pinned/archived、缺 cwd 校验 | **P1** |
| 左栏筛选面板 + 搜索 | 会话查询过滤（status[]/时间/keyword） | 🔴 只支持 workspaceRoot 过滤 | P2 |
| 项目列表与 CRUD | 项目实体存储 + CRUD REST（独立于 workspace） | 🔴 无项目实体；projects() 只是只读聚合视图 | P2 |
| 项目成员/角色/邀请 | 成员管理 + 角色权限 + 邀请链接 | 🔴 无；**单用户可退化为无成员** | P2 |
| 项目配置 5 卡（指令/连接器/专家/技能/自动化） | 项目级 config 存储 + 注入 | 🔴 packs/.mcp.json 可作蓝本，无项目实体级配置 | P2 |
| 项目动态面板（活动流+未读红点） | 项目事件审计流 + 未读标记 | 🔴 无（task-events 是单任务，非项目审计） | P2 |
| 项目计划面板（看板+外部工单源） | 待办看板 + 工单源同步 + 待办↔session 关联 | 🔴 `taskListService` 是单会话 todo，非项目看板 | P2 |
| 项目资产面板（网盘/版本/冲突） | 项目文件存储 + 版本历史 + 冲突处理 | 🔴 有工作区读写+备份，无项目网盘 | P2 |
| 项目从模板创建 | 项目模板库 | 🔴 命令/技能模板可作蓝本，无项目模板实体 | P2 |
| **项目新手指引（首进建 demo 任务+welcome 注入）** | demo 会话 + welcome 内容 + overview artifact + 去重 | 🔴 原语在（create+saveArtifact），缺 demo/welcome/一次性机制（**task#52 onboarding**） | **P1** |
| 项目连接器管理（OAuth/个人vs公共/调用日志） | OAuth 授权 + 凭证加密存储 + 调用日志 | 🔴 `credentialCipher`+MCP 可类比，无 OAuth 面板/日志 | P2 |
| **项目配置·自动化 / 助理按计划自动执行** | 真定时调度引擎（见 §1.2，两处合并） | 🔴 只存不跑（**task#53**，与自动化区合并） | **P1** |

### 1.2 自动化定时 + 资料库灵感

| 面板 / 功能 | 要的后端地基 | 现状 | 优先级 |
|------|------|------|------|
| 定时任务列表 CRUD/启停/分组 | 任务持久化 CRUD + REST | ✅ `desktopDataStore`(scheduledTasks) + `/api/v1/scheduled-tasks` | P0 |
| **真定时调度引擎·到点触发** | 常驻 tick：算 next_run、到点触发起会话 | ♻️ cc `cronScheduler.ts`(886L) 整套可复用；**我们无——next_run_at 恒 null，全仓无 timer 触发（#53「只存不跑」核实属实）** | **P0** |
| **补跑/错过计划** | 关机期错过检测 + 启动补跑一次 | ♻️ cc `cronScheduler.findMissedTasks`；我们无 | **P0** |
| **调度数据模型（周期/间隔/单次+RRULE+生效期）** | 调度规格存储 + next 计算 | ♻️ cc 5-field cron 可复用；我们仅 daily stub | **P0** |
| 测试运行 / 立即运行 | 立即执行一次 + 写 run 记录 | ♻️ cc `POST /:id/run`；我们无 | **P0** |
| 任务执行编排（跑提示词） | 拿 prompt→起会话执行→输出回灌 | ♻️ cc `executeTask`；我们内核可承接但无接线 | **P0** |
| **运行记录 / 运行历史** | TaskRun 存储（status/output/duration/sessionId）+查询+清理 | ♻️ cc `appendRun/getRecentRuns`；**我们有字段从没被写、无 run 列表** | **P0** |
| 执行权限档（免确认 vs 逐次确认） | 每任务 permissionMode 存储 + 无人值守放行 | 🔴 权限五档内核有，scheduledTask 无 permissionMode 字段、未接无人值守 | P1 |
| 工作空间绑定 CWD | 任务绑定工作目录，执行 cwd=该目录 | ♻️ cc `folderPath`；我们 scheduledTask 无 folderPath | P1 |
| 完成推送（微信小程序/通知） | 任务完成推外部渠道或应用内通知 | ✅ 应用内 `addNotification` 有；外部 IM 可复用 cc `notificationService` | P2 |
| 多会话防重复触发锁 | 多窗口只一个跑调度 | ♻️ cc `cronTasksLock.ts`；我们无（多窗口需要） | P2 |
| **内置模板库（12 模板）** | 模板数据供前端读 + 添加落成真任务 | 🔴 cc 无、我们无 | P1 |
| 批量选择/删除 | 批量删除 | ✅ 单删已有，前端循环即可 | P2 |
| 我的文件（成果+云盘+配额） | 文件库列举/上传/配额 + 成果归集 | 🔴 `save-to-library`+`StoreDocsService` 有索引，无上传/配额/云盘/归集面板 | P2 |
| **店铺资料库检索（本地 RAG）** | 本地文档索引 + 混合检索 + 来源引用 | ✅ `storeDocsService.ts`(BM25+语义 RRF + 工具 + 端点)，已较完整 | P0 |
| **案例/灵感起点库 DiscoverPanel** | 案例卡数据+分类+收藏+「做同款」灌输入框 | 🔴 cc 无、我们无 | P1 |
| 案例启动资源检查（技能/MCP 就绪） | 检查是否装+触发安装+阶段推进 | ✅ 技能/MCP 基建齐，缺「案例→清单→就绪」编排层 | P2 |
| 每日灵感 feed InspirationPanel | 每日定时生成个性化卡（调度+画像+AI+存储） | 🔴 无 feed 生成/存储，调度引擎也无 | P2 |
| 兴趣画像 / 偏好 | 用户兴趣/偏好持久化 | 🔴 无（store 是门店画像，非用户兴趣） | P2 |
| 收藏（灵感/案例 favorite） | 收藏关系存储 + 列举 | 🔴 无 | P2 |
| 预置 prompt 灌输入框 adapter | run 接收 content blocks | ✅ 内核认 content-block，前端 adapter 待建 | P2 |
| 模式→系统提示模板映射 | {family}-{welcomeMode}.tpl 选择 | ✅ outputStyles+领域包注入，地基已有 | P2 |
| 腾讯文档/ima/乐享 三方知识库 | 三方 OAuth+webview 选择器+导入 | 🔴 无；**球房非必需** | P2 |
| 外部数据源 datasource | 外部系统按规则同步进看板 | 🔴 无；**WB 自标 mock/WIP，不必优先** | P2 |

### 1.3 专家·技能·连接器 + 右侧预览 + 文件版本管理

| 面板 / 功能 | 要的后端地基 | 现状 | 优先级 |
|------|------|------|------|
| 技能加载与三层存储 | 分层加载 SKILL.md + 解析 + 聚合列表 | ✅ `skillLoader.ts`(三层) + bundled 10 + `/api/v1/agent/skills` | P1 |
| **技能安装/卸载/启停/置顶+批量** | 安装态持久化(installed/enabled/pinned) + 写盘 API | 🔴 cc 无、我们 skillLoader 只读扫描，无状态存储 | P1 |
| **技能上传/导入（zip/文件夹）** | 接收上传→解压→校验→落库 | 🔴 有 create_skill 写盘，无 zip 导入解压+校验管线 | P1 |
| **技能安全检测（病毒/恶意扫描）** | 安全扫描引擎 + 风险分级 + 高风险闸 | 🔴 cc 无、我们无（**task#56 信任闸重叠**） | P1 |
| 创建技能=skill-creator + 推荐条 | 采访式生成 + 按上下文推荐 | ✅ `skillify`+`recommendedSkillNames` | P2 |
| 技能市场（多来源/排序/分页/搜索） | 远程市场目录 API + 企业源 | 🔴 cc 无、我们无 | P2 |
| 技能自动更新 | 版本比对+拉更新+冲突检测 | 🔴 无（依赖远程源） | P2 |
| 专家包存储/加载/召唤运行 | subagent 加载 + fork 运行 + 记忆 + 预览测试 | ✅ `agentLoader`+`agentTool`+`forkSubagent`+bundled 3 | P1 |
| 专家创建/编辑（AgentEditor） | 定义 create/edit 写盘+校验+model/tools 选择器 | ♻️ cc `components/agents` 整套可复用；我们只读加载无 CRUD | P2 |
| 专家市场/分类/排行榜 | 远程专家目录 API | 🔴 cc 无、我们无（packs 是本地非市场） | P2 |
| 导入/分享专家包+安全检测 | 序列化分享+导入解析+安全扫描 | 🔴 无（**task#56 重叠**） | P2 |
| MCP 服务器存储/连接/工具发现 | JSON 配置 + stdio/SSE/HTTP 连接 + 状态 + 重连 | ✅ `ts/src/mcp` + `/api/v1/agent/mcp` + presets | P1 |
| MCP 信任/安全闸 | 首次连接信任门 + 恶意判定 + 工作区批准 | ✅ `mcpTrust.ts` + `/api/v1/agent/mcp/trust` | P1 |
| MCP 工具级开关 + 过多告警 | per-tool enable/disable 存储 + 阈值告警 | 🔴 只有 server 级 disabled，无 per-tool | P2 |
| 全局急停（禁用全部技能/MCP/插件） | 统一 kill-switch + 各子系统读取 | 🔴 无统一急停（hooks 有 disableAllHooks 局部门） | P2 |
| MCP Apps host tab | MCP-UI 宿主：沙箱渲染 MCP 下发 UI | 🔴 无（全前后端无 mcpApps 概念） | P2 |
| 连接器 OAuth/扫码/设备码/Token 四授权 | 连接器抽象层 + 四种授权流 + 凭据存储 | 🔴 无连接器抽象（MCP add JSON 是入口）；credentialCipher 可托底 | P2 |
| 概览·任务进程 section | 任务/todo 数据源供提取渲染 | ✅ `taskTools`+TodoWrite + `/api/v1/agent/tasks` | P1 |
| 概览·产物 section | 列产物 + 类型识别 + 拖拽路径 | ✅ `recent-artifacts`+`saved-artifacts`+`canvas` | P1 |
| 工作空间文件 tab（FileTree） | 目录树列举 + 单文件读取 | ✅ `fs/list`+`fs/read`(256KB)+workspace-status tree | P1 |
| **浏览器 tab（内嵌浏览器预览）** | Electron WebContentsView：loadURL/截图/zoom/注入/导航守卫 | ♻️ cc `ElectronPreviewService` 完整可复用；**我们仅占位注释+前端空壳** | **P1** |
| 变更 tab（文件 diff 列表） | diff 计算 + 改动列举 | ✅ `file-diff`(structuredPatch) + `fileHistory.ts` | P1 |
| 专家 tab 预览+立即测试 | 预览渲染 + 试跑 | ✅ `forkSubagent`+`agentTool` | P2 |
| 产物不存在兜底 | 路径存在性检查 + 404 | ✅ `fs/read` 返 404 | P2 |
| **文件版本·底层 git 版本引擎** | 工作目录 init git + 每次工具写文件自动 commit + name-status | 🔴 cc 只侦测手动 commit；我们 gitStatus/History 只读、不 init 不 commit，fileHistory 是逐文件 .bak 非 commit 时间线 | **P1** |
| **文件版本·commit 时间线** | commit 列表 RPC（多文件聚合、新→旧） | 🔴 cc 无、我们无（fileHistory 逐文件无 commitId 聚合） | **P1** |
| **文件版本·回滚 revert** | commit 级回滚（保留其后提交） | 🔴 无（file-restore 只单文件 backup 还原） | **P1** |
| **文件版本·重置 reset** | commit 级 reset --hard 丢弃后续 | 🔴 无 | **P1** |
| **文件版本·版本内容物化缓存** | 按版本批量取内容 + binary/oversize/missing 三态 | 🔴 fileHistory 存了 .bak+sha256+size 可托底，无按 commit+version 查询与三态语义 | **P1** |
| DiffViewer 数据 | 两版本内容取回 + 三态标记 | ✅ file-diff 可托底 diff；三态标记需补 | P1 |

### 1.4 语音 TTS + 消息中心 + 记忆 + 欢迎屏

| 面板 / 功能 | 要的后端地基 | 现状 | 优先级 |
|------|------|------|------|
| 语音输入 ASR | ASR 端点（音频→文字）+ whisper sidecar + ffmpeg + 准备门 | ✅ `voiceTranscription.ts`(whisper-cli+ffmpeg) + `/api/v1/voice/transcribe` + 503 准备门 | P1 |
| **朗读 TTS（三态喇叭流式播）** | TTS 端点/sidecar：startTts→流式 PCM 分片 + stopTts + requestId 防串音 + 网关藏 key | 🔴 **完全空白**（全 ts/ grep tts/synthesize 0 命中） | **P1** |
| **消息中心·通知列表读取** | 通知存储 + getList(cursor,limit) + 完整字段(msg_id/biz_type/is_read/actions...) | 🔴 半个：有 addNotification+after 增量拉，无 is_read/cursor/has_more/biz_type/actions/分组 | **P1** |
| 未读角标 + 摘要轮询 | getSummary()→{total,poll_interval,pending_popup} | 🔴 无未读计数/summary | P2 |
| 标记已读 + 删除 | markRead/deleteMessage + 持久化 is_read | 🔴 无 read 态/markRead/delete | P2 |
| 通知推送分发（系统通知/端内 toast） | getPendingDisplays + notifyShown + Electron Notification IPC + 前后台分流 | ♻️ cc `notificationService` 骨架可参考；我们只落库无系统通知桥 | P2 |
| 记忆·生成对话记忆开关+自动提取 | 回合/夜间从 transcript 抽取写 memdir + 每晚重生成 | ♻️ cc `extractMemories.ts`(fork 子代理抽取) 可复用；我们只有读回+模型自写，无自动抽取 | P1 |
| 记忆·管理弹窗契约 | getMemoryProfile/submitMemorySuggestion/checkMemoryUpdating + 更新锁 + toast | 🔴 memdir 底层有，面板契约层全无 | P2 |
| 记忆·重置/导入 | clearMemory/importMemoryContent | 🔴 memdir 写侧存在，无 HTTP 契约薄封装 | P2 |
| 记忆·本地记忆开关 | 开关控制注入 + 持久化键 | ✅ claudemd 分层注入 + env 可关；差 UI 开关持久化 | P2 |
| 个性化·语气风格（8 档） | toneStyle 持久化 + 读 style-<key>.md 注入 | ✅ outputStyle 机制在；缺①8 档 tone 内容 ②持久化（现靠前端每次传） | P1 |
| **个性化·自定义指令（customPrompt）** | customPrompt 持久化 + 每轮注入 + save/get 契约 | 🔴 注入位有，无持久化存储、无 save/getPersonalization | **P1** |
| 加载欢迎语开关 | 纯前端 localStorage | ✅ 无需后端 | P2 |
| **欢迎屏·三模式选择器映射** | mode→各挂系统提示模板 + run 带 mode 选模板 | 🔴 systemPrompt 静态单套、run 无 mode 字段；可借 outputStyle 实现但「三模式编排+映射」要新打 | **P1** |
| 欢迎屏·工作空间/仓库选择 | 工作空间列举/绑定 + 默认路径持久化 | ✅ `userSettings.ts`+workspace 模块+run 带 working_dir | P1 |
| 欢迎屏·领域包挂载 | 领域包注册表 + SessionStart 注入 + run 带 packs | ✅ `ts/src/packs`+`applySessionStartHooks`+billiards 包 | P1 |
| requestInsertContentBlocks | run 接收 content blocks | ✅ `inboundContentBlocks`+userContent 就绪，前端壳待建 | P2 |
| 快捷动作/模板 prompt | 模板清单 + insert content blocks | ✅ commands+skillListing 可复用，文案前端硬编码 | P2 |

---

## 2. 【重点】缺要新打的后端地基清单（WB 特有 · cc 没有 · 我们也没有）

这就是一直漏掉的维度核心。按优先级排，每条注明「要打什么」。
（注：cc 有整套可复用的不进本清单，见 §3；那类是「搬」不是「从零打」。）

### P1 —— 撑起 WorkBuddy 招牌面板的地基，先打

| # | 缺口 | 撑起哪个面板 | 要打什么 |
|---|------|------|------|
| N1 | **助理 roster 存储 + 列表/状态 REST** | 云助理卡片网格、助理详情全家桶 | 助理档案持久化（roster 存储）+ `GET /api/v1/agent/agents` 列表 + 运行状态查询；这是整个助理 Dashboard 的地基，下面 N2/N3/助理详情全依赖它 |
| N2 | **create_agent 写盘工具 + 建档 API** | 创建助理向导 | 类比 create_skill，把向导字段（昵称/职业/头像/职责/协作风格）落成 agent .md frontmatter；+ 名称/简介合规检测与查重 |
| N3 | **助理档案 update/delete REST** | 编辑档案 / 删除助理 | CRUD 端点 + 删除前占用校验 |
| N4 | **总控云助理编排 orchestrator（胶水层）** | 一句话派单自动拆解分派 | 把已有原语（taskTools 派单 + teamTools @路由 + agentTool 子代理）串成「后台跑总控→自动拆解→分派具名子助理→回收进展」；cc coordinatorMode.ts 可参考但 worker 是桩不能整块抄 |
| N5 | **会话分组地基（kind + pinned/archived + 查询过滤）** | 左栏会话三分区、会话卡操作、筛选 | SessionMeta 加 kind(independent/workspace/project/expert/cloudAssistant)+pinned+archived 字段 + 置顶排序 + cwd 存在性校验 + status/时间/keyword 过滤 |
| N6 | **项目新手指引 demo 机制** | 首进项目建 demo 任务 | demo 会话创建 + welcome.md 注入 + overview artifact 注入 + 一次性去重（**task#52 onboarding**） |
| N7 | **文件版本 git 引擎（地基）** | 文件版本管理整面板 | 工作目录 init git + 工具写文件后自动 `git add -A && commit` 聚合 + name-status 解析；这是 N8–N11 的共同地基 |
| N8 | **commit 时间线 RPC** | 版本时间线 | `listFileCommits{sessionId}`→commits 新→旧，每 commit 聚合多文件变更 |
| N9 | **回滚 revert RPC** | 回滚到某版本 | commit 级回滚（恢复但保留其后提交），返回 files 结果 |
| N10 | **重置 reset RPC** | 重置到某版本 | commit 级 `git reset --hard` + 确认弹窗（不可恢复） |
| N11 | **版本内容物化缓存** | DiffViewer 兜底 | 按 commit+version 批量取历史内容 + binary/oversize/missing 三态；fileHistory 的 .bak+sha256 可托底内容源 |
| N12 | **技能安装态存储 + 写盘 API** | 技能安装/卸载/启停/置顶+批量 | installed/enabled/pinned 持久化 + 卸载删本地文件夹 + 批量操作 RPC |
| N13 | **技能上传/导入管线** | 拖 zip/文件夹导入 | 接收上传→解压→校验含 SKILL.md 且 YAML 合法→落技能库目录 |
| N14 | **技能/专家包安全扫描引擎** | 技能安全检测、专家包导入 | 静态恶意意图/病毒扫描 + 风险分级(safe/low/med/high) + 异步结果通知 + 高风险手动确认闸（**task#56 信任闸，技能与专家共用一个引擎**） |
| N15 | **朗读 TTS 服务** | 助手消息喇叭朗读 | TTS 端点/sidecar：`startTts({text,requestId})`→流式 base64 PCM 分片+done/error；`stopTts`；requestId 防串音；走网关藏 key（**完全从零**） |
| N16 | **消息中心通知存储 + getList** | 通知列表面板 | 通知存储加全字段(msg_id/biz_type/title/summary/is_read/actions/notify_displays)+`getList(cursor,limit)`→{messages,next_cursor,has_more}；在现有 addNotification 上扩 |
| N17 | **自定义指令 customPrompt 持久化** | 个性化·自定义指令 | personalization 配置存储 + save/getPersonalization 契约 + 每轮 trim 注入（注入位已有） |
| N18 | **三模式选择器 → 系统提示模板映射** | 新建任务欢迎屏三模式 | mode(门店运营/内容创作/数据分析)→各挂系统提示模板 + run body 带 mode 选模板（可借 outputStyle 机制） |
| N19 | **自动化·执行权限档 permissionMode** | 免确认 vs 逐次确认 | scheduledTask 加 permissionMode 字段 + 无人值守按档放行/卡审批（权限五档内核已有，只差接线） |
| N20 | **自动化·内置模板库（12 模板）** | 从模板添加定时任务 | 模板数据(id/title/prompt/schedule/icon)供前端读 + 添加落成真任务 |
| N21 | **案例/灵感起点库 DiscoverPanel** | /discover「做同款」 | 案例卡数据(cover/prompt/tags/关联资源)+分类+收藏+「做同款」灌输入框 |

### P2 —— 次要 / 可退化 / SaaS 味重的，后打或砍

- 助理：事件总线、任务概览统计、对话任务表格、右侧 rail、能力配置 manifest、IM 渠道绑定
- 助理·**配额/可见范围/审核** →（本地单用户可整块砍）
- 项目：实体 CRUD、**成员角色邀请（单用户可退化）**、配置 5 卡、活动流、看板+工单源、网盘+版本、模板库、连接器 OAuth+日志
- 自动化：多窗口防重锁、我的文件/云盘配额、每日灵感 feed、兴趣画像、收藏、**三方知识库（球房非必需）**、**外部数据源（WB 自标 WIP）**
- 技能/专家：市场多来源、自动更新、专家市场排行、导入分享专家包、MCP 工具级开关、全局急停、MCP Apps host、连接器四种授权
- 消息中心：未读角标+摘要、标记已读+删除、通知推送分发（系统通知桥）
- 记忆：管理弹窗契约、重置/导入契约、本地记忆 UI 开关持久化

---

## 3. 跟之前 cc 后端审计的去重与合并

这次 WorkBuddy 反推审计里，有几处跟之前「对照 cc-haha 补后端」的审计撞车，避免重复施工：

| 撞车点 | 之前 cc 审计怎么记 | 本次 WB 审计怎么记 | 合并结论 |
|------|------|------|------|
| **真定时调度引擎** | 审计 **#53「只存不跑」**（scheduledTask 有存储无 tick） | 出现两次：助理区「项目配置·自动化」P1 + 自动化区「到点触发」P0 | **同一件事，合并为一个 P0**：直接搬 cc `cronScheduler.ts`+`cron.ts`+`cronTasksLock.ts` 整套。助理「按计划自动执行」和自动化面板共用这一个引擎 |
| **导入安全扫描信任闸** | 审计 **#56** | 出现两次：技能安全检测 + 专家包安全检测 | **合并为一个引擎 N14**：技能包和专家包共用一套静态恶意/病毒扫描+分级+高风险闸 |
| **onboarding demo** | 审计 **#52** | 助理区「项目新手指引」P1 | 同一件事（N6），归 task#52 |
| **content-block 注入** | 内核已认 content-block | 自动化区 + 欢迎屏区都标 ✅ we-have | 已有，不重复；前端 adapter 是前端活 |
| **店铺 RAG** | 已有 storeDocsService | 资料库区标 ✅ | 已有，不重复 |
| 定时任务的「运行记录/补跑/CWD 绑定/立即运行」 | cc 审计未单列 | 本次拆细为 §1.2 多条 | 都属调度引擎配套，随 cc cronScheduler 一起搬，不单独打 |

**净新增维度**（之前 cc 审计完全没覆盖、纯 WB 前端牵扯出来的）：助理 roster/CRUD、会话 kind 分组、文件 git 版本化全家桶、朗读 TTS、消息中心、自定义指令持久化、三模式映射、案例库、灵感 feed。这些是「补漏掉的维度」的真正增量。

---

## 4. 补齐路线（后端先，哪些先打）

原则：**先打「地基型」（一个撑起一整片面板的），再打「叶子型」（单点功能）；能搬 cc 的先搬不自己造。**

**第 0 波（搬 cc，最高杠杆）**
- 搬 cc 定时调度引擎全套（cronScheduler/cron/cronTasksLock/notificationService）→ 一次性点亮：自动化面板到点触发、运行历史、补跑、CWD 绑定、助理按计划执行、（后续）每日灵感 feed 的定时触发。**这是单点投入回报最高的一步（#53）**。

**第 1 波（自建地基，撑招牌面板）**
1. **助理 roster 存储 + CRUD REST + create_agent 写盘**（N1/N2/N3）→ 点亮整个助理 Dashboard（卡片网格/创建向导/编辑删除/详情各卡/rail 都依赖它）。
2. **文件版本 git 引擎 + 时间线/回滚/重置/版本缓存**（N7–N11）→ 点亮文件版本管理整面板，一个地基带四个 RPC。
3. **会话 kind 分组 + pinned/archived + 查询过滤**（N5）→ 点亮左栏会话列表三分区与卡操作。

**第 2 波（叶子功能，单点补）**
4. 朗读 TTS（N15，从零，与已有 ASR 对称）、消息中心通知存储+getList（N16）、自定义指令持久化（N17）、三模式映射（N18）。
5. 技能安装态+导入管线+安全扫描（N12/N13/N14，task#56）、自动化权限档+模板库（N19/N20）、案例库 DiscoverPanel（N21）、项目新手指引 demo（N6，task#52）。

**第 3 波（可选/可退化/可砍）**
- 项目实体 CRUD、成员角色、看板、网盘、活动流；助理 IM 绑定、配额审核；灵感 feed+兴趣画像+收藏；技能/专家远程市场；MCP 工具级开关/全局急停/Apps host；三方知识库、外部数据源。
- **本地免登录单用户形态下可整块砍或退化**：助理配额/可见范围/审核、项目成员/角色/邀请、多窗口防重锁（单 sidecar 够）、三方知识库（球房非必需）、外部数据源（WB 自标 WIP）。

**先打 5 件（若只做最关键的）**：① cc 定时调度引擎（搬）② 助理 roster+CRUD+create_agent ③ 文件 git 版本引擎 ④ 会话 kind 分组 ⑤ 技能安装态+安全扫描信任闸。
