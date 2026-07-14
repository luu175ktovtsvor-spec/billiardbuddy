# 桌面版 AI Agent · 项目规则

> 📌 状态:✅现行 · 最后核对 2026-07-13

## 权威入口

- 当前架构：`docs/当前架构与状态-总览.md`
- 服务器与部署：`docs/服务器与部署-当前拓扑.md`
- 文档导航：`docs/README.md`
- TypeScript 工程规则：`ts/CLAUDE.md`、`ts/AGENTS.md`
- 模块地图与开发路由：`.agents/skills/project-change-router/`
- 当前任务规格：`docs/plans/`

代码和测试是运行事实的最终依据。文档与代码不一致时，先按源码核对，再更新对应的唯一真相源。

## 产品定义

本项目是全本地、免登录、单用户的通用桌面 Agent。用户用自然语言提出目标，Agent 通过模型循环和工具完成文件、命令、搜索、媒体、任务与扩展工作。

台球运营是可挂载的 `billiards` 领域包，不是通用 Agent 的产品边界。领域包提供台球知识、门店资料检索、领域命令和工具；未启用时保持通用助手能力。

客户端只持有可吊销的应用令牌。模型密钥和供应商配置保存在自有网关或 relay，运行时界面和错误信息不暴露底层模型或供应商。

## 两类执行路径

### A 线：Agent 对话

问答和开放任务走 `ts/src/harness` 的模型驱动循环：模型判断下一步、调用工具、读取结果并继续推理。壳层提供正确的循环、工具、权限、上下文和恢复机制，不为具体用户说法编写固定 SOP。

### B 线：确定性产品功能

生成图片、剪视频、定时任务和设置页由产品代码直接实现。慢任务使用 REST submit/poll 或任务事件，原生系统能力通过 Electron IPC。A、B 两线只通过工具、预定义 prompt 或后端服务入口连接。

## 架构原则

1. **内核对齐**：`~/Desktop/cc-haha-ref` 是 coding-agent 内核的重要可执行参考。许可允许复制、修改和移植；复杂边界以行为测试证明一致性。
2. **消息格式**：内核统一使用 Anthropic content-block；OpenAI-compatible 端点在 proxy 层转换；`tool_use` 与 `tool_result` 必须配对。
3. **本地存储**：桌面业务状态使用 JSONL transcript 和 JSON 元信息，不引入 SQL 数据库。
4. **共享契约**：REST、SSE、WS、IPC 和持久化边界 Schema 放在 `ts/shared/contracts`，用 Zod 推导类型并在边界解析。
5. **权限模型**：采用 `default`、`acceptEdits`、`plan`、`bypassPermissions`、`dontAsk` 五档。权限规则、hooks、强制确认和工具输入校验共同决定执行结果。
6. **文件护栏**：路径边界、符号链接、TOCTOU、危险命令和外部目录授权在执行前检查；文件修改建立备份与历史记录。
7. **扩展能力**：skills、commands、hooks、plugins、MCP、领域包和子代理保持独立模块，通过公共注册与发现入口接入。
8. **资产交付**：应用核心进入安装包；FFmpeg、字体等必须在客户电脑执行的大资产由资产管理器按清单下载并校验 SHA-256。语音转写默认走自有网关，模型不下发客户端；本地 Whisper 只作为显式离线兼容能力。
9. **原生能力**：需要 `.node` 或本地模型的能力使用可打包的 Node sidecar；Electron 与 Bun 共用的 plumbing 优先使用 `node:` API。

## 开发流程

任何实现、修复、重构或接口调整都先执行 `.agents/skills/project-change-router/SKILL.md`：确定改动类别、唯一主责模块、完整调用链、契约位置、范围和验证方式。

随后执行一个主单项 Skill；契约、跨服务、安全、Electron E2E 或发布工作叠加对应 Skill。完成后执行 `.agents/skills/verify-modular-change/SKILL.md`。

- 功能修改与结构重构分开提交。
- 非平凡改动使用短生命周期分支和小提交。
- 模块或连接边界变化时同步执行 `maintain-project-skills`。
- 保留工作树中已有的无关改动。
- 完成、提交或发布前运行 `bash scripts/quality_gate.sh`。

## 前端规则

前端位于 `ts/desktop/renderer-react/`，使用 React、Vite、Tailwind v4 和 Zustand。

- 设计、布局、交互和文案以 Codex 真实源码与 `docs/references/Codex逆向档案/` 为首要依据。
- 强调色使用浅蓝 `#0a84ff`，暗色主题使用 `#409cff`；其余颜色保持中性灰阶。
- 用户可见内容使用普通中文，不显示模型名、供应商名或内部工程术语。
- UI 组件只负责展示与交互；API 路径、响应归一化和业务状态分别进入 feature API、store 或共享契约。
- 所有按钮必须有真实动作或明确的不可用状态。
- 桌面界面修改使用 Playwright/Electron 验证关键路径和最小窗口布局。

## 后端与连接规则

- Bun 后端测试使用 `bun test`；前端测试按 package 脚本执行。
- SSE 路由调用 `server.timeout(req, 0)`，并使用 async generator 输出。
- renderer 不直接导入 Electron、Node 或后端内部模块；原生能力统一走 `desktopHost`。
- route 依赖应用服务，应用服务依赖领域接口，adapter 实现接口。
- 改动字段、事件、路径、状态码或 IPC payload 时，同次更新生产者、消费者、Schema 和契约测试。
- 本地 renderer、Electron main 和 Bun sidecar 随桌面应用原子发布；`gateway/`、`relay/`、`dataeye/` 按独立服务管理兼容性和发布顺序。

## 安全与产品边界

- 通用安全红线始终注入：不协助实际性交易营销、赌场经营或其他刑事犯罪；优先保护未成年人；法律文书提示专业复核；广告文案避免绝对化表达。
- 对外发送、平台发布和不可逆操作按权限规则处理，不自动群发或私信。
- 生图和剪视频是产品功能，生成结果本身不增加额外的消费审批维度。
- 真密钥只保存在服务器受保护文件和密码管理器，不进入仓库、日志或客户端。
- 运行时使用 `BILLIARDBUDDY.md` 与 `.billiardbuddy/` 作为产品记忆和配置命名。

## 台球运营领域包

- 知识内容以 `~/Desktop/球房-PPT底本-本地存档/` 的真实资料为依据，安全红线独立生效。
- PPT 中真实出现的平台、渠道和器材名称可以保留；没有资料依据的第三方专名和业务事实不得编造。
- 门店资料通过项目记忆和带来源的检索能力进入上下文。
- 通用 Agent 默认不挂载领域包。

## 常用命令

```bash
bash scripts/quality_gate.sh
bash scripts/quality_gate.sh --quick
cd ts && bun test
cd ts && bun run typecheck
cd ts && bun run e2e:backend
cd ts && bun run e2e:desktop
cd ts && bun run build:sidecar
cd ts && bun run desktop:dev
cd ts && bun run desktop:dist
```

## 文档规则

1. 主入口只写当前产品、当前架构、当前规则、当前能力和当前待办。
2. 更新文档时直接改成最新事实，不记录迁移经过、废止过程、会话流水、人员归属或反复决策。
3. 同一主题只保留一个现行真相源；导航文档只提供入口，不复制正文。
4. 当前架构放在 `docs/当前架构与状态-总览.md`，部署放在 `docs/服务器与部署-当前拓扑.md`，媒体能力分别放在两份媒体真相源。
5. 正在执行的任务规格放 `docs/plans/`；完成后若没有长期参考价值，直接移除。
6. 调研和审计证据放 `docs/子代理报告/<日期>-<批次>/`，不进入主导航的必读链路。
7. 活文档标题下使用状态行：`> 📌 状态:✅现行 · 最后核对 YYYY-MM-DD`。
