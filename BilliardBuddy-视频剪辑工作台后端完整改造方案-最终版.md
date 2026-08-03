# BilliardBuddy 视频剪辑工作台后端完整改造方案（最终版）

> 文档性质：可直接交付开发人员执行的完整后端施工合同  
> 目标仓库：`luu175ktovtsvor-spec/billiardbuddy`  
> 静态审阅基线：`main` 分支提交 `ba5396a8585453ef17711d039f3049aad21a0abd`  
> 交付方式：一次性完成本文件全部目标，不把必要链路拆成“以后再补”  
> 明确边界：不修改 Agent；不接生视频；保留 FFmpeg/FFprobe 本地执行；MiMo 替换为 Qwen；ASR 使用 Fun-ASR-Flash + Fun-ASR
> 对抗审查修订：区分 Camera Shot、Content Segment 与 Evidence Window；增加 Delivery Variant、两阶段质量门、跨 SQLite/文件提交协议、Provider 预算闭环和完整桌面安全代理

“一次性完成”指最终交付不得留下双状态源、无验证的占位链路或只能演示的假实现，不代表使用一次大提交重写全部代码。施工必须按第 13 节的迁移关卡推进，每一关均保持旧项目可读、正式写入单一且可独立验证；全部关卡完成后才可宣称本合同完成。

---

## 0. 开发执行协议

一次开发任务只能实施第 13.0 节的一个施工关卡，或该关卡中一个不留下第二 writer、不可恢复状态或占位生产路径的纵向切片。上一关退出证据未通过，不开始下一关；“最终一次性交付”不能被解释为一次无边界重写。

修改代码前，实施者必须先输出本关施工对齐：

1. 本关完成的用户结果及对应第 15 节验收条目；
2. 当前生产调用链、writer、文件/SQLite 提交点、Operation/Event 与恢复入口；
3. 本关修改的领域事实、事务边界、远程合同和预计文件；
4. 明确保留的旧能力、退出的旧写路径和不在本关范围的内容；
5. 将实际运行的 characteristic、unit、contract、integration、crash/recovery、production-path 与桌面 E2E 验证。

交付时必须分别报告真实走通路径、失败/恢复证据、等价但形状不同的实现、真实未完成项、验证命令和临时进程清理结果。没有对应证据时只能报告“本关未完成”，不能以新增类型、页面或孤立测试代替生产路径。

可直接复制的开工指令：

```text
使用《BilliardBuddy 视频剪辑工作台后端完整改造方案（最终版）》作为施工合同。
本轮只实施第 13.0 节第 N 关：<关卡名称>；按该关要求完成正式 API → Application → SQLite/不可变 payload → Adapter → Event/Public Projection 生产路径和失败恢复路径。

修改前先输出第 0 节要求的施工对齐，并核实当前代码、最近 AGENTS.md 和工作树事实。不得开始下一关，不得新增第二 writer，不得用真实 Provider 依赖替代可复现合同测试，不得改动 Agent/Image 既有语义，不得启动子代理。保留用户无关改动，并停止、复查本轮启动的临时服务、浏览器、测试和打包进程。

达到本关退出证据后按第 0 节格式回报并停止；证据不足时明确报告未完成项。
```

### 0.1 Git worktree 与 main 同步协议

允许并推荐在独立 Git worktree 开发，使 `main` 工作树继续维护根 `AGENTS.md`、两份施工合同和已验收集成状态。创建 worktree 前，施工合同必须先进入可从 `main` 到达的提交；不得从包含未跟踪合同、未提交代码或未解决冲突的脏工作树复制开发基线。

视频开发分支建议为 `codex/video-workbench-refactor`。视频第 13.0 节第 1 关是 Shared Media Kernel、全局 `ts/package.json` test command 和共享 test runner 的首个 owner：只抽取通用存储/Operation/Event/CAS/recovery/测试原语并保持现有图片行为不变；该关经合并审核进入集成基线后，图片 worktree 才开始图片 15.0/15.1。也可以用单独 `codex/media-kernel-foundation` worktree 先完成完全相同的边界，但不能让图片、视频两个分支并行实现两套 Kernel 或争写全局 test 入口。

固定规则：

- 创建前先用 `git worktree list --porcelain` 核对现存 worktree/branch/path；只有确认目标目录已不存在的 `prunable` 注册才可清理，不能删除仍在使用的 worktree。新 worktree 使用仓库外的同级独立目录和未被占用的开发分支；
- `AGENTS.md` 按当前 worktree 中的实际文件生效；main 的后续修改不会自动传播。每关开工前，视频分支必须把最新 main 通过项目采用的 merge/rebase 策略纳入当前 HEAD，证明该 main commit 已是祖先，并重新完整阅读根和最近目录的 `AGENTS.md`；
- 一次只在一个 worktree 实施一个关卡，开发分支内可按关卡提交。达到退出证据后停在开发分支，等待用户另行发起合并审核；没有明确授权不得向 main 提交或合并，也不得切换主工作树。只有相关关卡经审核进入集成基线后，下一关及图片 worktree 才能同步并依赖它；
- `ts/package.json`/共享 test runner、Shared Kernel、`ts/shared/product/providerContracts.ts`、Gateway/Relay contracts、根架构文档、`deploy/production/*` 和服务器/Nginx 文档同一时刻只能有一个明确 owner。另一 worktree 必须等待 owner 关卡经合并审核进入集成基线；
- 各 worktree 使用独立数据目录、SQLite/CAS、端口、缓存、日志与临时输出，不能并发写同一项目目录；任务结束停止并复查各自临时进程；
- 服务器只部署已提交、已验收 revision。图片/视频 worktree 不并行手工修改同一台服务器；Video Media Relay 只能按第 1.2/5.4.1/13.5 节在第 4 关统一部署。

---

## 1. 改造完成后的后端结果

完成后必须形成以下完整链路：

```text
Create Project
→ Import Sources
→ Probe + Fingerprint
→ Derivatives
   ├── Proxy
   ├── Thumbnail
   ├── Waveform
   ├── Audio Extract
   ├── Camera Shot Map
   ├── Content Segment Map
   └── Keyframes
→ Timed Transcription
→ Adaptive Evidence Windows
→ Content Segment/Camera Shot-level Visual Evidence
→ Curation + User Decisions
→ Delivery Intent + Duration Feasibility
→ Outline Planning
→ Chapter Planning
→ Global Plan Review
→ Timeline Draft
→ User Accept / Timeline Commands
→ Editorial Timeline Version
→ Delivery Variant（画幅与完成层版本）
→ Preflight Quality Report
→ Timeline + Delivery Variant Validation
→ FFmpeg Execution Plan
→ Preview
→ Final Render
→ FFprobe + Hash Verification
→ Decode Scan + Post-render Quality Report
→ Durable Project/Operation Recovery
```

它必须支持：

- 1 个素材或几十个素材；
- 几分钟或几小时原始素材；
- 任意合理的短、中、长成片意图，而非固定分钟档位；
- 自然成片、目标时长和精确时长三种交付模式；
- 后端为未来手工剪辑界面提供完整的项目、Camera Shot/Content Segment、Editorial Timeline、Delivery Variant 和校验状态；
- 手工、口播/叙事、精华、节拍同步和混合五类工作方式；
- 先形成可预览的时间线草稿；只有用户接受或主动编辑后，才产生新的正式时间线版本；
- AI 辅助挑选和规划；
- 面向普通用户的快速成片：只说明用途、重点人物/片段与目标时长，即可得到可比较的候选片；
- 面向创作者的项目内 AI 协作：可围绕选中的文本、Camera Shot/Content Segment、时间范围、时间线和交付变体版本追问、比较和继续修改；
- 语义搜索、文本剪辑、自动字幕、智能构图、基础音频完成与可复用创作模板；
- 重启恢复；
- 增量处理新增素材。

本文件是后端与桌面安全桥的施工合同，不等同于已经完成用户产品。当前 Renderer 为空；只有后续前端能够完成“导入—查看分析范围/预算—比较草稿—接受或局部接受—预览—导出—恢复”的真实桌面旅程，并通过第 15 节端到端验收，才可对外宣称视频工作台完成。

### 1.1 开发前冻结决策

以下不是留给开发者或模型自行选择的开放题；实施必须按这些边界推进，改变时先修订本合同：

1. **视频远程能力走独立、无状态的 Video Media Relay。** 现有 Agent Text Gateway、图片 Relay 和产品语音转写路径保持不动，不承载本合同新增的关键帧、代理视频、视频 ASR task 或 embedding。Video Media Relay 持有一份服务端阿里云百炼凭据，代理 Qwen Visual/MediaReasoning、Fun-ASR 和 `text-embedding-v4`；它只保存请求级幂等、额度、上游 task/usage receipt 和短期对象租约，不保存 Project、Timeline、Creative Session 或用户编辑状态。本文后续简称 Media Relay。
2. **视频施工不迁移生图状态。** 本轮可以新增通用 Media Kernel 原语和向共享 capability registry 做加法，但首个消费者仅为 VideoModule；不得顺带迁移 `imageWorkbenchRepository.ts`、改写图片 writer，或重构 `imageReasoning.ts`。图片模块以后在自己的施工合同中主动采用兼容原语。
3. **首版导出只实现第 6.9.1 节白名单。** 模型、API 和 Renderer 不能提交任意 codec/filter/FFmpeg 参数；白名单外组合由 Validator 以稳定错误失败关闭。
4. **Beat 和 Subject Tracking 使用第 5.5 节本地 Port。** VLM 只提供候选语义/主体锚点，FFmpeg 只负责受控解码和确定性媒体测量；Beat Grid、跨帧跟踪和平滑必须有真实本地实现、版本 receipt、置信度和保守降级。
5. **Renderer 至少实现第 13.11 节信息架构。** 视觉样式可以另有设计稿，但页面状态、用户动作、IPC 边界和端到端旅程不能由开发时临时发明。

固定远程调用拓扑：

```text
Renderer
→ Electron Main typed IPC
→ Local Product Sidecar（项目事实、Operation、项目预算与恢复）
→ Stateless Video Media Relay（产品身份、账户额度、幂等、Provider receipt）
→ 阿里云百炼
   ├── qwen3-vl-flash
   ├── qwen3.6-flash
   ├── fun-asr-flash / fun-asr
   └── text-embedding-v4
```

长音频或短代理需要对象 URL 时，由 Media Relay 签发限定 `operation_id`、content hash、大小、Content-Type、过期时间和单次写入的上传能力；对象进入 Relay 控制的短期隔离区，提交 Provider 后按租约删除。桌面端不获得 OSS AccessKey、可复用上传凭据或任意 bucket 读写权。首版部署与阿里云百炼统一使用华北 2（北京）地域的一份 workspace API Key 和同地域临时对象存储；禁止为了调用成功静默跨地域回退。以后增加海外部署时建立独立 Relay、凭据和 consent region，不复用北京临时对象。Sidecar 的项目预算先 `reserve`，Media Relay 同时执行账户额度校验；最终以 Relay 返回的真实 Provider usage receipt `settle`。两者一个约束本地用户授权、一个约束服务端账户额度，不构成第二份项目状态。

### 1.2 生产服务器目标拓扑与调整时机

首版不要求增加一台物理服务器，也不迁移现有 Gateway/Image Relay；需要调整的是服务级拓扑。Video Media Relay 可以先作为同一产品后端主机上的独立 Compose service 部署，但必须拥有独立镜像、监听端口、数据目录、secret 文件、健康检查和 Nginx 公网前缀。Gateway 不依赖、不反向代理 Video Media Relay，也不承载视频字节；Video Media Relay 只依赖 Gateway 的私网安装会话内省端点。若开工前实测发现现有主机不在合适地域、CPU/内存/磁盘/出口不足或不能满足隔离要求，才把同一无状态服务部署到独立北京主机；API、鉴权、对象租约和 Sidecar 合同不得因此变化。

```text
现有链路（保持）
Desktop → https://zzyppz.cn/gw/ → Nginx → Gateway :8799 → Image Relay :8790（Compose 私网）

新增视频链路
Desktop Sidecar → https://zzyppz.cn/video-media/ → Nginx
               → Video Media Relay :8791
                  ├── Gateway /internal/v1/auth/introspect（仅身份内省，Compose 私网）
               → 北京 OSS 短期隔离对象 + 阿里云百炼
```

公网前缀 `/video-media/` 只映射到 Video Media Relay，并剥离该外层前缀后保留第 5.4.1 节的 `/v1/video-media/*` API。`relay:8790` 继续只在 Compose 私网暴露；`video-media-relay:8791` 只绑定宿主 `127.0.0.1:8791` 并由 Nginx 提供 TLS，不直接暴露 Docker 端口。Gateway 不新增 `GW_VIDEO_MEDIA_RELAY_BASE`，避免形成第二条视频路由。

Video Media Relay 的“无状态”是指不拥有 Project/Timeline/Consent，不表示完全无持久化。它必须持久化请求幂等、账户额度 reservation、上游 task、Provider usage receipt、ACK 和短期对象 lease 元数据；大字节存北京临时对象存储，服务自身数据库落独立 `/srv/billiardbuddy/data/video-media-relay`。凭据只放 `/srv/billiardbuddy/secrets/video-media-relay.env`，至少包含 Gateway 私网内省 base/服务凭据、阿里云百炼 workspace/key、北京 OSS endpoint/bucket 与签名权限、账户限额和保留期；Gateway 自己的会话签名 key 和安装会话数据库绝不复制给 Relay。部署脚本和日志只能校验变量名/权限，不打印值。

服务器修改不得提前于可部署实现。固定顺序为：

1. 在任何写操作前只读盘点真实主机的容器/镜像 revision、Compose、Nginx、监听端口、DNS/TLS、`/srv/billiardbuddy` 目录与权限、磁盘/内存、当前健康端点和 secret **变量名引用**；不得输出 secret 值；
2. 在第 13.0 节第 4 关先完成 Relay API/鉴权/对象租约/Provider contract tests、Dockerfile、env validator 和 `/healthz`/`/readyz`；
3. 同一关再更新 `deploy/production/compose.yml`、`deploy.sh`、Nginx 配置与 `docs/operations/production-servers.md`，从已提交 revision 构建并部署；不得先建立长期占位容器、空路由或临时手工进程；
4. 部署后验证外网 TLS/auth 拒绝、大小/MIME、幂等冲突、上传中断、lease 过期、真实受控 Provider smoke、ACK/清理、额度与日志脱敏；停止全部临时测试进程；
5. 第 6 关再以真实打包 Sidecar 完成桌面端 E2E。服务健康不等于产品旅程完成。

---

## 2. 当前后端静态分析

### 2.1 当前装配点

当前事实主节点：

```text
ts/src/server/index.ts
└── startServer()
    ├── new VideoWorkbenchService()
    ├── createVideoWorkbenchDomainApiHandler()
    ├── migrateLegacyMediaStore()
    └── recoverInterruptedOperations()
```

当前路由：

```text
ts/src/server/router.ts
└── /api/videos → video handler
```

判断：

- 视频领域已经独立；
- 不应重新并入 `MediaProjectService`；
- `startServer()` 是事实 Composition Root；
- 应抽取 `MediaRuntime`，但不能创建超级 MediaWorkbenchService。

### 2.2 当前正式模块

| 文件 | 当前职责 | 结论 |
| --- | --- | --- |
| `ts/src/server/api/videoWorkbench.ts` | HTTP 路由、安全投影、操作接口 | 保留 API 边界，内部委托新 façade |
| `videoWorkbenchService.ts` | 项目、导入、分析、计划、预览、渲染、恢复 | 过大，必须拆分 |
| `videoWorkbenchRepository.ts` | 项目、Operation、Event、删除、锁、Fence | 领域存储保留，抽取共享技术底层 |
| `videoAnalysis.ts` | 视觉证据、Brief、规划 | 拆成 Ports、Adapters 和 Host Validator |
| `videoExecution.ts` | FFprobe、FFmpeg、编码和验证 | 拆为 Probe、Derivative、Compiler、Executor、Verifier |
| `voiceTranscription.ts` | 现有产品语音 ASR 应用封装 | 保持既有语音行为；新视频不再复用 |
| `ts/src/media/remoteTranscription.ts` | 现有产品语音远程转写请求 | 保持既有语音行为；新视频另建 Timed Transcript adapter |
| `gateway/transcription.ts` | 当前产品语音与旧视频复用的 Fun-ASR adapter/解析 | 产品语音保持不动；新视频 Operation 改走 Video Media Relay |
| `gateway/providerRegistry.ts` | 当前混合模型能力 | Agent、图片、产品语音既有能力保留；新增视频能力放入独立 Relay Registry |
| `ts/shared/contracts/media.ts` | 旧图片和视频大合同 | 视频新增独立 contract 并保留 legacy reader；不在本轮迁移图片 contract |

### 2.3 当前做得好的部分

以下必须保留：

- Video Project 独立 owner；
- source 本地路径不进入 public projection；
- source hash；
- duration、width、height、fps、rotation、audio tracks；
- source missing/changed；
- writer fence；
- project revision；
- persisted Operation；
- operation Event Journal；
- stale result 校验；
- timeline version；
- locked scene；
- 主方案与 alternatives；
- preview 与 render 分离；
- 本地编码串行；
- 临时文件；
- FFprobe 和 hash 最终校验；
- legacy migration；
- interrupted operation recovery。

### 2.4 当前结构性问题

#### 问题 A：`VideoWorkbenchService` 是应用层单体

它同时负责：

- Project；
- Source；
- Probe；
- 文件服务；
- 分析；
- 抽帧；
- 音频提取；
- ASR；
- Evidence；
- Planning；
- Timeline；
- Preview；
- Render；
- Queue；
- Recovery；
- Migration。

改造目标：

```text
VideoWorkbenchFacade
├── ProjectAssetsApplication
├── AnalysisIndexApplication
├── EditorialApplication
└── FinishingDeliveryApplication

MediaRuntime
└── MediaKernel（Operation/Storage/Budget/Recovery/Security）
```

旧 Service 先变 façade，旧 API 在迁移窗口保持兼容投影；最终 façade 只做 DTO/路由适配，不再次跨四个应用模块聚合业务规则。

#### 问题 B：分析规模被硬编码为摘要级

当前路径存在：

- 仅前 4 个 Source；
- 每个 Source 约 10%/50%/90% 三帧；
- 音频只取前 10 分钟。

这只能生成项目摘要，不能成为剪辑系统。

必须删除这些业务限制。

安全限制应改为配置：

```text
BB_VIDEO_MAX_SOURCES
BB_VIDEO_MAX_TOTAL_SOURCE_DURATION_MS
BB_VIDEO_MAX_SOURCE_BYTES
BB_VIDEO_MAX_CAMERA_SHOTS
BB_VIDEO_MAX_CONTENT_SEGMENTS
BB_VIDEO_MAX_EVIDENCE_WINDOWS
BB_VIDEO_MAX_VISUAL_FRAMES
BB_VIDEO_MAX_PROXY_SECONDS
BB_VIDEO_MAX_MODEL_TOKENS
BB_VIDEO_MAX_DERIVATIVE_BYTES
BB_VIDEO_MAX_OUTPUT_DURATION_MS
BB_VIDEO_VISUAL_REQUEST_MAX_BYTES
```

配置是安全/资源上限，不是“默认全部花完”的分析计划。达到上限时返回已覆盖范围、未覆盖范围和扩大预算入口；不在领域 schema 中写死“4 个素材”“10 分钟”“每批 50 个”等产品限制。

#### 问题 C：ASR 时间码被裁掉

现状：

```text
旧 Gateway 能解析 segments/words
→ 旧视频复用了只面向产品语音的 remoteTranscription/voiceTranscription
→ 视频侧最终只得到 { text }
```

必须改成：

```text
TimedTranscript
├── Segment
└── Word
```

没有时间码的旧数据只能搜索/摘要，不能用于字幕和按句剪辑。

#### 问题 D：没有派生物层

当前 proxy、关键帧、音频抽取等缺少正式、可恢复、可失效的数据实体。

必须增加 `VideoDerivative`。

#### 问题 E：没有可操作的 Camera Shot、Content Segment 与 Evidence Window

当前 Source 和 Scene 之间缺少用户可操作的镜头/内容单元；同时不能把“每次镜头切换”和“送模型理解的范围”当成同一对象，否则 50 秒连续镜头会被一张中心帧错误代表。

必须同时增加 `CameraShot`、`ContentSegment`、`EvidenceWindow` 和 `SourceRangeDecision`。

#### 问题 F：时间线表达不足

当前 Clip 主要是：

```text
source_id
in_ms
out_ms
```

必须改为 Editorial Timeline v2 + Delivery Variant：

- Track；
- Item；
- RationalTime；
- Source Range；
- Timeline Range；
- Caption；
- Audio；
- B-roll；
- Overlay；
- Lock；
- Evidence；
- 横竖屏/方形独立构图、字幕与音频完成版本。

#### 问题 G：模型职责混乱

当前 MiMo 同时承担视觉和规划。

必须变为：

```text
Qwen3-VL-Flash → VisualEvidence
Qwen3.6-Flash  → MediaReasoning（VideoPlanning / VideoPlanReview / Proposal / CaptionTranslation）
text-embedding-v4 → SemanticEmbedding
```

#### 问题 H：大项目数据会膨胀

大量 Camera Shot、Content Segment、Evidence Window、Transcript、Evidence、Timeline 不能全部嵌入单一 project JSON。

必须拆分存储。

#### 问题 I：缺少创作协作层与低门槛入口

当前合同能处理素材和生成剪辑方案，但没有把普通用户的一句意图或创作者的连续反馈变成项目内、可审计的提案。不能把通用 Agent Thread 当作视频状态，也不能让聊天记录直接改项目。

必须增加：

```text
Creative Recipe / Brief
→ Creative Session
→ Context Anchors
→ Intent Compiler
→ Creative Proposal
→ User Accept / Partial Accept / Reject
→ Typed Timeline CommandSet
```

- 普通用户通过“旅行回忆、活动快剪、口播精华、课程浓缩、产品讲解”等 Recipe 开始，不面对专业参数；
- 创作者可通过自然语言附带当前 Script、Camera Shot、Content Segment、Layer、时间范围、Timeline Version 或 Delivery Variant 作为上下文；
- 对话只解释、检索、提问和提出草稿，不能直接写正式 Timeline；
- 对话历史不是真实状态；Source、Evidence、Decision、Proposal、Editorial Timeline Version 和 Delivery Variant Version 才是；
- 系统只在缺少会实质改变结果的信息时追问，且一次最多提出少量高价值问题。

#### 问题 J：缺少“自动成片确实像样”的质量合同

自动剪辑不能只以模型的主观评分或“已经成功导出”为完成。普通用户无法从空时间线判断好坏，必须有可解释的 `QualityReport` 和失败关闭规则。

必须新增：

- 语义、转写、Camera Shot/Content Segment 和用户决定的统一检索索引；
- 文本剪辑：删/移一句话必须映射为可预览的 Source Range 和 typed Timeline CommandSet；
- 自动构图/活跃说话人取景、字幕、基础声音完成和品牌/风格模板；
- 渲染前质量检查：句子/动作切点、黑场/重复/严重质量问题、必留内容、时长、音频清晰度、字幕对齐、画幅安全区；渲染后另行检查导出与解码完整性；
- 不足素材、冲突决定或低置信度必须说明原因并请求用户决定，不能静默凑片或宣称“爆款”。

---

## 3. 最终模块架构

```text
Local Product Server
└── MediaRuntime
    ├── Shared Media Kernel
    │   ├── OperationStore
    │   ├── EventJournal
    │   ├── AtomicDocumentStore
    │   ├── WriterFence
    │   ├── LockManager
    │   ├── AssetIntegrity
    │   ├── CapabilityRouter
    │   ├── RecoverySupervisor
    │   ├── JobOrchestrator
    │   └── Diagnostics/Budget
    └── VideoModule
        ├── Domain
        ├── Application
        ├── Infrastructure
        └── API
```

VideoModule 内部再分为四个不能互相越权的协作面：

```text
Media Facts
  Source / Derivative / Transcript / Camera Shot / Content Segment / Evidence Window / Evidence / Search Index

Editorial State
  Decision / Delivery Intent / Creative Recipe / Timeline Draft / Editorial Timeline Version

Creative Copilot
  Session / Context / Intent / Proposal / Feedback

Execution
  Delivery Variant / Finishing Plan / Quality Gate / Command Validator / Execution Plan / Preview / Render / Verify
```

`Creative Copilot` 不是通用 Agent，也不拥有媒体文件或时间线的写权限。它通过 Application Ports 查询事实、创建 Proposal；只有用户接受 Proposal 或主动提交版本化 TimelineCommandSet 时，Editorial State/Delivery Variant 才能改变。

远程部署边界独立于本地领域边界：

```text
Agent Text Gateway                 Stateless Video Media Relay
Responses 文本代理                 Qwen / Fun-ASR / Embedding
不接受本合同视频媒体               短期视频派生物租约
不拥有 Agent Thread                不拥有 Video Project/Timeline
```

### 3.1 依赖规则

```text
API
↓
Application
↓
Domain
↑
Infrastructure implements Ports
```

禁止：

- Domain import Bun；
- Domain import fetch；
- Domain import FFmpeg；
- Domain import Gateway；
- Domain import Image Workbench；
- Gateway 回包直接写 Timeline；
- Renderer 写项目文件。

### 3.2 架构板块与唯一职责

以下是正式架构板块。每个板块拥有自己的领域对象和 Application Port；新增功能必须先归属到其中一个板块，不能因为“需要一点逻辑”再次向 façade 或 API 堆代码。

| 架构板块 | 拥有的功能与状态 | 对外只暴露 | 不得承担 |
| --- | --- | --- | --- |
| Project & Ingest | Project、Source/Asset 导入、探测、完整/快速指纹、素材重连 | Project/Sources Commands 与 Summary Queries | Recipe、分析、规划、渲染、对话 |
| Media Facts | Derivative、Timed Transcript、Camera Shot、Content Segment、Evidence Window、Evidence、媒体索引 | 有时间范围的 Facts/Search Results | 用户决定、时间线写入、导出策略 |
| Discovery & Curation | 语义/全文检索、重复组、质量建议、Source Range Decision | Search、Candidate、Decision Commands | 直接选定成片或调用 FFmpeg |
| Editorial | Creative Recipe、Delivery Intent、Duration Feasibility、Outline/Plan、Timeline Draft、Editorial Timeline Version | 版本化 Timeline Commands、Diff | Provider 请求、文件系统、Review 和渲染进程 |
| Creative Copilot | Session、Context Anchor、Intent、Proposal、Feedback、澄清问题 | Answer/Proposal；永远带 revision 与 evidence | 直接写正式状态、持有媒体路径或任意工具权限 |
| Finishing | Delivery Variant、Caption Document、Composition Plan、Audio Finishing Plan、Brand Pack、Style Preset | 可预览、可拒绝的 variant commands 与 Quality inputs | 改写原始 ASR、原素材、内容规划 |
| Delivery | Export Profile、Preflight Report、Execution Plan、Preview、Render、Output Verification、Post-render Report | 只接受冻结 Editorial Timeline Version + Delivery Variant Version | 决定剪什么、修改 Draft/Timeline |
| Review & Approval | 时间范围批注、人工反馈、审批状态、反馈到 Proposal 的映射 | Review Notes、Approval Decision | 云端协作传输、用户身份体系；后者以后由独立 Adapter 提供 |
| Media Kernel | SQLite 事务原语、payload 提交、资产完整性、Operation DAG、资源调度、恢复、能力路由、桌面会话能力 | 视频无关的 Ports | 视频搜索 schema、任何 Video/Caption/Recipe 业务规则 |

`Review & Approval` 先作为本地领域能力存在：创作者可把自己或客户的“00:18 换镜头”“这一版可通过”固定在时间线版本上。领域对象从第一版就必须包含稳定 `actor_id`、事件序号、创建/解决时间和目标版本；未来增加共享链接、团队账户或云同步时主要新增 transport/identity Adapter，但访问控制、冲突合并和离线同步仍须作为独立施工合同，不能宣称“只换 transport”即可自动获得多人协作。

### 3.3 物理模块收敛

上表是功能归属板，不要求立刻建立九套独立 Repository、Service 和目录。为避免把一个应用层单体替换成大量互相转发的小 Service，第一版物理代码只设五个主要模块：

```text
ProjectAssets       # Project、Source、Asset、导入、重连、授权声明
AnalysisIndex       # Derivative、Transcript、CameraShot/ContentSegment/EvidenceWindow、Evidence、Search
Editorial           # Recipe、Decision、Intent、Plan、Draft、Timeline、Proposal、Review
FinishingDelivery   # Delivery Variant、Caption、Composition、Audio、Compile、Render、Quality
MediaKernel         # 通用存储提交、Operation、预算、资源、恢复、安全能力
```

Creative Copilot、Discovery、Review 等先是上述物理模块内具有独立 Port 和 schema 的功能包；只有出现独立生命周期、独立部署/存储或明确团队所有权后才升格为新的 bounded context。逻辑归属必须清晰，但禁止为了目录对称产生无业务价值的跨层转发。

### 3.4 低维护成本的演进规则

为了让以后增加模型、平台模板、字幕效果、导出格式或协作方式不造成横向改动，必须遵守：

1. **一处事实、多个投影。** Source、Transcript、Camera Shot/Content Segment、Decision、Editorial Timeline Version、Delivery Variant Version 只各有一个权威写入者；搜索、对话、预览和 UI 都是投影，不能另存可编辑副本。
2. **Commands 写、Queries 读。** 任何状态变化都通过 typed Command + `base_revision`；查询和搜索永远返回不可变 reference。API、Renderer、Copilot 都不能拿 repository 直接写数据。
3. **Provider 可替换。** ASR、视觉、规划、索引、音频处理、构图检测均实现 Port；业务层只依赖能力合同、Provider Receipt 和标准化结果。换模型只影响 adapter/registry 与 contract test。
4. **FFmpeg 可替换。** Timeline Compiler 输出强类型 `VideoExecutionPlan`，Executor 只接收已校验的 argv/plan；输出目标由 Host 分配的 Asset Target 决定，未来替换执行器或增加硬件编码器不修改 Editorial。
5. **功能通过 Plan/Proposal 接入。** Caption、构图、音频、模板、Review 的任何自动建议必须先成为 Plan 或 Proposal，再转换为 TimelineCommandSet；这避免每增加一个 AI 功能都开一条绕过版本控制的写路径。
6. **模块不共享私有表和文件路径。** SQLite 可以是一个文件，但每个板块只能经其 Repository/Port 操作自己的聚合；跨板块通过 IDs、Domain Events 或 Query Port 协作。
7. **可观测与可测试是 Adapter 合同。** 每个 Operation、Provider Call、Plan Compile 和 Output Verify 都有 receipt/metrics；每个 Port 都必须有 fake adapter、contract test 与可复现 fixture，不能靠真实模型或 FFmpeg 才能测试业务逻辑。
8. **兼容只留单向迁移。** 新格式单写、旧格式双读到迁移完成；不长期维护双写和双时间线语义。
9. **板块优先于类数量。** 一个板块可以有一个应用编排器和若干小 Command/Query handler，但不得机械地为每个名词创建跨板块 Service；`VideoWorkbenchFacade` 只适配 API，不重新聚合业务逻辑。
10. **相关性失效，不做全局雪崩。** Proposal、Plan、Search projection 和 Finishing Plan 保存实际引用的 Source/Transcript/Evidence/Timeline/Variant basis hash；项目改标题等无关变化不能让全部结果 stale。
11. **编辑事实与交付变体分开。** 选了什么内容、顺序和原始声音属于 Editorial Timeline；横竖屏裁切、字幕排版、品牌样式和导出编码属于 Delivery Variant。一个内容版本可以拥有多个交付变体。

---

## 4. 目标目录

```text
ts/src/server/media/
├── runtime/
│   └── createMediaRuntime.ts
├── kernel/
│   ├── operations/
│   │   ├── operationStateMachine.ts
│   │   ├── operationStore.ts
│   │   ├── eventJournal.ts
│   │   └── jobOrchestrator.ts
│   ├── storage/
│   │   ├── sqliteUnitOfWork.ts
│   │   ├── payloadCommitProtocol.ts
│   │   ├── writerFence.ts
│   │   ├── lockManager.ts
│   │   └── deletionStore.ts
│   ├── assets/
│   │   ├── assetReference.ts
│   │   ├── contentAddressedStore.ts
│   │   └── assetIntegrity.ts
│   ├── providers/
│   │   ├── mediaCapability.ts
│   │   ├── capabilityRouter.ts
│   │   ├── providerExecutionReceipt.ts
│   │   └── providerBudgetLedger.ts
│   └── recovery/
│       ├── recoverySupervisor.ts
│       └── migrationRegistry.ts
└── video/
    ├── domain/
    │   ├── projectAssets/       # Project、Source、Asset、授权/来源声明
    │   ├── analysisIndex/       # Transcript、CameraShot、ContentSegment、EvidenceWindow、Search
    │   ├── editorial/           # Recipe、Decision、Plan、Draft、Timeline、Proposal、Review
    │   └── finishingDelivery/   # Variant、Caption、Composition、Audio、Quality、Export
    ├── application/
    │   ├── projectAssets/       # create/update/import/rebind/attest
    │   ├── analysisIndex/       # probe/derive/transcribe/segment/window/understand/search
    │   ├── editorial/           # curate/feasibility/plan/draft/commands/copilot/review
    │   ├── finishingDelivery/   # variant/caption/composition/audio/quality/render
    │   └── videoWorkbenchFacade.ts
    ├── infrastructure/
    │   ├── storage/       # SQLite repositories、payload store、FTS/semantic index
    │   ├── media/         # FFprobe、Derivative、Compiler、Executor、Decode Verifier
    │   ├── providers/     # Fun-ASR、Qwen、embedding 与 receipt adapters
    │   └── desktop/       # Main broker、会话能力、文件对话框与平台 adapters
    ├── api/
    │   ├── videoWorkbenchApi.ts
    │   └── videoDto.ts
    └── testing/
        ├── fakes/         # Ports 的内存实现
        ├── fixtures/      # 可提交的最小媒体/metadata fixture
        └── contracts/     # Adapter 与 API contract tests

video-media-relay/
├── app.ts
├── providerRegistry.ts
├── gatewayIdentityIntrospection.ts
├── authQuota.ts
├── idempotencyStore.ts
├── providerReceiptStore.ts
├── mediaObjectLease.ts
├── temporaryObjectStore.ts
├── health.ts
├── validateProductionEnv.ts
├── providers/
│   ├── qwenVisual.ts
│   ├── qwenMediaReasoning.ts
│   ├── funAsrFlash.ts
│   ├── funAsrLong.ts
│   └── textEmbeddingV4.ts
└── contracts/
    ├── relayApi.ts
    └── providerFixtures.ts
```

`video-media-relay/` 表示独立部署模块边界；实施时可落在仓库已有服务器 workspace 的等价目录，但不能塞回 Agent Text Gateway 或现有图片 Relay handler。它与 Local Sidecar 共享版本化 DTO/receipt schema，不共享数据库、文件目录或业务 Repository。

---

## 5. 最终模型和能力合同

### 5.1 Registry

```text
TextReasoning
→ deepseek-v4-flash
→ Agent，不改

VisualEvidence
→ qwen3-vl-flash

MediaReasoning
→ qwen3.6-flash
  ├── VideoPlanning
  ├── VideoPlanReview
  ├── CreativeProposal
  └── CaptionTranslation

SemanticEmbedding
→ text-embedding-v4（768 维；仅对 Transcript 与结构化视觉描述建向量）

SpeechTranscription
├── short_sync → fun-asr-flash-2026-06-15
└── long_async → fun-asr

ImageGeneration（generate/edit/inpaint 由图片 application mode 区分）
→ 不属于视频模块

Beat
→ FFmpeg 解码受控 PCM + 本地 BeatDetector Port，不调用 LLM

Loudness / Silence / Scene Change
→ 本地 FFmpeg/FFprobe 确定性分析，不调用 LLM

Subject Tracking / Safe Area
→ Qwen VisualEvidence 提供候选主体证据，本地跟踪与 Host Validator 生成 Composition Plan
```

Registry 的正式 capability 名称必须与 `ts/shared/product/providerContracts.ts` 同步。`VideoPlanning`、`VideoPlanReview`、`CreativeProposal` 和 `CaptionTranslation` 是 `MediaReasoning` 的应用角色；`short_sync`/`long_async` 是现有 `SpeechTranscription` 的 application mode，不为同一类能力制造平行 registry entry；`SemanticEmbedding` 是唯一新增的独立计量 capability。业务代码按 capability/role/mode 请求，不按厂商名分支。

模型别名可以用于路由，但每条 Provider Receipt 必须保存实际解析到的 snapshot/model id、区域、请求 schema 版本、Prompt 版本、输入 basis hash、实际 token/媒体时长、缓存命中和上游 receipt hash。模型别名升级后旧 Evidence/Proposal 保持可读；只有对应 adapter 的 contract/fixture 通过后才允许新任务使用新快照。

### 5.2 新视频链路删除 MiMo

必须从 VideoModule 与 Video Media Relay 的新调用路径删除：

- Video Media Relay 内的 `mimo-v2.5` registry entry（正常情况下不得新建）；
- 视频 MiMo routing/visual bridge/scheduler/environment/retry/metrics；
- VideoModule 对旧 Gateway MiMo/Visual bridge 的新调用。

现有 Gateway、图片或产品语音仍在使用的共享 MiMo/媒体代码不由本合同删除或改写；只在 VideoModule 已无调用后移除视频专属分支。历史 Video Operation Receipt 中的 MiMo model id 保留只读。

### 5.3 Fun-ASR 路由

```ts
if (
  sourceDurationMs <= 5 * 60_000
  && !needsSpeakerDiarization
  && hotwords.length === 0
) {
  use('fun-asr-flash-2026-06-15')
} else {
  use('fun-asr')
}
```

`fun-asr` 用于：

- 单素材超过 5 分钟；
- 多人采访；
- 热词；
- 专业名词；
- 长课程；
- 长会议。

### 5.4 远程媒体、隐私和预算闭环

- 新视频远程能力只通过第 1.1 节的无状态 Media Relay 调用；现有 Agent Text Gateway 不接受本合同的视频媒体上传，不代理视频 ASR/Embedding，也不保存 Media Relay receipt，既有产品语音路径不变。实施本关时必须同步更新 `README.md` 与 `docs/重构/模型与远程能力平台.md`，把“Gateway 承载既有 Agent/产品能力”与“Video Media Relay 承载新增视频远程能力”写成两条互不重叠的正式路径；
- 首次把音频、关键帧、低清代理或 Transcript 发送到远程 Provider 前，必须展示并持久化项目级 `RemoteAnalysisConsent`：数据种类、Provider/区域、用途、预计媒体分钟/帧数、是否可撤回及撤回后的本地可用能力；无同意时仍可导入、手工剪辑、本地探测、场景/静音分析、预览和渲染；
- 原素材的 GPS/设备私有 metadata 不作为模型输入；Provider adapter 只能收到 Operation 明确声明的派生物和时间范围，不能读取项目目录；
- 每次远程调用先按现有 Provider Usage Budget Policy `reserve`，成功后以实际上游用量 `settle`，调用前失败 `release`，超时或断连且无法证明未提交时记 `outcome_unknown`；不得只记录可选的费用估算；
- 预算至少同时计量 `requests`、`total_tokens`、`input_bytes`、视觉帧/代理秒数、ASR 秒数和预估金额；Quick Create 和深度分析在超出项目默认预算时必须等待用户确认；
- Prompt/OCR/Transcript/字幕均视为不可信媒体内容，只能作为 `evidence` 数据进入模型；其中出现的“忽略系统指令”“调用工具”等文字不得改变 System Contract、工具权限或输出 schema；
- Fun-ASR-Flash 走短文件同步链路；Fun-ASR 长文件走异步提交、轮询/回调、结果下载、过期处理和重启恢复。远程 task id 与提交 receipt 必须在请求发出前后按 `outcome_unknown` 规则持久化；
- 搜索默认使用 FTS5 + `text-embedding-v4` 对 Transcript 与已经审计的视觉描述做混合检索，不把原始图片再次上传给 embedding 服务。embedding model/dimension/instruction 变化创建新索引代次，后台重建完成前旧索引继续只读。
- 若现有 Gateway/Image Relay 中仍有旧视频远程 Operation，新写入切换时只停止创建旧协议任务，不能遗弃已提交/`outcome_unknown` 任务。Sidecar 按 Operation/receipt schema version 继续走旧 poll/result/ACK reader 直到终态或明确过期；旧任务不能迁移成新 Relay 的“新提交”。连续两个发行版本无 legacy video relay read、全部旧 task 已终态/过保留期且迁移 fixture 通过后，才在独立清理提交中删除现有 Relay 的旧视频 handler，并把运行文档从“图片/视频 Relay”改成“Image/legacy Relay → Image Relay”。

#### 5.4.1 Video Media Relay 固定线协议

Video Media Relay 不是留给实施者自行设计的抽象边界。首版固定使用版本化 HTTPS JSON API；大字节只经 Relay 签发的短期对象 URL 传输。Sidecar 是唯一调用方，Renderer 不直接访问 Relay。

```text
POST   /v1/video-media/object-leases
POST   /v1/video-media/object-leases/:leaseId/complete
POST   /v1/video-media/object-leases/:leaseId/renew
DELETE /v1/video-media/object-leases/:leaseId

POST   /v1/video-media/operations
GET    /v1/video-media/operations/:operationId
POST   /v1/video-media/operations/:operationId/cancel
POST   /v1/video-media/operations/:operationId/ack
```

认证与身份规则：

- 所有 Relay API 使用 TLS 和现有 Electron Main/Sidecar 安装会话的 `Authorization: Bearer <installation access token>`。该 token 仍由 Gateway `AuthAuthority` 发行，保持当前 `aud=billiardbuddy-gateway`、`sid/pid/iid/exp` 合同；不另造 Video refresh token，不把 Gateway 的 HMAC signing key 或 session DB 复制到 Relay；
- Media Relay 不自行解码或信任该 HMAC token。每个控制面请求都通过 Compose 私网调用 Gateway `POST /internal/v1/auth/introspect`，使用独立的服务凭据提交原 access token；Gateway 以现有 `verifyAccess()` 检查签名、audience、expiry、session/registration revoke，并只返回 `{active, principal_id, installation_id, session_id, expires_at, owner}` 安全投影。Relay 不跨请求缓存 active 结果，logout/revoke 后下一请求立即失败关闭；Gateway/内省不可用时返回 `503 identity_unavailable`，不得降级为匿名或相信客户端 owner；
- `/internal/v1/auth/introspect` 不经公网 Nginx `/gw/` 暴露；同主机使用 `http://gateway:8799` Compose 私网和独立高熵 service credential，Nginx 显式拒绝 `/gw/internal/*`。如果 Video Media Relay 迁到独立主机，内省改用服务间 HTTPS + mTLS/等价双向身份，不能开放公共匿名 introspection；服务凭据只存在 `gateway.env` 与 `video-media-relay.env`，有独立轮换与日志脱敏；
- Relay 从内省结果注入账户和 owner，拒绝请求体自报 owner/account；Sidecar 不持有 Relay service token、阿里云 API Key、OSS AccessKey 或可复用 bucket 凭据。Relay 不保存安装 access token，日志、receipt 和错误中一律脱敏；
- 所有创建/取消/ACK 请求都带 `Idempotency-Key`、`X-Request-Timestamp` 和版本化 schema。相同 key + canonical request hash 返回同一资源；相同 key + 不同 hash 返回 `409 idempotency_conflict`。过期/撤销会话、region/scope 不符、重复消费的单次能力和超出允许时钟偏差的请求失败关闭；
- `401/403/409/410/413/415/422/429/503` 均返回稳定 machine code、`request_id` 和安全信息，不回传 Provider key、内部 Prompt、bucket/key 或上游原始错误正文。

对象租约协议：

```ts
type CreateMediaObjectLeaseRequest = {
  local_operation_id: string
  purpose: 'visual_frames' | 'proxy_video' | 'audio_for_asr' | 'transcript_for_reasoning'
  content_hash: `sha256:${string}`
  byte_size: number
  content_type: string
  consent_revision_id: string
  consent_scope_hash: `sha256:${string}`
}

type MediaObjectLease = {
  lease_id: string
  state: 'awaiting_upload' | 'ready' | 'bound' | 'expired' | 'deleted'
  put_url?: string
  required_headers?: Record<string, string>
  object_ref?: string
  expires_at: string
}
```

- Relay 先验证用途、大小、MIME、region、账户额度和 consent scope，再签发绑定精确 hash/size/Content-Type、服务端对象 key 和单次 PUT 的 URL；不接受客户端 bucket/key，也不抓取客户端提供的任意 URL；
- `complete` 必须验证实际字节数、SHA-256、媒体类型和安全限制，成功后才返回 opaque `object_ref`。未 complete 的对象不能提交 Provider；同一 lease 不能换 hash、用途或 owner；
- `renew` 只能在过期前、对象尚被本地 Operation 或远程任务合法引用时延长同一租约，不能扩大权限；`DELETE` 是幂等 abort。上传失败、未 complete、取消和到期对象按保留策略清理；正在运行的上游任务只保留到可安全终止或结果回收；
- Relay 输出同样以只读结果租约返回，GET URL 绑定 operation/result/hash、单次或短期读取。Sidecar 下载并校验后必须先完成本地 CAS + SQLite/Event 事务，再调用 ACK；ACK 失败只重试 ACK，不重新提交 Provider。

统一 Operation 协议：

```ts
type VideoRelayCapability =
  | 'visual_evidence'
  | 'media_reasoning'
  | 'speech_transcription'
  | 'semantic_embedding'

type VideoRelayOperationBase = {
  local_operation_id: string
  consent_revision_id: string
  consent_scope_hash: `sha256:${string}`
  local_budget_reservation_id: string
  request_hash: `sha256:${string}`
}

type RelayEvidenceItem = {
  id: string
  kind: 'transcript' | 'visual_fact' | 'user_constraint' | 'delivery_intent'
  text: string
  source_range_id?: string
  confidence?: number
}

type CreateVideoRelayOperationRequest =
  | (VideoRelayOperationBase & {
      capability: 'visual_evidence'
      application_role: 'shot_evidence'
      input: {
        object_refs: string[]
        evidence_window_id: string
        facts_basis_hash: `sha256:${string}`
        language: string
        output_schema_version: number
      }
    })
  | (VideoRelayOperationBase & {
      capability: 'media_reasoning'
      application_role: 'planning' | 'caption_translation'
      input: {
        object_refs: string[]
        facts_basis_hash: `sha256:${string}`
        evidence: RelayEvidenceItem[]
        language: string
        output_schema_version: number
      }
    })
  | (VideoRelayOperationBase & {
      capability: 'speech_transcription'
      application_role: 'asr'
      input: {
        mode: 'short_sync' | 'long_async'
        audio_object_ref: string
        source_offset: RationalTime
        language?: string
        hotwords: string[]
        speaker_diarization: boolean
        sentence_timestamps: true
        word_timestamps: true
      }
    })
  | (VideoRelayOperationBase & {
      capability: 'semantic_embedding'
      application_role: 'search_index'
      input: {
        embedding_role: 'document' | 'query'
        items: Array<{ id: string; text: string }>
        model: 'text-embedding-v4'
        dimension: 768
        instruction_version: string
      }
    })

type VideoRelayOperationProjection = {
  id: string
  state: 'accepted' | 'submitted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown' | 'expired'
  provider_task_id?: string
  result_object_refs?: string[]
  provider_receipt?: ProviderExecutionReceipt
  account_quota_reservation_id: string
  safe_error_code?: string
  retry_after_ms?: number
  created_at: string
  updated_at: string
}
```

- `POST /operations` 只有在所有输入 `object_ref` ready、consent region/scope 一致且 Relay 账户额度已 reserve 后才接受；同步模型也先创建 Operation/receipt，再返回终态投影；
- 上述判别联合是公网请求的唯一输入形状；每个分支拒绝未知字段，并有 object/text/item/hotword/evidence 数量与字节上限。客户端不能提交任意 provider/model/temperature/token、OSS URL 或自由 `provider_options`；具体 Provider 参数只由 Relay 的版本化 capability policy 产生并写 receipt；
- Provider 提交前后分别持久化请求 hash、上游 task id/提交 receipt。断连时不能证明未提交则进入 `outcome_unknown`，相同 Idempotency-Key 只能对账原 Operation，禁止再次付费提交；
- 长任务由 Sidecar 持久轮询；首版不依赖桌面可达 webhook。`cancel` 只表达取消意图并记录 Provider 实际结果；`ack` 幂等确认本地已提交的 result hashes/receipt id，之后 Relay 才能提前释放结果对象；
- Relay receipt 是服务端 Provider/账户用量证据；Sidecar 以其结算本地 reservation，但 Relay 不保存 Project budget ledger。Relay 账户额度与 Sidecar 项目授权两层都必须通过，任一失败都不得调用 Provider；
- `video-media-relay/contracts/relayApi.ts` 必须成为 Sidecar 与 Relay 共享的唯一 schema 来源，并有双方 contract tests、重放/冲突、上传中断、lease 过期、ACK 丢失、`outcome_unknown` 和额度竞争测试。

#### 5.4.2 RemoteAnalysisConsent 固定状态合同

```ts
type RemoteAnalysisDataKind = 'audio_extract' | 'keyframes' | 'proxy_video' | 'transcript'

type RemoteAnalysisConsent = {
  id: string
  project_id: string
  revision: number
  state: 'active' | 'revoked'
  provider: 'aliyun_bailian'
  region: 'cn-beijing'
  purposes: Array<'visual_evidence' | 'planning' | 'caption_translation' | 'asr' | 'semantic_search'>
  data_kinds: RemoteAnalysisDataKind[]
  coverage: Array<{ source_id: string; ranges: SourceTimeRange[] }>
  acknowledged_estimate_hash: `sha256:${string}`
  granted_by_actor_id: string
  granted_at: string
  revoked_at?: string
}
```

- 每个远程 Operation 锁定 `consent_revision_id` 与规范化 scope hash；增加 data kind、Provider、region、用途或覆盖范围必须创建新 revision 并重新确认，不能修改旧 consent；
- revoke 立即禁止新租约、新提交和续租，并尽快取消/清理未提交派生物；已经交给 Provider 的请求不能伪装成已撤回，须显示实际状态和保留限制。已安全提交到本地的 Transcript/Evidence 仍可离线使用，除非用户另行执行本地删除；
- Consent 证明允许发送什么，项目 budget reservation 证明允许花多少，两者分别持久化且都绑定 Operation；Relay 只验证调用携带的签名身份、region 与 consent scope 摘要，不成为 Project/Consent writer；
- Application 必须提供 consent diff、revoke 后能力投影和完整审计 Event。API/IPC contract tests 覆盖无 consent、本次 scope 超界、旧 revision、撤回竞态和本地能力继续可用。

### 5.5 本地 BeatDetector 与 SubjectTracker 合同

本合同冻结能力和降级，不把具体第三方库写成不可替换的领域依赖。首个 Adapter 可以独立实现或采用经过许可证审查的 OpenCV/ONNX/WASM/DSP 组件，但必须在 macOS arm64 与 Windows x64 安装包中离线运行；GPL/AGPL 或需要运行时下载模型/二进制的实现不能未经单独许可审查进入正式包。

```ts
type BeatPoint = {
  at: RationalTime
  strength: number
  downbeat: boolean
}

type BeatGridEvidence = {
  source_id: string
  source_range: SourceTimeRange
  pcm_hash: `sha256:${string}`
  analyzer_version: string
  tempo_bpm?: number
  confidence: number
  beats: BeatPoint[]
  coverage: SourceTimeRange[]
  created_by_operation_id: string
}

type NormalizedBox = { x: number; y: number; width: number; height: number }

type SubjectTrackPoint = {
  at: RationalTime
  box: NormalizedBox
  confidence: number
  source: 'visual_anchor' | 'local_track' | 'manual'
}

type SubjectTrackEvidence = {
  source_id: string
  source_range: SourceTimeRange
  subject_id: string
  analyzer_version: string
  anchor_evidence_ids: string[]
  points: SubjectTrackPoint[]
  unresolved_ranges: Array<{ range: SourceTimeRange; reason: 'occluded' | 'left_frame' | 'ambiguous' | 'low_confidence' }>
  created_by_operation_id: string
}
```

规则：

- BeatDetector 接收 FFmpeg 解码的单声道 `pcm_f32le/22050Hz`，输出带 coverage、强度、downbeat、tempo 和 confidence 的版本化 BeatGrid；缓存键包含源 fingerprint、range、PCM hash、解码参数和 analyzer version；
- `confidence < 0.65`、有效 beat 少于 4 个或覆盖不完整时，Beat Sync 必须降级为普通 highlights，并把原因交给用户；不得用 LLM 补造 BPM 或等间距 beat；
- SubjectTracker 以 Host/VLM/人工确认的 bounding box 为 anchor，通过本地跨帧关联、光流/检测器、运动模型和平滑器或工程等价实现生成 track；VLM 不输出最终逐帧 keyframe；
- 连续低置信度或遮挡超过 500ms 时停止追随，先保持最后稳定构图；超过 2 秒或主体消失时回退到 `preserve`/安全中心构图并生成 unresolved range，不把推测位置写成确定事实；
- Composition Plan 只从经过 Validator 的 SubjectTrackEvidence 生成稀疏 transform keyframe；用户手工 keyframe 优先级最高，本地跟踪不能覆盖；
- BeatDetector、SubjectTracker、平滑器分别有 Port contract、确定性 fixture、版本 receipt、取消/超时和资源上限；替换算法只使引用旧 analyzer version 的对应 Evidence/Plan stale，不重做 ASR、Camera Shot 或无关事实。

---

## 6. 核心数据模型

### 6.1 精确时间、Timebase 与 FrameRate

参考 OpenTimelineIO 的时间思想，但 TypeScript 持久化合同不能用一个 `{ value: number, rate: number }` 同时表示 timebase、帧率和时间值：

```ts
type Rational = {
  num: number // safe integer
  den: number // positive safe integer
}

type RationalTime = {
  ticks: string       // 有符号 int64 的十进制字符串，避免 JSON/JS 浮点精度丢失
  tick_rate: Rational // 每秒 ticks，例如 30000/1001 或 90000/1
}

type TimeRange = {
  start: RationalTime
  duration: RationalTime
}

type MediaTimeBase = Rational // FFprobe stream time_base，例如 1/90000
type FrameRate = Rational     // 例如 30000/1001

type BrandedTimeRange<K extends string> = TimeRange & { readonly __time_domain: K }
type SourceTimeRange = BrandedTimeRange<'source'>
type EditorialTimeRange = BrandedTimeRange<'editorial'>
type DeliveryVariantTimeRange = BrandedTimeRange<'delivery_variant'>
```

规则：

- `num > 0`、`den > 0`，创建时约分并拒绝超出 safe-integer 的分子/分母；`ticks` 只由统一 int64 工具解析；
- `MediaTimeBase`、`FrameRate`、`RationalTime` 是三个不同语义，禁止互相赋值；
- API 可额外投影 `start_ms/end_ms` 供显示，但任何编辑命令必须回传原始 RationalTime 或稳定范围 ID，毫秒不能成为写入权威；
- 所有比较、加减、相交、rescale 和舍入通过统一工具；每次 rescale 显式指定 `floor/ceil/nearest`，剪辑入点默认 floor、出点默认 ceil，禁止各模块自行 `Math.round`；
- 处理 24、25、30、30000/1001、60000/1001 及音频 sample rate；
- VFR Source Range 保存原始 stream timebase/PTS；“帧边界”来自实际 packet/frame timestamp，不从 average frame rate 推算；
- Source Range、Editorial Timeline Range 与 Delivery Variant Range 必须实际使用上述不同 branded type，不能只在文字中声明后继续让 Command/Plan 全部接收裸 `TimeRange`；跨域转换只能通过带 source/version/rounding receipt 的统一函数完成。

### 6.2 VideoSource

补充：

```ts
type MediaStreamTiming = {
  stream_index: number
  time_base: MediaTimeBase
  start_time: RationalTime
  duration?: RationalTime
}

type VideoStreamInfo = MediaStreamTiming & {
  codec: string
  width: number
  height: number
  rotation: number
  average_frame_rate?: FrameRate
  nominal_frame_rate?: FrameRate
  variable_frame_rate: boolean
}

type AudioTrackInfo = MediaStreamTiming & {
  codec: string
  sample_rate: number
  channels: number
  channel_layout?: string
  language?: string
  title?: string
  disposition_default: boolean
}

type VideoSource = {
  id: string
  fast_identity: {
    byte_size: number
    mtime_ms: number
    file_id?: string
    head_tail_hash: `sha256:${string}`
  }
  fingerprint?: `sha256:${string}`
  fingerprint_state: 'pending' | 'ready' | 'failed'
  primary_video_stream: VideoStreamInfo
  presentation_duration: RationalTime
  audio_tracks: AudioTrackInfo[]
  state: 'probing' | 'ready' | 'missing' | 'changed' | 'unsupported'
}
```

导入首先取得 fast identity 和 FFprobe metadata，让素材尽快可见；完整 SHA-256 作为独立可恢复 Operation 在后台计算。任何远程上传、跨项目缓存复用、正式 Timeline 冻结和最终导出开始前都必须已有完整 fingerprint。fast identity 只能用于检测“可能未变化”，不能作为内容寻址或安全证明。

每个流的 `time_base/start_time/duration` 必须保留 FFprobe 原始值；其中 `RationalTime.tick_rate` 必须与该流 `time_base` 的倒数严格一致。导入时显式选择 `primary_video_stream`，视频 `SourceTimeRange` 以该流 PTS 为权威；每个音轨保留自己的 stream index/timebase/start offset，Execution Plan 必须显式记录所选音轨和到 Editorial timebase 的 rescale/offset。`presentation_duration` 是把选中流映射到统一显示域后的可见总时长，不可反过来替代任一流的原始 PTS。音频早于或晚于主视频、负 start_time、edit list 和 VFR fixture 都必须进入 compiler/preview/render 合同测试。

### 6.3 VideoDerivative

```ts
type VideoDerivativeKind =
  | 'proxy'
  | 'thumbnail'
  | 'waveform'
  | 'audio_extract'
  | 'scene_map'
  | 'keyframe'

type VideoDerivative = {
  id: string
  project_id: string
  source_id: string
  source_fingerprint: `sha256:${string}`
  kind: VideoDerivativeKind
  source_range?: SourceTimeRange
  asset: AssetReference
  content_hash: `sha256:${string}`
  byte_size: number
  generator_name: string
  generator_version: string
  parameters_hash: `sha256:${string}`
  created_by_operation_id: string
  created_at: string
  state: 'ready' | 'stale' | 'missing'
}
```

规则：

- 可重建；
- source 变更即 stale；
- LRU 可清理；
- 不影响原素材；
- 代理用于分析和预览，原片用于最终导出。

### 6.4 TimedTranscript

```ts
type TranscriptWord = {
  id: string
  start: RationalTime
  duration: RationalTime
  text: string
  confidence?: number
}

type TranscriptSegment = {
  id: string
  source_id: string
  start: RationalTime
  duration: RationalTime
  text: string
  speaker_id?: string
  words: TranscriptWord[]
}

type TimedTranscript = {
  id: string
  source_id: string
  source_fingerprint: `sha256:${string}`
  model_receipt_id: string
  source_offset: RationalTime
  language?: string
  segments: TranscriptSegment[]
}

type TranscriptEdit =
  | { kind: 'replace_text'; segment_id: string; text: string }
  | { kind: 'set_speaker'; segment_ids: string[]; speaker_id: string }
  | { kind: 'split_segment'; segment_id: string; at_word_id: string }
  | { kind: 'merge_segments'; segment_ids: string[] }

type TranscriptRevision = {
  id: string
  transcript_id: string
  parent_revision_id?: string
  base_transcript_fingerprint: `sha256:${string}`
  edits: TranscriptEdit[]
  created_at: string
}
```

原始 transcript 不允许被字幕编辑覆盖。用户修正错字、说话人或断句时创建带父版本的 `TranscriptRevision`；Revision 只修改文字投影和分组，所有 edit 仍锚定原始 Segment/Word。新插入但无原始音频对应的文字标记为 `unanchored`，不能直接生成剪切命令。原始时间码和 ASR 回包保持只读，修正后的文本以 `active_revision_id` 投影给搜索、规划和字幕。

### 6.5 Camera Shot、Content Segment 与 Evidence Window

```ts
type SourceRangeDecisionValue =
  | 'required'
  | 'pick'
  | 'maybe'
  | 'reject'

type CameraShot = {
  id: string
  source_id: string
  source_fingerprint: `sha256:${string}`
  range: SourceTimeRange
  boundary_source:
    | 'scene_detect'
    | 'embedded_cut_marker'
    | 'manual'
  boundary_confidence?: number
}

type ContentSegment = {
  id: string
  source_id: string
  range: SourceTimeRange
  camera_shot_ids: string[]
  segmentation_source:
    | 'transcript_topic'
    | 'sentence_group'
    | 'silence'
    | 'motion_change'
    | 'ocr_change'
    | 'fixed_interval_fallback'
    | 'manual'
}

type EvidenceWindow = {
  id: string
  source_id: string
  camera_shot_id?: string
  content_segment_id?: string
  range: SourceTimeRange
  sample_strategy:
    | 'representative_frame'
    | 'start_middle_end'
    | 'visual_change_points'
    | 'transcript_signal'
    | 'short_proxy'
  keyframe_derivative_ids: string[]
  proxy_derivative_id?: string
  transcript_segment_ids: string[]
  evidence_ids: string[]
  analysis_depth: 'summary' | 'standard' | 'deep'
  sampling_receipt_id: string
}

type SourceRangeDecision = {
  id: string
  project_id: string
  target:
    | { kind: 'camera_shot'; id: string }
    | { kind: 'content_segment'; id: string }
    | { kind: 'source_range'; source_id: string; range: SourceTimeRange }
  value: SourceRangeDecisionValue
  origin: 'user' | 'ai_recommendation'
  reason?: string
  base_facts_revision: string
  created_at: string
}

type VisualQualityMetrics = {
  target_id: string
  quality: {
    sharpness?: number
    stability?: number
    exposure?: number
    composition?: number
  }
  warnings: string[]
}
```

规则：

- Camera Shot 只表达真实或人工确认的镜头切换；静音和固定间隔不是 Camera Shot 边界；
- Content Segment 表达镜头内部或跨镜头的内容单元，可由口播主题、动作、静音和 OCR 变化产生；
- Evidence Window 是唯一允许送入视觉模型的范围。每个短静态 Shot 可只用代表帧；长口播至少覆盖首/中/尾并结合 Transcript；长演示/屏录/动作片按视觉/OCR/运动变化增加窗口；仍无法判断时只发送对应短低清代理；
- 不设置“复杂 Shot 最多三张”的业务上限。预算以单 Source/项目的窗口数、总帧数、代理秒数和 token 限额控制；达到预算时返回未覆盖区间，等待用户扩大分析范围；
- `required/pick/maybe/reject` 属于可版本化的 Source Range Decision；时间线 `lock` 只属于 Timeline Item/Track，二者不能通过优先级混在一个字段中；
- AI Recommendation 和 User Decision 是不同记录；相同目标上的最新用户决定覆盖推荐投影，但不删除历史记录；互相重叠的 `required`/`reject` 必须在规划前报告冲突；
- 一个 50 秒 Camera Shot 可以对应多个 Content Segment 和多个 Evidence Window，任何一张中心帧都不得被当成整个 Shot 的完整事实。

### 6.6 Evidence

```ts
type EvidenceBase = {
  id: string
  source_id: string
  camera_shot_id?: string
  content_segment_id?: string
  evidence_window_id?: string
  range: SourceTimeRange
  derivative_ids: string[]
  provider_receipt_id?: string
  confidence?: number
  facts_schema_version: number
  prompt_version: string
  basis_hash: `sha256:${string}`
  created_at: string
}

type VideoEvidence =
  | (EvidenceBase & {
      kind: 'transcript'
      payload: { transcript_id: string; revision_id?: string; segment_ids: string[]; text: string; speaker_ids: string[] }
    })
  | (EvidenceBase & {
      kind: 'visual'
      payload: { summary: string; subjects: string[]; setting?: string; camera_motion?: string; warnings: string[] }
    })
  | (EvidenceBase & {
      kind: 'ocr'
      payload: { blocks: Array<{ text: string; normalized_box: [number, number, number, number] }> }
    })
  | (EvidenceBase & {
      kind: 'quality'
      payload: { metric: 'sharpness' | 'stability' | 'exposure' | 'black_frame'; score: number; threshold_version: string }
    })
  | (EvidenceBase & {
      kind: 'object'
      payload: { label: string; normalized_box?: [number, number, number, number]; subject_id?: string }
    })
  | (EvidenceBase & {
      kind: 'action'
      payload: { label: string; phase?: 'start' | 'middle' | 'end' | 'complete'; actor_subject_id?: string }
    })
  | (EvidenceBase & {
      kind: 'beat_grid'
      payload: { bpm?: number; beat_times: RationalTime[]; confidence: number; analyzer_version: string }
    })
```

Host 创建 ID、范围、basis hash 和可信关联；模型不能生成可信 ID，也不能返回任意 `kind/payload`。Provider adapter 必须用 Zod 判别联合严格解析，未知字段不进入领域对象；部分批次解析失败只重试失败窗口并保留已经提交的有效 Evidence。

### 6.7 Delivery Intent 与时长可行性

时长是用户意图和素材事实共同决定的约束，不是按原始素材总时长或每个素材平均切分得到的数字。它必须在项目领域中持久化、版本化，并作为规划输入的快照。

```ts
type VideoDurationMode = 'natural' | 'target' | 'exact'

type VideoEditingStrategy =
  | 'manual'
  | 'speech_story'
  | 'highlights'
  | 'beat_sync'
  | 'mixed'

type VideoCoveragePreference =
  | 'highlights'
  | 'balanced'
  | 'complete_when_feasible'

type VideoDeliveryIntent = {
  id: string
  project_id: string
  goal: string
  duration_mode: VideoDurationMode
  target_duration?: RationalTime
  target_min_duration?: RationalTime
  target_max_duration?: RationalTime
  exact_tolerance?: RationalTime
  coverage_preference: VideoCoveragePreference
  editing_strategy: VideoEditingStrategy
  revision: number
  created_at: string
  updated_at: string
}

type VideoDurationFeasibility = {
  id: string
  project_id: string
  intent_revision: number
  facts_basis_hash: `sha256:${string}`
  natural_duration_range: { min: RationalTime; max: RationalTime }
  recommended_variants: Array<{
    id: string
    label: string
    estimated_duration: RationalTime
    coverage: VideoCoveragePreference
    included_segment_ids: string[]
    omissions: Array<{ target_id: string; reason: string }>
  }>
  fit_status: 'fit' | 'insufficient_material' | 'excess_material' | 'required_conflict'
  warnings: string[]
}
```

规则：

- `natural` 不要求用户预先填写分钟数；后端根据目标和可用内容提出方案；
- `target` 支持“约 1–2 分钟”这类范围，而不是强制精确秒数；
- `exact` 只用于确有交付时长要求的场景，并必须显式保存容差；
- 可行性依据可用 Content Segment、Camera Shot、转写、Evidence 以及 Source Range Decision 计算，不以原始素材总时长替代；时间线锁定项只在已有 Editorial Timeline 上参与冲突判断；
- 方案必须说明哪些内容被省略；`required`、`reject`、`lock` 与时长相冲突时必须失败关闭并报告冲突；
- 精确时长优先通过选段、删减和节奏编排达成；不得自动变速、循环或冻结素材来凑时长。此类效果只能由用户明确创建；
- 前端以后只编辑或确认这一意图和推荐方案；它不得另行计算时长或把固定档位当作状态权威。

### 6.8 Plan

```ts
type VideoPlanBase = {
  id: string
  project_revision: number
  facts_basis_hash: `sha256:${string}`
  delivery_intent_id: string
  delivery_intent_revision: number
  duration_feasibility_id: string
  target_duration?: RationalTime
  warnings: string[]
  provider_receipt_id: string
}

type VideoPlan =
  | (VideoPlanBase & {
      kind: 'outline'
      chapters: Array<{ id: string; goal: string; target_duration?: RationalTime; candidate_segment_ids: string[] }>
    })
  | (VideoPlanBase & {
      kind: 'chapter'
      chapter_id: string
      proposed_items: Array<{ source_id: string; source_range: SourceTimeRange; evidence_ids: string[]; rationale: string }>
    })
  | (VideoPlanBase & {
      kind: 'global_review'
      chapter_plan_ids: string[]
      conflicts: string[]
      omissions: Array<{ target_id: string; reason: string }>
    })
```

`natural` 模式允许所有 Plan 的 `target_duration` 为空，由 Outline/Feasibility 给出自然区间；只有用户选定推荐变体或 `target/exact` 模式才冻结目标时长。Plan 的 stale 判断使用其实际引用的 basis hash，不因项目标题、未使用素材或无关 Review Note 改变而全局失效。

### 6.9 Timeline v2

```ts
type TimelineTrackKind =
  | 'primary_video'
  | 'b_roll'
  | 'source_audio'
  | 'music'
  | 'caption'
  | 'overlay'

type TimelineTrack = {
  id: string
  kind: TimelineTrackKind
  order: number
  locked: boolean
  muted: boolean
}

type TimelineAssetBinding =
  | { kind: 'source'; source_id: string; source_fingerprint: `sha256:${string}`; source_range: SourceTimeRange }
  | { kind: 'project_asset'; asset_id: string; asset_content_hash: `sha256:${string}`; source_range?: SourceTimeRange }
  | { kind: 'caption_document'; caption_document_id: string; caption_revision_id: string }

type TimelineItem = {
  id: string
  track_id: string
  kind: 'video' | 'audio' | 'caption' | 'overlay'
  timeline_range: EditorialTimeRange
  binding: TimelineAssetBinding
  linked_camera_shot_ids: string[]
  linked_content_segment_ids: string[]
  locked: boolean
  evidence_ids: string[]
}

type TimelineDraft = {
  id: string
  project_id: string
  facts_basis_hash: `sha256:${string}`
  plan_ids: string[]
  tracks: TimelineTrack[]
  items: TimelineItem[]
  status: 'proposed' | 'accepted' | 'rejected' | 'stale'
  created_at: string
}

type EditorialTimelineVersion = {
  schema_version: 2
  id: string
  parent_version_id?: string
  project_revision: number
  source_fingerprint_set_hash: `sha256:${string}`
  facts_basis_hash: `sha256:${string}`
  tick_rate: Rational
  tracks: TimelineTrack[]
  items: TimelineItem[]
  created_by_command_set_id: string
  created_at: string
}

type Keyframe<T> = {
  at: RationalTime
  value: T
  interpolation: 'hold' | 'linear' | 'bezier'
}

type DeliveryItemOverride = {
  item_id: string
  transform_keyframes?: Array<Keyframe<{ x: number; y: number; scale: number; rotation: number; opacity: number }>>
  volume_keyframes?: Array<Keyframe<number>>
  fade_in?: RationalTime
  fade_out?: RationalTime
  caption_style_id?: string
}

type DeliveryVariantVersion = {
  id: string
  variant_id: string
  parent_version_id?: string
  editorial_timeline_version_id: string
  export_profile_revision_id: string
  export_profile_hash: `sha256:${string}`
  composition_plan_id?: string
  caption_revision_id?: string
  audio_finishing_plan_id?: string
  item_overrides: DeliveryItemOverride[]
  created_by_command_set_id: string
  created_at: string
}
```

```ts
type InitialEncodingProfile =
  | {
      container: 'mp4' | 'mov'
      video: { codec: 'h264'; quality: { mode: 'crf'; value: number; preset: 'fast' | 'medium' | 'slow' } }
      audio: { codec: 'aac_lc'; sample_rate: 48_000; channels: 1 | 2 }
      output_color: { range: 'sdr_bt709'; pixel_format: 'yuv420p' }
    }
  | {
      container: 'mov'
      video: { codec: 'prores_422'; quality: { mode: 'prores_profile'; profile: 'standard' | 'hq' } }
      audio: { codec: 'pcm_s16le'; sample_rate: 48_000; channels: 1 | 2 }
      output_color: { range: 'sdr_bt709'; pixel_format: 'yuv422p10le' }
    }

type VideoExportProfileRevision = {
  id: string
  profile_id: string
  revision: number
  target: 'custom' | 'horizontal_video' | 'vertical_short' | 'square_social'
  width: number
  height: number
  frame_rate: FrameRate
  encoding: InitialEncodingProfile
  hdr_input_policy: 'tone_map_to_sdr' | 'reject'
  caption_mode: 'none' | 'burn_in' | 'sidecar'
  sidecar_caption_format?: 'srt' | 'vtt'
  audio_policy: 'source_only' | 'music_with_source' | 'music_only'
  content_hash: `sha256:${string}`
  created_at: string
}

type VideoExportProfile = {
  id: string
  scope: 'product_preset' | 'project_custom'
  current_revision_id: string
  created_at: string
}

type DeliveryVariant = {
  id: string
  project_id: string
  name: string
  current_version_id: string
  created_at: string
}

type EditorialTimelineCommand =
  | { kind: 'insert'; track_id: string; item: TimelineItem }
  | { kind: 'trim'; item_id: string; source_range: SourceTimeRange; timeline_range: EditorialTimeRange }
  | { kind: 'split'; item_id: string; at: RationalTime }
  | { kind: 'reorder'; item_id: string; track_id: string; timeline_start: RationalTime }
  | { kind: 'replace'; item_id: string; replacement: TimelineItem }
  | { kind: 'ripple_delete'; item_ids: string[]; close_gap: boolean }
  | { kind: 'set_track_state'; track_id: string; locked?: boolean; muted?: boolean }
  | { kind: 'lock'; item_ids: string[]; locked: boolean }

type DeliveryVariantCommand =
  | { kind: 'set_caption_revision'; caption_document_id: string; caption_revision_id: string }
  | { kind: 'set_transform_keyframes'; item_id: string; keyframes: Array<Keyframe<{ x: number; y: number; scale: number; rotation: number; opacity: number }>> }
  | { kind: 'set_volume_keyframes'; item_id: string; keyframes: Array<Keyframe<number>> }
  | { kind: 'set_audio_fades'; item_id: string; fade_in?: RationalTime; fade_out?: RationalTime }
  | { kind: 'set_caption_style'; item_id: string; caption_style_id: string }
  | { kind: 'set_export_profile'; export_profile_revision_id: string; expected_profile_hash: `sha256:${string}` }

type CommandSetBase = {
  id: string
  project_id: string
  actor_id: string
  idempotency_key: string
  created_at: string
}

type TimelineCommandSet =
  | (CommandSetBase & {
      target: { kind: 'editorial'; base_timeline_version_id: string }
      commands: EditorialTimelineCommand[]
    })
  | (CommandSetBase & {
      target: { kind: 'delivery_variant'; variant_id: string; base_variant_version_id: string }
      commands: DeliveryVariantCommand[]
    })
```

音乐、B-roll、Logo、字体、片头片尾和配音必须通过 `project_asset` 绑定到项目拥有或用户声明已获授权的 Asset；不得把远程 URL 或无来源文件直接写入时间线。系统记录 provenance/license/用户声明，但不能宣称自动判断版权真伪。自动配乐、循环、冻结或变速都不是时长填充手段；若未来支持，必须增加明确的 typed command、Validator 和 Compiler，不得塞进任意 effect payload。

初始执行支持：

- primary video；
- source audio；
- caption；
- b-roll；
- music；
- overlay；
- volume；
- fade；
- 静态与关键帧 transform；
- 字幕样式与画幅安全区。

初始版本不支持的转场、复杂调色、速度曲线或三维效果必须由 Validator 失败关闭，不能静默忽略。所有 Proposal accept、Caption/Composition/Audio Plan accept 和手工编辑最终都只能生成一个 `TimelineCommandSet`；Application 可提供多个便利 API，但领域内只有 `applyCommandSet` 一个写入口。Editorial Command 创建新的 `EditorialTimelineVersion`；Variant Command 创建新的 `DeliveryVariantVersion`，两者均不原地覆盖父版本。

### 6.9.1 首版导出白名单

首版不把“本机 FFmpeg 能编码”当作产品支持。只支持以下经过两平台 fixture 验证的组合：

| Container | Video | Audio | Pixel format / color | 用途 |
|---|---|---|---|---|
| MP4 | H.264 | AAC-LC 48kHz mono/stereo | `yuv420p` / SDR BT.709 | 横屏、竖屏、方形默认交付 |
| MOV | H.264 | AAC-LC 48kHz mono/stereo | `yuv420p` / SDR BT.709 | 需要 MOV 容器的通用交付 |
| MOV | ProRes 422 / 422 HQ | PCM s16le 48kHz mono/stereo | `yuv422p10le` / SDR BT.709 | 中间母版与后续专业软件接力 |

白名单规则：

- 允许帧率只有 `24000/1001`、24、25、`30000/1001`、30、50、`60000/1001`、60；导入素材的其他帧率不静默取整，用户必须选择最接近的合法 profile；
- width/height 必须为正偶数，单边不超过 4096，像素总数不超过 8,847,360；横竖屏可交换宽高，方形遵守同一像素预算；
- 首版不交付 HDR。HDR/HLG/PQ 输入只能按有 fixture 的 tone-map pipeline 显式转换为 SDR BT.709，或者由 `hdr_input_policy='reject'` 阻止导出；不得只改 metadata 假装已经转换；
- H.264 使用 CRF 质量模式，Validator 允许 16–28；默认 20，硬件编码路径使用与该 profile 视觉质量等价的受测参数。ProRes 只允许 standard/hq profile；ProRes 不能搭配 MP4 或 AAC；
- `caption_mode='sidecar'` 时必须给出 `srt` 或 `vtt`，sidecar 与视频共享 basis/output basename 并分别 hash/verify；`burn_in` 必须在 preflight 验证字体、字形、安全区和颜色；
- macOS 可优先使用 VideoToolbox，Windows 可使用经过 capability probe 和 fixture 验证的 QSV/NVENC/AMF；任何硬件路径失败都回退到 `libx264`，保持尺寸、帧率、颜色和音频规格不变，并写 Execution Receipt。ProRes 首版统一使用受测软件编码路径；
- HEVC、AV1、VP9、WebM、MKV、HDR passthrough、任意 bitrate、任意 FFmpeg filter 和未列出的 codec/container 组合均不属于首版；API 返回 `VIDEO_EXPORT_PROFILE_UNSUPPORTED`，不能把字符串透传给 FFmpeg；
- `VideoExportProfile` 是 head，`VideoExportProfileRevision` 是不可变产品 preset/custom snapshot。Renderer 只能选择 Host 返回的 revision id/hash，或提交由同一 Validator 收紧后创建的新 custom revision；模型只能建议已有 revision id/hash，不能生成 codec 参数。每个 `DeliveryVariantVersion` 锁定 revision id + hash，历史 Preview/Render 永远读取该 revision，不跟随 profile head 漂移。`DeliveryVariant` head 不重复保存 export profile 或 editorial timeline version；两者权威值只来自 `current_version_id` 指向的不可变 Variant Version。

### 6.10 创作协作、快速成片与质量合同

视频项目必须同时服务两类入口：

```text
快速成片
  普通用户只确认 Recipe、重点人物/片段、用途和时长
  → 在素材、预算和策略确实支持差异化时得到 2–3 个候选；否则得到 1 个草稿并说明为什么没有伪造更多方案

创作工作台
  内容创作者可检索素材、编辑文本、标记 Segment/Range、锁定 Timeline Item、直接操作时间线、对话迭代
  → 得到同一套事实和版本机制支持的正式 Timeline
```

两者只能是同一 Video Project 的不同交互入口；快速成片绝不能绕过 Source、Decision、Proposal、Validator、Editorial Timeline Version 或 Delivery Variant Version。

```ts
type CreativeRecipeId =
  | 'memory_recap'
  | 'event_recap'
  | 'talking_head_highlight'
  | 'course_condense'
  | 'product_explainer'
  | 'podcast_clips'

type CreativeRecipe = {
  id: CreativeRecipeId
  label: string
  defaults: {
    editing_strategy: VideoEditingStrategy
    duration_mode: VideoDurationMode
    output_target: VideoExportProfileRevision['target']
    caption_policy: 'off' | 'auto_draft' | 'required'
    composition_policy: 'preserve' | 'auto_reframe'
    audio_finishing_policy: 'preserve' | 'voice_cleanup'
  }
  required_questions: Array<'goal' | 'subject' | 'must_preserve' | 'duration'>
}

type ContextAnchor =
  | { kind: 'project' }
  | { kind: 'source'; source_id: string }
  | { kind: 'camera_shot'; camera_shot_id: string }
  | { kind: 'content_segment'; content_segment_id: string }
  | { kind: 'evidence_window'; evidence_window_id: string }
  | { kind: 'transcript_range'; transcript_id: string; range: SourceTimeRange }
  | { kind: 'timeline_range'; editorial_timeline_version_id: string; range: EditorialTimeRange }
  | { kind: 'timeline_item'; editorial_timeline_version_id: string; item_id: string }
  | { kind: 'delivery_variant'; variant_version_id: string; item_id?: string }

type CreativeSession = {
  id: string
  project_id: string
  title: string
  created_at: string
  archived_at?: string
}

type CreativeMessage = {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  text: string
  anchors: ContextAnchor[]
  response_ids: string[]
  proposal_ids: string[]
  provider_receipt_id?: string
  created_at: string
}

type CreativeResponse = {
  id: string
  project_id: string
  session_id: string
  kind: 'answer' | 'search_result'
  anchors: ContextAnchor[]
  evidence_ids: string[]
  text: string
  created_at: string
}

type CreativeProposal = {
  id: string
  project_id: string
  session_id: string
  created_by_message_id: string
  base_project_revision: number
  facts_basis_hash: `sha256:${string}`
  base_timeline_version_id?: string
  base_variant_version_id?: string
  anchors: ContextAnchor[]
  kind: 'timeline_draft' | 'timeline_patch' | 'delivery_variant_patch' | 'quality_fix'
  summary: string
  rationale: string[]
  evidence_ids: string[]
  proposed_timeline_draft_id?: string
  proposed_command_set?: TimelineCommandSet
  estimated_duration?: RationalTime
  quality_report_id?: string
  provider_receipt_ids: string[]
  actual_cost: {
    model_calls: number
    total_tokens: number
    input_bytes: number
    visual_frames: number
    proxy_seconds: number
    asr_seconds: number
    cache_hits: number
  }
  status: 'proposed' | 'accepted' | 'partially_accepted' | 'rejected' | 'stale'
  created_at: string
}

type PreflightQualityTarget =
  | { kind: 'timeline_draft'; draft_id: string }
  | { kind: 'delivery_variant'; editorial_timeline_version_id: string; variant_version_id: string }

type QualityCheck<K extends string> = {
  kind: K
  status: 'pass' | 'warning' | 'fail'
  message: string
  evidence_ids: string[]
  item_ids: string[]
}

type QualityReportBase = {
  id: string
  project_id: string
  basis_hash: `sha256:${string}`
  validator_version: string
  verdict: 'ready_for_review' | 'needs_user_decision' | 'blocked'
  provider_receipt_ids: string[]
  created_at: string
}

type VideoQualityReport =
  | (QualityReportBase & {
      phase: 'preflight'
      target: PreflightQualityTarget
      checks: Array<QualityCheck<
        | 'required_content'
        | 'cut_boundary'
        | 'duplicate_or_black_frame'
        | 'visual_quality'
        | 'audio_clarity'
        | 'caption_alignment'
        | 'safe_area'
        | 'duration'
        | 'asset_rights'
      >>
    })
  | (QualityReportBase & {
      phase: 'post_render'
      target: { kind: 'rendered_output'; render_operation_id: string; output_asset_id: string }
      checks: Array<QualityCheck<'export_integrity' | 'decode_integrity' | 'duration' | 'audio_clarity'>>
    })

type ReviewNote = {
  id: string
  project_id: string
  timeline_version_id: string
  anchor: ContextAnchor
  body: string
  status: 'open' | 'addressed' | 'dismissed'
  actor_id: string
  event_sequence: number
  resolution_proposal_id?: string
  resolved_by_timeline_version_id?: string
  resolved_by_variant_version_id?: string
  created_at: string
  resolved_at?: string
}

type ApprovalDecision = {
  id: string
  project_id: string
  timeline_version_id: string
  state: 'approved' | 'changes_requested'
  actor_id: string
  event_sequence: number
  note_ids: string[]
  created_at: string
}
```

规则：

- Answer/Search Result 是只读 `CreativeResponse`，不参与接受/拒绝状态机；只有能产生 Draft/CommandSet 的动作才是 `CreativeProposal`；
- `CreativeProposal` 必须引用实际使用的 facts basis 与 Timeline/Variant version；接受前只检查相关 basis，不能因项目改名等无关变化 stale，也不能把旧建议应用到已改变的目标版本；
- 对话模型只能查询 `Media Index`、创建 Proposal、提出澄清问题；它没有文件、FFmpeg 或正式 Timeline 写权限；
- Context Compiler 每轮只注入显式 Anchor、相关 Search Result、当前目标版本摘要和有界最近消息；不能把全部项目 payload、全部 Transcript 和完整历史每轮重发。较长会话摘要只是可重建上下文投影，不是项目事实；所有引用仍回到稳定 ID/basis；
- 用户可接受整份 Proposal，也可只选择其中的命令；接受后仍必须经过 Timeline Validator 和不可变版本写入；
- 搜索同时覆盖 Transcript 全文、用户修订文本、Camera Shot/Content Segment/Evidence 标签和语义向量，结果永远返回 Source/Segment/时间范围与索引代次，不返回脱离素材事实的答案；
- 文本剪辑必须映射到原始或修订 Transcript 的时间锚点；删除、移动或重排一句话时生成差异预览和 TimelineCommandSet，不得改写原始 ASR；无锚点的用户新增文字只能进入字幕或脚本，不能假装存在对应音频；
- `QualityReport` 不是审美裁判或“爆款预测”。它只验证可解释的内容完整性、剪辑边界、基础技术质量与用户约束；无法判断的取舍必须交还用户；
- 每个 Quick Create 草稿和 Delivery Variant 必须先产生 preflight QualityReport；preflight 不得声称检查过尚不存在的导出文件。Render 完成后必须产生 OutputVerification 和 post-render QualityReport；`blocked` 或 `needs_user_decision` 时禁止被标记为可直接交付；
- Review Note 永远钉在指定 Timeline/Variant Version 与 Context Anchor 上；“已解决”只能追加关联新的 Proposal、Timeline Version 或 Variant Version，不能修改旧版本或让反馈失去上下文；Approval 是不可变事件，“pending”只是尚无审批事件的查询投影。

### 6.11 字幕、智能构图、音频完成与风格资产

这些能力是让普通用户的自动草稿可用、让创作者规模化产出的基础完成层，不应混入 Planning 模型的自由文本输出。

```text
Transcript Revision
→ Caption Draft / Caption Review
→ Caption Track 或 Sidecar Caption Asset

Timeline / Speaker / Subject Evidence
→ Composition Plan（安全区、主体、裁切、动态重构图）
→ 可编辑 Transform / Keyframe Commands

Audio Track Analysis
→ Audio Finishing Plan（降噪、响度、静音/口头禅建议、ducking）
→ 可单独接受的 Audio Commands
```

```ts
type CaptionCue = {
  id: string
  source_anchor: { transcript_id: string; segment_ids: string[]; word_ids: string[] }
  timeline_range: EditorialTimeRange
  text: string
  translation_of_cue_id?: string
  alignment_confidence: number
}

type CaptionDocumentRevision = {
  id: string
  document_id: string
  parent_revision_id?: string
  editorial_timeline_version_id: string
  language: string
  cues: CaptionCue[]
  style_id?: string
  created_at: string
}

type CompositionPlan = {
  id: string
  editorial_timeline_version_id: string
  export_profile_revision_id: string
  export_profile_hash: `sha256:${string}`
  facts_basis_hash: `sha256:${string}`
  subject_evidence_ids: string[]
  proposed_commands: DeliveryVariantCommand[]
  unresolved_ranges: Array<{ item_id: string; range: DeliveryVariantTimeRange; reason: string }>
  created_at: string
}

type AudioFinishingPlan = {
  id: string
  editorial_timeline_version_id: string
  analysis_receipt_ids: string[]
  measured_loudness: Array<{ item_id: string; integrated_lufs?: number; true_peak_db?: number }>
  proposed_commands: DeliveryVariantCommand[]
  semantic_cut_suggestions: Array<{ source_id: string; range: SourceTimeRange; kind: 'silence' | 'filler'; transcript_anchor_ids: string[] }>
  created_at: string
}
```

- Caption 必须有独立 `CaptionDocument` 与 Revision；字幕纠错、断句、翻译和样式不能覆盖原始转写；
- 自动删停顿、口头禅、降噪、均衡响度、音乐 ducking 都必须是可预览且可拒绝的命令，不能默认改变原声含义；
- `CompositionPlan` 必须基于 Subject/Active Speaker/安全区证据生成；无可靠主体证据时保留原构图，不能盲目裁切人脸或重要物体；
- Brand Pack/Style Preset 只包含用户拥有的字体、颜色、Logo、字幕样式、片头片尾、音乐和导出默认项；每个 Asset 都要经过已有的来源/授权校验；
- Beat Sync 必须先生成本地 `beat_grid` Evidence，再由规划选择切点；没有可靠节拍证据时降级为普通 highlights，不能让模型凭文字猜 BPM；
- 字幕翻译由 MediaReasoning 生成候选 Revision，保留源 cue 和时间锚点；翻译不得自动延长/压缩源音频；
- 同宽高比只改变分辨率、码率或编码器时，只重新编译/渲染；改变宽高比、字幕安全区或品牌布局时，不重做 Transcript/Camera Shot/内容规划，但必须重做对应 Composition/Caption Plan、Delivery Variant preflight 和预览；
- Editorial Timeline 改变后，受影响的 Caption/Composition/Audio Plan、Variant Version、Quality Report 和 Compile Plan stale；未引用该 Timeline 的 Media Facts 与搜索索引保持有效。

---

## 7. 完整任务 DAG

### 7.1 Operation 类型

```text
video.probe
video.full_fingerprint
video.proxy
video.thumbnail
video.waveform
video.audio_extract
video.camera_shots
video.content_segments
video.evidence_windows
video.keyframes
video.transcribe
video.understand
video.index
video.beat_analyze
video.curate
video.assess_duration
video.plan_outline
video.plan_chapter
video.plan_review
video.creative_propose
video.caption_draft
video.composition_plan
video.audio_finish_plan
video.apply_command_set
video.quality_preflight
video.timeline_compile
video.preview
video.render
video.output_verify
video.quality_post_render
```

### 7.2 依赖关系

```text
probe
├── full_fingerprint
├── proxy（按分析范围延迟生成）
├── thumbnail
├── waveform
├── audio_extract → transcribe
├── camera_shots
├── content_segments（无转写时先生成本地 fallback，转写后增量完善）
└── camera_shots + content_segments → evidence_windows → keyframes/short proxy → understand

transcribe + understand + local quality/beat evidence
→ index generation → curate

curate + user decisions
→ assess_duration
→ plan_outline
→ plan_chapter 1..N
→ plan_review
→ Timeline Draft / Creative Proposal
→ draft preflight
→ user accepts Proposal or submits TimelineCommandSet
→ Editorial Timeline Version
→ create/select Delivery Variant
→ caption/composition/audio plans
→ user accepts Variant CommandSet
→ Delivery Variant Version
→ variant preflight
→ compile → preview
→ explicit render → output_verify → quality_post_render
```

上图是能力依赖，不是要求每个项目创建所有节点：无音轨不创建 transcribe/audio 节点，用户未授权远程视觉时不创建 understand 节点，手工模式可以从本地 Facts 直接进入 Timeline Command。Join 只等待本次 Operation Graph 实际创建的依赖；失败依赖使下游明确 `skipped/blocked_by_dependency`，不能永远留在 queued。

所有 Operation 除输入快照外必须声明分阶段资源需求：`local_cpu`、`local_gpu`、`disk_io`、`remote_asr`、`remote_visual`、`remote_reasoning`、`remote_embedding`、`render`。一个 Operation 可以依次申请多个资源，但不能持有本地 GPU 等待远程响应。`Job Orchestrator` 在项目之间统一限制并发，优先保证播放、用户显式预览和交互查询；后台任务应降低进程优先级并在低磁盘/高负载时暂停新任务，不得仅串行最终 Render 而允许多个代理生成、抽帧或深度分析同时耗尽设备资源。

### 7.3 Operation 状态、幂等和恢复

```text
queued → waiting_user → queued
queued → running → waiting_remote → committing → succeeded
                    ├── outcome_unknown
queued/running/waiting_remote → cancelling → cancelled
任一可重试失败 → retry_wait → queued（attempt + 1）
任一不可重试失败 → failed
依赖不可用/用户缩小范围 → skipped（带 reason）
```

- Operation 必须保存 `operation_id`、`attempt`、`idempotency_key`、dependency ids、input snapshot/basis hash、resource phases、预算预留 id、进度 checkpoint、remote task id、提交状态和结果 receipt；
- 本地纯函数/文件派生物可按退避策略自动重试；Provider 429/5xx 只在 adapter 合同允许且幂等键可证明时重试；请求可能已到上游但无响应时进入 `outcome_unknown`，不得盲目重复扣费；
- `waiting_user` 只用于远程分析同意、超预算确认或不可替代的创作取舍；它不持有 CPU/GPU/磁盘 lease，用户拒绝后对应分支进入 skipped 并保留本地能力；
- cancel 向未开始的依赖传播；已产生并提交的共享 Derivative/Evidence 不回滚，只停止后续节点；FFmpeg、轮询和文件读取都必须响应 AbortSignal；
- `committing` 表示结果已经落入 staging、尚未完成 SQLite/文件发布协议；恢复时根据 commit receipt 完成提交或回收 staging，不能仅把所有中断任务标 failed；
- Job Orchestrator 的队列、依赖和预算是 SQLite 权威状态；内存只保存正在运行的 AbortController/进程句柄，重启后由持久状态重建调度；
- Domain Event 使用 SQLite outbox 与状态事务同写，API Event cursor 来自单调序列；不得先改状态后单独追加一个可能丢失的 JSON journal。

### 7.4 分析范围与草稿边界

导入不等于立刻对全部素材执行最高成本的分析。系统必须分层：

```text
所有 Source：Probe、fast identity、基础缩略图、低成本 Camera Shot/静音/活动图和可用性
进入候选范围的 Source/Segment：完整 fingerprint、转写、Evidence Window、视觉证据和索引
交付意图涉及的内容：规划和时间线草稿
用户确认的草稿：Editorial Timeline Version
选定交付目标：Delivery Variant 与完成层
```

- 分析 Operation 必须持久化其 `source_ids`、`camera_shot_ids`、`content_segment_ids`、`evidence_window_ids`、深度和工作方式快照；
- 未选中的素材不能被 AI 在草稿中静默使用；用户可随时扩大范围，不重做仍然有效的派生物；
- 深度分析开始前利用已经完成的本地 Camera Shot/活动图返回预估的 Source/Segment/Window 数、帧/代理秒数、模型 token/ASR 分钟、磁盘派生物、预计耗时和平台额度影响；超过默认预算时须由用户确认；
- AI 只创建 `proposed` 草稿；接受、丢弃、比较草稿和恢复旧版本都是用户操作；
- 快速成片的 Recipe 只设置默认工作方式和交付意图，不能绕过“用户确认草稿”的边界；
- 每次深度分析、生成 Proposal 或应用 Quick Create 前，Host 必须保留输入范围、Recipe、预算授权、模型/Prompt receipt 和基准 revision；
- 用户直接编辑时间线时，每次提交生成新的不可变版本，不覆盖父版本。

### 7.5 增量与失效矩阵

新增一个 Source：

```text
只执行新增 Source 当前授权深度所需的 probe/本地摘要
→ 若它进入候选范围，再执行 fingerprint/derivative/transcribe/windows/understand/index
→ 将依赖旧候选集的 Feasibility/Plan 标记为“有更新可用”，不自动覆盖现有 Draft/Timeline
```

改变 Source Range Decision：

```text
不重做媒体分析
→ 增量重做 curate/feasibility；只有用户要求刷新方案时重做 Plan
```

改变 Timeline：

```text
不重做 Media Facts 和内容理解
→ 受影响的 Caption/Composition/Audio Plan、Delivery Variant、Quality 与 Compile Plan stale
→ 用户只要求直接预览时可按保守默认 Variant 重新 compile/preview
```

改变输出参数：

```text
同宽高比的分辨率/码率/codec → compile/render
宽高比/安全区/字幕布局变化 → composition/caption plan → variant preflight → compile/preview/render
```

改变 Transcript Revision 只重建相应 FTS/embedding projection、字幕候选以及引用该文字 basis 的 Proposal/Plan；原始 ASR、Camera Shot 和无关 Timeline Version 保持有效。删除或重连 Source 则使引用其 fingerprint 的 Draft/Timeline/Variant/Compile Plan stale，但旧版本仍保留为不可执行的历史记录并给出重连入口。

---

## 8. 大量素材的编排

### 8.1 入库

每个 Source 独立 Operation：

- 最大并发受控；
- 某个 Source 失败不使整个项目失败；
- Project 保存 source summary；
- 大对象分文件存储。

### 8.2 转写

- 短 Source 用 Fun-ASR-Flash；
- 长 Source 用 Fun-ASR；
- 多声道按选择的 channel；
- 多人开启 diarization；
- 热词由项目词典提供；
- 全量覆盖，不能截断前 10 分钟。

短文件通过同步 Flash adapter；长文件以可恢复异步 Operation 处理。多声道必须保存用户选择的 stream/channel mapping；多人 diarization 保存 speaker label 与置信度。若 Provider 只返回句级时间戳，文本搜索和句级剪辑仍可用，但词级字幕/删词功能显示能力降级，不能伪造词级时间码。

### 8.3 Camera Shot 与 Content Segment

本地先生成 Camera Shot：

- 场景变化；
- 容器/编码内置 cut marker（存在时）；
- 黑场只作为候选切换证据与质量 Evidence，不自动等价为一个可用 Shot；
- 用户手工修正。

再生成 Content Segment：

- 句子/主题变化；
- 静音与说话人变化；
- OCR/屏幕页面变化；
- 运动阶段变化；
- 固定间隔只作为没有其他证据时的分析窗口兜底，不改变 Camera Shot Map。

VLM 不拥有边界，只能为 Host 已建立的 Window 提供动作/语义证据。用户修正 Camera Shot 或 Content Segment 时创建新 map revision；旧 Evidence 仅在其 Window 范围和输入帧 hash 仍一致时复用。

### 8.4 分批视觉理解

自适应策略：

- 短静态 Camera Shot：1 张代表帧；
- 长静态口播：首/中/尾代表帧 + 全范围 Transcript；
- 演示、屏录、动作或 OCR 变化：在变化点建立多个 Evidence Window；
- 动作起止不确定：仅为不确定范围生成 2–8 秒低清代理；
- 采样器必须产出覆盖 receipt：已覆盖范围、未覆盖范围、采样原因、帧/代理数量和预算命中情况；
- 不设置每 Camera Shot 三帧的硬业务上限；项目配置只限制窗口、帧、代理秒数和总输入 token；
- 每批大小由 Provider body bytes、token 预算、图片数量和限流动态计算，不写死 20–50；
- 每批独立 Operation；
- 缓存键包括 source fingerprint、Window range、帧/代理 hash、采样器版本、facts schema 和 prompt version。

### 8.5 Curation

规则与模型结合：

```text
严重模糊/黑场/过曝 → reject 建议
重复组 → 保留最佳
有关键句/产品/人物 → Source Range pick 建议
用户标记 → 最高优先级
```

### 8.6 章节规划

需要多个内容段落的方案必须先 outline；是否需要章节由交付意图和内容结构决定，不能只按“超过五分钟”这一数字判断：

```text
项目目标
→ 章节
→ 每章目标时长
→ 每章候选 Content Segment/Source Range 集
```

再分别计划章节，最后全局复核。

### 8.7 精确切点

模型只选内容范围。

Host 调整：

```text
模型选择语义范围
→ Host 收集候选切点（word/sentence、silence、动作 phase、Camera Shot、真实 PTS）
→ 按内容类型和用户锁定选择最小语义损失的入/出点
→ VFR PTS / 音频 sample 边界 rescale
→ 生成 cut rationale 与可预览 final source range
```

切点不是依次“吸附到句子→静音→Shot”的流水线：口播句内切点不应被强行拉到几十秒外的镜头边界，动作画面也不应被强行吸附到语音停顿。Host 按 `speech/action/beat/manual` 策略为每个边界评分；超出允许偏移或置信度不足时保留模型范围并标记 `needs_user_decision`。

---

## 9. Timeline Compiler

必须增加强类型中间计划：

```ts
type VideoExecutionPlan = {
  editorial_timeline_version_id: string
  delivery_variant_version_id: string
  inputs: VideoExecutionInput[]
  filters: TypedVideoFilter[]
  maps: OutputMap[]
  encoder: EncoderProfile
  color_pipeline: ColorPipeline
  audio_pipeline: AudioPipeline
  output_target: AssetWriteTarget // Host 分配、限定在受管目录，不接受 API/模型路径
  compiler_version: string
  basis_hash: `sha256:${string}`
}
```

流程：

```text
Timeline v2
→ TimelineValidator
→ AssetResolver
→ TimebaseNormalizer
→ ExecutionPlan
→ FFmpeg argv
→ Executor
→ OutputVerifier
```

禁止让 LLM、API 请求或 Renderer 提交任意 FFmpeg 参数。

### 9.1 Validator 检查

- Source/Project Asset 存在且解析路径位于允许的受管目录或用户明确授权的外部文件；
- fingerprint 未变化；
- source range 有效；
- timeline range 有效；
- Track 支持；
- item 不越界；
- required/locked 合法；
- 主视频轨无非法重叠，允许的 gap/overlay 有显式语义；
- Source A/V link、channel mapping、采样率、声道布局和时间戳单调；
- Caption cue 不重叠越界，字体/字形可用，burn-in 与 sidecar 模式可实现；
- Delivery Variant 的所有 override 都引用当前 Editorial Timeline 中存在的 item；关键帧位于 item range 内；
- 不支持效果失败关闭；
- Export Profile 严格匹配第 6.9.1 节 container/codec/audio/frame-rate/pixel-format/HDR 白名单，字段组合无效时在编译 argv 前失败；
- 输出尺寸、SAR/DAR、rotation、pixel format、color space/HDR 策略和编码器合法；
- 音视频映射完整。

FFmpeg 只能通过 argv 数组启动，禁止 shell 字符串；输入协议默认只允许本地 `file` 与受控 pipe，禁止从素材 metadata、字幕或 API 打开 http/https/concat 任意路径。硬件编码器不可用时按经过 fixture 验证的 profile 降级，并把降级写入 Execution Receipt；不得静默改变分辨率、帧率或颜色范围。

### 9.2 输出验证

- 文件存在；
- 非 partial；
- 时长；
- video stream；
- audio stream；
- width/height；
- fps；
- codec；
- hash；
- verified_at；
- `ffmpeg -v error` 全量或按风险配置的 decode scan；
- packet timestamp 单调、音视频实际时长差和目标时长容差；
- 非预期黑屏/静音只作为 post-render warning，除非违反用户必留内容或明确阈值才 fail。

Hash 只证明输出身份，不证明视频可播放。OutputVerification 必须引用 ExecutionPlan basis、真实 encoder、ffprobe receipt、decode scan receipt 和文件 hash；只有验证与 post-render QualityReport 都通过，导出 Operation 才从 `committing` 进入 `succeeded`。

---

## 10. 存储布局

目标：

```text
videos/
├── metadata.sqlite
├── projects/<projectId>/
│   ├── payloads/
│   │   ├── transcripts/<transcriptId>.json
│   │   ├── evidence/<batchId>.json
│   │   ├── plans/<planId>.json
│   │   └── timelines/<versionId>.json
│   ├── sources/<sourceId>.json
│   ├── derivatives/<derivativeId>.json
│   ├── camera-shots/<sourceId>.jsonl
│   ├── content-segments/<sourceId>.jsonl
│   ├── evidence-windows/<sourceId>.jsonl
│   └── previews/<previewId>.json
├── assets/
├── exports/
├── deletions/
├── legacy-import/
├── staging/
├── quarantine/
├── backups/
└── trash/
```

原则：

- `metadata.sqlite` 是 Project header、Source/Derivative/Transcript/CameraShot/ContentSegment/EvidenceWindow/Evidence 索引、Decision、Proposal、Operation DAG、Event cursor、版本关系、缓存 LRU 和全文/语义检索元数据的唯一事务性权威；
- 文件系统保存媒体二进制、大型不可变 payload、可重建 derivative 与导出文件；不得通过扫描大量 JSON/JSONL 充当列表、分页、搜索或跨对象事务；
- `projects/*/payloads/*.json` 是不可变大对象 payload；`sources`、`derivatives`、`camera-shots`、`content-segments`、`evidence-windows`、`previews` 是可重建或可导入的物理描述，不得自行成为项目状态权威；
- 旧 `projects/*.json`、`operations/*.json`、`events/*.json` 只在 `legacy-import/` 双读迁移期间读取；新格式不得继续向它们写入；
- Project header 小；
- Timeline version 不可变；
- Transcript 独立；
- Camera Shot、Content Segment 与 Evidence Window 按 Source 分片；
- Evidence 按 batch；
- API 列表只返回 summary；
- 详情分页；
- 旧项目双读；
- 新格式单写；
- 不长期双写。

### 10.1 SQLite 与 payload 提交协议

```text
1. Operation 在 SQLite 创建 commit_intent（staging locator、预期 hash/bytes、最终 locator）
2. 大 payload 写入 staging/<operationId>/，关闭并计算 hash；必要时 fsync
3. SQLite 事务写领域索引、引用计数、outbox event 和 commit state=prepared
4. Host 将 staging 文件原子 rename 到最终路径
5. SQLite 事务把 payload/Operation 标 committed/committing，并发布可见 projection
6. Output/Derivative 额外验证完成后 Operation 才 succeeded
```

- 崩溃恢复扫描的是 SQLite `commit_intent`，不是全盘猜测：prepared 且 staging 完整则继续发布；最终文件已存在且 hash 相符则补记 committed；两者都不完整则回收并让 Operation 可重试；
- SQLite 使用 WAL、busy timeout、外键、明确事务隔离和受控 checkpoint；每次 schema migration 在单独事务中记录版本、校验与退出条件，启动失败时保留数据库副本并失败关闭，不能自动创建一个空库掩盖损坏；
- payload、CAS Asset 和 Derivative 有引用计数与 Operation lease；LRU/删除只处理 `ref_count=0`、无 lease、非正式导出且可重建的对象；跨项目复用 Asset 时删除一个项目不得删除其他项目仍引用的文件；
- `sources/*.json`、`camera-shots/*.jsonl`、`content-segments/*.jsonl`、`evidence-windows/*.jsonl` 等只能是导入/诊断 manifest 或不可变 payload，不作为第二写源。SQLite 行必须保存 payload hash/schema/version，读取时不一致则标 corruption 并进入恢复流程；
- FTS5 保存规范化文本与稳定范围 ID；`text-embedding-v4` 768 维向量按 index generation/model/dimension/instruction 存 BLOB。第一版使用 SQLite 条件过滤后在 Application 内做有界余弦排序，不引入未经 macOS/Windows 打包验证的 native vector extension；超过经过基准验证的规模后再以同一 Search Port 替换实现；
- 数据库备份、旧库迁移和 trash 均有保留期限与显式清理 Operation；不得在启动热路径同步扫描或 hash 全部历史媒体。

---

## 11. 缓存和磁盘

必须实现：

- derivative byte size；
- 项目缓存占用；
- 全局缓存上限；
- 安全剩余磁盘阈值；
- LRU 清理；
- 只删除无引用、无 Operation lease、可重建的 derivative；
- 不删除原素材；
- 不删除正式导出；
- Source 变化后 stale；
- 外置盘断开只标 missing；
- 恢复后重新绑定相同 fingerprint。

开始 Proxy/Preview/Render 前按源时长、目标 codec 和历史 receipt 预留磁盘预算；低于安全阈值时先清理符合条件的缓存，再返回可解释错误，不能让 FFmpeg 写满系统盘。播放中、当前预览、正在上传/分析和即将渲染使用的 Derivative 必须有 lease，不参与并发 LRU。外置盘断开期间不把 Source 标删除，也不反复计算错误 fingerprint；重连后先用 fast identity 筛选，再以完整 SHA-256 确认。

参考 Kdenlive Cached Data 设计。

---

## 12. API

保留现有：

```text
/api/videos/projects
/api/videos/projects/:id/sources
/api/videos/projects/:id/analyze
/api/videos/projects/:id/preview
/api/videos/projects/:id/render
/api/videos/operations/:id
```

新增：

```text
POST /api/videos/projects/:id/derivatives
POST /api/videos/projects/:id/transcriptions
POST /api/videos/projects/:id/analysis-scopes
POST /api/videos/projects/:id/remote-analysis-consent
POST /api/videos/projects/:id/analysis-estimates
GET  /api/videos/projects/:id/search
GET  /api/videos/projects/:id/shots
GET  /api/videos/projects/:id/content-segments
POST /api/videos/projects/:id/range-decisions
PUT  /api/videos/projects/:id/delivery-intent
GET  /api/videos/projects/:id/duration-feasibility
POST /api/videos/projects/:id/creative-sessions
POST /api/videos/projects/:id/creative-sessions/:sessionId/messages
GET  /api/videos/projects/:id/proposals/:proposalId
POST /api/videos/projects/:id/proposals/:proposalId/accept
POST /api/videos/projects/:id/proposals/:proposalId/reject
POST /api/videos/projects/:id/plans
GET  /api/videos/projects/:id/plans/:planId
GET  /api/videos/projects/:id/timeline-drafts/:draftId
POST /api/videos/projects/:id/timeline-drafts/:draftId/accept
POST /api/videos/projects/:id/captions/draft
POST /api/videos/projects/:id/captions/:captionId/revisions
POST /api/videos/projects/:id/composition/plan
POST /api/videos/projects/:id/audio-finishing/plan
GET  /api/videos/projects/:id/quality-reports/:reportId
GET  /api/videos/projects/:id/timelines/:versionId/review-notes
POST /api/videos/projects/:id/timelines/:versionId/review-notes
POST /api/videos/projects/:id/timelines/:versionId/approval
GET  /api/videos/projects/:id/timelines/:versionId
POST /api/videos/projects/:id/timelines/:versionId/commands
POST /api/videos/projects/:id/delivery-variants
GET  /api/videos/projects/:id/delivery-variants/:variantId
POST /api/videos/projects/:id/delivery-variants/:variantId/commands
POST /api/videos/projects/:id/delivery-variants/:variantId/preview
POST /api/videos/projects/:id/delivery-variants/:variantId/render
GET  /api/videos/operations
GET  /api/videos/operations/:operationId
GET  /api/videos/operations/events
POST /api/videos/operations/:operationId/cancel
POST /api/videos/operations/:operationId/retry
```

`commands`/`proposal accept`/`draft accept`/`finishing plan accept` 是 API 便利入口，但全部必须在 Application 内编译成第 6.9 节同一 `TimelineCommandSet` 并调用唯一 `applyCommandSet`。Editorial command 接收父 Timeline Version 并创建新 Editorial Timeline Version；Variant command 接收父 Variant Version 并创建新 Delivery Variant Version；不能原地修改既有版本。`compile` 是 Delivery Application 内部操作，不作为 Renderer 可自由调用的公共写接口。

每次 Preview/Render 使用冻结的 Editorial Timeline Version、Delivery Variant Version 和 `VideoExportProfileRevision`。相同宽高比下切换分辨率/codec 只触发 compile/preview/render；改变宽高比或安全区会使 Composition/Caption/Variant preflight stale，但不能重新触发内容 AI 或改变素材选择。

通用 API 合同：

- 所有创建 Operation 或版本的 POST 必须带 `Idempotency-Key`；重复请求返回同一资源，不能产生重复模型扣费或时间线版本；
- 列表使用稳定 cursor、`limit` 上限和排序键；大型 Transcript/Evidence/Search/Events 不返回无界数组；
- CAS 冲突统一返回 `409` + `current_revision/current_version_id/stale_reason`，校验错误返回稳定 machine code、字段路径和安全中文说明；
- 长任务只返回 `202 + operation_id`，进度从持久 Event cursor 获取；取消、重试和 outcome_unknown 需要不同用户操作；
- 媒体内容 GET 支持 Range、ETag/If-None-Match、正确 Content-Type 和短期签名；绝对路径永远不出 Sidecar；
- API schema 有显式版本，旧 reader 只在迁移窗口存在；不得依赖 URL 不变来维持两个不兼容写语义。

安全：

- Renderer 不持有可复用的 Sidecar 写密钥；所有改变项目、选择本地路径、启动模型任务、导出文件、接受 Proposal/Plan 和审批的请求必须经 Electron Main 的 typed IPC allowlist。优先由 Main 直接调用 Sidecar；若确需给 Renderer URL，只签发短时、audience/path/method/operation scope 绑定且单次可消费的 capability；
- 普通项目查询可通过受限 local API 提供；原视频、音频、Transcript、Evidence、缩略图和导出属于敏感读取，也必须经 Main 或短期签名 URL。不得依赖 loopback/CORS 作为唯一读写保护，须防 DNS rebinding、跨 Origin 请求、重放和 capability 泄漏；
- `CreativeProposal`、Caption、Composition、Audio Finishing 与 TimelineCommandSet 都以相关 facts basis、`base_timeline_version_id` 或 `base_variant_version_id` 做 CAS，过期结果返回明确的 stale 状态；
- 搜索、聊天与质量报告的 public projection 不暴露绝对路径、原始 Prompt、私有模型凭据或未获授权的素材信息。

Electron 改动是本合同必需部分：`ipc/channels.ts`、`preload.ts`、Main handler、`videoActions.ts` 和对应共享 DTO 必须覆盖上述所有写动作及敏感媒体签名；文件导入/导出路径只能由 Main 的系统对话框或已持久化授权产生，Renderer 不能提交任意绝对路径。

兼容：

- 旧 `/analyze` 作为 DAG 入口；
- 新项目使用新模型；
- public API 不暴露绝对路径和 Prompt；
- Transcript、Camera Shot、Content Segment、Evidence Window 和 Evidence 分页。

---

## 13. 当前代码改动清单

### 13.0 施工关卡与旧行为特征测试

当前 `VideoWorkbenchService`、Repository、Analysis、Execution、API 和 Gateway 先补特征测试，固定现有项目导入、writer fence/CAS、Operation Event、分析 stale、时间线选择、Preview/Render、删除/恢复和中断提交行为。没有这些测试不得先拆 Service。

按以下关卡推进；可以分提交实施，但最终交付必须全部通过：

1. **Storage/Operation/test foundation**：全局 `ts/package.json` 正式 test command/共享 runner、现状特征测试、SQLite schema、payload commit、migration、outbox、Job Orchestrator、旧 JSON reader；
2. **Media Facts**：精确时间、fast/full fingerprint、Derivative、Timed Transcript、Camera Shot、Content Segment、Evidence Window、索引；
3. **Editorial/Compiler**：Draft、typed CommandSet、Editorial Timeline Version、Delivery Variant、Validator、ExecutionPlan；
4. **Provider/Planning/Relay deployment**：Qwen/Fun-ASR/Embedding、Relay 固定线协议、Consent/预算闭环、Curation、Feasibility、Plan、Proposal，以及第 1.2/13.5 节服务器部署与真实受控 smoke；
5. **Finishing/Quality**：Caption、Composition、Audio、Beat、preflight、Render、Output Verification、post-render；
6. **Desktop/Product gate**：完整 Main broker/preload、敏感媒体签名、迁移退出、真实 Renderer 端到端旅程。

每关必须保持：新 writer 只有一个、旧项目可读、当前正式 Timeline/Export 不丢失、失败可恢复、相关 contract tests 通过。第 2–5 关未完成时可由 façade 投影旧 API，但禁止把旧 API 与新 API 同时变成两个可写状态源。

### 13.1 Composition Root

修改：

- `ts/src/server/index.ts`
- `ts/src/server/router.ts`

新增：

- `ts/src/server/media/runtime/createMediaRuntime.ts`

目标：

- 创建 Kernel；
- 创建 Video Module；
- 统一 migration/recovery；
- 返回 handler；
- startServer 不承载业务逻辑。

### 13.2 Repository

修改：

- `videoWorkbenchRepository.ts`

新增通用、视频首用的 Media Kernel 原语：

- SQLite Unit of Work 与 payload commit；
- lock；
- writer fence；
- outbox/event cursor；
- deletion store。

`imageWorkbenchRepository.ts` 不在本合同改动范围。共享原语必须保持领域无关、可独立 contract test，Video Repository 是本轮唯一正式消费者；不得为了证明“共享”而迁移图片数据、修改图片 writer 或让图片和视频共用数据库。生图以后是否采用这些原语由生图施工合同决定。

### 13.3 Service 拆分

把 `videoWorkbenchService.ts` 逐步改成 façade，业务进入 `ProjectAssets`、`AnalysisIndex`、`Editorial`、`FinishingDelivery` 四个应用编排器；不得按每个领域名词再创建一层只转发的 Service。当前 AI 分析直接创建并选中 Timeline Version 的行为必须迁移为 `TimelineDraft/CreativeProposal`，只有用户 accept/CommandSet 才生成正式版本。

### 13.4 ASR

新增 Video Media Relay：

- `video-media-relay/providers/funAsrFlash.ts`
- `video-media-relay/providers/funAsrLong.ts`
- `video-media-relay/remoteAsrTaskStore.ts`

新增 VideoModule：

- `video/infrastructure/providers/funAsrFlashAdapter.ts`
- `video/infrastructure/providers/funAsrLongAdapter.ts`
- `video/infrastructure/providers/remoteAsrTaskPoller.ts`
- `video/domain/analysisIndex/timedTranscript.ts`

要求：

- 句/词时间码；
- speaker；
- hotword；
- 长文件 task；
- 原片 offset；
- 异步提交、幂等、轮询、过期结果、取消和 outcome_unknown 恢复；
- 不再只返回 `{text}`。

现有 `gateway/transcription.ts`、`ts/shared/contracts/voice.ts`、`ts/src/media/remoteTranscription.ts` 和 `voiceTranscription.ts` 继续服务既有产品语音，不在本合同修改范围。旧视频项目若曾复用该路径，只保留旧结果 reader；所有新视频转写只能调用 Video Media Relay，不在 Gateway 保留第二条视频 ASR 写路径。

### 13.5 Provider、Media Relay 与服务器部署

修改：

- `video-media-relay/providerRegistry.ts`
- `video-media-relay/app.ts`
- `video-media-relay/mediaObjectLease.ts`
- `gateway/app.ts`
- `gateway/installationAuth.ts`（只复用/测试现有 `verifyAccess()`，不改变现有 token/session 语义）
- `ts/shared/product/providerGateway.ts`
- `ts/shared/product/providerContracts.ts`
- `ts/src/server/services/videoAnalysis.ts`

新增：

- `qwenVisualEvidenceAdapter.ts`
- `qwenVideoPlanningAdapter.ts`
- `qwenCaptionTranslationAdapter.ts`
- `textEmbeddingV4Adapter.ts`
- `providerBudgetLedgerAdapter.ts`

删除新视频链路 MiMo 路径。Video Media Relay Registry 复用 `VisualEvidence`、`MediaReasoning`、`SpeechTranscription`，只新增 `SemanticEmbedding`；MediaReasoning 应用角色与 SpeechTranscription short/long mode 不新增共享 capability 名称。现有 `gateway/*`、`relay/*` 与 `imageReasoning.ts` 除第 5.4.1 节明确的私网身份内省端点外不改动既有语义；`providerContracts.ts` 只做向后兼容的 `SemanticEmbedding`/descriptor/receipt 加法，不能改写 Agent、Image 或产品语音既有语义。

实施本关时同步更新 `README.md` 和 `docs/重构/模型与远程能力平台.md`：Agent Text Gateway 与既有产品语音/图片远程路径保持原有所有权；Video Media Relay 独立承载新增视频对象租约、阿里云凭据、模型路由、账户额度、幂等和 Provider usage receipt。Sidecar 仍是 Video Project/Operation/Consent/本地预算的唯一 owner，Media Relay 不出现 Timeline、Proposal 或 Creative Session 表。

本关同时承担第 1.2 节的服务器交付，不另开“先改服务器”的前置任务：

- 新增 `deploy/production/Dockerfile.video-media-relay`、生产 env validator 和独立 release image；
- 修改 `deploy/production/compose.yml` 与 `deploy.sh`，增加独立 `video-media-relay` service、`127.0.0.1:8791`、持久 request/receipt/lease metadata 目录、只读 rootfs、tmpfs、cap drop、资源限制与 health/readiness；Video Media Relay 可依赖 Gateway healthy 以使用私网身份内省，但 Gateway/现有 Relay 不依赖 Video Media Relay，现有端口和媒体路由保持不变；
- 在 `gateway.env` 与 `video-media-relay.env` 增加同一独立高熵 `GW_VIDEO_MEDIA_INTROSPECTION_TOKEN`（或共享合同冻结的等价单一变量名），两侧 validator 只验证存在/强度而不打印值；Gateway 新增 `/internal/v1/auth/introspect` 时复用现有 `AuthAuthority.verifyAccess()`，不另建用户/session 表；
- 将 `/video-media/` Nginx TLS 路由的规范配置纳入仓库并部署，同时显式拒绝公网 `/gw/internal/*`。控制面 request body/timeouts 只满足第 5.4.1 节 JSON；大字节必须直传北京临时对象存储，不能穿过 Nginx/Bun 内存；
- 更新 `docs/operations/production-servers.md` 的实测拓扑、端口、容器 revision、数据/secret 路径、健康检查、日志/保留期和故障诊断；更新内容必须来自部署当次只读/部署后实测，不能从目标文档反推现网；
- 部署前后 contract/smoke 必须覆盖安装 token 正常/过期/logout/revoke、错误 service credential、Gateway 内省不可用、伪造 owner、region/scope、无 token 拒绝、对象 URL 单次/过期、幂等冲突、账户额度、真实受控 Qwen/Fun-ASR/Embedding receipt、ACK 后清理和日志脱敏。未通过时本关不得标完成，也不得让桌面正式路径切到新服务。

### 13.6 FFmpeg

拆分当前 `videoExecution.ts`：

- probe；
- derivatives；
- compiler；
- executor；
- verifier；
- decode scan；
- scene/silence/loudness analyzers；
- PCM decoder + BeatDetector Port；
- SubjectTracker/smoother Port 与 fixture。

### 13.7 创作协作与完成层

按第 4 节五个物理模块新增领域 schema、应用编排器和 adapter。至少包括：

- `video/domain/projectAssets/*`：Project、Source、Asset、RemoteAnalysisConsent、provenance/license attestation；
- `video/domain/analysisIndex/*`：Derivative、Timed Transcript/Revision、Camera Shot、Content Segment、Evidence Window、typed Evidence、Search Generation；
- `video/domain/editorial/*`：Recipe、Range Decision、Intent/Feasibility、Plan、Draft、Editorial Timeline Version、typed CommandSet、Creative Session/Response/Proposal、Review/Approval；
- `video/domain/finishingDelivery/*`：Delivery Variant/Version、Caption Revision、Composition/Audio Plan、Quality Report、Export Profile、Execution/Verification receipt；
- `video/infrastructure/storage/*`：SQLite repositories、payload commit、FTS/embedding index、migration/backup；
- `video/infrastructure/media/*`：FFprobe、proxy/keyframe/waveform、local analyzers、compiler、executor、decode verifier；
- `video/infrastructure/providers/*`：Fun-ASR、Qwen、embedding、budget/receipt adapters；
- `video/testing/{fakes,fixtures,contracts}/*`。

要求：

- 以 SQLite 提供本地事务、全文检索、关系索引、分页和缓存 LRU；媒体文件仍由项目资产目录管理；
- Recipe、Session、Proposal、Feedback 和 QualityReport 全部引用项目事实和版本，不引入第二个聊天/时间线状态源；
- Review Note/Approval 同样绑定 Timeline/Variant Version、actor 与时间锚点；未来 transport/identity 适配不得改写已有编辑事实，但多人权限/同步仍需单独合同；
- 先实现项目内检索、文本剪辑、候选草稿、质量报告和人工接受，再扩展自然语言多步骤协作；
- 字幕、自动构图、声音完成与风格包均通过可预览的 Delivery Variant CommandSet 落地；
- 不接生视频；无法由真实素材和授权资产完成的内容必须明确报告缺口。

### 13.8 Electron Main 与本地安全桥

修改：

- `ts/desktop/electron/ipc/channels.ts`；
- `ts/desktop/electron/preload.ts`；
- `ts/desktop/electron/main.ts`；
- `ts/desktop/electron/services/videoActions.ts`；
- Sidecar capability/签名 URL 服务与共享 DTO。

要求：所有视频写入、路径选择、远程分析同意、预算确认、Proposal/CommandSet 接受、Preview/Render、取消/重试、Review/Approval 均有 typed IPC；敏感读取使用 Main 转发或短期 scope capability。Renderer 不获得会话级可复用 Sidecar secret，不提交任意路径，也不能绕过 Main 直接调用 paid/final action。

### 13.9 测试与跨平台验证

必须在 `ts/package.json` 增加正式 test script，并覆盖 Domain unit、Port contract、SQLite/payload crash、API/IPC contract 和 FFmpeg fixture integration。真实 Provider 测试与日常测试分离：日常测试只用可复现 fixture/fake；受控 smoke test 验证真实 Qwen/Fun-ASR/Embedding schema、额度 receipt 和超时语义。macOS arm64 与 Windows x64 都要验证 Sidecar 打包、SQLite/FTS、FFmpeg/FFprobe、硬件编码降级、中文路径、外置盘重连和进程清理。

### 13.10 旧视频项目迁移映射与退出条件

- 旧 Project/Source/Asset/Timeline/Operation/Event 先读入内存并通过旧 schema 校验，再在一个 migration batch 中写 SQLite + 不可变 payload；原目录只读保留到退出条件满足；
- 旧 `VideoClip/VideoScene/TimelineVersion` 映射为 `EditorialTimelineVersion`，当前选中版本保持选中并标 `created_by=migration`；不能因为旧版本由 AI 直接生成就把用户当前项目降成未接受 Draft；
- 旧输出规格和已验证导出映射为一个 imported Delivery Variant、不可变 Export Profile Revision 与 OutputVerification；Variant Version 锁定 profile revision id/hash。没有足够信息的字段使用明确 `legacy_unknown` projection，不伪造构图、授权或 post-render 通过记录；
- 旧 Evidence 按 kind 转入对应 typed legacy payload 并保存原始 payload hash；无法安全映射的内容只作为 legacy summary/search 文本，不可用于精确剪辑或质量通过；
- 无句/词时间码的旧 Transcript 只支持搜索/摘要；用户触发文本剪辑或字幕时提示重新转写，不根据文本长度推算时间；
- queued/running/committing Operation 依据已有 commit/output receipt 判断完成、可恢复或中断；不得统一标成功，也不得重复提交 outcome unknown 的远程调用；
- 退出旧 reader 前必须逐项目核对数量、Source fingerprint、Timeline parent 关系、当前版本、Asset/Output hash、Operation/Event cursor 和删除记录；连续两个发行版本 telemetry/诊断无 legacy read 且迁移 fixture 全通过后，才能在单独提交中删除 reader。

### 13.11 Renderer 最低功能信息架构

本合同不冻结视觉风格和像素稿，但冻结首版信息架构、状态来源和完成旅程。Renderer 至少包含以下领域视图；可以使用同页分栏、抽屉或独立路由，但不能删除对应用户结果：

1. **Project Home**：项目列表、新建/恢复/删除、Source missing/relink、最近 Timeline/Variant、未完成 Operation 与磁盘警告；
2. **Import & Analysis Scope**：系统文件对话框导入、Source 摘要、fast/full fingerprint 进度、远程分析同意、范围选择、预算/耗时/磁盘估算与扩大覆盖入口；
3. **Material Browser**：Source/Camera Shot/Content Segment/Evidence Window、Transcript、全文/语义搜索、质量/重复建议与 `required/pick/maybe/reject` 决定；
4. **Quick Create**：Recipe、用途、主体、必留内容、自然/目标/精确时长、Feasibility、1–3 个真实差异草稿、Quality preflight、比较/放弃/整份或局部接受；
5. **Editorial Workspace**：播放器、Transcript 文本剪辑、Timeline、Track/Item lock、insert/trim/split/reorder/replace/ripple delete、版本历史与冲突/stale 提示；
6. **Creative Copilot**：项目内 Session、明确 Context Anchor、只读回答/搜索结果、Proposal diff、证据/成本、接受/局部接受/拒绝，不显示为通用 Agent Thread；
7. **Finishing & Variants**：横屏/竖屏/方形 Variant、Caption Revision、Composition/Subject Track、Audio Finishing、Brand/Style Asset、preflight 与逐项预览/接受；
8. **Review & Delivery**：版本化 Review Note/Approval、Export Profile 白名单、预览/正式渲染、OutputVerification、post-render QualityReport、打开/保存导出；
9. **Operation Center**：持久进度、覆盖范围、Provider receipt 摘要、等待用户、取消、重试、outcome unknown、失败原因和重启恢复。

Renderer 只保存面板开关、缩放、滚动、当前选中 id 等可丢失视图状态。Project、Transcript、Search Generation、Draft、Timeline、Variant、Proposal、Review、Operation 和预算状态均从 Sidecar 查询；所有写动作、路径选择、付费调用和最终导出只调用第 12 节 typed Main IPC。每个视图必须设计 loading/empty/partial/stale/conflict/offline/missing/failed/needs-user-decision 状态，不能用本地乐观数组伪造成功。

前端施工前可另建视觉设计稿，但不得改变以下主旅程：

```text
导入
→ 看见首个素材摘要
→ 选择本地/远程分析范围并确认预算
→ 搜索/标记素材或选择 Quick Create
→ 比较草稿并局部接受
→ 在 Editorial Workspace 手工修正
→ 创建并检查横/竖/方 Variant
→ Preview
→ Render
→ 查看真实验证结果并保存导出
→ 重启后恢复同一项目、版本和 Operation 状态
```

---

## 14. 开源代码参考

外部项目只用于验证概念和工程边界。实施记录必须写明仓库 URL、审阅 commit、许可证和实际借鉴点；若移植代码而非独立实现，必须完成许可证/NOTICE 审查并保留来源。不得以“参考开源”替代本项目的 Port、错误语义、跨平台 fixture 和用户结果验证。

### 14.1 OpenTimelineIO

重点复制“思想和数据模型”，不复制运行时：

- `src/opentime/rationalTime.h`
- `src/opentime/timeRange.h`
- `src/opentimelineio/timeline.h`
- `src/opentimelineio/track.h`
- `src/opentimelineio/clip.h`
- `src/opentimelineio/externalReference.h`
- `docs/tutorials/otio-timeline-structure.md`
- `docs/tutorials/write-an-adapter.md`

对应本项目：

| OTIO | BilliardBuddy |
| --- | --- |
| RationalTime | 本项目精确 ticks/timebase 工具；不混用 FrameRate |
| TimeRange | Source/Timeline ranges |
| Timeline | EditorialTimelineVersion + DeliveryVariantVersion |
| Track | TimelineTrack |
| Clip | TimelineItem |
| ExternalReference | VideoSource/AssetReference |
| source_range | source_range |
| available_range | Source duration |

### 14.2 LosslessCut

重点：

- `docs/index.md` 的 Segments、Tracks、Project；
- 源码搜索 `cutSegments`、`waveform`、`keyframe`、`ffmpeg`；
- black/silence/scene detection；
- segment label/tag；
- I/O 点；
- segment reorder；
- export confirmation。

对应本项目：

- `CameraShot`、`ContentSegment` 与 Source Range Decision；
- 手工粗剪；
- Derivative；
- FFmpeg 执行；
- Timeline 的主视频子集。

### 14.3 Kdenlive

参考：

- Proxy Clips；
- Project Bin；
- Cached Data；
- Render Queue；
- Background jobs。

源码搜索：

- `ProjectClip`
- `ProxyClipJob`
- `TaskManager`
- `Render`
- `ProjectManager`

对应：

- VideoDerivative；
- Source/Proxy mapping；
- Cache manager；
- render queue。

### 14.4 OpenShot/libopenshot

参考代码：

- `src/Timeline.cpp`
- `src/Clip.cpp`
- `src/ReaderBase.cpp`
- `src/WriterBase.cpp`
- `src/KeyFrame.cpp`

对应：

- Timeline engine 与 UI 分离；
- typed timeline；
- reader/writer；
- keyframe/transform。

---

## 15. 完成判定

以下必须全部完成：

### 15.1 架构与唯一状态源

1. `VideoWorkbenchService` 只做 API 兼容 façade；正式业务归入 `ProjectAssets`、`AnalysisIndex`、`Editorial`、`FinishingDelivery`，MediaKernel 无视频业务规则；
2. Agent Thread、图片状态、Creative Session、Timeline、Delivery Variant 各有唯一 owner，不互相复用为状态源；
3. AI、API、Renderer、Caption/Composition/Audio accept 和 Proposal accept 全部经同一个 typed `applyCommandSet` 写入；不存在第二条直接改 Timeline 的路径；
4. Timeline Draft、Editorial Timeline Version、Delivery Variant Version 三者语义和持久化分开，旧版本不可变且可恢复；
5. 无关项目字段变化不造成全局 stale；每个 Plan/Proposal/Variant/Quality/Compile 以实际 basis hash 判断相关性。

### 15.2 素材、时间与分析

6. 导入先产生 fast identity/Probe/可见摘要，完整 SHA-256 可恢复后台计算；远程上传、缓存复用、正式版本和导出前强制完整 fingerprint；
7. Timebase、FrameRate、RationalTime 使用不同类型；主视频流及每个音轨分别保存 stream index/timebase/start/duration，Source/Editorial/Variant Range 使用不同 branded type；VFR fixture 按真实 PTS 编辑，29.97/59.94 与长时长不发生毫秒漂移；
8. VideoDerivative 可恢复、可失效、带 range/hash/generator/operation receipt，Proxy 只用于分析/预览，最终导出使用原片；
9. Camera Shot、Content Segment、Evidence Window 正式分离；静音/固定间隔不伪装成 Camera Shot；
10. 50 秒静态口播、50 秒产品演示和 50 秒屏幕录制 fixture 均能自适应覆盖，不能再以中心一帧或最多三帧代表全部内容；
11. 分析预算达到上限时返回覆盖/未覆盖范围和扩大分析入口，不静默宣称完整理解；
12. Fun-ASR-Flash/Fun-ASR 按能力路由，短同步/长异步、句/词时间码、speaker、hotword、channel、offset、取消、结果过期和重启恢复均有 contract test；
13. TranscriptRevision 能修正文案、断句和 speaker 而不覆盖原始 ASR；无锚点文字不能生成虚假剪切范围；
14. Evidence 是严格判别联合、带 basis/schema/confidence/receipt；模型未知 payload、伪造 ID 或媒体提示词注入不能进入领域状态；
15. FTS5 + 768 维 embedding 混合搜索可定位 Source/Segment/时间范围；索引代次可后台重建、旧代只读、结果可分页；
16. Beat Sync 使用本地 BeatGrid Evidence；没有可靠 beat 时明确降级，不由 LLM 猜测 BPM。

### 15.3 创作、规划与编辑

17. `natural`、`target`、`exact` 进入持久化 Delivery Intent；natural 不强制虚构 target duration；
18. Feasibility 基于 Content Segment、Evidence、Range Decision 和已有 Timeline 锁定项，说明 omissions；required/reject/lock 冲突失败关闭；
19. 大项目先 Outline、再 Chapter Plan、再 Global Review；Plan 是判别联合且每层保存 Provider Receipt/basis；
20. Quick Create 在确有差异时返回 2–3 个候选，否则返回 1 个并解释原因；所有候选可预览、可放弃，不覆盖正式时间线；
21. Answer/Search Result 是只读 CreativeResponse；只有 Draft/Patch/Quality Fix 是可接受 Proposal；
22. 文本剪辑能把删/移/重排映射为稳定 Source Range、差异预览和 typed CommandSet；
23. 手工 insert/trim/split/reorder/replace/ripple delete/track state/lock 均产生父子版本；重复 Idempotency-Key 不产生重复版本；
24. 新增 Source 只执行已授权深度并提示计划有更新可用，不自动重写用户已接受的 Timeline。

### 15.4 多画幅、完成层与导出

25. 同一个 Editorial Timeline 可拥有横屏、竖屏、方形多个 Delivery Variant，构图/字幕/品牌覆盖互不污染；
26. 同宽高比换分辨率/codec 只重编译；换宽高比重做 Composition/Caption/Variant preflight，但不重做内容规划；每个 Variant Version 锁定不可变 Export Profile Revision id/hash，历史 Preview/Render 不跟随 profile head 漂移；
27. Caption Document/Revision 与 Transcript 分离，翻译保留源 cue/时间锚点，字体缺失和安全区冲突可解释；
28. Composition Plan 有主体证据、动态 keyframe、未解决范围和保守 fallback；无可靠主体时不盲裁；
29. Audio Finishing 有真实 loudness/peak/静音分析、可预览命令和语义删减建议；不会默认改变原声含义；
30. B-roll、音乐、配音、Logo、字体、片头片尾均引用带 provenance/license attestation 的 Project Asset；远程 URL 不进入正式时间线；
31. preflight QualityReport 只检查渲染前可判断事项；OutputVerification 与 post-render QualityReport 在真实文件产生后检查 export/decode integrity；
32. Timeline Validator 覆盖范围、重叠/gap、A/V link、caption、keyframe、颜色/HDR、音频 mapping、Variant 引用和不支持效果；
33. ExecutionPlan 完全强类型、输出使用 Host Asset Target、FFmpeg 仅 argv、禁止任意远程协议/路径；
34. 输出经过 FFprobe、hash、decode scan、时间戳/音画时长校验；硬件编码降级有 receipt 且不静默改变规格。

### 15.5 存储、任务、预算与安全

35. SQLite 是元数据权威，payload/媒体是不可变大对象；跨 SQLite/文件 commit_intent 在每个崩溃点都能完成或回收；
36. WAL、busy timeout、外键、migration、backup/corruption failure、outbox cursor 和单向旧 JSON 导入均有测试；
37. CAS/Derivative 有 ref count 与 lease；LRU 不删除播放、上传、分析、预览、渲染或其他项目仍引用的对象；低磁盘先安全清理再失败；
38. Job Orchestrator 从 SQLite 恢复 DAG，支持资源分阶段申请、优先级、取消传播、retry_wait、committing 和 outcome_unknown；
39. Qwen3-VL-Flash、Qwen3.6-Flash、Fun-ASR 与 text-embedding-v4 均只经独立 Video Media Relay 按 capability/role 路由并保存实际 snapshot/schema/usage receipt；第 5.4.1 节鉴权、对象租约、幂等、ACK、账户额度和 `outcome_unknown` 线协议有双端 contract test，MiMo 不在新媒体路径；
40. 所有远程调用执行 reserve/settle/release/outcome_unknown 预算闭环，深度分析前显示 token、帧、代理秒、ASR 分钟、磁盘、耗时和金额估算；
41. 无 RemoteAnalysisConsent 时产品仍可本地导入、手工剪辑、场景/静音分析、预览和渲染；每个远程 Operation 锁定 consent revision/scope hash，扩大范围需重新确认，revoke 后禁止新租约/提交并显示在途真实状态；Provider 只收到获准派生物，不收到 GPS/私有 metadata；
42. 所有写操作、路径选择、付费调用和最终导出经过 Electron Main typed IPC；Renderer 无可复用 Sidecar secret、任意路径或 paid action 权限；
43. 敏感 GET 使用 Main 或短期 scope 签名，Range/ETag 正常，loopback/CORS/DNS rebinding 不能绕过保护；
44. API POST 有幂等键，列表有 cursor，上限明确，CAS/校验/取消/重试/outcome_unknown 有稳定错误合同。

### 15.6 可执行验证矩阵

45. 测试至少包含：无音轨、单/多音轨、多人说话、旋转手机视频、VFR 29.97、HDR/SDR、损坏文件、缺失/变更素材、中文/空格路径、外置盘断开重连；
46. 编辑至少包含：口播删句、动作切点、节拍剪辑、跨 Camera Shot 内容段、锁定/required 冲突、并发 stale、重复命令、父版本恢复；
47. 失败至少包含：Provider 400/413/429/5xx、超时后 outcome unknown、非法 JSON/schema、部分视觉批次失败、取消、应用崩溃、SQLite busy/损坏、低磁盘、FFmpeg 非零退出和输出 decode error；
48. 规模至少包含 1 个短素材、15 个/60 分钟、30 个/180 分钟，并记录入库耗时、首个可见摘要时间、深度分析成本、峰值内存、磁盘、恢复时间和交互预览优先级；这些只是基准 fixture，不写成产品业务上限；
49. 每个 Provider、执行器、存储和桌面 Port 有 fake、fixture、contract test；日常测试不依赖真实模型，真实 smoke test 独立受控；
50. macOS arm64 与 Windows x64 安装包真实验证 SQLite/FTS、Sidecar、FFmpeg/FFprobe、硬件编码 fallback、IPC、进程清理与升级迁移；Video Media Relay 也已按第 1.2/13.5 节从提交 revision 部署，外网 TLS/auth、`:8791` 回源、北京对象租约、真实受控 Provider smoke、ACK 清理和运行文档均以服务器实测通过；
51. 当前空 Renderer 补齐后，普通用户和创作者两条真实桌面旅程均能完成导入、预算确认、范围选择、草稿比较、局部接受、编辑、横竖屏预览、渲染、恢复；仅后端类型检查或文件存在不算完成；
52. 任务中启动的 FFmpeg、测试 Sidecar、浏览器和打包进程在验证结束后全部停止并复查，不遗留后台高负载进程。

### 15.7 量化发布阈值

以下阈值是首版 release gate，不是产品素材数量上限。性能数据必须同时记录 fixture、机器、OS、是否命中缓存、硬件编码器和 Provider 区域；不得只报最快一次。参考机器至少包含 Apple M2/16GB/内部 SSD 的 macOS arm64，以及现代 6 核 CPU/16GB/NVMe、无独立显卡依赖的 Windows x64。

53. **时间精度**：所有 Source↔Timeline↔Delivery rescale 的 Host 误差不超过 `max(1 frame, 20ms)`；29.97/59.94 VFR 长素材 fixture 到末尾仍满足该阈值，不累计毫秒漂移；
54. **字幕对齐**：已有 Provider word/segment anchor 时，Caption cue 投影误差不超过 `max(1 frame, 40ms)`；清晰普通话人工标注集的 ASR cue 边界 P95 不超过 300ms。后者未通过时可保留转写搜索，但字幕必须显示需校准，不能标记 ready；
55. **输出完整性**：成片实际音视频时长差和目标时长误差均不超过 `max(2 frames, 100ms)`；全量 decode scan 为零 error，packet timestamp 单调，sidecar 字幕文件和视频 basis/hash 一致；
56. **搜索质量**：版本化 golden query 集中，精确关键词相关 Segment 的 Top-1 命中率不低于 98%，语义改写查询的相关 Segment Top-5 recall 不低于 90%；结果必须落到真实 Source/时间范围，无法定位的回答不计命中；
57. **视觉覆盖**：50 秒静态口播、产品演示和屏录 fixture 的所有人工标注内容变化均被 Transcript、OCR change、Content Segment 或 Evidence Window 至少一种机制覆盖；未覆盖范围必须显式返回，不能以 summary 存在替代 coverage；
58. **智能构图**：在人工标注主体 fixture 中，排除明确镜头切换和人工标记快速运动后，主体关键区域位于目标安全区的帧比例不低于 95%，crop center 相邻采样点位移 P95 不超过输出宽度的 3%；低置信度 fixture 必须触发 preserve/fallback，盲裁记为失败；
59. **Beat Grid**：60/90/120/140 BPM 合成 click fixture 的有效 beat 时间误差 P95 不超过 50ms；真实音乐 golden fixture 不超过 80ms。半拍/双拍歧义只有在 beat 对齐仍满足阈值时允许；`confidence < 0.65` 必须降级，不能产生 Beat Sync 草稿；
60. **首个可用反馈**：参考机器冷启动、本地内部 SSD、未命中缓存时，单个 Source 在导入后 3 秒内显示 Probe 摘要；15 个/60 分钟项目在 30 秒内显示全部 Source 的基础摘要和后台任务状态。完整 fingerprint、Proxy 和远程分析不阻塞该指标；
61. **预览响应**：参考机器上，冻结 Timeline/Variant 的 30 秒、1080p H.264 软件编码预览 P50 不超过 15 秒、P95 不超过 30 秒；用户请求 Preview 时，后台低优先级分析在 2 秒内释放可抢占资源或明确报告不可抢占阶段；
62. **预算准确性**：有官方 usage/价格字段的成功调用，结算金额与本地展示实际金额一致；仅能预估的调用，实际用量相对预留 P95 偏差不超过 20%。任何 Operation 在 `reserve` 后不得超过用户授权上限继续启动新批次；Provider 结算异常必须进入 `outcome_unknown`/reconciliation，不能静默吞掉；
63. **恢复时效**：应用正常重启后 10 秒内恢复 Project、当前 Timeline/Variant、Operation 状态和可执行用户动作；在 SQLite/payload/FFmpeg/远程提交各注入崩溃点时，不产生重复正式版本、重复付费提交或无法解释的成功状态；
64. **质量评测纪律**：模型规划、Curation、Quick Create 和质量建议必须使用固定 golden project 集做版本对比，至少记录必留内容召回、非法引用率、需人工决定比例、草稿接受/局部接受/拒绝结果和单项目成本。没有 golden baseline 或新版在任一安全指标退化时，不得仅凭个别演示宣布模型升级通过。
