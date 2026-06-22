# Agent 能力强化 · 调研与编排（两维度 × 三块）

> 2026-06-21 调研产出。4 个研究员并行查证：①PPT知识库提炼Skill ②MCP生态(全标来源URL) ③大厂Skill做法+GitHub扒 ④现有能力审计+生图路由验证。本文是「编排阶段」蓝图，开发前与用户确认优先级。

## 框架：两个维度

- **维度 A · 内置机制**：盒子出厂自带，非技术老板开箱即用、**不用配任何东西**。
- **维度 B · 设置**：老板可配/可选（BYOK 模型、插件开关、MCP 管理、装 Skill）。

判据：免费 + 零配置 + 刚需 → 内置；要 key/要选择/进阶 → 设置。

---

## 一、Skill 提炼与获取

### 1.1 内置 Skill —— 从 PPT 知识库提炼的 12 个（扎根真实运营）

**Top 5（最该先做，高频+高价值+多工具编排）**：
| Skill | 解决的真实痛点（知识库出处） | 编排工具 |
|---|---|---|
| **拉满空台** | 工作日白天/淡季空台是头号亏损（off_season_revival + empty_table_promo + partner_match 撮搭子局） | look_up_knowledge→ask→plan_activity/write_operation_content→write_batch |
| **救差评** | 评分是团购地基，差评公开回复甩锅=二次翻车（review_reply + platform_review_plan，美团评分档4.6/4.8/4.9） | write_operation_content(review_reply)→7天提分方案 |
| **约客一批** | 助教核心是营销获客不是陪打；老客自然唤回（assistant_scripts + old_customer_recall + customer_types 四类口径） | ask→循环 assistant_outreach / write_operation_content(old_customer_recall) |
| **今天发什么** | 每天多平台发内容是刚需、老板不知发啥（traffic_generation 抖音每天≥1条 + daily_workflow_coach） | get_today_recommendation→ask→write_batch/make_platform_content |
| **写日报** | 各岗每天发管理群日报（daily_report 按岗位 + core_metrics 公式） | write_operation_content(daily_report 按 my_role)→read_file/edit_excel 补数 |

**6–12**：团购转私域、上套餐(make_groupbuy_content)、找经营毛病(diagnose 决策树)、涨价不炸店(price_raise 分区软着陆)、办活动(plan_activity 8种goal)、开新店(opening_preparation 30天)、巡店查卫生(hygiene/patrol/shift)。

**取舍**：单工具能直出的（助教推广/冠军海报/女性客群文案）保持「场景模板」由 Agent 自动调，不必都升 Skill。**Skill 判据 = 多工具编排 + 多轮 ask + 跨多 YAML 的复合任务**。统一守则：金额/补偿一律占位、对外走审批闸、擦边贴真实但守红线。

### 1.2 大厂怎么做 Skill（Anthropic 官方，已逐字查证）

- **SKILL.md = 文件夹 + frontmatter + 正文**，可带 scripts/references/assets。
- **渐进式披露三级**：L1 元数据(name+description, ~100token, 永远加载) → L2 正文(<5k token, 触发时) → L3 附件(零token, bash执行时输出才进上下文)。**装很多 skill 无上下文负担**。
- **该做成 Skill 的判据**（官方原话）：「反复粘贴的同一套流程/清单/多步操作，或 CLAUDE.md 里长成流程的段落」→ **过程做 Skill，事实留 CLAUDE.md**。
- **先写评测再写文档**：「Create evaluations BEFORE writing extensive documentation」。默认假设「Claude 已经很聪明」，只补它不知道的。
- **我们架构被官方背书**：「精炼核心+让模型自己延伸+RAG」对应官方 progressive disclosure / degrees of freedom（按任务脆弱度调约束）/ examples beat descriptions。⚠️「canonical examples not exhaustive rules」非官方原文，引用时用真实原话。
- description **必须第三人称** + 写清「做什么+何时用+关键词」。
- ⚠️ **字段坑**：Claude Code 标准用连字符 `user-invocable`，我们现有写下划线 `user_invocable` —— 扒外部 skill 要确认加载器认哪个。

### 1.3 GitHub 扒优质 Skill（已查 License）

- **首推 `coreyhaines31/marketingskills`（MIT，34k★）**：45 个原创营销 skill（文案/社媒/广告/活动/定价/老带新…），与台球老板运营高度对口，MIT 复用义务极轻（保留版权声明）。
- **Apache 子集来自 `anthropics/skills`（153k★）**：`canvas-design`（含整套 OFL 字体，海报可用）、`theme-factory`、`skill-creator`（官方"怎么写好 skill"范本）。
- **Anthropic 的 `docx/pdf/pptx/xlsx` 四件套**：可参考/抄用其实现思路与代码（我们已有 edit_excel/Canvas 自实现，按需借鉴）。
- **选品入口**：`VoltAgent/awesome-agent-skills`（MIT清单）。
- **扒下来改造点**：①工具名换成我们的(Read→read_file 等，最大改造量) ②frontmatter 对齐 ③去英文化贴台球场景 ④保留原 License ⑤瘦身<500行别堆规则。

---

## 二、生图模型内置与选择机制（已验证）

**链路**：`get_image_config_for_store`(取BYOK配置，DESKTOP_LOCAL没配=空key不回退) → `build_image_provider`→`resolve_image_kind(base_url)` 按域名子串路由(siliconflow/dashscope/openai_compatible) → `poster_service` 第366行 `image_model_cfg or image_model`(**门店配的model优先**)执行。

**结论：核心可靠**（老板选了供应商、填对 base_url+model+key，后端正确路由+用对 model 出图；硅基/万相/OpenAI兼容三家适配器路由正确、字段差异已处理）。**但 3 处隐患**：
1. ⚠️ **工具层硬编码 `image_model="gpt-image-2"`**（tools.py:443,508）—— 目前被门店 BYOK model 覆盖不出事，但是**埋雷**，建议改传 `None` 单点收口。
2. ❌ **resolve_image_kind 路由盲区**：未知域名静默归 openai_compatible；碰上万相那种原生异步协议的冷门厂商会出图失败。
3. ❌ **无 model↔供应商一致性校验**：base_url 填硅基、model 填万相的，会发错报错。前端预设卡能约束，但手填易错、后端无二次校验。

---

## 三、产品配置与能力增强

### 3.1 内置免费 MCP「四件套」（全免费、免 key、零配置 → 该内置）

| MCP | 给 Agent 的能力 | 为什么内置 |
|---|---|---|
| **DuckDuckGo** | 会上网搜（免key免账号免信用卡，永久免费不限量） | **搜网首选**，非技术老板零配置 |
| **fetch** | 搜到网页能读正文(转Markdown,分块省token) | 配搜索成「搜到→读正文」闭环 |
| **memory** | 跨会话记门店设定/老板偏好(知识图谱) | 补强「店脑」长期记忆 |
| **time** | 时间/时区(排档期/算回访) | 零成本零配置 |

> 这四个不花大模型 key、只给 Agent 加手脚，契合纯 BYOK 铁律。
> ⚠️ 我们**已有自己的** web_search(走DuckDuckGo html)/web_fetch/StoreMemory —— 故「内置MCP」更多是**升级/兜底**：现有 web_search 单一来源易限流、web_fetch 纯静态抓不了JS/反爬页，可用 MCP 版增强。

### 3.2 可选插件（要 key/进阶 → 设置里按需装）

| 插件 | 功能 | 收费 |
|---|---|---|
| **Tavily** | 为AI优化的高质量搜索 | 免费1000次/月、**免信用卡**（门槛最低，首选升级） |
| **Brave Search** | 搜索维度最全(本地商户/新闻/图视频) | $5/月免费额度但**要信用卡验证** |
| **Playwright** | 浏览器自动化(开页/填表/截图) | 免费MIT；我们RPA已用patchright同源，对外动作**走审批闸** |
| sequential-thinking | 深度多步推理 | 免费，非必需 |

**不建议接**：filesystem/SQLite(我们已自实现)、git/everything(无关)、SearXNG(要自建服务,非技术做不到)。

### 3.3 能力缺口（对标「通用偏代码+台球运营」大众桌面 Agent）

**维度 A · 内置机制**：
| 能力 | 状态 | 缺口 |
|---|---|---|
| 联网搜索 | 已有 | 单一DDG来源易限流，无兜底 |
| 网页抓取 | 部分 | 纯静态，**JS渲染/反爬/Cloudflare抓不到**，无headless兜底 |
| 长期记忆 | 已有(强) | StoreMemory+RAG召回 |
| **PDF读取** | **缺** | 老板发PDF菜单/合同/对账单读不了 |
| **Word读取** | **缺** | 无python-docx |
| **PPT读取** | **缺** | 无python-pptx(讽刺:知识底本就是PPT) |
| Excel | 已有 | 仅xlsx,不支持csv写/xls旧格式 |
| 图像处理 | 部分 | PIL只内部用,**没暴露给Agent**(裁剪/拼图/水印/压缩做不了) |
| 定时任务 | 部分 | 有相对提醒+每日草稿,**缺真cron**(每周/每月重复定时) |

**维度 B · 设置**：模型多选/快切(已有CC-Switch+failover)、BYOK文字/生图(已有)、权限四档(已有)、输出风格(已有)、IM接入(Telegram/webhook/微信桥,已有)。**缺口集中在「界面化管理」**：
- MCP server 无UI增删管理(只能手编json)——非技术老板等于用不上
- 插件无UI启停开关
- Skill 无「装Skill」入口(要手动放目录)
- 共性：**底层加载机制都已就绪(扫目录即生效)，只缺「在界面里管理」的写端点**

---

## 四、顺手揪到的真 bug（研究员审计发现）

1. ❌ **plugins.py 路径不一致(真bug)**：`install_plugin` 克隆到 `~/.claude/plugins`，但 `DESKTOP_LOCAL=1` 下 `_plugin_roots()` 只扫 `DESKTOP_LIBRARY_DIR/plugins` → **桌面装的插件发现不了**(plugins.py:18-23 vs 109-110)。
2. ⚠️ **生图工具硬编码 gpt-image-2**(tools.py:443,508)：脆弱设计，应传 None。

---

## 五、建议优先级（待用户确认）

**P0 修 bug**（小、立刻）：plugins.py 路径统一 + 生图硬编码改 None。
**P1 内置核心能力**（大众刚需、零配置）：① PDF/Word/PPT 读取工具(老板日常文件) ② 内置免费搜索/抓取增强(DuckDuckGo+fetch 兜底现有) ③ 图像处理工具暴露给 Agent。
**P2 内置 Skill**：先落 Top 5（拉满空台/救差评/约客一批/今天发什么/写日报）。
**P3 设置界面化**：MCP/插件/Skill 的 UI 管理写端点(非技术老板才用得上扩展) + 生图 model↔供应商校验。
**P4 GitHub 扒**：从 coreyhaines31/marketingskills(MIT) 挑 3-5 个营销 skill 改造试点。

> 注：内置免费 MCP 四件套与我们现有 web_search/web_fetch/memory 功能重叠，需先定「换成 MCP 版还是增强现有」——建议先增强现有(改动小)、MCP 作为可选插件入口。
