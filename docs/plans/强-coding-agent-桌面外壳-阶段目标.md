# 强 coding agent 桌面外壳阶段目标

> 状态:进行中 · 最后核对 2026-07-09 · 适用范围:本仓库 `main`

## 0. 使用方式

这份文档是本阶段给 Claude Code / Codex 执行长任务时的任务规格源。不要把全部细节塞进一次对话里反复解释,而是让执行 agent 先读本文档,再用 `/goal` 引用本文档持续推进。

推荐启动方式:

```text
/goal
按 docs/plans/强-coding-agent-桌面外壳-阶段目标.md 推进本项目 main 分支到阶段性完成状态。

执行前必须先完整阅读本文档、CLAUDE.md、ts/CLAUDE.md、ts/AGENTS.md、docs/当前目标与文档口径-2026-07-07.md、docs/plans/TS-cc-haha-v0.4.5-内核迁移矩阵-2026-07-07.md,并重新扫描本项目和 /Users/swl/Desktop/cc-haha-ref 当前源码。

以本文档的完成标准为最终验收口径。不要只做局部小改;每个模块必须维护迁移矩阵、测试结果和未完成原因。最终答复必须列出已跑测试、未跑测试及原因、剩余风险。
```

如果执行 agent 不支持 `/goal`,就把上面内容当普通任务发过去,但仍要求它持续维护本文档里的矩阵和完成标准。

## 1. 第一性目标

本项目的第一性目标是做成一个 **强 coding agent 桌面外壳**。

这意味着:

1. 后端/内核能力优先级高于台球业务、生图、生视频和剪辑 UI。
2. 项目主壳不是台球软件,不是生图软件,也不是视频生成软件。
3. 台球运营专家、生图、真实素材剪辑都只是通用 Agent 工作台上的可挂载能力或插件式延伸。
4. 如果 coding agent 的读写、命令、权限、工具、上下文、任务、错误恢复和测试能力不强,上层所有业务功能都会变成不可靠包装。

阶段性完成状态不是“做几个功能点”,而是让 `main` 分支在内核、前端、媒体能力和文档上都围绕“强 coding agent 桌面外壳”一致。

## 2. 权威资料顺序

执行前按下面顺序读,后续判断冲突时也按这个优先级处理:

1. 本文档:当前阶段目标、验收口径和任务拆分。
2. `CLAUDE.md`:项目总入口和历史铁律。
3. `docs/当前目标与文档口径-2026-07-07.md`:当前目标、文档取舍和 Python 退役口径。
4. `docs/plans/TS-cc-haha-v0.4.5-内核迁移矩阵-2026-07-07.md`:已有 cc-haha 迁移进度和下一批代码顺序。
5. `ts/CLAUDE.md` / `ts/AGENTS.md`:TS 内核施工规则。
6. `/Users/swl/Desktop/cc-haha-ref`:cc-haha 当前源码,作为可执行规格源。
7. `docs/references/竞品拆解/`:Work Buddy、Codex、Claude Code、Trae、Qoder 等竞品调研结论。

旧的商品化收官、早期视频生成、旧 Python 线、过时分支计划可以查原因,但不能覆盖本文档。

## 3. 关键校准

### 3.1 cc-haha 不是灵感,而是规格源

`/Users/swl/Desktop/cc-haha-ref` 的 LICENSE 允许 use/copy/modify/distribute/publish copies。因此本项目可以直接复制、移植、改写 cc-haha 的成熟实现。

要求:

- 可直接复制/移植/改写 cc-haha 代码。
- 复杂能力必须补行为对齐测试。
- 注释里只写 `cc`,不要写旧缩写或把参考源写成限制性口径。
- 统一写“可直接复制/移植/改写 cc-haha”,不要再写旧限制口径。
- 行为对齐优先于“看起来自己实现了一版”。

### 3.2 彻底删除 CD/Seedance 2.0 AI 视频生成模型功能

当前项目实际存在的是 CD/Seedance 2.0 相关 AI 视频生成模型功能。这里的决策不是暂停、开关禁用或保留后门,而是把这整条“模型直接生成视频”的功能完整删除:前端入口、agent 工具、API 路由、后台任务、网关代理、配置项、测试、E2E 和文档口径都不要保留。删除对象只限 AI 视频生成模型功能,不删除真实素材剪辑工作台。

本阶段要删除的是:

- CD/Seedance 2.0 文生视频。
- CD/Seedance 2.0 图生视频。
- “让这张图动起来”入口。
- `generate_video` 工具。
- `i2v` / `t2v` / image-to-video / text-to-video 产品主线。
- 前端把生图结果交给视频生成模型的入口。
- 后端提交 CD/Seedance 2.0 任务并轮询的生成视频链路。
- 与 AI 生成视频相关的网关代理、配置、测试、文档和 E2E 断言。

保留并强化的是:

- 用户手机实拍素材导入。
- 本地视频素材管理。
- 转写、字幕、高光识别、配乐、裁切、调色。
- 时间线/方案/对话式修改。
- 导出成片。
- 真实素材剪辑的 agent 编排能力。

### 3.3 browser-use/video-use 的定位

`browser-use/video-use` 不替换本项目现有视频工作台。它是 coding-agent-driven video editing 的方法论参考。

只吸收这些思想:

- transcript-first。
- 素材先转写、再让 LLM 读压缩后的素材索引。
- `takes_packed.md` 类素材摘要。
- `timeline_view` 类时间线可视摘要。
- 剪辑前确认策略。
- `project.md` 类项目记忆。
- render 后自检。
- 不切断单词。
- 30-200ms padding。
- 30ms fades。
- 输出集中到 edit 目录或本项目对应媒体任务目录。

本项目最终形态是:产品化视频工作台负责 UI、素材、时间线和导出;agent 编排层吸收 video-use 的“素材理解 -> 策略确认 -> 时间线生成 -> 渲染 -> 自检”流程。

## 4. 总体执行原则

1. 直接在 `main` 分支施工,不新建分支。
2. 每个清晰能力块单独提交。
3. 每次提交信息说明能力块、测试结果和文档更新。
4. 不做局部小修小补后声称阶段完成。
5. 不留下坏测试、半成品入口、未解释 TODO、明显 UI 瑕疵。
6. 发现架构不合理时及时调整,但必须能说明对“强 coding agent 桌面外壳”的提升。
7. 删除旧能力前必须确认调用点、测试和文档,不能删断真实链路。
8. Python 退役按 `docs/当前目标与文档口径-2026-07-07.md` 的节奏:先 TS/Node/native 接住,再切入口和测试,最后删。

## 5. 第一阶段:扫描与总矩阵

执行 agent 必须先扫描:

- 本项目当前源码。
- `/Users/swl/Desktop/cc-haha-ref` 当前源码。
- 已有文档和迁移矩阵。
- 当前测试分布。
- 当前前端真实入口。
- 当前媒体生成和剪辑链路。

必须维护总迁移矩阵:

| 源能力 | cc 源位置 | 本项目现状 | 本项目落点 | 迁移方式 | 测试/验收 | 状态 | 未完成原因 | 后续路径 |
|---|---|---|---|---|---|---|---|---|
| 示例:PermissionMode | `/Users/swl/Desktop/cc-haha-ref/src/types/permissions.ts` | `ts/src/permissions/types.ts` 只有 4 档 canonical,兼容旧值 | `ts/src/permissions/*` + UI selector | 复制/改写/补差异 | permission 单测 + UI 测试 | 待核 | 缺 dontAsk/auto 差异决策 | 建差异表后补实现 |

总矩阵至少覆盖:

- Provider/runtime。
- Anthropic / OpenAI-compatible proxy。
- Session/transcript/event replay。
- Permissions/approval。
- File tools。
- Bash/PowerShell/REPL。
- Sandbox/workspace。
- Hooks。
- Skills/commands。
- Subagents/tasks/background tasks。
- Worktree。
- MCP/plugins。
- Context compression。
- Trace/logging。
- Error recovery。
- Frontend main workflow。
- Knowledge pack/expert mount。
- Image generation/person portrait。
- Real-material video editing。
- Generated-video removal。
- Tests/build/package/smoke/E2E。

## 6. 权限与审批闸

### 6.1 重要口径

“审批闸只卡对外/不可逆/越权/高风险动作”是用户体验目标,不是实现规格。

实现不得按一句口号自造简化版,必须以 cc 当前源码为规格源,建立差异矩阵后再迁移。任何保留本项目产品差异的地方,都必须写清楚原因和测试。

### 6.2 cc 权限体系必须对齐的概念

从 cc 源码复核:

- `PermissionMode`: `default`、`acceptEdits`、`plan`、`bypassPermissions`、`dontAsk`。
- 内部/特性门控模式:如 `auto`、`bubble`,以 cc 当前源码为准调研是否迁移。
- `PermissionBehavior`: `allow`、`deny`、`ask`。
- `PermissionResult`:含 `allow`、`ask`、`deny`、`passthrough` 等分支。
- `PermissionRule`: `alwaysAllow`、`alwaysDeny`、`alwaysAsk`。
- `PermissionUpdate`:支持 `userSettings`、`projectSettings`、`localSettings`、`session`、`cliArg` 等作用域。
- `AdditionalWorkingDirectory`:工作区外目录授权。
- Bash/PowerShell 命令规则、危险规则、分类器、安全 wrapper/env 处理。
- 文件读写规则、敏感路径、读后再写、陈旧文件检测、diff 和会话授权。
- hook、MCP、subagent、remote approval 不能绕过主权限系统。

### 6.3 本项目当前差异必须被显式处理

当前 TS 权限实现里已经有 `ts/src/permissions/types.ts`、`resolve.ts`、`approval.ts` 等基础,但它不是 cc 的完整复刻。已有文档 `ts/docs/W4a-approval-permissions-findings.md` 明确写过一些产品差异。

必须做差异表:

| 项 | cc 行为 | 本项目当前行为 | 是否保留差异 | 理由 | 测试 |
|---|---|---|---|---|---|
| 模式数量 | default/acceptEdits/plan/bypassPermissions/dontAsk + gated auto | canonical 主要 4 档 + legacy | 待定 | 需按 cc 规格补齐或说明 | permission mode tests |
| bypassPermissions | 不越过 fatal/必须交互等 | 已部分补齐 | 保留并增强 | 高危动作旁路免疫 | resolve tests |
| 文件类动作 | 由模式/规则/路径/会话授权共同决定 | 部分文件类默认放行 | 待复核 | 体验目标不能破坏路径安全 | file permission tests |
| 命令审批 | Bash/PowerShell 分类器 + 规则 + sandbox | 已迁移大量 Bash 门,未完整 | 继续迁移 | coding agent 必需 | runCommand tests |

### 6.4 审批体验目标

普通本机开发流尽量少打断,但不是无脑放行。应该通过模式、规则、会话授权和工作区授权减少重复确认。

以下动作必须确认或拒绝:

- 对外发布。
- 远程触达。
- 不可逆删除。
- 高风险命令。
- 系统级权限动作。
- 高成本动作。
- 可能泄露隐私、密钥、环境变量或本机敏感文件的动作。
- 绕过沙箱或扩大工作区权限的动作。
- 操作真实鼠标键盘、屏幕控制等必须用户交互的动作。

### 6.5 权限验收

至少补齐这些测试:

- `default` / `acceptEdits` / `plan` / `bypassPermissions` / `dontAsk` 模式切换和行为。
- bypass 不越过 fatal / forceConfirm / requiresUserInteraction。
- 工作区内文件读写。
- 工作区外目录会话授权。
- 敏感路径拒绝或确认。
- 文件写入必须读前置、陈旧检测、diff 展示。
- Bash 安全命令自动通过。
- Bash 外联、删除、shell expansion、环境泄露、重定向不明目标进入审批。
- PowerShell 高风险动作进入审批。
- MCP 工具审批。
- subagent/background task 权限继承。
- hook 可拦截或要求审批。
- UI 显示审批原因、影响范围、允许一次、本会话允许、拒绝、规则来源和必要 diff。

## 7. 工作目录与本机路径

目标行为:

1. 用户选择文件夹后,该文件夹成为默认工作区。
2. 模型默认在该目录读写和执行命令。
3. 前端目录树、右侧预览、diff、任务状态都对应该工作区。
4. 用户明确指定其他本机路径时,在权限允许下可以读取或授权该路径。
5. 不能把 agent 锁死在当前工作区,也不能无权限乱扫用户电脑。

需要对齐 cc 的:

- 工作区根路径。
- additional working directories。
- 路径规范化。
- symlink/realpath/TOCTOU。
- UNC/网络路径风险。
- 删除根目录、home、盘符根等危险路径。
- 工作区切换后的 session/transcript/command cwd 一致性。

## 8. 内核能力迁移

内核优先级高于业务 UI。以下能力必须按 cc 迁移矩阵推进:

1. 工具调用系统:tool schema、tool result、tool error、工具配对、流式事件。
2. 文件系统工具:read/write/edit/patch/diff/backup/restore。
3. 命令执行:Bash/PowerShell/REPL,含风险分类、超时、取消、输出截断、sandbox。
4. 权限和审批:上一节完整实现。
5. 工作区和沙箱:路径护栏 + OS sandbox + 网络策略。
6. hooks:PreTool/PostTool/Stop/UserPromptSubmit/SessionStart/SubagentStart/SubagentStop。
7. skills/commands:SKILL.md、frontmatter、allowedTools、渐进披露。
8. subagents/background tasks:子代理、后台任务、任务输出、停止、恢复、drill-in。
9. context compression:长上下文压缩、最近文件恢复、大工具结果落盘。
10. trace/logging:工具链路、错误、token、模型调用、审批、任务阶段可追踪。
11. error recovery:工具报错回灌、失败重试、stuck detector、拒绝后不反复骚扰。
12. provider/runtime:provider 配置、active provider 首轮生效、failover、网络代理。

## 9. 前端主工作流

前端目标是 Codex / Work Buddy 风格:简洁、专业、低噪、工具流优先。

禁止方向:

- 卡片墙。
- 营销页。
- 台球挂件。
- 装饰性台球元素。
- 把生图/视频当产品主壳。
- 把模型内部日志无结构地堆给用户。

主窗口应包含:

- 工作区选择与目录树。
- 主对话输入框。
- 可挂载专家/skill。
- 工具调用流式过程。
- 文件变更列表。
- diff 面板。
- 右侧预览或工作区反馈。
- 后台任务入口。
- 审批卡片。
- 失败和恢复状态。

代码修改体验要求:

- 工具开始时显示 pending。
- 文件修改中间态可见。
- 完成后显示 diff。
- 可打开受影响文件。
- 命令输出默认折叠,展示人话摘要。
- 失败时有可理解原因和下一步。
- 不等最终答复才告诉用户改了什么。

## 10. 专家/知识库/skills

本项目默认是通用 coding agent 桌面外壳。台球运营专家只是可挂载领域包。

要求:

- 输入框附近提供专家/skill 选择或挂载入口。
- 至少支持“台球运营专家”。
- 专家挂载应影响上下文、检索范围、工具策略或系统提示词,不能只是 UI 文案。
- 专家和 skills 后续可扩展。
- 不做台球装饰挂件。
- 知识库回答必须能说明来源。
- 店铺文件、行业知识、门店记忆要分层展示。
- 没检索到的事实要明确说没看到。

需要翻旧调研:

- Work Buddy 的专家入口。
- Claude Code / Codex 的 skills、subagent、slash command 入口。
- Trae / Qoder 的工作区与智能体入口。
- 本项目已有竞品拆解文档。

## 11. CD/Seedance 2.0 AI 视频生成模型功能删除

### 11.1 当前已发现的相关入口

执行前需要重新 `rg` 核对,目前已知包括:

- `ts/src/media/mediaTools.ts`: `generate_video` 工具。
- `ts/src/media/mediaJobs.ts`: `i2v` / Seedance gateway 任务。
- `ts/src/media/mediaJobs.test.ts`: Seedance gateway 测试。
- `ts/src/server/index.ts`: 当前 `/api/v1/studio/i2v` 兼容路由,也属于删除目标。
- `ts/src/server/index.test.ts`: legacy studio i2v 测试。
- `server/services/video_service.py`: AI 文生视频/图生视频服务。
- `server/services/ai/providers/ark_video.py`: Ark/Seedance provider。
- `server/api/v1/studio.py`: `/studio/i2v`。
- `server/services/agent/tools.py`: Python `generate_video` 工具。
- `server/tests/test_ark_video_provider.py`、`test_studio_router.py`、`test_generate_video_job.py` 等相关测试。
- `web/src/app/dashboard/video/VideoWorkspace.tsx`: “用这张图生成视频”/handoff i2v UI。
- `web/src/lib/api.ts`: `studioI2v`。
- `desktop/e2e-pw/run.js`: 图生视频 E2E 断言。
- `gateway/app.ts` / `gateway/README.md`: Seedance 透传代理。
- `desktop/bundled.env.example`、`server/config.py`、`server/api/v1/stores.py`: `Seedance 2.0` 标签/配置。
- 文档中所有 Seedance/CD 生成视频主线描述。

### 11.2 删除原则

删除不是把所有视频能力删掉,而是把 CD/Seedance 2.0 这整条 AI 视频生成模型功能直接删掉。不要做禁用开关、兼容旧路由或“以后可能恢复”的保留实现。

保留:

- 视频工作台页面。
- 本地真实素材剪辑。
- 视频任务后台化。
- 视频导入、探测、自动方案、渲染、导出。
- 未来基于真实素材的 agent 编排。

删除:

- 文生视频。
- 图生视频。
- 用图片生成视频。
- 让图片动起来。
- `generate_video` 工具。
- `/studio/i2v` 等生成视频 API 路由。
- Seedance/CD 任务提交、轮询、下载、落库链路。
- Seedance/CD 网关透传代理。
- CD/Seedance 2.0 生成视频配置、模型标签、工具说明、测试、E2E。

### 11.3 删除验收

必须验证:

- 前端没有“用这张图生成视频”“让图片动起来”入口。
- agent 工具列表不再暴露 `generate_video`。
- API 不再提供 `/studio/i2v` 这类生成视频路径;不做兼容保留路由。
- 后端不存在继续提交/轮询 CD/Seedance 2.0 视频生成任务的运行链路。
- 网关不再提供 Seedance/CD 视频生成透传代理。
- 配置和设置抽屉不再展示 Seedance/CD 2.0 作为视频生成模型。
- E2E 不再断言图生视频承接。
- 文档不再把 CD/Seedance 2.0 作为产品主线。
- 真实素材剪辑相关测试仍通过。

## 12. 真实素材剪辑工作台

真实素材剪辑是保留并强化的方向。

核心流程:

1. 用户导入手机实拍视频。
2. 系统探测素材:时长、分辨率、fps、音频、格式。
3. 转写/识别口播。
4. 识别高光片段。
5. 生成剪辑策略。
6. 用户确认或对话修改策略。
7. 生成 timeline/EDL。
8. 渲染。
9. 自检。
10. 导出成片。

应该吸收 video-use 的剪辑方法:

- 先读 transcript 和素材索引。
- 大素材压成 takes/timeline 摘要。
- 剪辑前有 strategy confirmation。
- 按词边界剪口播。
- 片段两侧留 padding。
- 小 fade 避免硬切。
- render 后做自检。
- 输出和中间产物有项目目录。

需要补的产品能力:

- 多素材导入。
- 素材列表。
- 转写状态。
- 方案预览。
- 时间线摘要。
- 字幕预览。
- 右侧视频预览。
- 对话式修改。
- 导出状态。
- 失败重试和错误解释。

## 13. 生图与人像优化

生图是插件式延伸能力,不是产品主壳。

重点场景:

用户上传一张门店助教照片,照片可能普通、光线差、构图差、表情不理想。系统帮助用户生成更适合门店宣传的人像/形象照/商业宣传图。

研究和实现重点:

- GPT Image 2。
- Seedream / 豆包图像模型。
- 人像优化。
- 输入图质量检测。
- 肖像授权确认。
- 人物一致性。
- 真实感。
- 过度美化风险。
- 手、脸、肢体错误检测。
- 商业可用性。
- 失败兜底。
- 批量生成与并发。
- 成本控制。
- 生成结果质检。
- 前端对比预览。
- 版本选择、重生成、回滚。

合规口径:

- 不做未经授权的身份冒充。
- 不把“换脸/深度伪造”作为卖点。
- 明确用户应拥有上传照片使用授权。
- 对真人照片相关生成结果做风险提示和质检。

模型策略暂不写死:

- 图片理解、coding agent、剪辑编排、图像生成可以走不同模型。
- 前端是统一对话框,后端需要模型路由。
- 不把纯文本模型当成图片理解入口。

## 14. 文档更新规则

必须同步:

- `docs/当前目标与文档口径-2026-07-07.md`。
- `docs/plans/TS-cc-haha-v0.4.5-内核迁移矩阵-2026-07-07.md`。
- `CLAUDE.md`。
- `ts/CLAUDE.md` / `ts/AGENTS.md`。
- `docs/README.md`。
- 与视频、生图、剪辑、权限、前端 UI 相关的现行文档。

必须清理:

- 旧限制 cc-haha 复制/移植的口径,统一改为“可直接复制/移植/改写”。
- 把 CD/Seedance 2.0 生成视频当主线的描述。
- 引入不存在于本项目的 AI 视频生成模型名,导致清理范围跑偏。
- 过时任务文档。
- 已退役 Python 或已删除功能的说明。

文档原则:

- 活文档反映当前事实。
- 任务文档完成后归档。
- 旧文档可保留历史,但必须标明历史/作废。
- 不让下一轮 agent 被旧文档误导。

## 15. 测试与验证

每迁移一个模块,必须先找 cc 对应测试或边界用例,再在本项目补测试。

最低测试门:

- `cd ts && bun test`
- `cd ts && bun run typecheck`
- 相关单测按模块单独跑。
- 前端改动跑对应 typecheck/test。
- UI 改动做截图或浏览器验证。
- 视频真实素材剪辑跑 smoke 或等价端到端。
- 权限/审批跑边界测试。
- 删除 CD/Seedance 2.0 AI 视频生成模型功能后跑回归,证明真实素材剪辑没坏。

如果某些测试因为环境、密钥、模型成本、真机依赖不能跑,必须记录:

- 没跑什么。
- 为什么没跑。
- 风险是什么。
- 后续如何补。

阶段完成前必须有一轮总验证:

- 后端/TS 单测。
- 类型检查。
- 构建或 sidecar build。
- 关键前端截图/Playwright smoke。
- 真实素材剪辑 smoke。
- 关键权限 E2E 或单测矩阵。
- 文档一致性检查。

## 16. 提交要求

直接在 `main` 上施工。每个提交对应一个清晰能力块。

建议提交块:

1. 文档口径与迁移矩阵校准。
2. 权限模式差异矩阵和第一批行为测试。
3. cc 权限规则/目录授权迁移。
4. CD/Seedance 2.0 AI 视频生成模型功能删除。
5. 真实素材剪辑工作台保留与增强。
6. video-use 方法论吸收。
7. 专家/知识库挂载入口。
8. 生图人像优化流程和测试。
9. 前端低噪工具流 polish。
10. 总测试和文档收尾。

提交信息必须说明:

- 改了什么能力。
- 对应测试。
- 文档是否更新。
- 是否还有未完成项。

## 17. 阶段性完成标准

只有同时满足以下条件,才能说阶段完成:

1. cc 能力迁移矩阵无明显遗漏。
2. 未完成项都有明确原因和后续路径。
3. 权限/审批体系不是口号实现,而是有 cc 对照、差异表和测试。
4. 核心 coding agent 能力有测试兜底。
5. 工作区、文件读写、命令执行、工具调用、hooks、skills/subagents、后台任务、上下文压缩、trace、错误恢复等关键路径可用。
6. CD/Seedance 2.0 AI 视频生成模型功能已完整删除,且没有引入不存在于本项目的生成视频模型名。
7. 真实素材剪辑链路保留并增强。
8. browser-use/video-use 已完成适配研判,适合的编排思想已进入本项目方案。
9. 生图/人像优化有明确流程、质量标准和风险边界。
10. 前端主工作流符合 Codex / Work Buddy 式低噪工具流。
11. 台球运营专家是可挂载专家,不是装饰主壳。
12. 文档、测试、提交历史与当前目标一致。
13. 没有已知破损功能。
14. 没有未验证的关键路径。
15. 没有明显瑕疵品体验。

## 18. 执行 agent 最终答复格式

阶段完成或每轮阶段性汇报时,最终答复必须包含:

```text
完成内容:
- ...

验证:
- 已跑: ...
- 未跑: ... 原因: ...

迁移矩阵:
- 已完成: ...
- 未完成: ...

风险:
- ...

下一步:
- ...
```

不要只说“已完成”。必须给证据。
