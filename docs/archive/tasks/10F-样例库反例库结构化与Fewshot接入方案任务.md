# 10F：样例库 / 反例库结构化与 Few-shot 接入方案任务

## 任务定位

你现在只负责【10F：样例库 / 反例库结构化与 Few-shot 接入方案】。

本任务基于 10D / 10E / 10F-0 / 10F-0.5 已完成的成果，设计“如何把优质样例、反例库、行业术语规则真正接入 Prompt 生成链路”。

本任务只做方案设计与代码/Prompt阅读，不做代码修改，不做 YAML 修改，不调用 DeepSeek。

---

## 一、任务背景

当前项目已完成：

1. 10D：AI 工作台 / Workbench 自由输入入口
2. 10D-2：150 条 Workbench 暴力组合测试
3. 10D-3：强约束 Prompt 修复
4. 10D-4：30 条强约束回归测试
5. 10E：AI 工作台前端产品化
6. 10E-1 / 10E-1.5：快捷场景、示例、输出类型分组、布局优化
7. 10E-2：生成结果体验与历史记录优化
8. 10E-2.5 / 10E-2.6：老客户回访、新助教边界修正
9. 10F-0：产品大脑链路校准
10. 10F-0.5：Prompt YAML 同步补丁

现在进入正式 10F。

10F 的目标不是继续堆规则，而是设计一套更可持续的样例库 / 反例库 / few-shot 接入机制，让系统以后能：

- 根据用户场景选择少量相关优质样例
- 避免重复犯反例库里的典型错误
- 不把样例库全文塞进 Prompt
- 控制 Prompt 长度、成本和稳定性
- 支撑后续真实球房观察资料反哺

---

## 二、严禁事项

严禁：

1. 不要修改前端代码
2. 不要修改后端代码
3. 不要修改数据库
4. 不要创建迁移
5. 不要修改 Prompt YAML
6. 不要修改 PromptEngine
7. 不要修改 AI Provider
8. 不要调用 DeepSeek
9. 不要读取 `.env`
10. 不要输出 API Key
11. 不要直接把样例库全文塞进 Prompt
12. 不要做正式 few-shot 编码
13. 不要跑测试
14. 不要删除文件

允许：

1. 阅读 docs/product-brain 文档
2. 阅读 10D / 10E / 10F 报告
3. 阅读现有 Prompt / rules / service 代码
4. 设计结构化样例库方案
5. 设计 few-shot 选择策略
6. 设计反例库使用策略
7. 输出实施方案和后续编码任务建议

---

## 三、必须阅读的文档

请先阅读以下文档，不要只看摘要。

### 产品大脑与规则

1. `docs/product-brain/台球房AI运营工作台-产品大脑.md`
2. `docs/product-brain/台球房岗位场景库.md`
3. `docs/product-brain/Prompt规则库.md`
4. `docs/product-brain/助教业务规则库.md`
5. `docs/product-brain/行业术语白名单与风险词转译规则.md`
6. `docs/product-brain/workbench-优质样例库.md`
7. `docs/product-brain/workbench-反例库.md`

### 测试与阶段报告

8. `docs/reports/10D-2-Workbench150条暴力组合测试报告.md`
9. `docs/reports/10D-4-Workbench强约束回归测试报告.md`
10. `docs/reports/10E-2-生成结果体验与历史记录优化报告.md`
11. `docs/reports/10F-0-产品大脑链路校准报告.md`
12. `docs/reports/10F-0.5-PromptYAML同步补丁报告.md`

### 现有任务文档

13. `docs/tasks/10D-4-Workbench强约束回归测试用例.md`
14. `docs/tasks/10E-Workbench验收测试方案.md`

如某些文档不存在，请在报告中说明，不要中断任务。

---

## 四、必须阅读的代码 / Prompt

只读，不改。

### 后端

1. `server/services/content_service.py`
2. `server/prompts/workbench/free_intent.yaml`
3. `server/prompts/rules/baseline_rules.yaml`
4. `server/prompts/rules/role/*.yaml`
5. `server/prompts/rules/customer/*.yaml`
6. `server/schemas/generate.py`

### 前端配置

7. `web/src/lib/workbench-config.ts`

重点判断：

- 当前 Prompt 是如何组合 baseline / role / customer / free_intent 的
- 当前有没有动态样例注入机制
- 当前 WorkbenchRequest 保存了哪些字段
- 样例选择可以基于哪些字段：role / customer_type / output_package / user_intent / extra_note
- 是否适合先做静态结构化样例库，而不是直接接入运行时
- 后续接入会不会导致 Prompt 过长

---

## 五、10F 重点分析问题

### 1. 样例库现在的问题

请分析现有 `workbench-优质样例库.md` 是否适合直接作为 few-shot。

重点判断：

- 样例是否结构化
- 是否有 role / customer_type / output_package
- 是否有用户输入
- 是否有 AI 输出摘要或全文
- 是否有“为什么好”
- 是否适合机器选择
- 是否存在过长、过旧、质量不稳的问题

### 2. 反例库现在的问题

请分析 `workbench-反例库.md` 的使用方式。

重点判断：

- 反例适合放进运行时 Prompt 吗？
- 反例更适合做回归测试，还是少量作为禁用规则？
- 哪些反例可以转成规则
- 哪些反例可以转成测试用例
- 哪些反例不应进入生成时 Prompt，避免 Prompt 变长

### 3. Few-shot 接入是否应该现在做

请明确判断：

- 10F 是否直接编码接入 few-shot
- 还是先做结构化样例库
- 是否先做“手动选择 top 2-3 个样例”的方案
- 是否需要向量检索
- 当前是否不应该引入复杂检索系统

### 4. 样例选择策略

请设计基于以下字段的选择策略：

- role
- target_customer_type
- output_package
- user_intent 关键词
- extra_note
- 场景标签
- 风险标签

例如：

用户输入：今天美女助教到了，帮我发朋友圈  
role：assistant_manager  
customer_type：assistant  
output_package：moments + private_chat  

应优先选择：

- 助教到店通知样例
- 助教服务推广样例
- 行业口语专业转译样例

不要选择：

- 周赛样例
- 前厅核销样例
- 老客户回访样例

### 5. Prompt 长度控制

必须设计限制：

- 每次最多注入几个优质样例
- 每个样例最多多少字
- 是否只注入“用户输入 + 推荐输出片段 + 规则提示”
- 是否只注入摘要而不是全文
- 如何避免超过 token 预算
- 如何避免样例覆盖主规则

建议重点考虑：

- 每次最多 2-3 个相关正例
- 每次最多 1 个反例提示，且只放“不要这样写”的规则摘要
- 优先注入短样例，不注入长方案

### 6. 反例库使用策略

请区分：

#### 运行时 Prompt 中使用

只放：

- 高风险反例规则摘要
- 不放大量错误输出全文
- 不让模型模仿错误文本

#### 回归测试中使用

可以放：

- 完整反例
- 错误类型
- 正确处理方式
- 检查标准

#### 产品大脑中使用

用于沉淀长期规则。

---

## 六、建议输出方案

请设计 10F 分两步走：

### 10F-1：样例库 / 反例库结构化

目标：

- 把现有 Markdown 样例库整理成更适合机器读取的结构
- 可以先用 Markdown 表格或 YAML/JSON 文档
- 不接入运行时 Prompt
- 不改代码

建议新增文档：

- `docs/product-brain/workbench-结构化优质样例库.md`
- `docs/product-brain/workbench-结构化反例库.md`
- `docs/product-brain/workbench-fewshot选择策略.md`

### 10F-2：轻量 few-shot 接入

目标：

- 在不改 PromptEngine 大架构的前提下，设计或实现轻量选择机制
- 每次根据 role / customer / output_package / intent 选择少量样例
- 注入 free_intent Prompt
- 控制长度
- 做小样本测试

但本任务只设计，不执行 10F-2。

---

## 七、输出文档

请生成以下 3 份文档。

### 文档 1：10F 实施方案

路径：

`docs/tasks/阶段10F-样例库反例库结构化与Fewshot接入方案.md`

必须包含：

1. 10F 阶段定位
2. 当前样例库 / 反例库现状
3. 是否建议直接接入 few-shot
4. 样例库结构化方案
5. 反例库结构化方案
6. few-shot 选择策略
7. Prompt 长度控制方案
8. 反例库运行时使用边界
9. 10F-1 / 10F-2 分阶段执行建议
10. 文件修改清单
11. 是否需要数据库迁移
12. 是否需要修改 PromptEngine
13. 是否需要调用 DeepSeek
14. 风险评估
15. 验收标准
16. 是否建议开始 10F-1

### 文档 2：Few-shot 样例选择策略

路径：

`docs/product-brain/workbench-fewshot选择策略.md`

必须包含：

1. 样例标签体系
2. role 匹配规则
3. customer_type 匹配规则
4. output_package 匹配规则
5. user_intent 关键词匹配规则
6. 风险标签匹配规则
7. 样例数量限制
8. 样例长度限制
9. 正例 / 反例使用策略
10. 10 个选择示例

### 文档 3：10F 方案设计完成报告

路径：

`docs/reports/10F-方案设计完成报告.md`

必须包含：

1. 阅读了哪些文档和代码
2. 生成了哪些文档
3. 是否修改代码：必须为否
4. 是否修改 YAML：必须为否
5. 是否修改数据库：必须为否
6. 是否调用 DeepSeek：必须为否
7. 是否建议进入 10F-1
8. 是否建议 10F-1 只做结构化，不做运行时接入
9. 最大风险
10. 下一步建议

---

## 八、输出要求

完成后只回复：

1. 10F 实施方案路径
2. Few-shot 样例选择策略路径
3. 10F 方案设计完成报告路径
4. 是否修改代码：必须为否
5. 是否修改 YAML：必须为否
6. 是否修改数据库：必须为否
7. 是否调用 DeepSeek：必须为否
8. 是否建议进入 10F-1
9. 10F-1 是否只做结构化
10. 是否建议暂缓运行时 few-shot 接入
