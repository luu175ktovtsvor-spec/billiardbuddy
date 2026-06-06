# Workbench Few-shot 样例选择策略

> 生成时间：2026-05-12
> 用途：指导 10F-2 代码层实现样例自动选择逻辑
> 前置：10F-1 结构化样例库

---

## 1. 样例标签体系

### 1.1 主匹配键（必须匹配）

| 字段 | 来源 | 匹配方式 | 优先级 |
|------|------|---------|--------|
| role | WorkbenchRequest.role | 精确匹配 | P0 |
| target_customer_type | WorkbenchRequest.target_customer_type | 精确匹配或 all | P0 |

### 1.2 次匹配键（优选匹配）

| 字段 | 来源 | 匹配方式 | 优先级 |
|------|------|---------|--------|
| scene_tags | 样例标注 | 与 user_intent 关键词交集 | P1 |
| output_package | WorkbenchRequest.output_package | 交集数量排序 | P1 |

### 1.3 辅助排序键

| 字段 | 来源 | 作用 |
|------|------|------|
| quality_score | 样例标注（来自测试评分） | 同匹配度下优先选高分样例 |
| fewshot_output_length | 样例标注 | 优先选 short 样例，控制注入长度 |
| risk_tags | 样例标注 | 当 user_intent 含高风险词时，优先选有对应 risk_tags 的样例 |

### 1.4 场景标签（scene_tags）完整列表

```
## 客户运营
前厅接待, 团购核销, 加微信, 进群引导, 新客接待, 老客户回访, 大客户维护, 离店跟进

## 助教场景
助教到店通知, 助教服务推广, 助教预约转化, 助教短视频, 助教朋友圈, 助教PK, 助教招聘, 助教客户私聊

## 赛事场景
周赛, 月赛, 赛后战报, 赛前报名, 搭子局

## 门店管理
店长日报, 前厅日报, 前厅SOP, 开店闭店, 活动方案, 朋友圈日常, 员工关怀

## 风险/边界
口语转译, 免费助教拦截, 优惠金额拦截, 老客户编造拦截, 投诉经济承诺拦截
```

---

## 2. role 匹配规则

```
rule_match_role(input_role, example_role):
    if input_role == example_role:
        return match_score = 100   # 精确匹配
    elif example_role in compatible_roles[input_role]:
        return match_score = 50    # 兼容角色（见下表）
    else:
        return match_score = 0     # 不匹配，排除
```

### 兼容角色表

当精确匹配的样例不足 2 条时，可从兼容角色中选取：

| 输入 role | 兼容 role | 原因 |
|-----------|----------|------|
| boss | manager | 老板和店长的运营视角接近 |
| manager | boss, assistant_manager | 店长全盘视角，可参考老板和助教管理 |
| assistant_manager | manager | 助教管理偏管理，可参考店长 |
| coach | manager | 教练偏运营，可参考店长 |
| frontdesk | manager | 前厅接待话术可参考店长的客户沟通 |
| operator | manager | 运营负责人可参考店长 |

兼容匹配得分减半（50 vs 100），排序时精确匹配优先。

---

## 3. customer_type 匹配规则

```
rule_match_customer(input_type, example_type):
    if input_type == example_type:
        return match_score = 100
    elif example_type == "all":
        return match_score = 60     # all 是通用样例，可用但非最优
    elif input_type == "old" and example_type == "vip":
        return match_score = 50     # 老客户和大客户话术部分重叠
    elif input_type == "new" and example_type == "groupbuy":
        return match_score = 50     # 新客和团购客部分重叠
    else:
        return match_score = 0
```

---

## 4. output_package 匹配规则

```
rule_match_output(input_packages, example_packages):
    intersection = set(input_packages) & set(example_packages)
    if len(intersection) == 0:
        return match_score = 0
    jaccard = len(intersection) / len(set(input_packages) | set(example_packages))
    return match_score = jaccard * 50  # 最多加 50 分
```

注意：output_package 是次匹配键，不做硬过滤。即使用户选了 moments，一个没有 moments 但 scene_tags 高度匹配的样例也可能被选中（只是得分较低）。

---

## 5. user_intent 关键词匹配规则

从 user_intent 提取关键词，与样例的 scene_tags 做交集匹配。

### 5.1 关键词→场景标签映射表

| 用户输入关键词 | 映射 scene_tag |
|--------------|---------------|
| 美女助教, 好看的助教, 漂亮助教, 点助教 | 口语转译, 助教服务推广 |
| 新助教, 助教到了, 助教可约, 助教在店 | 助教到店通知 |
| 约助教, 约陪练, 想找助教, 点助教 | 助教预约转化 |
| 助教视频, 短视频, 抖音 | 助教短视频 |
| 助教朋友圈, 发圈 | 助教朋友圈 |
| 助教PK, 助教业绩, 助教比赛 | 助教PK |
| 招助教, 招聘, 招人 | 助教招聘 |
| 老客户, 好久没来, 很久没见, 几个月没来 | 老客户回访 |
| 大客户, VIP, 重要客户, 大哥 | 大客户维护 |
| 团购, 美团, 抖音团购, 核销 | 团购核销 |
| 加微信, 加个微信, 要微信 | 加微信 |
| 第一次来, 新客, 新来的客人 | 新客接待 |
| 周赛, 月赛, 比赛, 会员赛 | 周赛, 月赛 |
| 战报, 比赛结果, 赛后 | 赛后战报 |
| 搭子, 约球, 有没有人打, 一起打 | 搭子局 |
| 会员群, 会员通知, 会员活动, 会员提醒 | member_group, member_group_notice, member_maintenance |
| 竞技群, 约局, 轻竞技, 赛后战报, 缺一位, 练球局 | competition_group, competition_group_notice, matchmaking_notice |
| 乔氏, 独牙, 斯诺克, 台球桌, 桌型, 设备 | table_type, joy_billiards_table, snooker_table |
| 普通台球桌, 中式八球 | normal_pool_table |
| 空台, 没人, 冷清, 下午没人 | 朋友圈日常 |
| 日报, 今天工作, 总结一下 | 店长日报, 前厅日报 |
| 开店, 闭店, 检查表 | 开店闭店, 前厅SOP |
| 免费助教, 免费体验, 送助教, 体验券 | 免费助教拦截 |
| 优惠, 充值, 折扣, 会员价 | 优惠金额拦截 |
| 包教包会, 保证赢, 全城最低 | 口语转译 |

### 5.2 匹配算法

```
rule_match_scene(user_intent, example_scene_tags):
    keywords = extract_keywords(user_intent)     # 从映射表提取
    mapped_tags = map_keywords_to_tags(keywords)  # 映射到 scene_tags
    intersection = set(mapped_tags) & set(example_scene_tags)
    return len(intersection) * 30  # 每个匹配 tag 加 30 分
```

---

## 6. 风险标签匹配规则

当 user_intent 中包含高风险关键词时，额外加分给有对应 risk_tags 的样例：

| 风险关键词 | risk_tag |
|-----------|---------|
| 免费助教, 送助教, 体验券 | 免费助教拦截 |
| 美女助教, 点助教, 陪玩 | 口语转译 |
| 充多少送, 折扣, 优惠 | 优惠金额拦截 |
| 包教包会, 保证赢, 最低价 | 口语转译 |

```
risk_bonus = 1 if matching_risk_tag else 0
risk_bonus *= 40  # 风险匹配加 40 分（较高权重）
```

---

## 7. 综合评分公式

```
total_score = (
    role_score * 1.0 +            # 0 或 100 或 50
    customer_score * 0.8 +         # 0 或 100 或 60 或 50
    scene_score * 0.6 +            # 每个匹配 tag 30 分
    output_score * 0.4 +           # 最多 50 分
    risk_bonus * 0.5 +             # 0 或 40 分
    quality_score * 0.2            # 来自测试评分 (0-10)
)
```

权重设计原则：
- role 权重最高（岗位决定内容视角）
- customer_type 次之（客户类型决定策略）
- scene_tags 第三（场景精确匹配）
- output_package 较低（输出格式可以适配）
- quality_score 最低（只是同分时的 tie-breaker）

---

## 8. 样例数量限制

```
MAX_POSITIVE_EXAMPLES = 3     # 最多注入 3 个正例
MIN_POSITIVE_EXAMPLES = 1     # 至少 1 个（匹配度太低时可降为 0）
MAX_NEGATIVE_RULES = 1        # 最多 1 条反例规则摘要
MIN_MATCH_SCORE = 30          # 低于此分不注入
```

### 降级策略

| 情况 | 处理 |
|------|------|
| 匹配到 ≥3 个样例且分数 ≥30 | 取前 3 个 |
| 匹配到 1-2 个样例且分数 ≥30 | 全部注入 |
| 匹配到 0 个样例（或分数 <30） | 不注入，只用规则生成。不强制塞无关样例 |
| user_intent 含高风险词但无匹配样例 | 注入 1 条最相关规则摘要作为提醒 |

---

## 9. 样例长度限制

```
MAX_SNIPPET_CHARS = 200       # 单个样例 snippet 最多 200 字
MAX_TOTAL_FEWSHOT_CHARS = 600 # few-shot 注入总计最多 600 字
MAX_NEGATIVE_RULE_CHARS = 80  # 反例规则摘要最多 80 字
```

### 注入 Prompt 的格式

```
## 参考示例（仅供参考，以下规则约束优先）

**示例 1**（场景：助教到店通知 / 助教服务推广）
用户说：今天美女助教到了，帮我发朋友圈
正确输出：今日助教到店，想约助教服务的朋友可以提前说。一个人来打球也不尴尬，我帮你看时间。

**示例 2**（场景：老客户回访）
用户说：好久没联系老客户了，帮我发几句话约他们来打球
正确输出：好久没见你来打球了，最近忙什么呢？有空回来打两把，找找手感。来之前跟我说一声，帮你看台。

**注意**：以上示例仅供参考。基线规则和场景约束仍然是最高优先级。示例不能覆盖前述任何铁规。
```

---

## 10. 正例 / 反例使用策略

### 10.1 正例（优质样例）

- **用途**：以"示范正确做法"的方式引导模型
- **注入方式**：精选 2-3 条最相关正例的 user_intent + ai_output_snippet
- **不注入**：why_good、key_rule、完整 AI 输出（太长）
- **适用时机**：每次 Workbench 调用

### 10.2 反例（错误样例）

- **用途**：不在生成时注入完整反例
- **正确使用方式**：
  - 已转为 baseline_rules 的 → 已经在 Prompt 中生效
  - 未转规则的 → 评估后补充到 baseline_rules
  - 边界测试用例 → 回归测试时使用
- **唯一可注入的反例形式**：一句话规则摘要（如"助教服务不能作为任何形式的赠品"），且只在 user_intent 明确含相关风险词时注入

### 10.3 为什么反例不注入 Prompt

1. 模型可能模仿错误输出（已有论文证明反例 few-shot 不如正例有效）
2. 增加 Prompt 长度而边际收益低
3. 反例的"正确做法"部分大部分已转为规则
4. 一句话规则摘要比反例全文更高效

---

## 11. 10 个选择示例

### 示例 1：助教到店通知 + 口语转译

**输入**：
- user_intent: "今天美女助教到了，帮我发朋友圈"
- role: assistant_manager
- target_customer_type: assistant
- output_package: ["moments", "execution_tips"]

**选择过程**：
1. role 精确匹配 → 筛选 assistant_manager 样例
2. customer_type 精确匹配 → 筛选 assistant 样例
3. 关键词提取：美女助教 → scene_tag 口语转译 + 助教到店通知
4. 按综合评分排序，取前 2 条

**应选样例**：
- 优先：助教到店通知 + 口语转译类样例
- 可选：助教服务推广类样例
- 不选：助教PK、助教招聘、周赛、前厅核销

### 示例 2：老客户回访

**输入**：
- user_intent: "好久没联系老客户了，帮我发几句话约他们来打球"
- role: manager
- target_customer_type: old
- output_package: ["private_chat", "moments", "execution_tips"]

**应选样例**：
- 优先：老客户回访样例（角色=店长、客户=老客户）
- 可选：大客户维护样例（角色兼容）
- 不选：团购核销、助教推广、赛事战报

### 示例 3：团购客加微信

**输入**：
- user_intent: "今天来了几个团购客，想加他们微信后面方便喊他们来打球"
- role: frontdesk
- target_customer_type: groupbuy
- output_package: ["private_chat", "sop_checklist", "execution_tips"]

**应选样例**：
- 优先：C07（团购客加微信，role=frontdesk, customer=groupbuy）
- 可选：新客加微信类样例
- 不选：老客户回访、助教PK

### 示例 4：陪玩转译

**输入**：
- user_intent: "客户说想找人陪玩，我怎么回得专业一点"
- role: frontdesk
- target_customer_type: new
- output_package: ["private_chat", "execution_tips"]

**应选样例**：
- 优先：口语转译 + 前厅助教问询类样例
- risk_tag 匹配：口语转译 → 加分
- 不选：赛事、PK、老客户

### 示例 5：助教 PK

**输入**：
- user_intent: "这个月想搞个助教PK，帮我设计一下规则"
- role: assistant_manager
- target_customer_type: assistant
- output_package: ["pk_plan", "execution_tips"]

**应选样例**：
- 优先：助教PK类样例（但注意不能选"总奖金拆分"类样例——那是反例）
- 注意：如果有反例 C06（PK总奖金被拆），当前不注入反例，依赖 baseline_rules 规则 13 拦截

### 示例 6：赛后战报

**输入**：
- user_intent: "昨晚周赛打完了，帮我写个赛后战报"
- role: coach
- target_customer_type: competition
- output_package: ["moments", "group_notice", "poster_copy"]

**应选样例**：
- 优先：C15（赛后战报，role=coach, customer=competition）
- 可选：赛事类相关样例
- 不选：助教、前厅、老客户

### 示例 7：模糊需求（匹配不到）

**输入**：
- user_intent: "帮我弄点能用的东西"
- role: manager
- target_customer_type: all
- output_package: []

**选择结果**：匹配不到高相关度样例（输入太模糊）。触发降级策略：不注入 few-shot，只用 baseline_rules 模糊需求简版输出规则（规则32）生成。

### 示例 8：新助教到店 + 老客户邀约

**输入**：
- user_intent: "新助教今天到店，想喊几个老客户回来打球"
- role: assistant_manager
- target_customer_type: old
- output_package: ["moments", "private_chat", "execution_tips"]

**选择过程**：
1. role 匹配 assistant_manager
2. customer_type 匹配 old（兼容 vip）
3. 关键词：新助教 + 老客户 → scene_tags 助教到店通知 + 老客户回访
4. 取 2 条分别匹配助教到店和老客户回访的样例

**应选样例**：
- 优先：助教到店通知样例 + 老客户回访样例（各1条）
- 不选：纯助教PK、纯赛事

### 示例 9：免费助教拦截

**输入**：
- user_intent: "帮我写个活动，新客户免费体验助教一次"
- role: operator
- target_customer_type: new
- output_package: ["activity_plan", "moments"]

**选择过程**：
1. risk_tag 匹配：免费助教拦截 → 加分
2. 如无匹配样例：不注入正例，依赖 baseline_rules 规则 29 拦截

### 新增场景选择策略（10G-4）

#### 会员群场景
- 会员群场景优先选择 member_group / group_notice / old_customer_recall 相关样例
- 当 user_intent 包含"会员群"关键词时，优先筛选 scene_tags 含 member_group 的样例
- 避免选择 competition_group / groupbuy / new 类样例作为会员群场景的主样例
- 会员群相关风险标签（unknown_member_benefit, unknown_member_discount）匹配时加分

#### 竞技群场景
- 竞技群场景优先选择 competition_group / tournament / light_competition / group_notice 相关样例
- 当 user_intent 包含"竞技群""约局""缺一位"等关键词时，优先筛选 scene_tags 含 competition_group 的样例
- 避免选择 member_group / assistant_customer_group 类样例作为竞技群场景的主样例
- 竞技群相关风险标签（competition_gambling_wording, score_chasing_wording）匹配时加分

#### 桌型场景
- 根据 user_intent 中的桌型关键词选择对应标签样例：joy_billiards_table / snooker_table / duya_pool_table / normal_pool_table
- 未提供桌型时，不应通过 few-shot 引导模型编桌型——避免选择含桌型信息的样例
- 桌型相关风险标签（unknown_table_type, unknown_new_equipment）匹配时加分

---

### 示例 10：大客户单独约访

**输入**：
- user_intent: "有个大客户好久没来了，想单独约一下，别太刻意"
- role: boss
- target_customer_type: vip
- output_package: ["private_chat", "execution_tips"]

**应选样例**：
- 优先：C12（大客户单独约访，role=boss, customer=vip）
- 可选：老客户回访样例（customer 兼容）
- 不选：团购核销、助教PK、赛事战报

---

*选择策略设计完成。供 10F-2 代码实现参考。*
