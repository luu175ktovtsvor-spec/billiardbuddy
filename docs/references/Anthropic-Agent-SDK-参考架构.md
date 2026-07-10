# Anthropic Agent SDK 参考架构说明

> 📌 状态:✅现行 · 最后核对 2026-07-10
> 基于官方文档（2026-06-16），适用于垂直行业领域 AI Agent 设计

---

## 1. Agent 主循环架构

### 1.1 核心循环结构

**官方文档**: https://code.claude.com/docs/en/agent-sdk/agent-loop

Agent 循环是一个标准的 eval-act 模式，由 SDK 自动管理：

```
┌─────────────────────────────────────┐
│ 1. 接收 prompt（包含历史）          │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│ 2. 系统消息 (SystemMessage)         │
│    subtype: "init"                  │
│    data: { session_id, ... }        │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│ 3. 调用 Claude 评估当前状态         │
│   输入: system_prompt +            │
│         tool_definitions +          │
│         conversation_history        │
└──────────────┬──────────────────────┘
               │
     ┌─────────┴──────────┐
     │                    │
     ▼                    ▼
 有工具调用         无工具调用
 (tool_use)         (end_turn)
     │                    │
     ▼                    ▼
 AssistantMessage    AssistantMessage
                     + ResultMessage
     │                  (final)
     ▼
 4. 执行工具
    返回 ToolResult
     │
     ▼
 5. UserMessage
    (工具结果反馈)
     │
     ▼
 回到步骤 3...
```

### 1.2 消息类型与流转

**五种核心消息类型**（均异步流式返回，用 for await）：

| 消息类型 | 何时发出 | 主要字段 |
|---------|---------|--------|
| **SystemMessage** | 循环启动 / 上下文压缩 | `subtype: "init" / "compact_boundary"`, `data.session_id` |
| **AssistantMessage** | Claude 每次回复 | `content[]` (文本 + 工具调用块) |
| **UserMessage** | 工具执行后 | `content[]` (工具结果) |
| **StreamEvent** | 流式启用时 | 原始 API delta，仅当 `includePartialMessages: true` |
| **ResultMessage** | 循环结束 | `subtype: "success" / "error_max_turns" / ...`, `result` 字段 |

**消息流转**：每轮是 `AssistantMessage(工具调用) → UserMessage(工具结果)` 交替,直到 Claude 回复不含 `tool_use`(纯文本 `end_turn`)才发 `ResultMessage` 收尾;调用方用 `for await` 逐条消费,只在 `ResultMessage` 里拿最终答案(`message.result`),中间的 Assistant/User 消息都是过程态。

### 1.3 上下文管理

**上下文窗口包含的内容**（累积、不重置）：

1. **System Prompt**（固定，自动缓存）
2. **CLAUDE.md**（项目级指令，自动缓存）
3. **Tool Definitions**（内置工具 + MCP 工具）
4. **Conversation History**（随 Turn 累积）
   - 用户 prompt
   - Claude 回复
   - 工具调用输入
   - 工具结果输出
5. **Skill 元数据**（仅元数据自动缓存，全文按需加载）

**自动压缩机制**（超过上下文限制时）：

- SDK 发出 `SystemMessage(subtype="compact_boundary")`
- 将旧对话历史总结为摘要
- 保留最近交互和关键决策
- ⚠️ **早期指令可能丢失** → 应放在 CLAUDE.md（被重新注入每次请求）

---

## 2. Skill 机制（重点）

### 2.1 SKILL.md 格式规范

**官方文档**: https://code.claude.com/docs/en/skills 和 https://code.claude.com/docs/en/agent-sdk/skills

**Frontmatter 字段**（正文是普通 Markdown:标题+职责说明+能力列表+使用准则+示例,无强制结构）：

```yaml
---
name: "skill-name"            # 必需,唯一标识,用于 /name 调用;目录名或 YAML key
description: "一句话说明用途"    # 必需且最关键:Claude 据此判断何时自动调用,应含行为关键词+适用场景
category: "optional"          # 可选,分类标签,不影响功能
version: "1.0.0"               # 可选
allowed-tools: [Read, Write]   # ⚠️ CLI 仅支持,SDK 中无效(SDK 改用 allowedTools 选项)
tags: ["tag1", "tag2"]         # 可选
---
```

**description 好坏对比**：❌ 差(太笼统)`"A skill for processing documents"`；✅ 好(含关键词+场景)`"Extract text, tables, and metadata from PDF documents. Use when user asks to read, parse, or analyze PDFs."`

### 2.2 SKILL.md 目录结构与多文件支持

`.claude/skills/<skill-name>/` 下 `SKILL.md` 是唯一必需文件,同目录可放辅助脚本(Python/Shell/JS)、子目录资源(图片/数据文件)、内嵌 Prompt 模板(如 `prompts/xxx.md`)、`README.md`。CLI 和 SDK 都支持多文件 Skill;引用资源用相对路径(相对于 SKILL.md)。

### 2.3 Progressive Disclosure（渐进式披露）

**加载阶段**：

1. **发现阶段**（Session 启动）
   - SDK 扫描 `.claude/skills/*/SKILL.md`
   - 仅读取 frontmatter（name + description）
   - 消耗极少上下文
   
2. **激活阶段**（需要时）
   - Claude 判断需要某 Skill（基于 description 匹配）
   - SDK 加载该 SKILL.md 的**完整 Markdown 内容**
   - 注入到 Claude 的上下文中

3. **执行阶段**（可选）
   - Skill 可能包含 `/invoke` 子命令
   - 执行关联脚本或外部系统

**Cost Implication**：
- 元数据自动缓存（prompt cache）
- 完整内容首次加载计入上下文
- 缓存命中时费用大幅降低（0.1x）

### 2.4 Skill 如何被发现和调用

- **自动发现**：`ClaudeAgentOptions(setting_sources=["user","project"], skills="all")` 启用扫描后,Claude 按用户 prompt 关键词匹配 skill 的 `description`,命中即按需加载执行(如用户提到 "PDF" 命中 `pdf-processor`)。
- **显式调用**：用户直接打 `/<skill-name> ...`(如 `/pdf-processor Extract tables from invoice.pdf`)。
- **调用机制**：Skill 通过专门的 `Skill` 工具被调用(不是 Bash);包含在 `allowedTools` 中时自动批准;SDK 的 `skills` 选项控制哪些 skill 对本次会话可见。

### 2.5 Skill、Tool、Subagent 的区别与适用场景

| 维度 | Skill | Tool | Subagent |
|------|-------|------|----------|
| **定义方式** | 文件 SKILL.md | 代码（@tool） | 代码（AgentDefinition） |
| **发现** | 自动扫描文件系统 | 显式注册 MCP | 显式定义 |
| **调用** | 自动（基于 description）/ 显式（/name） | Claude 选择调用 | Claude 选择 or 显式（"use agent X"） |
| **持久性** | ✅ 跨会话保存 | ❌ 每会话注册 | ❌ 每会话定义 |
| **与主 Agent 上下文的关系** | 加载到主对话 | 加载到主对话 | **独立** 新对话 |
| **最佳用途** | 复用工作流、通用能力 | 与外系统交互、自定义逻辑 | 并行任务、专门角色、隔离复杂逻辑 |
| **例子** | PDF 阅读、Markdown 渲染 | 数据库查询、API 调用 | 代码审查、研究、测试执行 |

**场景判断树**：

```
需要这个能力？
├─ 多个 Agent / 多个项目复用？
│  └─ 是 → Skill（SKILL.md）
├─ 与外部系统交互（API、数据库）？
│  └─ 是 → Tool（自定义 MCP）
├─ 需要隔离上下文、并行执行、专门指令？
│  └─ 是 → Subagent（AgentDefinition）
└─ 简单的多步工作流？
   └─ Skill 或 Tool 都可，优先 Skill（更易维护）
```

---

## 3. Subagent 与 Agent SDK

### 3.1 Subagent 的隔离与派发

**官方文档**: https://code.claude.com/docs/en/agent-sdk/subagents

**上下文隔离**：

```
主 Agent                        Subagent（独立）
─────────────────────────────────────────────────
conversation_history        ×（不继承）
files_read                  ×（不继承）
analysis_done               ×（不继承）

接收：
  ├─ 自己的 system_prompt
  ├─ Agent tool 的 prompt 参数
  ├─ CLAUDE.md（如有）
  └─ AgentDefinition.tools 列表
  
返回：
  └─ 仅最终消息 → 主 Agent 作为工具结果
```

**派发方式**：主 Agent 的 `ClaudeAgentOptions.agents` 里注册一个 `{name: AgentDefinition}` 字典(如 `code-reviewer`),`allowed_tools` 需含 `Agent` 才能派发;调用方仍是标准 `query(prompt=..., options=...)`,只是 `AgentDefinition` 可以单独限定工具集(`tools=["Read","Grep","Glob"]`)、覆盖模型(`model="opus"`)、限制轮数(`max_turns=10`)、调推理深度(`effort="high"`)。派发结果同样只在 `ResultMessage.result` 里拿。

### 3.2 AgentDefinition 配置字段

**完整字段清单**：

```python
AgentDefinition(
    # 必需
    description: str           # Claude 何时使用该 subagent
    prompt: str               # 该 subagent 的系统提示词
    
    # 工具与权限
    tools: List[str]          # 允许的工具；省略 = 继承全部
    disallowed_tools: List[str]  # 显式移除的工具
    
    # 模型
    model: str                # "opus" / "sonnet" / "haiku" / "inherit" / full_id
    
    # 行为
    max_turns: int            # 最多循环轮数
    effort: str               # "low" / "medium" / "high" / "xhigh" / "max"
    background: bool          # 后台运行（非阻塞）
    
    # 记忆与集成
    skills: List[str]         # 预加载的 skill
    memory: str               # "user" / "project" / "local"
    mcp_servers: List         # MCP 服务器列表
    
    # 初始提示（可选）
    initial_prompt: str       # 作为首个用户消息自动提交
    
    # 权限
    permission_mode: str      # "default" / "acceptEdits" / "plan" / "dontAsk" / "auto"
)
```

### 3.3 Agent SDK 构建自定义 Agent 的要点

**两种编程模式**：① `query(prompt=..., options=ClaudeAgentOptions(...))` 配合 `async for` —— 推荐,简洁,单轮无状态调用;② `ClaudeSDKClient(options=...)` + `await client.request(prompt=...)` —— Python 专用,适合多轮状态管理场景。

**核心概念**：

- **无状态 API**：每次 `query()` 或 `.request()` 是独立调用
- **会话延续**：捕获 `ResultMessage.session_id`，用 `resume=session_id` 继续
- **流式输出**：使用 `async for` 逐个处理消息，实时响应
- **成本控制**：设置 `maxBudgetUsd` 和 `maxTurns` 防止失控

---

## 4. 工具调用与 Function Calling

### 4.1 工具定义格式（JSON Schema）

**官方文档**: https://code.claude.com/docs/en/agent-sdk/custom-tools

**自定义工具创建流程**：`@tool(name, description, input_schema)` 装饰一个 `async def handler(args: dict) -> dict`,再用 `create_sdk_mcp_server(name, version, tools=[...])` 把多个工具打包成一个 MCP server 供 agent 挂载。`input_schema` 支持两种写法:①简单 dict(`{"latitude": float, "longitude": float}`,SDK 自动转 JSON Schema);②完整 JSON Schema dict(`{"type":"object","properties":{...},"required":[...]}`,可表达 `enum`/嵌套等复杂约束)。handler 收到的 `args` 已按 schema 验证过,返回值是下文 4.2 的 tool_result 结构(`content`/`is_error`/`structuredContent`)。

### 4.2 Tool Use / Tool Result 消息块结构

**AssistantMessage 中的 Tool Use 块**（`content[]` 里可以有多个 `tool_use`,并行下发）：

```python
AssistantMessage(
    content=[
        {
            "type": "tool_use",
            "id": "tool_use_abc123",        # 唯一 ID（用于结果匹配）
            "name": "get_temperature",      # 工具名
            "input": {"latitude": 37.7749, "longitude": -122.4194},
        },
    ]
)
```

**UserMessage 中的 Tool Result 块**（SDK 自动生成,靠 `tool_use_id` 与上面的 `id` 一一配对,顺序与数量必须严格匹配）：

```python
UserMessage(
    content=[
        {
            "type": "tool_result",
            "tool_use_id": "tool_use_abc123",  # ← 匹配 AssistantMessage 的 id
            "content": [{"type": "text", "text": "Temperature: 62°F"}],
            "is_error": False,               # 可选：标记工具调用失败
        },
    ]
)
```

### 4.3 并行工具调用与顺序执行

**并行规则**：
- **读操作**（Read, Grep, Glob, WebSearch）：可并行
- **写操作**（Edit, Write, Bash）：顺序执行（防止冲突）
- **自定义工具**：默认顺序；若在 `@tool(...)` 上标 `annotations=ToolAnnotations(readOnlyHint=True)` 则可与其他只读工具并行

### 4.4 错误处理：异常 vs 返回 is_error

**规则**：❌ 不要在工具 handler 里抛异常(会中断循环);✅ 应该返回 `is_error: True` 让 Claude 自己看到失败、决定重试或换方案。

**工具结果返回结构**（完整字段）：

```python
return {
    "content": [                      # 必需：内容数组,支持 text/image/audio/resource/resource_link
        {"type": "text", "text": "..."},
        {"type": "image", "data": "base64...", "mimeType": "image/png"},
    ],
    "is_error": False,                # 可选：标记失败,True 时 Claude 能重试/换方案
    "structuredContent": {            # 可选：机器可读的结构化数据(如 {"temperature": 62.0})
        "temperature": 62.0,
    },
}
```

---

## 5. 记忆与成本管理

### 5.1 CLAUDE.md 作为持久记忆

**官方文档**: https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts

**文件位置与加载**：

```
~/.claude/CLAUDE.md                 # 用户级（所有项目）
<project>/.claude/CLAUDE.md         # 项目级（优先）
<project>/CLAUDE.md                 # 项目根（旧格式，兼容）
```

**加载条件**：`ClaudeAgentOptions(setting_sources=["user","project"])` 必须显式启用这两个源(`query()` 默认已启用两者;显式传 `setting_sources` 时需自己包含,否则不加载)。

**CLAUDE.md 的特点**：
- ✅ **持久化**：跨会话保存；通过 git 共享
- ✅ **自动注入**：每次请求都重新加载并注入对话
- ✅ **不入系统提示词**：作为上下文（第一条消息），不消耗系统提示词 token
- ✅ **自动缓存**：Prompt cache 机制（首次完整价格，后续 0.1x）
- ❌ **不是 Memory API**：无智能提取、无遗忘管理

**内容指导**（官方建议的分节结构）：项目名与使命(目的/技术栈/关键约束) → 编码标准(语言规范/命名/目录约定) → 关键概念与域名语言(项目特有术语避免歧义) → 上下文压缩指引(压缩时必须保留:当前任务目标/已读改文件路径/测试结果/关键决策理由) → 禁止与合规(不该做的事/安全边界/数据隐私规则)。

### 5.2 Prompt Caching 成本节省机制

**官方文档**: https://platform.claude.com/docs/en/build-with-claude/prompt-caching

**工作原理**：

```
请求 1：
系统提示词 (5000 token) + CLAUDE.md (3000 token) + 用户消息
→ 首次处理，缓存前 8000 token
→ 费用：8000 × 基础价 + 缓存写费用

请求 2（相同的系统提示词 + CLAUDE.md）：
→ 检测到前 8000 token 相同
→ 从缓存读取 8000 token
→ 费用：8000 × 0.1x 基础价 + 新消息部分
→ 节省 90%！
```

**定价（以 Claude Opus 4.8 为例）**：

| 操作 | 价格 |
|------|------|
| 基础输入 | $5 / 百万 token |
| 缓存写入（5分钟） | $6.25 / 百万 token（1.25x） |
| 缓存写入（1小时） | $10 / 百万 token（2x） |
| **缓存读取** | **$0.50 / 百万 token（0.1x）** |

**最小缓存要求**：
- Opus 4.8 / Sonnet 4.6：1024 token
- Haiku 4.5：4096 token

**启用方式**：直接调 Messages API 时,在 `system`/消息块上加 `cache_control: {"type": "ephemeral"}` 标记缓存点(默认 5 分钟 TTL,也可选 1 小时);可以只标记"保持不变的大块"(如系统提示词),让"会变的部分"(如最新一条消息)留在缓存外。也支持"预热"——发一个 `max_tokens=0` 的空跑请求提前把缓存写热,用户真正提问时直接命中。

**Agent SDK 里是全自动的**：System prompt、CLAUDE.md、Tool definitions(内置+MCP)、Skill 元数据和完整内容这四类都会被 SDK 自动打上缓存点,用户只需正常设置 `ClaudeAgentOptions`,不需要手写 `cache_control`。

### 5.3 Memory API 与上下文管理

**官方文档**: https://platform.claude.com/docs/en/agents/agent-memory

⚠️ **重要区分**：

| 特性 | CLAUDE.md | Memory API（Managed Agents） | 消息历史 |
|------|-----------|---------------------------|---------|
| **适用场景** | 项目级规则、指引 | 长期会话、用户特定上下文 | 当前会话 |
| **持久性** | 跨项目、跨用户 | 每用户、跨会话 | 单会话 |
| **更新方式** | 手工 git commit | API 自动/手工 | 每 turn 累积 |
| **成本** | Prompt cache | 存储费 + API 调用 | token 计费 |

**Agent SDK（本地）不包含 Memory API**：

Memory API 是 Managed Agents（云托管）的功能。本地 Agent SDK 使用：

1. **CLAUDE.md**（项目级）
2. **会话持久化**（session_id resume）
3. **手工状态管理**（数据库 / 文件）

**如果需要长期学习**（如"店脑"这类跨会话记忆）：本地 SDK 没有现成机制,只能自己在 `ResultMessage` 回来后手工解析 `message.result`、决定存什么、下次 `query()` 时再手工注入——这正是本项目 cc AutoMem 自建记忆池要解决的问题,SDK 本身不提供。

---

## 小结与选择矩阵

### 使用场景判断

```
┌─ 需要专业知识库？
│  ├─ 是，固定的 → Skill (SKILL.md)
│  └─ 是，动态的 → CLAUDE.md + 定期更新
│
├─ 需要与外部系统交互？
│  └─ 是 → 自定义 Tool (MCP)
│
├─ 需要并行执行多个专门任务？
│  └─ 是 → Subagent
│
├─ 需要跨会话学习?
│  └─ 是 → CLAUDE.md + 数据库，或迁移到 Managed Agents (Memory API)
│
└─ 成本关键？
   └─ 是 → Prompt Caching (自动 + 手工缓存点)
```

---

## 官方文档汇总

| 功能 | 官方文档 URL |
|-----|-----------|
| Agent Loop | https://code.claude.com/docs/en/agent-sdk/agent-loop |
| Agent SDK 总览 | https://code.claude.com/docs/en/agent-sdk/overview |
| Skills（CLI）| https://code.claude.com/docs/en/skills |
| Skills（SDK）| https://code.claude.com/docs/en/agent-sdk/skills |
| Subagents | https://code.claude.com/docs/en/agent-sdk/subagents |
| 自定义工具 | https://code.claude.com/docs/en/agent-sdk/custom-tools |
| 系统提示词 | https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts |
| Prompt Caching | https://platform.claude.com/docs/en/build-with-claude/prompt-caching |
| TypeScript 引用 | https://code.claude.com/docs/en/agent-sdk/typescript |
| Python 引用 | https://code.claude.com/docs/en/agent-sdk/python |

