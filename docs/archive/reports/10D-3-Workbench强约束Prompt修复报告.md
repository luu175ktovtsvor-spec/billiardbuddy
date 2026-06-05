# 10D-3 Workbench 强约束 Prompt 修复报告

> 生成时间: 2026-05-12
> 基于: 10D-2 Workbench 150条暴力组合测试报告

---

## 1. 本次修复依据

基于 10D-2 报告中的以下核心发现：

- **150 条全部成功调用 DeepSeek**，通过 61 条，基本通过 77 条，未通过 12 条
- **通过率约 92%**，平均分 7.6/10
- **高频问题统计前 10**（数据以 10D-2 完整 Markdown 报告正文为准）：
  1. 未知信息未占位（95 次，63.3%）
  2. 未知信息已占位（55 次，36.7%）
  3. 用户意图误判（31 次，20.7%）
  4. output_package 未响应（30 次，20.0%）
  5. 输出太长（28 次，18.7%）
  6. 乱编优惠/充值（10 次，6.7%）
  7. 乱编金额/奖品/报名费（9 次，6.0%）
  8. 擅自安排管理动作（3 次，2.0%）
  9. 默认带电话地址（1 次，0.7%）
  10. 虚假承诺 / 乱编助教姓名/客户数据（各 1 次，0.7%）
  8. 默认带电话地址（1 次，0.7%）
  9. 虚假承诺（1 次，0.7%）
- **12 条 FAIL 用例的主要问题**集中在：优惠/价格泄漏、总预算拆具体金额、模糊需求过度输出、高风险表达照写不误

---

## 2. 修改了哪些 Prompt / Rules 文件

| # | 文件 | 修改类型 | 说明 |
|---|------|---------|------|
| 1 | `server/prompts/rules/baseline_rules.yaml` | 强化+新增 | 从 27 条规则扩展到 34 条，新增 10D-3 强约束 |
| 2 | `server/prompts/workbench/free_intent.yaml` | 强化+新增 | 新增逐项响应规则表、模糊需求简版策略、高风险转译表 |
| 3 | `server/prompts/rules/customer/old.yaml` | 强化 | 最高优先级禁止默认优惠/充值/折扣 |
| 4 | `server/prompts/rules/customer/groupbuy.yaml` | 强化 | 严禁输出会员卡档位和充值具体方案 |
| 5 | `server/prompts/rules/customer/new.yaml` | 强化 | 严禁输出课程价格、具体优惠促销方案 |
| 6 | `server/prompts/rules/customer/assistant.yaml` | 强化 | 最高优先级拦截"免费+助教"组合 |
| 7 | `server/prompts/rules/customer/competition.yaml` | 强化 | 严禁编造具体奖金金额、报名费、比赛时间 |
| 8 | `server/prompts/rules/customer/light_competition.yaml` | 强化 | 严禁赌博暗示词，小奖品不编造具体价值 |
| 9 | `server/prompts/rules/customer/vip.yaml` | 强化 | 严禁编造VIP特权内容、充值续费方案 |
| 10 | `server/prompts/rules/role/manager.yaml` | 强化+新增 | 新增模糊需求简版策略、优惠约束 |
| 11 | `server/prompts/rules/role/assistant_manager.yaml` | 强化+新增 | 新增PK奖金分配规则、招聘合规约束 |
| 12 | `server/prompts/rules/role/coach.yaml` | 强化 | 新增课程推广约束、赛事信息占位强化 |
| 13 | `server/prompts/rules/role/frontdesk.yaml` | 强化+新增 | 会员话术禁令、投诉安抚禁令、SOP金额约束 |
| 14 | `server/prompts/rules/role/operator.yaml` | 强化+新增 | 新增预算约束、活动设计约束、数据汇报约束 |
| 15 | `server/prompts/rules/role/boss.yaml` | 强化 | 新增汇报数据约束、大客户场景约束 |

**共计修改 15 个 YAML 文件。**

---

## 3. 新增 / 强化了哪些规则

### 3.1 未知信息占位（强化）

- **baseline_rules 第11条**：升级为最高优先级。"用户没有明确提供的任何经营信息，必须用【请补充：XXX】占位，不得为了让内容看起来完整而自己编。"
- 覆盖范围扩展到：优惠、充值、折扣、会员价、奖金、奖品、报名费、活动时间、活动地点、比赛规则、助教姓名、助教数量、助教价格、客户数据、营业额、预算明细、员工姓名、具体福利、体验券、台费金额、备用金、饮料赠送、台费减免、排班安排、处罚规则、奖励规则、会员卡档位、会员充值方案、具体课时价格、具体服务承诺

### 3.2 优惠 / 金额强约束（新增）

- **baseline_rules 第12条**：严禁在用户说"店里冷清""想拉人""搞个活动""促活""老客户回来""团购客转会员"等模糊场景下默认输出优惠/充值/折扣。默认输出方向为熟人邀约、空台提醒、群里接龙、约球搭子等非优惠手段
- **old.yaml**：新增最高优先级约束——"即使用户说店里冷清/想拉人/让老客户回来，也严禁默认输出优惠、充值、折扣"
- **groupbuy.yaml**：前厅话术严禁输出会员卡档位和储值金额
- **new.yaml**：新客户转化"靠体验和服务，不靠优惠刺激"

### 3.3 总预算不自动拆金额（新增）

- **baseline_rules 第13条**：用户给总预算/总奖金时，严禁自动拆分具体金额，只给分配思路和比例建议
- **assistant_manager.yaml**：PK奖金分配规则明确——错误示例 vs 正确示例
- **operator.yaml**：活动预算分配规则明确——给比例不给金额
- **触发条件**："帮我具体分配""直接给我拆金额""你直接帮我定每项多少钱" 才允许拆金额

### 3.4 output_package 逐项响应（新增）

- **baseline_rules 第34条**：output_package 必须逐项响应
- **free_intent.yaml**：新增逐项响应规则表，10 种输出类型各自必须包含的内容
- 不适合的场景必须说明原因并跳过，不能无故忽略

### 3.5 模糊需求简版输出（新增）

- **baseline_rules 第32-33条**：模糊需求默认简版，800-1200 字
- **free_intent.yaml**：模糊需求简版结构模板——【先发这条】→【再做这2-3件事】→【需要你补充】
- **manager.yaml**：店长模糊需求处理策略

### 3.6 员工管理动作限制（强化）

- **baseline_rules 第20条**：投诉安抚不得擅自承诺免单、退款、抹零、送饮料、台费减免、赔偿
- **baseline_rules 第21条**：员工管理/绩效/处罚不得擅自设计扣款金额、绩效权重、处罚细则
- **frontdesk.yaml**：投诉安抚标准三步流程

### 3.7 前厅 / 会员 / 团购转化限制（新增）

- **frontdesk.yaml**：会员话术最高优先级禁令——"前厅话术中严禁输出具体会员卡档位、充值金额、赠送金额"
- **groupbuy.yaml**：团购客问会员的处理方式——引导到店了解而非直接报价

### 3.8 高风险表达转译（新增）

- **baseline_rules 第30条**：高风险输入转译表，6 类常见高风险表达的转译对照
- **free_intent.yaml**：高风险输入转译规则表，7 类场景的正确转译
- **具体转译**：全城最低价→价格透明、包教包会→纠正常见问题、追分→台费局、免费助教→付费服务、招助教身高年龄→形象得体

### 3.9 免费助教体验拦截（强化）

- **baseline_rules 第29条**：严禁"免费体验助教""来店免费陪打""送免费助教一小时""助教体验券"等表达，即使用户要求也必须转译
- **assistant.yaml**：最高优先级拦截规则

### 3.10 emoji 控制（强化）

- **baseline_rules 第24条**：从"每段文案最多2个emoji"升级为"每段文案最多2个emoji，整个输出中emoji总数不超过5个"

---

## 4. 新增了哪些文档

| # | 文件 | 说明 |
|---|------|------|
| 1 | `docs/product-brain/workbench-优质样例库.md` | 20 条优质样例，覆盖 10 个核心场景，每条含场景/输入/输出摘要/为什么好/可沉淀规则/是否适合few-shot |
| 2 | `docs/product-brain/workbench-反例库.md` | 30 条典型反例，覆盖 9 类高频错误，每条含错误类型/为什么错/正确处理方式/应新增规则/是否适合回归测试 |
| 3 | `docs/tasks/10D-4-Workbench强约束回归测试用例.md` | 30 条回归测试用例，覆盖 20+ 类高风险场景，每条含user_intent/role/customer/output/extra/重点检查项/通过标准 |

---

## 5. 是否修改代码

**否。** 未修改任何业务代码文件，包括：
- `server/services/content_service.py`
- `server/api/v1/generate.py`
- `server/schemas/generate.py`
- `server/services/ai/prompt_engine.py`
- `server/services/ai/factory.py`
- `web/` 目录下任何文件

---

## 6. 是否修改 PromptEngine

**否。** `server/services/ai/prompt_engine.py` 未做任何修改。

---

## 7. 是否需要数据库迁移

**否。** 未修改任何数据库模型和表结构。

---

## 8. 静态检查结果

### 8.1 YAML 语法检查

- **检查文件数**: 23 个（全部 Prompt/Rules YAML 文件）
- **结果**: 全部通过，0 个语法错误

### 8.2 PromptEngine 加载检查

- **PromptEngine 初始化**: 成功
- **模板加载数**: 23 个
- **baseline_rules 渲染**: OK (2475 chars)
- **free_intent 渲染**: OK (3002 chars)
- **全部 6 个 role rules 渲染**: OK
- **全部 7 个 customer rules 渲染**: OK
- **结果**: 全部通过，0 个加载失败

### 8.3 代码修改检查

- **结果**: 确认未修改任何 .py 文件
- **确认未修改**: content_service.py, generate.py, prompt_engine.py, factory.py
- **确认未修改**: web/ 目录任何文件

---

## 9. 是否建议进入 10D-4 回归测试

**建议进入。** 理由：

1. 15 个 Prompt/Rules YAML 文件被修改，规则从 27 条扩展到 34 条
2. 新增了 10 个维度的强约束规则
3. 10D-2 测试中的 12 条 FAIL 用例需要重新验证
4. 30 条回归测试用例已准备好

---

## 10. 建议 10D-4 测试规模

- **建议先跑 30 条回归测试**（已准备就绪：`docs/tasks/10D-4-Workbench强约束回归测试用例.md`）
- **不要立即再跑 150 条**，除非用户明确要求
- 30 条回归测试通过后，可根据需要选择性补充高风险用例
- 如果 30 条全部通过，说明 10D-3 强约束有效，可以进入产品验收

---

## 附录：修改前后的规则变化对比

| 维度 | 10D-1 (修改前) | 10D-3 (修改后) |
|------|---------------|---------------|
| baseline_rules 规则数 | 27 条 | 34 条 |
| 优惠/充值约束 | 一般约束 | 最高优先级（10处以上强化） |
| 总预算拆金额 | 无约束 | 强制禁止 + 比例建议替代 |
| output_package 响应 | 无强制 | 逐项响应规则表 |
| 模糊需求输出 | 无约束 | 简版模板 + 800-1200字限制 |
| 投诉安抚 | 无专门约束 | 禁止经济承诺 |
| 免费助教 | 一般禁止 | 强制拦截转译 |
| 高风险转译 | 无 | 6类转译对照表 |
| emoji 控制 | 每段≤2个 | 每段≤2个 + 全文≤5个 |

---

## 附录：临时测试脚本保留说明

以下脚本为 10D-2 测试时创建的临时脚本，本次 10D-3 修复未使用，保留供参考：

- `scripts/tmp_workbench_matrix_test.py` — 10D-2 150条测试脚本
- `scripts/tmp_analyze_results.py` — 10D-2 自动违规检测脚本
- `scripts/tmp_score_and_report.py` — 10D-2 评分和报告生成脚本
- `scripts/test_results_150.json` — 10D-2 150条测试原始结果
