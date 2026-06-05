# 10F-2 轻量 Few-shot 选择器接入报告

> 生成时间：2026-05-12
> 任务编号：10F-2
> 任务名称：Workbench 轻量 Few-shot 选择器最小接入
> 前置依赖：10F-1.5 样例覆盖补齐

---

## 1. 本次任务目标

基于 10F-1.5 完成的结构化样例库（15 条 suitable_for_fewshot: true），在 Workbench 生成链路中接入轻量 few-shot 选择器。

每次 Workbench 请求时，根据 role / customer_type / output_package / user_intent 自动选择最多 2 条最相关优质样例，注入到 free_intent Prompt 中，帮助 DeepSeek 更稳定地生成行业化内容。

不注入反例，不影响旧 4 个生成 Tab，可降级。

---

## 2. 实际新增 / 修改文件

| # | 文件 | 操作 | 说明 |
|---|------|------|------|
| 1 | `server/services/workbench_fewshot_service.py` | **新增** | 轻量 few-shot 选择器（~180 行） |
| 2 | `server/services/content_service.py` | **修改** | 新增 1 行 import + ~12 行 few-shot 调用逻辑（仅 generate_workbench） |
| 3 | `server/prompts/workbench/free_intent.yaml` | **修改** | 新增 `fewshot_examples` 变量 + 模板中注入位置（+1 变量 +1 行） |

**未修改的文件**：
- `server/services/ai/prompt_engine.py` — 不动
- `server/schemas/generate.py` — 不动
- `server/api/v1/generate.py` — 不动
- `server/models/` — 不动
- 全部前端文件 — 不动
- 旧 4 个 Tab 的 service 方法（generate_copywriting / generate_activity / generate_operation）— 不动

---

## 3. 选择器实现说明

### 3.1 样例加载

`_load_examples()` 从 `docs/product-brain/workbench-结构化优质样例库.yaml` 加载全部样例，过滤条件：
- `suitable_for_fewshot == true`
- `injection_style == "short_snippet"`

15 条样例进入候选池。文件不存在或解析失败时返回空列表，不报错。

### 3.2 打分策略

`_score_example()` 对每条样例打分：

| 匹配维度 | 分值 | 说明 |
|---------|------|------|
| role 完全匹配 | +3 | 核心匹配键 |
| customer_type 完全匹配 | +3 | 核心匹配键 |
| customer_type = all | +1 | 通用样例可用但非最优 |
| output_package 交集 | 每个 +1，最多 +3 | 次匹配键 |
| user_intent keyword → scene_tag 匹配 | +2 | 关键词字典映射 |
| 助教服务体验型关键词 → 优先 assistant_service_experience 等标签 | +2 | 助教场景分类 |
| 技术陪练型关键词 → 优先 technical_assistant 等标签 | +2 | 助教场景分类 |
| risk_tags 存在 | +1 | 边界场景加分 |
| priority P0/P1 | +1 | 高质量样例优先 |

### 3.3 最多 2 条

`select_workbench_fewshots()` 参数 `max_examples=2`，按分数降序取前 2 条，且分数必须 > 0。

### 3.4 助教服务体验型 vs 技术陪练型

通过两套关键词字典自动判断：

- **服务体验型关键词**（15 个）：美女助教、好看的助教、点助教、陪玩、陪打、新助教、今日助教可约、助教服务、情绪价值、服务体验、氛围、轻松、到店可约、一个人来、想约助教
- **技术陪练型关键词**（10 个）：练球、提升、技术、指导、纠正动作、陪练、动作、球技、水平、训练

命中服务体验型关键词时，优先匹配 `assistant_service_experience` / `assistant_booking` / `assistant_service` / `new_assistant` / `assistant_arrival` 标签的样例。

命中技术陪练型关键词时，优先匹配 `technical_assistant` / `assistant_service` 标签的样例。

### 3.5 降级策略

以下情况全部静默降级（返回空字符串，Workbench 正常生成）：

- YAML 文件不存在
- YAML 解析失败
- 候选池为空
- 所有样例分数 = 0
- 选择器内部任何异常

在 generate_workbench() 中，选择器调用包装在 try/except 中，确保异常不影响主流程。

---

## 4. Prompt 注入方式

### 4.1 注入变量名

`fewshot_examples`（字符串类型，为空时渲染为空白，不产生多余输出）

### 4.2 注入位置

在 free_intent.yaml 中，`{fewshot_examples}` 放置在：
- **之后**：用户需求（role_label / target_customer_label / user_intent 等）
- **之前**：输出结构（严格遵守）

确保样例不会覆盖基线规则，也不干扰输出格式约束。

### 4.3 注入格式

```
## 可参考的优质写法（仅供参考，以下铁规优先）
以下样例只用于参考台球房运营内容的表达方式和行业语气。
不要照抄样例中的具体事实、金额、姓名、门店活动信息。

**参考样例1**（场景：old_customer_recall、private_chat、wechat_moments）
用户需求：好久没联系老客户了，帮我发几句话约他们来打球
参考写法：好久没见你来打球了，最近忙啥呢？有空回来打两把...
可复用原则：
  - 老客户回访的节奏控制：分批发、隔天跟进

**注意**：以上样例仅供风格参考。本次生成仍需严格遵守所有基线规则和场景约束。
```

### 4.4 安全措施

- 明确声明"仅供参考，铁规优先"
- 明确声明"不要照抄具体事实、金额、姓名、门店活动信息"
- 每条样例控制在 max_injection_chars 内
- 最多 2 条
- 不包含反例错误输出
- 不包含 suitable_for_fewshot: false 的样例

---

## 5. 是否影响旧 4 个 Tab

**否。** 本次修改仅影响 Workbench 生成路径：

- `generate_workbench()` 新增 few-shot 选择调用
- `generate_copywriting()` / `generate_activity()` / `generate_operation()` 完全未修改
- API 路由未修改
- 前端未修改

---

## 6. 是否修改数据库

**否。** 本次接入未涉及任何数据库操作。

---

## 7. 是否修改 PromptEngine

**否。** PromptEngine 通过 extra_vars 字典接收 `fewshot_examples` 变量，与现有 baseline_rules / role_rules / customer_rules 的传递方式完全一致，无需修改 PromptEngine 代码。

---

## 8. 是否调用 DeepSeek

**否。** 本次接入仅做静态检查和选择器单元测试，未发起任何 API 调用。

原因：10F-2 任务是"最小接入"，重点是验证选择器逻辑正确性、Prompt 注入格式正确性、降级机制有效性。真实 DeepSeek 调用和效果评估留到 10F-3。

---

## 9. 静态检查结果

| 检查项 | 结果 |
|--------|------|
| `workbench_fewshot_service.py` Python 编译 | ✅ 通过 |
| `content_service.py` Python 编译 | ✅ 通过 |
| `free_intent.yaml` YAML 语法 | ✅ 通过 |
| `workbench-结构化优质样例库.yaml` YAML 语法 | ✅ 通过 |
| 样例加载（15 条 suitable） | ✅ 通过 |
| 老客户回访场景选择 | ✅ 选中相关样例（546 chars） |
| 美女助教场景选择 | ✅ 选中相关样例（565 chars） |
| 无匹配场景降级 | ✅ 不报错，返回空 |
| PromptEngine 加载（23 templates） | ✅ 通过 |
| free_intent + fewshot 渲染 | ✅ 3516 chars（参考样例文本出现在输出中） |
| free_intent 无 fewshot 渲染 | ✅ 3501 chars（正常渲染，无多余输出） |
| baseline_rules 渲染 | ✅ 4018 chars（不受影响） |
| 前端未修改 | ✅ 确认 |
| 数据库未修改 | ✅ 确认 |
| 未调用 DeepSeek | ✅ 确认 |

**综合结论**：全部静态检查通过。

---

## 10. 小样本测试结果

**未执行真实 DeepSeek 调用。** 原因：10F-2 任务目标是最小接入验证，不要求真实调用测试。

### 建议 10F-3 人工回归测试用例（8 条）

| # | user_intent | role | customer | output_package | 预期命中的 few-shot |
|---|------------|------|----------|---------------|-------------------|
| 1 | 好久没联系老客户了，帮我发几句话约他们来打球 | manager | old | private_chat, moments, execution_tips | G010 老客户回访约球 |
| 2 | 今天美女助教到了，帮我发朋友圈 | assistant_manager | assistant | moments, execution_tips | G002 助教短视频配文 / G004 助教群提醒 |
| 3 | 有客户说想点助教，我怎么回 | assistant_manager | assistant | private_chat, execution_tips | G002 助教短视频配文 |
| 4 | 团购客第一次来，问有没有助教可以约 | frontdesk | groupbuy | private_chat, execution_tips | G001 团购客加微信 / G015 前厅加微信 |
| 5 | 助教拍了条短视频，帮我配文案 | assistant_manager | assistant | short_video, moments | G002 助教短视频配文 |
| 6 | 最近朋友圈发太少，帮我规划这周发什么 | operator | all | moments, short_video, execution_tips | G022 本周内容规划 |
| 7 | 这个月想搞个助教PK，帮我设计 | assistant_manager | assistant | pk_plan, execution_tips | G025 助教PK方案（但 suitable=false 不会选中，走降级） |
| 8 | 帮我写今天的店长日报 | manager | all | daily_report, execution_tips | G023/G024 均为 false，走降级，规则约束日报格式 |

---

## 11. 当前风险

| 风险 | 等级 | 说明 |
|------|------|------|
| few-shot 可能带偏模型 | 中 | 样例输出片段可能让模型忽略基线规则中的禁止项。已通过在注入文本中声明"铁规优先""不要照抄事实"来缓解 |
| 样例覆盖仍然有限 | 中 | 15 条 true 样例覆盖 6 个 role × 8 个 customer_type × 10 个 output_package 的组合有限。边缘组合匹配不到样例时走降级 |
| 长方案类不适合注入 | 低 | 已在 10F-1.5 中将 daily_report/pk_plan/长方案标记为 false，不会注入 |
| 反例暂未运行时接入 | 低 | baseline_rules 已覆盖大部分反例规则。10F-3 可评估是否注入反例规则摘要 |
| 关键词字典需维护 | 低 | 当前 ~70 个关键词映射 ~30 个 scene_tag。后续新增场景需同步更新字典 |
| 无真实调用验证 | 中 | 选择器逻辑通过单元测试，但实际注入后 DeepSeek 输出效果未验证。10F-3 应做小样本调用测试 |

---

## 12. 是否建议进入 10F-3

**建议进入 10F-3，但需先做真实调用小样本测试。**

10F-3 建议任务：
1. **8 条小样本真实调用测试**：用上述 8 条测试用例真实调用 DeepSeek，对比有无 few-shot 的输出差异
2. **few-shot 命中率统计**：检查选择器在典型场景下是否选到了相关样例
3. **输出质量评估**：重点检查"是否照抄样例事实""是否忽略基线规则""是否专业转译行业口语"
4. **选择器微调**：如分数权重或关键词字典需要调整，在 10F-3 中修正

如果小样本测试稳定，可继续做：
- 10F-3.5：反例规则摘要运行时注入（仅注入一句话规则，不注入错误全文）
- 10F-4：真实球房观察样例补充（从实际使用中沉淀新样例）

---

*报告完成。10F-2 轻量 Few-shot 选择器最小接入任务执行完毕。*
