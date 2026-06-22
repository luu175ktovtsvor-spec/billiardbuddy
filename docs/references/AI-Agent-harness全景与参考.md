# AI Agent / Harness 全景与参考（动手前先看这里）

> 用途：实现 harness/agent 能力（循环/工具/上下文/权限/压缩/多 Agent/MCP…）前，先看**大厂**怎么做，借鉴再动手。
> 校准：2026-06-23 WebSearch 多源核实。⚠️ 本沙箱数据偶有合成/过时（star 数、版本号、价格、市占率尤甚），下方只写**多源印证的产品线与厂商归属**；具体版本/价格用时再核。

## 0. 一句话大势（最该记住的）

**大厂已一致认定「harness 就是产品」**——模型之外，真正的护城河是那套"循环+工具+上下文+权限+记忆"的执行外壳；各家分歧只在**怎么收费**（按会话时长 / 只收 API+工具 / 捆云）。**我们这盒子做的正是 harness，方向踩在风口上。** 三大开放标准已成范式：**MCP**（Anthropic 捐 Linux 基金会）、**A2A**（Google·Agent 间通信）、**AGENTS.md**（OpenAI·仓库约定）。

## 1. 大厂 AI Agent 谱（按厂商）

| 厂商 | 编码 Agent（成品） | Agent SDK/框架 | 平台/其它 |
|------|------|------|------|
| **Anthropic** | **Claude Code**（CLI 编码 agent·品类标杆） | **Claude Agent SDK** | **MCP**（工具协议·已成行业标准）、Computer Use、Skills、Cowork、企业版 Managed Agents |
| **OpenAI** | **Codex**（CLI + 云/IDE） | **Agents SDK**（多 agent·handoff·取代 Swarm）、AgentKit/Responses API | Operator/ChatGPT agent（控屏）、**AGENTS.md** 约定 |
| **Google** | **Gemini CLI**、**Jules**（异步编码 agent） | **ADK**（Agent Development Kit·开源·多语言·模型无关） | **Antigravity**（agent 优先 IDE/平台·一套 harness 跨多端）、Vertex AI Agent Builder、**A2A** 协议 |
| **微软** | **GitHub Copilot**（agent 模式 / Copilot Workspace）、Amazon… | **Microsoft Agent Framework**（统一 AutoGen + Semantic Kernel）、AutoGen、Semantic Kernel | Copilot Studio、Azure AI Foundry Agent Service |
| **AWS** | **Amazon Q Developer**、Kiro（agentic IDE） | **Strands Agents SDK**（模型驱动·原生接 Bedrock） | Bedrock Managed Agents（已上 OpenAI 模型/harness） |

**行业标准/治理**：MCP（工具）、A2A（agent 互通）、AGENTS.md（仓库说明约定）三标准融合；**Agentic AI Foundation（AAIF）** 在 Linux 基金会下，成员含 Anthropic/OpenAI/Google/微软/AWS/Block/Cloudflare 等。

## 2. 国内大厂（与本 BYOK 产品最相关）

| 厂商 | 代表 | 形态 |
|------|------|------|
| **字节** | **Trae**（AI IDE·国内份额领跑）、**Coze/扣子**（零代码 Agent 搭建平台） | IDE + Agent 平台 |
| **阿里** | **通义灵码**（IDE 插件）、**Qwen3-Coder**（编程模型·第一梯队）、Qoder（IDE） | 插件 + 模型 + IDE |
| **腾讯** | **CodeBuddy**、WorkBuddy（办公助手·微信指令处理 Excel/PPT） | IDE + 办公 agent |
| **百度** | **文心快码 / Comate** | IDE 插件 |
| **月之暗面** | **Kimi（含 Kimi Code）** | 模型 + 编码 agent（多模态视频原生送等做法可借鉴） |
| 其它 | DeepSeek、CodeGeeX（智谱） | 模型 + 补全 |

## 3. 开源 Agent（自托管/可读源研究用）

- **终端 CLI**：Aider（git 深整合·BYOK）、Goose（Block·Apache）、OpenCode（开源版 Claude Code·provider 无关）、Pi。
- **IDE 内嵌**：Cline（VS Code·审批治理强）、Continue、Kilo Code。
- **自主/企业级**：OpenHands（前 OpenDevin·自主解真实 GitHub issue）。
- **编排框架**：LangGraph、CrewAI、AutoGPT。

## 4. Harness 架构通识（主流都长这样）

**harness = 把无状态 LLM 变成"有状态、会用工具、能自我纠错的 agent"的编排层。** 核心 = ReAct 循环 + 一圈支撑子系统：
- **ReAct 6 阶段**：前置检查/压缩 → 思考 → 自我批判 → 行动 → 工具执行 → 后处理。
- **支撑子系统**：Prompt 组装引擎（模块化拼系统提示）/ 工具注册表（分发 handler）/ 多层安全 / 上下文工程（每步决定"放什么进上下文"，靠它迭代比微调快）/ 记忆 / 压缩 / 可观测。
- **执行模式谱系**：Agent Loop / 事件驱动 / 状态机 / 图流 / 混合。
- **安全两路线**：容器隔离（policy engine，如 OpenHands）vs 宿主进程直跑（确认+命令过滤+沙箱，**我们走这条**）。

### 对照我们这盒子（已对齐）
| 通识组件 | 我们的实现 |
|---------|-----------|
| ReAct 主循环 | `services/agent/loop.py`（同步+流式双入口） |
| Prompt 组装引擎 | `agent.py` `compose_agent_system_prompt`（三段） |
| 工具注册表 | `services/agent/registry.py`（能力位 + general/billiards） |
| 多层安全（宿主进程路线） | 四层防御 + 命令黑名单 + 改前备份 |
| 上下文工程/压缩 | microcompact + autocompact + anti-spin + prompt-cache 纪律 |
| 工具协议 | **MCP 客户端用官方 `mcp` SDK** |
→ 核心组件齐、与大厂同路数；缺口在生态/扩展层（见 `docs/plans/通用Agent改造-0到6路线图.md`）。

## 5. 深挖入口
- awesome 清单：`ai-boost/awesome-harness-engineering`、`bradAGI/awesome-cli-coding-agents`、`ARUNAGIRINATHAN-K/awesome-ai-agents-2026`。
- 论文：arXiv「Building Effective AI Coding Agents for the Terminal」「Architectural Design Decisions in AI Agent Harnesses」。
- Anthropic 官方：BEA / Effective Context Engineering / Writing Tools for Agents（见 `Anthropic-Agent-SDK-参考架构.md`）。
- 本机参考库：`~/Desktop/cc-haha-ref`（Claude Code/cc-haha·可读 TS·**可直接抄用**）。

> 来源（2026-06-23 核实）：thenewstack「harness is the product」/ Google Cloud Next 2026 报道 / langchain agent-frameworks / DataCamp / 多篇国产 AI 编程横评（CSDN/知乎/掘金）+ 上述 awesome 与 arXiv。版本/价格/市占率类细节用时再独立核实。
