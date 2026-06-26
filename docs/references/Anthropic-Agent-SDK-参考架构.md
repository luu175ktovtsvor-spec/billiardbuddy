# Anthropic Agent SDK 参考架构说明

> 📌 状态:✅现行 · 最后核对 2026-06-26
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

**消息流转示例**（Python 伪代码）：

```python
async for message in query(prompt="Fix bug in auth.py"):
    # Turn 1
    # -> SystemMessage (subtype="init")
    # -> AssistantMessage (calls Bash to find test)
    # -> UserMessage (test output)
    
    # Turn 2
    # -> AssistantMessage (calls Read on auth.py)
    # -> UserMessage (file content)
    
    # Turn 3
    # -> AssistantMessage (calls Edit, then Bash to re-run test)
    # -> UserMessage (test result: success)
    
    # Final
    # -> AssistantMessage (text-only, no tool calls)
    # -> ResultMessage (subtype="success", result="Fixed...")
    
    if isinstance(message, ResultMessage):
        print(message.result)  # 只在这里获取最终答案
```

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

**完整结构**：

```markdown
---
name: "skill-name"                          # 必需，唯一标识
description: "一句话说明用途"                  # 必需，Claude 用来判断何时调用
category: "optional"                        # 可选
version: "1.0.0"                            # 可选
allowed-tools:                              # ⚠️ CLI 仅支持，SDK 不支持
  - Read
  - Write
tags: ["tag1", "tag2"]                     # 可选
---

# Skill 标题

You are a specialized AI assistant for [domain].

## Capabilities

- Capability 1
- Capability 2

## Guidelines

1. Always ...
2. Never ...

## Example

When user says "...", you should...
```

**关键字段详解**：

| 字段 | 必需 | 说明 |
|------|------|------|
| `name` | ✅ | 唯一标识，用于 `/name` 调用；目录名或 YAML 中的 key |
| `description` | ✅ | **最关键**：Claude 据此判断何时自动调用；应包含行为关键词和适用场景 |
| `category` | ❌ | 分类标签（不影响功能） |
| `allowed-tools` | ⚠️ | CLI 中有效；**SDK 中无效**，改用 `allowedTools` 选项 |

**描述范例**（好 vs 坏）：

```markdown
❌ 差：
description: "A skill for processing documents"

✅ 好：
description: "Extract text, tables, and metadata from PDF documents. Use when user asks to read, parse, or analyze PDFs."
```

### 2.2 SKILL.md 目录结构与多文件支持

```
.claude/skills/
├── pdf-processor/
│   ├── SKILL.md                    # 必需
│   ├── helper.py                   # 可选：支持脚本
│   ├── prompts/
│   │   └── extract_template.md    # 可选：Prompt 模板
│   └── README.md                   # 可选：文档
└── another-skill/
    └── SKILL.md
```

**Skill 可以包含**：
- SKILL.md（主文件，必需）
- 辅助脚本（Python、Shell、JS 等）
- 子目录和资源（图片、数据文件）
- 内嵌 Prompt 模板

CLI 和 SDK 都支持多文件 Skill；引用资源时用相对路径（相对于 SKILL.md）。

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

**自动发现与调用流程**：

```python
# SDK 代码示例
options = ClaudeAgentOptions(
    setting_sources=["user", "project"],  # ← 启用 skill 发现
    skills="all"                          # ← 选项：哪些 skill 可用
)

async for message in query(
    prompt="Process this PDF to extract tables",
    options=options
):
    # Claude 自动识别 "PDF" 关键词
    # 查找 description 匹配的 skill（如 pdf-processor）
    # 按需加载并执行
    pass
```

**显式调用**：

```
用户："/pdf-processor Extract tables from invoice.pdf"
```

**Skill 工具本身**：

- Skill 通过 `Skill` 工具被调用（不是 Bash）
- 包含在 `allowedTools` 中时自动批准
- SDK 的 `skills` 选项控制可见性

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

**派发代码示例**：

```python
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions, AgentDefinition

async def main():
    async for message in query(
        prompt="Use the code-reviewer agent to check auth.py",
        options=ClaudeAgentOptions(
            allowed_tools=["Read", "Grep", "Glob", "Agent"],
            agents={
                "code-reviewer": AgentDefinition(
                    description="Expert code review specialist for quality and security",
                    prompt="You are a code reviewer. Check for bugs, security issues, performance problems.",
                    tools=["Read", "Grep", "Glob"],  # ← 限制工具集
                    model="opus",                    # ← 可override 模型
                    max_turns=10,                   # ← 限制循环轮数
                    effort="high",                  # ← 推理深度
                ),
            },
        ),
    ):
        if hasattr(message, "result"):
            print(message.result)

asyncio.run(main())
```

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

**两种编程模式**：

1. **使用 `query()` 函数**（推荐，简洁）：
   ```python
   async for message in query(
       prompt="...",
       options=ClaudeAgentOptions(...)
   ):
       pass
   ```

2. **使用 `ClaudeSDKClient` 类**（Python，多轮状态管理）：
   ```python
   client = ClaudeSDKClient(options=...)
   response = await client.request(prompt="...")
   ```

**核心概念**：

- **无状态 API**：每次 `query()` 或 `.request()` 是独立调用
- **会话延续**：捕获 `ResultMessage.session_id`，用 `resume=session_id` 继续
- **流式输出**：使用 `async for` 逐个处理消息，实时响应
- **成本控制**：设置 `maxBudgetUsd` 和 `maxTurns` 防止失控

---

## 4. 工具调用与 Function Calling

### 4.1 工具定义格式（JSON Schema）

**官方文档**: https://code.claude.com/docs/en/agent-sdk/custom-tools

**自定义工具创建流程**：

```python
from claude_agent_sdk import tool, create_sdk_mcp_server
from typing import Any

# 定义工具：名称、描述、入参schema、处理函数
@tool(
    name="get_temperature",
    description="Get the current temperature at a location",
    input_schema={"latitude": float, "longitude": float},  # 简单 dict schema
)
async def get_temperature(args: dict[str, Any]) -> dict[str, Any]:
    # args 已被验证，对应 schema 定义
    lat, lon = args["latitude"], args["longitude"]
    
    # ... 调用外部 API ...
    
    return {
        "content": [
            {"type": "text", "text": f"Temperature: {temp}°F"}
        ]
    }

# 包装成 MCP 服务器
weather_server = create_sdk_mcp_server(
    name="weather",
    version="1.0.0",
    tools=[get_temperature],  # 可多个
)
```

**复杂 Schema 示例**（用 JSON Schema dict）：

```python
@tool(
    name="convert_units",
    description="Convert between units",
    input_schema={
        "type": "object",
        "properties": {
            "unit_type": {
                "type": "string",
                "enum": ["length", "temperature", "weight"],  # 枚举
            },
            "value": {"type": "number"},
        },
        "required": ["unit_type", "value"],  # 必需字段
    },
)
async def convert_units(args: dict) -> dict:
    # ...
    pass
```

### 4.2 Tool Use / Tool Result 消息块结构

**AssistantMessage 中的 Tool Use 块**：

```python
# Claude 决定调用工具后
AssistantMessage(
    content=[
        {
            "type": "tool_use",
            "id": "tool_use_abc123",        # 唯一 ID（用于结果匹配）
            "name": "get_temperature",      # 工具名
            "input": {                      # 工具输入
                "latitude": 37.7749,
                "longitude": -122.4194,
            },
        },
        # 可有多个工具调用
        {
            "type": "tool_use",
            "id": "tool_use_def456",
            "name": "get_precipitation_chance",
            "input": {...},
        },
    ]
)
```

**UserMessage 中的 Tool Result 块**（SDK 自动生成）：

```python
UserMessage(
    content=[
        {
            "type": "tool_result",
            "tool_use_id": "tool_use_abc123",  # ← 匹配 AssistantMessage 的 id
            "content": [
                {"type": "text", "text": "Temperature: 62°F"}
            ],
            # 可选标记工具调用失败
            "is_error": False,
        },
        {
            "type": "tool_result",
            "tool_use_id": "tool_use_def456",
            "content": [
                {"type": "text", "text": "Precipitation: 30%"}
            ],
        },
    ]
)
```

### 4.3 并行工具调用与顺序执行

**并行规则**：

- **读操作**（Read, Grep, Glob, WebSearch）：可并行
- **写操作**（Edit, Write, Bash）：顺序执行（防止冲突）
- **自定义工具**：默认顺序；若标记 `readOnlyHint: true` 则可并行

**代码示例**：

```python
from claude_agent_sdk import tool, ToolAnnotations

@tool(
    name="query_database",
    description="...",
    input_schema={...},
    annotations=ToolAnnotations(readOnlyHint=True),  # ← 允许并行
)
async def query_db(args):
    # 只读，可与其他只读工具并行
    pass
```

### 4.4 错误处理：异常 vs 返回 is_error

**规则**：

```python
# ❌ 不要：抛异常（中断循环）
if not response.ok:
    raise ValueError("API failed")

# ✅ 应该：返回 is_error 让 Claude 处理
return {
    "content": [
        {"type": "text", "text": "API failed: 404"}
    ],
    "is_error": True,  # ← Claude 看到失败，可重试或换方案
}
```

**工具结果返回结构**（完整）：

```python
return {
    "content": [                      # 必需：内容数组
        {"type": "text", "text": "..."},
        {"type": "image", "data": "base64...", "mimeType": "image/png"},
        # 支持：text, image, audio, resource, resource_link
    ],
    
    "is_error": False,               # 可选：标记失败
    
    "structuredContent": {           # 可选：机器可读的结构化数据
        "temperature": 62.0,
        "unit": "fahrenheit",
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

**加载条件**：

```python
options = ClaudeAgentOptions(
    setting_sources=["user", "project"],  # ← 必须显式启用
)

# 默认 query() 启用两个源；显式设置时需包含
```

**CLAUDE.md 的特点**：

- ✅ **持久化**：跨会话保存；通过 git 共享
- ✅ **自动注入**：每次请求都重新加载并注入对话
- ✅ **不入系统提示词**：作为上下文（第一条消息），不消耗系统提示词 token
- ✅ **自动缓存**：Prompt cache 机制（首次完整价格，后续 0.1x）
- ❌ **不是 Memory API**：无智能提取、无遗忘管理

**内容指导**：

```markdown
# 项目名与使命
简洁说明项目目的、技术栈、关键约束

## 编码标准
- 语言特定规范（Python/TypeScript）
- 命名约定
- 目录结构约定

## 关键概念与域名语言
定义项目特有的概念、术语、角色，避免歧义

## 上下文压缩指引
当上下文过长时，告诉 Claude 什么必须保留：
- 当前任务目标
- 已读/已改的文件路径
- 测试结果
- 关键决策理由

## 禁止与合规
- 不该做的事
- 安全边界
- 数据隐私规则
```

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

**何时启用缓存**：

```python
# 方法 1：自动缓存（推荐多轮对话）
response = client.messages.create(
    model="claude-opus-4-8",
    cache_control={"type": "ephemeral"},  # 5分钟缓存
    system="System prompt...",
    messages=[...],
)

# 方法 2：显式指定缓存点（精细控制）
response = client.messages.create(
    system=[
        {
            "type": "text",
            "text": "Large system prompt that stays same...",
            "cache_control": {"type": "ephemeral"},
        }
    ],
    messages=[...],  # 后续消息不缓存（变化的部分）
)

# 方法 3：预热缓存（用户到达前）
client.messages.create(
    model="claude-opus-4-8",
    max_tokens=0,  # 无输出，仅缓存
    system=[{"type": "text", "text": "...", "cache_control": {...}}],
    messages=[{"role": "user", "content": "warmup"}],
)
```

**SDK 中的自动缓存**：

```python
# Agent SDK 在以下场景自动缓存：
# 1. System prompt（claude_code preset 或 custom）
# 2. CLAUDE.md（projectsetting source）
# 3. Tool definitions（内置 + MCP）
# 4. Skill 元数据和完整内容

# → 用户仅需设置，无需显式 cache_control
async for message in query(
    prompt="...",
    options=ClaudeAgentOptions(
        system_prompt={"type": "preset", "preset": "claude_code"},
        setting_sources=["project"],
        # SDK 自动处理缓存
    ),
):
    pass
```

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

**如果需要长期学习**（如你的"店脑"），方案：

```python
# 每次生成后，从 Claude 的回复提取重要信息
async for message in query(prompt="..."):
    if isinstance(message, ResultMessage):
        # 人工解析 message.result
        # 存入 CLAUDE.md 或 数据库
        # 下次 query 时注入
        store_learning(message.result)
```

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

