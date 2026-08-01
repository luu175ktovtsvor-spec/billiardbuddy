# 工作树模块归属盘点

## 1. 目的与范围

本文件把当前脏工作树作为待审阅的施工资产，而不是把它自动认定为一个模块或一次提交。每个改动必须能对应 `BilliardBuddy-重构合同.md` 的模块结果、当前或历史施工单，或被明确标记为无关保留项；不能因为文件同时存在于工作树中就混入当前模块。

本盘点不宣布任何代码模块完成，也不授权部署、打包或发布。当前唯一施工游标仍以 `refactor-roadmap.md` 的施工单为准；R3.1 已独立完成个人模型的 Model Port、凭据隔离、冻结路由与本机 operation store，R3.2 已独立完成 Gateway 托管 TextReasoning 的 operation ledger、结果回放与额度结算，R3.3 已独立完成主 Harness 的私有 receipt 持久化与 ACK，R3.4 已独立完成 Subtask/Plugin agent 的父工具 receipt handoff，R3.5 已独立完成 Hook/压缩模型消费者的主 session receipt 持久化与 ACK，R3.6 已独立完成 unknown operation 的 generation-bound 新 attempt，R4.3 已独立收口公开 WebSocket hand-off 与动作围栏，R5.5 已独立收口中断图片提交的未知结果围栏，R5.6 已独立收口图片版本选择与 ACK 的资产完整性，R6.6 已独立收口预览发布后的终态恢复。下一项 R6.7 只复核视频导入、时间线、预览/导出与取消恢复，不得混入图片、Agent、搜索或桌面设置。

## 2. 当前快照

2026-07-31 只读盘点得到：

- `git diff --name-only` 有 271 个已跟踪路径；
- `git diff --cached --name-only` 有 9 个暂存路径，都是共享合同的重命名；
- `git ls-files --others --exclude-standard` 有 207 个实际未跟踪文件。

以上视图在 `RM` 路径上会重叠，不能相加当作提交规模。工作树包含 R2—R11 的历史施工资产，其中未跟踪目录在 `ts/src/`（104）、`ts/desktop/`（55）、`docs/refactor/`（41）、`ts/shared/`（4）和 `docs/product/`（3）最集中。

## 3. 归属规则

1. 每一个**差异块**在一次审阅或提交中只能由一个模块拥有；同一共享文件可以在不同模块中出现多个独立差异块，但不得用整个文件把无关改动混入。
2. 路径只能提供初步归属，最终以正式调用链、状态权威和消费者为准。
3. 合同、路线图和参考—改动文档是证据，不替代生产源码审阅；它们本身归 R0 文档与架构收口。
4. 锁文件、包清单、共享合同和应用壳等跨域文件，必须跟随实际修改它的模块审阅，不能单独凑成“杂项提交”。
5. 不能映射、没有消费者或已经被替代的改动进入 R8 清理裁决；在裁决前保留，不删除、不提交、不把它当成当前模块成果。

## 4. 初步模块地图

| 模块 | 当前工作树中的候选路径 | 审阅边界 |
| --- | --- | --- |
| R0 文档与架构 | `BilliardBuddy-重构合同.md`、`AGENTS.md`、`docs/refactor/**`、`docs/product/**`、`README.md` | 只记录方向、施工单和证据；不以历史记录改写当前游标。 |
| R1 共享产品内核 | `ts/shared/contracts/**`、`ts/shared/kernel/**`、跨领域持久化/资源合同 | 只保留真正跨 Agent、图片、视频的状态和权限合同。 |
| R2 Agent Harness | `ts/shared/agent/**`、`ts/src/domains/agent/**`、`ts/src/server/agent-worker/**`、Agent Authority/Worker/Tool/Process/Review 路径 | 以 TaskRun、Host、Authority 和恢复的唯一生产链裁决。 |
| R3 模型接入与使用权 | 安装身份、个人模型配置、Gateway token/operation、额度和资源调度路径 | 凭据、账本和 provider receipt 不得进入 Renderer 或 Agent Core。 |
| R4 Agent 桌面客户端 | `ts/desktop/src/product/**` 中的任务、线程、活动、审批、进程、恢复与公开协议消费 | Renderer 只投影公开 Authority 状态，不成为第二权威。 |
| R5 生图工作台 | `image*`、`ImageWorkbench`、图片项目/候选/资产/版本/远端 operation 路径 | 图片项目独立于 ProductTask，未知付费结果不能自动重试。 |
| R6 视频工作台 | `video*`、`VideoStudio`、素材、证据、时间线、预览、渲染与导出路径 | 视频项目和本地渲染拥有独立 Authority。 |
| R7 共享桌面壳 | `AppShell`、导航、窗口、设置、通知、通用菜单/组件和跨项目 attention 路径 | 只统一导航、窗口、通知和设置，不合并领域状态机。 |
| R8 清理与迁移 | 删除的旧浏览器/招聘/旧技能路径、迁移读取者、旧品牌、`scan-missing-imports`、无消费者资产 | 先证明没有正式消费者和升级输入，再删除旧路径。 |
| R10 生产部署 | `deploy/**`、`docs/operations/**`、服务器运行闭包相关改动 | 仅在用户确认软件层后才可审阅或写入生产。 |
| R11 构建、更新与发布 | `.github/workflows/desktop-build-*`、Electron pack 脚本、原生 Windows helper、运行资源、安装图标与更新配置 | Windows/macOS 只由 GitHub 原生 runner 构建；服务器只保存静态产物，不承载桌面 VM。当前不构建、不上传、不切换更新元数据。 |

## 5. 需要逐项裁决的跨域路径

以下归属已经由当前正式消费者收紧；锁文件跟随同一依赖差异块，而不是单独拥有模块：

| 文件与差异块 | 已确认消费者 | 模块归属 |
| --- | --- | --- |
| `ts/.env.example` 的 `/gw` 入口与移除固定模型 | Host/Gateway 运行时配置 | R3 模型接入与使用权 |
| `ts/package.json`、`ts/bun.lock` 的 `pdf-parse`、`unzipper` | `productDocumentAttachments.ts` | R2 Agent Harness 的项目附件 |
| `ts/package.json`、`ts/bun.lock` 的 `@napi-rs/canvas` | `imageVisualSignal.ts` | R5 生图工作台的视觉信号 |
| `ts/desktop/package.json`、`ts/desktop/bun.lock` 的 `@tanstack/react-virtual` | `ProductTaskThreadList.tsx` | R4 Agent 桌面客户端 |
| `ts/desktop/package.json` 的 PTY helper 资源 | Agent Host 的长进程/PTY 路径及安装资源审计 | R2 实现、R11 发布时分别审阅对应差异块 |
| `ts/desktop/package.json` 的浏览器扩展和 `product-secrets.json` 移除 | 旧浏览器/旧激活路径没有保留为正式安装资源 | R8 清理与迁移、R11 安装资源审计 |
| `ts/desktop/build/product-config.json` 的公开匿名安装会话说明 | Electron `productConfig.ts` | R11 构建、更新与发布 |
| `website/vite.config.ts` 的参考品牌注释清理 | 官网本地预览配置 | R8 旧品牌清理 |

共享合同、桌面通用组件及其他包清单改动仍须在对应模块审阅时连同消费者查看。它们目前不是独立工作单元，也不因存在于工作树中自动进入发布。

## 6. 后续工作法

1. 先完成当前路线图工作单元允许的静态证据与必要修复；
2. 再从本表选择依赖顺序中的下一个模块，读取该模块总纲和候选路径；
3. 对每一组改动确认生产调用链、唯一状态权威、失败/恢复边界和消费者；
4. 只暂存该模块已裁决的路径，检查暂存差异后再提交；
5. 其余改动继续保留在工作树，不能被宽泛 `git add -A` 混入。

本文件的退出条件是：后续每个模块完成审阅时，将其候选路径缩小为有消费者的正式路径、明确保留的迁移路径，或 R8 待删除项；在此之前，工作树仍是待分类资产，不是“已经完成的重构”。
