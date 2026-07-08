# 知识库可观测 manifest（X-3 · 自动生成）

> 本文件由 `scripts/gen_knowledge_manifest.mjs` 生成，**勿手改**——改了下次重跑会被覆盖。机器可读断言由 `server/tests/test_knowledge_manifest.py` 守门（那条绿=这份表健康）。
>
> 生成日期：2026-07-08　|　数据源：Prompt YAML + `content_service.KNOWLEDGE_KEYWORDS`。

## 一眼看健康

- 知识总条数：**57**
- ① 死料（没角色列入 required_knowledge）：**0** ✅ 无死料
- ② 孤儿关键词（KNOWLEDGE_KEYWORDS 指向不存在的知识）：**0** ✅ 无孤儿
- ③ 渲染类缺 description：**0** ✅ 全有 description
- 幽灵引用（角色 required_knowledge 指向不存在的知识）：**0** ✅ 无
- 核心知识（恒注入，CORE + daily_workflow*）：**9** 条
- 无关键词条目（非核心，靠语义/内容召回，不算缺陷，仅供留意）：**5** 条

## 角色（required_knowledge 来源）

| 角色 key | 显示名 | 列入知识条数 |
|---|---|---|
| `assistant_manager` | 助教管理岗位规则（运营校准版） | 23 |
| `boss` | 老板岗位规则（运营校准版） | 21 |
| `coach` | 教练/赛事负责人岗位规则 | 14 |
| `frontdesk` | 前厅主管岗位规则（运营校准版） | 11 |
| `manager` | 店长岗位规则（运营校准版） | 27 |
| `operator` | 运营负责人岗位规则（运营校准版） | 13 |

## 每条知识 → 覆盖矩阵

列含义：**被哪些角色列入**（required_knowledge，空且非 L1 域目录页=死料）｜**desc** 有无 description｜**关键词** 有无 KNOWLEDGE_KEYWORDS 命中词（核心知识标 🔒，恒注入不靠关键词）。

| knowledge key | 名称 | 被哪些角色列入 | desc | 关键词 |
|---|---|---|---|---|
| `knowledge.assistant_coaching_sop` | 助教球技培训SOP知识库 | assistant_manager | ✅ | ✅（8 词） |
| `knowledge.assistant_difficult_situations` | 助教管理刁钻问题应对话术 | assistant_manager | ✅ | ✅（13 词） |
| `knowledge.assistant_overtime_service` | 助教超休服务（陪伴服务·管理·激励·边界） | assistant_manager | ✅ | ✅（9 词） |
| `knowledge.assistant_persona_building` | 助教人设/形象卖点打造SOP | assistant_manager | ✅ | ✅（16 词） |
| `knowledge.assistant_promotion` | 助教推广获客知识库 | assistant_manager | ✅ | ✅（17 词） |
| `knowledge.assistant_salary` | 助教薪资体系知识库 | assistant_manager | ✅ | ✅（6 词） |
| `knowledge.assistant_scripts` | 助教高频话术速查 | assistant_manager | ✅ | ✅（13 词） |
| `knowledge.assistant_service_sop` | 助教服务 SOP 知识库 | assistant_manager | ✅ | ✅（7 词） |
| `knowledge.assistant_tier_system` | 助教等级体系知识库 | assistant_manager | ✅ | ✅（6 词） |
| `knowledge.billiards_game_rules` | 台球玩法规则知识库 | coach、frontdesk | ✅ | ✅（13 词） |
| `knowledge.business_cases` | 商业球房运营案例知识库 | boss、operator | ✅ | ✅（5 词） |
| `knowledge.casual_customer_segments` | 初次进店散客细分与维护转化 | assistant_manager、coach、frontdesk、manager | ✅ | ✅（10 词） |
| `knowledge.competitive_group_ops` | 竞技群运营知识库 | coach | ✅ | ✅（6 词） |
| `knowledge.compliance_rules` | 合规表达规则库 | assistant_manager、boss、coach、frontdesk、manager、operator | ✅ | 🔒 核心恒注入 |
| `knowledge.core_metrics` | 核心指标公式库 | boss、manager | ✅ | ✅（9 词） |
| `knowledge.core_operations` | 台球房核心运营逻辑 | assistant_manager、boss、coach、frontdesk、manager、operator | ✅ | 🔒 核心恒注入 |
| `knowledge.cost_control` | 店长成本控制与成材率知识库 | boss、manager | ✅ | ✅（13 词） |
| `knowledge.customer_ops_index` | 客户运营·域目录页（L1） | L1 域目录页（look_up_knowledge 召回） | ✅ | —（靠语义/内容） |
| `knowledge.customer_profile_template` | 客户档案模板知识库 | assistant_manager、frontdesk、manager | ✅ | ✅（5 词） |
| `knowledge.customer_tagging` | 客户标签体系知识库 | assistant_manager、boss、coach、frontdesk、manager、operator | ✅ | ✅（5 词） |
| `knowledge.customer_types` | 客户类型知识库 | assistant_manager、boss、coach、frontdesk、manager、operator | ✅ | ✅（6 词） |
| `knowledge.daily_workflow` | 前厅日常工作流程知识库 | frontdesk | ✅ | 🔒 核心恒注入 |
| `knowledge.daily_workflow_assistant_manager` | 助教管理一日工作流程 | assistant_manager | ✅ | 🔒 核心恒注入 |
| `knowledge.daily_workflow_coach` | 教练每日工作流程 | coach | ✅ | 🔒 核心恒注入 |
| `knowledge.daily_workflow_frontdesk` | 前厅每日工作流程 | frontdesk | ✅ | 🔒 核心恒注入 |
| `knowledge.daily_workflow_manager` | 店长每日工作流程 | manager | ✅ | 🔒 核心恒注入 |
| `knowledge.data_analysis_index` | 数据诊断·域目录页（L1） | L1 域目录页（look_up_knowledge 召回） | ✅ | —（靠语义/内容） |
| `knowledge.diagnostic_logic` | 经营诊断决策树 | boss、manager、operator | ✅ | ✅（14 词） |
| `knowledge.female_customer_ops` | 女性客群差异化运营知识库 | assistant_manager、coach、manager、operator | ✅ | ✅（15 词） |
| `knowledge.game_rules` | 台球玩法规则库 | assistant_manager、coach、frontdesk、manager | ✅ | ✅（16 词） |
| `knowledge.gaming_customer_ops` | 追分/博弈客群对内运营 | coach | ✅ | ✅（12 词） |
| `knowledge.growth_playbook` | 拉新裂变与留存套路库 | assistant_manager、coach、manager、operator | ✅ | ✅（20 词） |
| `knowledge.industry_data` | 台球行业数据知识库 | boss、operator | ✅ | ✅（4 词） |
| `knowledge.management_recruitment` | 管理层招聘知识库 | boss | ✅ | ✅（5 词） |
| `knowledge.manager_compensation` | 店长薪资结构知识库 | boss | ✅ | ✅（4 词） |
| `knowledge.marketing_index` | 营销获客·域目录页（L1） | L1 域目录页（look_up_knowledge 召回） | ✅ | —（靠语义/内容） |
| `knowledge.mini_games` | 小球房趣味游戏规则库 | coach、manager | ✅ | ✅（6 词） |
| `knowledge.opening_preparation` | 开业筹备知识库 | boss、manager | ✅ | ✅（6 词） |
| `knowledge.performance_standards` | 绩效评分标准知识库 | boss、manager | ✅ | ✅（6 词） |
| `knowledge.pk_incentive` | PK激励机制知识库 | assistant_manager、manager | ✅ | ✅（7 词） |
| `knowledge.platform_operations` | 美团与抖音运营操作手册 | operator | ✅ | ✅（7 词） |
| `knowledge.positioning_design` | 球房定位设计与品牌传播 | boss、manager | ✅ | ✅（13 词） |
| `knowledge.price_raise` | 经营改善后分区主动涨价 | boss、manager | ✅ | ✅（10 词） |
| `knowledge.profit_model` | 球房盈利模型知识库 | boss、manager | ✅ | ✅（9 词） |
| `knowledge.recharge_strategy` | 充值活动策略知识库 | boss、manager | ✅ | ✅（7 词） |
| `knowledge.recruitment_compliance` | 助教招聘合规规则知识库 | assistant_manager | ✅ | ✅（4 词） |
| `knowledge.review_generation_rules` | 好评文案生成规范 | manager | ✅ | ✅（6 词） |
| `knowledge.scale_guide` | 门店人员配置基准 | boss、manager | ✅ | ✅（15 词） |
| `knowledge.service_philosophy` | 服务理念场景化知识库 | frontdesk、manager | ✅ | 🔒 核心恒注入 |
| `knowledge.site_selection` | 商业球房选址要点 | boss | ✅ | ✅（5 词） |
| `knowledge.store_manager_competency` | 店长能力模型 | boss、manager | ✅ | ✅（11 词） |
| `knowledge.strategy_index` | 战略认知·域目录页（L1） | L1 域目录页（look_up_knowledge 召回） | ✅ | —（靠语义/内容） |
| `knowledge.talent_mgmt_index` | 人才管理·域目录页（L1） | L1 域目录页（look_up_knowledge 召回） | ✅ | —（靠语义/内容） |
| `knowledge.term_whitelist` | 行业术语白名单与风险词转译规则 | operator | ✅ | 🔒 核心恒注入 |
| `knowledge.tournament_rules` | 赛事活动规则库 | coach、manager | ✅ | ✅（19 词） |
| `knowledge.traffic_generation` | 球房引流操作手册 | assistant_manager、operator | ✅ | ✅（7 词） |
| `knowledge.traffic_priority` | 引流渠道合规优先级 | assistant_manager、boss、manager、operator | ✅ | ✅（25 词） |

## 怎么读这份表

- **某条「被哪些角色列入」为空且不是 L1 域目录页** → 死料，这条知识永远注不进任何对话。要么删、要么在角色 YAML 的 `required_knowledge` 登记。
- **desc 为 ❌** → 缺 description，Agent/语义召回挑不到它（A-2 守门，渲染类必须有）。去 `prompts/knowledge/<file>.yaml` 补 `description:`。
- **关键词为「—」** → 没配 KNOWLEDGE_KEYWORDS（非缺陷）。它靠语义/内容 bigram 召回；若该知识很想被精确关键词命中，可在 `content_service.KNOWLEDGE_KEYWORDS` 补词。
- **🔒 核心恒注入** → CORE_KNOWLEDGE_KEYS 或 `daily_workflow*`，每轮都注，不依赖关键词。

