# BilliardBuddy 总任务：以 Coding Agent 内核重做产品

> 这是当前唯一的总迁移指令。目标、已有源码和已经验收是三件事，不得混写。

## 一句话目标

直接在当前 `dev` 开发线完成新的 BilliardBuddy：

```text
按 Codex 中文桌面端信息架构与交互重新实现的 BilliardBuddy 前端
  +
当前已导入的 CC-HH Coding Agent 能力内核
  +
当前产品网关、语音、媒体和球房领域能力
  =
唯一的 BilliardBuddy 桌面产品
```

保留的是 CC-HH 带来的 Coding Agent 能力内核，不是 CC-HH 的 renderer，也不是它围绕 renderer 形成的产品状态和接口形状。前端全部按 Codex 中文桌面端的任务、项目、线程、归档、分叉、审阅、文件、浏览器和终端信息架构重新做一轮；随后围绕新前端重构 BilliardBuddy 应用层，把 Agent 能力接入新产品。CC-HH 的页面结构、导航、样式、用户交互和旧产品层假设都不作为最终架构前提。

“按 Codex 重新做”是根据本机实际分发的前端 bundle 反推组件职责、状态层次和交互契约，再由 BilliardBuddy 自己实现可维护源码；不是把混淆 bundle 直接塞进产品，也不是复制 Codex 品牌、图标或服务端协议。

这是一个可以用多个子代理并行完成的大任务，但最后必须收口为一套前端、一套状态、一套 Agent 链路和一个可打包产品。

## 开工位置与历史事实源

唯一正式开发、测试和后续打包位置：

```text
/Users/swl/Desktop/billiardbuddy
branch: dev
```

当前 `dev` 是基于旧 `main` 继续演进的新产品开发线，已经包含导入的 Coding Agent 底座与后续产品修改。`/Users/swl/Desktop/bb-cc-haha-migration` 已不是当前开发目录，不得再按旧文档将任务派到那里。

### 开发参照物总清单

下表是本轮允许使用的完整开发参照清单。没有列入清单的旧目录、阶段文档、临时报告、截图实现、adapter 草稿和历史约定，不得自行提升为架构事实源。

| 参照物 | 固定位置或版本 | 只允许解决的问题 | 禁止做法 |
|---|---|---|---|
| 当前正式代码 | `/Users/swl/Desktop/billiardbuddy` 的 `dev` | 新产品实现、测试和最终打包 | 不再把其他 worktree 当成开发主线 |
| Codex 前端本地逆向参考 | `codex-frontend-reference/26.715.31925/`；`raw/webview` 4,909 个文件，`reverse-readable` 24 个可读文件 | 前端信息架构、任务生命周期、中文表达、组件职责和交互行为 | 不复制品牌、图标、账号体系、云端协议或混淆 bundle；不进入构建和安装包 |
| 旧 BilliardBuddy 前端 | `main@2d6c88dc2639eca9fe5efbcb39136e1ef21991c1` 的 `ts/desktop/renderer-react/src`，共 128 个文件 | 用户认可的品牌、深浅主题、输入框感受、旧生图/视频工作台视觉和交互证据 | 不恢复为第二套 renderer，不搬回旧 Agent loop、旧 store 或旧接口 |
| 旧产品能力快照 | `legacy/dev-before-cc-haha@1bcaafb594c99e042343f7e9a9d067a197ee35ca`；相关 Skill、知识、媒体和旧前端约 174 个文件 | 选择性核对旧 Skill、媒体工作台、品牌资产和业务能力是否遗漏 | 只迁移仍有产品价值的能力，不机械恢复旧流程、强制 RAG、旧权限、旧 API 或旧 Agent 架构 |
| Coding Agent 内核参考 | `/Users/swl/Desktop/cc-haha-ref@d318b1b49213b9a0445f82681876003580e41263` | 核对 Agent 循环、工具、子代理、Skill、Plugin、MCP、Hook、权限、上下文、CLI 和会话机制 | 不使用其 renderer 或产品状态模型，不整树覆盖当前 `ts/`，不机械同步后续提交 |
| 当前 Agent 与产品接线 | `ts/src`、`ts/shared`、`ts/desktop/electron`、`ts/desktop/src` | 识别当前生产者、传输、消费者、IPC、REST/WS 和桌面宿主的真实调用链 | 当前能跑不等于目标架构必须保留；过渡产品层允许重构和删除 |
| 网关与服务器部署入口 | `gateway/*.ts`、`gateway/deploy.sh`、`relay/*.ts`、`relay/deploy.sh` | 模型、视觉、语音、容量、凭据、图片 relay 和部署事实 | 不根据旧报告猜服务器状态；部署或真机测试前重新读取代码并核验真实服务器 |
| 当前媒体链 | `ts/desktop/src/components/media/`、`ts/src/server/services/mediaProjectService.ts`、`ts/src/tools/MediaWorkbenchTool/`、`relay/` | 生图/视频工作台、任务状态、素材、预览、导出与 Agent Tool 的现有证据 | 不因文件存在就宣称可用，不把媒体字节塞进 LLM 网关 |
| 当前球房能力 | `ts/src/skills/bundled/billiardsKnowledge.ts`、`billiardsOperations.ts`、`bossRecruiting.ts` | 去来源后的经营知识、业务确认框架和 Skill 触发方式 | 不恢复原始资料身份、机械浏览器步骤、固定评分或每轮强制检索 |
| 当前产品品牌资产 | `ts/desktop/public/app-icon.*`、`ts/desktop/src-tauri/app-icon*`、`ts/desktop/src-tauri/icons/` | BilliardBuddy 图标、品牌和打包资产 | 不从 Codex 或 CC-HH 复制品牌资产 |

原始台球资料不属于后续开发窗口的直接参照物。运行时重新整理后的 `billiardsKnowledge.ts` 是唯一可进入 Agent 上下文的球房知识事实源；原始资料名称、人物、机构、案例身份、页码和整理记录不进入仓库或产品。

参照物只用于判断目标和迁移价值，不是要在工作树里长期复制一份。Codex 解包目录保持本机只读并排除 Git；旧 BilliardBuddy 通过固定 Git 提交/分支读取；CC-HH 通过外部只读参考仓库读取。最终产品源码不得包含这些参照物的重复副本。

Codex 安装包没有 source map，也没有原始 TypeScript/React 工程。反推时必须区分“安装包真实行为”“根据 bundle 推导的组件边界”和“BilliardBuddy 自己的实现方案”，不得把推导结果伪称为官方源码。视觉是否达到用户要求最终由用户本人验收，不得由截图相似度或自动审查替用户下结论。

开工前先读 `git status`。当前工作树已有前端调整和文档清理，不得盲目回退、stash 覆盖或整目录替换。未经明确要求，不新建分支、不合并 `main`、不 push、不发布安装包。

## 开发权限与实现方法

### 依赖安装

- 允许安装完成开发、构建、逆向分析、类型检查、测试、媒体处理和桌面打包所需的全部依赖，不需要因为“仓库原来没有”而退回低质量临时实现。
- JavaScript/TypeScript 依赖使用当前仓库的包管理器并同步更新对应 `package.json` 与 lockfile；系统工具、原生模块和 sidecar 依赖按真实平台要求安装和接线。
- 新依赖必须有明确运行消费者或开发用途；发现选型错误时删除依赖、配置、生成物和死调用，不长期保留两套同类库。
- `node_modules`、构建缓存和本地逆向产物仍属于可重建文件，不提交进 Git，也不打进不需要它们的安装包。

### Codex 前端驱动产品重构

核心路径不是“保留 CC-HH 后端产品形状，再给旧前端换皮”，而是：

```text
Codex 前端真实信息架构、状态与交互
  → 反推出 BilliardBuddy 需要的项目/任务/运行/产物/面板语义
  → 重构 BilliardBuddy 应用服务、REST/WS/IPC、持久化和事件链
  → 通过 Agent Core Adapter 接入保留的 Coding Agent 内核
  → 由新的 BilliardBuddy 前端消费真实结果
```

- 前端风格直接对标本机 Codex 的布局层级、信息密度、留白、组件职责、主题行为、状态反馈和整体克制感；旧 BilliardBuddy 只补充品牌蓝、Logo、输入框手感和用户已经认可的局部视觉。
- 前端文案以 Codex 实际 `zh-CN` 语义为第一参考，但不能先写漂亮文案再倒逼后端造假。每个标题、菜单、状态、按钮、提示、错误和空状态，先确认它对应的领域状态、后端动作、权限边界、成功证据与失败恢复，再写普通球房用户能理解的中文。
- 前端交互直接对标 Codex 的新建任务、项目/任务索引、置顶、重命名、归档/恢复、继续任务、侧边任务、worktree、Composer、工具活动、审批、Diff、文件、Browser/Preview、Terminal 和多面板协作；布局和交互语义对标，品牌资产与专有云服务不复制。
- Codex 有交互而当前后端没有真实语义时，先补 BilliardBuddy 产品领域模型与应用服务，再展示入口；不能用假按钮、前端临时状态或旧 session 字段硬凑。
- Agent 内核继续负责理解、推理、工具、权限、子代理、Skill、Hook、MCP、上下文与执行循环。为匹配 Codex 前端而重构的是 BilliardBuddy 产品后端和应用层，不把任务/归档/面板等 UI 状态塞进 Agent 循环。

## 已核实的当前源码状态

- 当前唯一 React renderer 是 `ts/desktop/src`，入口是 `ts/desktop/src/main.tsx`。
- 当前 renderer 源自 CC-HH 产品层，夹有多轮未完成的 BilliardBuddy 视觉修改；它只作为当前后端消费关系和功能清单的过渡实现，不再作为新前端的页面基础。
- 当前 renderer 已消费真实的会话、REST、WebSocket、工具、审批、附件、Skills/Plugins/MCP、Workspace/Diff、Browser/Preview、Terminal 和 Computer Use 数据链。这些代码是盘点真实能力和调用链的证据，不代表现有接口、store 或事件外壳必须原样保留。
- 当前对话链使用 `/api/sessions/*` 与 per-session WebSocket `/ws/:sessionId?token=`。这是过渡实现事实，不是新产品不可修改的契约。重构可以重新定义 BilliardBuddy 的产品 API、事件和状态，只要 Agent 内核运行语义、工具循环、权限和会话恢复能力不被降级。
- 当前 Agent 内核已有子代理、Task/后台任务、worktree、文件和 shell 工具、Skills、Plugins、MCP、Hooks、权限、Plan Mode、上下文压缩、会话恢复、Web Search/Fetch、Browser/Preview 和 Computer Use 相关源码。
- 当前 Server/ConversationService/Provider Proxy 与产品网关源码已存在。代码默认文本模型为 DeepSeek V4 Flash，MiMo v2.5 负责原生视觉/视觉桥接，Qwen3-Coder-Plus 保留路由，语音只走 Fun-ASR-Flash，Whisper 不得恢复。
- ImageWorkbench、VideoStudio、媒体 API/Tool、图片网关/relay 和台球领域 Skill 相关源码存在；但“有源码”、“有测试”、“已接线”和“安装包真机可用”不是同一件事，本文档不提前声称它们已完成。

## 不可改变的产品边界

### 保留的是 Coding Agent 能力

保留并继续接通：

- Agent 循环、工具执行、子代理、Task/后台任务、团队协作和 worktree。
- 文件、命令、编辑、搜索、网页、Browser/Preview、Terminal 和 Computer Use 能力。
- Skills、Plugins、MCP、Hooks、权限、Plan Mode、上下文管理和会话恢复。
- CLI 和 GUI 两种运行方式。当前先完成桌面端，但 CLI/sidecar 能力不降级。
- Electron 宿主安全边界、sidecar/CLI 启动、终端、Browser/Preview、Workspace/Diff 和 Computer Use 的真实能力。preload/IPC 和应用侧调用形状可以随新产品层重构。
- Provider Proxy、Anthropic/OpenAI/MCP 等上游通用协议、产品网关和 Agent 内核必须依赖的语义。现有 Server/ConversationService、REST/WS/SSE 的产品外壳可以拆分或重写。
- Agent 自动发现项目指令的能力。`CLAUDE.md`、`.claude/rules`、`AGENTS.md` 和 `BilliardBuddy.md` 的兼容应在会话/启动边界处理，不破坏通用协议。

`CLAUDE.md`、`ANTHROPIC_*`、Anthropic/OpenAI/MCP 字段可能是运行协议，不是用户可见品牌。不得为了扫关键词破坏协议。

底座不是“永远一行不改”。可以修复真实 bug，也可以为安全、网关、产品指令和前端接线增加窄适配；但任何修改都不能降级 Agent 的自主判断、工具、权限、Skill、Hook、上下文或子代理机制。

### 必须重做的是产品与应用层

可以根据 BilliardBuddy 需求自由调整：

- 前端布局、视觉、品牌、文案、导航和工作台。
- BilliardBuddy 的项目、任务、线程、运行、产物和面板领域模型。
- 应用服务、前端 API/store、事件协议、Electron IPC 与 Agent 内核适配层。
- 产品网关、模型路由、凭据管理、媒体 relay 和用户入口。
- 台球运营 Skill、按需知识资源、生图/视频工作台和未来多渠道入口。

Telegram、飞书、微信、H5 等只是会话的外部入口/输出渠道，不属于 Agent 核心循环。未来可以独立增删，不影响 Agent 对任务的理解和执行。当前桌面端优先，不因未来渠道拖慢主线。

## 前端总任务：按 Codex 重做前端 + 接当前 Agent 后端

这是现阶段第一优先级。

### Codex 反推出来的前端骨架

新前端必须重新建立下面这些明确层次，不能继续沿用 CC-HH 页面后局部换皮：

1. 项目索引：项目、工作目录、任务、worktree 和远程环境分别建模，不能都压成一个“会话”。
2. 新建任务：独立的新任务页面负责选择项目/目录、运行位置、附件、权限和初始 Composer，不通过清空旧聊天模拟。
3. 任务页面：一个 task/thread 对应稳定 ID，内部包含多轮消息、工具活动、审批、子代理、状态、输入框和恢复能力。
4. 任务生命周期：新建、置顶、重命名、归档、恢复、复制链接/ID/Markdown、继续任务和打开新窗口必须有真实状态变化。
5. 多线程与分叉：继续任务可以落在当前工作区、新任务或新 worktree；侧边对话是临时 fork，不得与普通任务混为一类。
6. 审阅区：Diff、文件预览、图片/视频预览、Browser/Preview、Computer Use 与任务 ID 绑定，不是孤立页面。
7. 运行区：Terminal、后台任务、Plan、权限请求和工具进度由当前 Agent 事件驱动。
8. 导航与布局：Codex 的项目/任务索引、中央任务流、右侧审阅/预览和可展开运行区是信息架构参考；具体尺寸、主题和视觉细节由 BilliardBuddy 自己实现并由用户验收。

### CC-HH 前端如何退出

- 不保留 CC-HH 的页面结构、导航、设置布局、样式 token、品牌组件和聊天壳作为新界面基础。
- 先从现有 renderer 盘点真实 API client、WebSocket 解码、IPC、store 数据和各能力消费者，形成新前端 adapter；不能先删后端接线再猜。
- 纯协议、类型、事件解码、安全边界和无视觉状态逻辑可以迁入新结构；带 CC-HH 交互假设的页面组件必须重写。
- 新页面逐项接通后，删除不再被消费的 CC-HH 页面、组件、样式、路由和对应旧测试。
- 最终仍只有 `ts/desktop/src` 一个入口，不恢复旧 `renderer-react`，也不让逆向 bundle 参与构建。

### 应用层与 Agent 内核重构原则

这不是在 CC-HH 现有产品上补几个接口，也不是只写一个前端 shim。应先按新前端需要定义 BilliardBuddy 自己的 `project/thread/worktree/run/turn/artifact/panel` 领域模型，再建立应用服务和事件协议，最后由单独的 Agent Core Adapter 驱动 CC-HH Coding Agent 内核。

新产品层负责：项目与任务索引、任务生命周期、中文标题与状态、归档/恢复、分叉关系、worktree、面板、产物、桌面 IPC 和前端可消费事件。Agent 内核负责：理解任务、上下文、工具调用、权限、子代理、Skill/Hook/MCP 和执行循环。两层之间按语义连接，不让 CC-HH 原页面结构反向决定新产品模型。

现有 `/api/sessions/*`、WebSocket、store、ConversationService 和 Electron IPC 只能作为迁移素材：合理的底层能力可以抽取，不合理的产品假设直接删除或重写。不得为了减少改动长期保留两套状态、两套事件或一层层临时兼容 shim。

Codex bundle 只告诉我们前端应该有哪些概念和交互，不授权把 Codex 的服务端 API、账号体系或云端状态搬进产品；也不得为了模仿 Codex 改写或削弱 CC-HH Agent 内部循环。

### 前端必须保留的真实能力

- 会话创建/恢复、项目选择、worktree、多标签和任务状态。
- 流式文本、工具调用树、子代理、权限请求、AskUserQuestion、中断和上下文状态。
- Composer、附件/图片、文件引用、斜杠命令、Skill/Agent 发现和发送/停止。
- Workspace 文件树、文件预览、Diff、Browser/Preview、Terminal 和 Computer Use。
- 图片和视频预览与专业工作台入口。
- 必需的 Skills、Plugins、MCP、Hooks、权限和运行设置。高级设置可以收起，能力不能删除。

### 普通用户界面的表达原则

- 默认语言为简体中文，优先参考 Codex 安装包真实的 `zh-CN` 文案语义，再改写成 BilliardBuddy 产品表达；英文作为可选语言和内部标识兼容，不得让主界面中英混杂。
- “任务、项目、归档、继续任务、侧边任务、工作目录、工作树、审阅、终端”等核心概念必须统一翻译。普通球房用户不必直接看到 `thread`、`fork`、`worktree`、`provider` 等内部词。
- 用户说业务目标，不先选模型、Provider、Skill、MCP、Playwright 或脚本。
- 前端不展示模型名、Provider 名、Claude 登录、上下文 token、隐藏 system prompt、hook 注入文本或原始思考正文。
- 可以显示简洁的“正在思考”、工具活动、审批、进度、失败和真实执行结果，但不泄露内部提示和原始推理。
- 前端文案用球房工作人员能理解的普通话，但不能把产品做成简陋聊天壳或低级“球房管理系统”，也不需要到处放台球装饰。
- 深色/浅色随系统切换必须保留；不能把品牌蓝理解为整个界面永远固定成蓝色。
- 新建任务 Composer 与任务内 Composer 可以处于不同页面状态，但必须共享同一套输入能力、快捷键、附件和发送规则。
- 所有可见文案都必须有真实后端语义：先定义状态和动作，再确定中文表达；不得用文案掩盖未实现、失败或仍是临时兼容的能力。

## Skill 与台球知识的正确边界

Skill 是 Agent 按需读取的业务经验、任务目标、风险边界和完成证据，不是预先写死的流程引擎。Agent 可以根据当前环境自主选择浏览器、MCP、连接器、命令、脚本、代码或工作台。

- 台球运营知识做成运行时去来源标识、可渐进读取的 Skill 参考资源，只在相关任务中按需加载。不常驻 system prompt，不每轮强制检索，不把案例经验当成当前门店事实。
- 原始资料名称、人物、机构、案例身份、页码和整理记录不进入 Git、安装包、模型上下文或普通用户界面；运行时只保留重新组织后的经营方法、决策变量和风险边界。
- 用户和本店真实资料永远高于通用台球经验和方案参考值。
- 文字和知识型 Skill 可以较轻；涉及浏览器、外部账号、付费、生图、视频导出的 Skill 必须核对真实工具和完整执行链，不能只写一段流程文字就声称能用。

### BOSS 招聘

旧 BOSS Skill 的固定评分、机械自动跟进、写死页面步骤和假定 Playwright 一定可用的逻辑取消，不机械迁移。

如果未来保留招聘能力，必须重做成 Agent 主导的 Skill：

1. 根据真实岗位和页面准备草稿、候选人事实和批次队列；
2. Agent 现场选择真实可用的 Browser、Playwright/MCP、Computer Use、脚本或人工接管；
3. 登录、验证码、发布和联系真人前让用户确认；
4. 执行后重新读取页面或工具结果，不把“准备了”写成“已联系”。

在真实执行工具和页面适配未核对前，BOSS 不是当前前端迁移的阻塞项，也不得标记为已完成。

## 生图与剪视频的正确架构

生图和剪视频是“Agent + Skill + 确定性工具 + 必要工作台”，不是把整套媒体引擎写进 Agent 核心循环。

### 生图

- Skill 负责理解用途、尺寸、文字、品牌、参考图和验收标准。
- 工具/服务负责真实生成、编辑、幂等、任务状态、取消、失败和结果存储。
- 工作台负责参考素材、多版本、预览、微调、下载和用户确认。
- 文本 LLM 请求不过度人为限流；昂贵生图请求必须保留上游容量保护、幂等、单用户/全局在途上限和防重复扣费。

### 剪视频

- Skill 负责理解素材、镜头顺序、剪辑目标、字幕、音乐、封面和输出要求。
- 本地确定性媒体服务负责素材检查、时间线、FFmpeg/ffprobe、预览、取消和导出，不把视频字节经 LLM 网关传输。
- 工作台负责需要连续状态的素材管理、时间线、预览、版本和导出位置。
- 字幕、转场、音频、封面和镜头分析是可逐步增强的工具能力，不应在上游未验证时在 Skill 中虚构完整效果。

本轮开发先把边界和数据链做对，不做真实付费生图、真视频导出和安装包真机验收。不得因此声称媒体能力已经上线。

## 模型、视觉、语音和网关边界

- 真实上游 API key 只放服务器网关，不进 renderer、Git、日志或普通用户设置。
- 桌面端只连 BilliardBuddy 产品网关或用户明确配置的通用 Provider，不先连 CC-HH 私有服务再中转。
- 普通用户前端不展示 DeepSeek、MiMo、Qwen 等技术模型名；模型增减、路由和容量保护由网关内部管理。
- 会话/工具循环不在中途静默换供应商；上游失败应返回明确错误，避免模型能力、思考和工具上下文丢失。
- 普通图片交给 MiMo 视觉能力/桥接；文本模型不能被假装成原生看图模型。Computer Use 截图回合需要保留像素和坐标语义。
- 语音只经 Fun-ASR-Flash 转写并回填 Composer，不自动发送，不恢复 Whisper。
- 后期可以增加多供应商、多 key 和更大服务器容量，但客户端协议保持稳定；当前不为未来 50–100 用户过度重写整个架构。

## 品牌、清理和许可边界

用户可见产品身份只能是 BilliardBuddy。最终清理：

- CC-HH 的 renderer 布局、页面、样式、演示内容和只为其旧界面存在的无消费组件。
- `cc-haha`、`Claude Code Haha`、`Claude Code Companion`、`claude-haha`、`NanmiCoder` 等用户可见品牌、宣传、更新源和私有服务链接。
- 被替代的旧 Agent loop、机械 workflow、强制 RAG、旧 renderer、旧 API/store 和无产品消费者的外围模块。
- 代码中无价值的“参照 Codex/CC-HH”、迁移过程和已过时作者品牌注释。

### 重构完成后的唯一代码形态

这轮不是在仓库里长期并排维护“旧 BilliardBuddy + CC-HH 产品 + 新 BilliardBuddy”。目标工作树、构建产物和安装包最终只能保留：

1. 一套位于 `ts/desktop/src` 的 BilliardBuddy renderer；
2. 一套 BilliardBuddy 的 `project/thread/worktree/run/turn/artifact/panel` 产品领域模型；
3. 一套直接服务该领域模型的应用服务、REST/WS/IPC 和事件链；
4. 一个边界清楚的 Agent Core Adapter；
5. CC-HH 带来的 Coding Agent 内核能力；
6. BilliardBuddy 自己的网关、媒体工具/工作台、球房 Skill 和产品资产。

下面这些内容在替代链路接通后必须从当前工作树删除，不能改名后继续保留：

- CC-HH renderer、页面路由、导航、样式、产品 store、设置页面、演示数据和只服务其旧产品状态的组件；
- 旧 BilliardBuddy Agent loop、旧单例 chat store、旧 `/api/v1/agent/*`、旧 `/agent/ws`、机械 workflow、强制 RAG 和旧权限/提示拼装；
- 为过渡接线产生但已经失去消费者的 adapter、shim、双写状态、旧事件翻译和兼容路由；
- 被删除页面、旧 API、旧 store 和死模块专用的测试、fixture、文案、样式与构建脚本；
- 阶段报告、迁移记录、基线审计、截图实现、实验分支副本和没有运行消费者的临时代码。

旧代码“彻底删除”指最终开发工作树、构建输入、构建产物和安装包中不再存在或引用。固定历史提交和外部只读参考仓库只在迁移期间提供证据，不复制进产品；正常 Git 删除不会抹除历史提交，不为清理产品源码重写整个 Git 历史。

### 按重构思维完成替换

每个模块都按同一顺序处理，禁止先堆新壳、最后再赌一次性清理：

1. 标出当前生产者、传输、消费者、持久化、权限边界和对应测试。
2. 判断该能力属于 Agent 内核、BilliardBuddy 产品层、可复用基础设施，还是应退役旧代码。
3. 先定义新产品领域状态和唯一契约，再实现新的生产者与消费者。
4. 用一条真实纵向链接通新前端、应用服务、Agent Core Adapter 和内核能力。
5. 切断旧消费者和双写，迁移必要持久化数据；不保留长期 shim。
6. 在同一次模块收口中删除被替代的旧页面、store、API、事件、测试和死依赖。
7. 运行受影响模块的类型检查、聚焦测试和真实界面核对，再继续下一条链。

删除前必须确认没有真实消费者；确认被替代后就直接删除，不因为“以后也许有用”留在当前源码树。需要回看时从上面的固定参照物读取，不在产品目录里保存废旧副本。

清理不是简单全局替换：

- `CLAUDE.md`、`ANTHROPIC_*`、Anthropic/OpenAI/MCP 字段如果是通用协议或兼容入口，必须保留。
- 配置目录、路由、环境变量、localStorage、缓存和诊断键如果在运行，要按生产者—传输—消费者整链修改，不能只改显示文字。
- 源自第三方依赖、字体、内嵌源码、运行时和实际分发代码所依赖的 LICENSE/NOTICE/版权声明，按其真实许可要求保留。这些法律声明不等于在产品界面展示他人品牌。
- 仓库中的 `ts/LICENSE` 是简短宽松授权文本，本身没有写明归属展示条款；是否替换或删除应与实际分发代码和其他第三方许可分开判断，不把它当成品牌文案。

`node_modules`、`dist`、缓存和解包参考不是手工维护的产品源码。它们不进 Git，可根据 lockfile/构建重建；不能在不读构建链的情况下把依赖目录当成废旧代码删了就结束。

## 文档与测试的处理

- 项目级说明只保留根 `README.md`、这份唯一总迁移指令和源码中真正需要的部署入口；不再维护重复的子目录 README、旧开发规范或多套架构说明。
- 运行时 Skill 自带的 `SKILL.md`、按需 references、协议参考，以及真实分发依赖要求保留的 LICENSE/NOTICE，不属于旧项目文档，不能为了清目录误删。
- 清理对象只限会误导开发方向的项目级旧文档、旧规范、旧质量门和外部开发脚本。产品自身的 Agent、子代理、Task/计划任务、工具、Skill、Plugin、MCP、Hook、提示机制、权限、上下文、CLI、协议参考及其有效测试，默认属于产品能力，不能因为名称中出现 Claude、Codex、Agent 或旧兼容字段就删除。
- Claude Code 和 Codex 本身也是 Agent 产品与能力参照。判断一个文件是否删除，必须先确认它是“开发过程规则”还是“产品运行能力”；存在真实运行消费者或承担 Agent 语义的内容先保留并接入目标架构，只有被新链路替代且确认无消费者后才能删除。
- 不新建 Phase 2E/2F、开工报告、执行日志、质量门说明等成批中间文档。
- 旧任务、阶段完成度、过期架构契约和会引导其他窗口改错位置的文档直接删除。
- 测试源码本身不是废文件。保留能验证 Agent 契约、网关、安全边界和真实用户交互的测试；删除仅验证已退役页面、旧 API 和死代码的测试。
- 不重建大型质量门、覆盖率台账或导入基线审计。修改时运行受影响模块的 TypeScript、聚焦测试和界面核对，不让测试建设取代产品主线。

## 直接执行顺序

### 1. 先按 Codex 重做前端

1. 读取 `codex-frontend-reference/README.md`、完整 raw bundle 和高价值可读 chunk，先列出 project/thread/worktree/run/turn/panel 的状态关系及用户动作。
2. 对照“开发参照物总清单”，盘点当前代码中真正属于 Agent 内核的能力，以及 renderer、Server、ConversationService、REST/WS、store、IPC 中只为 CC-HH 产品层服务的部分；不能把“现有能跑”误判为“目标架构必须保留”。
3. 先定义 BilliardBuddy 自己的项目、任务、线程、运行、轮次、产物、worktree 和面板状态，以及简体中文默认文案和完整任务生命周期。
4. 重构应用服务、产品 API、事件协议和桌面 IPC，使它们直接服务新领域模型；再通过独立 Agent Core Adapter 接入 CC-HH Agent 能力，不修改或削弱 Agent 循环。
5. 在唯一的 `ts/desktop/src` 中建立新的 BilliardBuddy 前端骨架：项目/任务索引、新建任务、任务页面、任务操作、多线程/分叉、右侧审阅区和运行区。
6. 按“新建任务 → 流式对话 → 工具/审批 → Diff/文件/浏览器 → 终端 → 归档/恢复 → 分叉/worktree”的顺序逐条接真数据，并删除被替代的临时兼容链。
7. 用户先验收页面结构、中文表达、操作位置和视觉方向；用户未确认前，不用截图相似度宣称完成。
8. 新产品链具备对应消费者后，按“生产者—传输—消费者—持久化—测试”整链删除退出的 CC-HH 页面、组件、样式、路由、产品 store、旧应用接口、临时 shim 和旧测试，不在仓库中长期维护两套前端或两套产品后端。

### 2. 再审核 Skill 和媒体链

1. 盘点当前内置台球 Skill、知识资源、BOSS、生图和视频能力，不以文件名存在作为已完成证据。
2. 删除机械 Skill 和无真工具消费的假能力；保留并重写真正提高 Agent 完成业务任务能力的按需 Skill。
3. 生图和视频按“Skill 管意图，工具管执行，工作台管连续状态”收口，不重复任务和数据链。

### 3. 最后做真机与打包验收

当前开发阶段不先做真实付费生图、真视频导出、大并发、服务器迁移和安装包真机。源码边界稳定后再集中验收，避免边改架构边消耗付费 API。

## 明确禁止

- 不得把 CC-HH 前端换色后当成 BilliardBuddy 最终前端。
- 不得继续在 CC-HH 页面结构上小修小补来冒充“按 Codex 重做”。
- 不得把本轮重构缩减成“前端换壳 + 若干 adapter/shim”，让 CC-HH 原产品状态继续主导架构。
- 不得直接把 Codex 混淆 bundle、品牌资产、账号体系或专有服务端接口接入产品。
- 不得因为前端重做就重写或降级 Coding Agent 底座。
- 不得恢复旧 `renderer-react` 成第二个应用入口。
- 不得搬回旧 `/api/v1/agent/*`、`/agent/ws`、旧单例 chat store 和旧 Agent loop。
- 不得把台球知识、BOSS、生图或视频流程强塞进每轮 Agent 提示或核心循环。
- 不得在普通前端显示模型名、Provider、Claude 登录、隐藏提示、hook 注入或原始思考。
- 不得用假会话、假文件树、假工具活动和假完成状态冒充真实接线。
- 不得启用 Whisper，不得让客户端持有上游真实 API key，不得静默跨供应商切换。
- 不得修改 `ts/desktop/src-tauri/resources/preview-agent.js`。
- 不得为这次迁移重建繁重仓库规则、质量门、阶段报告和文档流程。

## 什么时候才能声称完成

前端与 Coding Agent 底座接轨只有在以下条件同时满足时才能写成完成：

1. 开发版和安装包最终只加载 `ts/desktop/src` 构建出的一套前端。
2. 用户确认项目/任务导航、新建任务、任务页面、Composer、审阅区和整体视觉符合目标，不再是 CC-HH 换皮。
3. BilliardBuddy 已有单一明确的项目/任务/运行领域模型和产品事件链；CC-HH 只通过 Agent Core Adapter 提供执行能力，不再向前端暴露其 renderer 产品模型。
4. 新建、置顶、重命名、归档、恢复、继续任务、侧边任务和独立工作区等已实现部分都连接真实后端；尚无后端能力的动作明确不展示或标记未实现，不能做假按钮。
5. 真实会话能流式返回，工具、子代理、审批、中断、附件、文件和 Diff 事件没有因重构丢失。
6. Workspace、文件树、Browser/Preview、Terminal、图片/视频预览都消费新的 BilliardBuddy 应用层和真实 Agent 能力。
7. 默认界面为统一简体中文，并且不泄露 system prompt、hook 注入、原始思考、密钥、内部配置、模型名和不需要的开发者术语。
8. 退出的 CC-HH 页面、样式、路由、产品状态和旧应用接口已删除，安装包中没有第二套 renderer、第二套产品链或 Codex 逆向参考产物。
9. 临时 adapter/shim、双写状态、旧事件翻译、旧 Agent loop、机械 workflow、强制 RAG、死代码及其专用测试已经删除；当前源码树没有为“也许以后有用”保留的旧实现副本。
10. 受影响模块的 TypeScript、聚焦测试和可见界面核对通过，且没有覆盖当前用户的未提交修改。

整个产品最终完成还需要后续真机验证：真实模型工具循环、语音转写、付费生图、视频导出、Computer Use 系统权限、安装包启动/恢复和最终分发内容审查。没有运行过的环节必须如实报告“未验证”，不伪称完成。

最后交付时直接在对话中报告：改了什么、删了什么、保留了什么、实际运行了什么、哪些仍未验证。不再为每个阶段新建一份仓库报告。
