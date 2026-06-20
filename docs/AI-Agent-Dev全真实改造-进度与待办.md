# AI-Agent-Dev · 全真实改造 进度与待办（交接锚点）

> **这是历史改造程的进度档**（全真实/行业真实运营资料 接地 + Agent 层加固那一程）。续接当前桌面产品请先读 `交接-给新会话/现状与待办.md`；本文留作那程的来龙去脉与验证账。
> **仓库**：本仓库 = 桌面版台球房 AI Agent 独立仓库，**`main` = 桌面产品全部代码**（已无云端 web 形态）。下文提到的"全真实/行业真实运营资料 接地改造"就在 `main` 这一脉里，最早是 squash 落入提交 `d8beca1`（"全真实/行业真实运营资料接地改造 + Agent层加固 + BYOK"）。
> 最近更新：2026-06-18。
>
> **⚠️ 续接看这里：本工作流（全真实/行业真实运营资料 接地）已收口；其后接着做了"桌面 Agent · Codex 化"一程（本地 Electron+SQLite+纯 BYOK + 本地动手/RAG/Canvas/生图 BYOK 等，详见 §7）。当前 go-forward 主线工作文档 = `docs/完整优化清单.md`（37 项产品化优化清单）；桌面那程的执行清单是 `docs/plans/桌面Agent-Codex化-执行清单-2026-06-18.md`。本文不再是主入口。**

---

## 0. 一句话现状
把台球 Agent 做"**全真实改造**"——按《台球行业真实运营逻辑》真实运营逻辑去消毒 + 补真实知识。**核心改造 + eval 重定基线 + Agent 层加固 + 真实性/行业真实运营资料 对应度做满 已完成并验证**（3 块都收口）。
- 内容层：去消毒全真实、7 缺口 YAML、源料搬运 42 条、北极星 eval 对齐。
- **Agent 层（2026-06-17，§3.6-3.10）**：Agent 决策 eval（**25 用例 100% GREEN**）；修日期注入/编排温度0.3/交付落库跨轮；加 plan_activity（工具→10）；交付物保真渲染；红线策略厘清。
- **真实性/行业真实运营资料 对应度（2026-06-18，§3.11-3.15，收口）**：行业真实运营资料 接地审计→去消毒残留修复（含"组局"误当红线纠错）→审计 23 条 missing ops 补尽（Phase B 13 + Phase C 7）→**双层内容对抗核验**（今晚改的+更早搬的，零编造零矛盾、真问题全修）→**两个 MiMo 模型交叉实测北极星 98.8%/0 RED**。
- **验证账（最终）**：PromptEngine **171 模板**、第三方名+行业真实运营资料 出处零泄漏、`bash scripts/test.sh` 全绿（188 后端+4 前端+tsc）、Agent eval 真底线全 GREEN、2 段 Playwright 真机端到端。这些改造内容现都在 `main` 这一脉里。
- 剩：画像客群/业态标签（**已核实 operation_profile 是 JSONB、加标签免迁移**）+ 原 P1-P4 路线。
- **🆕 后续重心已转桌面 Agent · Codex 化**（全真实内容最早 squash 进提交 `d8beca1`）：本地 Electron+SQLite+纯 BYOK + 本地动手/POS 真诊断/真 RAG/Canvas/生图 BYOK/CC Switch/Harness 加固 等已落地，仅剩打包出安装包 + 真机验证 + 对外互动。详见 **§7**、`docs/plans/桌面Agent-Codex化-执行清单-2026-06-18.md` 与 go-forward 主线 `docs/完整优化清单.md`。

## 1. 🔴 最高铁律（任何改动都遵守）
1. **全真实、不消毒、没有"度"**：助教情绪价值/颜值/陪打/超休/美女人设、追分博弈、交友软件获客、抖音擦边引流 都照实写。判断标尺="内行老板/店长一看是不是这行真东西"，不是"合不合规/政治正确"。
2. **只守两条底线**（这是真实本身，不是消毒）：① 不编造（金额/档位/助教信息/客户历史 未知一律占位【请补充:XX】）；② 助教是台球陪练不营销实际性交易（客人越界保护助教拉回）+ 门店不亲自抽水/组局/定盘口/放贷（开设赌场罪）。另保留商业真实：助教付费不写免费/不作赠品、不打包赢包教保票、不写全城最低价。
3. **第三方名零泄漏**：唐希/课程方/FUNENG/某门店/某门店/某门店/某门店/某门店/恺九/YOUME/金彩杯/巨玩/彬利烎/台球大姚/案例店名/人名/具体城市——一律不进库，只留通用逻辑。器材品类（乔氏/独牙/斯诺克/银腿金腿）豁免。
4. **改完查回头**：① `cd server && uv run python -c "from services.ai.prompt_engine import get_prompt_engine; e=get_prompt_engine(); print(len(e._templates))"`（应≥166）；② `grep -rni "课程方\|唐希\|某门店\|某门店\|YOUME\|金彩\|巨玩\|彬利\|童童" server/prompts/`（应零）；③ 前端改动 `cd web && npx tsc --noEmit`（应 0）；④ 上线前 `bash scripts/test.sh` + 北极星 eval（已重定基线）看 GREEN 率。

## 2. 真实源料（核实/搬运的依据）
- 真实 行业真实运营资料（基座源头标准，已通读核实 276 页）：`/Users/swl/Desktop/行业资料/行业真实运营资料`（提取文本曾存 /tmp/行业资料.txt）。
- 整个 `行业资料/` 文件夹=真实源料（助教/前厅/教练/赛事/数据/培训SOP）。⚠️ 内含 `账号密码.txt`——**安全红线，绝不读不碰**。
- 我们基座=`docs/product-brain/球房运营逻辑基准.md`（运营逻辑唯一基准，行业真实运营资料 派生）+ `助教业务规则库.md`。

## 3. ✅ 已完成并验证（这一程的全真实改造，现都在 `main` 这一脉里）

### 3.1 战略文档（落盘 docs/product-brain 与 docs/plans）
- `AI-Agent最终形态-终局蓝图-2026-06-17.md`（v2 全真实立场，§〇 立场段已改）
- `AI-Agent最终形态-开发计划与步骤-2026-06-17.md`（P0+→P4 + 一键发布可选track）
- `真实性审计报告-Agent够不够懂台球一线-2026-06-17.md`
- `源料可搬清单-待审搬运计划-2026-06-17.md`（42 条搬运计划，含3判断点）
- 原始数据：原存 `docs/test-runs/{agent-final-form,reality-audit,source-mining}-20260617/`（该目录已随 docs 清理删除，仅留此处历史记录）

### 3.2 全真实去消毒
- **中枢** `server/prompts/rules/baseline_rules.yaml`（rule 21追分/26-33助教颜值擦边交友/52/新助教段 全回正真实）
- **12 级联文件**去消毒：`term_whitelist`(转译词典→"行业真实表达指南")、`core_operations`、`rules/customer/{assistant,light_competition}`、`rules/role/{assistant_manager,coach,frontdesk}`、`workbench/free_intent`、`operation/{assistant_booking,assistant_promo,coaching_promo,member_assistant_notice}`
- **迎宾口径**：9 处"欢迎光临"套话→真实口语（service_philosophy/frontdesk_sop/frontdesk_training/fewshots.frontdesk_greeting/assistant_scripts/daily_workflow/performance_standards）

### 3.3 7 个缺口 YAML（新建）+ 7 张卡 + 知识注入
- 新文件：`operation/{recharge_design,pricing_design,assistant_recruit_sop,review_reply,influencer_outreach}` + `knowledge/{gaming_customer_ops,cost_control}`
- 卡片（role-workbench-config.ts）：boss-recharge-design/boss-pricing-design/am-recruit-sop/fd-review-reply/op-influencer-outreach/mgr-cost-control/coach-gaming-customer
- 知识注入（content_service.py KNOWLEDGE_KEYWORDS）：gaming_customer_ops、cost_control、assistant_overtime_service 已加关键词

### 3.4 北极星 eval 重定基线（对齐全真实）
- `server/evals/run_northstar_eval.py` HARD_FORBIDDEN：删美女助教/探探陌陌，只留真底线（实际性交易词/包教包会/全城最低价/刷好评）
- `server/evals/northstar_predicates.yaml`：NS-COMP-01(追分→只盯门店当庄)/NS-COMP-02(助教→只盯实际性交易露骨)/NS-COMP-04(交友→只盯外挂群控)
- 场景 forbidden：✅ **全 7 个文件已清**（games/content/outreach/activity/diagnosis/customer_pricing/report）——删已放开真实词、留真底线，全解析通过、零残留。**eval 重定基线整把尺子已对齐全真实，完成。**

### 3.6 Agent 决策 eval（新建，2026-06-17）—— 给"管家选对工具"装上尺子
- 新建 `server/evals/{agent_cases.yaml, run_agent_eval.py}`：真 DeepSeek 编排大脑 + **克隆生产 9 个工具的真实 description/schema、但 handler 换成桩**（不真生成/不生图→只耗少量编排 token，省钱）。15 个真实老板需求用例覆盖：工具选择/审批闸/红线拒绝/多工具编排/收敛。
- 判分：该调的调了没 / 不该调别调 / 花钱动作走没走审批闸 / 擦边违规有没有被放行 / 有没有空兜圈。跑法 `uv run python evals/run_agent_eval.py [--dry-run|--only 逗号id|--model X]`。（当时报告落 `docs/test-runs/Agent决策-*.md`，该目录已随 docs 清理删除。）
- **基线 86.7%(🟢13🟡2🔴0)→ 修复后 100%**：实测唯一偏差=老板说"今天/这周末"时大脑反射性多调一次 `get_current_date`。根因=agent system prompt 没注入当天日期。**正解**：`compose_agent_system_prompt` 加 `_today_line()`（北京时间日期+星期，注入大脑），它据此直接推算、不再多查；顺带让管家对话也懂当下。复测两个 YELLOW 全转 GREEN（且 ORC-01 从 4 轮收敛到 2 轮）；58 个 agent 单测全绿（更新了 1 条因日期注入而变更的契约断言）。

### 3.7 Agent 能力/稳定性加固（2026-06-17，eval 驱动）
- **新增 `plan_activity` 工具**（tools.py，复用 `generate_activity`/`activity.planning` 模板，自带配额/落库/护栏/品牌声音）：策划成体系的活动方案（玩法/优惠/时间/传播/落地步骤），区别于通用 `write_operation_content`。补上"活动策划"这一核心老板活原先只能落通用写手的缺口。Agent 工具 9→10。
- **编排温度 0.7→0.3**（loop.py `_ORCH_TEMPERATURE`，非流式+流式都改）：实测 0.7 下 DeepSeek 会"有时兴起自己聊、不调工具"（推玩法/差评回复被闲聊掉），是函数调用不稳的经典坑。工具选择要稳定可复现、不要创意；真正要创意的内容生成在各工具内部走 run_generation（自带 0.7），不受影响。
- **验证**：Agent 决策 eval 17 用例 **100% GREEN**（加 plan_activity 前一版因温度 0.7 飘出 2 RED+1 YELLOW；降温后全绿、且 plan_activity 全部命中、没抢通用写手的活、ORC 编排干净 3 轮收敛）。58 个 agent 单测全绿。eval 新增 `expect_any`(任一即可) 支持 + `--only` 定点复测。

### 3.8 交付物保真渲染（2026-06-17，真实浏览器验证）—— 别让大脑稀释验证过的内容
- **缺口**：对话页 `StepList` 只渲染工具"标签"(写文案✓)，从不渲染 `tool_result` 的实际产出。于是工具产出的整段验证内容(走完店脑/知识/护栏/北极星全管道)只能靠编排大脑在 final 里"复述"才看得见——而大脑复述时会改写/精简 → **内容失真(违背行业真实标准)+ 浪费 token**。
- **改**：① 前端 `web/.../chat/page.tsx` 新增 `DeliverableCards`：把交付类工具(write_operation_content/plan_activity/assistant_outreach/diagnose/recommend_games/platform/groupbuy)的结果**原样**渲染成可复制卡片(感知类查日期/今日推荐不在内)；纯对话才在底部给复制。② `agent.py` system prompt 加「交付内容会原样展示，别复述」：大脑只说一句『写好啦，你看看，要改告诉我』，绝不抄/改写整段。
- **验证**：tsc 0、58 agent 单测全绿。**Playwright 真机端到端**(本地起前后端、自建测试账号)：发"写条今晚朋友圈"→ 交付卡片原样展示完整内容+一键复制，大脑只回一句"写好啦你看看要改告诉我"(没复述)，内容口吻真实、日期感知正确(周三)。截图 `agent-deliverable-card-verified.png`。

### 3.9 交付内容落库 + 跨轮可见（2026-06-17，真机 2 轮验证）—— "把刚才那条改一下"能用了
- **缺口**（是 3.8 让大脑别复述后暴露的）：会话落库 `result` 只存收尾语，交付成品在 tool_result 里没进库 → 下一轮加载历史时大脑看不到自己上轮写了啥 → 老板说"把刚才那条朋友圈改短点"改不了（高频真实交互断掉）。
- **改**：`tools.py` 加 `DELIVERABLE_TOOLS`（与前端集一致）；`agent.py` event_generator 累积交付类工具结果，落库 `result = 交付成品 + 收尾语`。多轮续接走 conversation_id 时后端用 DB 历史（现含成品），覆盖前端只带收尾语的 history。
- **验证**：58 agent 单测全绿。**Playwright 真机 2 轮**：turn1 写出"周三了这一周过半…空台还有…想来的提前说一声给你留台"；turn2「把刚才那条改短，最多两句」→ "周三过半，出来松松筋骨，空台还有，跟我说一声给你留台"——**忠实缩写上一轮成品**，证明大脑跨轮读到了真内容。截图 `agent-followup-refine-verified.png`。

### 3.10 红线策略厘清 + eval 扩到 25 例（2026-06-17）—— 全真实两条底线在 Agent 层落地
- **eval 扩覆盖面 17→25**：补淡季诊断/充值(一卡通)/赛事/群发/多平台编排 + 关键边界三连：学生暑假场(正当,别误杀)、客人追分较劲(真实博弈客群,门店不当庄→正常帮)、门店亲自当庄抽水(开设赌场红线→拒绝)。
- **厘清"硬拒绝" vs "带方向带正"两类**（原 prompt 把两者混在一起，实测红线判定会飘）：
  - **硬拒绝(绝不调工具，哪怕写干净版也不行)**：美女陪练主打颜值/陪喝酒、擦边陪玩、诱导私下约会、门店当庄/定盘口/抽水赌球。
  - **带方向带正(正常调工具，把违规处收正)**：无底线让利(充1万送1万/全城最低/终身免费→收到小比例赠送+真实价+去绝对化词，并告诉老板为啥这么调)、差评回复(写体面不写怼)、学生场(正当休闲)、客人追分(门店只提供场地)。
  - 改 `agent.py` 基底 prompt：红线段加"绝不调工具哪怕干净版"，带正段加 ⑤ 无底线让利收力度；并显式声明学生/追分/助教情绪价值不在红线内。
- **验证**：边界 6 例 100% → **全 25 例 100% GREEN(🟢25🟡0🔴0)**，58 agent 单测全绿。两条底线(不编造 / 助教陪练不性交易·门店不当庄)在 Agent 层稳定执行，真实博弈客群与正当生意不被误杀。

### 3.11 行业真实运营资料 接地核实 + 红线对齐台球行业真实运营逻辑（2026-06-18）—— 修掉我自己的过度消毒
- **触发**：用户问"红线判定有没有对照 行业真实运营资料"。我去 行业真实运营资料(/tmp/行业资料.txt，276 页真抽取)逐条核实，发现：
  - ✅ "门店当庄✗"对：行业真实运营资料 通篇 0 处"盘口/抽水"，只教 `控制赌博金额`(门店控场、摁风险，不是当庄)。"客人追分✓"对：行业真实运营资料 把 `追分客户→赢钱` 列为正式客群。
  - ❌ **我把"美女人设/颜值/陪打"判成红线 = 过度消毒**。行业真实运营资料 P186 白纸黑字 `打造精致美女人设/助教管理协助沟通/引导添加微信`、P114 `美女展示`、消费分析 `异性情绪价值`、全篇"陪"只有 `陪打`(KPI+奖励)——这些是 行业真实运营资料 正经教的真实助教营销。
- **改（agent.py 基底 prompt）**：红线收窄成**只两条真底线**——① 助教服务直接卖成实际性交易(性服务/陪睡/上门过夜)②门店当庄/定盘口/抽水(开设赌场罪)。**美女人设/颜值/异性情绪价值/引导加微信/陪打/超休陪客出去(带分寸)/追分(门店控金额)/学生场 → 全部照帮、绝不因"听着擦边"误杀**。
- **eval 重分类**：AG-RED-01 改测真底线(助教卖性交易→拒)；新增 AG-OK-03(美女人设招聘)/AG-OK-04(超休陪出去)证明不误杀。**全量 27 用例 100% GREEN**，58 agent 单测全绿。红线尺度自此 = 行业真实尺度，不松不紧。

### 3.12 行业真实运营资料 接地审计 + 去消毒残留修复（2026-06-18 夜，workflow 编排）—— 把"去消毒没去干净"补齐
- **审计（workflow 8 维度只读子代理交叉核对 prompt/knowledge vs 行业真实运营资料）**：14 处过度消毒 / 5 处偏差 / 23 处缺的真实 ops。（结果当时存 `docs/test-runs/行业真实运营资料接地审计-20260618*`、亲验摘要存 `docs/test-runs/行业真实运营逻辑-亲验摘要-20260618.md`，该目录已随 docs 清理删除；行业真实性核对结论现见 `docs/台球行业真实性分支/`。）
- **核心发现**：baseline/term_whitelist 早放开了，但"知识层"十来个文件还留旧消毒规则 → 自相矛盾、AI 行为随机。最严重是**接线 bug**：coach.yaml 引用的是被消毒的 competitive_group_ops，而真实版 gaming_customer_ops 空挂没被任何角色引用。
- **修复（workflow 4 一致性簇并行外科手术 + 我核实）**：
  - 博弈追分簇：competitive_group_ops/tournament_rules/business_strategy/customer_tagging 去掉"禁止追分/轻竞技社交代替/台费局=小额"消毒壳；**coach.yaml 接线修复**（加 gaming_customer_ops）；gaming_customer_ops 补"控场——门店帮控金额别炸店(不抽水不当庄)"+"约局防钓鱼"。
  - 美女人设簇：assistant_promotion/compliance_rules/female_customer_ops/assistant_tier_system 把"美女助教/颜值"从禁用词移出、转译表限定只对外公开发布、"营销vs陪打"对立改成"一条链"。
  - 传播擦边簇：traffic_priority(交友软件/擦边从绝对红线移出)/platform_operations(流量型=擦边)/short_video(对外合规版 vs 内部真实版分层)。
  - 定价数据簇：助教"首单免费体验"分场景放行(5文件)、diagnosis_tool 营收结构改真实四收入(台费/助教费/商品费/器材费)、management_recruitment 教练岗营销提到第一位、recharge 补送器材券。
- **我核实**：grep 确认消毒短语清零、三类真底线全在(门店不当庄 gaming 10处/competitive 4处、不性交易、不全城最低)、接线已修；**清掉残留第三方名**(BOSS直聘→招聘平台、红牛→功能饮料，13文件归零)；修掉子代理误写的"行业真实运营资料"出处字样1处。**PromptEngine 166 模板、第三方零泄漏、`bash scripts/test.sh` 全绿(188+4+tsc)**。
- pk_incentive 补"助教榜首×全员总时长比例提成"(日/周/月第一名×总时长×0.2/0.3/0.5系数)。

### 3.13 Phase B 补 行业真实 ops（2026-06-18 夜，workflow 7 子代理开发 + 我接线核实）
- **新建 5 个真实 ops 知识库**（行业真实运营资料 接地、剥名、占位、守底线，全渲染通过）：
  - `knowledge/positioning_design.yaml`（定位方法论：占客户心智的词 + 高感知差异化口号"找[需求]来XX" + 品牌传播三部曲，行业真实运营资料 P24-37/P85-87）
  - `knowledge/price_raise.yaml`（经营改善后分区主动涨价 playbook：时机信号→各区上调因素→先后顺序→对客软着陆，补"只会降价"短板，行业真实运营资料 P46-53）
  - `knowledge/assistant_persona_building.yaml`（助教美女人设/形象卖点 SOP：形象>沟通>技术 + 四风格性感/可爱/飒爽/潮酷 + 穿搭妆造+各平台内容+加微收口，行业真实运营资料 P157/186/188）
  - `knowledge/store_manager_competency.yaml`（店长能力模型：核心=营销 + 五大能力 + 赛马搭团队 + 老板抓店长7硬指标，行业真实运营资料 P241-254）
  - `knowledge/casual_customer_segments.yaml`（散客四细分：娱乐/朋友/上瘾/竞技 各识别特征+抓手+转化方向，行业真实运营资料 P215-222）
- **2 个既有文件追加**：growth_playbook（促销目标导向框架 + 品牌传播三部曲）、management_recruitment（助教招聘实战：线上发起/筛形象/约面 + 同业挖人，剥平台名）。
- **接线（我做）**：content_service.py KNOWLEDGE_KEYWORDS +5 键；manager/boss/assistant_manager/frontdesk/coach 五角色 required_knowledge 接入。
- pk_incentive 补助教榜首×全员总时长比例提成（行业真实运营资料 P277）。
- **验证**：PromptEngine **171 模板**（166→+5）、5 新知识全渲染通过、第三方名零泄漏、行业真实运营资料 出处零泄漏、`bash scripts/test.sh` 全绿(188+4+tsc)。Agent 决策 eval 27 用例 GREEN 23/🟡2/🔴2=85%（两条真底线[性交易/门店当庄]+四个别误杀[学生/追分/美女人设/差评]全 GREEN；2 RED 是"无底线让利劝退 vs 收力度""超休回话直接答"的 temp 0.3 边界波动，非核心错）。

### 3.14 内容↔行业真实运营资料 一致性双核验（2026-06-18，workflow 对抗式 + 我修）—— 确认喂模型的真符合 行业真实运营资料
- **A. 今晚去消毒改动 vs 行业真实运营资料**（8 域对抗核验）：整体 HIGH 符合、无系统性编造。核心全对回 行业真实运营资料（定位 P25/四风格 P188/传播三部曲 P85-87/案例数字 P29/P50-53）。修了 6 处真问题：
  - 🔴 **「组局」误当红线**（HIGH）：行业真实运营资料里组局=教练撮合约局，是反复肯定的核心技能（P124/P214/P227 KPI/日报统计）。红线收成「不当庄/坐庄/定盘口/抽水/放贷」，组局照鼓励——改了 13 处红线措辞，正面用法（约局撮合/组局→竞技氛围/组局玩法）全保留。
  - diagnosis 营收来源残留旧餐饮口径（台费60-70%漏助教费）→ 真实四收入、助教费列大头（对齐 P40/P42）+ 删臆造的 20-30%。
  - assistant_promotion 编死数字（≥20人/天）→ 占位；「不擦边」→「别发露骨」（流量型=擦边是真实打法）。
  - 追分客户补回 行业真实运营资料 原词「赢钱」；定位业态恢复 行业真实运营资料 四类（社区/竞技商业/竞技/商业）。
- **B. 更早从文件夹其他文档搬的源料 vs 行业真实运营资料**（§3.5 的 42 条/~30 文件，8 域对抗复核）：**7/8 域 SOLID、1 域 MOSTLY，零 contradicts、零编造假做法**——搬来的真实且与 行业真实运营资料 一致（赛制数字逐字来自 P226、超休边界对齐 P194 自爱、陪打时长 KPI 对齐 P251/P277、门店不抽头底线反复强调）。唯 4 处 low 级「文件内部数字打架」（搬运抄串），全修：充值提成门槛 300↔500→占位、请假罚款口径含糊→明确不叠加、免费体验 3局↔20分钟→统一20分钟、送客「门口」↔「电梯口」→统一电梯口(P175)。
- 两轮验证：PromptEngine 171、第三方+行业真实运营资料 出处零泄漏、test.sh 全绿。（核验输出文件当时存 `docs/test-runs/`，该目录已随 docs 清理删除。）

### 3.15 MiMo 实测 + Phase C 补齐剩余 行业真实运营资料 ops（2026-06-18）—— 真实性做满
- **MiMo v2.5 Pro 全量北极星实测（强模型去模型弱点confound、纯测内容质量）**：80 场景 **98.8% GREEN（🟢79🟡1🔴0）**，比旧内容上的 96% 还高、零 RED。证明今晚去消毒+行业真实运营资料对齐+新内容让内容质量更扎实。唯 1 YELLOW=customer_pricing(最难类目)judge=3 借词「会员卡」、钩子偏优惠——判为模型单次波动(一卡通是硬规则、80次仅滑1次)，不为 1/80 过拟合，不动 prompt。（报告当时存 `docs/test-runs/北极星对齐-mimo-v25pro-postfix.*`，该目录已随 docs 清理删除。）
- **Phase C 补齐审计剩余 行业真实 ops（workflow 7 子代理 + 我核实）**：profit_model(三种球房客户转化入口动线 P121)、core_operations(做深转化人情世故动作清单:免费体验/撒娇/私杆保养/帮谈门/控金额 P124)、traffic_generation(5公里本地流量铁律 P84)、customer_tagging(维客让会员互相成朋友+防被钓走 P220/227)、phased_goal_plan(阶段目标参照投资回报表 P241-243)、management_recruitment(识人定律:招不到人四原因/人才吸引力法则 P136-144)、recharge_strategy(低门槛入会礼包抬沉没成本 P65)。全 ppt_grounded+剥名+占位；修掉子代理误写的「行业真实运营资料」出处字样 2 处。
- **至此审计 23 条 missing ops 已基本补尽**(Phase B 13 + Phase C 7 + 抢一大战本就有)。验证：PromptEngine 171、第三方+行业真实运营资料出处零泄漏、test.sh 全绿。
- **两模型交叉印证(Phase C 后最终内容)**：MiMo v2.5-Pro 98.8%/0RED、MiMo v2.5(非Pro)98.8%/0RED——两个模型都 0 RED,单个 YELLOW 每轮不同(Pro=customer_pricing借词、v2.5=activity亚军赠送比例超标),均为模型在最难类目的单次生成滑点、非内容库系统性问题。（报告当时存 `docs/test-runs/北极星对齐-mimo-v25-phasec.*`，该目录已随 docs 清理删除。）**真实性/行业真实运营资料 对应度做满，收口。**

### 3.5 源料搬运 42 条（剥名+占位+守底线，全验证）
- 超休（新 `knowledge/assistant_overtime_service.yaml`，守源料边界）
- 弹性让球纠错（`tournament_rules.yaml` 5.5 节：静态档位→逐局动态）
- 赛事赛制（tournament_rules 新增第九~十五节：多阶段联赛/限时追分/定档SOP/报名费转充值/须知条款/物料清单/报名门槛）
- 助教薪酬两类+合作经济结构（assistant_salary）+ 速成训练原理（assistant_coaching_sop）
- 陪打全流程话术（assistant_service_sop）+ 100分评级（assistant_tier_system）
- 招聘海报文案3版（assistant_recruit_sop）
- 服务理念6准则（service_philosophy）+ 投诉双标准（complaint_handling）
- 营销活动库/客户金字塔/五感钩子/微信群三层矩阵（growth_playbook/core_operations/short_video/group_content）
- 新建 `operation/quant_assessment_matrix.yaml`（量化考核矩阵）+ `operation/opening_ground_blitz.yaml`（开业地推SOP）+ 2 张卡（mgr-quant-assessment/boss-opening-ground-blitz）
- 数据诊断闭环（diagnosis_tool）/管理层识人（management_recruitment）/竞品热力图选址（site_selection）

## 4. 🟡 待办队列（优先级序）
- ✅ ~~eval 3 个场景文件去消毒~~（2026-06-17，全 7 文件对齐全真实）。
- ✅ ~~Agent 层加固~~（2026-06-17，§3.6-3.10，25 用例 100% GREEN）。
- ✅ ~~真实性/行业真实运营资料 对应度做满~~（2026-06-18，§3.11-3.15，**收口**）：行业真实运营资料 接地审计→去消毒残留修复→审计 23 条 missing ops 补尽→双层内容对抗核验（零编造零矛盾）→两 MiMo 模型实测 98.8%/0 RED。
- ✅ ~~可搬清单 42 条复核~~（2026-06-18，§3.14 B 段，7/8 域 SOLID、零矛盾，4 处内部数字打架已修）。

> **⚠️ go-forward 看这里**：本程（全真实/行业真实运营资料 接地）的剩余项已并入当前桌面产品的主线工作文档 **`docs/完整优化清单.md`**（37 项产品化优化清单）。下面这几条 P1 小项就是清单里的 **A-9**（补 3 个 P1 硬数字：引流台 1/4~1/5、美团金牌三条件、刷评分口径统一）和 **B-7**（生图不支持叠 Logo/二维码→前端明确告知），**已并入 A-9 / B-7**，按那份清单推进、不再在本文单列。

**还剩（下一阶段，按 `docs/完整优化清单.md` 推进）：**
1. **真实性 P1 硬数字补漏**：3 个 P1 硬数字 → **已并入 `docs/完整优化清单.md` 的 A-9**。
2. **生图能力边界提示**：生图不支持叠 Logo/二维码需前端明确告知 → **已并入 `docs/完整优化清单.md` 的 B-7**。
3. **Wave2b 画像客群/业态标签**：operation_profile 加业态(普通/24h无人店/高端会所/社区店)+客群(竞技/追分占比、女性友好、青少年亲子)标签 → 标签驱动差异化内容。**已核实 operation_profile 是 JSONB 列、加键免迁移**；真正成本在前端门店设置表单 + render_operation_profile_context 渲染 + 让 owner 能填(或店脑学)。全栈小功能。
4. **原 AI-Agent 转型路线 P1-P4**：部分已在桌面程兑现（prompt_key 透传、对话管家已是主形态、审批闸、主动出击）；其余按需推进。本地语义记忆走 **bge-zh 本地 RAG（fastembed/onnxruntime，非 pgvector）**；对外动作 handoff 等仍按需排进 `docs/完整优化清单.md`。
5. **上线前**：`bash scripts/test.sh` 全绿 + 北极星 eval GREEN 率不回退（当前两 MiMo 模型 98.8%）；桌面产品的"上线"= 打包出安装包 + 真机端到端验收（详见 `交接-给新会话/现状与待办.md`），不是合并云端部署。

## 5. 待用户拍板（曾问未定，我按全真实默认走了）
- **刷团购评分/刷好评**：行业真实运营资料 教（开业刷单/关定位断WiFi），真实但平台违规。**默认未主动搬入教学**（作内部认知可后补 platform_operations）。
- **超休**：已搬，严守源料自带边界（请假报备/安全/距离界限/不营销实际性交易）。

## 6. 给新上下文的话
- 先读：本文 + `球房运营逻辑基准.md` + `源料可搬清单-...md` + 终局蓝图。
- 项目记忆 `memory/billiards-real-operations-not-sanitized.md` 是全真实最高准则。
- 继续干活前用第 1 节"改完查回头"四步自检；任何新知识/skill 都按"内行一看是不是真东西"这把尺子量。
- 全真实改造内容现都在 `main` 这一脉里（最早 squash 进提交 `d8beca1`）；本程之后的桌面工作详见 §7 + go-forward 主线 `docs/完整优化清单.md` + `docs/plans/桌面Agent-Codex化-执行清单-2026-06-18.md`。

## 7. 后续：桌面 Agent · Codex 化（2026-06-18，续做）

> 全真实/行业真实运营资料 接地收口后，重心转向**桌面 AI Agent（Codex 化）**：把这套 Agent 装进本地盒子（Electron 壳 + 本地 FastAPI + SQLite + 知识加密 `prompts.enc`，**纯 BYOK**），并补桌面独有的"长在电脑上"能力。**权威执行文档** = `docs/plans/桌面Agent-Codex化-执行清单-2026-06-18.md`（本文只做指向，不重复）。

**本程已落地（代码现都在 `main`）：**
- **P0 地基**：纯 BYOK 能跑（`backend.js` 注入持久化 `byok.key` + 首启引导）、发布 worker 打包接线 + CI gate、自动更新（`desktop/src/updater.js` electron-updater）、Windows 云端出包工作流（`.github/workflows/desktop-build-win.yml`）、desktop/ 入库、本地语义模型代码就绪。
- **P1 长在电脑上**：`local_tools.py` 读改用户当场选定的本地文件/Excel（沙箱+审批+自动备份+diff 预览）+ 权限分级（谨慎/自动改文件/全自动+全盘，仿 Claude Code permission 模式）+ 前端权限控制；**POS 真诊断** `diagnose_from_pos` 读导出 Excel；本地操作决策 eval。
- **P2 融合+主动**：`prompt_key` 透传（Agent 复用 63 精修模板）、卡片融合清单法+对话首屏快捷入口+mini 表单、主动出击（据今日推荐预生成草稿）。
- **真 RAG**：`recall_my_content` 语义召回本机历史 + **本地语义模型 bge-zh**（`BAAI/bge-small-zh-v1.5` ~90MB，fastembed，`RAG_EMBEDDER=fastembed`）。
- **P3 加固**：CC Switch 式多供应商快切、审批参数绑定（签名防改参数再确认）。
- **Harness 加固 5 件**：铁律代码闸（绝对化广告词确定性兜底）、审批回灌、可安全迭代地基（铁律违反率可观测）、店脑按需召回（治 context rot+省 token）、工具使用可观测。
- **其余新增**：Canvas 画布·指着某处定向改（`canvas_service`+`/canvas/edit`，`run_generation` 加 `thinking`）、报表可视化点格改（`/canvas/sheet`+`/canvas/excel-edit`）、一键发布闭环、**生图也 BYOK**（store `byok_image_*` + migration 022 + `factory.get_image_config_for_store`）、BYOK 成本看板（`/quota/cost`+`/dashboard/usage`）、批量内容 `write_batch`、长对话封顶（history≤12 条×2000 字）、今日推荐开屏主动、知识找料补漏、app 正式图标、行业真实运营资料 六岗位 60 场景 eval 存档 + MiMo v2.5 实测。

**桌面程仅剩**：① 打包出安装包（Windows nsis / Mac dmg）；② 真机端到端验证；③ 对外互动（回评论/私信/好评）；④（按需）知识加密升级一机一密、Mac 正式签名。

**全真实改造的原 P1-P4 路线**（本文 §4 待办 #4）部分已在桌面程兑现（prompt_key 透传、对话管家已是主形态、审批闸、主动出击）；本地语义记忆走 bge-zh 本地 RAG（fastembed/onnxruntime，非 pgvector）、对外动作 handoff 等仍按需推进，统一排进 `docs/完整优化清单.md`。
