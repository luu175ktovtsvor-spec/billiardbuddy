# AI Agent 架构评估 — 原始调研汇总（2026-06-17）
> 本文件由12路并行调查自动汇总（落盘agent因超长失败，由主循环补落）。是战略评估的原始证据，勿手改。


## 1. 台球房AI运营SaaS项目 agent 框架完成度评估

**核心结论**: 这个项目的 agent 框架在结构上已经是一个完整实现了 ReAct 循环的真 agent，不是伪装成 agent 的单次生成。loop.py 实现了标准的 think-act-observe 多轮循环（最多 8 轮），DeepSeek provider 完整支持 OpenAI 格式的 tools/tool_choice 参数和流式工具调用累积，模型真正主动决定调哪个工具、拿结果、再推理，这是教科书级 function calling。工具层（tools.py）注册了 9 个领域工具，覆盖感知、生成、审批三类能力，审批闸（requires_approval）机制完整。orchestrator.py 是独立的"指挥官模式"多智能体框架，走 planning-executing-synthesizing 三阶段、岗位并行，但它是无 tool calling 的链式调用，与 loop.py 的 ReAct agent 是两套独立体系。最大的差距是：agent 会话本身不落库、无跨请求多轮记忆（历史靠前端每次回传）、无真正的长期自主规划能力、orchestrator 走的是固定工作流而非动态规划。按 Anthropic 的分类，loop.py 端点是真 agent，orchestrator 是 workflow，二者平行共存，综合完成度约 6-7 成。

### 关键发现
- **agent loop 是真正的多轮 think-act-observe 循环，不是单次生成**: loop.py 的 run_agent_loop 和 run_agent_loop_stream 都实现了标准 ReAct 循环：for turn in range(1, max_turns+1) 最多 8 轮；每轮调用 provider.generate(TextRequest(tools=tools, tool_choice='auto'))；若 resp.tool_calls 为空则收敛返回，否则把 assistant(tool_calls) 回灌、执行工具、把 role:tool 结果回灌、再进下一轮。每一步记录 AgentStep(type=thinking/tool_call/tool_result/final)。这是 ReAct 范式的完整实现，不是 prompt 拼接后单次调用。
  - 依据: server/services/agent/loop.py:76-125
- **DeepSeek provider 完整支持 function calling，工具调用是模型主动决策**: DeepSeek provider 的 generate() 和 generate_stream() 都在构造 kwargs 时加入 if request.tools: kwargs['tools'] = request.tools; kwargs['tool_choice'] = request.tool_choice，用 OpenAI SDK 直接发给 DeepSeek（兼容 OpenAI 格式）。流式版有专门的 _accumulate_tool_call_deltas 函数把分片到达的 arguments 按 index 拼接，流结束后写入 tool_calls_sink 供 agent 循环消费。generate() 返回的 TextResponse 包含 tool_calls 字段（list[dict]），并有注释说明'模型决定调工具时 content 为空、tool_calls 才有值'。这是真正的 function calling，不是 prompt 提示模型'请输出 JSON'再手动解析。
  - 依据: server/services/ai/providers/deepseek.py:54-58（generate）, 129-132（stream）, 154-184（流式累积）, 87-101（TextResponse tool_calls）
- **工具层注册了 9 个领域工具，分感知/生成/审批三类，能力边界清晰**: tools.py 通过 @tool 装饰器向 default_registry 注册：感知类（只读）2个—get_current_date、get_today_recommendation；生成类（走现有管道，自带配额/落库/合规）5个—write_operation_content、assistant_outreach、diagnose_operation、recommend_games、make_platform_content；审批类（requires_approval=True，花钱/对外）1个—make_poster（AI生图）；内容生成类1个—make_groupbuy_content。总计9个。每个工具的 description 字段明确写了'何时该调我'，是模型选对工具的关键信号。
  - 依据: server/services/agent/tools.py:27-355（全部9个@tool装饰器）
- **审批闸机制完整：requires_approval 工具在循环里被拦截，经 /agent/execute 单独确认执行**: loop.py 中：对每个 tc in resp.tool_calls，先检查 tool.requires_approval；若 True，不调 handler，改 yield {type: approval_request}，把 _APPROVAL_PENDING_MSG 回灌给模型（让模型向用户说明方案、不要假装完成），然后 continue 跳过执行。前端收到 approval_request 事件后弹确认卡片；用户点确认调 POST /agent/execute，该端点只允许执行 requires_approval=True 的工具，调其 handler，工具自身的护栏（配额/并发/计费）由 handler 负责。make_poster 是唯一的受审批工具。
  - 依据: server/services/agent/loop.py:108-114（循环里拦截）, server/api/v1/agent.py:140-173（/execute 端点）, server/services/agent/tools.py:166-179（make_poster requires_approval=True）
- **orchestrator 是独立的指挥官-工作者多智能体，走固定三阶段 workflow，与 ReAct loop 无交集**: orchestrator.py 实现的是 planning-executing-synthesizing 三阶段管道：①_plan_framework 指挥官 LLM 产出《协作框架》并解析参与岗位；②asyncio.gather(*[run_one(a) for a in agents]) 岗位并行执行（每个岗位是一次 generate() 调用，无工具）；③_synthesize 汇总整合。三阶段均为固定调用序列，无工具调用、无循环。与 loop.py 的 ReAct agent 互不依赖、互不调用，是两套体系。orchestrator 的任务状态落库（collab_tasks 表），支持跨 worker 轮询和取消；loop 的 agent 会话则不落库（TODO 注释写明）。
  - 依据: server/services/orchestrator.py:141-249（三阶段函数）, server/api/v1/orchestrate.py:1-84（独立路由）, server/api/v1/agent.py:14（TODO：agent会话落库）
- **记忆层分两级：短期靠前端回传 history，长期靠店脑注入 system prompt**: agent.py 的 /chat 端点：①从 DB 加载 store_memories（长期记忆，店脑）+ 门店画像，拼入 system_prompt；②接受请求体中的 history: list[dict]（短期多轮上下文，由前端管理）传给 loop；③对话后台异步调 remember() 从用户消息学习新记忆（故障安全，不计配额）。这意味着 agent 本身无 server-side session，多轮记忆依赖客户端回传 history；长期记忆（门店偏好/价格/特色）通过店脑自动沉淀并注入，是持久化的。
  - 依据: server/api/v1/agent.py:99-131（system_prompt 组装、history 传入、后台学习）, server/api/v1/agent.py:14（TODO：多轮 conversation_id 续接）
- **模型路由支持编排大脑与内容生成分离，但当前默认同一个 DeepSeek 实例**: config.py 有 orchestration_model_provider 和 orchestration_model_name 两个字段（默认为空），effective_orchestration_provider/model 属性在空时 fallback 到 text_model_provider/name。ProviderFactory.get_orchestration_provider() 用 effective_orchestration_provider 取 provider。loop.py 调 ProviderFactory.get_orchestration_provider() 而非 get_text_provider()。这个设计允许后续把 agent 大脑切换到更强模型（如 GLM-4.6 或 DeepSeek-Reasoner），只需设环境变量，无需改代码。
  - 依据: server/config.py:60,61,79-86, server/services/ai/factory.py:25-31, server/services/agent/loop.py:62-63
- **plan.py 是订阅套餐模型，与 agent 规划无关**: models/plan.py 中的 Plan 类是商业订阅套餐模型（price_monthly/price_yearly/generation_limit/token_limit/poster_limit），配套 StoreSubscription 和 SubscriptionPayment，与 agent 的任务规划毫无关系。真正的 agent 协作任务持久化走的是 models/collaboration.py 的 CollabTask（framework/agents/summary 字段），由 orchestrator.py 管理。文件命名有些误导性。
  - 依据: server/models/plan.py:1-66（全是商业套餐字段）, server/services/orchestrator.py:286-318（CollabTask 是真正的任务状态存储）

### 差距/缺失
- agent 会话本身不落库：loop.py 返回的 messages（完整对话轨迹含工具调用/结果）没有存到 DB，agent.py 的 TODO 明确写着'agent 会话本身落库(type=agent) + 多轮 conversation_id 续接'尚未实现（agent.py:14）。当前多轮上下文靠前端每次回传 history，刷新浏览器即失忆
- orchestrator 无工具调用能力：指挥官规划和岗位执行都是单次 generate() 调用，无 function calling，不能在执行过程中动态查询外部数据源（如查今日推荐、诊断工具）。属于 Anthropic 定义的 workflow，不是 agent
- 无真正的自主规划（planning）能力：loop.py 的 agent 只有 tool selection，没有 goal decomposition + subtask scheduling。遇到复合任务时只能顺序调工具，不能自主拆成多步子目标、分配执行顺序
- 无环境感知/外部观测反馈：工具执行结果只作为 role:tool 文本回灌，没有结构化的 observation 层。工具无法返回结构化错误码供模型按类型区别处理（如 quota_exceeded vs network_error），模型只能从文本推断
- 审批类工具只有 make_poster 一个：写平台内容（抖音/小红书）、团购文案、群发话术等有潜在合规风险或不可逆后果的操作目前没有审批闸保护，requires_approval 机制建好但覆盖面不足
- orchestrator 和 ReAct loop 是两套独立体系，没有互通：指挥官模式下的岗位 agent 无法调用 tools.py 里的工具；ReAct loop 也无法发起多岗位协作任务。这两套能力是孤立的
- 无持久化工具状态或外部数据库查询工具：tools.py 里没有查询 generations 历史、查配额余量、查客户标签、查绩效数据的工具，agent 不能主动查询自己平台内的业务数据来做决策
- model routing 实际是空路由：ProviderFactory.resolve_provider() 无论传什么 model 都 fallback 到 get_text_provider()（factory.py:48-52），编排大脑和内容生成事实上用同一个 DeepSeek 实例，更强推理模型的差异化配置尚未落地

### 建议
- 优先补 agent 会话落库：loop.py 返回的 AgentResult.messages 已含完整轨迹，在 agent.py /chat 端点生成完成后存 Generation(type='agent', sub_type='chat')，把 turns/steps 存 input_params。这一步完成后 conversation_id 续接就可以基于 DB 查询，不依赖前端回传 history
- 给 orchestrator 的岗位 agent 接入工具：run_agent 函数改成调用 run_agent_loop，传入一个只读子集的 ToolRegistry（get_current_date、get_today_recommendation、诊断工具），让岗位 agent 在执行时能动态查询，而不是仅靠 system prompt 里的静态知识
- 扩展审批类工具：把 make_platform_content（发抖音/小红书）和 make_groupbuy_content 改为 requires_approval=True，因为这些内容的格式/用词一旦发布有品牌风险，让用户预览确认再给到手
- 在 tools.py 补两类业务查询工具：①get_store_quota（查配额余量，让 agent 知道是否够用再建议生成计划）；②get_generation_history（查最近 N 条生成记录，让 agent 知道用户上次做了什么、避免重复）。这两个工具都是只读的，不需要审批
- 把 model routing 真正落地：在 .env 加 ORCHESTRATION_MODEL_NAME=deepseek-reasoner（DeepSeek 思考模式），让 agent 规划/工具选择走更强的推理模型，内容生成走更快的 v4-flash。当前 resolve_provider() 的 fallback 逻辑（factory.py:48-52）需要修复，不能无视传入的 model 参数
- 给 orchestrator 的指挥官规划阶段加结构化输出校验：_plan_framework 用正则解析'参与岗位:'行，解析失败 fallback 到场景默认（orchestrator.py:180-189）。可以改成让模型输出 JSON，用 Pydantic 校验，失败时用 tool_choice='required' 强制重试一次，减少解析脆弱性

---

## 2. 台球房AI运营助手内容生成主管道深度分析

**核心结论**: 项目存在两套并行的生成系统：①传统内容管道（stream.py + content_service.py 的 generate_workbench/run_generation），岗位工作台和自由对话均走这条；②Agent循环管道（services/agent/loop.py + api/v1/agent.py），Agent对话走这条，但其生成类工具内部最终仍回调 generate_workbench/run_generation，形成"外壳不同、内核复用"的架构。最终发给 DeepSeek 的 prompt 由七层上下文拼装：时间锚点（北京时间自动注入头部）、场景模板/free_intent主体、baseline规则+岗位规则+客户规则、行业知识库（关键词筛选最多4条场景知识+4条核心知识）、门店运营画像（11个模块）、品牌声音（点赞历史+点踩避免）、店脑记忆（末尾近因效应）。知识选择机制是关键词字符串匹配，不是语义检索，存在漏选风险；特别是工作台的 prompt_key 路径（94/96张卡片走此路径）用模板中文名做 intent_text，比 free_intent 路径更脆弱。Agent系统的 system prompt 只有门店画像+店脑+基底行为指令，没有行业知识库注入，依赖工具调用时再通过 generate_workbench 间接获得知识——这意味着 Agent 规划阶段本身处于知识盲区。

### 关键发现
- **run_generation 端到端链路（非流式统一管道）**: 调用顺序：①注入检查 check_input_injection → ②配额门 check_quota → ③生产环境 mock 禁用检查 → ④店脑注入 with_store_brain（把 store_memories 追加 prompt 末尾，故障安全）→ ⑤ProviderFactory.get_text_provider().generate(TextRequest) → ⑥去前缀 _strip_ai_prefixes → ⑦泄露过滤 filter_output_leak → ⑧写 Generation 表（store_id/user_id/type/sub_type/input_params/prompt_used/result/model_used/tokens_used）→ ⑨increment_usage 计费 → ⑩_safe_log_generation 打点 usage_events（故障安全）。共10步，配额/安全/落库/计费4件套全覆盖，其他路径（poster/batch/repurpose/诊断等）复用此函数保证不漏。
  - 依据: server/services/content_service.py:36-112
- **最终 prompt 的七层上下文拼装顺序与来源**: ①【时间锚点】PromptEngine.render() 对所有非 knowledge 类模板在头部注入'【当前时间】今天 YYYY-MM-DD（周X）；本周末是…'（来自 core/timezone BUSINESS_TZ 北京时间）；②【模板主体】YAML template 渲染，占位符替换门店基础字段（store_name/city/pricing/member_cards/has_coaching 等23个字段）；③【防护上下文 _append_guardrails】= baseline_rules（rules/baseline_rules.yaml）+ 岗位规则（rules/role/{role}.yaml）+ 行业知识库（按 intent_text 关键词筛选）+ 门店运营画像 render_operation_profile_context（11个模块：基础画像/设备/经营目标/客户结构/私域群/助教体系/赛事/团购规则/会员体系/内容风格/AI偏好+品牌风格/门店信息/价格体系/广告语）；④【品牌声音 brand_voice】最近5条点赞历史内容+最近3条点踩原因（来自 DB generations 表 effect_rating 字段）；⑤【精简档 concise_directive】可选，插在品牌声音之后；⑥【店脑记忆 format_memories_for_prompt】放在最末尾（近因效应，冲突时压过前面画像）。free_intent 路径还额外在模板变量里注入：customer_rules（rules/customer/{type}.yaml）和 fewshot_examples（最多2条，来自 workbench_fewshot_service）。
  - 依据: server/services/content_service.py:356-388（_append_guardrails）; server/services/ai/prompt_engine.py:86-93（时间注入）; server/services/content_service.py:700-708（品牌声音+精简档+店脑注入顺序）
- **知识选择 _select_knowledge_keys 的机制：关键词字符串匹配，非语义检索**: 函数遍历角色 required_knowledge 列表，对每个非核心知识 key 统计 intent_text 中命中 KNOWLEDGE_KEYWORDS[key] 的关键词个数（sum of kw in intent_lower）。按命中数降序取前 _MAX_SCENE_KNOWLEDGE=4 条场景知识，核心知识（CORE_KNOWLEDGE_KEYS + daily_workflow* 前缀）无条件注入。核心知识硬编码4个：compliance_rules / term_whitelist / core_operations / service_philosophy。intent_text 来源：prompt_key 路径用 template_name（中文名）+ user_intent + extra_note；free_intent 路径用 user_intent + extra_note。关键词库有 29 个场景映射，共约 200 个关键词，全是中文精准词组（如'上钟''帮我约'），不含同义词/近义词，且全小写匹配。
  - 依据: server/services/content_service.py:227-274（KNOWLEDGE_KEYWORDS 词表）; server/services/content_service.py:281-306（_select_knowledge_keys 实现）; server/services/content_service.py:226-232（CORE_KNOWLEDGE_KEYS）
- **两套系统的关系：岗位工作台和自由对话走传统管道，Agent对话走agent管道但内核复用**: 岗位工作台（/stream/workbench SSE）走 stream.py 的 stream_workbench，有完整的对话历史拼装（最近5轮 conversation_id 归档）。自由对话 /dashboard/chat 在前端也走同一 SSE 端点。Agent对话（/agent/chat）走 api/v1/agent.py → run_agent_loop_stream（ReAct循环，最多8轮，工具调用）。Agent的生成类工具（write_operation_content/diagnose_operation等）内部最终回调 generate_workbench 或 run_generation，因此配额/落库/合规过滤/店脑注入在工具执行时仍生效。两套系统的关键区别：①传统管道直接输出文本；Agent管道先决策调哪个工具再执行；②Agent系统prompt只有门店画像+店脑+行为指令，没有行业知识库——知识库只在工具执行时间接注入。
  - 依据: server/api/v1/router.py:47,61（两条路由注册）; server/services/agent/tools.py:73-84（write_operation_content 调 generate_workbench）; server/api/v1/agent.py:59-67（compose_agent_system_prompt 只含画像+店脑）; web/src/lib/api.ts:307,444（前端两条 URL）
- **店脑记忆的双路径注入与后台学习机制**: 注入：①传统管道（run_generation）调 with_store_brain() 追加 prompt 末尾；②流式管道（stream.py）调 format_memories_for_prompt() 直接 append 到 rendered_prompt 末尾；③Agent管道在 compose_agent_system_prompt() 里注入 system prompt（也在末尾）。三路均在末尾，利用近因效应覆盖前面门店基础资料的旧值。后台学习：流式生成结束后 BackgroundTask 异步调 _learn_in_background → remember()，从用户 intent+extra_note 抽取记忆，整合到 store_memories 表（用 pg_advisory_xact_lock 防并发丢失，上限 episodic 25条/总计 150条）。agent 端点同样有后台学习。日报提交时 note≥6字也触发学习。
  - 依据: server/services/content_service.py:65-70（run_generation 注入）; server/api/v1/stream.py:148-155（流式注入）; server/api/v1/agent.py:59-67（agent注入）; server/api/v1/stream.py:261-272（后台学习 BackgroundTask）; server/services/memory_service.py:154-162（with_store_brain 末尾契约）
- **ProviderFactory 架构与流式 fallback 实现**: ProviderFactory 是类方法工厂，按 settings.text_model_provider 懒创建并缓存 provider 实例。generate_with_fallback 实际没有真正的 fallback（直接调主 provider，返回 (response, False)）。generate_stream_with_fallback 也只路由到同一 provider，fallback_used 恒为 False。编排大脑 get_orchestration_provider() 用 settings.effective_orchestration_provider（默认跟随生成 provider）。Agent ReAct 循环里 TextRequest 带 tools/tool_choice 参数，要求 DeepSeek 支持 function calling（OpenAI 兼容格式）。流式生成用 StreamGuard 做增量安全过滤（去前缀+实时泄露检测）。
  - 依据: server/services/ai/factory.py:55-71（fallback 实现）; server/api/v1/stream.py:191-210（TextRequest + StreamGuard）; server/services/agent/loop.py:62-63（编排 provider）
- **prompt_key 路径（94/96卡片主路径）的知识筛选比 free_intent 更脆弱**: prompt_key 路径（generate_workbench 函数第646-662行）：渲染指定场景模板后调 _append_guardrails，intent_text 拼接为 template_label（模板中文名）+ user_intent + extra_note。stream.py 中同一逻辑在第81-99行。问题：①工作台卡片用户通常不填 extra_note，user_intent 由前端从场景名预填，往往只有几个字；②知识筛选的有效输入主要是 template_label（如'套路PK挑战赛'），必须匹配到 KNOWLEDGE_KEYWORDS 里的词才生效；③某些场景名与知识词表无交集（如'开台接待引导'不含'竞技/群/赛/话术'等词），场景知识会全部漏选，只注入4条核心知识。free_intent 路径通过 extra_vars 注入 knowledge_context 变量进模板，还有 fewshot_examples，总体更丰富。
  - 依据: server/services/content_service.py:646-662（prompt_key 路径）; server/api/v1/stream.py:81-99（stream prompt_key 路径）; server/services/content_service.py:281-306（_select_knowledge_keys 只靠关键词）

### 差距/缺失
- 知识选择是关键词字符串匹配，不是语义检索，存在两类漏选：①关键词同义词未覆盖（如'激励员工'不含'PK/对赌'词组，pk_incentive 知识会漏注入）；②prompt_key 路径（94张卡片）的 intent_text 以模板中文名为主，短且与知识词表覆盖不全——某些卡片场景下只有4条核心知识能进入 prompt，场景化知识全漏
- Agent 系统 system prompt 完全没有行业知识库：compose_agent_system_prompt 只注入门店画像+店脑，Agent 在规划/决策阶段（决定调哪个工具）处于行业知识盲区，可能在多工具组合场景做出次优决策
- generate_with_fallback 没有真正的 fallback（直接调主 provider 无备份），'fallback_used' 字段永远返回 False，备份机制等于虚设，DeepSeek 如宕机/429 会硬失败无降级
- 店脑注入的末尾近因效应依赖位置契约：'在 with_store_brain 之后不可再 append'——但 stream.py 中品牌声音注入在店脑之前（第141-146行 brand_voice 在前，第148-155行 store brain 在后），而 generate_workbench 非流式函数中顺序相反（品牌声音 703-705行在店脑注入之后），两条路径注入顺序不一致，stream路径正确、非流式路径的店脑注入在 run_generation 内部才追加（content_service:65-70），此时 brand_voice 已附在 prompt 末尾，实际顺序是…brand_voice → store_brain，位置正确；但代码分散在两处使人误解，维护时容易破坏契约
- fewshot_examples 只在 free_intent 路径注入（最多2条），prompt_key 路径（94张卡片）完全没有 fewshot，导致卡片触发的生成缺少高质量正例示范
- 品牌声音 get_brand_voice_context 查 effect_rating='good' 最近5条：新店/新用户零历史时返回空串，等同于无品牌风格注入；且反馈采集率偏低时（多数用户不点赞/踩），品牌声音数据长期匮乏
- CORE_KNOWLEDGE_KEYS 硬编码了 term_whitelist 和 service_philosophy，但这两个文件不在 KNOWLEDGE_KEYWORDS 词表里——即使 intent_text 完全命中其他场景知识，term_whitelist 也会被无条件注入；但如果文件不存在会被 PromptVariableMissingError 静默跳过（仅 warning 日志），不会影响生成但也不会报错给开发者
- 多 worker 生产环境（2 worker）下，stream.py 中的 conversation_id 多轮对话历史是跨进程从 DB 查的（正确），但 _POSTER_GENERATING set 和 poster_service 的 asyncio.Semaphore 是进程内的，全局并发实际是配置值的 2 倍

### 建议
- 知识选择升级方案（高优先级）：在 KNOWLEDGE_KEYWORDS 中为每个知识 key 补充同义词和近义词扩展，尤其是 pk_incentive（补'员工激励/冲业绩/绩效PK'）、assistant_scripts（补'话怎么说/怎么开口'）、diagnostic_logic（补'生意不好/没客人'）；或在 _select_knowledge_keys 中改用 TF-IDF/向量相似度匹配替换纯关键词匹配（可用 DeepSeek embedding API 离线预算好每条知识的嵌入向量，运行时 cosine 相似度选 top-k）
- prompt_key 路径补注 fewshot：在 _append_guardrails 或 stream.py 的 prompt_key 分支末尾加 fewshot_examples 注入（与 free_intent 路径对齐），调用 select_workbench_fewshots(role, intent_text=template_label)，可显著提升卡片触发生成的质量
- Agent 知识盲区修复：在 compose_agent_system_prompt 中加入轻量知识上下文（不需要全量，只注入核心4条 CORE_KNOWLEDGE_KEYS 对应内容），让 Agent 在规划阶段了解行业基本运营规则；或者在 agent.py 里复用 _load_knowledge_for_role('manager', store, intent=user_message) 注入前5条最相关知识
- 真正的 fallback 实现：在 generate_with_fallback 里增加真备用 provider（如配置了 GLM/Groq 时），或至少实现本地缓存+重试策略；stream fallback 同理；当前 fallback_used 永远 False 使该字段无意义，可先移除或加 TODO 注释避免误导
- 注入顺序文档化与测试化：在 content_service.py 和 stream.py 的店脑注入位置加显式断言注释说明'这必须是最后一段'；补充一条集成测试验证最终 prompt_used 的末尾段是 store_brain 文本（防止未来开发者无意在其后再追加内容破坏近因效应契约）
- 品牌声音冷启动方案：新店/零反馈时的 brand_voice 为空，可改为从 store.brand_style 字段（lively/professional/youthful/premium）合成一段默认语气指导语，填补空品牌声音的空白
- 知识词表覆盖盲点扫描：写一个脚本遍历所有 operation/ 和 fewshots/ 的场景名，跑一遍 _select_knowledge_keys，输出哪些场景只能命中核心4条知识（场景知识0命中），按出现频率优先补词

---

## 3. 台球房AI运营SaaS 记忆体系深度评估（店脑架构、行为信号、员工记忆、模拟预置）

**核心结论**: 店脑（store_memories）是唯一实现的长期记忆层，以门店为粒度，通过DeepSeek JSON模式自动抽取+整合，注入生成和Agent对话的system prompt末尾。记忆分四类（语义/偏好/运营/情景），上限总150条/情景25条，有pg_advisory_xact_lock并发安全和delete+reinsert整体替换机制。行为信号（BehaviorSnapshot）是从generations表实时计算的统计画像，不持久化，用于今日推荐排序，和店脑记忆是互补而非重叠关系。运营画像（operation_profile）是静态结构化配置，存于stores表，通过render_operation_profile_context渲染为prompt段落。目前完全没有"员工记忆"概念——所有记忆绑定store_id，不区分是哪个员工/助教的个人特征。预置模拟记忆的最直接路径是调用POST /api/v1/store-memory接口逐条写入，或直接INSERT到store_memories表；没有批量预置脚本。与教科书级Agent长期记忆标准相比，缺少反思记忆（Reflection Memory）、跨店语义记忆、员工级个人记忆、记忆版本追溯，以及工具调用结果的记忆沉淀。

### 关键发现
- **店脑抽取机制：DeepSeek JSON模式 + 异步后台，四类输入触发**: 抽取入口有三处：① stream.py的工作台SSE流式生成（用户输入user_intent+extra_note拼成learn_text，BackgroundTask异步调_learn_in_background）；② agent.py的Agent对话（同样BackgroundTask后台学习用户消息）；③ content_service.py的非流式生成路径（with_store_brain注入但未见后台学习调用，仅读取）。抽取提示词明确'绝不编造没提到的信息'，temperature=0，max_tokens=900。抽取后调consolidate_memories与已有记忆整合，整合返回完整最终列表（非ADD/UPDATE操作），避免标签边界模糊问题。
  - 依据: server/services/memory_service.py:83-125（_EXTRACT_SYS + extract_memories）; server/api/v1/stream.py:151-155,265-272; server/api/v1/agent.py:70-78,103
- **整合机制：delete+reinsert全量替换 + pg_advisory_xact_lock并发安全**: consolidate_memories调用DeepSeek一次完成去重/更新/覆盖，返回合并后完整列表；_replace_store_memory用DELETE WHERE store_id + 批量INSERT实现原子替换。并发安全通过pg_advisory_xact_lock(hashtext('store_memory:{store_id}'))串行化同一家店的learn操作，锁在consolidate（LLM约3-5s）期间持有。防膨胀：_cap_memories把情景类截断到最近25条，总数封顶150。整合失败时兜底返回并集（宁可重复也不丢记忆）。
  - 依据: server/services/memory_service.py:128-202（consolidate_memories, _replace_store_memory, _cap_memories, remember）
- **注入机制：system prompt末尾，近因效应压过前面profile旧值**: format_memories_for_prompt生成固定前缀文本'如与其他门店资料/价格冲突，一律以这里为准'，用with_store_brain追加到prompt末尾。注入路径：stream.py（工作台流式）、content_service.py（非流式generate）、agent.py（Agent对话）共三条管道均注入。海报生成（poster_service.py）未注入店脑。设计上原计划放前缀吃KV缓存，实测发现放前缀无法压过后面profile旧值，改为末尾注入，放弃了1-2k token缓存命中。
  - 依据: server/services/memory_service.py:143-162（format_memories_for_prompt, with_store_brain）; server/api/v1/stream.py:148-155; server/services/content_service.py:68; server/api/v1/agent.py:59-67
- **store_memories表数据模型：6字段，无版本/无用户绑定/无召回权重**: 表结构：id(uuid PK), store_id(uuid FK→stores, index), type(varchar20: semantic/episodic/preference/operational), content(text), confidence(varchar10: high/medium/low), created_at, updated_at。无user_id字段（无法追踪是哪位员工触发的学习），无version/prev_id（无版本追溯），无embedding/vector（不支持语义检索），无importance_score（全量注入无优先排序），无tag/topic分组。CRUD API：GET/POST/PATCH/{id}/DELETE/{id}，写权限限STORE_UPDATE（owner/店长级别）。
  - 依据: server/models/store_memory.py:1-33; server/api/v1/store_memory.py:24-121; server/db/migrations/versions/017_store_memories.py
- **行为信号（BehaviorSnapshot）：实时计算、不持久化、仅用于今日推荐**: BehaviorSnapshot从generations表最近30天/最多300条记录中统计type_counts、sub_type_counts、prompt_key_counts、recent_prompt_keys、good_prompt_keys，完全在内存中计算，每次今日推荐请求重新算，不存DB。它和店脑记忆的关系是互补：行为信号='你最近做了什么'（频次统计），店脑='这家店是什么样的'（语义事实）。运营画像（operation_profile）是stores表JSONB字段，存老板手动填写的结构化门店信息，通过render_operation_profile_context渲染，不自动学习。三者分工：静态profile（手填）+ 动态behavior（算）+ 学习memory（AI抽取）。
  - 依据: server/services/behavior_service.py:1-71; server/services/store_profile_service.py:74-400; server/models/store.py（stores表operation_profile字段）
- **员工记忆：完全不存在，所有记忆仅绑定store_id**: 代码库中没有任何staff_memory、employee_memory、coach_memory、user_memory概念，全文搜索无命中。store_members表仅记录store_id+user_id+role三字段，无profile/memory字段。店脑的store_memories表无user_id列，无法区分是哪个员工的行为触发的学习，也无法为特定助教/教练存储个人特征（如'张助教擅长中高杆，主要客群是白领'）。如果要做'员工记忆'，需要新增staff_memories表（含store_id+staff_id+type+content），独立CRUD API，并在生成路径中按当前登录用户注入对应员工记忆。
  - 依据: server/models/store_memory.py:11-32（无user_id字段）; server/models/store.py:91-114（store_members仅有role）; Bash搜索全仓库无任何employee/staff memory命中
- **人工预置记忆的现有接口：POST /api/v1/store-memory，逐条写入，无批量接口**: POST /api/v1/store-memory接受{content:str, type:str}，返回{id,type,type_label,content,confidence}，需要Bearer token且调用方用户须有STORE_UPDATE权限。confidence自动设为'high'（人工写入默认高置信度）。无批量插入接口（无/bulk或/import端点）。替代方案：直接SQL INSERT到store_memories表，指定store_id+type+content+confidence即可（不经过抽取/整合流程，直接落库）。预置后立即生效——下一次生成就会注入。
  - 依据: server/api/v1/store_memory.py:60-79（add_memory）; server/api/v1/router.py:59（路由注册/store-memory）

### 差距/缺失
- 员工/个人级记忆完全缺失：现有记忆以门店为粒度，无法存储特定助教（如'张助教月上钟最高，客户满意度好'）、特定教练、特定客户的个人画像记忆，限制了针对个人的运营建议质量
- 反思记忆（Reflection Memory）缺失：没有'AI自己反思过去决策/生成质量，提炼规律'的机制。效果好/差反馈（effect_rating）只进behavior统计，不触发记忆层的主动反思更新
- 情景记忆缺乏时间语义：episodic类记忆存的是内容文本，无独立的event_date/occurred_at字段，无法做'上次端午活动发生在哪天'的精确时序推理（LongMemEval测试项③无法完整支持）
- 记忆无版本追溯：每次整合是全量delete+reinsert，历史值被覆盖无法查看（改价前是多少？上次整合删了什么？），无法做记忆质量的事后审计
- 无召回排序/重要性权重：全量注入（全部记忆塞进prompt），当记忆趋近150条上限时注入量~3-5k token，无importance_score/relevance_score按当前任务筛选最相关记忆子集，效率下降
- 跨门店/行业层面无语义记忆：没有从所有门店的共同模式中提炼'行业级长期规律'注入给所有门店的机制（现有行业知识是静态YAML，不从用户交互中学习演化）
- 工具调用结果不沉淀记忆：Agent的工具调用结果（如'本次经营诊断发现客单价偏低'）不触发记忆学习，只有用户输入的文字才被学习
- 海报生成管道未注入店脑：poster_service.py完全不读取store_memories，导致AI生图的prompt扩写不享受店脑的'懂这家店'能力（如不知道门店风格偏好高端还是活泼）
- 记忆主动触发机制缺失：目前是被动学习（用户发消息后台才学），没有'店脑发现画像缺口/矛盾主动追问用户'的主动补全机制（架构文档第二版计划提到但未实现）

### 建议
- 预置门店模拟记忆（最快路径）：直接SQL批量INSERT，无需经API逐条写——找到目标门店的store_id，执行：INSERT INTO store_memories(id, store_id, type, content, confidence) VALUES (gen_random_uuid(), '<store_id>', 'semantic', '门店有12张球桌，含2张斯诺克', 'high'), (gen_random_uuid(), '<store_id>', 'operational', '周末以散客为主，工作日靠助教上钟', 'high'), ...；一次可插入任意数量，立即生效
- 预置员工模拟记忆（当前无原生支持，变通方案）：将员工特征以semantic类型写入门店记忆，内容格式化为'张助教（技术型）擅长中高杆，主要客群是白领，上钟高峰周二至周四晚'——这样AI在写助教相关文案时会读到，但无法按employee_id过滤，所有员工共享同一批门店记忆池
- 真正的员工记忆：新增staff_memories表（store_id+staff_id+type+content+confidence），在store_members表上加profile JSONB字段存结构化员工画像；API层加GET/POST /api/v1/staff/{staff_id}/memory；生成路径在有明确员工context时（如写助教约客文案时传了coach_id）额外注入该员工的记忆片段
- 批量灌入脚本：在server/scripts/目录下写seed_memories.py，读一个JSON文件（格式：[{type,content,confidence}]），调memory_service.remember或直接_replace_store_memory批量写入，命令行传store_id和json路径；比API逐条调用快且绕开RBAC认证
- 模拟记忆的推荐内容结构（按四类分层预置）：semantic层放门店客观事实（球桌数/面积/价格/地段）；operational层放运营节奏（几点开门/旺季淡季/哪天客流高）；preference层放老板偏好（文案喜欢简短直接/不用emoji/常用口头语）；episodic层放近期事件（上月做了什么活动/效果怎样）
- 修复海报生成未注入店脑的漏洞：在poster_service.py的_build_prompt方法中加载并注入store_memories，和content_service.py的做法一致（调with_store_brain），确保生图prompt扩写也懂这家店的风格偏好
- 情景记忆补时间字段：在store_memories表加可选的event_date字段（migration），episodic类型的记忆存储时同时记录事件发生日期，使时序推理（'上次端午几号做的'）有据可查

---

## 4. 球房AI运营SaaS 测试体系现状评估（支撑"大规模北极星对齐测试"）

**核心结论**: 测试体系分三层：无AI免费的单元层（pytest约50个文件）、需真实DeepSeek的eval层（仅1个文件 eval_store_brain.py，覆盖店脑记忆模块）、以及人工+脚本混合的agent压测层（临时脚本跑真实DeepSeek、人工读输出、存档至docs/test-runs/）。"北极星对齐"的基准文档已完整存在（球房运营逻辑基准.md，144行），知识库对照它做过一次人工审计，并有少量自动口径护栏（test_pipeline.py中有几条关键词级别的断言）。eval_store_brain.py 是唯一真正调用 LLM 做语义评判的文件，但它只覆盖"店脑记忆抽取/整合"这一子功能，使用的是关键词精确子串匹配+自定义lambda谓词，并非 LLM-as-judge。agent压测记录了12+真实场景的输出，通过"人工阅读+注入校验布尔值"定义合格，没有量化评分。要做"几十上百场景的大规模北极星对齐自动测试"，当前缺：系统性场景集、自动评分器、北极星要素的可机器检验拆解、批量跑评框架、以及pass/fail的量化标准。

### 关键发现
- **测试分三层，成本与覆盖差异显著**: 层1（主套件）：约50个pytest文件，全部无AI、不联网，跑一次免费秒级完成，覆盖Agent循环/工具注册/权限/配额/报表/海报并发/prompt引擎等机制。层2（eval层）：仅 eval_store_brain.py 1个文件，调真实DeepSeek，默认被主套件排除（文件名前缀eval_），需显式 pytest tests/eval_store_brain.py 跑，覆盖店脑记忆抽取/整合/防幻觉3个测试函数。层3（压测层）：无自动化脚本，每次手工运行临时脚本，结果存入 docs/test-runs/，无复用入口。
  - 依据: scripts/test.sh:3-25, server/tests/eval_store_brain.py:7-8, docs/test-runs/agent压测实跑-2026-06-17.md:1-3
- **eval_store_brain.py 的评判机制：子串精确匹配+lambda谓词，不是 LLM-as-judge**: 抽取测试（test_extraction_recall_and_no_hallucination）：对每个用例用 ' | '.join(m.content) 拼成一个大字符串，然后用 `m not in blob` 做精确子串匹配判断必须捕获的关键值是否出现，forbidden词同理。整合测试（test_consolidation_outcomes）：用自定义 lambda 函数检查最终列表中关键词存在性和条目数量。通过标准：幻觉=0，召回允许6条中漏≤1条（容忍1次LLM抖动）；整合5个用例全部通过。没有任何 LLM 对输出质量做打分。
  - 依据: server/tests/eval_store_brain.py:105-119, 73-96, 44-68
- **北极星文档完整但与测试体系几乎断连**: 球房运营逻辑基准.md（144行）是完整的行业运营方法论文档，包含10条铁律清单、四大客户分类、客户运营五步闭环、定价铁律等，明确声明是项目内容的唯一基准。但这份文档和自动测试的唯一连接点是：test_pipeline.py 中少数几条口径级别断言（test_profit_model_no_high_ratio_recharge检查profit_model.yaml不得出现'充1000送500'等大比例赠送字样；test_baseline_has_positive_expert_layer检查baseline_rules.yaml包含'正向专家标准'等字符串）。没有一条测试系统性验证AI输出是否符合北极星运营逻辑。
  - 依据: docs/product-brain/球房运营逻辑基准.md:1-144, server/tests/test_pipeline.py:136-142, server/tests/test_pipeline.py:471-479
- **agent压测用"注入校验布尔值+人工阅读"定义合格，无量化标准**: 压测脚本（临时、已删）对每个场景输出一行 `[growth_playbook 是否注入：True/False]`，这是唯一的自动检验项——只检查 knowledge key 是否进入 prompt，不检查输出内容是否正确。输出质量判断完全靠人工阅读，判定标准是主观的（"输出有没有用上套路""金额是否占位不编数字"）。12+场景覆盖了平台内容/玩法推荐/诊断/约客/文案/多步链式等，但没有失败判定的量化阈值。
  - 依据: docs/test-runs/P2-1-growth_playbook-拉新裂变库-20260617.md:4, docs/test-runs/P2-3-诊断决策树注入-20260617.md:8-14, docs/test-runs/agent压测实跑-2026-06-17.md:409-412
- **知识库口径护栏覆盖"禁止出现什么"但不覆盖"必须体现什么"**: test_pipeline.py 中有7条左右的口径回归测试：检查profit_model不得含大比例赠送字样、知识库不得含行业真实运营资料出处字样、baseline必须含正向专家层关键字、价格字段单点策略、日期用北京时间等。这些都是防御型（不能出现X）。但北极星的核心正向要素——如"散客求社交/竞技求交流/助教求情绪价值/追分求刺激"四大客户分类、"客户运营五步闭环"、"营销第一"等——没有任何测试验证AI输出是否体现这些框架。
  - 依据: server/tests/test_pipeline.py:136-142, 194-208, 471-479
- **样例库和反例库存在但未接入自动评测**: docs/product-brain/ 目录下有 workbench-结构化优质样例库.yaml 和 workbench-结构化反例库.yaml 两个文件，是北极星对齐测试的天然素材，但当前它们没有被任何测试文件引用，仅作为人工参考存在。运营逻辑对齐审计报告（2026-06-13）是纯人工审计，共改了7个YAML文件，方法是人工对照行业真实运营资料逐文件核查，不可重复运行。
  - 依据: docs/product-brain/运营逻辑对齐审计报告.md:1-46, docs/product-brain/workbench-结构化优质样例库.yaml（未被任何test_*.py import）
- **多轮链式场景（multi-turn）测试全部靠Mock，无真实LLM行为测试**: test_agent_loop.py 的6个测试函数全部使用 MockTextProvider 注入预设的 scripted 响应序列（TextResponse数组），验证的是循环骨架的控制流（tool调用→回灌→收敛、max_turns兜底、未知工具/异常的错误回灌），完全不涉及DeepSeek真实的工具选择行为。真实的"DeepSeek面对用户输入选哪个工具"只在压测的临时脚本中测，且只存档文本、无法自动回归。
  - 依据: server/tests/test_agent_loop.py:33-127, server/tests/test_agent_builtin_tools.py:36-48（monkeypatch假工具）

### 差距/缺失
- 缺"北极星要素检验清单"：球房运营逻辑基准.md 中的10条铁律、四大客户分类、五步闭环、定价铁律等未被拆解成可机器检验的断言集——现在没有办法自动判断一条AI输出是否"没脱离北极星"
- 缺语义级评分器：现有eval层只做关键词子串匹配；对于"白天空台该不该直接打5折"这类诊断质量，没有任何自动评分机制——既没有LLM-as-judge，也没有基于样例库的相似度评分
- 缺系统性场景集（scenario suite）：压测场景以每轮P2改动为边界临时设计，没有一个覆盖北极星所有核心运营维度的固定场景集（如：客流诊断/竞争诊断/定价咨询/四类客户处理/五步闭环各环节/助教约客/活动策划等至少50个固定场景）
- 缺多轮对话/工具选择的真实LLM回归：test_agent_loop.py 全部是Mock，DeepSeek真实工具选择行为只靠人工压测，换模型或改工具描述后没有自动回归保护
- 缺分层pass/fail定义：什么叫"北极星对齐通过"没有量化标准——是口径词命中率？关键建议覆盖率？与反例库的语义距离？目前靠人工拍脑袋
- 缺批量eval运行框架：agent压测用临时脚本、每轮删掉；eval_store_brain.py是pytest单测；两者之间没有可配置的批量eval runner（能并行跑N个场景×M个门店画像、汇总pass率）
- 缺回归对比机制：每次改prompt/knowledge YAML后，无法自动对比输出质量变化（前后diff）；只能人工读两份存档对比

### 建议
- 将球房运营逻辑基准.md的10条铁律拆解成"可检验谓词列表"：每条铁律对应1-3个检验点，例如铁律3（取消大额充值赠送）→检验AI的充值方案建议中不出现"送50%以上"的表达，铁律5（四大客户分类）→诊断输出中当问题涉及客户流失时必须提及至少一种客户类型。形成 docs/product-brain/北极星检验谓词集.yaml，每条谓词包含：id/铁律编号/场景标签/检验方式（关键词/正则/LLM-as-judge）/判定逻辑
- 建立固定场景集 evals/scenes/*.yaml，至少50个场景，每个场景含：用户输入/门店画像/必须体现的北极星要素id（from谓词集）/不得出现的forbidden词。命名规则：scene_{类别}_{序号}.yaml，类别覆盖：diagnosis/activity/content/outreach/games/report
- 实现轻量LLM-as-judge：对于无法用关键词判断的质量维度（如"建议是否具体可执行""是否卖氛围而非堆优惠"），用DeepSeek自身以JSON格式返回{score:1-5, reason, failed_criteria:[]}的裁判prompt；裁判prompt直接引用北极星铁律清单；通过标准：score≥3且failed_criteria为空。这不需要新模型，用现有deepseek-v4-flash即可
- 将压测脚本固化为可重复运行的 scripts/eval_agent.py：参数化门店画像（至少3种：社区/商业/竞技）×场景集→批量跑→输出JSON报告（场景/注入命中率/LLM评分/forbidden词命中情况）。每轮P2改动后跑一次并把JSON存入 docs/test-runs/，取代当前的人工存档
- 量化pass/fail标准建议三级：GREEN（北极星完全对齐）= 所有强制要素命中+forbidden词=0+LLM-as-judge score≥4；YELLOW（轻微偏离）= 强制要素命中率≥80%+score≥3；RED（脱离北极星）= 强制要素命中率<80%或出现forbidden词或score<3。全场景GREEN率≥85%才允许合并到main分支
- 将 workbench-结构化优质样例库.yaml 和 workbench-结构化反例库.yaml 接入自动测试：对每个新场景输出计算与反例库的语义相似度（简单版：关键短语重叠率），相似度高于阈值则标记为WARN；优质样例库用于校准LLM-as-judge的打分参考（few-shot示例注入裁判prompt）
- 在 test_pipeline.py 中新增"北极星铁律口径守护"测试：用_select_knowledge_keys验证诊断场景下core_operations（含四大客户分类）始终注入；用baseline_rules.yaml文本断言验证一卡通/营销第一/四大客户等核心关键词存在于规则层——这是无AI成本的最低成本防线

---

## 5. 球房运营北极星逻辑结构化提炼 — 已固化程度与可优化点评估

**核心结论**: 北极星基准文档（docs/product-brain/球房运营逻辑基准.md）已经完整覆盖"识别→创造→传播→交付"四步营销总纲、四类球房定位、四类客户分类、客户五步闭环、6岗位职责矩阵、定价铁律等核心逻辑骨架，并已向下固化到 43 个 knowledge YAML 和 67 个 operation YAML。整体覆盖率高、逻辑清晰、零第三方信息。主要短板在三个维度：一是"行业原始资料的部分做法明显是头部连锁特供逻辑"，对中小独立球房偏重偏难（如60人助教团队指标、BOSS刷量手段等），AI产出如果照搬会出水土不服；二是"女性客群/年轻客群/团建场景"等新增量渠道在 knowledge 层几乎空白，只有碎片化提及；三是"淡季/时段冷场/老客流失"的诊断逻辑已有决策树，但对应的运营动作套路库（空台促活、淡季拉新方案生成）在 AI 产出侧还不完整。知识的量已到位，但"适配对象分层"和"当下打法校准"是最值得优化的方向。

### 关键发现
- **【人·岗位体系】六岗位职责已固化，但助教管理指标照搬头部连锁，中小店落地有门槛**: 北极星基准已清晰定义6岗位（店长/助教管理/助教/教练/前厅/运营）核心职责与KPI方向，并在 knowledge YAML 中固化了助教7天筛选制、五级晋升体系、陪打时长提成阶梯。但原始资料（11目录薪资表）中呈现的是头部连锁规格：每组助教15+人、助教管理月添加2000个交友平台微信、月均陪打130小时为'及格线'，正式助教月薪10000元体系。这套指标对50台以上的连锁场合理，对10-20台的中型独立球房严重过配，AI若直接套用这套指标生成绩效方案，中小老板会看到现实无法落地的数字。knowledge/assistant_tier_system.yaml 和 assistant_salary.yaml 已有相对合理的参考值，但缺乏'按门店规模/台数分档'的差异化说明。
  - 依据: /Users/swl/Desktop/球房 ai 运营助手/server/prompts/knowledge/assistant_tier_system.yaml，/Users/swl/Desktop/球房 ai 运营助手/server/prompts/knowledge/assistant_salary.yaml，原始资料 docs/台球行业资料收集-全量提取.txt:line 463-510
- **【客户·分类与生命周期】四类客户+ABCD分级已固化，女性/年轻客群/企业团建这条增量路径几乎空白**: knowledge/customer_tagging.yaml 和 customer_types.yaml 已完整固化四类客户（散客/竞技/助教/追分）+ABCD分级+生命周期维护策略，是该项目质量最高的知识模块之一。但原始资料多处点到'女性占比持续增长、女性更看重环境与服务'（行业知识提炼 1.1节），以及'企业老板或店长免费筹办团建比赛'（原始资料 line 15661）。这两类场景——针对女性客户的差异化内容策略（话术/活动/朋友圈文案语气）、企业团建转化路径——在现有 knowledge YAML 中均无专项模板，AI 生成时无法区分用户类型差异，只能套通用话术。这是行业正在扩张的增量渠道，但产品大脑还是以男性核心客为中心的设计。
  - 依据: /Users/swl/Desktop/球房 ai 运营助手/server/prompts/knowledge/customer_tagging.yaml:line 1-60，/Users/swl/Desktop/球房 ai 运营助手/docs/台球房行业知识提炼.md:line 13-15，原始资料 line 21498-21499（女性客群占比），原始资料 line 15661（团建场景）
- **【盈利·收入结构与定价体系】四大盈利点+一卡通+团购精简逻辑是全项目最成熟的模块**: knowledge/profit_model.yaml 是全项目质量最高的文件，涵盖：台费/助教/商品/充值四大收入来源及占比健康标准、4类球房定价策略对比表、取消大额充值赠送的四步落地流程、7个经营诊断维度。diagnostic_logic.yaml 进一步固化了'指标异常→根因→责任部门→具体动作'的决策树，对应原始资料中12目录数据分析材料（营业额总公式：总营业额=助教费+商品费+总台费，总台费=助教客户台费+竞技客户台费）逻辑完全对应。定价铁律、团购控制在4-5个品类等内容已在 core_operations.yaml 和 profit_model.yaml 双重固化。这一要素群在 knowledge 层完整、在 operation 层有5个对应模板，是北极星覆盖最扎实的区域。
  - 依据: /Users/swl/Desktop/球房 ai 运营助手/server/prompts/knowledge/profit_model.yaml:line 1-320，/Users/swl/Desktop/球房 ai 运营助手/server/prompts/knowledge/diagnostic_logic.yaml:line 1-77，原始资料 line 1420-1430（营业额公式图）
- **【获客·引流体系】四路引流逻辑已固化，但交友软件/BOSS刷号等争议性做法原封不动进了 knowledge，有合规和平台封号风险**: knowledge/traffic_generation.yaml 和 account_nurturing.yaml 已覆盖线上短视频、直播、交友平台、美团/大众点评、线下地推等引流路径，并给出了具体操作步骤（如美团评分规避关键词、避免WiFi评价等）。问题是：原始资料大量描述使用 BOSS直聘/交友平台以'帅哥身份'约客（原始资料 line 6581），这在资料来源中属于灰色操作，BOSS直聘已有封号风险的记录（原始资料 line 10265）。account_nurturing.yaml 中的微信养号操作（模拟阅读、1对1私聊节奏控制等）也处于平台灰色地带。growth_playbook.yaml 新增了梯度集赞、邀请有礼、限时限桌引流局等更合规且可落地的套路，但与灰色操作并列在知识库中，AI 无法自动区分优先推荐合规打法。
  - 依据: /Users/swl/Desktop/球房 ai 运营助手/server/prompts/knowledge/traffic_generation.yaml，/Users/swl/Desktop/球房 ai 运营助手/server/prompts/knowledge/account_nurturing.yaml，/Users/swl/Desktop/球房 ai 运营助手/server/prompts/knowledge/growth_playbook.yaml，原始资料 line 6567-6581、10265
- **【场景·赛事活动体系】赛事规则库完整，主题夜/赛季制新手联赛等创新场景已进 knowledge 但 operation 模板尚未跟上**: knowledge/tournament_rules.yaml 覆盖了10种赛事类型，新增了赛季制新手友好联赛格式（line 367起）和主题夜概念（sports_event_watching.yaml line 114）。运营场景索引中赛事类有9个场景，其中月赛、会员赛、赛制说明、冠军海报4个缺独立卡片。更重要的是：主题夜（单身夜/女生场/情侣场/团建专场）这类以'场景体验'为核心的活动设计，在现有 operation YAML 中完全没有对应模板——这类活动正是当下球房差异化竞争的核心手段之一，是行业资料中提到的'团建服务'和'主题活动'在场景侧的具体化。看球活动有 operation.sports_event_watching 模板，但其他主题夜场景均缺失。
  - 依据: /Users/swl/Desktop/球房 ai 运营助手/server/prompts/knowledge/tournament_rules.yaml:line 367-400，/Users/swl/Desktop/球房 ai 运营助手/server/prompts/operation/sports_event_watching.yaml:line 114，/Users/swl/Desktop/球房 ai 运营助手/docs/product-brain/运营场景索引.md:line 72-92
- **【内容·文案与传播体系】文案生成框架完整，但'地方化/小城市适配'逻辑和'内容差异化策略'在 knowledge 层缺乏结构化支撑**: 原始资料中有一段关键提醒（line 10087）：'90%以上的本地化是必经之路，照搬一线城市高端会员制到三四线城市无人买单'——这是真实踩坑经验，说明运营逻辑不能一套通用。但现有 knowledge YAML 中的价格参考、薪资结构、客单价等数字基本以商业球房（中高端）为基准，没有按城市层级或球房定位给出差异化参数。内容输出层面，platform_operations.yaml 涵盖了抖音/美团平台运营SOP，但'内容两条线'（流量型吸睛 vs 获客型讲卖点）的策略区分虽在北极星基准1.7节有论述，在 YAML 层面没有固化成可触发的判断规则，AI 生成文案时两条线的目标会混淆。
  - 依据: /Users/swl/Desktop/球房 ai 运营助手/server/prompts/knowledge/platform_operations.yaml，/Users/swl/Desktop/球房 ai 运营助手/docs/product-brain/球房运营逻辑基准.md:line 74-76（传播两条线），原始资料 line 10087（本地化警示）

### 差距/缺失
- 女性客群差异化运营逻辑：原始资料明确指出女性更看重环境与服务，但整个 knowledge 层没有针对女性客户的专项话术规则、内容策略差异（语气/情感诉求/场景选择），AI 生成内容默认以男性客户为对象
- 企业团建作为独立获客渠道：高端会员权益中明确提到'老板免费筹办团建'，但没有对应的 operation YAML（企业团建跟进/方案/话术），也没有在客户分类中设'企业客'这个标签
- 中小独立球房适配层：知识库的参考数字（人员规模/薪资/指标阈值）对应头部连锁场景，对10-20台的独立球房会有误导；knowledge 层缺乏'按台数/规模给差异化建议'的路由机制
- 引流合规优先级排序：灰色操作（BOSS交友号/微信养号）与合规操作（梯度集赞/限时引流局）并列在 knowledge 中，AI 无法自行判断优先推荐合规打法；应当在生成规则层明确优先级
- 主题夜/特定场景活动模板：单身夜、女生场、情侣场、企业团建这类'场景体验型活动'在 operation YAML 中完全缺失，而这类活动是当前球房做差异化的主流手段之一
- 淡季专项运营方案：知识库和诊断决策树有提及淡季识别，但对应的'淡季拉新/空台促活/冷清时段活动'生成能力薄弱，diagnosis_tool 能诊断出'冷清'但 operation 侧的具体套路模板覆盖不完整
- 内容流量型/获客型两条线的生成规则：北极星基准明确区分了这两种内容方向，但未固化成 AI 生成时的可触发判断条件，导致文案生成偶尔目标不清
- 数据分析辅助生成能力：原始资料展示了详细的数据分析框架（营业额公式、各区域拆解、周数据趋势图），现有产品能生成文字诊断，但无法辅助用户填表/解读自己的数据（输入数据→输出诊断结论的能力仍弱）
- 开业筹备全套动作：opening_preparation.yaml 已有30天时间线，但对应的前7天高强度冲刺动作（储备客户、养成习惯、口碑决定）没有独立的 operation 模板集，开业场景覆盖仍是点状

### 建议
- 在 knowledge/customer_tagging.yaml 中增加'女性客群'和'企业团建客'作为独立标签类型，配套在 operation YAML 里新增2个模板：operation.female_customer_content（女性向内容策略差异化指南）和 operation.corporate_team_building（企业团建引导与方案）——这是最小成本、最高价值的填补
- 在 knowledge/profit_model.yaml 或新建 knowledge/scale_guide.yaml 中增加'门店规模分档'部分：10台以下/10-20台/20台以上分别给出适配的助教配置、绩效指标、定价区间建议，避免中小店老板看到60人助教团队指标而直接放弃
- 在 core_operations.yaml 或 compliance_rules.yaml 中增加明确的'引流手段优先级'规则：合规公域（抖音矩阵/美团/小红书）> 合规私域（梯度集赞/邀请有礼/组局类裂变）> 灰色操作（交友平台/养号）；并在生成文案前的知识筛选层加入这条判断，当用户问引流时优先推合规套路
- 新建 operation.theme_night.yaml，覆盖主题夜（单身夜/女生场/情侣场/斯诺克看球夜）四种场景各自的策划框架、宣传文案模板、执行SOP，补上当前 operation 层最明显的空白场景
- 把北极星基准1.7节的'内容两条线'（流量型/获客型）固化成 operation 层的生成参数：在 stream.py 生成的问答链路或 prompt_engine 渲染前，根据用户选择的场景自动注入'本次内容目标=流量吸睛'或'本次内容目标=转化获客'的提示词，让 AI 生成时有清晰目标
- 将'北极星要素树'制作成一个可测试的对齐基准表：每个要素对应1-3个验证问题（如'助教管理要素：AI 生成的PK方案是否包含分组规则/指标/阶梯奖励/排名公示4项？'），作为 eval_store_brain.py 类型的验收套件的一部分，可定期回归跑，确保 knowledge 更新后 AI 产出不偏离北极星
- 对 account_nurturing.yaml 做内容审查：移除或降权明显违反平台规则的操作描述（如BOSS以假身份发聊天等），保留合规的微信账号维护技巧（阅读文章/正常互动等），在文件头部增加免责说明，避免 AI 输出助教用平台规避手段做引流的建议

---

## 6. AI Agent 转型进展盘点（截至 2026-06-17）

**核心结论**: 转型从 2026-06-16 启动，27 个 commit 落在 AI-Agent-Dev 分支（未合并 main）。三个用户拍板决策中，「对话管家为主入口」和「审批闸（proposal 模式）」已完整落地，「大脑可切换」配置层已就位但 GLM A/B 尚未实测。P0（ReAct 循环地基）、P1（对话管家 MVP + 9 个工具）、P3.1（平台内容）、P3.2（团购文案）和审批闸（P2 核心）均已实现并有真实 DeepSeek 压测存档。打标「P2」的最新 5 个 commit 实际是内容质量校准（拉新裂变库、赛季联赛、诊断决策树等），与编排计划中「P2 = 记忆升级 + pgvector」不同，要注意语义歧义。关键缺口有三：一是 Agent 对话本身未落库（无 conversation_id 跨会话续接，页面刷新即丢历史）；二是记忆层仍是全量注入而非 pgvector 召回（P2 架构升级未动）；三是 P4 主动出击完全未启动。整体节奏超出计划（P3 工具已做完），但移动端三件套（会话持久化 + 滚动总结 + loop 打点）是微信 WebView 下最影响体验的缺口，应是下一步优先项。

### 关键发现
- **P0 地基：ReAct 循环已完整实现并验收**: 新增 server/services/agent/（loop.py / registry.py / context.py / tools.py），自研白盒 ReAct 循环：TextRequest 增 tools/tool_choice、TextResponse 增 tool_calls；DeepSeek 流式 tool_calls 增量拼接；/api/v1/agent/chat SSE 端点；前端 api.ts 新增 streamAgent + executeAgentTool。P0 验收：true DeepSeek 端到端冒烟通过（smoke_agent.py：模型自主调用 get_current_date → 用结果作答 → 2 轮收敛）。
  - 依据: commit 06b9323 feat(agent): P0 地基；server/services/agent/loop.py:50-125；server/api/v1/agent.py
- **P1 对话管家 MVP：9 个工具注册、管家为主界面、登录后直落管家**: 已注册工具：get_current_date、get_today_recommendation、write_operation_content、assistant_outreach、diagnose_operation、recommend_games（P1 MVP）+ make_poster（审批闸）+ make_platform_content（P3.1）+ make_groupbuy_content（P3.2）。登录后 auth-context.tsx 默认跳 /dashboard/chat（管家）而非今日工作台。移动端顶栏改「管家主页式」：左侧汉堡菜单进其他功能，不再是返回箭头。
  - 依据: commit 3554c63（P1 MVP）、2e498c2（默认落地管家）、5b80537（管家顶栏）；server/services/agent/tools.py:27-355；web/src/hooks/auth-context.tsx:49-52
- **审批闸（Proposal 模式）：已完整实现，make_poster 是第一个受审批工具**: loop.py 中 requires_approval=True 的工具不在循环内执行，改发 approval_request SSE 事件 + 回灌 _APPROVAL_PENDING_MSG 让模型向用户说明方案；用户确认后走独立 POST /agent/execute 端点真正执行。前端 chat/page.tsx 渲染「确认生成/取消」卡片，点确认 → api.executeAgentTool()，状态用 ApprovalState.status（pending / done / cancelled）管理。
  - 依据: commit a3cf32a（后端审批闸）、531f9e4（前端审批卡片）；server/services/agent/loop.py:108-114；web/src/app/dashboard/chat/page.tsx:204-225
- **P3 对外动作工具已做完（内容备好 + 复制 handoff，不自动发）**: make_platform_content 支持抖音/小红书/快手/视频号，每平台有独立格式指令（钩子/镜头数/话题标签规范等），有城市编造红线护栏（只用门店真实城市）。make_groupbuy_content 支持美团/抖音来客，输出套餐标题/卖点/包含内容/使用规则/引流钩子，不接服务商 API、不自动上架。两者均走 run_generation 管道（配额/落库/合规过滤全生效）。
  - 依据: commit 915372a（P3.1）、de30804（P3.2）；server/services/agent/tools.py:226-355；docs/references/P3对外平台-官方文档与资质清单.md（commit 36c7f21）
- **内容质量 P2 校准：知识库新增 4 个、诊断注入决策树强制化、平台内容二轮压测**: 新增 growth_playbook.yaml（拉新裂变/留存套路库，接入 manager/operator/coach/assistant_manager 四岗位）；tournament_rules.yaml 补赛季制新手联赛 + 主题之夜（单身夜/女生场/情侣场/团建/双业态/看球）；诊断改为在 intent 前缀强制塞触发词确保 diagnostic_logic 知识段被注入，不再靠关键词碰运气；诊断新增 off_season（淡季/时段）标签；平台内容经两轮真实 DeepSeek 压测（36 条话术验证），修了城市编造 bug、补了情侣/双人玩法。
  - 依据: commit bbde638 / 1212a3c / 055d67d / 54a340a / 84ece11 / d59bd73；docs/test-runs/P2-1 到 P2-5；server/services/diagnosis_service.py:18-41
- **Agent 对话未落库、无 conversation_id——刷新即丢历史**: agent.py TODO 注释明确标注「agent 会话本身落库(type=agent) + 多轮 conversation_id 续接」尚未做。当前多轮靠前端在 send() 时把 messages 数组整包带上 history 参数，后端每次重建完整上下文。浏览器刷新或会话切换后历史全丢，无法从生成历史页找回 agent 对话。对应计划的「P1.6 跨会话持久化」。
  - 依据: server/api/v1/agent.py:13（TODO 注释）；web/src/app/dashboard/chat/page.tsx:141-143（history 仅来自本地 useState）
- **P2 架构记忆升级（pgvector 召回）完全未启动**: 记忆层仍是 memory_service.py 全量注入：load_store_memory 拉出所有 store_memories 行拼成字符串压进 system prompt。计划中的 pgvector HNSW 索引 + EmbeddingProvider + top-k 召回 + 软衰减一行代码未动，也未新增 EmbeddingProvider 接口。这意味着记忆条数一多就撑爆 context、稀释相关性、成本线性涨，是架构层面最大未完成项。
  - 依据: docs/plans/AI-Agent转型-编排.md:§4.6；server/services/memory_service.py（无 embedding 字段）；server/api/v1/agent.py:103（load_store_memory 全量）
- **P4 主动出击完全未启动，P3 真发布/真上架均引导人工**: P4（排程引擎/门店状态监测/合规推送通道/预生成）无任何代码。P3 定稿边界：美团无商户内容发布 API、小红书无发笔记 API、抖音有官方 create_video 但企业资质门槛极高，因此全部走「AI 备内容 + 一键复制 + 引导手发」模式，「真发」路径不做。GLM A/B 实测（P1 验收条件之一）未做，生产仍全 DeepSeek。
  - 依据: docs/plans/AI-Agent转型-编排.md:§5（P3/P4 范围）；server 无 schedule/proactive 相关文件；config.py:59-86（GLM 配置位预留但空）

### 差距/缺失
- P1.6 跨会话持久化：Agent 对话应落库（type=agent）+ conversation_id 续接，目前刷新即丢——计划明确要做，代码里是 TODO 注释
- P1 验收条件之一「GLM A/B 实测，确认 DeepSeek 规划稳定性或切换」未做，生产大脑仍全 DeepSeek，规划可靠性无实测数据
- P2 记忆升级（pgvector 召回 + EmbeddingProvider + HNSW 索引 + 软衰减）：编排计划列为最高优先级，完全未启动；当前全量注入随着店脑增长会撑爆 context
- P2 对话滚动总结（把早期对话压成摘要，防信息直接丢）：未做
- P2 Skill 规范化（把运营 SOP 知识沉淀为标准化技能条目供 Agent 按需加载）：未做
- P1 剩余工具包装：SOP（前厅话术）、performance（绩效模板）、reports（日报）、repurpose（内容变体）、batch（批量生成）计划在 P1 包成工具但尚未登记进 registry
- P3 真发布路径（企微群发 API、抖音 create_video、小红书 openSDK 唤起 App）：定稿边界是「引导人工发」，但编排文档中的「有余力再上官方 API」部分完全未碰
- P4 主动出击（排程引擎 / 门店状态监测 / 合规推送通道 / 预生成）：完全未启动
- loop 打点（loop 里调 log_event 记录 agent 会话成功/失败）：计划列为移动端三件套之一，未做
- CLAUDE.md §8 计划改写（项目定位/架构原则/不做自动触达更新为合规审批闸模式）：编排文档说「随落地实时更新」，但 CLAUDE.md 中项目定位仍是原描述，未同步 Agent 架构

### 建议
- 最高优先：做 Agent 对话落库 + conversation_id 续接（P1.6）。具体：在 generation 表新增 type=agent 行（或复用 conversation 表），/agent/chat 落库并返回 conversation_id，前端在 chat/page.tsx 把 conversationId 存 localStorage，刷新后恢复历史。这是微信 WebView 刚需，用户说完一句话被切出去就丢上下文是严重体验断裂。估时：1 天
- 高优先：做 loop 打点（log_event 记录 agent 会话事件：turns/工具调用链/最终耗时/停止原因）。复用现有 usage_event_service.log_event，故障安全。加上后 admin /usage/scenarios 就能看到 Agent 调用链数据，喂下一轮优化。估时：半天
- 高优先：做 GLM A/B 实测。现有代码 config.py:59-86 已预留 orchestration_model_provider/name 可一键切换，只需在 .env 配 GLM-4.6 的 base_url/key，拿 5-10 个真实老板需求场景跑对比，得出「继续 DeepSeek 或切 GLM」的实测结论。这是 P1 验收条件，不做则大脑稳定性是未知量。估时：半天
- 中优先：启动 pgvector 记忆升级。第一步先确定 EmbeddingProvider 来源（OpenAI text-embedding-3-small 最简单、项目已直连 api.openai.com），写接口 + 加 store_memories.embedding 列 migration + HNSW 索引，然后把 load_store_memory 改成 top-k 相似召回。这是架构层面最大技术债，越晚做越贵（店脑越积越大）。估时：2-3 天
- 低优先但高价值：把剩余 5 个工具包成 Agent 工具：SOP（sop_service）、绩效模板（performance_service）、日报（reports 字段抽取）、内容变体（repurpose_service）、批量生成（batch）。每个工具约 30 行代码，难度极低（直接调现有 service），加上后 Agent 覆盖的场景宽度翻倍。建议先做 repurpose（用户常用），再做 sop/performance。
- 分支合并时机评估：AI-Agent-Dev 已领先 main 27 个 commit，核心功能稳定（压测通过）。建议等 P1.6 落库做完再合并 main 部署，否则「刷新丢历史」会让管家主界面体验显著低于预期。合并前跑 bash scripts/test.sh 全套确认绿灯。
- CLAUDE.md 更新：同步 Agent 架构现状——项目定位改为「台球房运营 AI Agent」、核心架构原则新增 ReAct/工具注册表/审批闸描述、「不做自动触达」改为「走合规通道 + 审批闸」。这不是纯文档活，是新会话上下文定位的权威来源，漂移越久新 Claude 实例越容易偏航。

---

## 7. 台球房AI运营SaaS — BYOK（用户自带API Key）架构评估

**核心结论**: 当前系统是纯全局单Key架构：所有用户共用老板服务器.env里的DeepSeek Key（文本）和OpenAI Key（生图），Key从未下到用户/门店模型层。ProviderFactory是进程级单例缓存，provider实例在进程启动时用全局Key初始化一次，之后所有请求复用同一实例。DeepSeek Key有3处旁路直连（memory_service、poster_prompt_engine、orchestrator直接new AsyncOpenAI），绕过ProviderFactory，BYOK改造必须覆盖这些散点。OpenAIImageProvider已经通过__init__参数接收api_key/base_url（非硬写settings），但poster_service.py仍从settings.openai_api_key取值传入，所以生图侧有一半改造基础。数据库User、Store模型完全没有BYOK相关字段，配额系统只管次数/tokens，没有key源切换逻辑。当前没有任何加密基础设施。若要落地BYOK，最小路径是：在stores表（或新建store_api_keys表）加加密字段 → provider lookup时优先取门店key、fallback全局key → 拆除DeepSeek 3处旁路到统一工厂。

### 关键发现
- **API Key 是纯全局单Key，来自.env，所有用户共用**: config.py定义deepseek_api_key/openai_api_key两个字段，默认空串，实际由server/.env注入。服务器只有一份.env，所有用户（不管是哪家门店）的每一次AI调用都走同一个Key。文本Key用量计入同一个DeepSeek账户，OpenAI Key的IPM限额也是全局共享的。用户侧没有任何Key配置入口。
  - 依据: server/config.py:29-32
- **ProviderFactory是进程级单例缓存，Key固化在provider实例里**: ProviderFactory用两个类变量dict做缓存（_text_cache/_image_cache），get_text_provider()第一次调用时实例化DeepSeekProvider并缓存，之后全程复用。DeepSeekProvider._get_client()在首次调用时用settings.deepseek_api_key构造AsyncOpenAI client并作为实例变量缓存。这意味着Key在进程启动后就固化了，无法在运行时按用户/门店动态切换——如果想BYOK，每个不同Key都需要独立的provider实例，现有缓存机制是按provider name索引而不是按(name, key)索引。
  - 依据: server/services/ai/factory.py:10-13, 34-45; server/services/ai/providers/deepseek.py:17-31
- **OpenAIImageProvider已有构造函数参数接收Key，但调用方还是从settings取**: OpenAIImageProvider.__init__接受api_key和base_url参数（不写死settings），这说明图片provider的设计已经预留了传key的接口。但poster_service.py第180行仍然从settings.openai_api_key取值后传入，等于这个灵活设计没有真正被利用。这是BYOK改造成本最低的那一块：调用层改成从门店配置取key即可，provider类本身不用改。
  - 依据: server/services/ai/providers/openai_image.py:26-28; server/services/poster_service.py:180, 313
- **DeepSeek Key有3处旁路直连，绕过ProviderFactory**: 除了通过ProviderFactory走正常管道的所有文本生成外，有3个服务直接new AsyncOpenAI(api_key=settings.deepseek_api_key)：(1) memory_service._get_client()——店脑记忆抽取和整合；(2) poster_prompt_engine._get_client()——海报提示词扩写；(3) orchestrator.py实际走ProviderFactory但有些路径直接调get_text_provider()。这3处旁路在BYOK方案里必须同步改造，否则店脑/海报扩写永远走全局Key、BYOK覆盖不完整。
  - 依据: server/services/memory_service.py:58-62; server/services/poster_prompt_engine.py:27-31; server/services/ai/providers/deepseek.py:22-30
- **User和Store模型完全没有BYOK字段，数据库也没有key存储基础设施**: User模型（user.py）只有id/phone/password_hash/name/is_active/is_admin共6个字段。Store模型（store.py）有30+个运营相关字段，但完全没有任何api_key/encrypted_key类字段。UsageQuota模型只管次数配额（generation_limit/poster_limit），不知道Key来源。数据库目前跑到migration 020，没有任何key存储相关迁移。项目也没有引入任何加密库（如cryptography/Fernet/AES）。
  - 依据: server/models/user.py:1-31; server/models/store.py:1-88; server/models/quota.py:1-40
- **计费逻辑和配额系统只追踪次数/tokens，不区分Key来源**: run_generation()是所有非流式生成的统一管道，内部check_quota/increment_usage只按store_id记次数。quota表的monthly_generation_limit/monthly_poster_limit是服务商控制的配额闸，不是用户的Key消耗追踪。如果引入BYOK，用户自带Key的消耗不需要扣我们的配额限制，但现有配额系统没有"Key来源"字段，也没有bypass逻辑——需要新增一个"用BYOK跳过平台配额"的判断分支。
  - 依据: server/services/content_service.py:61-78; server/models/quota.py:20-29

### 差距/缺失
- ProviderFactory缓存是按provider name索引（如'deepseek'），BYOK要求按(provider_name, key)索引，否则不同门店的key会互相覆盖——现有缓存逻辑完全不支持多Key并发
- DeepSeek provider实例化时key固化在AsyncOpenAI client里（实例变量），不支持运行时按请求动态切换key；要BYOK必须改成每次调用时根据传入key决定用哪个client实例
- 3处DeepSeek旁路（memory_service/poster_prompt_engine/两个直连）绕过ProviderFactory，BYOK改造若只改factory会留下死角——店脑和海报扩写永远走全局Key
- Store/User模型没有api_key字段，需要新增数据库迁移；且完全没有key加密基础设施（无Fernet/AES等），key若明文存DB有泄露风险
- 配额系统不区分'用平台Key'和'用自带Key'——BYOK用户理论上不应受平台次数配额限制，但现有check_quota/increment_usage没有这个判断分支
- 前端完全没有Key配置页面（门店设置目前是运营资料，无AI配置入口），BYOK需要新增Key录入/验证/删除的UI流程
- Key验证机制缺失：用户录入Key时需要实时验证（发一个测试请求确认Key有效），否则用户填错Key到生成时才报错、体验差
- 没有Key使用审计：目前usage_events表只记录场景/成功失败，不记录用的是平台Key还是用户Key，无法做per-key用量分析
- 多成员门店的Key权限边界不清晰：一个门店有多个角色（老板/店长/助教），BYOK的Key只有老板级别才能设置，但现有RBAC权限矩阵没有'管理AI Key'这个权限维度

### 建议
- 最小改动路径第一步：新建migration 021，在stores表加两个可空字段 byok_deepseek_key_enc TEXT（加密后的DeepSeek Key）和 byok_openai_key_enc TEXT（加密后的OpenAI Key），并加一个 byok_enabled BOOLEAN DEFAULT FALSE。不要放在users表——Key属于门店而非个人，多成员共用同一Key
- 引入key加密：在server/core/增加 crypto.py，用Python cryptography库的Fernet对称加密，加密主Key（FIELD_ENCRYPT_KEY）存.env。读写DB时调encrypt/decrypt，DB里存密文——这样即使DB被dump，Key也不明文暴露。参考：from cryptography.fernet import Fernet
- 改造ProviderFactory支持per-key实例：修改 _get_or_create_text_provider(name, api_key=None) 签名，cache_key改为 f'{name}:{api_key[:8]}' 这样的复合key，让不同Key得到不同实例。调用方传入门店的byok_key（如有）或None（走全局settings）。这是最核心的架构改动
- content_service.run_generation()和stream.py的generate_stream调用处，在调provider之前先判断 store.byok_enabled，若是则从stores表取解密后的Key传给ProviderFactory；同时在这里跳过check_quota（BYOK用户消耗自己的配额，不扣平台额度）
- 3处DeepSeek旁路统一改造：memory_service._get_client()、poster_prompt_engine._get_client()改成接受可选api_key参数，默认fallback到settings.deepseek_api_key；调用方从store对象里传入byok_key。这3处用量低且内部调用，不需要复杂逻辑，加一个参数即可
- 前端门店设置新增'AI配置'tab（仅限owner/admin角色可见，通过RBAC控制），提供DeepSeek Key和OpenAI Key的输入框 + '验证'按钮（后端新增POST /api/v1/stores/{id}/byok/validate，发一个最小测试请求）+ 显示当前状态（已配置/未配置，不回显明文）
- RBAC权限矩阵（core/rbac.py）新增'manage_ai_keys'权限，只给owner角色；route层用require_permission('manage_ai_keys')守住Key的CRUD接口，避免店员修改老板的Key
- 分阶段实施建议：第一阶段只做OpenAI（生图Key）BYOK，改动最小（provider已有参数接口，只需加DB字段+前端UI）；第二阶段再做DeepSeek（文本Key）BYOK，涉及3处旁路和配额bypass。OpenAI Key单次生图$0.04-0.21，用户BYOK意愿更强，优先级高

---

## 8. 什么才算真正的 AI Agent —— 权威判据 + 台球运营 SaaS 定位评估

**核心结论**: 根据 Anthropic 官方文章（"Building Effective Agents"，官方）和 OpenAI 治理论文（官方），以下是可查证的核心结论。第一，Workflow 与 Agent 的本质分水岭不是"有没有用工具"，而是"谁在决定下一步"——代码预定义路径 vs LLM 动态决定自己的流程。第二，Augmented LLM（LLM + retrieval + tools + memory）是一切 agentic 系统的基础砖，但仅此还不够成为 agent。第三，真正的 agent 核心是自主循环：从环境中获取 ground truth → 据此规划 → 再行动，且能在不确定步数的任务里持续运转直到满足终止条件。第四，Anthropic 明确反对"为了 agent 而 agent"——自主性带来更高延迟、成本和复合错误风险，只有任务真正开放结构、无法硬编码路径时才值得上 agent。第五，OpenAI 明确指出 agenticness 是一个光谱而非二元状态，按"能在复杂环境中以有限监督自适应达成复杂目标的程度"来衡量。对台球运营 SaaS 来说，当前正确形态是"workflow 为主干、局部 agent 能力点缀"的混合架构，而非全 agent——用户的核心价值是可预期的文案/活动/日报输出，强行 agent 化只会增加不可控性和烧钱风险。

### 关键发现
- **Workflow vs Agent 的权威定义 [官方]**: Anthropic 原文精确区分：Workflow = 'systems where LLMs and tools are orchestrated through predefined code paths'；Agent = 'systems where LLMs dynamically direct their own processes and tool usage, maintaining control over how they accomplish tasks'。分水岭是控制权归属——workflow 的控制权在开发者写好的代码里，agent 的控制权在 LLM 本身的动态决策里。有工具调用不等于是 agent；工具调用被 LLM 自主决定何时调、调哪个、调几次，才是 agent 特征。
  - 依据: https://www.anthropic.com/engineering/building-effective-agents [官方]
- **Augmented LLM 是基础块，但不等于 Agent [官方]**: Anthropic 原文：'The basic building block of agentic systems is an LLM enhanced with augmentations such as retrieval, tools, and memory. Our current models can actively use these capabilities—generating their own search queries, selecting appropriate tools, and determining what information to retain.' 这说明 LLM + retrieval + tools + memory 是构建 agentic 系统的必要条件，但不是充分条件。关键词是 'actively use'（主动使用）和 'selecting'（自主选择）——LLM 不只是被动执行工具调用，而是自己决定要不要调、怎么调。
  - 依据: https://www.anthropic.com/engineering/building-effective-agents [官方]
- **Agent 的核心特征：自主循环 + 环境反馈 + 不确定步数 [官方]**: Anthropic 原文给出 agent 最简洁定义：'Agents are typically just LLMs using tools based on environmental feedback in a loop.'（LLM 在循环中基于环境反馈使用工具）。展开特征：①任务开始后'plan and operate independently'（独立规划执行）；②'gain ground truth from the environment at each step (such as tool call results or code execution) to assess progress'（每步从环境取真实结果评估进度）；③适用于'open-ended problems where it's difficult or impossible to predict the required number of steps'（无法预测步数的开放任务）；④有停止条件：达标或触发人工检查点。缺少任一环，就是 workflow 而非 agent。
  - 依据: https://www.anthropic.com/engineering/building-effective-agents [官方]
- **什么时候该用 Agent，什么时候简单 workflow 就够 [官方]**: Anthropic 明确给出四个上 agent 的条件：①任务开放结构、步数无法预测；②无法硬编码固定路径；③LLM 需要运行多轮；④你对其决策有一定信任基础（'you must have some level of trust in its decision-making'）。反面：'When building applications with LLMs, we recommend finding the simplest solution possible, and only increasing complexity when needed'（最简方案优先，只在必要时加复杂度）；'optimizing single LLM calls with retrieval and in-context examples is usually enough'（大多数情况单次 LLM 调用加检索就够）。任务可以分解为固定子任务时，用 workflow 获得可预测性与一致性更合适。
  - 依据: https://www.anthropic.com/engineering/building-effective-agents [官方]; https://www.anthropic.com/news/building-effective-agents [官方]
- **'不要为了 agent 而 agent'——复合错误与成本代价 [官方]**: Anthropic 原文：'The autonomous nature of agents means higher costs, and the potential for compounding errors.'（自主性意味着更高成本和复合错误风险）。'Agentic systems often trade latency and cost for better task performance, and you should consider when this tradeoff makes sense'（agentic 系统以延迟和成本换性能，需衡量是否值得）。框架可能诱使开发者'add complexity when a simpler setup would suffice'（在简单方案够用时仍堆复杂度）。核心论点：自主性不是目标，解决特定问题才是目标。
  - 依据: https://www.anthropic.com/engineering/building-effective-agents [官方]
- **OpenAI：agenticness 是光谱而非二元 [官方]**: OpenAI 官方论文（Shavit et al., 'Practices for Governing Agentic AI Systems'）定义：agenticness = 'the degree to which it can adaptably achieve complex goals in complex environments with limited direct supervision'（在有限监督下自适应地在复杂环境中实现复杂目标的程度）。这是一个属性（property）而非分类（category）——任何系统都在这个光谱上有位置，而非简单的'是/不是 agent'。核心维度：①目标复杂度；②环境复杂度；③监督的稀疏程度；④行动序列的自主规划能力。
  - 依据: https://cdn.openai.com/papers/practices-for-governing-agentic-ai-systems.pdf [官方]; https://openai.com/index/practices-for-governing-agentic-ai-systems/ [官方]
- **Agent 光谱判断清单（综合 Anthropic + OpenAI 标准）[官方综合]**: 基于两份官方文献提炼的 7 条可勾选判据：①LLM 自主决定下一步行动（vs 代码决定）；②存在工具调用且工具选择由 LLM 动态决定（而非固定调用序列）；③行动后从真实环境获取反馈并据此调整（ground truth loop）；④任务步数不确定、开放结构（vs 固定子任务分解）；⑤在有限或无人持续监督下能推进任务；⑥有明确的终止条件（成功/失败/人工介入）；⑦整体行为呈现从目标出发的规划能力（而非固定 prompt → 固定输出）。勾选 0-2 条 = 单次 LLM 调用；3-4 条 = workflow；5-7 条 = agent。
  - 依据: https://www.anthropic.com/engineering/building-effective-agents [官方]; https://cdn.openai.com/papers/practices-for-governing-agentic-ai-systems.pdf [官方]

### 差距/缺失
- 当前系统缺少真正的'环境反馈循环'——大多数功能是 user input → single LLM call → output，没有 LLM 基于工具执行结果自主调整再行动的回路，按 Anthropic 定义属于 workflow 而非 agent
- 工具调用（tool use）尚未实现：系统内没有 LLM 自主调用外部工具（如搜索、数据库查询、计算器、API）并根据结果决策下一步的能力，只有 RAG-style 知识注入，不算动态工具选择
- 店脑（store_memories）虽然是 memory 层，但注入是被动的（每次生成前批量注入），不是 LLM 在任务过程中主动决定'要查哪段记忆'，缺少 active memory retrieval 能力
- 没有 multi-turn autonomous planning：日报、文案等任务均为一次性生成（单轮或伪多轮），LLM 不会基于输出质量自主决定'要不要重写''要不要补充信息'
- 按教科书 AI Agent 定义，'自主循环'是核心，但当前系统的循环（多轮对话）是由用户推动的，而非 LLM 自主推进——缺少 LLM 作为主驱动者的 autonomous loop
- 缺少主动触达能力的合规安全出口：计划中的'主动出击'功能（群发等）有封号红线，但替代方案（待确认工作流、审批闸）尚未完整落地，导致 agent 转型计划有空白地带
- 没有 orchestrator/subagent 架构：当前为单一 LLM 调用路径，缺少 Anthropic 描述的'central LLM dynamically breaks down tasks, delegates them to worker LLMs'的分层 agent 能力

### 建议
- 明确产品定位为'智能 workflow + 局部 agent 能力'混合架构，而非全 agent——Anthropic 原则'最简方案优先'在这里完全适用：文案/日报/活动策划是结构化任务，workflow 的可预期性和成本优势远超全 agent
- agent 能力只在三个场景值得引入：①经营诊断（需要 LLM 自主决定查哪些指标、调哪些工具、多轮推进才能给出结论）；②约客助手（需要根据客户回复动态决定下一步话术，有真正的环境反馈循环）；③主动推荐引擎（根据门店实时信号自主选择推荐什么、何时推荐）——这三个场景满足'步数无法预测、无法硬编码路径'的条件
- 按 agent 光谱 7 条清单自评每个功能模块：工作台文案生成≈1-2 条（单次调用）、经营诊断≈3-4 条（接近 workflow）、约客助手理论上≈5-6 条（若加入真实反馈循环）——用这个评分指导'哪里值得投入 agent 改造'
- 落地'环境反馈循环'的最小实现：让诊断模块能调用一个'查询门店数据摘要'工具，LLM 看到数据后自主决定要不要追加查询其他维度，再给结论——这是从 workflow 升级到 agent 的最小一步，成本可控
- 店脑从被动注入升级为 active retrieval：生成时不再全量注入所有记忆，而是让 LLM 先看任务描述，自主生成检索 query 查相关记忆片段——满足 Anthropic 'generating their own search queries' 描述，这是 Augmented LLM 的正确实现
- 严守 Anthropic 的成本纪律：'autonomous nature means higher costs, and the potential for compounding errors'——每次引入 agent 能力必须评估：这个任务的步数真的无法预测吗？如果可以预测、可以硬编码，就保持 workflow，不要因为'agent 更酷'而升级
- 文档中已有的 AI Agent 转型计划（docs/plans/AI-Agent转型-编排.md）应对照本判断清单逐功能重新过一遍，凡满足 workflow 定义的功能不要冠以'agent'之名，避免技术方案过度设计

---

## 9. Anthropic Agent Skills 真实机制查证 + DeepSeek 自建类 Skill 机制可行性分析

**核心结论**: Agent Skills 是 Anthropic 于 2025 年 12 月发布的结构化能力包机制，核心是一个含 SKILL.md 文件的文件夹，配合三层渐进加载（元数据→正文→按需资源）实现 context 效率最大化。用户的理解"借鉴外部内容再输出"方向正确但不完整——Skill 不是"查资料"，而是"按需注入专业流程/规则/脚本"的声明式能力合约，且只在被触发时才消耗 context。与 Tool（执行函数）、MCP（传输协议）、RAG（向量检索文档）是四个不同维度的机制。Agent Skills 是 Claude 平台原生特性，DeepSeek 无原生支持，但本项目的 KNOWLEDGE_KEYWORDS + _select_knowledge_keys + PromptEngine.render 机制已是一套原生"类 Skill 机制"的雏形：固定核心知识（Level-1 常驻）+ 关键词触发场景知识注入（Level-2 按需）。对标官方 Skill 三层模型，本项目缺少 Level-3 可执行脚本层（目前只有 YAML 知识，没有可调用的结构化工具脚本），以及精确的"description 触发语义匹配"（当前靠关键词列表，无语义向量）。可在现有架构上渐进升级，不需要重写。

### 关键发现
- **Agent Skills 官方定义：结构化能力包，不是知识检索**: 官方文档原文：'Skills are reusable, filesystem-based resources that provide Claude with domain-specific expertise: workflows, context, and best practices that transform general-purpose agents into specialists. Unlike prompts (conversation-level instructions for one-off tasks), Skills load on-demand and eliminate the need to repeatedly provide the same guidance across multiple conversations.' 核心差异在于：Skill 是声明式能力合约（含执行流程、工具依赖、输出规范），而非文档检索。它告诉模型'当遇到 X 场景时，按 Y 流程走，可调用 Z 脚本'——是专业流程知识的结构化封装，而不是把外部内容喂给模型后再输出。用户理解中'借鉴外部内容'方向对，但缺少'结构化流程约定'和'按需加载省 context'两个关键维度。
  - 依据: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview [官方]
- **三层渐进披露（Progressive Disclosure）机制：官方文档完整描述**: 官方文档定义三层：Level-1 元数据（始终加载）：YAML frontmatter 的 name + description 字段注入系统 prompt，每个 Skill 约 100 tokens，100 个 Skill 仅 ~10,000 tokens，Claude 只知道'有哪些 Skill、何时触发'；Level-2 指令（触发后加载）：请求匹配 description 时，Claude 用 bash 从文件系统读 SKILL.md 正文（< 5,000 tokens），只有此时指令才进入 context；Level-3 资源与脚本（按需加载）：SKILL.md 引用的附加文件（FORMS.md、REFERENCE.md）和可执行脚本（fill_form.py），仅被引用时才读取，脚本执行时只有输出进 context、源码不消耗 token。官方表格明确：Level-1 ~100 tokens/Skill；Level-2 < 5k tokens；Level-3 实际上无上限（因为不进 context）。之所以省 context：绝大多数 Skill 在单次会话中根本用不到，Level-3 内容直接在 VM 里执行，源码永不进 context。
  - 依据: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview — 'Three types of Skill content, three levels of loading' 一节 [官方]
- **SKILL.md 文件结构：必填字段与文件夹约定**: 每个 Skill 是一个目录，结构：skill-name/SKILL.md（必须）+ scripts/（可选，Python/Bash/JS）+ references/（可选，详细文档按需加载）+ assets/（可选，模板/schema/数据）。SKILL.md 必须包含 YAML frontmatter：name（最长 64 字符，只含小写字母+数字+连字符，不能含 'anthropic'/'claude'）和 description（最长 1024 字符，非空，不含 XML 标签）。description 字段是激活触发器，官方要求写清楚'做什么 + 什么场景下用'，精确 description 才能精确触发，模糊描述会导致无关任务误触发或该触发时不触发。正文是普通 markdown，写步骤/最佳实践/对其他文件的引用。
  - 依据: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview — 'Skill structure' 一节 + firecrawl.dev/blog/agent-skills [官方+二手]
- **Skill vs Tool vs MCP vs RAG：四种机制对比**: Tool（工具）：可执行函数，Claude 调用后得到返回值，是'做什么'的执行层；MCP（Model Context Protocol）：传输协议，负责在 AI 与外部系统之间传数据/工具定义，是'连接层'，解决'如何接入外部能力'的问题；RAG（检索增强生成）：向量检索相关文档片段注入 context，是'查什么文档'的信息检索层；Skill（技能）：声明式能力合约，告诉模型'遇到 X 场景按 Y 专业流程走，可用 Z 脚本'，是'怎么做某类任务'的专业流程层。firecrawl 原文：'MCPs transport data; skills transport domain instructions that teach agents when and how to work.' RAG 拉文档，Skill 编码工作规则和惯例。四者可叠加：Skill 里可以调用 Tool，Tool 定义可通过 MCP 传输，Skill 里也可以包含 RAG 查询步骤。
  - 依据: https://www.firecrawl.dev/blog/agent-skills — 'Comparison to Alternatives' 一节 [二手，与官方机制一致]
- **Agent Skills 是 Claude 平台特性，但概念已成开放标准；DeepSeek 无原生实现**: Agent Skills 2025 年 12 月由 Anthropic 发布，规范托管在 agentskills.io（v0.9 草案，v1.0 预计 2026 H2），GitHub 官方仓库 anthropics/skills 提供 17 个开源 Skill。发布数周内 GitHub Copilot、VS Code、Cursor、OpenAI Codex、Gemini CLI 等约 40 个客户端跟进采纳。DeepSeek API 是无状态 /chat/completions，没有 VM 文件系统，没有 bash 执行环境，没有 Skill 注册/发现机制。但 Skill 的核心思想（分层按需注入专业流程知识）可以在任何 LLM 上用应用层代码模拟实现，代价是失去 Level-3 的脚本执行能力（DeepSeek 没有 VM 环境），但 Level-1 + Level-2 两层的 context 效率优化完全可以自建。
  - 依据: https://github.com/anthropics/skills [官方] + https://www.newsletter.swirlai.com/p/agent-skills-progressive-disclosure [二手]
- **本项目现有机制已是 Level-1+Level-2 的类 Skill 实现雏形**: server/services/content_service.py 的 CORE_KNOWLEDGE_KEYS（4 条，始终注入）对应 Skill Level-1 的'元数据层'（但注入的是全文而非仅 description）；KNOWLEDGE_KEYWORDS 字典（44 条场景知识+关键词映射）+ _select_knowledge_keys 函数（关键词命中打分+最多 4 条）对应 Level-2 的'按需触发加载'。PromptEngine._load_all() 启动时加载全部 44 个 knowledge YAML（全量到内存），但 render 时只注入被 _select_knowledge_keys 筛出的子集到 prompt。这个机制与官方 Skill 设计思路高度一致，区别在于：① 触发机制是关键词匹配而非语义理解；② 没有 Level-3 可执行脚本层；③ 元数据层实际上注入了全文（YAML 完整内容），而非只注入 name+description。
  - 依据: /Users/swl/Desktop/球房 ai 运营助手/server/services/content_service.py:226-300 + /Users/swl/Desktop/球房 ai 运营助手/server/services/ai/prompt_engine.py:45-56
- **'渐进发现'比'渐进披露'更准确的工程语义**: 开发者社区对命名有讨论：'progressive disclosure'借自 UX 设计（主动控制信息显露），但实际机制是 Claude 主动用 bash 命令去读文件——是模型在做条件决策'是否值得深入'，而非 Skill 在'控制披露'。Anthropic 工程博客实际上用了 discovery 语言描述具体机制，尽管官方文档标签仍用 disclosure。这个区分对 Skill 作者有实际意义：问题不是'这一层应该披露什么'，而是'Claude 能在这里找到足够信息决定是否继续深入读吗'。description 字段是 Claude 做 Level-1→Level-2 跳转决策的唯一依据，所以它的写法决定触发精度。
  - 依据: https://dev.to/phil-whittaker/progressive-discovery-a-better-mental-model-for-agent-skills-51bd [二手] + https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills [官方]

### 差距/缺失
- 用户理解的核心偏差：'借鉴外部内容再输出'把 Skill 等同于 RAG（查资料），忽略了 Skill 的本质是'结构化专业流程约定'——它规定的是'遇到 X 场景按 Y 步骤操作，可调用 Z 工具'，不仅仅是补充领域知识
- 现有项目 Level-1 层实现不完整：CORE_KNOWLEDGE_KEYS 注入的是 YAML 全文而非仅 description 摘要，导致 4 条核心知识每次占据数千 token；官方 Skill 的 Level-1 每条只有 ~100 token（仅 name+description）
- 现有项目触发机制精度有限：KNOWLEDGE_KEYWORDS 关键词列表需要人工维护，遇到同义词/上下文变体会漏触发；官方 Skill 依赖模型自身语义理解 description 来判断相关性，不需要维护关键词表
- 现有项目缺少 Level-3 脚本执行层：所有知识都是 YAML 文本，没有可执行的工具脚本；DeepSeek 无 VM 环境，但可用 FastAPI 工具函数模拟（不过需要 Function Calling 支持，DeepSeek v4-flash 支持 tool_use）
- 跨场景知识复用路径不清晰：44 条 knowledge YAML 各自独立，没有'Skill 引用其他 Skill'的组合机制，复杂任务（如诊断+引流+活动三合一）需要人工在 KNOWLEDGE_KEYWORDS 里堆关键词
- 没有 Skill 级别的效果反馈闭环：usage_events 记录了场景调用，但没有追踪'哪条知识被注入后效果好/差'，无法数据驱动优化知识库的触发策略

### 建议
- 【立即可做，改 content_service.py】将 CORE_KNOWLEDGE_KEYS 改为两级：核心摘要层（~100 token 的 description 字段，每次注入）+ 核心全文层（按需注入），避免 4 条核心知识每次全量灌入 prompt。在每个 knowledge YAML 里加一个 `summary:` 字段（2-3 句话），作为 Level-1 始终注入的内容，`template:` 作为 Level-2 触发后注入
- 【中期，改触发机制】_select_knowledge_keys 增加一个 LLM 语义匹配兜底层：当关键词命中 0 条时，用轻量 DeepSeek 调用（< 200 token）判断用户意图与哪些 Skill summary 最相关，而不是完全不注入任何场景知识。这解决同义词/上下文变体漏触发问题
- 【中期，标准化 YAML 结构】在所有 44 个 knowledge YAML 里补充 `summary:` 字段（1-2 句话，作为 Level-1 元数据）和 `triggers:` 字段（列出触发意图描述，比关键词表更语义化）。这让 knowledge YAML 的结构完全对应 Skill 的 frontmatter+description，未来迁移到任何支持 Skill 标准的平台都无需重写
- 【中期，对应 Level-3】利用 DeepSeek 的 tool_use（Function Calling）能力，把现有的数据计算/格式化逻辑（如 core_metrics 的指标公式、report_forms 的 YAML 表单处理）包装成可调用工具函数，在 Skill 正文里引用。这样指令文本里只写'调用 calculate_metrics 工具'，工具源码不进 context，实现对 Level-3 脚本层的近似模拟
- 【数据驱动，改 usage_events】在 usage_events 中增加 injected_knowledge_keys 字段，记录每次生成实际注入了哪些知识；结合已有的 feedback（效果好/差）事件，定期跑统计'哪些知识被注入后正向反馈率更高'，用数据指导 KNOWLEDGE_KEYWORDS 的关键词更新和 _MAX_SCENE_KNOWLEDGE 阈值调整
- 【架构认知对齐】本项目的 PromptEngine + KNOWLEDGE_KEYWORDS + _select_knowledge_keys 组合已经是一套可用的'DeepSeek 上的类 Skill 机制'，与官方 Skill 三层模型的对应关系是：Level-1=CORE_KNOWLEDGE_KEYS（待优化为摘要层）、Level-2=KNOWLEDGE_KEYWORDS 触发注入、Level-3=待建工具函数层。不需要重构，沿着这条路渐进升级即可

---

## 10. LLM"自我进化"技术真相 与 垂直行业SaaS（台球房）"让AI越来越懂行"的可落地路径

**核心结论**: 真相一：DeepSeek /chat/completions 是无状态API，推理时权重完全冻结，单次或多次调用不会让模型"学会"台球。官方文档原话是"The server does not record the context of the user's requests"，开发者必须把历史自己拼进messages再传。真相二："看起来在进化"是系统层（应用层架构）的工程幻象，不是模型内部变化，共有四条外部机制可实现这一效果：in-context反思循环、长期记忆注入、RAG知识检索、eval驱动的人工迭代。真相三：In-context self-refinement（让模型自己批判自己）2024年一项系统研究发现"no clear evidence of inherent Self-Refinement"，单模型批判自己效果不稳定，双模型Reflexion更可靠但需要外部验证信号。真相四：真正改变权重的微调（Fine-tune/RLHF）成本极重——需要高质量标注数据集+ML基础设施+持续迭代循环，台球房SaaS当前体量不到触发微调门槛。真相五：对本项目最现实的"越来越懂台球"路径是：精调YAML知识库（RAG/prompt注入）+ 店脑记忆（已有）+ eval驱动迭代（LLM-as-judge打分 → 自动标记偏差 → 人工审核改YAML）三层闭环，成本极低且项目现有架构已有完整基础。

### 关键发现
- **核心真相：推理时模型权重冻结，DeepSeek API无状态，绝不自动进化**: DeepSeek /chat/completions 是完全无状态的API。服务端不记录任何请求上下文，不会因为你调用多了就变懂台球。官方原话：'The server does not record the context of the user's requests. To implement multi-round chat, the user must concatenate all previous conversation history.'。这是标准LLM推理架构的根本约束：模型权重在训练后就冻结了，生产API调用期间没有梯度更新、没有反向传播、没有权重变化。所谓'越用越懂'如果发生，100%是应用层的工程机制在起作用，而非模型本身在变化。
  - 依据: https://api-docs.deepseek.com/guides/multi_round_chat [官方]；https://medium.com/@danaasa/the-truth-behind-self-improving-llms-f18c19a78e9b [二手]
- **机制一：In-context反思/自我批判（Reflexion/Self-Refine）——有效但有条件**: Reflexion（Shinn et al. 2023）让Agent先产出结果，再由同一模型或另一模型对输出进行语言批判，把批判结论存入记忆缓冲区，下一次尝试时注入上下文重新生成。在编程任务（HumanEval）上比基线提升11个百分点，QA提升约20点。但2025年系统研究发现：'LLMs show no clear evidence of inherent Self-Refinement and may even experience response quality degradation after Self-Refinement'——单模型自批判自己并不可靠，需要外部验证信号（如运行测试、人类评分）才有效。台球场景缺乏客观验证信号，单纯让DeepSeek自己批判自己产出的台球文案，效果不稳定，很可能批着批着跑偏。
  - 依据: https://arxiv.org/abs/2303.11366 Reflexion论文 [官方]；https://arxiv.org/pdf/2502.05605 Self-Refinement综述 [官方]
- **机制二：长期记忆注入（Memory）——项目已有，是目前最有效的'越用越懂'机制**: 把'什么内容有效、什么格式老板爱用、这家店的特殊情况'写入持久化记忆，下次调用时注入prompt末尾。本质是：权重不变，但每次喂给模型的上下文在进化。这是项目已实现的'店脑'机制（store_memories表 + memory_service.py），从生成/对话后台异步抽取门店记忆 → pg_advisory_xact_lock防并发丢失 → 每次生成前注入prompt。这是最低成本、最直接的'越用越懂'实现，且已通过golden测试套件验收。核心约束：记忆质量取决于抽取逻辑，需要定期检查store_memories表看记忆是否准确反映台球行业现实。
  - 依据: 项目文件 /Users/swl/Desktop/球房 ai 运营助手/server/services/ai/providers/deepseek.py + CLAUDE.md店脑章节 [官方]；https://medium.com/@danaasa/the-truth-behind-self-improving-llms-f18c19a78e9b [二手]
- **机制三：RAG/知识注入——通过改YAML知识库让模型'突然变懂'台球**: 模型权重里其实有大量台球相关知识，但没有被激活或被错误方向激活。通过把精准的行业知识（43个knowledge YAML + 54个operation YAML）注入prompt，让模型的输出贴近台球现实。这不是让模型'进化'，而是给它更准确的参照系。项目的prompt_engine.py实现了这套机制。当产出不符合行业逻辑时，根因几乎必然是：a) 对应YAML覆盖不到该场景，b) YAML内容本身描述不够精确，c) 选知识的_select_knowledge_keys逻辑没选中相关YAML。改YAML是最直接、最快生效的修正路径，不需要改代码。
  - 依据: 项目文件 /Users/swl/Desktop/球房 ai 运营助手/server/services/ai/prompt_engine.py [官方]；https://www.useparagon.com/blog/rag-vs-finetuning-saas [二手]
- **机制四：Eval驱动迭代（LLM-as-judge + 人工审核）——工程界主流'让系统越来越准'的办法**: 用另一个LLM（judge）对产出打分，标记不符合台球行业逻辑的输出，积累成数据集，人工审核后改prompt/YAML，再跑eval验证改善效果。形成一个数据飞轮：生产trace → AI judge标记偏差 → 人工审核确认 → 改知识库/prompt → 再eval。Evidently AI指出judge模型的判断与人类评判一致性可达>80%，但judge prompt本身质量决定判断可靠性，且judge结果需要人工周期性抽样校验以防偏移。项目已有usage_events表（migration 020）和feedback系统（效果好/差），是这套数据飞轮的天然底层。
  - 依据: https://www.evidentlyai.com/llm-guide/llm-as-a-judge [二手]；项目文件 server/api/v1/feedback.py + server/models/usage_event.py [官方]
- **机制五：DSPy自动优化prompt——存在但不适合当前阶段**: DSPy（Stanford，2023）把prompt当'可编译的程序'，用评分函数+示例自动迭代prompt措辞，F1可从0.41提升到0.63（官网案例）。已在Shopify、Dropbox等生产环境使用。但有前置条件：需要定义结构化的输入输出签名，需要可自动运行的评分函数，需要相对固定的任务格式。台球文案生成的'好坏'标准难以自动化打分（需要行业专家判断），且项目prompt是YAML模板而非DSPy签名体系——引入DSPy意味着重写prompt管理层，成本不成比例。结论：DSPy是一个值得了解的高级技术，但在本项目完成eval闭环前不应引入。
  - 依据: https://dspy.ai/ [官方]；https://towardsdatascience.com/systematic-llm-prompt-engineering-using-dspy-optimization/ [二手]
- **机制六：微调/RLHF（真改权重）——成本极重，当前阶段不值得**: 微调能让模型在风格/格式/领域术语上达到98-99.5%一致性（vs prompt工程的85-95%），且用短prompt就能调出垂直领域效果，长远每次调用成本更低（约省30-60%延迟）。但门槛：需要高质量标注数据集（1000条精标 > 10000条糟糕数据），需要ML基础设施，需要持续迭代循环。对台球房SaaS：行业足够垂直（有价值），但台球文案训练集几乎为零，标注成本高，且DeepSeek官方没有开放fine-tune API（只有推理API）。Anthropic宪法AI（Constitutional AI）等RLHF高级玩法是大厂自己训练基础模型用的，不是调API的应用层开发者能直接复用的。结论：现阶段不值得，等RAG+eval闭环跑通、业务量上来、有足够高质量语料再考虑。
  - 依据: https://www.heavybit.com/library/article/llm-fine-tuning [二手]；https://www.anthropic.com/research/constitutional-ai-harmlessness-from-ai-feedback [官方]；https://dextralabs.com/blog/fine-tuning-llm/ [二手]

### 差距/缺失
- 现有store_memories抽取逻辑只从用户输入中学，无法从AI产出的'质量'中学——不知道哪条记忆指导出了好内容、哪条指导了差内容，记忆更新无反馈闭环
- feedback表（效果好/差）数据目前只用于卡片排序，没有连回prompt/YAML改进流程——积累的信号被浪费了
- usage_events表有失败率/场景数据，但没有自动触发'这个场景失败率高→ 检查对应YAML'的机制
- 43个knowledge YAML没有版本化测试——改了一个YAML后不知道其他场景有没有受影响（回归测试缺失）
- 没有LLM-as-judge层：当前只有用户手动点'效果好/差'，没有自动化eval能持续批量评估产出质量是否贴近台球行业逻辑
- 知识库（YAML）的内容本身是否准确反映台球行业现实，没有周期性专家复核机制——可能内容已过时但没人发现
- Reflexion/self-critique如果未来引入，缺少'外部验证信号'——台球文案的好坏没有客观评分函数，纯模型自批容易自圆其说

### 建议
- 【立刻可做，成本接近零】把现有feedback数据（效果好/差）连回知识改进流程：每月导出feedback=差的generation记录，按prompt_key聚合，找失败率>30%的场景对应YAML手动审查并修正。这是最快的'反馈进化闭环'，完全利用已有数据。
- 【建议本月实施】设计一个轻量eval套件（类比现有eval_store_brain.py）：选10-20个代表性台球场景，每个有2-3个'北极星输出样例'（符合行业逻辑的），用DeepSeek-as-judge对每次改YAML前后的产出打分（1-5分），改了YAML就跑一遍，分数回退则不合并。文件放docs/test-runs/，每轮存档对比。
- 【反馈进化闭环设计】产出→用户点'效果差'或judge自动标记低分→logging到usage_events带fail_reason字段→每周自动聚合高失败率场景→对应YAML文件路径由_select_knowledge_keys反查→人工审查YAML内容是否准确→修正后跑eval套件验证→合并→下一轮。这是教科书eval-driven改进路径，本项目基础设施已完备。
- 【店脑记忆闭环强化】当前store_memories只从用户输入学。建议增加：当用户点'效果好'时，异步提取该次生成对应的关键决策（哪个知识片段起了作用）存入正向记忆标签；点'效果差'时提取'此路不通'的信号。让店脑记忆不只是'这家店的事实'，还包括'什么生成策略对这家店有效'。
- 【知识库健康检查】每季度对43个knowledge YAML做一次'行业对照审查'：从usage_events中找调用最多的top10场景，把对应YAML的关键段落喂给DeepSeek问'这个说法在台球行业是否准确'，把偏差记录成issue。这不是让AI自己进化，而是用AI辅助人工审查知识库准确性。
- 【In-context Reflexion的谨慎引入】如果某类场景（如诊断报告、活动策划）产出质量不稳定，可以试引入两步生成：第一步正常生成→第二步用专门的评审prompt让DeepSeek从'台球老板视角'批判第一步的结果（而非同一prompt自批）→第三步基于批判重写。但必须有人工抽样验证二次批判确实改善了输出，否则关掉，因为研究显示单模型自批不稳定。
- 【长期但不紧迫：微调节点判断】当项目积累了500条以上被用户明确标注'效果好'且涵盖20+台球场景的generation记录时，可以评估是否值得微调。届时DeepSeek也可能开放fine-tune API。在此之前，所有'改模型'的想法都应转化为'改YAML/改prompt/改记忆'，这是成本和效果比最优的路径。

---

## 11. BYOK（Bring Your Own Key）通用架构调研——台球房运营SaaS落地参考

**核心结论**: BYOK在开源AI产品中已有成熟模式，但实现路径分两大类：(1) 本地优先工具（Cline/Continue.dev）——key存用户本机（VSCode SecretStorage/文件系统0o600权限），完全不过服务端，无需服务端加密；(2) 服务端SaaS（LibreChat/OpenWebUI）——key加密存服务器DB，用AES-256-CBC/CTR+服务端主密钥，用户只能通过API读取过期时间、不能明文取回。LiteLLM Gateway提供第三条路：用户key以请求头`x-api-key`实时透传到provider，服务端只存虚拟key，真实key一次性用完即走、不持久化。安全最佳实践核心：传输TLS/密文存DB/不落日志/一用户一DEK（Data Encryption Key）/支持即时撤销。多Provider统一抽象首选OpenAI兼容格式（已有90%+主流模型支持），中小项目自建适配器即可，不必引LiteLLM增加运维复杂度。BYOK后计费分两轨：BYOK用户AI Token成本自付，平台只计SaaS功能额度（海报生成次数/工作台使用次数）保持商业可持续，这是业界主流做法。我们项目的ProviderFactory已有干净的抽象层，落地BYOK的最小改动是：新增`user_keys`加密DB表+settings页填key+factory按`user_key`优先取key+BYOK用户跳过token计费但不跳过功能次数配额。

### 关键发现
- **Cline：key存本机文件系统，0o600权限保护，无服务端加密**: Cline将所有AI provider API key（openRouterApiKey/geminiApiKey等20+个）存入`~/.cline/data/secrets.json`，文件权限0o600（owner only读写）。这是VSCode SecretStorage的文件迁移版，原VSCode路径是系统Keychain（macOS）/libsecret（Linux）/Credential Vault（Win），现在统一到文件便于跨IDE共享（VSCode/CLI/JetBrains）。key不过任何服务端，完全本地持有。代码位置：`apps/vscode/src/shared/storage/storage-context.ts`第43行`fileMode: 0o600 // Owner read/write only — protects API keys`；`state-keys.ts`枚举了完整secrets列表。
  - 依据: https://github.com/cline/cline/blob/main/apps/vscode/src/shared/storage/storage-context.ts [官方] https://github.com/cline/cline/blob/main/apps/vscode/src/shared/storage/state-keys.ts [官方]
- **LibreChat：服务端AES-CBC/CTR三代加密演进，key按userId绑定存MongoDB**: LibreChat的Key schema（`packages/data-schemas/src/schema/key.ts`）存字段：userId/name/value/expiresAt，其中value存密文。加密走`packages/data-schemas/src/crypto/index.ts`，共三代：v1=AES-CBC固定IV（遗留），v2=AES-CBC随机IV（`iv:ciphertext`格式），v3=AES-256-CTR（`v3:iv:ciphertext`格式）。密钥来自env var `CREDS_KEY`（32字节hex）+`CREDS_IV`，即服务器统一主密钥加密所有用户key。API端点：`PUT /api/keys`（存key）/`DELETE /api/keys/:name`/`GET /api/keys?name=xxx`（只返回过期时间，不返回明文）。前端用户填key→发PUT→服务端加密写DB→生成时解密用→用户无法取回明文。
  - 依据: https://raw.githubusercontent.com/danny-avila/LibreChat/main/packages/data-schemas/src/crypto/index.ts [官方] https://raw.githubusercontent.com/danny-avila/LibreChat/main/api/server/routes/keys.js [官方] https://raw.githubusercontent.com/danny-avila/LibreChat/main/packages/data-schemas/src/schema/key.ts [官方]
- **LiteLLM Gateway：实时key透传模式，`forward_llm_provider_auth_headers:true`将x-api-key直达provider**: LiteLLM的BYOK实现是请求级透传而非持久化：客户端在请求头带`x-api-key=<用户自己的provider key>`，proxy配置`forward_llm_provider_auth_headers: true`后，proxy把这个key优先转发给provider（高于proxy自身配置的key）。proxy只用`x-litellm-api-key`做proxy层认证追踪。用户key不存proxy DB，一次请求用一次。Virtual Keys（proxy自己的）则存DB用于按key/user/team做spend tracking和budget限制，这是proxy-managed key的路径，与BYOK透传是两套机制可共存。
  - 依据: https://docs.litellm.ai/docs/tutorials/claude_code_byok [官方] https://docs.litellm.ai/docs/proxy/users [官方]
- **OpenWebUI：目前只有per-user API key（让外部调用WebUI），BYOK for provider connections是未实现的feature request**: OpenWebUI现有的API Keys功能（`docs.openwebui.com/features/authentication-access/api-keys/`）是给外部系统调WebUI用的token，继承创建者权限，无法设置子集权限。真正意义的BYOK（用户填自己的OpenAI/Anthropic key接管admin配置的connection）在GitHub Discussion #21357处于feature request阶段，尚未实现。该讨论提出设计方案：admin配置的connection只让用户编辑认证字段，user配置的connection全开放，但尚无PR合入。
  - 依据: https://docs.openwebui.com/features/authentication-access/api-keys/ [官方] https://github.com/open-webui/open-webui/discussions/21357 [官方]
- **Continue.dev：纯本地config.yaml存key，推荐localEnv:ENV_VAR引用而非硬编码**: Continue.dev完全本地模式：API key写在`~/.continue/config.yaml`的`apiKey:`字段，或用`apiKey: localEnv:YOUR_ENV_VAR`引用shell环境变量（后者是官方推荐的安全做法，key不落文件）。没有服务端存储组件。Hub（云端）模式则由Continue托管provider配置，但key由Continue Hub管理而非用户直接可见。文档明示：「All configuration stays on your machine — perfect for air-gapped environments.」
  - 依据: https://docs.continue.dev/guides/understanding-configs [官方] https://docs.continue.dev/reference [官方]
- **BYOK计费分离：token成本用户自付，平台收功能SaaS费，这是企业级BYOK的主流模式**: Augment Code的分析明确指出BYOK的计费分离逻辑：所有provider token调用计费到用户自己的provider账户（不经平台），平台只对「可观测性、路由、guardrails、访问控制」等增值功能收费。对SaaS来说，这意味着BYOK用户不消耗平台的AI Token池，但仍受功能次数限额（如海报生成张数/工作台调用次数）约束以维持商业可持续。实践中常见双轨配额：普通用户用平台token池且受token限额，BYOK用户跳过token池计费但保留功能次数配额。
  - 依据: https://www.augmentcode.com/guides/byok-enterprise-agent-rollouts [官方] https://docs.litellm.ai/docs/proxy/users [官方]
- **SQLAlchemy加密字段最佳实践：TypeDecorator+Fernet，或信封加密（每用户独立DEK）**: 两种方案：(1) 统一主密钥（LibreChat做法）：用`cryptography.fernet.Fernet`+`TypeDecorator`让ORM透明加解密，master key存env var。简单，但master key泄露则所有user key全暴露。(2) 信封加密（envelope encryption）：每用户生成独立DEK，DEK本身用KEK加密后和密文一起存DB。`@encrypt_fields(kek=os.getenv('MASTER_KEK'))`装饰器可实现透明化。每用户独立DEK好处：一个DEK泄露不影响其他用户，可以按用户轮换。对小型SaaS来说方案(1)够用，中大型推荐方案(2)。
  - 依据: https://devhuddle.ai/envelope-encryption-for-sqlalchemy-fields/ [二手] https://blog.miguelgrinberg.com/post/encryption-at-rest-with-sqlalchemy [二手]
- **安全传输与不落日志的最小标准：HTTPS only + 日志过滤 + 只返回key存在状态**: 行业共识安全要点：(1) key只通过HTTPS传输，绝不出现在URL参数（防server log）；(2) 请求/响应日志过滤掉Authorization头和key字段，Python的logging可用filter；(3) GET接口只返回key是否存在+过期时间，不返回明文或密文（LibreChat `getUserKeyExpiry`的做法）；(4) 前端展示用masked形式（sk-...****后四位）；(5) 用户可随时删除（DELETE接口立即撤销）；(6) key加过期时间字段支持定期轮换机制（LibreChat `expiresAt`+MongoDB TTL index）。
  - 依据: https://raw.githubusercontent.com/danny-avila/LibreChat/main/api/server/routes/keys.js [官方] https://www.serverion.com/uncategorized/10-api-key-management-best-practices/ [二手]

### 差距/缺失
- 我们的ProviderFactory目前是单例全局实例（`_text_cache`按provider name缓存），初始化时从settings.deepseek_api_key读取固定key，不支持per-request/per-user动态key注入——这是BYOK的核心改造点
- 没有`user_keys`表，也没有key的加密存储机制（`cryptography`库未在项目中使用）
- 配额系统目前只有一轨（generation_limit计次），没有「BYOK用户跳过token成本、仍受功能次数限制」的双轨逻辑
- deepseek.py的`_get_client()`在`__init__`时直接绑定settings.deepseek_api_key，如要支持用户key需要变成每次调用时按参数取key（或工厂方法按user_id取）
- 前端settings页面目前无provider key配置UI（类比LibreChat的api keys管理页面）
- 缺少key的传输安全日志过滤（当前FastAPI logging配置未过滤Authorization头）
- 没有key的mask展示（前端show sk-...****）和「只返回过期时间不返回明文」的API设计

### 建议
- 最小可行方案（MVP）：新增`user_api_keys`表（字段：id/user_id/store_id/provider_name/encrypted_value/expires_at/created_at），用Python`cryptography`库Fernet加密，master key存服务端env var`USER_KEY_ENCRYPTION_KEY`。迁移文件一个，不动现有表。
- ProviderFactory改造：`get_text_provider()`新增可选参数`user_api_key: str | None`，有传则构造临时client（不入`_text_cache`），无传则退回全局settings key。调用链：stream.py/generate.py在dependency注入时从DB取该user的BYOK key并传入factory，实现请求级按user路由。
- Provider抽象层无需改动：TextProvider/ImageProvider的接口不感知key来源，key注入在`_get_client()`层面处理（DeepSeekProvider.__init__可增加可选api_key参数覆盖settings.deepseek_api_key），符合已有「Provider 抽象与业务解耦」原则。
- 安全要点落地清单：(1) PUT /api/v1/user-keys接收明文key→Fernet加密→存DB，GET只返回{provider, exists, expires_at}不返回密文；(2) 前端展示mask格式；(3) FastAPI middleware加logging filter过滤Authorization和user-key相关请求体字段；(4) `expiresAt`字段+定期检查（复用existing expire_subscriptions cron模式）；(5) 用户DELETE立即撤销（清DB行，下一请求自动退回平台key或报错）。
- 多provider统一：不引LiteLLM（运维代价高），继续用OpenAI兼容SDK格式自建适配器。DeepSeek/OpenAI/任意OpenAI兼容provider只需改base_url和api_key，AsyncOpenAI client构造函数参数统一，这正是已有架构的优势。BYOK key存库时按provider_name（'deepseek'/'openai'/'custom'）区分。
- 计费双轨设计：BYOK用户（user.has_byok_key(provider)=True）调AI时：(1) 跳过我们的DeepSeek/OpenAI账户余额消耗；(2) token_usage仍记录到usage_events表（供产品分析）；(3) 不扣monthly_tokens_limit（该字段仅展示）；(4) 仍扣功能次数配额（generation_limit/monthly_poster_limit）维持商业可持续。普通用户维持现状。实现：run_generation里check_quota之前判断has_byok，绕过token计费分支但不绕过次数配额检查。
- 对台球房SaaS当前阶段的建议：BYOK适合「想自己控成本的中大店/连锁」用户，是高级功能而非基础功能。建议作为「专业版/企业版」差异化功能：普通套餐用平台key（简单），专业套餐可BYOK（AI成本自付，功能次数仍受套餐限制）。这样平台两边都有收益：新用户门槛低，规模用户愿BYOK换成本控制权。

---

## 12. 主流AI Agent产品架构调研 + 台球房垂直运营SaaS的能学与不照搬分析

**核心结论**: 本次调研基于Claude Code官方SDK文档、VILA-Lab对Claude Code源码的逆向分析(arXiv:2604.14228)、Coze Studio开源README、Dify官方博客，以及通用Agent模式分析文章，均为一手或高可信二手资料，无编造。核心结论如下：

一、Agent本质只有三件事：循环(loop) + 工具调用(tool use) + 反馈回灌(observation)。Claude Code的源码验证了"98.4%是确定性基础设施，1.6%才是AI决策逻辑"——loop本身极简，真正复杂的是权限闸、上下文压缩、工具路由、会话恢复这些"脚手架"。这对我们的垂直SaaS有直接指导意义：别花精力设计"更聪明的模型调用"，要花精力在工具可靠性、记忆召回准确性、审批闸安全性这些基础设施上。

二、Dify/Coze的行业借鉴价值在于"知识库 + 工作流节点 + 记忆变量"三件套的产品化做法——它们把复杂的RAG管线、条件分支、HTTP工具封装成非技术用户可操作的可视化节点。我们已有的43个knowledge YAML + 54个operation YAML + run_generation统一管道，本质上已经是一个"垂直化的领域知识库 + 能力节点库"，架构层面不比Dify弱，差的是"语义召回"而非知识内容本身。

三、我们的P0已落地最小ReAct循环(loop.py 236行，审批闸骨架已埋)。与"教科书级agent"对标，最大差距在两块：(A) 记忆仍是全量注入而非pgvector语义召回，token膨胀且相关性不精准；(B) 缺乏主动出击层(P4)，即"合适时机主动提醒店主该做什么"——这是从"工具"变成"运营助理"的最后一跃。

四、多agent、代码执行沙箱、通用工具市场这三类通用agent能力对台球房垂直SaaS既无必要也有合规风险，明确不照搬。

### 关键发现
- **Claude Code Agent Loop核心机制：98.4%是基础设施，1.6%才是AI决策**: Claude Code的agent本质是一个AsyncGenerator实现的while循环：接收prompt → 调模型 → 若模型输出tool_calls则执行工具 → 把tool结果作role:tool回灌 → 再调模型，直到模型不再调工具或触发5个停止条件之一(无工具调用/max_turns/context溢出/hook干预/abort)。每次模型调用前有5层上下文压缩(Budget Reduction→Snip→Microcompact→Context Collapse→Auto-Compact)。源码逆向分析显示：1884个TS文件中真正的AI决策逻辑约占1.6%，其余98.4%是权限闸(7层独立安全层)、工具路由(并发安全/顺序安全分类)、上下文管理、会话持久化等确定性基础设施。对垂直SaaS的启示：Agent的可靠性不来自更聪明的prompt，而来自工具可靠性、权限闸、错误恢复这些基础设施——和我们在loop.py里'工具失败不崩循环、把错误回灌让模型补救'的取舍完全一致。
  - 依据: https://code.claude.com/docs/en/agent-sdk/agent-loop [官方]
https://github.com/VILA-Lab/Dive-into-Claude-Code arXiv:2604.14228 [二手-学术]
本项目 /Users/swl/Desktop/球房 ai 运营助手/server/services/agent/loop.py [项目内]
- **Claude Code的CLAUDE.md记忆体系：分层指令 + 自动上下文压缩 + subagent隔离**: Claude Code通过三种机制管理记忆：(1) CLAUDE.md文件系统——项目级/用户级/目录级分层指令，会话开始时载入并在每次请求做prompt cache，规则持久存在不依赖对话历史；(2) 自动上下文压缩——context接近上限时自动摘要旧历史，保留最近交换和关键决策，CLAUDE.md内容每次请求重新注入避免被压缩丢失；(3) subagent隔离——子agent启动时上下文归零，只载入系统prompt和CLAUDE.md，执行结果以摘要形式回传父agent，防止主context膨胀。对比我们：店脑(store_memories)+ 行业知识库(YAML) + 最近5轮对话的三层结构与此高度相似，但缺pgvector语义召回——全量注入在记忆多后必然撑爆context。
  - 依据: https://code.claude.com/docs/en/agent-sdk/agent-loop#automatic-compaction [官方]
https://code.claude.com/docs/en/agent-sdk/subagents [官方]
/Users/swl/Desktop/球房 ai 运营助手/docs/plans/AI-Agent转型-编排.md §4.6 [项目内]
- **Dify的行业知识产品化：RAG管线全栈 + 工作流节点 + Agent Strategy插件**: Dify将知识库到输出的全链路产品化为三层：(1) RAG管线——文档上传→分块→embedding生成→向量存储→混合检索(向量+BM25)+可选reranking，v1.1.0加入Metadata过滤实现按部门/时段精确召回；(2) 工作流节点——LLM调用、知识检索、条件分支、HTTP请求、Python/JS代码节点、迭代器、聚合器构成可视化画布，支持并行分支、错误重试、超时；(3) Agent节点 + Agent Strategy插件——节点内嵌可自定义的'大脑策略'插件，支持Agentic RAG(迭代分析意图→选工具→改写查询→评估证据的循环)。对垂直SaaS的借鉴：我们的43个knowledge YAML目前做不到语义召回(只有关键词匹配选知识文件)，Dify的hybrid retrieval + metadata filter正是我们P2 pgvector升级要解决的核心问题；工作流节点思路可映射到我们的'工具注册表'，每个工具的description字段就是节点的触发条件说明。
  - 依据: https://dify.ai/blog [官方]
https://skywork.ai/blog/dify-review-2025-workflows-agents-rag-ai-apps/ [二手]
https://jimmysong.io/blog/open-source-ai-agent-workflow-comparison/ [二手]
- **Coze Studio的架构：微服务Go后端 + DDD + 五大能力模块(Prompt/RAG/Plugin/Workflow/Memory)**: Coze Studio(ByteDance 2025年7月开源)后端Go微服务 + React/TypeScript前端，DDD领域驱动设计，核心五模块：(1) 模型服务——统一多模型接入(OpenAI/Volcengine等)；(2) 工作流引擎——可视化拖拽节点构建agent工作流，Eino框架提供agent/workflow运行时；(3) 知识库——RAG全管道；(4) 插件系统——工具/API集成；(5) 数据库+变量——agent会话内/跨会话状态管理。Coze相比Dify更强调'多平台发布'(Discord/WhatsApp/Feishu等渠道分发)，Agent本身通过配置知识库/工作流/插件的组合来定义能力边界，而非代码。对比我们：Coze的'Agent = 系统prompt + 知识库配置 + 工具/工作流挂载'的声明式组合模型，与我们'system_prompt + knowledge注入 + tool_registry工具挂载'的设计思路完全一致，验证了我们架构方向正确。
  - 依据: https://github.com/coze-dev/coze-studio README [官方]
https://starlog.is/articles/ai-agents/coze-dev-coze-studio [二手]
https://test-news.aibase.com/news/19989 [二手]
- **通用Agent四大模式对比：ReAct最适合我们，Plan-and-Execute和Reflection是可选增强**: 四种主要单agent模式的适用边界(均基于实测数据)：(1) ReAct(Reasoning+Acting)——每步依赖上一步真实结果，适合工具链动态的交互式任务，如'帮我出这周活动方案'；LLM调用次数=步骤数，成本随复杂度线性增长；风险是uncontrolled loop需设max_turns。(2) Plan-and-Execute——先出完整计划再顺序执行，约3-4次LLM调用，适合可预测步骤序列；缺点是计划出岔子后不能自适应。(3) ReWOO——2次LLM调用+并行工具执行，适合多个独立数据查询，不适合有依赖关系的步骤。(4) Reflexion——生成→批评→再生成循环，适合有明确pass/fail标准的任务(代码测试/数据校验)，成本高。我们的场景结论：ReAct是底座——运营任务需要动态工具选择；高质量内容输出(如海报文案)可选Reflexion做质量把关；批量定时任务可用Plan-and-Execute降成本。关键警示：'如果你无法衡量agent是否成功，任何架构模式都救不了你'——我们的usage_events采集正是补这个盲点。
  - 依据: https://theaiengineer.substack.com/p/the-4-single-agent-patterns [二手]
https://dev.to/gabrielanhaia/react-plan-and-execute-or-reflection-the-three-agent-patterns-every-engineer-needs-in-2026-355p [二手]
https://redis.io/blog/ai-agent-architecture-patterns/ [官方]
- **对标差距：我们在哪5个agent能力上与北极星的距离**: 北极星=让台球房老板像雇了懂行运营店长——说句话事就办了。对标5个核心agent能力：(1) 对话理解需求→选对工具/知识 [现状:P0已实现ReAct loop + 工具注册表，模型自主选工具；差距:DeepSeek agentic规划稳定性未A/B实测，BFCL榜DeepSeek V3.2仅56.73分显著弱于GLM-4.6的72.38]；(2) 连续调用多个运营能力→交付整套成果 [现状:P0循环已通，但现有能力还未全部包成工具，P1任务]；(3) 记住这家店→越用越懂 [现状:店脑已有全量注入，差距:仍是全量而非pgvector语义召回，多记忆后token膨胀不可控，P2任务]；(4) 生成内容贴北极星 [现状:43+54 YAML知识库+run_generation管道，industry prompt第一梯队；差距:知识选择还靠关键词匹配而非语义召回，相关性不精准]；(5) 主动提醒该做什么 [现状:今日推荐规则引擎已有，差距:没有推送通道+定时触发，完全被动等用户开口，P4任务，这是从工具→助理的本质跨越]。
  - 依据: /Users/swl/Desktop/球房 ai 运营助手/docs/plans/AI-Agent转型-编排.md §5 [项目内]
/Users/swl/Desktop/球房 ai 运营助手/server/services/agent/loop.py [项目内]
BFCL榜数据来源：gorilla.cs.berkeley.edu 已在编排文档附录核实 [官方]
- **Claude Code的审批闸(Approval Gate)设计：7种权限模式 + deny-first + proposal模式**: Claude Code的权限架构核心原则：deny-first(宽泛deny始终覆盖窄泛allow)，7种权限模式从最严格plan(只读不改)到最宽松bypassPermissions(沙箱内全放行)构成渐进信任谱系；工具分为read-only(可并发)和state-modifying(顺序执行)两类；PreToolUse hook可拦截/修改/拒绝任意工具调用；子agent运行在隔离上下文，权限不从父agent继承。对应我们已实现的设计：loop.py的'requires_approval工具不在循环里执行而是回灌待确认消息(proposal模式)'正是从Claude Code的'side-effecting工具需弹确认'移植过来的最合理实现——避免了流式中途暂停/恢复的复杂度。这个审批闸(P2任务)是P3对外动作(抖音/美团内容)的安全前提，必须先建好。
  - 依据: https://code.claude.com/docs/en/agent-sdk/agent-loop#tool-execution [官方]
https://github.com/VILA-Lab/Dive-into-Claude-Code README#safety-and-permissions [二手-学术]
/Users/swl/Desktop/球房 ai 运营助手/server/services/agent/loop.py L108-L114 [项目内]

### 差距/缺失
- 记忆召回是全量注入而非语义召回：store_memories目前全部注入system prompt末尾，随记忆积累必然撑爆context window并稀释相关性；Dify/Coze均已用hybrid retrieval(向量+BM25)+metadata filter实现精准top-k召回，我们缺EmbeddingProvider + pgvector HNSW索引这一层(P2已规划但未落地)
- 知识库选择靠关键词匹配而非语义：43个knowledge YAML的选取逻辑(_select_knowledge_keys)依赖关键词命中而非embedding相似度，复杂运营需求可能选错知识文件或漏选；教科书Agentic RAG要求'迭代分析意图→改写查询→评估证据'的循环，我们缺这层
- 缺主动出击层(P4)：今日推荐规则引擎已有但完全被动——只有用户主动打开App才触发；'北极星运营助理'应在'明天节日/本周末活动预备/上周数据异常'等时机主动推提醒；缺合规推送通道(微信服务号/企业微信)和定时触发引擎
- Agent大脑规划稳定性未实测：BFCL函数调用榜显示DeepSeek V3.2仅56.73分(全球排名较低)，GLM-4.6达72.38(国产第一)；我们的编排大脑用DeepSeek但尚无P1的A/B实测数据，有规划力不稳的风险
- 对话管家UI面板(P1)尚未落地：前端还没有'思考过程/工具调用时间线/多步进度'的可视化面板；Coze/Dify均有workflow运行可视化，用户看不见agent在干什么会丧失信任感
- 缺上下文滚动总结：最近5轮截断会丢失早期重要上下文(如'第一轮告知的活动主题')；Claude Code用5层自动压缩+CLAUDE.md每次重注入解决这个问题，我们缺对话摘要层(P2)
- 工具描述质量决定大脑选对工具的概率：现有工具注册表骨架已有，但96张卡片的description字段尚未按'何时该调我'的标准写清楚；Claude Code的Skill体系明确要求description是模型选用的核心依据，不是给人看的

### 建议
- 最优先：P2 pgvector语义召回替代全量注入——在store_memories加embedding列+HNSW索引，注入前召回top-8~12相关记忆条目而非全部；同步用pgvector召回替代knowledge YAML的关键词选取；零新增基础设施(PG14已在)，这是最高ROI的单点改动，直接修复'记忆越多越慢越贵越不准'和'知识选错'两个核心短板。参考Dify的metadata filter做法：同时加store_id过滤保证租户隔离不破坏
- 审批闸完整落地(P2最先做)——loop.py的requires_approval骨架已埋，补齐'审批态走DB+前端确认UI+用户确认后走独立执行路径'；这是P3对外动作(抖音/小红书内容handoff)的安全前提，也是'AI运营助理'与'工具'的分水岭。参考Claude Code的deny-first原则：写/花钱/对外动作一律经审批闸，查询/只读自动放行
- 工具description升级——把现有96张卡片能力包成工具时，每个工具的description按'何时该调我、适合什么任务描述'写清楚(参考Claude Code Skill描述标准)；大脑选对工具的概率直接由description质量决定，这是'0成本提升规划准确率'的杠杆点
- P1对话管家UI：补'过程可见'面板——工具调用时间线+多步进度展示，参考Coze Studio的workflow运行可视化；SSE协议扩展(thinking/tool_call/tool_result事件)后端P0已完成，前端消费逻辑是P1核心任务；用户看得见agent在干什么，信任感从0到有
- P4主动出击先走最小路径——不上复杂推送系统，先用'微信服务号模板消息'或'企业微信应用通知'(两者均有官方API、无需额外资质)做一条合规推送通道；触发信号复用现有today_status接口('日报没写/明天节日/本周末无活动');每天只推1条高价值提醒(避免骚扰)，这是从'被动工具'→'主动助理'的最后一步，直接对标北极星

---