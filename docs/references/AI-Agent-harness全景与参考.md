# AI Agent / Harness 全景与参考（动手前先看这里）

> 📌 状态:✅现行 · 最后核对 2026-07-10

> 用途：实现 harness/agent 能力（循环/工具/上下文/权限/压缩/多 Agent/MCP…）前，先看**大厂**怎么做，借鉴再动手。
> 校准：2026-06-23 WebSearch 多源核实。⚠️ 本沙箱数据偶有合成/过时（star/版本/价格/市占率尤甚），下方只写**多源印证的产品归属与开/闭源状态**；细节用时再核。**非穷举，查到新的自行延伸。**

## 0. 一句话大势（最该记住的）

**大厂已一致认定「harness 就是产品」**——模型之外，真正的护城河是那套"循环+工具+上下文+权限+记忆"的执行外壳；各家分歧只在**怎么收费**。**我们这盒子做的正是 harness，方向踩在风口上。**
**大厂普遍"两头都做"**：开源一个 SDK/CLI 圈生态，同时闭源一个产品/服务收钱——所以同一家公司会同时出现在下面两张表里。

## 1. 大厂 · 开源（可读源研究 / 可借鉴机制）

| 厂商 | 开源的东西 | 是什么 |
|------|-----------|--------|
| **OpenAI** | **Codex CLI**（Apache）、**Agents SDK** | 终端编码 agent 参考实现 + 多 agent SDK（handoff，取代 Swarm） |
| **Google** | **Gemini CLI**（Apache）、**ADK**（Agent Development Kit·多语言） | 终端编码 agent + 代码优先、模型无关的 agent 框架 |
| **Anthropic** | **Claude Agent SDK**、**MCP**（协议+各语言 SDK） | 搭 agent 的 SDK + 已成行业标准的工具协议 |
| **微软** | **AutoGen**、**Semantic Kernel** → 合并为 **Microsoft Agent Framework**；**Copilot Chat（VS Code 扩展）** | 多 agent 框架 + 企业 SDK；Copilot 的编辑器扩展已开源 |
| **AWS** | **Strands Agents SDK** | 模型驱动、原生接 Bedrock 的 agent SDK |
| **阿里（国内）** | **Qwen Code**（CLI·Gemini CLI 派生）、**Qwen3-Coder**（开放权重模型） | 开源终端编码 agent + 第一梯队国产编程模型 |
| 其它可延伸 | Meta Llama 系工具、智谱 **CodeGeeX**、字节 **Coze Studio**（部分开源）… | — |

## 2. 大厂 · 闭源（产品/服务，付费用·只能黑盒研究）

| 厂商 | 闭源产品 | 是什么 |
|------|---------|--------|
| **Anthropic** | **Claude Code**（CLI 编码 agent·品类标杆）、Computer Use、Cowork、企业 Managed Agents | 产品/服务闭源（其 SDK/MCP 才是开源那部分） |
| **OpenAI** | **Codex 云/IDE**、**Operator/ChatGPT agent**（控屏） | 托管编码服务 + 消费级 agent |
| **Google** | **Jules**（异步编码 agent）、**Antigravity**（agent 优先 IDE）、Vertex AI Agent Builder | 托管产品/平台 |
| **微软** | **GitHub Copilot**（服务·agent 模式）、Copilot Studio、Azure AI Foundry Agent Service | 服务闭源（扩展开源，见上表） |
| **AWS** | **Amazon Q Developer**、**Kiro**（agentic IDE）、Bedrock Managed Agents | 托管编码 agent + IDE |
| **字节（国内）** | **Trae**（AI IDE·国内份额领跑）、**Coze/扣子**（Agent 搭建平台） | 闭源 IDED + 平台 |
| **阿里（国内）** | **通义灵码**（IDE 插件）、Qoder（IDE） | 闭源插件/IDE（注：阿里开/闭都做，见上表） |
| **腾讯（国内）** | **CodeBuddy**、WorkBuddy（微信指令办公） | 闭源 |
| **百度（国内）** | **文心快码 / Comate** | 闭源插件 |
| **月之暗面（国内）** | **Kimi / Kimi Code** | 闭源产品（多模态视频原生送等做法可借鉴） |

## 3. 行业标准/治理（开放标准，谁都能接）
- **MCP**（Anthropic 捐 Linux 基金会·工具协议）、**A2A**（Google·agent 互通）、**AGENTS.md**（OpenAI·仓库说明约定）三标准融合。
- **Agentic AI Foundation（AAIF）**（Linux 基金会下），成员含 Anthropic/OpenAI/Google/微软/AWS/Block 等。

## 4. Harness 架构通识（主流都长这样）

**harness = 把无状态 LLM 变成"有状态、会用工具、能自我纠错的 agent"的编排层。** 核心 = ReAct 循环 + 一圈支撑子系统：
- **ReAct 6 阶段**：前置检查/压缩 → 思考 → 自我批判 → 行动 → 工具执行 → 后处理。
- **支撑子系统**：Prompt 组装引擎 / 工具注册表（分发 handler）/ 多层安全 / 上下文工程（每步决定"放什么进上下文"，迭代比微调快）/ 记忆 / 压缩 / 可观测。
- **执行模式谱系**：Agent Loop / 事件驱动 / 状态机 / 图流 / 混合。
- **安全两路线**：容器隔离（policy engine，如 OpenHands）vs 宿主进程直跑（确认+命令过滤+沙箱，**我们走这条**）。

> 我们这盒子对照通识组件的当前实现清单(ReAct 主循环/Prompt 组装/工具注册表/安全/压缩等具体文件路径),已由 `docs/当前架构与状态-总览.md` §0~§1 更细致地覆盖(六层模块表+文件清单),这里不再重复对照,避免两份口径不同步。

## 5. 深挖入口
- awesome 清单：`ai-boost/awesome-harness-engineering`、`bradAGI/awesome-cli-coding-agents`、`ARUNAGIRINATHAN-K/awesome-ai-agents-2026`。
- 论文：arXiv「Building Effective AI Coding Agents for the Terminal」「Architectural Design Decisions in AI Agent Harnesses」。
- Anthropic 官方：BEA / Effective Context Engineering / Writing Tools for Agents（见 `Anthropic-Agent-SDK-参考架构.md`）。
- 本机参考库：`~/Desktop/cc-haha-ref`（Claude Code/cc-haha 风格参考）。**该库 LICENSE 允许复制/修改/发布,可直接复制/抄/移植/改写;复杂边界仍用行为测试兜住。**

> 来源（2026-06-23 核实）：agentic.ai / opensourcealternatives / firecrawl / langchain / morphllm / thenewstack「harness is the product」/ 国产 AI 编程横评（CSDN/知乎/掘金）等。开/闭源状态多源印证；版本/价格/市占率类细节用时再独立核实。
