# AI Agent / Harness 全景与参考（动手前先看这里）

> 用途：实现 harness/agent 能力（循环/工具/上下文/权限/压缩/多 Agent…）前，先看主流是怎么做的，借鉴再动手。
> 校准：2026-06-23 WebSearch + GitHub 交叉核实。⚠️ 本沙箱 GitHub star 数偶有不可信（合成/网络问题），下方只收**多源印证**的项目；star 仅供量级参考。

## 一、按"品种/类型"分（typology）

| 类型 | 是什么 | 典型代表 |
|------|--------|---------|
| **终端 CLI Agent** | 长在终端里的编码/执行 agent（**我们这盒子属此类**） | **Claude Code**、**OpenAI Codex CLI**、**Gemini CLI**（平台/厂商）；**Aider**（git 深整合·BYOK·自动 commit）、**Goose**（Block 出品·Apache）、**OpenCode**（provider 无关·本地模型·TUI，被称开源版 Claude Code）、**Pi** |
| **IDE 内嵌 Agent** | 嵌进 VS Code/JetBrains | **Cline**（VS Code·逐步审批/治理强）、**Continue**（多 IDE）、**Kilo Code**；Cursor（闭源 IDE）。注：Roo Code 2026-05 已归档 |
| **自主/企业级 Agent** | 高自主、解 GitHub issue 级别 | **OpenHands**（前 OpenDevin·自主解 50%+ 真实 issue）、Devin（闭源） |
| **Agent 编排框架 / SDK**（不同层：搭 agent 用的库） | 不是成品 agent，是搭 agent 的脚手架 | **LangGraph**、**CrewAI**（多角色编排）、**OpenAI Agents SDK**、**Anthropic Agent SDK**、smolagents、AutoGPT（早期自主 agent 鼻祖） |
| **计算机/浏览器操作 Agent** | 控屏/控浏览器 | Claude computer-use、browser-use |

**选型三问**（业界共识）：① 在哪写码（IDE vs 终端）？② 要多自主（每步确认 vs 全自主）？③ 要不要换模型自由（任意 LLM vs 厂商锁定）？

## 二、Harness 架构通识（主流怎么搭）

**harness = 把"无状态 LLM"变成"有状态、会用工具、能自我纠错的 agent"的编排基础设施。** 核心 = ReAct 循环 + 一圈支撑子系统：

- **ReAct 主循环 6 阶段**：前置检查/压缩 → 思考 → 自我批判 → 行动 → 工具执行 → 结果后处理。
- **支撑子系统**：① Prompt 组装引擎（模块化拼系统提示）② 工具注册表（分发到各 handler）③ 安全系统（多层独立防御）④ 上下文工程（每步决定"放什么进上下文"，靠它迭代比微调快）⑤ 记忆 ⑥ 压缩 ⑦ 可观测。
- **执行模式谱系**：Agent Loop / 事件驱动 / 状态机 / 图流（graph/flow）/ 混合。
- **安全两路线**：容器隔离（policy engine，如 OpenHands）vs 宿主进程直跑（靠确认+命令过滤+沙箱，**我们走这条**）。

## 三、对照我们这盒子（已对齐处）

| 通识组件 | 我们的实现 |
|---------|-----------|
| ReAct 主循环 | `services/agent/loop.py`（同步+流式双入口） |
| Prompt 组装引擎 | `api/v1/agent.py` `compose_agent_system_prompt`（通用身份+安全红线+领域人设三段） |
| 工具注册表 | `services/agent/registry.py`（`Tool` + 能力位 + `general/billiards_registry`） |
| 安全系统（宿主进程路线） | 四层防御：权限模式 + allow-ask-deny/审批闸 + 文件沙箱+备份 + 审批签名；命令黑名单 |
| 上下文工程/压缩 | microcompact + autocompact + anti-spin + prompt-cache 前缀纪律 |
| 多 Agent | `run_subagent` |

→ 结论：核心组件我们都有、与主流对齐；缺口主要在生态/扩展层（见 `docs/plans/通用Agent改造-0到6路线图.md`）。

## 四、研究入口（要深挖时从这查）

- **awesome 清单**：`ai-boost/awesome-harness-engineering`（harness 工程：工具/模式/评测/记忆/MCP/权限/可观测）、`bradAGI/awesome-cli-coding-agents`（终端 agent 与 harness 编目）。
- **论文**：arXiv「Building Effective AI Coding Agents for the Terminal: Scaffolding, Harness, Context Engineering」、「Architectural Design Decisions in AI Agent Harnesses」。
- **Anthropic 官方**：Building Effective AI Agents、Effective Context Engineering、Writing Tools for Agents（见 `docs/references/Anthropic-Agent-SDK-参考架构.md`）。
- **本机参考库**：`~/Desktop/cc-haha-ref`（Claude Code/cc-haha，可读 TS，**可直接抄用**）。

> 来源（2026-06-23 核实）：wetheflywheel / frontman / pinggy / morphllm（Terminal-Bench 榜）/ martinfowler harness-engineering / 上述 arXiv 与 awesome 仓库。
