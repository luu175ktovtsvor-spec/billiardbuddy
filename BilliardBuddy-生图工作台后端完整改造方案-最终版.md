# BilliardBuddy 生图工作台完整改造方案（最终版）

> 文档性质：不需要实施者补做产品/架构决策，可直接执行的产品、前端与后端施工合同
> 目标仓库：`luu175ktovtsvor-spec/billiardbuddy`
> 静态审阅基线：`main` 分支提交 `ba5396a8585453ef17711d039f3049aad21a0abd`
> 交付方式：最终交付必须一次性达到本文件全部目标；施工按可验证的纵向切片推进，每个切片都保持数据一致和可恢复，不把半成品路径留在正式运行链
> 明确边界：不修改 Agent；保留 GPT Image 2 与 Seedream 4.5；删除图片理解链路中的 MiMo；使用 Qwen3-VL-Flash 做理解与非阻断视觉评估，确定性 Release Check 负责成品发布门禁

**架构裁决：** 以本文件修正后的新架构为正式目标；当前旧架构只作为可用能力和迁移数据的基线，不继续扩展为最终工作台。原因不是新架构“类更多”，而是它用更少的正式 writer 和清晰的事务边界，同时覆盖人的探索、选择、修改、多规格排版与交付。本文件定义的是目标与验收合同，不表示当前代码已达成；只有第 18 节全部有生产路径证据时才能宣称完成。

## 0. 开发执行协议

本文件已把产品决策、领域事实、事务边界、API、存储、恢复和验收证据写成施工合同。实施时必须按下列协议执行，不将整份文档作为一个无边界的一次性任务。

### 0.1 一次任务的唯一范围

每个开发任务只接收第 15 节的一个阶段，或该阶段中一个可独立验证的纵向切片。标准任务语句为：

```text
只实施本文档第 15.X 节（或其中明确子切片）。
完成该节的正式 API → Application → SQLite/CAS → Adapter → Event/Public Projection 生产路径和失败路径。
达到该节退出证据后停止，不开始下一阶段。
```

不允许使用“先把所有类和页面搭出来，以后再接真实存储/恢复”的横向施工方式。

### 0.2 开工前必须输出

实施者在修改代码前必须先给出一份简短的“本阶段施工对齐”：

1. 本次完成的用户结果和对应第 18 节条目；
2. 当前生产调用链、存储 writer、事件和恢复入口的代码事实；
3. 本次会修改的领域事实、事务边界和预计文件；
4. 必须保持的旧能力、明确删除的旧 writer/路由以及不在本次范围的内容；
5. 准备运行的 schema、unit、integration、crash/recovery、production path 和 E2E 验证。

如果这五项中有一项无法从本文档和当前代码得出，先报告精确缺口，不自行扩大产品范围。

### 0.3 决策优先级

```text
用户当前任务和明确修改
> 本文档的目标、不变量与验收结果
> 当前代码的真实装配、协议和数据事实
> 历史名称、旧类形状与外部参考实现
```

本文档冻结的是用户结果、领域事实、唯一 writer、事务/恢复边界和验收证据。目录、类名或内部工具在不改变这些结果时可根据现有代码调整，不把“文件名不同”误报为架构缺失。

### 0.4 交付时必须输出

每个阶段的最终回报必须分开说明：

- **已走通的用户结果**：从真实 API 到最终投影/文件的链路；
- **事务与失败结果**：幂等、冲突、崩溃、恢复、拒绝、取消和过期结果中与本阶段有关的证据；
- **等价实现**：哪些能力与文档结果等价但内部形状不同；
- **真实未完成项**：只列用户结果、不变量或验证证据缺口，不列纯代码形状差异；
- **验证清单**：实际命令、结果、未验证的外部依赖；
- **运行环境清理**：施工中启动的临时测试、服务、浏览器和打包进程已停止并复查。

没有对应退出证据时，回报“本阶段未完成”；不因为新增了类、页面、类型或通过了孤立测试而宣称完成。

### 0.5 已冻结、不得重新设计的决策

以下事项已经决定。实施者的任务是实现并验证，不是再次在新旧方案之间选择。

| 冻结决策 | 必须实现的结果 | 禁止的替代做法 |
| --- | --- | --- |
| 元数据存储 | SQLite 是新正式 writer，大字节使用 CAS | 继续拆成多个 JSON writer，或长期 JSON/SQLite 双写 |
| 事务与事件 | 领域状态、pointer、Receipt 和 Event/Outbox 同事务提交 | 先写业务文件、再尽力补 Event，或用进程内 lock 代替数据库约束 |
| Relay 结果 | CAS/DB 成功后才 ACK，ACK 失败只重试 ACK | ACK 失败后重新生成，或本地未提交就 ACK |
| 创作方向 | 一个 Direction = 一个付费 Operation = 一个 Candidate Group | 把多个不同 Prompt 包装成“一次收费任务” |
| 候选与采纳 | Candidate 不可变，Decision/Adoption 独立，不自动采纳 | 修改 Candidate state，或模型生成成功即改 current version |
| 多画板状态 | `current_versions_by_artboard` 是 working selection；完整导出才创建 Delivery Set | 回到单 `current_version_id`，或采纳 Candidate 时伪造 Delivery Set |
| Canvas 写入 | Canvas 新建后只能通过强类型 Command 产生 revision | 增加整份 Canvas PUT 或由前端覆盖服务端文档 |
| 正式像素 | 指定 Canvas revision 经后端 Renderer 产生 Version/Receipt | 把前端预览 PNG 当作正式成品 |
| 精确内容 | required text、Logo、QR 使用确定性 Layer/资产/发布检查 | 依赖生成模型重画或依赖 VLM/OCR 猜测正确 |
| 智能辅助 | Qwen 只提供可解释、非阻断建议；Release Check 确定性执行 | 把 Qwen 分数当发布门禁，或让它自动采纳/删除/发布 |
| 异步过期结果 | 晚到结果可入历史，不覆盖更新的用户事实 | 任务完成时无条件改 current pointer |
| Brand/Template/Asset | 不可变 revision、owner、Provenance 和 Grant 同时成立 | 只靠 CAS hash 推导权限，或让历史成品跟随 head 漂移 |
| 高频旅程 | Quick Create/Inspiration/Campaign 复用普通 Project/Operation/Asset 正式链路 | 为快捷或批量模式复制第二套业务模型 |
| 应用层 | 五个按完整用例/事务边界组织的 Application | 再造一个单体 Service，或按每个名词拆出大量 CRUD Service |
| 远程拓扑 | 生图 Sidecar 携带短期安装 bearer 直连公开 Image Relay；Relay 只经私网 Gateway 内省身份；Qwen 建议单独经 Gateway | Gateway 再代理图片任务、客户端自报 owner/持有 service token，或把 Qwen 覆盖到通用 MiMo 路由 |
| 共享能力语义 | Registry 使用 `ImageGeneration` 与 `VisualEvidence`；图片 generate/edit/inpaint 和 understanding/assessment 是业务 mode/role | 为每个图片用例复制共享 capability，或让共享 Registry 承担图片业务路由 |
| 桌面安全 | 所有写入、付费、路径、grant、风险接受和最终交付经 Electron Main typed IPC | 把 loopback/CORS 当唯一授权，给 Renderer 会话级 secret 或任意路径能力 |
| Shared Kernel 边界 | 视频第 13.0 节第 1 关先成为共享底座 owner 并合入 main；图片 15.1A 只从图片旧 Repository 采用这些兼容原语 | 在图片 worktree 修改视频 Repository/业务状态，或并行复制第二套同义 Kernel |
| 测试开工门 | 视频第 1 关/共享 foundation 先建立全局 test command；图片同步后由 15.0 增加图片分组和旧行为特征基线 | 两个 worktree 并行争写 `ts/package.json`，或先拆 Service/Repository 再反推旧行为 |

允许自主选择的只是不改变上表结果的实现细节：内部函数/类名、SQLite 表与索引的具体名称、满足资源限制和 golden test 的成熟库、前端组件拆分，以及与本文档用户结果和工程质量等价的更小实现。

### 0.6 固定施工顺序与阅读索引

阶段顺序固定为 `15.0 → 15.1 → 15.2 → 15.3 → 15.4 → 15.5`。上一阶段的退出证据未通过，不开始下一阶段。特别是：在旧行为特征基线和正式 test command 未成立前不拆 Service/Repository；在 SQLite 唯一 writer 未成立前不扩展新领域写路径；在确定性 Release Check 未成立前不把 Qwen 评估包装成“质量门禁”。

| 阶段 | 本阶段必读 | 必须交付的生产结果 | 本阶段停止边界 |
| --- | --- | --- | --- |
| 15.0 开工基线 | 第 0、2、12、13.6–13.7、14、15.0、15.6 节 | 正式 test command、当前生产路径 characteristic tests、API/IPC schema harness、可提交 fixture 与临时进程清理检查 | 不拆 Service/Repository，不改变生产 writer/路由/数据 |
| 15.1 事务底座 | 第 2、3、4、6.1、6.4、6.12、8、12、13.6–13.7、14.1–14.3、14.5、14.9–14.11、15.1、15.6 节 | SQLite schema/migration、legacy read/import、唯一 writer、CAS 发布、Event/Outbox、Relay ACK 与启动对账真实链路 | 不开始 Creative Plan、Canvas 或新 UI |
| 15.2 生成候选 | 第 5、6.2–6.9、7、8、9、13.1–13.2、13.6–13.7、14.4–14.5、14.10–14.11、15.2、15.6 节 | Brief/Reference/Policy、Generation Round、付费 Operation/Receipt、Candidate/Decision/Derivation/Adoption、采纳时的初始 Canvas revision 与多 Artboard working pointer | 不开始 Renderer、Canvas 编辑 Command、Qwen 评分或批量 UI |
| 15.3 Canvas 交付 | 第 6.7–6.11、6.14、8.3、10、11、13.3–13.4、13.6–13.7、14.6–14.7、14.10–14.11、15.3、15.6 节 | Canvas Command/revision、确定性 Renderer、Preflight、Version/Render Receipt、Release Check、Export Receipt/Delivery Set | 不开始 Qwen 发布判定或 Campaign |
| 15.4 智能辅助 | 第 5.2–5.4、6.3、6.6、6.14、7、8.4、13.6–13.7、14.4、14.8、14.10–14.11、15.4、15.6 节 | Qwen Understanding/Visual Assessment Adapter、严格 schema、receipt/confidence、失败降级与非阻断 Repair Action | 不给 Qwen 采纳、删除、发布或修改用户事实权限 |
| 15.5 完整工作流 | 第 6.10–6.13、8.4、11–13、14.7–14.11、15.5–15.6、17 节 | Quick Create、Inspiration、Reference Tray、Candidate Review、Canvas/Delivery/Library/Operation Center、Brand/Template、Campaign E2E | 不扩展多人协同、云素材、外部审稿或 CMYK |

每个阶段还必须阅读第 18 节中与本阶段相关的全部条目。如果一个修改横跨两个阶段，优先收缩为上游阶段的完整纵向切片；只有在不留第二 writer或不可恢复中间状态时，才允许一个任务同时收口必要的上下游边界。

### 0.7 第 18 节验收责任映射

| 阶段 | 本阶段主责的第 18 节条目 | 不能提前宣称完成的内容 |
| --- | --- | --- |
| 15.0 | 不提前认领业务条目；为 1–24 建立当前路径基线与测试入口 | 任何尚未实施的新架构能力 |
| 15.1 | 1–3；19 的幂等/revision/单 writer 底座；18、20 的存储与脱敏底座 | 尚未走真实生成/Canvas/UI 路径的业务条目 |
| 15.2 | 4–11；19–21 中与生成、参考、费用和未知结果相关的部分 | 12–15 的正式 Canvas/交付结果，16 的 Qwen 结果 |
| 15.3 | 12–15；17–21 中与渲染、资产、SVG/字体/QR 和导出相关的部分 | 16 的 Qwen 结果和 22–24 的完整产品旅程 |
| 15.4 | 4、6、16、20，以及 21 中 Qwen 输入/输出资源上限 | 不用 Qwen 测试替代 12–15 已需独立通过的确定性验收 |
| 15.5 | 17–24；并对 1–16 进行真实产品路径回归 | 任何缺少真实 E2E、重启恢复、费用确认或最终文件证据的“全部完成”结论 |

一个条目被多个阶段共同完成时，上游阶段只记录“底座证据已通过”，直到它在最后一条真实业务路径中完成回归才标记整项完成。

### 0.8 可直接复制的开工指令

```text
使用《BilliardBuddy 生图工作台完整改造方案（最终版）》作为本轮施工合同。

本轮只实施第 15.X 节：<阶段名称>。
按第 0.6 节阅读必读章节，按第 0.7 节承担对应验收条目。
第 0.5 节的冻结决策不得重新设计或降级。

修改代码前，先按第 0.2 节输出“本阶段施工对齐”，并根据当前代码核实真实装配、writer、生产调用链、失败路径和最近 AGENTS.md。
然后自主完成本阶段的实现、迁移、旧测试更新、真实生产路径验证、崩溃/恢复验证和最终 diff 审查。

不开始下一阶段，不创建并行业务 writer，不用孤立测试代替生产路径，不启动子代理，不改动 Agent/Video。Shared Kernel 必须来自已经合入 main 的共享底座，不在图片 worktree 改写 Video 来制造前置条件。
保留用户的无关工作区改动。停止并复查本轮启动的临时服务、浏览器、测试和打包进程。

达到第 15.X 节退出证据后，按第 0.4 节格式回报并停止；证据不足时明确回报未完成项，不宣称阶段完成。
```

### 0.9 Git worktree 与 main 同步协议

允许并推荐在独立 Git worktree 开发，使 `main` 工作树可以继续维护根 `AGENTS.md`、施工合同和集成状态。创建 worktree 前，两份施工合同必须先进入一个可从 `main` 到达的提交；不得从包含未跟踪合同、未提交代码或未解决冲突的脏工作树复制开发基线。

建议边界：

```text
主工作树 / main
  只负责 AGENTS.md、施工合同、已验收关卡集成和发布基线

视频 worktree / codex/video-workbench-refactor
  先完成视频第 13.0 节第 1 关，成为 Shared Media Kernel 首个 owner

图片 worktree / codex/image-workbench-refactor
  等共享 test/Kernel foundation 经审核进入集成基线后同步，再完成 15.0 → 15.1
```

固定规则：

- 创建前先用 `git worktree list --porcelain` 核对现存 worktree/branch/path；只有确认目标目录已不存在的 `prunable` 注册才可清理，不能删除仍在使用的 worktree。新 worktree 使用仓库外的同级独立目录和未被占用的开发分支；
- `AGENTS.md` 按 worktree 内实际文件生效，main 后续修改不会自动传播。每个阶段开工前，开发分支必须把最新 main 通过项目采用的 merge/rebase 策略纳入当前 HEAD，证明该 main commit 已是祖先，然后重新完整阅读根和最近目录的 `AGENTS.md`；未提交在 main 的指令不视为其他 worktree 已收到；
- 一个阶段只在一个 worktree/branch 内实施，开发分支内可按关卡提交。达到退出证据后停在开发分支，等待用户另行发起合并审核；没有明确授权不得向 main 提交或合并，也不得切换主工作树。只有相关关卡经审核进入集成基线后，后续阶段和另一 worktree 才能同步并依赖它，不能长期在两个分支各自演化同一事实；
- `ts/package.json`/共享 test runner、Shared Kernel、`ts/shared/product/providerContracts.ts`、Gateway/Relay contracts、根架构文档、`deploy/production/*` 和 Nginx/服务器运行文档同一时刻只能有一个明确 owner。需要触碰时先在阶段对齐中声明文件与语义，另一 worktree 等其经合并审核进入集成基线后再继续；
- 图片 worktree 不修改 Video 业务文件；Shared Kernel 首次抽取由视频第 1 关或单独 foundation worktree 完成。图片 15.1 只消费已合入 main 的兼容原语；
- 每个 worktree 使用独立本地数据目录、SQLite/CAS、Sidecar 端口、缓存、日志和临时输出，不能让两个开发实例写同一项目目录。阶段结束停止并复查各自临时进程；
- 服务器只接受已提交、已验收 revision 的一次部署。图片/视频 worktree 不能同时手工改同一台服务器；涉及远程服务的关卡先合入集成基线，再按对应服务器合同盘点和部署。

---

## 1. 改造完成后的后端结果

完成后必须形成以下完整链路：

```text
Create Image Project
→ Define Delivery Intent and Artboards
→ Add, Classify and Lock References
→ Compile Deterministic Brief
→ Optional Qwen Visual Understanding
→ Confirm Facts / Preserve / May Change / Exact Text / Brand Rules
→ Submit Generate/Edit/Inpaint Operation
→ Persist Remote Task and Idempotency
→ Poll and Recover
→ Download Trusted Result
→ Verify Bytes / MIME / Dimensions / Hash
→ Commit Candidate Group
→ User Keep / Reject / Derive / Adopt Candidate
→ Edit Versioned Canvas and Artboards
→ Backend Preflight and Render
→ Verify Exact Text / Logo / QR / Dimensions / Hash
→ Commit Immutable Delivery Version
→ Export Deliverable Set and Verify
→ Recover after Restart
```

它必须支持：

- 无参考图生成；
- 单张或多张参考图；
- subject/style/environment/brand/logo/qrcode；
- 文生图；
- 图生图；
- edit；
- inpaint；
- 多候选；
- 候选比较、保留、舍弃和派生；
- 用户采纳；
- 精确文字；
- Logo；
- 二维码；
- 品牌资产和受控模板；
- 多画板画布组合与尺寸适配；
- 历史版本；
- 导出规格包与发布前检查；
- 可追溯的资产来源和复用；
- 断网和重启恢复。

---

## 2. 当前后端静态分析

### 2.1 当前装配点

当前事实入口：

```text
ts/src/server/index.ts
└── startServer()
    ├── new ImageWorkbenchService()
    ├── createImageWorkbenchDomainApiHandler()
    ├── migrateLegacyMediaStore()
    └── recoverInterruptedOperations()
```

当前路由：

```text
ts/src/server/router.ts
└── /api/images → image handler
```

判断：

- 图片领域已经独立；
- 不应并入 Agent 或 Video；
- 不应重新依赖旧 `MediaProjectService`；
- 应通过 `MediaRuntime` 注入共享 Kernel。

### 2.2 当前正式模块

| 文件 | 当前职责 | 结论 |
| --- | --- | --- |
| `ts/src/server/api/imageWorkbench.ts` | 项目、参考图、提交、操作、版本、输出 | 保留 HTTP 边界，委托新 façade |
| `imageWorkbenchService.ts` | 项目、Brief、模型、Relay、候选、质量、版本、导出、恢复 | 过大，必须拆分 |
| `imageWorkbenchRepository.ts` | 项目、Operation、Event、删除、Fence、锁 | 保留领域存储，抽共享技术层 |
| `imageAssetStore.ts` | MIME、尺寸、CAS、所有权、导出校验 | 基础较好，拆为 AssetStore/Verifier |
| `imageBrief.ts` | 确定性事实和 exact text | 保留并版本化 |
| `imageReasoning.ts` | 远程 Brief 与候选评估 | MiMo 改 Qwen，并通过 Port 调用 |
| `relay/app.ts` | 慢任务、幂等、owner、SQLite/blob、ack | 保留协议，适配为 Generation Port |
| `gateway/providerRegistry.ts` | GPT Image 2、Seedream、MiMo | 保留生成模型，替换理解模型 |
| `ts/shared/contracts/media.ts` | 图片/视频混合合同 | 拆分 kernel/image/video |

### 2.3 当前做得好的部分

必须保留：

- 图片项目独立 owner；
- 参考图角色；
- Brief；
- exact text 提取；
- GPT Image 2；
- Seedream 4.5；
- 三候选；
- Generate/Edit/Inpaint；
- Relay 异步任务；
- idempotency key；
- owner 绑定；
- queue limit；
- blob 持久化；
- `failed_unknown/outcome_unknown` 保护；
- 本地持久化后才 ack；
- Image Operation Event；
- writer fence；
- CAS；
- 真实 MIME；
- 图片尺寸解析；
- SHA-256；
- 项目路径边界；
- 不可变版本；
- current version pointer；
- 导出后二次读取验证；
- public projection 隐藏模型、Prompt 和内部资产。

### 2.4 当前结构性问题

#### 问题 A：`ImageWorkbenchService` 是单体

当前同时负责：

- Project；
- Reference；
- Brief；
- provider 路由；
- remote submit；
- poll；
- result handoff；
- Candidate；
- Assessment；
- Edit/Inpaint；
- Canvas commit；
- Version；
- Export；
- Migration；
- Recovery。

必须收口为少量按完整用例和事务边界组织的 Application：

```text
ImageWorkbenchFacade
├── ImageProjectApplication
├── ImageGenerationApplication
├── ImageCanvasApplication
├── ImageDeliveryApplication
└── ImageRecoveryApplication
```

Project、Reference、Brief、Candidate、Brand Kit 等仍是独立 Domain 模型，但不按“一个名词一个 Service”机械拆类。一次用户命令的校验、事务和事件发布由一个 Application 用例完整承担，避免跨十几个 Service 拼装事务。

#### 问题 B：具体模型进入业务逻辑

当前模型枚举与路由逻辑直接进入项目/Service。

目标：

```text
业务请求 Capability + QualityTier
→ ImageProviderPolicy
→ ProviderCapabilityRegistry
→ Provider/Model Adapter
→ Execution Receipt
```

项目不按模型字符串分支。

#### 问题 C：MiMo 同时负责理解和质检

必须替换为：

```text
qwen3-vl-flash
├── image_understanding（Image Module application role）
└── image_visual_assessment（Image Module application role）
```

GPT Image 2 与 Seedream 4.5 保持不变。

#### 问题 D：没有正式 Candidate Group

远程一次收费操作返回多个候选，但领域需要明确：

```text
Operation
→ Candidate Group
→ Candidate Branches
→ User Adopt
```

候选生成成功不能自动等价为用户采用。

#### 问题 E：客户端 PNG 是最终像素权威

当前 `commitVersion()` 可以接收外部渲染 PNG，并验证：

- 格式；
- 尺寸；
- 图层声明；
- 文本列表；
- 图层边界。

但它不能证明 PNG 真实包含这些图层。

必须建立后端 `ImageCanvasRendererPort`。

#### 问题 F：精确文字、Logo 和二维码不够确定

必须把它们升级为独立 Layer 类型和强校验规则。

#### 问题 G：大项目单 JSON 膨胀

assets、outputs、versions、candidate、canvas 不应无限嵌入 project header。

必须拆分存储。

---

## 3. 最终模块架构

```text
Local Product Server
└── MediaRuntime
    ├── Shared Media Kernel
    │   ├── OperationStore
    │   ├── EventJournal
    │   ├── TransactionalMetadataStore
    │   ├── LockManager
    │   ├── AssetIntegrity / CAS
    │   ├── ProviderCapabilityRegistry
    │   ├── RecoverySupervisor
    │   └── Diagnostics / Budget
    └── ImageModule
        ├── Domain
        ├── Application
        ├── Infrastructure
        └── API
```

依赖：

```text
Image API
↓
ImageWorkbenchFacade
↓
Image Application Use Cases
↓
Image Domain
↑
Infrastructure implements Ports
```

禁止：

- Domain import fetch；
- Domain import Relay；
- Domain import Gateway；
- Domain import Bun；
- Domain import Video；
- Domain import Agent；
- provider result 自动修改 current version；
- 客户端 PNG 无验证地成为正式 Version。

---

## 4. 目标目录

```text
ts/src/server/media/
├── kernel/
│   ├── operations/
│   ├── storage/
│   ├── assets/
│   ├── providers/
│   └── recovery/
└── image/
    ├── domain/
    │   ├── imageProject.ts
    │   ├── imageReference.ts
    │   ├── imageBrief.ts
    │   ├── imageOperation.ts
    │   ├── imageCandidate.ts
    │   ├── imageCreativePlan.ts
    │   ├── imageQualityPolicy.ts
    │   ├── imageInspirationBoard.ts
    │   ├── imageCampaign.ts
    │   ├── imageBrandKit.ts
    │   ├── imageTemplate.ts
    │   ├── imageDeliverySpec.ts
    │   ├── imageAssetProvenance.ts
    │   ├── imageCanvas.ts
    │   ├── imageVersion.ts
    │   └── imageExport.ts
    ├── application/
    │   ├── imageWorkbenchFacade.ts
    │   ├── imageProjectApplication.ts
    │   ├── imageGenerationApplication.ts
    │   ├── imageCanvasApplication.ts
    │   ├── imageDeliveryApplication.ts
    │   └── imageRecoveryApplication.ts
    ├── infrastructure/
    │   ├── sqliteImageMetadataStore.ts
    │   ├── imageMetadataMigrations.ts
    │   ├── legacyImageProjectReader.ts
    │   ├── imageAssetStore.ts
    │   ├── imageOutputVerifier.ts
    │   ├── projectAssetLibrary.ts
    │   ├── fontResolver.ts
    │   ├── canvasPreflight.ts
    │   ├── qrCodeRenderer.ts
    │   ├── svgAssetVerifier.ts
    │   ├── gatewayImageGenerationAdapter.ts
    │   ├── qwenImageUnderstandingAdapter.ts
    │   ├── qwenImageQualityAdapter.ts
    │   ├── deterministicTextLayout.ts
    │   └── imageCanvasRenderer.ts
    └── api/
        └── imageWorkbenchApi.ts

ts/desktop/src/image-workbench/
├── features/
│   ├── creative-intake/
│   ├── quick-create/
│   ├── inspiration-board/
│   ├── reference-tray/
│   ├── candidate-review/
│   ├── canvas-editor/
│   ├── delivery-panel/
│   ├── batch-production/
│   └── operation-center/
├── state/
│   └── imageWorkbenchViewState.ts
└── api/
    └── imageWorkbenchClient.ts
```

`ts/desktop/src/image-workbench` 只保存瞬态交互状态，例如选中的候选、未提交的拖动和面板展开状态。项目、画布、候选、版本、任务与导出事实始终由 Image Module 保存；前端不能自行拼接 Provider Prompt、篡改渲染结果或绕开 Command API 写入项目。

---

## 5. 最终模型和能力合同

### 5.1 Registry

```text
ImageGeneration
→ gpt-image-2
→ doubao-seedream-4-5-251128

VisualEvidence
→ qwen3-vl-flash
```

共享 Registry 只增加或复用以上两个平台 capability，不新增 `ImageEditing`、`ImageUnderstanding`、`ImageQualityAssessment` 三个平行共享 capability：

- `ImageGeneration` 的 provider descriptor 声明受支持的 `operation_modes: generate | edit | inpaint`、参考图数量/角色、尺寸、透明度和输出限制；图片领域在提交前据此返回 capability gap；
- `VisualEvidence` 是只读视觉证据能力。Image Module 通过 `application_role: image_understanding | image_visual_assessment` 选择严格输出 schema；两个 role 复用同一 Qwen capability，不代表 Qwen 获得采纳、发布或写项目权限；
- `ProviderExecutionReceipt.capability` 保存图片领域实际 application role（第 5.3 节的小写枚举），shared registry key 另存为 `registry_capability`。二者不得混为一个可任意扩展的字符串。

共享 `ProviderCapabilityRegistry` 只说明 Provider/Model 声明和实测支持的能力；图片领域自己的 `ImageProviderPolicy` 根据 Reference、画布尺寸、质量档位和用户确认选择模型：

```text
subject/high-fidelity edit
→ GPT Image 2

中文商业视觉/Seedream支持尺寸
→ Seedream 4.5
```

图片路由策略必须集中在 `ImageProviderPolicy`，不能散落在 Application 或 Domain。共享 Kernel 不知道“中文商业视觉”“主体保真”等图片业务概念。

### 5.2 删除 MiMo

必须删除图片正式路径中的：

- MiMo Brief reasoning；
- MiMo candidate assessment；
- MiMo registry capability；
- MiMo provider-specific prompt 分支。

历史 Receipt 保留只读。全局 MiMo key/config 只有在图片、视频及其他消费者全部迁移并完成引用审计后才能删除；图片改造不能越权删除仍被其他领域使用的共享配置。

### 5.3 执行 Receipt

每次远程执行保存：

```ts
type ImageProviderCapability =
  | 'image_generation'
  | 'image_editing'
  | 'image_understanding'
  | 'image_visual_assessment'

type ProviderExecutionReceipt = {
  id: string
  project_id: string
  owner: MediaOwner
  capability: ImageProviderCapability
  registry_capability: 'ImageGeneration' | 'VisualEvidence'
  provider: string
  model_id: string
  model_snapshot?: string
  policy_revision: string
  prompt_compiler_version: string
  provider_request_id?: string
  idempotency_key: string
  request_hash: `sha256:${string}`
  input_asset_hashes: Array<`sha256:${string}`>
  output_asset_hashes?: Array<`sha256:${string}`>
  refusal?: { category: string; safe_message: string }
  submitted_at: string
  completed_at?: string
  usage?: {
    input_bytes?: number
    input_tokens?: number
    output_tokens?: number
    image_count?: number
  }
}
```

Receipt 是独立、不可变的领域证据，Operation 只保存 receipt id。它证明“当时请求了什么能力、使用了什么输入和得到什么输出”，不承诺外部生成模型可以像本地确定性程序一样重放出相同像素。public API 只返回安全摘要。

### 5.4 固定远程调用拓扑与服务器边界

首版图片改造不新增物理服务器；现有图片 Relay 收口为独立 `image-relay` service，并由 Nginx 提供唯一公开前缀。正式路径固定为：

```text
生成 / 编辑 / Inpaint
Renderer → Electron Main typed IPC → Local Sidecar
         → https://zzyppz.cn/image-generation/v1/images/tasks
         → Image Relay
             ├── Gateway POST /internal/v1/auth/introspect（仅 Compose 私网身份内省）
             └── GPT Image 2 / Seedream 4.5

图片理解 / 非阻断视觉评估
Renderer → Electron Main typed IPC → Local Sidecar
         → 已认证 Gateway POST /v1/image/reasoning
         → Qwen3-VL-Flash
```

冻结规则：

- Sidecar 只从受信产品运行配置取得 Image Relay HTTPS base，并复用 Electron Main 注入的短生命周期安装 bearer；Renderer 不得到 bearer、Relay service credential 或 Provider Key。Image Relay 每个受保护请求都用独立 service credential 回查 Gateway，并且只信任内省返回的 owner；请求体/header 自报 owner 一律忽略或拒绝；
- `ImageGenerationPort` 的 generate/edit/inpaint 均走同一 Image Relay task/幂等查询/结果 grant/ACK 协议。Relay 继续拥有 queue、远程 task、unknown、result grant 和 ACK；Image Module 只在本地 CAS + SQLite/Event 事务提交后 ACK，ACK 失败只重试 ACK；
- 付费 POST 前先持久化 operation、idempotency key、request hash 与 `remote_submission_started_at`。若提交响应丢失，Sidecar 只调用 Image Relay `GET /v1/images/tasks/by-idempotency/:key` 查询已持久化任务；404 保持 `outcome_unknown`/失败关闭，禁止自动 POST。只有从未进入提交边界的 operation 才允许首次 POST；
- Qwen 图片建议通过 Gateway 独立 `/v1/image/reasoning` 版本化 schema 发送，使用 `image_advice` workload、独立 `qwen-account` capacity policy 和 `gateway.image-advice` quota。它不得改写通用 MiMo `/v1/media/reasoning` 或 `/v1/visual/evidence`；Gateway 只保存 Qwen 服务端凭据、鉴权、额度、实际用量、幂等结果和安全转发，不保存 Image Project/Candidate/Canvas；
- 模型目录、物理账号 capacity、产品 quota 与 credential ownership 是四个独立权威来源。并发采用“配置外置、算法共享、Provider 执行边界守门”：Nginx 只做连接/请求体/基础速率保护，不充当付费 Provider 并发事实源；Image Relay 在真实 Provider 调用前获取对应账号许可；
- 图片施工不得创建或复用 Video Media Relay。视频大对象租约、视频 ASR/Embedding 与本节无关；两条远程路径只共享向后兼容的 capability/receipt DTO，不共享服务数据库或路由所有权；
- 实施 15.2E/15.4D 时必须同步更新 `README.md`、`docs/重构/模型与远程能力平台.md`、`docs/重构/模型资源治理分层.md` 与 `docs/operations/production-servers.md`，准确记录图片直连 Relay、私网身份内省、独立 Qwen 路由和凭据归属；不得保留 Gateway 图片任务代理或把 Video Media Relay 描述成图片依赖；
- 服务器随已审核提交更新 Gateway/Image Relay 镜像、两个独立 introspection secret 端、Image Relay 结果签名 secret、Qwen/图片 Provider credential、validator、Nginx `/image-generation/` 回源和受控 smoke。任何写操作前仍须按运行文档只读盘点容器、端口、Nginx、revision、资源和 secret 引用；部署后分别验证真实 Sidecar → Image Relay → Provider、Relay → Gateway 内省与 Sidecar → Gateway → Qwen 路径，并以实测更新运行文档。

---

## 6. 核心数据模型

以下公共类型不允许由各模块自行重新声明：

```ts
/** 复用 Shared Media Kernel 已有 owner 合同。 */
type MediaOwner = {
  kind: 'standalone'
  owner_id: 'local_workbench'
}

type ImageProjectState = 'draft' | 'active' | 'ready' | 'failed' | 'trashed'

type ImageReferenceRule = {
  reference_id: string
  role: ImageReferenceRole
  influence_strength: 'low' | 'medium' | 'high'
  preservation: 'may_change' | 'prefer_preserve' | 'must_preserve' | 'exact'
  priority: number
}

type ImageOperationResult =
  | { kind: 'candidate_group'; candidate_group_id: string; expected_count: number; valid_count: number; invalid: Array<{ index: number; safe_error_code: string }> }
  | { kind: 'visual_assessment'; assessment_id: string }
  | { kind: 'rendered_version'; version_id: string; render_receipt_id: string }
  | { kind: 'export_receipts'; export_receipt_ids: string[]; delivery_set_id?: string }
```

Repository 中的 Zod schema、TypeScript type、SQLite constraint 和 public projection 必须从同一套合同派生或逐字段对齐，不能只把本节当作文档示意。

### 6.1 ImageProject

Project header 只保存：

```ts
type ImageProject = {
  id: string
  owner: MediaOwner
  title: string
  state: ImageProjectState
  revision: number
  current_brief_id?: string
  current_delivery_spec_id?: string
  current_delivery_spec_revision?: number
  current_quality_policy_id?: string
  current_quality_policy_revision?: number
  latest_delivery_set_id?: string
  current_versions_by_artboard: Record<string, string>
  brand_kit_revision_id?: string
  created_at: string
  updated_at: string
}
```

当前选中的 Canvas、Candidate、面板和 Artboard 属于前端瞬态视图状态，不进入 Project。Reference、Candidate Group 和 Operation 都通过 `project_id` 索引查询，不把会无界增长的 id 数组放回 Project header。Project state 只表示聚合是否可编辑/可交付，队列、进度和错误以可并发的 Operation 为权威，一个方向失败不得覆盖其他方向的状态。大型内容进入事务元数据表和 CAS；Project 只保存聚合根当前指针。所有写入携带 `base_revision`，由数据库事务中的乐观并发检查取代跨多个 JSON 文件的 writer fence。

### 6.2 ImageReference

```ts
type ImageReferenceRole =
  | 'unclassified'
  | 'subject'
  | 'product'
  | 'character'
  | 'style'
  | 'composition'
  | 'environment'
  | 'brand'
  | 'logo'
  | 'qrcode'

type ImageReference = {
  id: string
  project_id: string
  asset_id: string
  source_inspiration_item_id?: string
  role: ImageReferenceRole
  label?: string
  content_hash: `sha256:${string}`
  influence_strength: 'low' | 'medium' | 'high'
  preservation: 'may_change' | 'prefer_preserve' | 'must_preserve' | 'exact'
  priority: number
  created_at: string
}
```

规则：

- Logo 和 QR 默认 `preservation = exact`；
- `logo`/`qrcode` 的 exact 原资产默认不要求生成模型重画；Brief/Provider 只获得“预留位置”等必要构图约束，真实 Logo/QR 字节由后端 Canvas Layer 合成；
- subject/product/character 默认 `must_preserve`；
- style 不能覆盖 subject；
- unclassified 不允许提交付费生成；
- Provider 不支持某种 reference control 时必须在付费提交前返回 capability gap，并由用户明确降级或换模型，不能生成后才提示风险。

### 6.3 ImageBrief

```ts
type ExactTextRequirement = {
  id: string
  text: string
  role:
    | 'title'
    | 'subtitle'
    | 'price'
    | 'date'
    | 'address'
    | 'contact'
    | 'body'
  required: boolean
}

type ImageBrief = {
  schema_version: 2
  id: string
  project_id: string
  user_request: string
  confirmed_facts: string[]
  must_preserve: string[]
  may_change: string[]
  missing_information: string[]
  exact_text: ExactTextRequirement[]
  reference_rules: ImageReferenceRule[]
  /** 只用于生成底图的建议画布；正式交付尺寸以 DeliverySpec 为准。 */
  generation_canvas?: {
    width: number
    height: number
    color_space: 'srgb'
  }
  compiler_name: 'image-brief'
  compiler_version: string
  reasoning_receipt_id?: string
  snapshot_hash: `sha256:${string}`
  created_at: string
}
```

优先级：

```text
用户 override
> 用户原话
> Host 确定性提取
> Qwen 建议
```

Qwen 不能修改 confirmed facts。

`ImageBrief` 不能再拥有正式输出尺寸。一个 Project 的正式交付尺寸、安全区、格式和多 Artboard 只以 `ImageDeliverySpec` 为权威，避免后续出现两个尺寸来源。

### 6.4 ImageOperation

```ts
type ImageOperationKind =
  | 'generate'
  | 'edit'
  | 'inpaint'
  | 'assess'
  | 'canvas_render'
  | 'export'

type ImageOperation = {
  id: string
  project_id: string
  owner: MediaOwner
  kind: ImageOperationKind
  status:
    | 'queued'
    | 'running'
    | 'cancelling'
    | 'committing'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'blocked_by_policy'
    | 'outcome_unknown'
  idempotency_key: string
  logical_attempt: number
  base_version_id?: string
  /** 未采纳候选也可以成为下一轮变体、编辑或局部重绘的输入。 */
  base_candidate_id?: string
  mask_asset_id?: string
  instruction?: string
  input_refs: {
    project_revision: number
    brief_snapshot_hash?: `sha256:${string}`
    delivery_spec_revision?: number
    canvas_revision?: number
    execution_policy_revision: string
    asset_hashes: Array<`sha256:${string}`>
  }
  remote_task_id?: string
  execution_receipt_id?: string
  result?: ImageOperationResult
  completion_freshness?: 'current' | 'stale'
  safe_error?: { code: string; message: string }
  cancellation?: {
    requested_at: string
    remote_state: 'pending' | 'confirmed' | 'unsupported' | 'too_late'
    late_result_policy: 'retain_as_unadopted' | 'discard_after_receipt'
  }
  cost_state: 'not_submitted' | 'submitted_charge_possible' | 'usage_recorded'
  submitted_at?: string
  completed_at?: string
  created_at: string
  updated_at: string
}
```

`ImageOperationResult` 按 `kind` 使用判别联合，至少区分 Candidate Group、Visual Assessment、Rendered Version 与一组 Export Receipts/可选 Delivery Set，禁止把 `unknown` 作为持久化合同。幂等键由 owner、operation kind、全部 input refs、policy revision 和逻辑 attempt 共同生成；远端提交开始后没有明确结果时只能按原幂等键查询，不能自动创建新付费请求。Provider 内容策略拒绝必须落为 `blocked_by_policy` 和脱敏的 refusal receipt，不得伪装成网络失败或自动重试。

底层兼容旧 `mediaTaskSchema`，但新领域不能把所有操作叫 `image.generate`。

### 6.5 Candidate Group

```ts
type ImageCandidateGroup = {
  id: string
  project_id: string
  operation_id: string
  brief_snapshot_hash: string
  creative_plan_id?: string
  creative_direction_id?: string
  generation_round_id: string
  base_version_id?: string
  candidate_ids: string[]
  created_at: string
}

type ImageCandidate = {
  id: string
  asset_id: string
  candidate_index: number
  derived_from_candidate_id?: string
  creative_direction_id?: string
  content_hash: `sha256:${string}`
  width: number
  height: number
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp'
  created_at: string
}

type ImageCandidateDecision = {
  id: string
  project_id: string
  candidate_id: string
  decision: 'kept' | 'rejected'
  supersedes_decision_id?: string
  actor: MediaOwner
  created_at: string
}

type ImageCandidateAdoption = {
  id: string
  project_id: string
  candidate_id: string
  artboard_id: string
  version_id: string
  canvas_id: string
  canvas_revision: number
  placement: { fit: 'cover' | 'contain'; focus_x: number; focus_y: number }
  actor: MediaOwner
  created_at: string
}
```

规则：

- 一次收费请求对应一个 Group；
- 每张 Candidate 和其像素事实不可变；
- assessment 不自动 adopt；
- keep/reject 与 adopt 是独立记录，不能修改 Candidate 本体；
- 同一 Candidate 可以被多个 Artboard 采纳；
- 只有明确 adopt/select 才改变对应 Artboard 的 current version。

候选派生以 `base_candidate_id` 为输入，不要求先 adopt 成 Version；派生后新 Candidate 必须通过 `derived_from_candidate_id` 保留谱系。

### 6.6 Candidate Assessment 与 Creative Plan

候选组不能只是同一请求的三次随机采样。`ImageCreativePlan` 先将同一 Brief 拆成有意义、可比较的方向，再由生成任务为每个方向请求候选；它是建议，不改变用户事实，也不替代用户选择。

```ts
type ImageCreativePlan = {
  id: string
  project_id: string
  brief_snapshot_hash: `sha256:${string}`
  directions: Array<{
    id: string
    label: string
    rationale: string
    generation_intent: {
      composition_goal: string
      visual_tone: string
      text_space_goal?: string
    }
    preservation_rules: string[]
  }>
  source: 'deterministic' | 'qwen_suggestion'
  suggestion_receipt_id?: string
  created_at: string
}

type ImageGenerationRound = {
  id: string
  project_id: string
  creative_plan_id: string
  direction_operations: Array<{ direction_id: string; operation_id: string }>
  estimate_hash: `sha256:${string}`
  confirmed_at: string
  created_at: string
}
```

默认可提供“稳妥商业版 / 强视觉版 / 为确定性文字预留空间版”等不同方向；用户也可以选择仅沿一个方向生成。每个 Direction 对应一个独立 Operation 和 Candidate Group，多个方向由 Generation Round 聚合。Round 创建时即固定 direction 到 Operation 的映射；Candidate Group id 是各 Operation 完成后的结果，不反向改写 Round。不能把多个不同 Prompt 塞进一个 Operation 后仍宣称是一次收费请求。结构化 `generation_intent` 只在 Adapter 中编译为实际 Provider Prompt，不作为前端可写的内部 Prompt。

`ImageVisualAssessment` 只承载视觉风险和创意建议，并为问题给出可执行的下一步：

```ts
type ImageVisualAssessment = {
  id: string
  candidate_id: string
  candidate_hash: `sha256:${string}`
  brief_snapshot_hash: string
  provider_receipt_id: string
  subject_fidelity?: number
  composition?: number
  defects: string[]
  preservation_risks: string[]
  exact_text_area_risk?: string
  visual_signals: Array<{ name: 'subject' | 'composition' | 'text_area' | 'artifact' | 'crop'; confidence: number; message: string }>
  recommended_actions: Array<'keep' | 'derive' | 'inpaint' | 'regenerate' | 'move_to_canvas'>
  recommendation: 'usable' | 'review' | 'retry_suggested'
  created_at: string
}
```

Qwen 只输出非阻断的视觉建议，不能产生 Release Gate。确定性发布检查由独立的 `ImageReleaseCheckResult` 负责；它读取资产字节、Canvas、字体、Logo/QR 和最终导出文件，不依赖 Qwen 判断。

### 6.7 Canvas Document

```ts
type ImageCanvasDocument = {
  schema_version: 1
  id: string
  project_id: string
  artboard_id: string
  delivery_spec_id: string
  delivery_spec_revision: number
  brand_kit_revision_id?: string
  template_revision_id?: string
  width: number
  height: number
  color_space: 'srgb'
  background: CanvasBackground
  layers: CanvasLayer[]
  created_at: string
}
```

Canvas 的 width/height 是被锁定 Delivery Spec revision 的冗余校验值，不是第二个尺寸权威；读取或渲染时必须断言两者一致。

```ts
type CanvasTransform = {
  x: number
  y: number
  width: number
  height: number
  rotation_degrees: number
  scale_x: number
  scale_y: number
}

type CanvasBackground =
  | { kind: 'solid'; color: string }
  | { kind: 'transparent' }

type MaskLayer = {
  id: string
  kind: 'mask'
  source_asset_id: string
  target_layer_id: string
  mode: 'alpha' | 'luminance'
}
```

坐标统一使用 Artboard 像素、左上角原点。顶层 `layers` 与每个 Group 的 `children` 数组顺序是各层级的唯一 z-order；Layer id 在整份 Document 中唯一，树嵌套深度有上限，不存在另一份 child id 映射或隐含 z-order。

颜色只允许规范化 sRGB `#RRGGBB`/`#RRGGBBAA`；opacity 在 `[0, 1]`；所有坐标为有限数，width/height/scale 大于 0，rotation 规范到统一区间。Raster `source_crop` 使用源图像素坐标且不得越界；Mask 只能指向同一 Group 层级的 Raster，按目标边界确定性重采样，不能裁切 Logo 或 QR。

Layer：

```ts
type CanvasLayer =
  | RasterLayer
  | TextLayer
  | LogoLayer
  | QrCodeLayer
  | ShapeLayer
  | GroupLayer
  | MaskLayer
```

#### RasterLayer

```ts
type RasterLayer = {
  id: string
  kind: 'raster'
  source_asset_id: string
  transform: CanvasTransform
  source_crop?: { x: number; y: number; width: number; height: number }
  opacity: number
  blend_mode: 'normal' | 'multiply' | 'screen'
}
```

#### TextLayer

```ts
type TextLayer = {
  id: string
  kind: 'text'
  requirement_id?: string
  text: string
  font_family: string
  /** 正式渲染必填；font_family 仅用于 UI 显示。 */
  font_asset_id: string
  font_size: number
  min_font_size?: number
  font_weight: number
  font_style: 'normal' | 'italic'
  line_height: number
  letter_spacing: number
  fill: string
  stroke?: string
  position: { x: number; y: number }
  rotation_degrees: number
  max_width?: number
  max_height?: number
  overflow: 'error' | 'shrink_to_fit' | 'clip'
  locale: string
  align: 'left' | 'center' | 'right'
  opacity: number
}
```

映射 required ExactText 的 TextLayer 不允许 `overflow = 'clip'`；`shrink_to_fit` 必须有可读的 `min_font_size`，若仍放不下则 Preflight 失败，不能无下限缩小来制造“已排下”的假象。

#### LogoLayer

```ts
type LogoLayer = {
  id: string
  kind: 'logo'
  source_asset_id: string
  transform: CanvasTransform
  preserve_exact_source: true
  /** SVG 保持矢量渲染；其他格式按原始像素渲染。 */
  render_mode: 'vector_exact' | 'raster_exact'
}
```

`preserve_exact_source` 表示 Logo 必须来自锁定 hash 的源资产，不能被生成模型重画，也不能滤镜、内容裁切、重着色或改变内部图形；允许在 sRGB 中做明确的整体几何缩放、旋转和平移。它保证来源与内容不被生成式修改，不声称缩放后的输出像素与源文件逐像素相同。Render Receipt 必须记录原资产 hash、解码器/矢量渲染器版本、转换矩阵和输出边界。

#### QrCodeLayer

```ts
type QrCodeLayer = {
  id: string
  kind: 'qrcode'
  source:
    | { kind: 'asset'; asset_id: string }
    | { kind: 'payload'; value: string }
  transform: CanvasTransform
  error_correction: 'M' | 'Q' | 'H'
  quiet_zone_modules: number
  verify_after_render: true
}
```

当 `source.kind = 'payload'` 时，`qrCodeRenderer` 在服务端生成二维码资产并记录 payload hash；当其为 `asset` 时，保留用户的原始二维码。两种模式都必须在最终 PNG 上重新解码验证。Logo 资产新增受控的 `image/svg+xml` 支持，仅允许作为 Logo/Template 资产进入 `svgAssetVerifier` 与 Renderer，不把 SVG 当作可执行内容或普通参考图。

#### ShapeLayer 与 GroupLayer

```ts
type ShapeLayer = {
  id: string
  kind: 'shape'
  shape: 'rectangle' | 'ellipse' | 'line'
  transform: CanvasTransform
  fill?: string
  stroke?: string
  stroke_width?: number
  opacity: number
}

type GroupLayer = {
  id: string
  kind: 'group'
  children: CanvasLayer[]
}
```

Shape 与 Group 只解决海报、封面和模板中的基础构图；不引入任意路径编辑、滤镜图层或通用矢量编辑器语义。

### 6.8 ImageVersion

```ts
type ImageVersion = {
  id: string
  project_id: string
  artboard_id: string
  parent_version_id?: string
  source_candidate_id?: string
  kind:
    | 'generated'
    | 'edit'
    | 'inpaint'
    | 'canvas'
  operation_id: string
  asset_id: string
  canvas_document_id?: string
  canvas_revision?: number
  canvas_document_hash?: `sha256:${string}`
  render_receipt_id?: string
  content_hash: `sha256:${string}`
  width: number
  height: number
  created_at: string
}

type ImageRenderReceipt = {
  id: string
  canvas_id: string
  canvas_revision: number
  document_hash: `sha256:${string}`
  delivery_spec_id: string
  delivery_spec_revision: number
  brand_kit_revision_id?: string
  template_revision_id?: string
  renderer_version: string
  text_layout_engine_version: string
  dependency_asset_hashes: Array<`sha256:${string}`>
  font_asset_hashes: Array<`sha256:${string}`>
  output_hash: `sha256:${string}`
  created_at: string
}

type ImageDeliverySet = {
  id: string
  project_id: string
  delivery_spec_id: string
  delivery_spec_revision: number
  version_ids_by_artboard: Record<string, string>
  export_receipt_ids_by_artboard: Record<string, string>
  created_at: string
}

type ImageExportReceipt = {
  id: string
  project_id: string
  artboard_id: string
  version_id: string
  source_hash: `sha256:${string}`
  output_asset_id: string
  output_format: 'png' | 'jpeg' | 'webp'
  output_hash: `sha256:${string}`
  width: number
  height: number
  byte_size: number
  release_check_result_id: string
  created_at: string
}
```

Version、Render Receipt、Delivery Set 和 Export Receipt 都不可修改。Candidate 采纳或选择历史版本只改变 Project 对应 Artboard 的 working current version；只有全部必需 Artboard 都使用与 Delivery Spec 匹配且通过发布检查的正式渲染 Version，导出事务才创建完整 Delivery Set 并更新 `latest_delivery_set_id`。后续编辑不改写旧 Delivery Set；UI 通过比较当前 version map 与 latest set 标记“有未重新导出的更改”。

### 6.9 Delivery Spec 与 Artboard

用户首先表达的是交付意图，而不是模型尺寸。`ImageDeliverySpec` 将渠道、尺寸、文字安全区、输出格式和透明背景等交付规则集中保存；生成模型只能读取其中与生成有关的约束，最终尺寸和排版由 Canvas/Renderer 执行。

```ts
type ImageDeliverySpec = {
  schema_version: 1
  id: string
  project_id: string
  revision: number
  purpose: 'social_cover' | 'product_marketing' | 'poster' | 'custom'
  artboards: Array<{
    id: string
    label: string
    required: boolean
    width: number
    height: number
    safe_area?: { top: number; right: number; bottom: number; left: number }
    output:
      | { format: 'png'; transparent: boolean }
      | { format: 'jpeg'; quality: number; background_color: string }
      | { format: 'webp'; quality: number; transparent: boolean }
  }>
  created_at: string
}
```

规则：

- 一个 Project 可以有多个 Artboard；每个 Artboard 有自己的 Canvas Document 和正式 Version；
- 同一视觉底图可复用，但不能假定横竖版只需缩放，文字、Logo 和安全区必须允许独立调整；
- Artboard id 在同一 revision 内唯一，尺寸/像素受上限约束，safe area 不得反转或超出画板；JPEG 不支持透明并必须明确压平背景色，JPEG/WebP quality 限定在有效范围；
- `DeliverySpec` 的变更创建新 revision，不得静默改变已经导出的文件；
- `(id, revision)` 是 Delivery Spec revision 的唯一键，记录本身不可变；Project 的 current id/revision 必须成对修改；
- 输出尺寸、格式和安全区为确定性规则，不进入自由文本 Prompt。

### 6.10 Brand Kit 与 Template

品牌不是一张“风格参考图”。它需要与模型参考和画布图层分开保存，避免每个 Service 都各自解释品牌色、字体和 Logo。

```ts
type ImageBrandKit = {
  id: string
  owner: MediaOwner
  name: string
  current_revision_id: string
  created_at: string
  updated_at: string
}

type ImageBrandKitRevision = {
  id: string
  brand_kit_id: string
  revision: number
  logo_asset_ids: string[]
  font_asset_ids: string[]
  color_tokens: Record<string, string>
  required_text: Array<{ id: string; value: string; purpose: 'legal' | 'contact' | 'slogan' }>
  created_at: string
}

type ImageTemplate = {
  id: string
  owner: MediaOwner
  name: string
  current_revision_id: string
  created_at: string
  updated_at: string
}

type ImageTemplateRevision = {
  id: string
  template_id: string
  revision: number
  brand_kit_id?: string
  brand_kit_revision_id?: string
  /** 与 Project Canvas 分离的无 owner 画布蓝图。 */
  blueprint: CanvasBlueprint
  slots: Array<{ id: string; layer_id: string; kind: 'raster' | 'text' | 'logo' | 'qrcode'; required: boolean }>
  schema_version: number
  created_at: string
}

type CanvasBlueprint = {
  schema_version: number
  artboard: { width: number; height: number; safe_area?: { top: number; right: number; bottom: number; left: number } }
  layers: CanvasLayer[]
}
```

规则：

- Brand Kit 与 Template 在当前阶段按本地 owner 隔离并使用不可变 revision；项目和 Canvas 只能引用具体 revision，后续修改不能改变历史成品；
- Template/Campaign 中的 Brand Kit/Template head id 与 revision id 必须成对存在且所属关系一致，不允许只记 head 后在运行时漂移到新 revision；
- Template 只保存可编辑的 Canvas 结构和 Slot，不能保存外部 Provider 的私有 Prompt 或令牌；
- Blueprint 只能引用 Brand Kit/内置资产或未绑定的 Slot，不能引用某个 Project 的 Candidate、Canvas 或临时资产；
- Slot id/layer id 在 revision 内唯一，指向存在且 kind 匹配的 Layer；应用时 required Slot 必须有受控绑定，尺寸/纵横比不匹配时必须使用明确的适配策略产生新 Canvas revision，不隐式拉伸或截断文字；
- Brand Kit color token 名使用受限标识符，值使用规范化 sRGB 颜色；Logo/Font 资产必须属于该 Brand Kit 或有有效 Grant，字体许可必须允许本地渲染；
- 必填文字、Logo、字体和色彩 Token 由 Preflight 校验；模型可以生成背景或装饰，但不能替代这些确定性资产；
- 模板应用是一次显式 Command，生成新的 Canvas revision，不能反向改写模板或其他项目。

### 6.11 Canvas Revision 与 Command

`ImageCanvasDocument` 不能只有创建时间。前端拖动、文字修改、图层重排与尺寸适配必须通过可验证 Command 形成 revision，才能支持撤销、恢复和低成本维护。

```ts
type CanvasCommandBase = {
  id: string
  idempotency_key: string
  canvas_id: string
  base_revision: number
  actor: MediaOwner
  created_at: string
}

type CanvasCommand = CanvasCommandBase & (
  | { kind: 'add_layer'; payload: { parent_group_id?: string; layer: CanvasLayer; index?: number } }
  | { kind: 'replace_layer'; payload: { layer: CanvasLayer } }
  | { kind: 'remove_layer'; payload: { layer_id: string } }
  | { kind: 'reorder_layers'; payload: { parent_group_id?: string; ordered_layer_ids: string[] } }
  | { kind: 'apply_template'; payload: { template_id: string; template_revision_id: string; slot_bindings: Array<{ slot_id: string; asset_id?: string; text?: string; qr_payload?: string }> } }
  | { kind: 'apply_brand_kit'; payload: { brand_kit_id: string; brand_kit_revision_id: string } }
  | { kind: 'sync_delivery_spec'; payload: { delivery_spec_id: string; delivery_spec_revision: number; layout_policy: 'preserve_position' | 'fit_safe_area' } }
)

type ImageCanvasRevision = {
  canvas_id: string
  revision: number
  document_hash: `sha256:${string}`
  document: ImageCanvasDocument
  parent_revision?: number
  created_at: string
}
```

规则：

- Command 必须携带 `base_revision` 和 idempotency key，由同一数据库事务中的 revision compare-and-swap 拒绝过期写入；
- `replace_layer` 必须保持 layer id 且通过对应 kind schema；`reorder_layers` 必须精确包含指定层级的全部 layer id，不得隐式删层或跨 Group 移动；
- 修改画板尺寸先创建 Delivery Spec revision，再用 `sync_delivery_spec` 产生 Canvas revision；Canvas Command 不能成为第二个正式尺寸权威；
- 撤销通过创建反向 Command 或选择历史 revision 实现，不修改历史文档；
- 前端预览可即时，但正式导出只能使用已持久化 revision；
- Canvas 只实现本产品需要的图层、对齐、分组、裁切和安全区；不演化为通用 Figma 或 Photoshop。

### 6.12 Asset Provenance 与 Project Library

CAS 解决内容完整性，不等于素材可追溯。每个导入的 Reference、Logo、字体和外部结果还需要记录来源和使用边界；系统只保存用户声明，不自动断言版权或肖像授权。

```ts
type ImageAssetOwner =
  | { kind: 'project'; id: string }
  | { kind: 'brand_kit'; id: string }
  | { kind: 'template'; id: string }

type ImageAssetProvenance = {
  asset_id: string
  owner: ImageAssetOwner
  origin: 'user_upload' | 'generated' | 'derived' | 'template'
  source_asset_ids: string[]
  source_project_id?: string
  source_version_id?: string
  user_rights_note?: string
  retention: 'project' | 'brand_kit' | 'template'
  created_at: string
}

type ImageAssetGrant = {
  id: string
  asset_id: string
  from_owner: ImageAssetOwner
  to_owner: ImageAssetOwner
  purpose: 'render' | 'template_use' | 'project_reuse'
  granted_by: MediaOwner
  created_at: string
  revoked_at?: string
}
```

Project Library 提供项目内资产、候选、采用版本和导出物的筛选、收藏、克隆/复用入口。它复用现有 Asset Store 与内容哈希，不新建第二套文件系统或泛化媒体图库。跨 owner 复用必须创建显式 Asset Grant 或复制为新 owner 资产；CAS 可以去重字节，但不能绕过所有权检查。

### 6.13 Quick Create、Inspiration Board 与 Campaign

三个面向人的高频场景必须作为正式功能，而不是要求用户每次都走完整表单：

```ts
type ImageQuickCreateRequest = {
  prompt: string
  output_preset: 'square' | 'landscape' | 'portrait' | 'auto'
  /** 在建项事务中一起校验、持久化为该 Project 的 Reference。 */
  reference_inputs?: Array<{ data_url: string; role: Exclude<ImageReferenceRole, 'unclassified'> }>
}

type ImageInspirationBoard = {
  id: string
  project_id: string
  revision: number
  created_at: string
  updated_at: string
}

type ImageInspirationItem = {
  id: string
  board_id: string
  asset_id: string
  note?: string
  created_at: string
  updated_at: string
}

type ImageCampaign = {
  id: string
  owner: MediaOwner
  revision: number
  brand_kit_id?: string
  brand_kit_revision_id?: string
  template_id?: string
  template_revision_id?: string
  shared_brief: { user_request: string; confirmed_facts: string[]; must_preserve: string[] }
  planned_item_count: number
  estimated_paid_operations: number
  estimate_hash?: `sha256:${string}`
  budget_limit?: { currency: string; amount_minor: number }
  confirmed_at?: string
  created_at: string
  updated_at: string
}

type ImageCampaignItem = {
  id: string
  campaign_id: string
  ordinal: number
  variable_values: Array<{ slot_id: string; value: string }>
  project_id?: string
  state: 'draft' | 'queued' | 'running' | 'ready' | 'failed' | 'cancelled'
  attempt: number
  safe_error_code?: string
  created_at: string
  updated_at: string
}
```

规则：

- Quick Create 在一次点击中创建后台 Project、默认 Delivery Spec、确定性 Brief snapshot、单方向 Creative Plan/Generation Round 与初始 Operation；Candidate Group 只在远端结果通过本地事务提交后出现。完整 Brief 表单、Brand Kit 和 Canvas 是后续可选增强，不能阻塞第一次出图；
- 无参考图 Quick Create 可以一键提交；带参考图时必须先明确 role，不能用模型猜测的角色直接触发付费生成；
- Inspiration Board 可以保存灵感图与备注，但只有用户显式标记的项目才成为 `ImageReference` 并发送给 Provider；
- Campaign Item 是独立受限表行，不嵌入 Campaign header；不对多个 value 数组做隐式笛卡尔积；开始前展示项目数、预计付费 Operation 数并要求确认；
- Campaign 只编排多个普通 ImageProject 的创建和状态，不另造候选、画布、版本或资产存储模型；单个项目失败不会阻塞其他项目；
- Campaign 的变量只能填充受控 Brief/Template Slot，不能作为未经校验的 Provider Prompt 拼接。

### 6.14 Quality Policy 与 Repair Loop

质量不能由单一评分决定。`ImageQualityPolicy` 为一个项目定义技术硬检查、软风险、用户确认和可执行修复之间的关系。

```ts
type ImageQualityPolicy = {
  id: string
  project_id: string
  revision: number
  visual_review_checks: Array<'subject_fidelity' | 'composition' | 'artifacts' | 'text_area'>
  warning_acceptance: {
    enabled: boolean
    allowed_categories: Array<'optional_layer_bleed' | 'optional_text_area' | 'subject_fidelity' | 'composition' | 'visual_artifacts'>
  }
  created_at: string
}

type ImageReleaseCheckResult = {
  id: string
  project_id: string
  version_id: string
  export_asset_id: string
  checks: Array<{ id: string; name: string; status: 'pass' | 'warn' | 'fail'; waivable: boolean; evidence: string; evidence_hash: `sha256:${string}` }>
  accepted_warning_receipt_ids: string[]
  passed: boolean
  created_at: string
}

type ImageRiskAcceptanceReceipt = {
  id: string
  project_id: string
  check_name: string
  evidence_hash: `sha256:${string}`
  actor: MediaOwner
  reason?: string
  created_at: string
}
```

流程：

```text
Reference capability check
→ Candidate visual assessment
→ 推荐 keep / derive / inpaint / regenerate / canvas
→ User decision
→ Canvas Preflight
→ Backend render
→ Technical release checks
→ Export Receipt
```

视觉评估永远只能给出建议。资产所有权、资产完整性、文件可解码和输出尺寸不可豁免；字体覆盖、必填内容、Logo 来源和二维码解码是否允许带警告导出，由 Delivery Spec/Template 是否将其标为 required 决定。任何用户接受风险的操作都要留下锁定当时 check/evidence hash 的 receipt，不能静默跳过检查或把接受回执套用到后续新导出。

`ImageQualityPolicy` 不能保存或修改硬门禁数组。平台代码固定 `asset_ownership`、`asset_integrity`、`file_decode`、`export_dimensions` 为不可豁免；Delivery Spec/Template/Brand revision 将文字、Logo、QR 或安全区标成 required 后，对应 `font_coverage`、`required_text`、`logo_source`、`qr_decode`、`required_safe_area` 也在该 Version 上派生为不可豁免。策略 revision 只能选择视觉复核项、软阈值和上表有限的 warning category，不能把 fail 降为 warn。任何策略/模板变化都使旧 Release Check 和风险接受回执 stale，必须针对新导出重新检查。

---

## 7. Brief 编排

### 7.1 确定性编译始终运行

```text
user request
→ normalize whitespace
→ exact text extraction
→ explicit fact extraction
→ reference role validation
→ missing information
→ base Brief
```

当前 `imageBrief.ts` 的以下思路保留：

- 引号文字；
- 标题/文案/写上；
- 价格/日期/时间/地址/电话；
- 不编造事实；
- 为确定性文字预留区域。

### 7.2 Qwen 调用条件

以下情况调用 shared `VisualEvidence` 下的 `image_understanding` application role：

- subject；
- brand；
- logo；
- qrcode；
- 多参考图；
- 复杂 edit；
- 用户明确要求增强理解。

简单无参考文生图可以不调用。

### 7.3 合并

Qwen 返回：

- 参考图可见事实；
- 保留风险；
- 主体和品牌提示；
- 构图建议；
- 缺失信息。

Host 合并时：

- 不覆盖用户事实；
- 不删除 must_preserve；
- 不添加未经确认的商业事实；
- 保存 reasoning receipt。

Qwen Adapter 必须使用严格 schema 和字段/数组/文本长度上限解析响应，拒绝未知字段；不把自由文本响应直接拼入 Provider Prompt。参考图中出现的“指令”、URL 或伪造系统文字都只是被观察的图像内容，不是 Host Command；Qwen 没有文件、网络、采纳、发布或删除权限。超时、无法解析或低信度时保留确定性 Brief，并把未确认内容留给用户，不阻断可安全继续的路径。

---

## 8. 生成/编辑任务编排

```text
validate project/revision
→ compile Brief snapshot
→ resolve provider policy
→ create persisted Operation
→ persist idempotency
→ submit Relay
→ persist remote task id
→ poll/recover
→ obtain trusted result grant
→ download bytes
→ verify image
→ operation committing
→ persist CAS/assets/candidate group
→ commit project
→ acknowledge Relay
→ operation succeeded
```

### 8.1 未知结果

```text
remote submission started
但未得到明确结果
→ outcome_unknown
→ 不自动重提
→ 继续按 idempotency 查询
```

### 8.2 部分候选

如果返回 3 张中只有 2 张合法：

- Group 可以提交 2 张；
- Operation result 记录 expected/valid/invalid；
- 不把坏图写入资产；
- 用户可以使用合法候选；
- 不自动重复收费。

### 8.3 异步完成与过期输入

每个异步 Operation 锁定提交时的 Project/Brief/Delivery Spec/Canvas/Asset/policy revision。任务执行期间用户可以继续编辑，因此完成时必须遵守：

- Generate/Edit/Inpaint 完成只创建 Candidate Group，永不改 working current version；
- Canvas Render 无论输入是否过期都可保存可验证 Version/Receipt，但只有当 Project 的预期 current version 和 Canvas revision 仍与提交时一致时，才能按 `activate_on_success` 原子更新 working pointer；否则记录 `completion_freshness = 'stale'` 并留在历史供用户选择；
- Export 始终对锁定的 version map 生成 Delivery Set；导出期间的新编辑不改变该成品，UI 用当前 map 对比该 Set 清晰显示它是最新编辑还是历史交付；
- 任何过期异步结果都不能用“任务后完成”作为理由覆盖更新的用户事实。

### 8.4 政策、隐私、成本与取消边界

生图是会对外传输素材且可能付费的操作，因此必须在正式产品路径中有以下边界：

- 本地策略或 Provider 内容安全拒绝记为 `blocked_by_policy`；仅当用户修改输入或明确选择另一符合能力与政策的 Provider 时才能创建新 Operation；
- 上传给 Provider 的衍生文件默认移除 EXIF/GPS 等非必要元数据；原始文件是否本地保留由 retention policy 决定；
- internal Prompt、原始 Provider response、result grant 和图像字节不进入 public projection、Event 或普通日志；诊断仅保留 hash、分类、时间和脱敏错误码；
- Relay 结果在本地 CAS/元数据事务提交且 ACK 成功后进入可删除状态，不无期保留第二份结果；
- 多方向 Generation Round 和 Campaign 启动前必须返回付费 Operation 数、可获取的价格/用量上界与并发占用，超过用户或系统 budget 时拒绝启动；
- 一个付费 Operation 在 `submitted_charge_possible` 之后永不自动替换幂等键重提；“重试”必须说明是继续查询原任务还是创建新的可收费尝试；
- 取消是请求，不是退费承诺。远端不支持或取消太晚时仍可能产生费用和结果；晚到结果按 Operation 的 `late_result_policy` 保存为未采纳候选或留下 receipt 后删除，绝不自动改变项目；
- API 和 Renderer 统一限制上传字节、解码像素、Canvas 图层数、SVG 节点/外部资源、字体大小、QR payload、单批项目数和同时 Operation 数，防止解码炸弹和资源耗尽。

---

## 9. 用户采纳

正确流程：

```text
Candidate Group Ready
→ 各 Artboard 的 Current Version 都不自动改变
→ User Adopt Candidate to one or more Artboards
→ 用户为每个目标 Artboard 确认 cover/contain 和焦点
→ 为每个 Artboard 创建引用原 Candidate 资产的初始 Canvas revision 与 working Version
→ 同一事务更新 current_versions_by_artboard
→ latest_delivery_set_id 保持上次成功交付，UI 标记当前编辑已过期待重新导出
```

为了读取历史项目，可以保留旧自动选择记录，但新项目不自动 adopt。

新增 command：

```text
POST /api/images/projects/:id/candidates/:candidateId/adoptions
```

Command 必须明确给出每个 Artboard 的 placement、`base_revision` 和幂等键。对已完成的相同幂等键重放返回原 Adoption/Canvas Revision/Version；不得重复创建版本。working Version 可复用 Candidate 的原资产字节，但不等于已满足 Artboard 尺寸的成品；只有后端 Canvas Render 产生的 Version 才可进入 Delivery Set。部分 Artboard 失败时整个采纳事务回滚，不留下半套 current pointer。

---

## 10. 后端画布渲染

### 10.1 为什么必须后端渲染

客户端预览只用于交互，不能作为正式像素真相。

后端必须根据：

- base raster；
- image layers；
- text；
- Logo；
- QR；
- masks；
- position；
- dimensions；
- font；
- renderer version；

重新生成最终 PNG。

### 10.2 Renderer Port

```ts
type VerifiedAssetInput = {
  asset_id: string
  content_hash: `sha256:${string}`
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml'
  width?: number
  height?: number
  bytes: Uint8Array
}

type VerifiedFontAssetInput = {
  asset_id: string
  content_hash: `sha256:${string}`
  family: string
  style: string
  weight: number
  bytes: Uint8Array
}

type RenderedImage = {
  bytes: Uint8Array
  mime_type: 'image/png'
  width: number
  height: number
  content_hash: `sha256:${string}`
}

interface ImageCanvasRendererPort {
  render(input: {
    document: ImageCanvasDocument
    canvas_revision: number
    dependency_assets: VerifiedAssetInput[]
    fonts: VerifiedFontAssetInput[]
  }): Promise<RenderedImage>
}
```

默认 Adapter 可以使用 Sharp/libvips 处理栅格合成，但文字塑形、SVG 与二维码必须由明确版本、随应用打包并经过跨平台金图测试的组件负责。Domain 不依赖任何具体库名称；不能因为 Sharp 能 composite 就假定它独自解决中文排版、字体 fallback、emoji、双向文字和 SVG 安全。

正式 Renderer 必须锁定文字塑形规则、CJK 换行规则、字体 fallback 顺序、颜色解析和插值算法；macOS 与 Windows 对同一 Render Receipt 的结构结果、尺寸、图层边界和内容哈希必须满足已声明的跨平台一致性策略。

### 10.3 渲染前检查

- asset 属于项目；
- hash 正确；
- Canvas revision 与 Artboard 属于当前 Project；
- MIME 支持；
- width/height 合法；
- layer 几何参数与裁切关系合法；RasterLayer 可为封面裁切而有意越过 Artboard，但必须显式 `clip_to_artboard=true` 并记录 source crop/transform，Artboard 外像素不得进入输出；Text/Logo/QR 和 required safe-area layer 不允许用 bleed 逃避边界检查；
- layer 数量上限；
- 总像素上限；
- font 存在；
- 字体覆盖当前文字的 Unicode 字符；
- exact text requirement 已映射；
- Brand Kit 的必填文字、颜色 Token 与 Logo Slot 已满足；
- 文本、Logo、QR 没有越过 Artboard 的安全区；
- Logo/QR 使用 exact reference；
- QR 尺寸和静区足够；
- 内存预算。

### 10.4 渲染后检查

- 实际 PNG；
- width/height；
- sRGB；
- hash；
- byte size；
- exact text manifest；
- Logo source receipt；
- QR 可解码或满足验证策略；
- 输出落 CAS；
- 创建带 Artboard 和 Canvas revision receipt 的 Canvas Version。

后端先生成无损 canonical PNG 并创建 Canvas Version；JPEG/WebP/PNG 等 Deliverable 由 Export Adapter 从该 Version 编码。二维码、最终尺寸、文件解码和哈希必须针对每个最终导出文件再次验证，不能只验证 canonical PNG。

“精确文字”只由映射 `ExactTextRequirement.id` 的 TextLayer 保证，不承认底图中由生成模型画出的字，也不用 VLM/OCR 猜测代替保证。Renderer 输出带 text hash、font hash、glyph/run 位置、overflow 结果和像素边界的布局 manifest；Release Check 验证每个 required requirement 都唯一映射、未缺字、未裁切且在安全区内。

### 10.5 旧 `commitVersion(rendered_image)`

标为 legacy：

- 保留读取；
- 历史项目兼容；
- 新项目默认走 server canvas render；
- public projection 标记 `render_authority`；
- 完成迁移后停止新写入。

---

## 11. 图片资产

现有 `ImageAssetStore` 继续保留：

- PNG/JPEG/WebP 签名；
- 实际 MIME；
- dimensions；
- CAS；
- hash；
- owned path；
- verified export。

重构：

```text
ImageAssetStore
├── ImageFormatVerifier
├── ContentAddressedStore
├── ProjectAssetStore
└── ImageExportVerifier
```

但 API 行为保持。

### 11.1 字体资产

Canvas 需要正式字体资产：

```ts
type FontAsset = {
  id: string
  family: string
  style: string
  weight: number
  content_hash: string
  source: 'bundled' | 'user'
  license: { name?: string; embedding_allowed: boolean; redistribution_allowed: boolean; user_attested?: boolean }
}
```

后端记录许可和内部资产引用。字体字节不通过 public API 下发；用户导入字体时必须声明可用于本地渲染，不得因 CAS 去重而跨 owner 复用许可。

### 11.2 不可信资产验证

- 不相信扩展名、data URL MIME 或 HTTP `Content-Type`；用 magic bytes 和受限解码器确认真实格式、尺寸、帧数、颜色空间和内存上界；当前不支持动图或多页图像；
- SVG 只能进入 Logo/Template 受控路径，使用 allowlist parser；禁止 script、event handler、DTD/entity、foreignObject、外部 URL、远程字体/图像和任意 CSS，并限制字节、节点、嵌套深度、path 复杂度、viewBox 和渲染像素；
- 字体用专用 parser 验证 SFNT/WOFF 结构、表偏移、glyph 数、解压大小和字符映射；未明确支持的 collection、variable/bitmap font 不得直接交给 Renderer；
- QR payload 仅作为编码数据，服务端不跟随 URL；限制字节数和编码模式，导出校验比较 payload hash，不在日志中记录完整内容。

---

## 12. 存储布局

领域元数据使用本地 SQLite 事务存储，大文件继续使用 CAS。当前 JSON Repository 只作为受控迁移 reader，不作为新格式 writer。

```text
images/
├── metadata/image-workbench.sqlite
├── metadata/migrations/
├── cas/sha256/<digest>
├── exports/
├── trash/
└── legacy-readonly/
```

SQLite 至少保存：Project、Inspiration Board/Item、Reference、Brief Snapshot、Delivery Spec Revision、Creative Plan、Generation Round、Operation、Execution Receipt、Candidate Group、Candidate、Decision、Adoption、Visual Assessment、Quality Policy Revision、Canvas Revision、Render Receipt、Version、Delivery Set、Release Check/Risk Acceptance/Export Receipt、Brand Kit Revision、Template Revision、Campaign/Item、Asset Ownership/Grant/Provenance、Event/Outbox、Deletion Receipt。

事务原则：

- Project header 小，资产字节不进数据库；
- SQLite 连接强制 `foreign_keys=ON`、`journal_mode=WAL`、`synchronous=FULL` 和有界 `busy_timeout`；不依赖运行环境默认 pragma，关闭与备份前执行受控 checkpoint；
- 修改聚合的事务在写入前执行 revision compare-and-swap，idempotency key/request hash 由数据库唯一约束保底，不仅靠进程内 lock；
- 同一用例涉及的 Project pointer、Operation、Candidate/Version、Receipt 和 Event 在一个 SQLite transaction 内提交；
- CAS 文件先写同文件系统的临时路径、限制字节/解码像素、校验 MIME/dimensions/hash，`fsync` 文件后原子 rename，并按平台策略同步父目录；数据库事务只引用已发布 CAS 对象；
- 数据库事务失败时 CAS 对象暂时成为 orphan，由基于可达性的 GC 安全清理；
- Relay ACK 只能发生在本地数据库事务提交之后；ACK 失败只重试 ACK，绝不重新生成；
- Event 与状态变更同事务写入 outbox/event 表，提交后再唤醒订阅者；
- Event cursor 由数据库单调序列生成；发送者重启只会重放已提交 Event，前端按 event id 去重；
- 旧 project embedded JSON 只读、幂等导入；新格式只写 SQLite，不长期双写；
- Migration 使用 schema version、migration receipt 和逐项目导入状态；中断后可以继续，完成验证后才停止 legacy reader。

### 12.1 崩溃恢复与对账

启动恢复不能只扫描 `running` Operation，还必须对账：

- `committing` Operation 是否已有已提交 Candidate Group/Version；
- CAS 对象是否与数据库中的 content hash 一致；
- 已提交远端结果是否仍待 ACK；
- Canvas render/export 临时文件是否可以完成或应清理；
- Campaign item 与子 Project 是否一致；
- Event cursor 是否连续，客户端是否需要 projection reset；
- Trash/Deletion Receipt 与 Asset Grant 是否仍阻止物理删除。

### 12.2 删除、引用与 GC

- CAS 通过数据库中的 Asset Ownership、Asset Grant、Version、Brand Kit/Template revision 和 Export Receipt 做可达性分析，不依赖不可靠的手工引用计数；
- 删除 Project 先提交 Deletion Receipt 并进入可恢复 trash；仍被 Brand Kit、Template 或其他 Project grant 使用的资产不得物理删除；
- GC 只删除超过保留期、数据库不可达且通过第二次扫描确认的 CAS 对象；
- 日志、Receipt 和 Event 中不得保存图片原始 base64、Provider token 或未脱敏的内部 Prompt。

---

## 13. API

新 API 只允许一套业务 writer。现有 `/submit`、`/outputs/:outputId/save` 等路由可作为旧前端的暂时兼容 adapter，但必须调用下方同一 Application Command，不得保留第二套数据写入和任务编排。

所有会改变聚合的请求都使用类型化 Command envelope：

```ts
type CommandEnvelope<T> = {
  idempotency_key: string
  /** 创建新聚合时可省略，修改 Project/Canvas/BrandKit/Template/Campaign 时必填。 */
  base_revision?: number
  payload: T
}
```

`actor/owner` 由已验证的本地会话注入，不接受客户端自报。核心路由如下。

### 13.1 Project、Brief、Reference 与灵感

```text
GET    /api/images/projects
POST   /api/images/projects
GET    /api/images/projects/:id
POST   /api/images/projects/:id/commands/delete
GET    /api/images/deletions
POST   /api/images/deletions/:deletionReceiptId/commands/restore
POST   /api/images/quick-create
POST   /api/images/projects/:id/briefs/compile
POST   /api/images/projects/:id/briefs/:briefId/commands/apply-overrides
POST   /api/images/projects/:id/references
POST   /api/images/projects/:id/references/:referenceId/commands/update-control
POST   /api/images/projects/:id/references/:referenceId/commands/remove
GET    /api/images/projects/:id/inspiration-board
POST   /api/images/projects/:id/inspiration-board/commands/upsert-items
POST   /api/images/projects/:id/inspiration-board/items/:itemId/commands/promote-to-reference
GET    /api/images/projects/:id/library
```

Board Item 只有经过 `promote-to-reference` 并明确 role、influence、preservation 后才会进入 Provider 输入。

### 13.2 创作方向、付费任务与候选

```text
POST /api/images/projects/:id/creative-plans
GET  /api/images/projects/:id/creative-plans/:planId
POST /api/images/projects/:id/generation-rounds/estimate
POST /api/images/projects/:id/generation-rounds
GET  /api/images/projects/:id/generation-rounds/:roundId
GET  /api/images/projects/:id/candidate-groups/:groupId
POST /api/images/projects/:id/candidates/:candidateId/decisions
POST /api/images/projects/:id/candidates/:candidateId/adoptions
POST /api/images/projects/:id/candidates/:candidateId/assessments
POST /api/images/projects/:id/candidates/:candidateId/derivations
GET  /api/images/projects/:id/operations
GET  /api/images/operations/:operationId
POST /api/images/operations/:operationId/commands/cancel
GET  /api/images/projects/:id/events?after=:cursor
GET  /api/images/projects/:id/events/stream?after=:cursor
```

`generation-rounds/estimate` 返回方向数、预计付费 Operation 数、并发和可获取的用量/价格上界；真正创建 Round 时必须带上未过期的 estimate hash 与用户确认。每个 direction 返回独立 Operation，不用一个 Operation id 包装多次远程请求。`decisions` 的 payload 是 `kept | rejected`；`adoptions` 明确一个或多个 `artboard_ids`。

### 13.3 Delivery、Canvas 与导出

```text
GET  /api/images/projects/:id/delivery-spec
POST /api/images/projects/:id/delivery-spec/revisions
GET  /api/images/projects/:id/quality-policy
POST /api/images/projects/:id/quality-policy/revisions
GET  /api/images/projects/:id/versions
POST /api/images/projects/:id/artboards/:artboardId/commands/select-version
POST /api/images/projects/:id/canvases
GET  /api/images/projects/:id/canvases/:canvasId
POST /api/images/projects/:id/canvases/:canvasId/commands
GET  /api/images/projects/:id/canvases/:canvasId/revisions/:revision
POST /api/images/projects/:id/canvases/:canvasId/preflights
POST /api/images/projects/:id/canvases/:canvasId/renders
POST /api/images/projects/:id/exports
GET  /api/images/projects/:id/delivery-sets/:deliverySetId
GET  /api/images/projects/:id/export-receipts/:receiptId
```

Canvas 没有“PUT 整份文档”的并行 writer；新建后只能通过 Command 产生 revision。`select-version` 只能选择属于同 Project/Artboard 的已验证 Version，并原子改 working current pointer，不修改历史 Version 或伪造新 Delivery Set。Preflight 只检查指定已持久化 revision；Render/Export 是异步 Operation，必须返回它们实际锁定的 Canvas、Delivery Spec、Brand Kit 和 Template revision。单 Artboard 导出可产生独立 Export Receipt 但不更新 `latest_delivery_set_id`；完整交付请求必须覆盖所有 required Artboard，成功后才创建 Delivery Set。

### 13.4 Brand Kit、Template 与资产授权

```text
GET    /api/images/brand-kits
POST   /api/images/brand-kits
GET    /api/images/brand-kits/:brandKitId
POST   /api/images/brand-kits/:brandKitId/revisions
POST   /api/images/brand-kits/:brandKitId/commands/delete
GET    /api/images/templates
POST   /api/images/templates
GET    /api/images/templates/:templateId
POST   /api/images/templates/:templateId/revisions
POST   /api/images/templates/:templateId/commands/delete
POST   /api/images/assets/:assetId/grants
POST   /api/images/assets/:assetId/grants/:grantId/commands/revoke
```

创建 revision 只改变 head 的 current pointer，不改写旧 Project/Canvas/Version 已锁定的 revision。Template/Brand Kit 的应用仍使用 13.3 节唯一 Canvas Command 端点中的 `apply_template`/`apply_brand_kit`，不新增特例 writer。删除 head 只进入 trash；被历史成品引用的 revision 与 Asset 按可达性继续保留。

### 13.5 Campaign

```text
POST /api/images/campaigns
GET  /api/images/campaigns/:campaignId
POST /api/images/campaigns/:campaignId/commands/replace-items
POST /api/images/campaigns/:campaignId/estimate
POST /api/images/campaigns/:campaignId/commands/confirm
POST /api/images/campaigns/:campaignId/commands/start
POST /api/images/campaigns/:campaignId/commands/cancel
POST /api/images/campaigns/:campaignId/items/:itemId/commands/retry
```

Campaign `start` 只接受与当前 revision 匹配的 estimate hash 和确认回执。Item retry 创建新尝试并再次进行成本确认，不改写原 Operation。

### 13.6 返回、冲突和公开边界

- 同步 Command 成功返回新 aggregate revision 和 event cursor；异步请求用 `202 Accepted` 返回 Operation/Generation Round 安全投影和 event cursor；
- 相同幂等键与相同请求 hash 返回原结果；同键不同 hash 返回 `409 idempotency_conflict`；过期 `base_revision` 返回 `409 revision_conflict` 和最新安全投影；
- 付费提交前的能力不匹配返回 `422 capability_gap`；内容策略拒绝返回 `422 policy_blocked` 或对应终态 Operation；两者都不得伪装成 `500`；
- 请求体、响应和 Event 都由共享 schema 验证，不存在持久化 `unknown`、未约束 `Record<string, unknown>` 或前端自由拼接 Prompt；
- 保存到用户目录时使用桌面端授予的不透明 destination grant 或受控导出会话，public API 不接收也不返回本地绝对路径。

public API 不返回：

- provider key；
- internal prompt；
-本地绝对路径；
- Relay token；
- result grant；
-完整 provider raw response。

`GET /library` 只返回当前 Project 有权读取的资产、安全元数据和派生关系；它不是文件路径或默认跨项目搜索接口。Brand Kit、Template、Asset Grant 的读写也必须按 `MediaOwner` 过滤。

`POST /quick-create` 是 `POST /projects` 的快捷应用命令，不引入第二套项目创建逻辑；它在同一建项事务中保存上传参考图，返回正式 Project 与初始 Operation。

### 13.7 Electron Main 与本地安全桥

本合同固定桌面信任边界：

```text
Untrusted Renderer
→ Electron Main typed IPC allowlist
→ Local Sidecar authenticated command/query
→ Gateway（仅需要远程能力时）
```

必须经 Electron Main typed IPC 的动作包括：

- Project/Brief/Reference/Delivery Spec/Canvas/Brand Kit/Template/Campaign 的全部写命令；
- Generate/Edit/Inpaint、Qwen、Campaign start/retry 等付费或远程调用及其成本确认；
- Candidate adopt/reject/derive、风险接受、发布、导出、删除/恢复和 Grant 创建/撤销；
- 本地文件选择、目录选择、Reference/Logo/字体/SVG 导入、打开导出和保存到用户目录；
- Operation cancel/retry、`outcome_unknown` 决策及任何改变 current pointer 的动作。

实现规则：

- 优先由 Main 直接调用 Sidecar；Renderer 不获得会话级可复用 Sidecar secret、Gateway/Relay token、任意 filesystem path 或通用 HTTP 写能力。文件源/目标只能由系统对话框或 Main 持久化授权产生，Renderer 只持 opaque grant id；Sidecar 从可信会话注入 actor/owner，忽略或拒绝请求体自报身份；
- 普通安全投影可经受限 loopback query API 读取；原参考图、Candidate、Canvas/Version 像素、字体/Logo/QR、Provider 输入输出和导出属于敏感媒体，必须由 Main 转发或签发短期 capability URL。capability 固定 audience、owner、project/asset、path、method、operation、expiry、nonce 和最大 Range，单次消费或显式可撤销；
- Sidecar 必须校验 Host/Origin、会话/capability、method/path/body hash、过期与 nonce，防 DNS rebinding、跨 Origin 写入、重放和 capability 泄漏；CORS/loopback 不能作为授权。错误与日志不得包含绝对路径、token、internal Prompt 或私有媒体 URL；
- 同步 IPC 返回 typed public projection；长任务只返回 Operation id/event cursor。Main/Preload 不自行维护 Project/Candidate/Canvas 状态，也不在进程重启后伪造成功；
- `ts/desktop/electron/ipc/channels.ts`、`preload.ts`、Main handler、`services/imageActions.ts`、共享 DTO 和 Sidecar auth/capability 服务是本合同必改文件。每个 channel 使用显式输入/输出 schema 与 allowlist，不提供 `invoke(url, body)`、任意 channel 或任意路径逃生口；
- contract tests 至少覆盖未授权 Renderer、伪造 owner/actor、任意路径、错误 method/path、过期/重放 capability、DNS rebinding Host、敏感 Range 读取、付费确认、风险接受、destination grant 和 IPC/Sidecar schema 漂移。

---

## 14. 当前代码改动清单

### 14.1 Composition Root

修改：

- `ts/src/server/index.ts`
- `ts/src/server/router.ts`

新增：

- `ts/src/server/media/runtime/createMediaRuntime.ts`
- `image/application/imageWorkbenchFacade.ts`

### 14.2 Shared Kernel

从：

- `imageWorkbenchRepository.ts`

抽取：

- Operation 状态机与幂等记录；
- 事务存储接口和短临界区 lock；
- Event Journal / Outbox / cursor；
- Recovery Supervisor 与崩溃注入钩子；
- CAS 完整性、可达性 GC 基础能力；
- 统一的资源、并发、budget 和诊断上限。

图片/视频的 schema、迁移、业务表和读写仍分开。Kernel 不知道 Candidate、Canvas、Brand Kit 等图片概念。

Shared Kernel 的首次抽取由视频文档第 13.0 节第 1 关或一个先行的单一 foundation worktree 完成并合入 main；该底座必须已经通过视频 repository characteristic/崩溃恢复测试。图片 15.1A 只把 `imageWorkbenchRepository.ts` 中同义技术原语迁移到现有 Kernel，并运行图片兼容测试，不修改 `videoWorkbenchRepository.ts`。如果 main 尚无该兼容底座，图片 15.1 不得自行复制或跨领域补写，先完成并合入共享底座关卡。

### 14.3 Service

将 `imageWorkbenchService.ts` 改为仅做兼容和组合的 façade，委托五个按用例/事务边界组织的 Application：

- `ImageProjectApplication`：建项、Brief、Reference、Inspiration、Brand/Template 绑定；
- `ImageGenerationApplication`：Creative Plan、Generation Round、Operation、Candidate、Decision/Adoption/Derivation；
- `ImageCanvasApplication`：Canvas Command、revision、Preflight 与 Render；
- `ImageDeliveryApplication`：Delivery Spec、Delivery Set、Export、Library、Campaign 交付编排；
- `ImageRecoveryApplication`：迁移、启动对账、Relay ACK、事件修复、trash/GC。

Domain 仍按概念分模型与纯规则，但不为每个名词创建一个只做 CRUD 的 Service。

### 14.4 Qwen

修改：

- `imageReasoning.ts`
- `gateway/providerRegistry.ts`
- `gateway/app.ts`
- `gateway/visionBridge.ts`

新增：

- `qwenImageUnderstandingAdapter.ts`
- `qwenImageQualityAdapter.ts`

删除图片 MiMo 路径。

Qwen Adapter 只实现 shared `VisualEvidence` capability 下的 `image_understanding`/`image_visual_assessment` application role，并通过 Gateway 独立 `/v1/image/reasoning` 调用。目录用 `image_advice` workload 把它绑定到独立 capacity/quota/credential，不覆盖 MiMo 的 `media_reasoning` 或 `shared_visual_evidence`。`providerContracts.ts` 如需修改，只做与现有 Agent/Video/ImageGeneration 向后兼容的 descriptor/receipt 加法。

### 14.5 Relay

保留 `relay/app.ts` 的核心协议：

- owner；
- idempotency；
- queue；
- persistence；
- unknown；
- result grant；
- ack。

在 Image Module 中通过 `ImageGenerationPort` 调用，不直接耦合 HTTP 细节。

具体生产路径固定为 `ImageGenerationPort → Image Relay /v1/images/tasks`。Sidecar 只配置公开 Relay base URL，并携带 Electron Main 注入的短期安装 bearer；它不持有 introspection service token 或 Provider Key。Gateway 不保留 `/v1/images/tasks` 代理。Relay 的提交、按 idempotency 查询、poll、result grant、cancel、ACK、owner 内省和 production contract test 必须与第 5.4 节一致。

### 14.6 Canvas

新增：

- Canvas schema；
- Canvas Application use case；
- Renderer Port；
- 可复现文字布局/字形整形和 CJK 换行；
- 受控的 raster composite（可使用 Sharp/libvips）与 SVG renderer；
- font asset；
- exact text verifier；
- QR verifier；
- canvas render operation 和 immutable render receipt；
- macOS arm64/Windows x64 字体、图形和颜色跨平台 golden fixtures。

### 14.7 Delivery、Brand 与复用

新增：

- `imageDeliverySpec.ts`：交付意图、多 Artboard、不可变 revision、输出格式和安全区；
- `imageBrandKit.ts`：本地 owner 范围的 head 与不可变 revision，保存 Logo、字体、色彩 Token 和必填文案；
- `imageTemplate.ts`：有 owner、revision 和 Asset 边界的 Slot 化 Canvas 模板；
- Canvas Command 在 SQLite transaction 中完成 revision compare-and-swap、撤销/恢复与 Event 提交；
- `canvasPreflight.ts`：字体覆盖、必填内容、安全区、QR、尺寸、像素和内存检查；
- `projectAssetLibrary.ts`、`imageAssetProvenance.ts`：项目内复用、所有权、Asset Grant、来源和派生关系；
- 图片工作台前端的 Intake、Reference Tray、Candidate Review、Canvas、Delivery 与 Operation Center；前端只能调用 public API 和 Command。

不得新增：

- 全局可写媒体目录；
- 第二套 Asset Store；
- 团队权限、云同步或素材市场的半成品实现；
- 由前端直接提交最终 PNG 作为新正式路径。

### 14.8 Quality、创作方向与高频旅程

新增：

- `imageCreativePlan.ts`、`imageGenerationRound.ts`：把同一 Brief 编排为可解释的候选方向，且每个方向对应独立付费 Operation；
- `imageQualityPolicy.ts`、`imageVisualAssessment.ts`、`imageReleaseCheck.ts`：把 Qwen 非阻断建议、确定性技术检查、用户风险确认与修复动作分开；
- `imageInspirationBoard.ts`：灵感图和备注与正式 Reference 分离；
- `imageCampaign.ts`：经过 estimate/confirm/budget 后将共享 Brief、Brand Kit 与变量编排为多个普通项目；
- `qrCodeRenderer.ts`：服务端二维码编码、静区设置和最终像素解码验证；
- `svgAssetVerifier.ts`：受控 SVG Logo/模板资产的安全验证与矢量渲染；
- `base_candidate_id`、`derived_from_candidate_id`：未采纳候选可直接派生，且谱系可追溯；
- Quick Create：一键创建后台 Project 和初始候选，不用先完成完整 Brief。

不得新增：

- 模型自动采纳、自动发布或自动删除候选；
- 把 Qwen 分数当成用户审美结论；
- 将 Inspiration Board 中的所有图片默认发送给 Provider；
- 给 Campaign 复制一套项目、候选、版本、Canvas 或 Asset Store。

### 14.9 存储、迁移与生产边界

新增：

- `sqliteImageMetadataStore.ts`、`imageMetadataMigrations.ts`：业务表、事务、索引、外键、outbox 和 schema migration；
- `legacyImageProjectReader.ts`：旧 JSON 的只读、幂等导入和 migration receipt；
- 启动对账、CAS orphan 清理、Relay ACK 重试、trash 和两次确认 GC；
- Provider 上传副本的元数据清理、日志脱敏、结果保留期和 refusal receipt；
- 上传/像素/图层/SVG/字体/QR/Campaign/并发/budget 的集中限制配置与拒绝码。

迁移期不长期双写 JSON 和 SQLite，也不允许旧 Repository 与新 API 同时拥有正式 writer 资格。

### 14.10 Electron Main 安全桥

修改：

- `ts/desktop/electron/ipc/channels.ts`；
- `ts/desktop/electron/preload.ts`；
- `ts/desktop/electron/main.ts`；
- `ts/desktop/electron/services/imageActions.ts`；
- Sidecar 本地会话/capability 服务与共享 IPC DTO。

按第 13.7 节覆盖全部写动作、付费确认、路径/grant、敏感媒体读取、风险接受和最终导出。旧的少量 Image IPC 只能扩展为完整 typed broker，不能保留一个 Renderer 可绕开的通用 loopback 写入口。生产调用链、IPC/API schema 和拒绝路径都要有 contract test。

### 14.11 正式测试入口、根文档与服务器发布

- 视频第 1 关/共享 foundation 先在 `ts/package.json` 建立正式一方 `test` script 与共享 runner；图片同步该集成基线后只增加可单独运行的 Image Workbench、API/IPC contract 与 integration 分组，并保持全局 `test` 包含它们。日常测试只用可提交 fixture/fake，不依赖真实 Provider；
- 真实 GPT Image/Seedream/Qwen smoke 与日常 suite 分离，只在受控账户、预算和明确环境开关下运行，验证 schema、幂等/usage receipt、拒绝、超时和日志脱敏，不把它当领域测试替代品；
- 15.0 先为当前 Repository/Service/API/Gateway/Relay/IPC 路径建立 characteristic tests；15.1 以后每个阶段在其上补 Domain unit、Port contract、SQLite/CAS crash/recovery、API/IPC、Renderer golden 与真实生产路径测试；
- 15.2E/15.4D 涉及远程实现时同步更新 `README.md`、`docs/重构/模型与远程能力平台.md`、`docs/operations/production-servers.md`、对应 env example/validator 和部署 smoke，使文档与第 5.4 节一致；
- 图片不增加物理服务器，但把原图片 Relay 正式收口为独立 `image-relay` service 和 `/image-generation/` 公网前缀。只有代码确实修改 Gateway/Image Relay 时才从已提交 revision 发布镜像；部署前只读盘点，部署后验证真实 Image Relay 直连链、Gateway 私网内省、Qwen、容器 revision、健康、capacity/quota、幂等查询、ACK 和日志。

---

## 15. 施工顺序与验证证据

本改造不按“先写完所有 Domain，再一次接 UI”推进，而是按下列纵向切片施工。每个阶段结束时，本阶段的正式 API、Application、存储、Event、恢复和前端投影必须一起闭环，不留只有 Schema 或只有页面的半成品。

### 15.0 阶段零：现状特征测试与施工底座

本阶段只建立可重复证据，不改变生产 writer、路由、远程模型、项目数据或用户行为：

1. **15.0A 正式测试入口：** 先确认视频第 1 关/共享 foundation 的全局 test runner 已进入当前集成基线，再由本阶段单独拥有 `ts/package.json`，增加第 14.11 节的图片 test 分组并纳入全局 `test`；区分可复现日常 suite 与显式真实 Provider smoke，保证 CI/本地失败码可靠；
2. **15.0B 当前行为特征：** 固定旧 Image Project 导入/读取、owner、writer fence/CAS、Operation/Event cursor、submit/poll/cancel/unknown、Candidate/Version/current pointer、删除/恢复、Gateway → Relay ACK 和中断提交行为；测试描述当前事实，不把已知缺陷写成新架构规范；
3. **15.0C API/IPC 合同：** 为当前 image API、Gateway/Relay DTO、现有 Image IPC 建立 schema harness 和未授权/伪造 owner/路径拒绝测试，列出第 13.7 节尚缺 channel 作为后续明确差距；
4. **15.0D Fixture 与进程纪律：** 提交最小合法/损坏图片、旧项目、Operation/Event、迁移和 hash fixture；测试使用独立临时数据目录/端口，并自动终止 Sidecar、Gateway/Relay fake、浏览器和渲染辅助进程。

退出证据：一条正式 `test` 命令可在干净环境稳定运行；当前关键生产链的 characteristic/API/IPC tests 通过；故意破坏 fixture 能使 suite 失败；运行前后无遗留监听端口或临时进程。没有这些证据不得开始 15.1。

### 15.1 阶段一：事务元数据与恢复底座

子切片按以下顺序执行；15.1D 是唯一生产 writer 切换点，不得在更早子切片中开始双写：

1. **15.1A Shared Kernel 采用、Schema 与事务仓储：** 确认视频第 1 关/共享 foundation 已合入当前 main，从 `imageWorkbenchRepository.ts` 采用现有 Operation/Event/CAS/recovery 原语，再建立图片 SQLite schema/migration、外键、索引、revision compare-and-swap、idempotency 唯一约束、Event/Outbox 和 Asset Ownership/Grant；新存储此时可以在测试中运行，但不接管生产 writer，也不修改 Video；
2. **15.1B 旧数据导入：** 实现旧 JSON 只读、幂等导入和 migration receipt，用固定 fixture 验证 Project、Operation、Candidate、Version、Asset hash 和历史 current pointer 不丢失；
3. **15.1C 提交与恢复：** 在新存储上跑通 CAS publish → DB transaction → Event/Outbox → Relay ACK，实现启动对账、ACK 重试、CAS orphan 和事务崩溃注入测试；
4. **15.1D 生产切换：** 对比新旧 public projection，将正式 writer 一次性切到 SQLite，把旧 Repository 降为仅供导入的只读 reader，复查正式运行时只剩一个 writer。

退出证据：迁移前后安全投影对比、重复导入无副作用、外键/唯一约束测试、在 CAS publish 后/DB commit 前、DB commit 后/ACK 前两个崩溃点的自动恢复测试。

### 15.2 阶段二：付费生成、候选与多画板采纳

1. **15.2A 输入合同：** 收口 Brief Snapshot、Reference role/influence/preservation/priority、Delivery Spec 尺寸权威和提交前 capability gap；
2. **15.2B 付费 Operation：** 实现 Provider Policy、判别式 Operation Result、Execution Receipt、幂等、cost state、policy refusal、cancel/late result 和 unknown outcome；
3. **15.2C 方向与候选：** 引入 Creative Plan、estimate/confirm、Generation Round 和 Candidate Group，保证一个 Direction = 一个付费 Operation = 一个 Candidate Group；
4. **15.2D 用户决定：** 引入 Candidate Decision、Derivation、带显式 placement 的多 Artboard Adoption；采纳事务只创建引用 Candidate 原资产的初始 Canvas revision/working Version 并更新 `current_versions_by_artboard`，不在本子切片实现后续 Canvas 编辑 Command 或 Renderer；Delivery Set 仍留在成品交付阶段创建；
5. **15.2E 兼容切换：** 将旧 `/submit` 映射到单方向 Generation Round，保持 GPT Image 2、Seedream 4.5 真实生产调用，证明旧路由没有第二套付费任务逻辑。

退出证据：无参考/多参考生成、能力不匹配提交前拦截、部分候选、未知结果不重复付费、相同幂等键重放、候选到多 Artboard 原子采纳和不自动采纳的 API/集成测试。

### 15.3 阶段三：可复现 Canvas 与成品交付

1. **15.3A Canvas 事实：** 完成强类型 Canvas Command/revision、乐观并发、撤销/恢复、Delivery Spec sync、Template/Brand apply 和多 Artboard 独立排版；
2. **15.3B 确定性 Renderer：** 锁定字体资产、字形整形/CJK 换行、图形合成、颜色/插值、SVG 限制和 QR 编码/解码依赖，让指定 revision 成为 Renderer 唯一文档输入；
3. **15.3C 版本与发布检查：** 完成 Preflight、Render Receipt、immutable Version、exact text manifest、Logo/QR/SVG/字体/尺寸/hash Release Check 和风险接受回执；
4. **15.3D 导出交付：** 完成 canonical PNG 到 PNG/JPEG/WebP 的格式转换、每个最终文件重新验证、单 Artboard Export Receipt 与完整 Delivery Set；
5. **15.3E 正式路径切换：** 新写入停止接受“前端 PNG 直接成为正式 Version”，过期渲染结果仅进历史不覆盖用户新事实。

退出证据：过期 Canvas revision 冲突、指定 revision 重渲染、macOS arm64/Windows x64 golden image、CJK/缺失字形、Logo 锁定源资产与允许几何转换、SVG 恶意样例、QR 最终文件解码、每种输出格式尺寸/hash 和渲染中断恢复测试。

### 15.4 阶段四：可解释的智能辅助

1. **15.4A Adapter 与安全输出：** 实现 Qwen3-VL-Flash Understanding/Visual Assessment Adapter、严格输出 schema、长度上限、receipt/confidence、脱敏和超时/解析失败语义；
2. **15.4B Brief/Plan 建议：** Qwen 只补充可见事实、风险和 Creative Plan 建议，用户原话、override、confirmed facts 和确定性编译始终优先；
3. **15.4C 视觉评估/修复建议：** 产生非阻断 ImageVisualAssessment 和 Repair Action，不修改 Candidate/Version/Project pointer，不取代确定性 Release Check；
4. **15.4D 模型切换：** 移除图片新理解/评估路径的 MiMo，保留历史 Receipt 只读能力，验证 Qwen 不可用时不阻断确定性 Canvas/导出。

退出证据：用户事实不被模型覆盖、Qwen 评估无法改变 Candidate/Version、Qwen 失败的可降级路径、拒绝脱敏和 public projection 不泄露 internal Prompt 的合同测试。

### 15.5 阶段五：人的完整工作流

1. **15.5A 建项与输入体验：** 完成 Quick Create、Creative Intake、Inspiration Board 与 promote-to-reference、Reference Tray 和 Delivery Spec，让用户可以从一句话或完整 Brief 开始；
2. **15.5B 创作与交付体验：** 完成 Creative Plan/成本确认、Candidate Review、Derive/Inpaint/Adopt、Canvas、Delivery 和 Operation Center，全部使用 public API/Event；
3. **15.5C 复用体验：** 完成 Project Library 和带 revision 的 Brand Kit/Template 创建、浏览、删除、资产授权及其前端体验；“应用”只调用 15.3A 已完成的 `apply_template`/`apply_brand_kit` Command，不在本阶段复制第二个 apply writer；
4. **15.5D 批量体验：** Campaign 只在 estimate、budget 和用户确认后调度显式 Item/普通 Project，完成逐项取消、失败隔离和显式新付费尝试；
5. **15.5E 最终回归：** 前端只保存选中、拖动草稿和面板状态，重启后从 public projection + event cursor 恢复业务事实；跑通第 17.4/17.5 节全部场景并回归第 18 节所有条目。

退出证据：第 17.4 节完整用户旅程、第 17.5 节全部当前范围场景、中途关闭应用后恢复、事件断点重连、批量成本确认、资产 owner 越权拒绝和删除/GC 的 E2E 证据。

### 15.6 通用验证门槛

每个阶段都必须同时提供：

| 证据层 | 必须证明的事 |
| --- | --- |
| Schema / Type | 请求、Command、Event、Receipt 和 public projection 没有未定义持久化字段 |
| Domain / Unit | 不变量、状态机、幂等、revision 冲突和所有权规则成立 |
| Transaction / Crash | 事务中断、重启对账、outbox、Relay ACK、CAS orphan 和迁移可恢复 |
| Adapter / Contract | Provider、Relay、Qwen、Renderer 的真实协议、拒绝、超时、部分结果和资源上限被覆盖 |
| Production path | 从真实 API 经 Application、DB、CAS、Adapter 到 public projection，不是仅测孤立类 |
| Product E2E | 人能完成场景，看到进度/冲突/费用/风险，且得到经验证的最终文件 |

单元测试通过、TypeScript 通过、UI 出现或某个新文件存在，均不能单独作为完成证据。每阶段结束后必须检查正式运行时只有一个 writer、没有长驻的旧任务轮询器，并停止施工中启动的临时服务和测试进程。

---

## 16. 开源代码参考

### 16.1 InvokeAI

仓库：

- `https://github.com/invoke-ai/InvokeAI`

重点参考目录：

- `invokeai/app/invocations/`
  - 将耗时操作表达为明确 Invocation；
- `invokeai/app/services/session_processor/`
  - 图/任务执行与状态；
- `invokeai/app/services/images/`
  - 图片元数据和存储；
- `invokeai/app/api/routers/`
  - API 与服务分离；
- Canvas、Boards、Queue 模块。

对应本项目：

| InvokeAI 概念 | BilliardBuddy |
| --- | --- |
| Invocation | ImageOperation |
| Queue Item | Persisted Operation |
| Output Image | Candidate |
| Staging/Accept | Candidate Adopt |
| Board/Gallery | Project Candidate/Version |
| Canvas | ImageCanvasDocument |

不引入：

- 本地模型管理；
- GPU；
- Diffusion node runtime；
- Python 服务。

### 16.2 ComfyUI

仓库：

- `https://github.com/Comfy-Org/ComfyUI`

重点参考：

- `execution.py`
  - 图执行、依赖、缓存、Job 生命周期；
- `server.py`
  - 提交、状态和结果；
- `nodes.py`
  - 节点能力注册；
- Workflow JSON：
  - `https://docs.comfy.org/specs/workflow_json`

对应本项目：

- 内部可重放 Generation Recipe；
- versioned schema；
- operation job；
- provider adapter；
- input/output asset dependency。

不暴露任意节点图给普通用户。

### 16.3 Krita AI Diffusion

仓库：

- `https://github.com/Acly/krita-ai-diffusion`

重点参考：

- `ai_diffusion/jobs.py`
  - `JobState`
  - `JobKind`
  - `JobParams`
  - `JobQueue`
  - result used/discarded；
- `ai_diffusion/workflow.py`
  - 区域、蒙版和生成配方；
- `ai_diffusion/model.py`
  - 文档状态与操作；
- `ai_diffusion/control.py`
  - 参考/控制图层。

对应：

- ImageOperation；
- Candidate 使用/丢弃；
- Mask；
- Region；
- Canvas Document。

### 16.4 不直接复制代码

注意许可证与技术栈：

- InvokeAI/ComfyUI/Krita 插件的本地模型执行不适合当前云模型架构；
- 参考领域模型和任务语义；
- 不引入其 GPU/runtime；
- 第三方代码若复制，必须单独审查许可证。

---

## 17. 必补功能板块与架构归属

本节是产品范围与维护边界，不是“再加几个页面”的清单。每个板块只有一个领域事实源，并通过 Application Command 改变事实；API 与前端不得承担业务规则，Kernel 不得吸收图片概念。

### 17.1 功能板块总览

| 功能板块 | 用户完成的事 | 领域事实源 | 主要 Application | Infrastructure / 维护边界 |
| --- | --- | --- | --- | --- |
| Creative Intake / Brief | 说明用途、文案、必须保留与可变化内容 | `ImageBrief`、`ImageDeliverySpecRevision` | `ImageProjectApplication` | Qwen 只产生建议；确定性编译和用户覆盖不依赖模型 |
| Quick Create / Inspiration | 快速出图，或先整理灵感再指定哪些图真正参与生成 | `ImageProject`、`ImageInspirationBoard` | `ImageProjectApplication` | Quick Create 复用正式建项链路；Board Item 需显式 promote |
| Reference Control | 为主体、风格、构图、Logo、二维码指定用途与控制 | `ImageReference` 的 role、influence、preservation、priority | `ImageProjectApplication` | AssetStore 校验字节；Adapter 翻译模型能力；付费前报 capability gap |
| Generate / Edit | 提交、取消、恢复一次可追溯的生成或局部修改 | `ImageOperation`、`ProviderExecutionReceipt` | `ImageGenerationApplication` | Relay/Gateway 只实现 Port；Kernel 提供幂等、事件、budget 和恢复 |
| Candidate Review / Creative Plan | 比较方向，保留/舍弃、评估、派生与多画板采纳 | `ImageGenerationRound`、`ImageCandidateGroup`、`ImageCandidateDecision/Adoption`、`ImageVisualAssessment` | `ImageGenerationApplication` | 一方向一付费 Operation；Qwen 只建议，不自动采纳或删图 |
| Brand / Template | 复用 Logo、字体、颜色和固定文案 | `ImageBrandKitRevision`、`ImageTemplateRevision` | `ImageProjectApplication` | Font Resolver、Asset Provenance/Grant；按本地 owner 隔离 |
| Canvas / Artboards | 将候选组织成横版、竖版或多规格设计 | `ImageCanvasDocument`、`ImageCanvasRevision` | `ImageCanvasApplication` | 前端只发 Command；Renderer 以持久化 revision 和锁定依赖为唯一输入 |
| Delivery / Export | 预检、渲染、导出并确认真正可用的文件 | `ImageReleaseCheckResult`、`ImageRenderReceipt`、`ImageVersion`、`ImageDeliverySet`、Export Receipt | `ImageCanvasApplication`、`ImageDeliveryApplication` | 确定性文字布局、图形合成、QR 编解码、SVG/字体/尺寸/hash 校验 |
| Project Library / Reuse | 找回、收藏、克隆或复用已有资产与作品 | Asset Ownership / Grant / Provenance / Derivation | `ImageDeliveryApplication` | 复用 CAS 但不绕过 owner；不创建第二套图库或文件 writer |
| Campaign / Batch | 用同一品牌、Brief 和变量批量制作内容 | `ImageCampaign` 及显式 Item/estimate/confirmation | `ImageDeliveryApplication` | 只调度普通 Project；成本/budget 确认；逐项失败隔离 |
| Operation Center | 看见队列、进度、未知结果和恢复动作 | `ImageOperation`、Event/Outbox cursor | `ImageRecoveryApplication` | Kernel EventJournal/RecoverySupervisor；前端断点订阅并支持 projection reset |

### 17.2 架构板块图

```text
Image Workbench UI
├── Quick Create / Inspiration Board / Creative Intake / Reference Tray
├── Candidate Review / Canvas Editor / Delivery Panel / Batch Production
├── Operation Center
└── only sends typed Commands and reads public projections
                     ↓
Image API + ImageWorkbenchFacade
                     ↓
Image Application
├── ImageProjectApplication
├── ImageGenerationApplication
├── ImageCanvasApplication
├── ImageDeliveryApplication
├── ImageRecoveryApplication
└── validates use cases and owns transaction boundaries
                     ↓
Image Domain
├── Project / InspirationBoard / Brief / DeliverySpecRevision / Reference / CreativePlan / GenerationRound
├── Operation / Receipt / CandidateGroup / Decision / Adoption / VisualAssessment / QualityPolicy
├── BrandKitRevision / TemplateRevision / CanvasRevision / RenderReceipt / Version / DeliverySet / Provenance
└── contains invariants; imports no HTTP, provider or file API
                     ↑ implements ports
Image Infrastructure
├── SQLite Metadata Store / Legacy Reader / CAS / Font Resolver / SVG Verifier / QR Renderer / Preflight / Renderer
├── Qwen Understanding & Quality Adapters / Relay Generation Adapter
└── cannot decide user adoption, brand rules or canvas semantics
                     ↑
Shared Media Kernel
└── transaction contract, operation state, idempotency, outbox/journal, lock, recovery, diagnostics, limits/budget
```

### 17.3 维护成本控制规则

1. **一类事实一个 owner。** Brief、Reference、Candidate、Canvas、Version、Brand Kit 与 Delivery Spec 有各自明确的表、不变量和写用例；它们可以共享同一 SQLite transaction，但不得重新嵌回巨型 Project JSON、`ImageWorkbenchService` 或 Renderer state。
2. **所有可写行为都是 Command。** UI 不能提交完整项目 JSON 覆盖服务端状态；Command 带 revision 和幂等键，actor 由会话注入，便于冲突处理、审计和恢复。
3. **Provider 差异停在 Adapter。** Domain 只声明“风格/构图/主体/局部修改等需要何种控制”，Adapter 回报某模型是否支持；Policy 和 Receipt 记录实际选择，避免日后增加模型时改动 Canvas 或 Candidate。
4. **智能建议可解释且不可越权。** Creative Plan、`ImageVisualAssessment` 与 Repair Loop 都返回方向、风险和下一步 Command；它们不自动采纳、发布、删除候选或改写用户事实。
5. **预览和交付分离。** Web/桌面预览可以快且可丢弃；后端正式渲染、Preflight、哈希校验和 Export Receipt 才构成版本交付，避免平台差异造成成品不一致。
6. **重用有边界。** Brand Kit、Template、Inspiration Board 与 Project Library 复用的是受控资产和 Canvas slot，不复用私有 Prompt、Provider Token 或不明来源文件；不提前实现团队协作、云盘、素材市场。
7. **批量只编排既有项目。** Campaign 不复制 Project/Canvas/Candidate/Version 的业务模型；它只在 estimate、budget 和确认后创建并跟踪多个标准项目，避免批量路径与单项目路径分叉。
8. **扩展先加板块，不改核心。** 未来支持团队审核、审批流、更多模型、印刷色彩或素材库时，应新增对应 Domain/Application/Port；不能把功能开关堆进 Project、Facade 或公共 Media Kernel。
9. **正式路径只有一个 writer。** 兼容 API、Quick Create、Campaign 和恢复都调用同一 Application/transaction；不长期双写 JSON/SQLite，不保留整份 Canvas PUT。
10. **历史成品锁定全部依赖。** Version/Delivery Set 锁定 Canvas、Delivery Spec、Brand Kit、Template revision、renderer 版本和 Asset/Font hash，新修改不能漂移旧成品。

### 17.4 必须可走通的用户旅程

以下是前端、API、后端和渲染共同验收的产品闭环；只存在 Schema 或 Service 不算完成。

```text
选择“产品宣传图”与横版/竖版交付规格
→ 放入产品、风格、Logo 参考并设置保留规则
→ 确认 Brief 的卖点、固定文案与可变化项
→ 查看 Creative Plan 方向、付费 Operation 数和成本上界并确认生成
→ 得到按方向组织的候选；保留一张并基于它做区域修改
→ 采纳候选到两个 Artboard
→ 应用 Brand Kit / Template，分别调整文字与安全区
→ Preflight 检查字体、必填文案、Logo、QR、尺寸与哈希
→ 后端渲染各 Artboard，创建不可变版本与导出回执
→ 在 Project Library 中复用该品牌资产或克隆为下一次活动
```

### 17.5 人的使用场景覆盖

| 场景 | 用户实际动作 | 走的功能板块 | 成品质量如何兜底 |
| --- | --- | --- | --- |
| 30 秒快速封面 | 输入一句话、选横竖版、可选拖入一张图 | Quick Create → Candidate Review | 后台仍创建正式 Project；用户之后可补 Brief、局部修改或进入 Canvas |
| 灵感探索 | 收集多张风格/构图/竞品图，圈定真正要用的参考 | Inspiration Board → Reference Control → Creative Plan | 未选中的灵感不上传给模型；主体/风格/构图的 role、influence、preservation 可见 |
| 精准产品宣传图 | 上传产品、Logo，填写卖点与品牌要求 | Brief → Candidate → Brand Kit → Canvas | 模型只做产品场景与底图；字体、Logo、价格、日期、二维码走后端确定性渲染和 Preflight |
| 活动海报 / 社交矩阵 | 同一活动做横版、竖版、方图 | Delivery Spec → 多 Artboard → Template → Export | 安全区、必填文字和各自版式独立；不能仅拉伸一张底图冒充多尺寸交付 |
| 修图与局部修改 | 保留人物或产品，只改背景、局部元素或光线 | Candidate/Version → Edit 或 Inpaint → Derive | `base_candidate_id` / `base_version_id` 与蒙版保留谱系；风险检查给出修复建议而非自动覆盖 |
| 连续品牌内容 | 用多个 SKU、标题、优惠信息制作一批素材 | Campaign → 普通 Project → Template / Brand Kit | 每项仍有独立任务、候选、版本和失败状态；一项出错不污染其他成品 |

不在当前范围：多人实时协同、外部审稿链接、云端素材市场、通用照片修图和印刷 CMYK 工作流。它们应在真实需求出现时新增独立 Domain/Application/Port，不把不确定的未来需求提前塞进图片项目。

## 18. 完成判定

以下是交付门槛，必须全部完成并提供第 15.6 节对应证据：

1. `ImageWorkbenchService` 只是兼容 façade，五个 Application 进入 `MediaRuntime`；Agent 和 Video 未进入图片领域状态。
2. 正式元数据只写 SQLite；旧 JSON 只读导入可重入，不存在长期双写或第二个业务 writer。
3. Project、Operation、Candidate/Version/Receipt、pointer 和 Event/Outbox 在用例事务中一致提交；CAS publish 失败、DB commit 失败和 ACK 失败都可对账恢复。
4. GPT Image 2 和 Seedream 4.5 保留真实生成/编辑路径，固定为 Sidecar → Image Relay `/v1/images/tasks`；Relay 只经 Gateway 私网内省验证安装 owner。图片新理解/评估使用 Qwen3-VL-Flash 并只经 Gateway `/v1/image/reasoning`，不再调用 MiMo；Renderer 不直连 Relay/Provider，Sidecar 不持有 service credential 或 Provider Key。
5. Provider 路由集中在 `ImageProviderPolicy`；Reference 能力差异在付费前返回，Provider/model/policy/request/input/output 有不可变 Execution Receipt。
6. Brief 有不可变 snapshot 和清晰事实优先级；正式尺寸、格式和安全区只以 Delivery Spec revision 为权威。
7. Reference 明确 role、influence strength、preservation 和 priority；`unclassified` 不能触发付费生成。
8. Operation 有按 kind 分类的输入/结果、幂等、费用状态、`outcome_unknown`、`blocked_by_policy` 和取消/晚到结果语义；不明确的远程结果不会自动重复付费。
9. 一个 Creative Direction 精确对应一个付费 Operation 和一个 Candidate Group；Generation Round 只做聚合和成本确认。
10. Candidate 像素事实不可变；keep/reject、derive 和 adopt 分离，未采纳 Candidate 可派生并保留完整谱系。
11. 同一 Candidate 可通过显式 placement 原子采纳到多个 Artboard；Project 使用 `current_versions_by_artboard` 保存 working selection，只有完整导出才创建 immutable Delivery Set 并更新 `latest_delivery_set_id`，不存在冲突的单 `current_version_id`。
12. Canvas 新建后只有 Command/revision writer，支持冲突、撤销/恢复和指定 revision 重渲染；前端提交 PNG 不能绕过 Renderer 成为新正式 Version。
13. Render Receipt 锁定 Canvas revision/document hash、renderer 版本、所有 Asset/Font hash 和输出 hash；历史 Version 不因 Brand Kit、Template 或依赖更新而漂移。
14. 精确文字有确定性字体/字形/CJK 布局，Logo 使用验证过的原资产，QR 支持 payload、静区/纠错配置和最终文件解码，SVG 无脚本/外部资源。
15. Preview、Preflight、Backend Render、Release Check、immutable Version、Delivery Set 和 Export Receipt 分离；PNG/JPEG/WebP 每个最终文件都重新检查解码、尺寸、QR 与 hash。
16. Qwen 的 Brief/Creative Plan/Visual Assessment 是带 receipt/confidence 的非阻断建议；技术发布门禁只由确定性 `ImageReleaseCheckResult` 和明确风险接受回执决定。平台/required 派生的硬门禁不能被 `ImageQualityPolicy` 降级或豁免。
17. Brand Kit 和 Template 按 owner 隔离且使用不可变 revision；Project/Canvas 引用精确 revision，Template 不引用 Project 私有或临时资产。
18. Asset Ownership、Provenance、Grant、Deletion Receipt、trash 和两次可达性 GC 走通；CAS 字节去重不会绕过 owner。
19. 所有修改 API 都有幂等键和适用的 `base_revision`；Canvas 没有整文档 PUT，兼容 API 不产生第二套业务逻辑。全部写入、付费、路径/grant、风险接受和最终交付经 Electron Main typed IPC，Renderer 无会话级 secret、任意路径或绕过 Main 的 paid/final action。
20. Public API/Event/日志不暴露 provider key、internal Prompt、原始图像字节、result grant、raw response 或本地绝对路径；Provider 上传副本默认移除非必要 EXIF/GPS。
21. 上传、像素、图层、SVG、字体、QR、并发、Campaign 和 budget 限制在真实 API/Renderer 路径生效；多方向/批量付费前有 estimate 和用户确认。
22. Quick Create 复用正式建项/生成链路；Inspiration Board 未 promote 的素材不发给 Provider；Campaign 只编排显式 Item 和普通 Project，逐项失败隔离。
23. 前端只保存瞬态视图状态，能用 public projection + event cursor 恢复；Operation Center 能区分队列、运行、取消中、策略拒绝、未知结果、失败和完成。
24. 正式一方 test command、macOS arm64/Windows x64 合同/打包验证、第 17.4 节完整用户旅程以及第 17.5 节每个当前范围场景都有真实证据，且临时服务/测试/浏览器/打包进程已停止并复查。
