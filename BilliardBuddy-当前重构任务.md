# BilliardBuddy 当前重构任务

> 状态：进行中 · 最后核对 2026-07-18

## 目标

在现有 Coding Agent 内核上完成 BilliardBuddy 桌面产品。保留通用 Agent 的模型循环、工具、子代理、任务、权限、Skills、Plugins、MCP、Hooks、上下文管理、工作区和终端；重做产品外层、桌面界面与球房业务能力，不再维护旧 Agent、旧前端或机械工作流的并行实现。Browser/Preview、网页自动化和 Computer Use 必须按真实能力分别验收，不能用一个界面或 feature stub 代替完整交付。

## 唯一开发位置

```text
/Users/swl/Desktop/billiardbuddy
branch: dev
```

`bb-cc-haha-migration` worktree 已移除。旧实现只在需要核对视觉或选择性回迁产品能力时从 Git 读取：

- `main` 提交 `2d6c88dc2639eca9fe5efbcb39136e1ef21991c1` 中的 `ts/desktop/renderer-react/src`：原 BilliardBuddy 前端的固定视觉和交互基线，后续 `main` 变化不得暗中改变参考版本。
- `legacy/dev-before-cc-haha`：旧 dev 的已提交实现。
- `preserve legacy dev working changes 2026-07-18` stash：旧 dev 的未提交修改。
- `/Users/swl/Desktop/cc-haha-ref`：只读核对 Agent 原始机制，不再整仓覆盖当前 `ts/`。

## 实现原则

1. 当前 `dev` 的源码、测试和实际运行结果是实现事实源。
2. Agent 内核保持通用 Coding Agent 架构；产品改造放在桌面外壳、适配层、网关、Skill 和专业工作台。
3. 前端以原 BilliardBuddy 的视觉语言和 Codex 的信息架构为参考，消费当前真实 store、REST、WebSocket 和 Electron IPC；不从旧实现恢复 Agent、状态管理或接口契约。
4. 普通聊天只显示用户消息、Agent 输出和必要执行状态，不显示 system prompt、hook 注入文本、密钥或隐藏运行配置。
5. 普通用户界面不展示模型名、Provider 配置或官方模型账号登录；产品自带的 Claude/ChatGPT 登录路由和回调退役，但通用 MCP 协议自身需要的 OAuth 能力保留。运行诊断留在高级界面。
6. 语音、生图和视频不写进 Agent 核心循环。开放任务用 Skill 编排；需要连续预览、编辑和导出的能力使用专业工作台与确定性服务。
7. 不恢复强制球房知识库、固定 RAG 或 BOSS 招聘流程。领域知识按任务需要通过 Skill 或资源读取。
8. 默认产品运行只经产品网关和用户明确配置的通用 Provider、MCP 或网络工具外联；导入内核中保留的可选私有服务兼容代码不得在默认启动和托管网关主路径自动激活。源码存在不等于产品已启用，验收以安装包默认态的实际外联为准。
9. 本仓库不新增 AI 开发规则、路由 Skill、质量门治理或迁移台账。验证按改动风险执行聚焦检查，最终以桌面真机和安装包验收。

## 已完成的底座

- 新 Coding Agent 内核、Electron 桌面宿主和产品网关已统一到当前 `dev`。
- 网关默认文本模型为 DeepSeek V4 Flash，MiMo v2.5 是唯一原生视觉上游，Qwen 作为可明确选择的文本上游保留。普通图片先由 MiMo 产生结构化理解再交给原目标模型；带原始截图并启用真实 Computer Use 工具集的回合则整轮直接路由 MiMo，保留像素、坐标和工具语义。视觉失败或目标上游不可用时明确失败，不丢图、不跨厂商静默回退。真实上游 Key 只存在服务端，不进入桌面端、Agent 子进程、设置文件或日志。Fun-ASR-Flash 是产品语音输入的唯一转录上游，Whisper 已退役。
- 桌面已具备真实会话、流式输出、工具调用、权限、Skills、Plugins、MCP、工作区、Diff、终端和人工 Browser/Preview 数据链。
- 旧 IM adapters、dataeye、死 Tauri 宿主、无消费者网关路由和部分旧品牌链路已经删除。
- 桌面壳已恢复 BilliardBuddy 的 Sidebar、TopBar、会话密度、输入器、亮暗主题和整窗设置页；开发态视觉已经验证，Electron 宿主能力与最终安装包仍以真机验收为准。

## 当前工作

### 桌面前端收口

- 保留当前 store/API/WS/IPC，只调整 React 展示层。
- 左侧项目与会话导航、中间对话、右侧预览/审阅与文件树、底部终端形成可展开的工作区。
- Assistant 正文不做气泡；用户消息为紧凑右侧气泡；thinking 原文不展示；工具调用默认显示为轻量活动行。
- 设置页按“个人 / 功能 / 高级”分组，技术配置默认收起。
- 亮色、暗色和跟随系统三种主题保持同一布局与可读性。

### 已接线的产品能力

- 语音：桌面录音经 sidecar 和产品网关调用 Fun-ASR-Flash，转写结果回填 Composer，不自动发送。
- 生图：独立 Skill、媒体 Tool 与生图工作台共用项目和任务服务；草稿可在扣费前修改。参考图以 `0600` 权限仅在本地项目中保存，普通项目列表和 Agent Tool 结果只返回数量而不返回图片内容；只有用户在 Electron 工作台明确确认时，主进程才携带本次进程随机生成的媒体 capability 经网关提交付费任务，renderer、H5、Agent、CLI 和其子进程都拿不到 capability。提交响应丢失或应用中断时使用原幂等键恢复；只有用户明确确认放弃未知结果并创建新任务时才生成新键，`failed_unknown` 必须提示可能已经产生费用。
- 视频：独立 Skill、媒体 Tool 与剪视频工作台共用项目、素材和时间线；本地 `ffprobe` 分析、Range 预览和 FFmpeg 导出不进入模型循环。最终导出同样只能由 Electron 工作台确认；本地只允许一个 FFmpeg 导出占用槽，任务 ID 与项目 revision 共同阻止取消后的旧任务覆盖新任务，输出先写临时文件再原子落位。当前能力是裁切、排序、缩放补边、拼接和基础音频统一，不宣称具备自动字幕、镜头理解、音乐、转场或完整智能剪辑。
- 招聘：BOSS 固定流程已取消，不迁移旧评分、话术或自动跟进实现。

语音、生图和视频已完成源码接线与假上游验证；真实麦克风、真实付费生图和 FFmpeg 真机导出留到最终真机验收。安装包不允许依赖用户系统已有 FFmpeg：发布时必须离线注入审核过的 LGPL 二进制、许可证、源码地址和哈希；缺失或含 GPL/nonfree 构建参数时直接停止打包。

## 能力事实分级

| 能力 | 源码与界面 | 默认装机状态 | 外部条件 | 当前结论 |
|---|---|---|---|---|
| Agent 循环、工具、终端、Diff、文件树 | 已接线 | 默认启用 | 按权限执行 | 可进入最终桌面验收 |
| 人工 Browser/Preview | 已接线 | 默认启用 | Electron WebContents | 用户可浏览和检查，不等于 Agent 自动操作网页 |
| Agent 浏览器自动化 | 只有 feature-gated stub | 首版不预装 Playwright | 用户项目自备 Playwright，或用户另行配置浏览器 MCP/连接器 | 内置能力待后续独立交付；人工 Preview、旧 `playwright-browser` 和 BOSS Skill 都不得冒充自动化 |
| WebSearch | 工具与设置已接线 | 默认模型无原生搜索 | 用户自备 Tavily/Brave Key | Key 存独立 `0600` 凭据文件，普通设置 API 只返回配置状态 |
| Computer Use | 源码、设置和权限链已接线 | macOS/Windows 可配置，不称开箱即用 | 首次需可用的 Python、venv、pip 联网安装运行依赖及系统辅助权限 | 安装包、依赖安装、默认模型的坐标与工具循环尚未真机验证；Linux 不视为已交付 |
| 图片工作台 | 草稿、参考图、异步任务、重试、下载和删除已接线 | 网关配置后可用 | 真实图片上游与额度 | 付费真机待验收 |
| 视频工作台 | 素材、时间线、预览、取消、删除和导出服务已接线 | 发布包强制要求媒体工具链 | 审核过的 FFmpeg/ffprobe | 基础剪辑 MVP，真机导出待验收 |
| 独立 CLI 命令 | Agent sidecar 支持 CLI 模式 | 尚未作为安装包命令安装 | CLI launcher 交付 | 不能仅凭源码存在宣称已交付 |

## 项目指令兼容

- 原生 `CLAUDE.md`、`CLAUDE.local.md` 和 `.claude/rules` 机制保持不变。
- 产品额外从 Git 根到当前目录读取 `AGENTS.md` 和 `BilliardBuddy.md`；同目录先读 `AGENTS.md`、后读 `BilliardBuddy.md`，近目录优先。
- 单文件最多 40,000 字符、总计最多 100,000 字符；超预算时先保留更近目录和同目录 `BilliardBuddy.md`，最终注入顺序仍为根到近目录。
- 文件只在会话启动时生成一次追加提示文件，不作为普通聊天消息展示。

## 明确不改

- Agent 循环、原始系统提示机制、工具/Skill/权限/上下文压缩机制。
- Anthropic、OpenAI、MCP、SSE、WebSocket 等通用协议字段和兼容层。
- 网关现有模型路由与凭据边界，除非另有明确任务。
- `ts/desktop/src-tauri/resources/preview-agent.js` 中用户已有修改。
- 未经明确要求不 push、不合并 `main`、不发布安装包。

## 完成标准

1. BilliardBuddy 可启动、创建和恢复会话，CLI 与 GUI 的 Agent 工具循环可用。
2. 桌面布局和交互对齐已固定的原 BilliardBuddy 前端基线及 Codex 工作区信息架构，所有区域使用真实数据。
3. 会话区不泄露内部提示词、hook、凭据或隐藏配置。
4. 工作区、Diff、文件树和终端能从会话真实进入并返回结果；人工 Browser/Preview 只按人工浏览能力验收，首版不宣称内置 Agent 网页自动化。Computer Use 要在安装包中完成依赖安装、系统权限、坐标和工具循环真机验收后才可宣称可用。
5. 语音、生图和视频在安装包内完成真机闭环；BOSS 招聘入口与旧实现均不存在。
6. 最终安装包默认启动和托管网关主路径不主动连接旧产品私有服务，产品 Claude/ChatGPT 登录路由和回调不再对外提供；用户明确配置的通用 Provider、MCP OAuth 和网络工具不属于该限制。安装包不包含旧产品品牌、更新源或无消费者模块；第三方依赖许可按实际分发内容保留。
