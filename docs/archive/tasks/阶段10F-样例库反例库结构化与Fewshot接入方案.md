# 阶段 10F：样例库 / 反例库结构化与 Few-shot 接入方案

> 生成时间：2026-05-12
> 版本：v1.0 — 方案设计
> 前置依赖：10D / 10E / 10F-0 / 10F-0.5

---

## 1. 10F 阶段定位

10F 的目标不是继续堆 Prompt 规则，而是设计一套更可持续的样例库 / 反例库 / few-shot 接入机制。

当前状态：经过 10D→10E→10F-0→10F-0.5 四个阶段，Prompt 规则体系已经很强（baseline 34条强制规则 + 6角色规则 + 7客户规则 + free_intent 输出结构约束），10D-4 回归测试通过率 96.7%。继续堆规则性价比递减。

10F 要解决的问题：
- 规则再多，模型仍会在边界场景犯错（如 10D-4 唯一的 FAIL：办卡送助教未完全拦截）
- 给出"好例子"比给出"更多禁止规则"更高效
- 现有 20 条优质样例和 30 条反例处于"有人读、机器不用"的状态
- 后续真实球房运营观察资料需要一个结构化的反哺入口

**10F 的长远目标**：让系统能根据用户场景自动选择少量相关优质样例注入 Prompt，用"示范"替代部分"禁止"。

---

## 2. 当前样例库 / 反例库现状

### 2.1 优质样例库（20 条）

**文件**：`docs/product-brain/workbench-优质样例库.md`

**结构分析**：

| 维度 | 现状 | 评价 |
|------|------|------|
| 是否有 Case ID | ✅ 有（C01-C30 风格） | 适合引用 |
| 是否有 role | ✅ 明确标注 | 可用于匹配 |
| 是否有 target_customer_type | ✅ 明确标注 | 可用于匹配 |
| 是否有 output_package | ✅ 明确标注 | 可用于匹配 |
| 是否有用户输入 | ✅ 完整原文 | few-shot 核心字段 |
| 是否有 AI 输出 | ⚠️ 摘要形式（非完整原文） | few-shot 够用但非最优 |
| 是否有"为什么好" | ✅ 每条都有 | 适合沉淀规则，不适合注入 Prompt |
| 是否有"可沉淀的规则" | ✅ 每条都有 | 适合转成规则 |
| 是否有 few-shot 标记 | ✅ 全部标记"是" | 但未经筛选 |
| 格式 | Markdown 自由文本 | 不适合机器直接读取 |

**核心问题**：
1. 标记为"适合 few-shot"的 20 条并非全部同等适合——有些场景太窄（如"周五朋友圈"），有些输出过长（如"32人周赛全套"）
2. Markdown 格式不适合机器直接读取，需要转为结构化格式
3. AI 输出是摘要而非完整原文，few-shot 注入时信息密度不够
4. 缺少场景标签和风险标签，机器无法做精准匹配

### 2.2 反例库（30 条）

**文件**：`docs/product-brain/workbench-反例库.md`

**结构分析**：

| 维度 | 现状 | 评价 |
|------|------|------|
| 是否有 Case ID | ✅ 有 | 适合引用 |
| 是否有错误类型分类 | ✅ 9 类高频错误 | 结构清晰 |
| 是否有错误输出摘要 | ✅ 有 | 但不能注入 Prompt（会让模型模仿错误） |
| 是否有"为什么错" | ✅ 每条都有 | 适合沉淀规则 |
| 是否有正确处理方式 | ✅ 每条都有 | 可转为正面示例 |
| 是否有规则建议 | ✅ 每条都有 | 大部分已同步到 YAML |
| 是否有回归测试标记 | ✅ 大部分标记"是" | 适合转成回归用例 |
| 格式 | Markdown 自由文本 | 不适合机器读取 |

**核心问题**：
1. 反例**绝对不应该**把完整错误输出注入运行时 Prompt——会让模型模仿错误
2. 30 条反例中大部分已通过 10D-3/10F-0.5 转为 YAML 规则，剩余的反例价值在于回归测试
3. 少量高价值反例可提取为"反面规则摘要"（一句话提醒），但不应放错误全文

---

## 3. 是否建议直接接入 few-shot

**不建议直接接入运行时 few-shot。建议分两步走：10F-1（结构化）→ 10F-2（轻量接入）。**

理由：

1. **样例库尚未达到可机器选择的状态**。当前 20 条样例缺少结构化标签（场景标签、风险标签），Markdown 格式无法被代码直接读取和匹配。
2. **Prompt 长度敏感**。当前 free_intent.yaml 渲染后约 3500 chars，baseline_rules 约 4000 chars，加上 role+customer rules 后总 Prompt 已接近 8000 chars。盲目注入样例会导致 token 超支。
3. **选择策略未经设计**。需要先定义匹配规则（基于哪些字段、优先级、数量限制），再考虑是否接入。
4. **当前规则体系已经够强**。10D-4 通过率 96.7%，10F-0.5 又补了 7 份 YAML。few-shot 是锦上添花，不是雪中送炭。
5. **引入向量检索太早**。当前场景数有限（6 role × 8 customer × 10 output），规则匹配足够，不需要引入复杂的向量检索系统。

**结论**：10F-1 先做结构化样例库（不写代码），10F-2 再做轻量接入（写少量代码）。

---

## 4. 样例库结构化方案

### 4.1 目标

将现有 Markdown 样例库整理为机器可读的结构化文档，支持代码层按字段匹配和选择。

### 4.2 新增文件

**文件 1**：`docs/product-brain/workbench-结构化优质样例库.yaml`

格式：YAML，每条样例包含标准化字段。

```yaml
# 结构化优质样例库
# 机器可读，支持按 role / customer_type / output_package / scene_tag / risk_tag 筛选

examples:
  - id: "POS-001"
    source: "C07"
    title: "团购客加微信（前厅场景）"
    user_intent: "今天来了几个团购客，我想加他们微信，后面方便喊他们来打球"
    role: "frontdesk"
    target_customer_type: "groupbuy"
    output_package: ["private_chat", "group_notice", "sop_checklist", "execution_tips"]
    extra_note: "不要太像推销"
    scene_tags: ["前厅接待", "团购核销", "加微信", "私域转化"]
    risk_tags: []
    quality_score: 8.2
    ai_output_snippet: |
      哈喽，今天打得还顺手吗？我们有个球友群，平时群里经常有人约球，你要感兴趣我拉你进去。下次来之前微信跟我说一声，帮你看台。
    why_good: "话术自然像真人微信聊天，不推销不优惠，output_package全部响应，附客户回应→应对方案"
    key_rule: "团购客加微信的三段式：体验问询→群邀约→下次留台"
    suitable_for_fewshot: true
    fewshot_output_length: "short"  # short / medium / long
```

### 4.3 字段说明

| 字段 | 类型 | 说明 | 用于匹配 |
|------|------|------|---------|
| id | string | 唯一标识 | — |
| source | string | 来源 Case ID | 追溯 |
| title | string | 中文标题 | — |
| user_intent | string | 用户输入原文 | 关键词匹配 |
| role | enum | 岗位 | **主匹配键** |
| target_customer_type | enum | 客户类型 | **主匹配键** |
| output_package | list[enum] | 输出类型 | **次匹配键** |
| extra_note | string | 补充说明 | 辅助排序 |
| scene_tags | list[string] | 场景标签 | **次匹配键** |
| risk_tags | list[string] | 风险标签（如有） | 反例触发 |
| quality_score | number | 质量评分（来自测试） | 排序优先 |
| ai_output_snippet | string | AI 输出片段（≤300字） | **注入 Prompt** |
| why_good | string | 为什么好 | 不注入，仅参考 |
| key_rule | string | 可沉淀规则 | 不注入，仅参考 |
| suitable_for_fewshot | bool | 是否适合 few-shot | 筛选 |
| fewshot_output_length | enum | 输出长度等级 | 长度控制 |

### 4.4 场景标签体系

```
## 客户运营
- 团购核销
- 加微信
- 进群引导
- 新客接待
- 老客户回访
- 大客户维护
- 离店跟进

## 助教场景
- 助教到店通知
- 助教服务推广
- 助教预约转化
- 助教短视频
- 助教朋友圈
- 助教PK
- 助教招聘
- 助教客户私聊

## 赛事场景
- 周赛
- 月赛
- 赛后战报
- 赛前报名
- 搭子局

## 门店管理
- 店长日报
- 前厅日报
- 前厅SOP
- 开店闭店
- 活动方案
- 朋友圈日常

## 风险/边界
- 口语转译（美女助教/点助教/陪玩）
- 免费助教拦截
- 优惠金额拦截
- 老客户信息编造拦截
- 投诉经济承诺拦截
```

### 4.5 从现有样例库迁移

20 条样例全部迁移到 YAML 格式，补充缺失字段。迁移过程中：
- 保留原始 Case ID 作为 source
- 标注 quality_score（从 10D-2 测试报告提取）
- 补充 scene_tags
- 将 AI 输出摘要裁剪为 ≤300 字的 snippet
- 标记 suitable_for_fewshot（长方案类标记为 false）

---

## 5. 反例库结构化方案

### 5.1 目标

将反例库拆分为三层用途：运行时规则提醒（极少量）、回归测试用例、产品大脑长期规则。

### 5.2 新增文件

**文件 2**：`docs/product-brain/workbench-结构化反例库.yaml`

```yaml
# 结构化反例库
# 三层用途：runtime_rules / regression_tests / product_brain

anti_examples:
  - id: "NEG-001"
    source: "C06"
    title: "助教PK总奖金5000被拆成具体金额"
    user_intent: "我想搞一个助教PK，店里有15个助教，奖金大概5000块钱，你帮我设计一下"
    role: "manager"
    target_customer_type: "assistant"
    error_type: "乱编金额/奖品/报名费"
    error_snippet: "第1名：1500元、第2名：1000元..."
    correct_approach: "给出分配思路和比例建议，不拆具体金额"
    rule_status: "已同步到 baseline_rules 规则13"
    regression_test: true
    runtime_use: false        # 不放运行时 Prompt
    runtime_rule_summary: ""  # 不放运行时 Prompt，留空
    product_brain_use: true
```

### 5.3 反例三层使用策略

| 层级 | 用途 | 包含内容 | 是否注入 Prompt |
|------|------|---------|---------------|
| 运行时规则 | 极少量高风险反例的规则摘要 | 一句话规则提醒（如"助教服务不能作为赠品"） | ✅ 已通过 baseline_rules 注入 |
| 回归测试 | 完整反例用于测试验证 | 错误类型+输入+检查标准 | ❌ 不放 Prompt |
| 产品大脑 | 长期规则沉淀 | 完整反例分析 | ❌ 不放 Prompt |

**关键判断**：30 条反例中，大部分已在 10D-3 / 10F-0.5 中转为 YAML 规则。剩余的未被规则覆盖的反例（如"免费助教体验未拦截"的变体），应通过强化规则覆盖而不是注入反例全文来处理。

---

## 6. Few-shot 选择策略

详见独立文档：`docs/product-brain/workbench-fewshot选择策略.md`

核心设计要点：

1. **基于规则匹配，不做向量检索**。当前场景空间有限，规则匹配足够。
2. **匹配层次**：role（必须匹配）→ customer_type（必须匹配或 all）→ scene_tags（优选匹配）→ output_package（加分匹配）
3. **数量限制**：每次注入 2-3 个正例，最多 1 个反例规则摘要
4. **长度限制**：每个样例 snippet ≤ 200 字，总 few-shot 注入 ≤ 600 字
5. **降级策略**：匹配不到相关样例时，不强制注入，只用规则生成

---

## 7. Prompt 长度控制方案

### 7.1 当前 Prompt 长度估算

| 组件 | 预估 chars | 预估 tokens（中文） |
|------|-----------|-------------------|
| baseline_rules | 4000 | ~1000 |
| role_rules | ~1700 | ~400 |
| customer_rules | ~1000 | ~250 |
| free_intent（门店背景+输出结构） | ~1500 | ~400 |
| **当前总 Prompt** | **~8200** | **~2050** |

DeepSeek-chat 上下文窗口 32K tokens，当前用量只占 6%。但加样例时要控制增量。

### 7.2 注入预算

| 注入项 | 数量 | 单条上限 | 总上限 |
|--------|------|---------|--------|
| 优质正例 snippet | 2-3 条 | 200 字 | 600 字（~150 tokens） |
| 反例规则摘要 | 0-1 条 | 80 字 | 80 字（~20 tokens） |
| **注入总预算** | | | **≤ 700 字（~170 tokens）** |

### 7.3 避免样例覆盖主规则

- few-shot 注入放在 Prompt 的"输出结构"之前、"关键约束"之后
- 明确标注 `## 参考示例（仅供参考，规则约束优先）`
- 当样例与 baseline_rules 冲突时，声明"以上参考示例不得覆盖前述铁规"

---

## 8. 反例库运行时使用边界

**核心原则：反例不放运行时 Prompt 中的完整错误输出。**

| 反例处理方式 | 是否放入 Prompt | 理由 |
|------------|--------------|------|
| 完整错误输出 | ❌ 绝对不放 | 会让模型模仿错误 |
| 错误类型+正确做法 | ❌ 不放 | 太长，应转为规则 |
| 一句话规则摘要 | ✅ 可放（≤80字） | 如"助教服务不能作为赠品——包括去掉'免费'二字的变体" |
| 回归测试用例 | ❌ 不放 | 测试时使用，不在生成时使用 |

**具体策略**：
- 30 条反例 → 提取已覆盖的规则（约 25 条已通过 10D-3/10F-0.5 转为 YAML 规则）
- 剩余 5 条未被规则覆盖的反例 → 评估是否需要补充规则
- 不新增"反例注入"机制

---

## 9. 10F-1 / 10F-2 分阶段执行建议

### 10F-1：样例库 / 反例库结构化（本次仅设计，不编码）

**目标**：把 Markdown 样例/反例转为机器可读的 YAML 格式，建立标签体系。

**产出物**：
- `docs/product-brain/workbench-结构化优质样例库.yaml`（20 条）
- `docs/product-brain/workbench-结构化反例库.yaml`（30 条）
- `docs/product-brain/workbench-fewshot选择策略.md`（本方案已产出）

**不做的**：
- 不改 PromptEngine 代码
- 不改 YAML prompt 文件
- 不接入运行时 few-shot
- 不引入向量检索

**工作量估算**：纯文档工作，约 2-3 小时。

### 10F-2：轻量 few-shot 接入（本次仅设计，不编码）

**目标**：在 content_service.py 的 generate_workbench() 中添加样例选择→注入逻辑。

**改动范围**（后续编码任务）：
- `server/services/content_service.py`：新增 `_select_fewshot_examples()` 函数（约 50 行），修改 `generate_workbench()` 添加 few-shot 注入（约 10 行）
- `server/prompts/workbench/free_intent.yaml`：新增 `{fewshot_examples}` 变量和注入位置（约 5 行）
- `server/services/ai/prompt_engine.py`：无需修改（通过 extra_vars 传入）
- `server/schemas/generate.py`：无需修改
- 前端：无需修改

**不做的**：
- 不引入向量数据库
- 不引入复杂检索系统
- 不修改 PromptEngine 架构

**工作量估算**：约 50-80 行代码改动，约 1-2 小时。

---

## 10. 文件修改清单

### 10F 方案设计阶段（本次）

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `docs/tasks/阶段10F-样例库反例库结构化与Fewshot接入方案.md` | 本文件 |
| 新增 | `docs/product-brain/workbench-fewshot选择策略.md` | 选择策略详细文档 |
| 新增 | `docs/reports/10F-方案设计完成报告.md` | 方案设计完成报告 |

### 10F-1 实施阶段（后续）

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `docs/product-brain/workbench-结构化优质样例库.yaml` | 20 条结构化的 YAML 样例 |
| 新增 | `docs/product-brain/workbench-结构化反例库.yaml` | 30 条结构化的 YAML 反例 |

### 10F-2 实施阶段（后续）

| 操作 | 文件 | 说明 |
|------|------|------|
| 修改 | `server/services/content_service.py` | 新增样例选择函数 + few-shot 注入 |
| 修改 | `server/prompts/workbench/free_intent.yaml` | 新增 {fewshot_examples} 变量 |
| 不修改 | `server/services/ai/prompt_engine.py` | — |
| 不修改 | `server/schemas/generate.py` | — |
| 不修改 | 所有前端文件 | — |

---

## 11. 是否需要数据库迁移

**否。** 10F-1 和 10F-2 均不需要数据库变更。

样本库和反例库以静态 YAML 文件形式存储，加载方式与现有 rules YAML 一致（通过 PromptEngine 或直接读取文件）。无需建表存储。

---

## 12. 是否需要修改 PromptEngine

**否。** 现有 PromptEngine 通过 extra_vars 字典传递动态变量（如 baseline_rules、role_rules、customer_rules），few-shot 注入可复用同一机制——将选中的样例渲染为字符串，通过 `fewshot_examples` 变量传入 free_intent.yaml。PromptEngine 本身不需要修改。

---

## 13. 是否需要调用 DeepSeek

**10F 方案设计阶段**：否（本次任务不调用）。

**10F-1 结构化阶段**：否（纯文档工作）。

**10F-2 接入阶段**：建议接入后进行 20 条小样本回归测试，确认 few-shot 注入对输出质量的提升。但不属于本方案设计范围。

---

## 14. 风险评估

| 风险 | 等级 | 说明 | 规避方案 |
|------|------|------|---------|
| 样例选择不准 | 中 | 关键词匹配可能选到不相关的样例 | 优先匹配 role + customer_type，scene_tags 只做加分项；匹配不到时不强制注入 |
| Prompt 过长 | 低 | 注入 2-3 条样例增加约 170 tokens，占比小 | 严格限制样例数量和长度，降级时减少或跳过 |
| 样例覆盖主规则 | 中 | 样例可能暗示模型忽略 baseline_rules | 注入位置放在规则之后，明确标注"规则约束优先" |
| 样例过时 | 低 | 产品规则演进后，旧样例可能不再适用 | 定期审查样例库（每次 YAML 规则更新后检查） |
| 过度依赖 few-shot | 中 | 以为加样例就能解决所有边界问题 | Few-shot 是辅助手段，强规则仍然是主力；不因加样例而放松规则 |
| 引入向量检索的诱惑 | 高 | 场景数不够多时引入向量检索是过度设计 | 明确 10F 不做向量检索，10F-2 只做规则匹配 |

---

## 15. 验收标准

### 10F-1 验收标准

- [ ] 结构化优质样例库 YAML 包含全部 20 条样例
- [ ] 每条样例有完整的 role / customer_type / output_package / scene_tags
- [ ] ai_output_snippet ≤ 300 字
- [ ] 标注了 suitable_for_fewshot 和 fewshot_output_length
- [ ] 结构化反例库 YAML 包含全部 30 条反例
- [ ] 反例标注了 runtime_use / regression_test / product_brain_use 三层分类
- [ ] YAML 语法正确，可被 Python yaml.safe_load() 解析
- [ ] Few-shot 选择策略文档包含标签体系、匹配规则、10 个选择示例

### 10F-2 验收标准（后续）

- [ ] content_service.py 新增样例选择函数
- [ ] free_intent.yaml 支持 {fewshot_examples} 变量
- [ ] 20 条小样本测试确认 few-shot 注入无负面影响
- [ ] Prompt 长度增量 ≤ 200 tokens
- [ ] 不修改 PromptEngine、数据库、前端代码

---

## 16. 是否建议开始 10F-1

**建议，但需先把本方案提交 ChatGPT 审查。**

审查重点：
1. 样例标签体系是否合理
2. 反例三层使用策略是否可行
3. 10F-2 接入方案是否过于保守/激进
4. 是否有遗漏的关键场景需要在结构化样例库中补充

审查通过后即可开始 10F-1（纯文档工作，不改代码）。

---

*方案设计完成。10F 方案设计阶段执行完毕。*
