# WorkBuddy 与本项目底座差异及项目理解校正

> 状态：架构与产品决策稿
> 形成日期：2026-07-13
> 输入：本机 WorkBuddy 5.2.5、本仓库代码与 `CLAUDE.md`、`ts/CLAUDE.md`、当前架构/目标/产品大脑文档
> 目的：回答“底座是否相同”“当前项目理解哪里有偏差”“大厂通用 Agent 变强后，这个台球产品是不是伪需求”

## 0. 直接回答

你的核心理解成立，但要把“coding 是默认场景”与“Agent 的能力边界”分开。

对的部分：

- WorkBuddy、Claude Code、cc-haha 和本项目都采用了 coding-agent/harness 的共同语义：模型循环、工具调用、权限模式、文件与命令、skills、hooks、MCP、任务和上下文管理。这套内核本质上是**通用执行 Agent**，编码是它最成熟的默认任务分布，不是能力上限。
- 你用 cc-haha 作为内核行为规格，能较快获得一个强 Agent kernel，这条工程路线成立。
- 模型本身能写文章、理解文档、做分析和问答；harness 再给它文件、表格、浏览器、电脑操作、生图和媒体工具，就能处理编码之外的真实任务。WorkBuddy 保留英文“software engineering tasks”母提示词，同时扩展 `ComputerUse`、`ImageGen`、connector 等能力，就是现成证据。
- “通用 Agent + 台球知识”是成立的领域化架构：它可以直接支持台球问答、经营分析、文案和开放式执行，不需要为每个问题预编一套 SOP。
- 台球从业者不需要先知道 Claude/Codex/WorkBuddy，产品仍然可以通过更低门槛、更贴近业务的入口创造价值。

需要校正的部分：

- **“都抄 Claude Code，所以底座一样”不成立。** 相同的是 harness 概念和部分行为语义，不是进程模型、传输、信任边界、数据层和产品层。
- **可以高置信度确定 WorkBuddy/CodeBuddy Code 是 Claude Code 衍生的深度魔改。** 它不是只借了 Agent 概念：系统提示词存在多段逐句长文本重合，CLI 参数名/说明/顺序、工具名与 Schema、权限字段、plan/tasks/teams/hooks/worktree 行为也成组一致，并有 CodeBuddy 白标替换痕迹。“完全独立实现、只是恰好相似”不符合证据。
- **“魔改 Claude”不等于“原封不动内嵌官方 Claude 二进制”。** WorkBuddy 又用自己的 `@genie/agent-cli`、`@genie/*` 服务、OpenAI Agents Runner、ACP、sidecar、connector 和多 provider 替换/扩展了大量运行层。安装包足以支持工程上的“Claude Code-derived”判断，但不能单独法证它拿到哪份 Anthropic 源仓库、逐文件复制比例或法律来源。
- **cc-haha 适合作为 Agent kernel 的行为 oracle，不是完整桌面产品安全规格。** Electron、IPC、loopback、凭据、插件、更新、遥测和供应链必须由本项目自己负责。
- **“用户不知道大厂产品”不是可持续壁垒。** 这只是暂时的分发/认知空档；豆包、WorkBuddy 或其他产品一旦把入口做得更简单，这个空档会迅速消失。
- **“只做知识注入就没价值”也不成立。** 高质量、有来源、能随门店记忆更新的行业知识，本身就能降低获取和应用专业经验的门槛。需要验证的是知识质量、任务完成率、复用和付费，不是先验证它像不像传统工作流软件。
- **当前不能判定它是伪需求，也不能判定需求成立。** 仓库证明了技术能力，不证明门店愿意持续使用或付费。现在准确状态是：`技术可行，需求假设未验证`。

最终建议：

> 继续对齐 Claude Code/cc-haha 的通用执行内核，不因为产品面向台球就削弱 coding-agent 能力。台球专家首先走“英文内核行为契约 + 中文领域知识/记忆 + 通用工具”的模型驱动路线；只对已证明高频、必须确定性交付或涉及安全边界的任务增加结构化产品功能。同时用真实门店验证回答质量、任务完成、复用和付费。

## 1. 三种“底座”不能混为一谈

讨论底座时必须先分层：

| 层 | 问题 | 典型内容 |
|---|---|---|
| 模型层 | 谁生成下一步 | Claude、GPT、MiMo、豆包等 |
| harness/kernel 层 | 模型怎样持续做事 | ReAct/tool loop、permissions、skills、hooks、context、tasks |
| 宿主平台层 | 代码怎样在用户电脑上安全运行 | Electron、sidecar、IPC、HTTP/WS、进程隔离、凭据、插件、更新 |
| 领域/产品层 | Agent 懂什么、能完成什么 | 台球知识包、门店记忆、领域工具，以及按需增加的生图/视频/定时等确定性功能 |

“都像 Claude Code”最多描述第二层。真正决定产品是否相同的是第三、第四层，而这两层 WorkBuddy 与本项目差异很大。

## 2. WorkBuddy 的实际底座

### 2.1 是否魔改 Claude Code：确定性结论

结论分四层，不能再含糊写成“只是受范式影响”：

| 命题 | 结论 | 置信度 |
|---|---|---|
| WorkBuddy 只是 Electron 套官方 Claude Code 可执行文件 | 否 | A |
| WorkBuddy 是从零独立设计、仅使用通用 Agent/MCP 概念 | 否 | A |
| WorkBuddy 以 Claude Code 的提示词、CLI、工具/权限契约和行为作为母体，再做白标、移植、替换和扩展 | **是，即深度魔改/衍生实现** | A/B |
| WorkBuddy 具体复制了 Anthropic 哪个私有源码版本、复制比例多少 | 安装包无法法证 | C/未知 |

#### 证据一：系统提示词不是风格相似，而是逐句重合

WorkBuddy 的 `cli/product.json:880` 保存完整 Nunjucks 主提示词。在本机 Claude Code 2.1.207 可执行产物和 `cc-haha-ref` 对应源码中，可以找到多段相同的长句与相同顺序，包括：

- 交互式 CLI 软件工程助手的身份句。
- 只有用户要求时才用 emoji 的规则。
- 非必要不新建文件、优先编辑已有文件的规则。
- 工具调用前不要用冒号及其同一个示例。
- 先读代码再提修改、避免过度设计等工作规则。

WorkBuddy 在这些段落外插入自己的内容政策、文档地址和 CodeBuddy 品牌。随机独立实现不太可能同时复现多段非协议性长文本、顺序和例子；这是直接移植/白标提示词的强证据。

本地对照锚点：

- WorkBuddy：`cli/product.json:880`。
- Claude 对照源码：`cc-haha-ref/src/constants/prompts.ts:432`、`:438`，`src/tools/AgentTool/built-in/generalPurposeAgent.ts:15`。
- 本机官方产物：`~/.local/share/claude/versions/2.1.207`（只做 strings/字面量核对，不写入仓库）。

#### 证据二：CLI 表面成组同名、同文案、同顺序

WorkBuddy bundle `codebuddy.bun.js:142357` 附近的 commander 链与 Claude Code 高度同构：

- `-p/--print`、`--output-format`、`--input-format`、`--json-schema`。
- `-y/--dangerously-skip-permissions`、`--permission-mode`、`--allowedTools`、`--disallowedTools`、`--add-dir`。
- `--mcp-config`、`--strict-mcp-config`、`--continue`、`--resume`、`--worktree`、`--max-turns`、`--agents`、`--settings`、`--setting-sources`、`--replay-user-messages`。
- 多条 help 文案逐句相同，例如“只在无外网沙箱中使用 bypass”的说明。

这不是 ACP/MCP 标准规定的表面，而是 Claude Code 产品自己的 CLI 契约。WorkBuddy 在同一链上新增 `--serve`、ACP transport、E2B/container sandbox、图片模型和远程控制，体现的是“保留母体再扩展”。

#### 证据三：工具协议和内部行为一起迁移

WorkBuddy `codebuddy.bun.js:222653`、`:223248`、`:228207` 等位置保留了 Claude Code 的特征组合：

- `Read/Write/Edit/MultiEdit/NotebookEdit/Bash/BashOutput/Glob/Grep/TodoWrite/WebFetch/WebSearch`。
- `Agent/TaskOutput/TaskCreate/TaskGet/TaskUpdate/TaskList/TaskStop`。
- `EnterPlanMode/ExitPlanMode/TeamCreate/TeamDelete/SendMessage/EnterWorktree`。
- Agent 参数中的 3-5 词任务描述、`subagent_type`、resume/background/name/team/mode 等 Schema 与文案。
- 子代理不能自行进入/退出 plan、进入 plan 前保存权限模式、退出时恢复、teammate 向 team lead 发 plan approval 的同类状态机。
- `PreToolUse/PostToolUse/UserPromptSubmit/SessionStart/SubagentStart/SubagentStop` 事件名、hook payload 和 permission decision 语义。

单独一个工具名可能是兼容设计；几十个工具、字段、提示文案、错误消息和分支顺序一起重合，已经超过“API 兼容层”的最低需要。

#### 证据四：设置与权限模型是 Claude Code 白标

WorkBuddy 内置文档和运行代码保留：

- `default/acceptEdits/plan/bypassPermissions/dontAsk` 权限语义。
- `allow/ask/deny`、`userSettings/projectSettings/localSettings/flagSettings/policySettings/session` 来源。
- `disableBypassPermissionsMode`、`additionalDirectories`、`subagentPermissionMode`。
- `.codebuddy/settings.json` / `.codebuddy/settings.local.json`，对应 Claude 的 `.claude/*` 路径替换。
- Bash 复合命令、重定向、文件路径、MCP、Agent、Skill 的同类规则语法。

WorkBuddy 的 monitoring 文档还明确写出：兼容 `CLAUDE_CODE_ENABLE_TELEMETRY`，OTEL span 命名、属性和截断策略对齐 Claude Code。这是产品自己承认的兼容目标，虽然它单独不能证明源码来源，但与前三组证据相互印证。

#### 证据五：运行内核已经被明显替换和扩展

WorkBuddy 又不是简单重命名版：

- `cli/package.json` 依赖 `@openai/agents` 和 `@openai/agents-core`，而 `cc-haha-ref` 的 Claude 路径直接依赖 `@anthropic-ai/sdk`。
- WorkBuddy bundle 存在 `AgentManagerImpl`、`DefaultAgentFactory`、`RunnerFactoryImpl`、`RunnerProviderImpl` 和按优先级串联的 `AgentRunInterceptor` 体系。
- 其 interceptor 覆盖 env、history、message reorganize、sandbox、memory、image、telemetry、token calculation 等阶段。
- 桌面侧再增加 ACP/HTTP、每会话 CLI service、sidecar socket、connector proxy、MCP Apps 和自带 Node runtime。

因此最准确的架构表述是：

> **Claude Code-derived 行为/契约母体 + CodeBuddy 自有 Agent Runner/多模型适配 + WorkBuddy 多进程桌面平台。**

这就是工程意义上的“魔改 Claude”，不是“官方 Claude 二进制套壳”，也不是从零洁净重写。

### 2.2 本地包证据

WorkBuddy 5.2.5 的桌面包名是 `@genie/workbuddy-desktop`，内置 CLI 是 `@genie/agent-cli`。其依赖和产物直接表明它不是一个薄 Electron 壳：

- Agent Client Protocol (`@agentclientprotocol/sdk`)。
- MCP SDK。
- `@openai/agents` 和多模型/provider 适配。
- `@anthropic-ai/sandbox-runtime`。
- 自有 authentication、enterprise-policy、prompts、runtime、telemetry 等包。
- 独立 sidecar、connector proxy、MCP app、Node runtime 和桌面服务。

这证明它拥有自己的 Agent 平台实现；结合上一节的逐句/逐契约证据，应把它定性为 Claude Code 衍生平台，而不是仅“相似”。

### 2.3 进程与传输结构

```text
WorkBuddy Electron main
  -> sandboxed renderer + 多个窄/宽不一的 preload
  -> stdio daemon app server
  -> sidecar control（Unix socket / Windows named pipe）
       -> 每个会话一个 `agent-cli --serve` 进程
            -> loopback ACP/HTTP（真实会话传输）
       -> connector proxy（bearer + Host/Origin）
       -> 每个 stdio MCP / MCP App 可再起独立 Node 进程
```

可执行注释明确写出：每个 session 承载一个 CLI `--serve` 实例，桌面真正通过 `127.0.0.1` 上的 ACP HTTP 通信，PTY 主要用于历史日志/TUI 路径。sidecar 还负责进程生命周期、session socket、端口和恢复。

### 2.4 这种结构带来的性质

优势：

- 单会话 CLI 崩溃和内存泄漏更容易局部隔离。
- 每个会话可以有独立环境、端口和生命周期。
- CLI 本身可复用于终端、IDE、桌面等多宿主。
- MCP/connector/daemon 职责较清晰，适合多产品线。

代价：

- 进程数量、内存、端口/socket 和恢复状态更复杂。
- bearer、环境变量和子进程继承形成更多泄密面。
- Electron、app server、sidecar、CLI、MCP 多层契约更容易漂移。
- 多进程本身不是安全隔离；若都使用同一 OS 用户权限，仍可互相影响文件和凭据。

## 3. 本项目的实际底座

### 3.1 当前结构

```text
本项目 Electron main（Node）
  -> preload 白名单
  -> React renderer / 过渡期 vanilla renderer
  -> 一个共享 Bun backend-sidecar（127.0.0.1）
       -> REST + WebSocket /agent/ws
       -> 多会话 ReAct/permission/tool/task 状态在同一进程
       -> JSONL transcript + JSON 元数据
       -> 按需 spawn ffmpeg / whisper / MCP / shell 等外部进程
       -> 大陆 gateway / 美国 relay / dataeye / 模型与媒体服务
```

Renderer 通过 Electron IPC 取得 sidecar 地址，再直接使用 REST/WS。`ts/src/server/index.ts` 同时拥有大量路由、会话状态、Agent 运行、MCP、媒体和产品服务。所有会话共享一份 Bun 进程和大部分进程级资源。

### 3.2 当前结构的优势

- 进程少、冷启动快、内存和部署复杂度较低。
- Agent kernel、媒体任务、门店数据和前端接口在一个 TypeScript 工程内迭代快。
- JSONL/JSON 与 cc-haha 行为路线一致，调试和迁移成本低。
- 产品特有的生图、真实素材剪辑、网关、relay 和门店知识可以直接编排。

### 3.3 当前结构的代价

- 一次 sidecar 崩溃可能影响全部会话、媒体任务和审批状态。
- 进程级 singleton、Map、环境变量和全局 sandbox manager 的影响半径更大。
- REST/WS 暴露面大，而当前只有 loopback/CORS，没有启动级鉴权。
- `server/index.ts` 承担过多连接和编排职责，安全策略难形成一个可证明的总状态。
- 用户能看到的是通用 coding-agent UI，门店经营结果还没有成为唯一主流程。

## 4. Claude Code、cc-haha、WorkBuddy、本项目的准确关系

| 维度 | Claude Code | cc-haha / 本地参考 | WorkBuddy 5.2.5 | 本项目 |
|---|---|---|---|---|
| 可核源码范围 | 只讨论公开可见行为/文档，不推测闭源实现 | 本地参考源码可直接读，许可允许使用/修改 | 本地打包产物可逆向，闭源专有 | 全仓库可控 |
| 本项目中的角色 | 行业范式与外部行为参照 | **kernel 行为 oracle** | 桌面平台、安全交互、产品反例/参考 | 最终责任主体 |
| Agent loop | 以编码为默认场景的通用执行 Agent | 供本项目迁移/对齐 | Claude 契约/提示词母体 + 自有 `@genie/agent-cli`/OpenAI Agents Runner | Bun 内进程实现 |
| 会话运行 | 不在本文臆测内部进程 | 以参考代码为准 | 每会话 CLI `--serve` | 多会话共享 sidecar |
| 主传输 | 不臆测 | 参考实现自己的接口 | ACP/HTTP + sidecar socket | REST + WebSocket |
| 产品范围 | 以软件工程为强默认，模型和工具可处理更广任务 | kernel/桌面参考 | 通用桌面 Agent 平台、连接器等 | 通用 Agent kernel + 可挂载台球领域包 + 媒体产品能力 |
| 安全责任 | 其产品自己承担 | 不能替代本项目宿主安全 | 有完整但并非全优的产品安全层 | 必须新增高于 cc 兼容的安全不变量 |

### 4.1 系统提示词与语言的确定策略

WorkBuddy 的真实实现已经给出了一个可直接复用的结构：

- `cli/product.json:880` 的主提示词保留了大段英文 Claude Code 行为契约，包括语气、做任务、权限、工具和输出效率。
- 它没有为了做通用桌面 Agent 就删掉“software engineering tasks”，而是通过增加 `ComputerUse`、`ImageGen`、connector、领域 skill 和宿主能力扩展任务边界。
- 同一份模板的 `# Language` 另行规定：即使工具描述和系统指令是英文，用户沟通、任务和自然语言工具参数仍必须使用用户选定的语言。

因此，本项目不必把内核提示词全部翻译成中文。更稳的分层是：

| 层 | 建议语言 | 处理方式 |
|---|---|---|
| Agent kernel 行为契约 | **优先保留英文** | 从许可明确的 `cc-haha-ref` 建立上游对照，对已验证长句尽量保持原意和顺序，避免中译时丢掉限定条件 |
| 产品身份、白标和安全增量 | 独立短块 | 不改写整份母提示词；以可删除、可评测的 patch 形式叠加 |
| 台球知识、门店记忆与业务语料 | **中文** | 保留行业术语、语境和原始来源，不为了统一语言做二次翻译 |
| 输出语言 | **明确指定中文** | 用单独的 language section 约束用户回复、任务标题和自然语言参数；不需要为此复制一份中文内核提示词 |

“英文一定更高质量”不能当成无条件事实；不同模型的训练和对齐分布不同。但在当前场景下，**保留已被 Claude Code/cc-haha 长期打磨的英文内核条款，比自由中译更容易保持行为等价和跟踪上游变化**。最终仍要用当前所接模型做 A/B 行为评测，而不是凭语言偏好定优劣。

来源边界也要分清：**可以从本项目已确认许可的 `cc-haha-ref` 移植内核提示词；WorkBuddy 解包出的专有模板只用于对照，不复制它新增的品牌、政策、文档链接和产品特有段落**。与 Claude/cc-haha 共同的长句，工程来源应记为许可参考库，不记为 WorkBuddy。

应该继续对齐 cc-haha 的内容：

- tool loop、content block、stream/replay。
- permission 基本语义和规则匹配。
- 文件工具、命令解析、skills/hooks/tasks/context 等确定性行为。
- 对应刁钻边界测试。

不应由 cc-haha 决定的内容：

- Electron IPC、导航、CSP。
- sidecar 本地鉴权。
- OS 凭据和 MCP token 落盘。
- 插件 quarantine、签名和更新供应链。
- 遥测/隐私默认值。
- “完全访问”是否允许宿主灾难级动作。
- 台球产品的工作流、验收和商业价值。

## 5. 对当前项目理解的逐条校正

| 当前理解 | 判断 | 更准确的口径 |
|---|---|---|
| “我和 WorkBuddy 都是抄 Claude Code 底座” | 部分正确 | 都使用同类 harness 语义；WorkBuddy 是自有多进程平台，本项目是 cc-haha 行为对齐的共享 Bun runtime |
| “WorkBuddy 就是 Claude 的底座/魔改 Claude” | **工程判断基本正确，但表达要精确** | 可确定它是 Claude Code-derived 深度魔改；不是官方 Claude 二进制套壳，具体私有源码来源和逐文件复制比例无法由安装包法证 |
| “coding agent 只适合写代码” | 不准确 | coding 是默认任务和工具命名；模型循环 + 文件/浏览器/电脑/媒体工具构成通用执行 Agent，可处理文档、文章、表格、研究和运营任务 |
| “台球知识只放进 prompt 就一定是弱产品” | 不准确 | 对问答、规划、分析和开放式创作，prompt/RAG/记忆就是正确落点；只有高频确定交付、强状态或高风险动作才需升级为结构化功能 |
| “英文内核提示词会影响中文产品” | 不必然 | 内核契约可保留英文，台球知识保留中文，另用 language section 强制中文交互；WorkBuddy 已采用这种混合结构 |
| “全方位照 cc 就能得到强桌面 Agent” | 只对 kernel 成立 | kernel 可对齐；桌面安全、供应链和产品闭环必须另建 |
| “全本地” | 不准确 | 本地优先执行；推理、媒体、资产、遥测和部分连接器依赖云端 |
| “权限 + 沙箱 + 备份就是安全” | 不完整 | renderer、IPC、loopback、secret、plugin、MCP、update、telemetry、data lifecycle 同等重要 |
| “沙箱默认开” | 过度表述 | macOS/Linux 配置默认开，但初始化可静默降级；Windows/全盘会话没有等价保证 |
| “改文件前备份，所以能回滚” | 过度表述 | 文件工具有快照；大文件/异常可跳过，shell 写删不受完整覆盖 |
| “完全访问就是用户知情后全部放行” | 不应成为产品规则 | full access 减少普通审批，不能取消宿主灾难级和真实外发/身份操作的不变量 |
| “共享契约已统一” | 只完成一部分 | 多处已有 shared contract，但 desktop host 等仍为手写接口，server 路由也有 raw body 解析 |
| “大厂做的一定更安全/更懂产品” | 不成立 | 规模提供工程投入和样本，不提供自动正确性；WorkBuddy 本身也有宽 IPC/CSP/遥测/更新等风险 |

根 `CLAUDE.md` 与 `ts/CLAUDE.md` 后续需要把这些校正写回唯一真相源。尤其要去掉“危险命令完全访问档一律放行”作为产品铁律，以及“全本地”“备份可回滚”的无条件表达。

## 6. 大厂通用 Agent 变强后，这个产品还有没有用

### 6.1 coding agent 是默认场景，不是能力边界

Agent 能做什么，由下面四项共同决定：

```text
模型的通用推理/生成能力
  + 系统提示词给它的默认任务偏置
  + 实际可调用的工具
  + 当前上下文、知识和权限
```

Claude 模型本来就能写文章、摘要文档、分析表格和做通用问答。Claude Code 在此之上给它文件、shell、任务、浏览器和扩展工具，所以产品默认擅长软件工程，但不会因此丧失非编码能力。

WorkBuddy 更直接：它连“You are an interactive CLI tool that helps users with software engineering tasks”都保留了，但仍然在同一内核上跑通用桌面 Agent、图片、电脑操作和 connector。这证明“保留 coding-agent 母体”与“扩展非编码能力”并不冲突。

通用能力会快速商品化，但这影响的是差异化，不是技术路线正当性。对齐 Claude Code/cc-haha 仍然是得到强通用 Agent kernel 的合理捷径。

### 6.2 台球知识注入是成立的第一阶段

对于下列任务，“通用 Agent + 领域 prompt/RAG + 门店记忆 + 工具”就是正确实现，不需要另写确定性 SOP：

- 解释台球行业知识、经营方法和 PPT 内容。
- 结合具体门店情况做诊断、比较和规划。
- 写活动方案、文案、制度、培训材料和复盘。
- 在用户变更目标或输入不完整时，动态选择工具并迭代结果。

要分开三个问题：

| 层次 | 要证明什么 | 当前判断 |
|---|---|---|
| 懂 | 模型能否使用台球知识正确回答 | 架构已成立，回答质量需专项 eval |
| 做 | 能否调用文件、媒体、浏览器等工具完成结果 | 内核已有大量能力，真实任务完成率待验证 |
| 产品成立 | 门店是否复用、依赖并付费 | 尚无实证 |

知识注入只在下列情况才会成为“换名字”：知识与通用模型无显著差异；内容没有来源、不能更新；Agent 读不到真实门店信息；回答无法通过行业题集验证；或结果与用户直接问通用模型没有可感知差异。

### 6.3 但“用户不知道底层技术”不是问题本身

大多数人也不知道数据库、PS、剪辑引擎或推荐算法，仍然会购买带来结果的软件。用户不必知道 Claude/Codex，关键是：

- 他是否反复遇到一个足够痛的任务。
- 当前是否花了明确的时间、人工、外包费或机会成本。
- 产品是否减少输入和判断，而不是增加学习 Agent 的负担。
- 产物是否能直接进入经营动作。
- 使用一段时间后，领域知识、门店记忆和使用反馈是否让结果持续变好。

所以问题不是“他们懂不懂 Agent”，而是“没有这个产品时，他们具体损失什么；用了以后，什么指标稳定改善”。

### 6.4 当前最诚实的结论

| 判断 | 当前证据 |
|---|---|
| 技术可做 | 已有 Agent、权限、媒体、门店知识、scheduled tasks 等大量实现 |
| 台球知识存在 | 有 PPT-only 口径、运营基准、字段字典和包机制 |
| 领域问答架构成立 | 领域包每回合进系统提示，门店记忆与通用 Agent 工具可同时使用 |
| 领域回答显著优于通用模型 | **需用台球 eval 题集对比，尚未证明** |
| 有真实门店高频需求 | **仓库内没有证据** |
| 用户能无需辅导完成真实结果 | **尚未证明** |
| 用户会持续复用 | **尚未证明** |
| 用户愿意付目标价格 | **尚未证明** |
| 大厂通用 Agent 无法替代 | **尚未形成** |

因此不能说“这是伪需求”，也不能再按“需求已成立”投入。它是一个需要尽快做失败验证的产品假设。

## 7. 建议的产品定位：内核通用，领域按两条线落地

### 7.1 双层定位

内部平台：

> 强通用执行 Agent kernel。继续对齐 cc-haha，负责可靠执行、权限、安全、任务、文件、文档、浏览器、媒体和扩展能力。

外部产品：

> 懂台球经营、也能操作电脑把事做完的通用助手。用户可以直接问、让它分析或交办开放式任务；对高频、确定的功能再从专用工作台进入。

通用对话可以继续是主入口，不需要为了“像垂直软件”就隐藏 Agent。但界面不必迫使门店用户先理解模型、MCP、工作区和 permission mode；技术概念按需渐进披露即可。

### 7.2 领域能力按 A/B 两条线处理

| 线 | 适用任务 | 正确落点 | 不该做什么 |
|---|---|---|---|
| A 线：模型驱动 | 问答、诊断、规划、文案、文档、开放式交办 | Claude Code/cc-haha 循环 + 台球 prompt/RAG + 门店记忆 + 通用/领域工具 | 不要把“用户说 X”穷举成写死的 1-2-3 SOP |
| B 线：确定性产品 | 生图工作台、视频工具、定时任务、资产导出、高风险外发和确定性校验 | 结构化契约 + 确定性代码；需要时以工具提供给 Agent | 不要把产品状态机和安全边界全交给 prompt 猜 |

知识注入不是“低级版本”，结构化工作流也不是每个领域任务的必修课。只有当真实使用反复证明某个任务高频、输入输出稳定、需要恢复/审批或涉及安全边界时，才把它从 A 线提升成 B 线功能。

未来的价值可以同时来自：有来源的行业知识与评测题集、门店专属记忆、通用 Agent 的强执行力、领域工具、按需出现的确定性功能，以及行业渠道、服务和信任。不必预先指定只能由哪一层构成壁垒。

### 7.3 第一切口不要同时做全部经营

基于本仓库现状和《球房运营逻辑基准》“营销是重中之重”的口径，最接近可验证成品的候选切口是：

> **门店真实素材 -> 一次活动/一周内容 -> 海报、朋友圈文案、短视频 -> 店主确认 -> 导出 -> 记录采用与效果。**

选择它不是因为已经证明市场需求，而是因为：

- 当前已有生图、真实素材剪辑、文案、门店画像和任务能力，验证成本最低。
- 输入和交付物具体，能观察完成时间、采用率和复用率。
- 可以用门店真实素材检验结果，不需要先接复杂 POS。

风险也要明说：内容生成竞争最激烈、单次价值可能低、用户可能直接用剪映/豆包/外包。因此它只能作为**验证切口**，不能预设为最终护城河。

如果访谈证明内容不是最痛任务，就按证据换切口；不要因为代码已经写了而强迫市场接受。

## 8. 可证伪的需求验证门

以下数字是本项目的管理决策阈值，不是假装成行业统计。价格 `P_target` 必须在测试前由 owner 固定，不能看到反馈后临时降价美化结果。

### 阶段 A：问题验证（12 家真实门店，7 天）

做法：

- 至少覆盖店主/店长/实际内容执行者三种角色。
- 不问“你想不想要 AI”，让对方现场展示最近两周真实任务、素材、产物、耗时和返工。
- 记录现在由谁做、多久一次、用什么工具、花多少钱、为什么拖延、什么算合格。
- 只讨论已经发生的行为，不把口头兴趣计入需求证据。

通过门槛：

- 至少 8/12 家存在同一类每周或更高频任务。
- 至少 8/12 家能拿出真实输入与旧产物，而不是只说“应该有用”。
- 至少 6/12 家当前为它付出明确人工时间、外包费或错失发布。

未通过：停止为该切口增加功能，回到问题选择；不进入 beta。

### 阶段 B：人工陪跑验证（8 家，连续 2 周）

用当前产品 + 必要的人工 concierge 完成真实任务。人工可以帮助操作，但必须记录每分钟帮助和每次开发者改稿。

通过门槛：

- 6/8 家在 30 分钟内完成第一次真实交付。
- 至少 4/8 家在第二周主动再次使用，不靠提醒代操作。
- 门店实际采用/导出的交付物比例不低于 70%。
- 相对原流程，门店主动操作时间中位数下降至少 50%。
- 开发者人工修改不超过每个交付物 10 分钟，否则说明产品没有真正完成工作。
- 至少 3/8 家按预先固定的 `P_target` 支付订金或首月款；“以后可能买”不算。

未通过：

- 采用率低：输出质量/任务选择不成立。
- 使用但不复用：低频或一次性需求。
- 复用但不付费：价值不足或付费方不对。
- 高人工才能完成：产品闭环未成立，不能按 SaaS/软件规模化假设推进。

### 阶段 C：无陪跑 beta（20 家，4 周）

通过门槛：

- 首次真实结果完成率至少 60%。
- 第 4 周仍有真实结果产出的门店至少 40%。
- 至少 30% 按 `P_target` 付费。
- 每店每周人工支持中位数低于 20 分钟。
- 关键交付失败、敏感数据误用、未授权外发为 0。

只有阶段 C 通过，才把需求写成“初步成立”；此前所有文档统一写“待验证”。

### 必须埋的最小指标

在用户明确同意的前提下，只记录结构化元数据，不传内容：

- `workflow_started/completed/abandoned`
- 首次结果耗时、重试次数、人工帮助分钟数
- 产物 `accepted/exported`，不记录产物正文
- 第二周/第四周是否重复完成同一工作流
- 用户给出的失败原因枚举
- 付费/退款状态

这些指标服务需求判断，不得借机恢复默认原始日志上传。

## 9. 产品与开发路线调整

### D0：先验证，同时继续补强通用内核

在阶段 A/B 完成前：

- 继续修 P0 安全和阻断真实使用的稳定性问题。
- 继续对齐对所有场景都有价值的 Claude Code/cc-haha kernel 能力；不因为台球需求还在验证就停止内核建设。
- 不为了“竞品有所以我也要有”盲目增加独立功能；但后台 Agent、文档、浏览器、电脑操作等通用执行原语本身仍是主线。
- 先直接用“通用对话 + 台球知识包 + 门店记忆 + 工具”验证问答质量和开放式任务，不以是否已有专用工作流 UI 作为产品成立前提。
- 允许 behind-the-scenes 人工，但记录帮助成本和模型失败原因。

### D1：只把已证明稳定的重复任务升级为 B 线功能

若内容切口通过阶段 A，且反复出现稳定输入/输出，可把它从 A 线对话提升成下列 B 线功能：

```text
门店首次设置
  -> 导入真实门店信息/品牌/活动/素材
  -> 选择明确经营目标
  -> 生成一周内容计划
  -> 生成海报/文案/真实素材短视频
  -> 品牌/价格/肖像/文字/事实校验
  -> 店主确认和导出
  -> 记录采用/未采用原因与实际结果
```

只在确定升级为 B 线后，才需要的目标文件/契约方向：

- `ts/shared/contracts/` 新增领域 workflow Schema，禁止前后端镜像手写。
- `ts/src/media/` 复用现有图片/视频能力，不再从聊天 prompt 临时拼接口。
- `ts/src/packs/` 或现有领域包边界承载规则与知识来源。
- `ts/desktop/renderer-react/src/features/` 提供专用工作台，同时保留 Agent chat 作为并列主入口与修改通道。
- `ts/src/server/services/` 保存 workflow state、交付版本和采用结果。

### D2：只有真实数据需求出现后才接经营系统

不要凭想象先做 POS/会员/排班/私域全家桶。只有阶段 A/B 反复出现且用户愿意提供数据时，才选择一个连接：

- 台位/营收/时段数据 -> 经营诊断。
- 会员与活动数据 -> 分群触达建议。
- 排班/助教数据 -> 班次与复盘。
- 内容发布结果 -> 内容效果复盘。

涉及真实外发、账号和个人信息时，继续走独立审批与安全契约，不能因为“领域工作流”自动放行。

### D3：通用 Agent 是产品核心，但不单独构成护城河

无论某个固定切口是否通过验证，通用 kernel 都继续提供：

- 用户遇到例外时的自然语言修改。
- 自动读取/整理素材和表格。
- 直接完成领域工作流之外的开放式任务。
- 未来增加其他垂直行业包的复用基础。

但 UI 和销售不能要求低数字化用户理解 coding-agent 概念。permission、sandbox、MCP 等仍需可管理，只不应占据业务首屏。

## 10. 哪些现有资产保留，哪些降级

| 当前资产 | 决策 | 理由 |
|---|---|---|
| cc-haha 对齐 kernel | 保留并继续强化 | 是通用执行 Agent 的产品核心和工程底座 |
| 权限/沙箱/文件历史 | P0/P1 强化 | 真机 Agent 的准入条件 |
| 生图与真实素材剪辑 | 保留，用于第一切口验证 | 当前最接近端到端交付 |
| 门店画像/运营 PPT | 保留并继续做来源、召回和 eval | 它是 A 线领域问答/分析的正式能力；只有稳定字段和动作才需要结构化 |
| scheduled tasks | 保留为通用执行能力 | 既可由 Agent 开放式设置，也可被 B 线功能调用 |
| 通用聊天 | 保留为 A 线主入口 | 问答、分析、创作和开放式交办本来就适合自然语言入口 |
| coding workspace/diff/terminal | 能力保留，界面按任务披露 | 它们不限于编码，但无需强迫门店用户先理解技术概念 |
| 插件/MCP 市场 | 暂不作为增长主线 | 安全成本高，尚无需求证据 |
| computer-use | 作为通用执行能力保留，高风险动作严格审批 | 能扩展非编码任务，但信任边界大 |
| 通用领域包扩张 | 暂停 | 台球首个需求未验证前不扩散 |

## 11. 大厂产品应该怎样影响我们的决策

WorkBuddy 的价值：

- 证明可以保留 Claude Code 的英文 coding-agent 母提示词和契约，再通过工具、connector 和宿主能力将其扩成通用桌面 Agent。
- 证明成熟桌面 Agent 需要产品级进程、权限、安全中心、连接器、审计和运行时治理。
- 提供可观察的交互与工程参考。
- 暴露“功能越多，信任边界越多”的现实。

WorkBuddy 不能证明：

- 这套功能在台球行业有需求。
- 英文系统提示词对本项目所有模型都必然优于中文；语言选择仍要做模型级 eval。
- 其所有安全实现都值得照搬。
- 用户会因为“不知道 Claude”长期选择本产品。
- 多进程一定比共享 Bun sidecar 更适合当前规模。
- 大厂做了通用 Agent，所以垂直软件没有机会；也不能反过来证明垂直软件必然有机会。

正确用法是把大厂当作高质量证据源和未来同质化压力，不把它当权威答案。

## 12. 最终决策

1. **技术路线不推倒重来。** 保留共享 Bun sidecar 和 cc-haha 对齐 kernel，先补安全与模块边界；不为“像 WorkBuddy”盲目改成每会话完整 CLI 进程。
2. **明确 coding agent 的真实定位。** 它是以编码为强默认的通用执行 Agent，也是本产品的核心；对外用“懂台球并能把事做完”表达，无需向门店用户解释底层编码术语。
3. **承认需求未验证。** 在完成 12 家问题验证、8 家陪跑和 20 家 beta 前，不写“市场需求已成立”。
4. **知识注入是正式的第一阶段。** 先以 prompt/RAG/记忆支持问答、分析和开放式执行；只对稳定、高频、强状态或高风险任务补结构化 B 线功能。
5. **内核提示词优先保留英文母契约。** 从许可参考库对齐上游，台球知识和门店记忆保留中文，用独立 language section 约束中文交互，再用当前模型 A/B eval 决定是否实装。
6. **认知差不是护城河。** 获客可以利用更易懂入口，但长期价值可同时来自知识质量、门店记忆、强 Agent 执行、专用功能和行业信任。
7. **设停止条件。** 阶段 A/B 任一不通过，就停止给该切口加功能，不等于停止通用 Agent kernel；阶段 C 不通过，就调整该台球商业假设。
8. **安全高于兼容。** cc-haha 兼容保留在 kernel；宿主灾难级、外发、秘密、插件和供应链安全由产品层额外收紧。

一句话总结：

> 你的方向可以明确定义为：用 Claude Code/cc-haha 打磨过的通用执行 Agent 做底座，在中间挂载中文台球知识、门店记忆和领域工具，让模型先解决问答、分析、创作和开放式交办；只把经过真实使用证明值得固定的任务做成专用产品功能。这条技术路线本身没问题，需要继续证明的只是回答质量、任务完成、复用和付费。
