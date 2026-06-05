# 10F-2：Workbench 轻量 Few-shot 选择器最小接入任务

## 任务定位

你现在只负责【10F-2：Workbench 轻量 Few-shot 选择器最小接入】。

本任务基于 10F / 10F-1 / 10F-1.5 已完成的结构化样例库，做一个“安全、最小、可回滚”的运行时 few-shot 接入。

本任务只接入 Workbench / AI 工作台，不影响旧 4 个生成 Tab。

目标不是大规模提高所有生成质量，而是让 Workbench 在典型场景下能根据 role / customer_type / output_package / user_intent 选择少量相关优质样例，帮助 DeepSeek 更稳定地生成行业化内容。

---

## 一、前置背景

已完成：

1. `docs/tasks/阶段10F-样例库反例库结构化与Fewshot接入方案.md`
2. `docs/product-brain/workbench-fewshot选择策略.md`
3. `docs/product-brain/workbench-结构化优质样例库.yaml`
4. `docs/product-brain/workbench-结构化反例库.yaml`
5. `docs/product-brain/workbench-样例标签字典.yaml`
6. `docs/reports/10F-1.5-样例覆盖补齐与Fewshot可用性校准报告.md`

10F-1.5 已确认：

- 优质样例共 26 条
- `suitable_for_fewshot: true` 共 15 条
- `suitable_for_fewshot: false` 共 11 条
- operator / daily_report / pk_plan 覆盖已补齐
- true 样例均为 `short_snippet`
- 日报 / PK / 长方案类大多是 `rule_only` 或 `not_runtime`

---

## 二、本轮核心原则

### 必须遵守

1. 只从 `suitable_for_fewshot: true` 的样例中选择。
2. 每次最多注入 2 条正例。
3. 不注入反例全文。
4. 反例库本轮不做运行时注入，最多读取其规则用于方案判断；如果实现复杂，则完全不接反例。
5. 不引入向量检索。
6. 不引入复杂 rerank。
7. 不改数据库。
8. 不改 PromptEngine 大架构。
9. 不影响旧 4 个 Tab。
10. 接入必须可关闭 / 可降级。
11. 如果样例库读取失败，Workbench 必须继续正常生成，只是不带 few-shot。

### 特别注意助教场景

助教场景必须区分：

#### 服务体验型助教

适用关键词：

- 美女助教
- 好看的助教
- 点助教
- 陪玩
- 陪打
- 新助教
- 今日助教可约
- 助教服务
- 情绪价值
- 服务体验
- 氛围

优先选择带有以下标签的样例：

- `assistant_service_experience`
- `assistant_booking`
- `assistant_service`
- `new_assistant`
- `assistant_arrival`

#### 技术陪练型 / 高级助教

适用关键词：

- 练球
- 提升
- 技术
- 指导
- 教练
- 陪练
- 动作
- 球技

优先选择带有以下标签的样例：

- `technical_assistant`
- `assistant_service`

不要让“专业陪练 / 技术指导”样例带偏所有普通助教推广场景。

---

## 三、严禁事项

严禁：

1. 不要修改前端页面
2. 不要修改数据库
3. 不要创建迁移
4. 不要修改 AI Provider
5. 不要重构 PromptEngine
6. 不要改旧 4 个 Tab 的业务逻辑
7. 不要调用 DeepSeek 做大规模测试
8. 不要读取 `.env`
9. 不要输出 API Key
10. 不要把 26 条样例全部塞进 Prompt
11. 不要注入 `suitable_for_fewshot: false` 的样例正文
12. 不要注入反例错误全文
13. 不要接入向量数据库
14. 不要引入新后端服务
15. 不要做 10G / 岗位工作台功能

允许：

1. 阅读结构化样例库 YAML
2. 新增轻量 few-shot 选择器
3. 修改 Workbench 生成逻辑以传入少量 few-shot 内容
4. 小范围修改 `free_intent.yaml` 以接收 few-shot 变量
5. 新增单元/静态检查脚本
6. 做 5-8 条小样本 Workbench 调用测试，如当前项目已有可用测试方式且不会泄露 API Key
7. 生成 Markdown 报告

---

## 四、必须阅读的文件

请先阅读，不要直接开改：

### 方案 / 样例

1. `docs/reports/10F-1.5-样例覆盖补齐与Fewshot可用性校准报告.md`
2. `docs/product-brain/workbench-结构化优质样例库.yaml`
3. `docs/product-brain/workbench-结构化反例库.yaml`
4. `docs/product-brain/workbench-样例标签字典.yaml`
5. `docs/product-brain/workbench-fewshot选择策略.md`
6. `docs/tasks/阶段10F-样例库反例库结构化与Fewshot接入方案.md`

### 后端代码 / Prompt

7. `server/services/content_service.py`
8. `server/prompts/workbench/free_intent.yaml`
9. `server/prompts/rules/baseline_rules.yaml`
10. `server/schemas/generate.py`
11. `server/api/v1/generate.py`

如某些文档不存在，请记录，不要中断任务。

---

## 五、建议实现范围

### 1. 新增轻量选择器文件

建议新增：

`server/services/workbench_fewshot_service.py`

或者如果项目更适合放 utils，可自行选择，但报告要说明原因。

该文件负责：

1. 加载 `docs/product-brain/workbench-结构化优质样例库.yaml`
2. 过滤 `suitable_for_fewshot: true`
3. 根据请求字段打分
4. 返回最多 2 条样例
5. 格式化成短文本，供 Prompt 注入

### 2. 选择器输入

建议函数：

```python
select_workbench_fewshots(
    role: str,
    target_customer_type: str,
    output_package: list[str],
    user_intent: str,
    extra_note: str | None = None,
    max_examples: int = 2,
) -> list[dict]
```

### 3. 打分策略

基础打分建议：

- role 完全匹配：+3
- target_customer_type 完全匹配：+3
- output_package 命中一个：+1，最多 +3
- user_intent 命中 scene keyword：+2
- user_intent 命中助教服务体验关键词：优先 `assistant_service_experience`
- user_intent 命中技术陪练关键词：优先 `technical_assistant`
- risk_tags 与场景相关：+1
- priority P0/P1：+1
- snippet 过长或 injection_style 不是 `short_snippet`：不得入选

要求：

1. 不需要复杂 NLP。
2. 不需要向量检索。
3. 可以用简单关键词字典。
4. 选择结果必须稳定、可解释。

### 4. 样例格式化

Prompt 中建议格式：

```text
【可参考的优秀写法】
以下样例只用于参考表达方式，不要照抄具体事实、金额、姓名、活动信息。

样例1：
用户需求：xxx
适用场景：xxx
参考写法：
xxx

可复用原则：
- xxx
- xxx
```

注意：

- 明确“不要照抄具体事实”
- 不要把样例变成门店事实
- 每条样例控制在 max_injection_chars 内
- 最多 2 条

### 5. 修改 Workbench 生成逻辑

在 `server/services/content_service.py` 的 `generate_workbench()` 中：

1. 根据 WorkbenchRequest 选择 few-shot
2. 格式化为 `fewshot_examples` 或类似变量
3. 传给 `free_intent.yaml`
4. 如果选择器报错，捕获异常并继续生成，不带 few-shot
5. 把选中的样例 id 可以记录在日志或 input_params 中，但不要改数据库结构。如 input_params 已保存请求参数，是否记录 fewshot ids 请谨慎；不需要强行记录。

### 6. 修改 free_intent.yaml

小范围新增一个可选段落：

```jinja
{% if fewshot_examples %}
{{ fewshot_examples }}
{% endif %}
```

放在合适位置：

- 在角色/客户/规则之后
- 在最终任务生成要求之前
- 不要覆盖强约束规则
- 不要放在最前面，避免样例压过规则

### 7. 可降级

如果：

- YAML 文件不存在
- YAML 解析失败
- 没有匹配样例
- 选择器异常

则：

- 不报错
- Workbench 正常生成
- fewshot_examples 为空

---

## 六、反例库本轮处理边界

本轮不接反例库到运行时 Prompt。

原因：

1. 反例错误文本容易污染输出。
2. 反例更适合回归测试。
3. 当前 baseline rules 已覆盖大多数风险。
4. 10F-2 先验证正例注入是否稳定。

可以在报告中说明：

- 反例库仍用于 10F-3 回归测试设计
- 后续如需运行时反例，只注入 rule summary，不注入错误输出全文

---

## 七、测试要求

完成后必须执行：

### 后端静态检查

根据项目当前工具选择可用命令，例如：

```bash
cd server
uv run python -m py_compile services/workbench_fewshot_service.py
uv run python -m py_compile services/content_service.py
```

如果项目有 pytest，可运行相关轻量测试。

### PromptEngine 加载检查

确认：

- `free_intent.yaml` 能正常加载
- 新增变量缺失时不会报错
- fewshot_examples 为空时能正常渲染

### 前端检查

如果未修改前端，可不跑前端 build。  
但如果你改动了前端，必须执行：

```bash
cd web
npx tsc --noEmit
pnpm lint
pnpm build
```

### 小样本测试

如果本地具备 API Key 且当前项目允许调用，可以做最多 5-8 条 Workbench 小样本真实调用。

如果不能调用 DeepSeek，请说明未调用原因，不要伪造结果。

建议测试场景：

1. 老客户回访
2. 美女助教到了，发朋友圈
3. 有客户说想点助教，我怎么回
4. 团购客第一次来，问有没有助教可以约
5. 助教拍了条短视频，帮我配文案
6. 本周内容规划
7. 助教 PK
8. 日报/汇报

重点检查：

- 是否选到相关 few-shot
- 输出是否更贴近行业表达
- 是否没有照抄样例事实
- 是否没有输出低俗擦边
- 是否没有乱编优惠/价格/姓名

---

## 八、输出报告

请生成：

`docs/reports/10F-2-轻量Fewshot选择器接入报告.md`

报告必须包含：

### 1. 本次任务目标

说明只做 Workbench 轻量 few-shot 接入，不影响旧 4 个 Tab。

### 2. 实际新增 / 修改文件

逐个列出。

### 3. 选择器实现说明

说明：

- 样例如何加载
- 如何过滤 suitable_for_fewshot
- 如何打分
- 如何限制最多 2 条
- 如何处理助教服务体验型 vs 技术陪练型
- 如何降级

### 4. Prompt 注入方式

说明：

- 注入变量名
- 注入位置
- 最大样例数量
- 是否包含反例
- 如何避免照抄事实

### 5. 是否影响旧 4 个 Tab

必须明确回答。

### 6. 是否修改数据库

必须为否。

### 7. 是否修改 PromptEngine

必须为否。

### 8. 是否调用 DeepSeek

说明是否调用。  
如果调用，列出测试数量和结果。  
如果未调用，说明原因。

### 9. 静态检查结果

列出：

- Python 编译 / 类型检查结果
- PromptEngine 加载结果
- YAML 读取结果
- 如有前端检查，也列出

### 10. 小样本测试结果

如果执行了真实调用，列出每条：

- user_intent
- role
- customer
- output_package
- 命中的 few-shot id
- 简评
- 是否通过

如果未真实调用，列出建议测试用例。

### 11. 当前风险

必须说明：

- few-shot 可能带偏模型
- 样例覆盖仍然有限
- 长方案类不适合注入
- 反例暂未运行时接入
- 后续真实球房观察样例需要补充

### 12. 是否建议进入 10F-3

建议：

- 如果接入稳定，进入 10F-3：小样本回归测试 / few-shot 效果评估
- 如果不稳定，先做 10F-2.5 调整选择器

---

## 九、完成后只回复

完成后只回复：

1. 报告路径
2. 新增 / 修改了哪些文件
3. 是否新增 few-shot 选择器
4. 每次最多注入几条样例
5. 是否只使用 suitable_for_fewshot=true
6. 是否注入反例：必须为否
7. 是否影响旧 4 个 Tab：必须为否
8. 是否修改数据库：必须为否
9. 是否修改 PromptEngine：必须为否
10. 是否调用 DeepSeek，如调用，调用几条
11. 静态检查是否通过
12. 是否建议进入 10F-3
