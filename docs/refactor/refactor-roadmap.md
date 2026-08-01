# BilliardBuddy 重构施工路线图

## 1. 作用与权威顺序

这份文件只回答三件事：模块依赖顺序、每个模块的退出条件、唯一当前施工单。它不是施工日记，也不保存旧轮次的代码细节。

1. `BilliardBuddy-重构合同.md` 定义产品结果、长期边界和最终完成定义。
2. 本路线图定义全局施工顺序和当前唯一游标。
3. 当前模块总纲定义该模块的局部边界；`agent-harness-construction-direction.md` 只在 R2 被选中时生效。
4. 当前正式源码和真实生产调用链是实现事实。
5. `module-verification-ledger.md`、`worktree-module-inventory.md` 与专题 `*-reference-change.md` 只记录证据、历史和缺口，不能改变游标或单独宣布模块完成。

每次施工只允许一个 active work unit。完成一个模块后，先记录当前源码证据、未验证事实和静态结果，再提交一次；附属文档只随该模块记录事实，不另起“文档完成”冒充代码完成。

## 2. 已关闭的架构裁决

- 产品是“模块化单体 + 明确进程边界 + 远端控制面”，不是按目录或技术名词拆出的微服务集合。
- Agent、图片、视频是同级业务域；共享控制面、存储、资源、桌面壳与 Gateway 是支撑层，不成为第四个工作台。
- Agent Harness 以 `codex-reference/` 的 Core/App Server/Protocol/Prompts 作为主要语义参考；参考源码不进入产品运行时、构建或安装包。
- 产品支持托管和个人模型来源，但都经同一 Model Execution Port；个人 Key 只留在本机受信 Host，Gateway 只拥有托管身份、额度和远端 operation。
- Renderer 只消费公开投影；Task/Run/Project/Task/Asset/Provider receipt 的权威状态都在其所属 Server/Host/Gateway 持久边界内。
- 开发侧不保留或运行测试、fixture、smoke、安装或升级验收；模块证据只使用当前源码审查、类型检查、生产构建、静态审计和必要的生产事实核对。

## 3. 全局模块顺序

```text
R0 文档与施工协议
  → R1 共享产品内核
  → R2 Agent Harness
  → R3 模型接入与使用权控制面
  → R4 Agent 桌面投影
  → R5 图片工作台
  → R6 视频工作台
  → R7 共享桌面壳
  → R8 旧路径、迁移与依赖收口
  → R9 软件层跨模块审计
  → R10 生产部署闭包
  → R11 构建、更新与发布
  → main 合并
```

只有错误结果、数据丢失、重复付费副作用、权限越界或无法恢复，才允许中断当前模块去修正更高优先级缺口；其余发现先登记到所属模块。

## 4. 模块卡片与当前静态状态

| 模块 | 产品结果 | 静态退出证据 | 当前提交链 |
| --- | --- | --- | --- |
| R0 | 合同、路线图和模块协议给出同一顺序和唯一游标 | 路线图不含施工流水；账本只记录证据；一次一个 work unit | `e36ab93a`、`eaba7606` |
| R1.1 | 一份跨域资源 claim、lease、fencing 与队列合同 | Kernel 合同、唯一持久 scheduler、旧路径仅转发 | `d239c797` |
| R1.2 | 匿名安装会话、能力目录、受信凭据与迁移入口 | Main 持有安装/凭据能力；Renderer/Worker 不得持有刷新凭据 | `3b3033a7` |
| R2 | 唯一 Authority—Worker—Host—Harness 链 | 单一组合根、事件账本、私有 session、公开投影和恢复边界 | `dfc281d4` |
| R3.1 | 同一 Model Port 支持托管和个人来源 | 冻结路由、个人 Key 本机受信存储、Host 重建并校验 route digest | `727aa28b` |
| R3.2 | 托管模型 result/usage operation ledger | 同 operation 回放、unknown 围栏、持久结果后结算 | `c2ff58e8` |
| R3.3—R3.5 | 模型结果只在 durable consumer 持久化后 ACK | 主消息、父工具、Hook/压缩各自的 receipt handoff | `a1830f3b`、`cd685960`、`7a3cbd14` |
| R3.6 | unknown 后只能由用户确认创建新 attempt | `dispatch_generation` 进入 operation namespace；旧 unknown 不自动重发 | `b69246c0` |
| R4 | 桌面只投影 Agent 的公开权威事件 | `awaiting_resume → replaying → live` handoff；动作在交接前失败关闭 | `33190719` |
| R5 | 图片 Project/Task/Asset/Version 的持久闭环 | 提交前 unknown 围栏、显式新操作、候选和 ACK 均校验已物化资产 | `484a21c4`、`bcae0ade` |
| R6 | 视频 Source/Timeline/Preview/Render 的独立 Authority | 素材 fingerprint、render revision 和 timeline version 一致才发布结果 | `5d8c427d`、`5aa9e519` |
| R7 | 页面关闭不停止跨工作台后台观察 | MainApp 唯一持有任务/媒体公开订阅，页面只额外观察 | `a2312a99` |
| R8 | 正式运行路径、迁移和依赖收口 | 无测试资产或入口；可达性与安装资源扫描只保留正式消费者 | `069ae753` |
| R9 | 三条旅程和共享底座不存在已知静态阻断缺口 | 按模块重查权威、恢复、权限与旧路径；组合根无默认替代实例 | `161103cd`、`38ee351a` |
| R10 | 服务器运行闭包与仓库事实可分辨 | 版本、Compose、端口、健康、持久目录和 operator-owned 策略有只读记录 | `15584554` |
| R11 | 平台构建、更新与发布边界可静态追踪 | 原生 runner、默认不发布、来源/签名/产物/安装资源审计 | `ec342969` |

“静态退出”不等于真实产品效果已经验证。真实模型、付费生成、FFmpeg 中断、多窗口、安装、升级、候选构建和发布都必须在未来获得相应授权后单独确认；它们不构成把未完成代码混入当前模块的理由。

## 5. R2 内部顺序

R2 被选中时只能依次处理：

1. A0.1：`ProductTask → TaskRun → Worker → Harness → Model Port → Event` 正式调用链；
2. A0.2：Task、Run、Session、Tool、Process、Provider 与 Projection 的唯一写入者和恢复者；
3. A0.3：Domain/Application/Ports/Infrastructure/Projection 的依赖方向；
4. A1：Authority 与 Thread/Turn/Item/Event 持久边界；
5. A2：Harness 上下文、模型—工具循环、协作和审阅；
6. A3：Tool Runtime、Host、权限、Sandbox、文件、Shell 与长进程；
7. A4：Worker—Host IPC、恢复、取消、背压和资源租约；
8. A5：旧 Agent 路径的消费者迁移与退出。

不得因某个文件名称、历史专题文档或局部功能而跳过这些顺序。

## 6. 当前施工游标

```text
Active work unit: main 合并 — 已核验模块链成为 main 的正式树
Outcome: R0—R11 的已核验提交链成为 main；旧的混杂工作保留为可恢复归档，不进入正式树。
Evidence: 本文件的模块—提交映射、module-verification-ledger.md、git log/diff/status、目标 main 历史与当前源码静态检查。
Constraints / Non-goals: 不推送、不创建 PR、不发布、不写服务器；不把旧混杂改动混进模块链。
Allowed scope: Git 归档、工作树保护、main 合并、合并后静态检查和必要记录。
Verification / Exit: 每个 R0—R11 都有产品结果、退出证据和可追溯提交；main 最终树只含已裁决模块；工作树干净；静态检查通过。
Next cursor: 合并完成后进入用户确认的真实产品/发布验收，不以文档或静态检查替代该确认。
```

## 7. 合并规则

合并不是再做一个“大模块”。合并前只允许：核对 R0—R11 提交链、确认工作树干净、检查目标 `main` 的历史和未提交状态、确定最终树只含已裁决模块。合并后重新执行静态检查与最终差异核对。

如果 `main` 自身有未提交或未裁决旧工作，必须先保留为可恢复的归档，再由已核验模块链成为 `main` 的正式树；不能把旧工作和新模块提交强行混合，也不能在未保留的情况下丢弃。
