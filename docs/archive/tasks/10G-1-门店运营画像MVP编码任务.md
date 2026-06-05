# 10G-1：门店运营画像 MVP 编码任务

## 任务定位

你现在只负责【10G-1：门店运营画像 MVP 编码】。

本任务基于 10G-0 方案执行，把“门店资料”升级为可被 AI 使用的“门店运营画像 / 门店大脑”第一版。

本轮只做 MVP 闭环，不做完整 88 字段，不做岗位工作台，不做图片/视频能力。

---

## 一、任务背景

10G-0 已完成方案设计，推荐：

- 在 `stores` 表新增 `operation_profile` JSONB 字段
- 先做 MVP 约 12-15 个关键字段
- 前端在门店资料页增加“AI 运营画像”快速配置
- Workbench 生成时注入门店画像摘要
- 无画像时安全降级

用户补充了重要行业场景：

台球房私域群不只是“客户群”，还包括：

- 客户群
- 会员群
- 竞技群
- 搭子群
- 助教客户群
- 赛事群
- 员工群

其中“会员群”和“竞技群”是必须单独识别的真实运营场景。

会员群主要用于：

- 会员维护
- 老客户复购
- 空台提醒
- 会员活动通知
- 节假日关怀
- 周赛 / 活动提醒
- 助教可约通知

竞技群主要用于：

- 约局
- 竞技客户维护
- 轻竞技活动
- 周赛 / 月赛报名
- 赛后战报
- 找搭子
- 临时缺人补位
- 练球局 / 友谊局

边界：

- 会员群不能乱编会员优惠、充值规则、会员权益、会员专属价格
- 竞技群不能写赌博、追分、大额输赢、搞钱局、高风险对局

---

## 二、严禁事项

严禁：

1. 不要做岗位工作台
2. 不要做 10G-2 / 10H 功能
3. 不要做图片 / 视频能力
4. 不要改 AI Provider
5. 不要改 PromptEngine 大架构
6. 不要调用 DeepSeek
7. 不要读取 `.env`
8. 不要输出 API Key
9. 不要删除文件
10. 不要把 88 个字段全部做成复杂前端表单
11. 不要把客户隐私 / 员工隐私 / 内部经营卡点作为可外显字段
12. 不要把“美女助教 / 点助教 / 陪玩”作为前端默认字段名
13. 不要改变旧 4 个 Tab 的业务逻辑

允许：

1. 新增数据库 migration
2. 修改 Store model / schema / API
3. 修改门店资料页面
4. 修改 Workbench 生成链路，注入门店画像摘要
5. 小范围修改 `free_intent.yaml`，接收 `profile_context`
6. 新增轻量 profile 渲染工具函数 / service
7. 跑后端检查、前端 tsc/lint/build
8. 生成 Markdown 报告

---

## 三、必须阅读的文档和代码

请先阅读以下文件，不要直接开改。

### 方案文档

1. `docs/reports/10G-0-门店运营画像方案设计报告.md`
2. `docs/tasks/阶段10G-0-门店运营画像与资料模块升级方案.md`
3. `docs/product-brain/门店运营画像字段字典.md`
4. `docs/product-brain/台球房AI运营工作台-产品大脑.md`
5. `docs/product-brain/Prompt规则库.md`
6. `docs/product-brain/行业术语白名单与风险词转译规则.md`

### 后端

7. `server/models/store.py`
8. `server/schemas/store.py`
9. `server/api/v1/stores.py`
10. `server/services/content_service.py`
11. `server/prompts/workbench/free_intent.yaml`
12. `server/alembic/versions/` 或项目当前 migrations 目录

### 前端

13. `web/src/app/dashboard/store-settings/page.tsx`
14. `web/src/lib/api.ts`
15. `web/src/types/` 下与 store 相关类型文件，如存在

如某些文件不存在，请记录在报告中，不要中断任务。

---

## 四、本轮 MVP 功能范围

本轮只做 P0：

1. 新增 `stores.operation_profile` JSONB 字段
2. 后端 Store model / schema / API 支持 operation_profile
3. 前端门店资料页增加“AI 运营画像”快速配置区域
4. 支持 MVP 字段保存和回显
5. 支持私域群矩阵字段，必须包含会员群和竞技群
6. Workbench 生成时注入门店运营画像摘要
7. 无画像时安全降级
8. 不影响旧 4 个 Tab
9. 跑后端 / 前端检查
10. 输出编码报告

---

## 五、operation_profile 推荐结构

请使用 JSONB 存储，结构建议如下，可根据项目实际微调：

```json
{
  "basic": {
    "positioning": "",
    "business_district": "",
    "table_count": null,
    "main_selling_points": []
  },
  "business_goals": {
    "current_goals": [],
    "monthly_focus": "",
    "avoid_recommendations": []
  },
  "customer_structure": {
    "main_customer_types": [],
    "target_conversion_types": []
  },
  "private_domain_groups": {
    "customer_group": {
      "enabled": false,
      "purpose": [],
      "tone": "",
      "forbidden_content": []
    },
    "member_group": {
      "enabled": false,
      "purpose": [],
      "tone": "",
      "forbidden_content": []
    },
    "competition_group": {
      "enabled": false,
      "purpose": [],
      "tone": "",
      "forbidden_content": []
    },
    "partner_group": {
      "enabled": false,
      "purpose": [],
      "tone": "",
      "forbidden_content": []
    },
    "assistant_customer_group": {
      "enabled": false,
      "purpose": [],
      "tone": "",
      "forbidden_content": []
    },
    "event_group": {
      "enabled": false,
      "purpose": [],
      "tone": "",
      "forbidden_content": []
    },
    "staff_group": {
      "enabled": false,
      "purpose": [],
      "tone": "",
      "forbidden_content": []
    }
  },
  "assistant_system": {
    "has_assistant": false,
    "assistant_types": [],
    "has_assistant_manager": false,
    "allow_new_assistant_notice": false,
    "allow_today_assistant_available": false,
    "assistant_booking_rule": "",
    "assistant_forbidden_words": []
  },
  "events": {
    "has_weekly_match": false,
    "has_light_competition": false,
    "has_partner_group": false
  },
  "commerce_rules": {
    "has_groupbuy": false,
    "has_membership": false,
    "allow_discount_copy": false,
    "allow_price_copy": false
  },
  "content_style": {
    "moments_tone": "",
    "private_chat_tone": "",
    "group_notice_tone": "",
    "emoji_preference": "",
    "common_phrases": [],
    "forbidden_phrases": []
  },
  "ai_preferences": {
    "default_output_length": "medium",
    "missing_info_strategy": "safe_generate_with_missing_info"
  }
}
```

重点：

- 可以根据当前代码实际类型调整
- MVP 不要求前端展示所有嵌套字段
- 但 JSONB 结构要为后续扩展留空间
- 不要把敏感隐私字段放进去

---

## 六、MVP 前端字段要求

前端“AI 运营画像”快速配置不要做太复杂。

建议展示 12-15 个核心输入，优先用多选 / 单选 / 简短文本。

### 必做字段

1. 门店定位 / 风格
2. 所在商圈 / 区域
3. 主要客户类型，多选
   - 团购客
   - 新客户
   - 老客户
   - 助教客户
   - 竞技客户
   - 轻竞技客户
   - VIP / 大客户
   - 单人练球客户
4. 当前最想提升目标，多选
   - 拉新
   - 老客户回流
   - 团购客转私域
   - 助教预约转化
   - 提升周赛人气
   - 提高朋友圈发布频率
   - 提升前厅转化
   - 提升助教上钟
   - 搭子群活跃
5. 私域群类型，多选，必须包含：
   - 客户群
   - 会员群
   - 竞技群
   - 搭子群
   - 助教客户群
   - 赛事群
   - 员工群
6. 是否有助教
7. 助教类型，多选
   - 服务体验型助教
   - 技术陪练型 / 高级助教
   - 两者都有
8. 是否允许写“新助教到店”
9. 是否允许写“今日助教可约”
10. 是否固定做周赛 / 活动
11. 是否做团购
12. 朋友圈语气
13. 是否允许写优惠
14. 是否允许写电话 / 地址
15. 禁用表达，多选 / 文本

### 私域群矩阵 UI 简化要求

MVP 可以这样做：

先只让用户勾选：

```text
你们门店有哪些群？
□ 客户群
□ 会员群
□ 竞技群
□ 搭子群
□ 助教客户群
□ 赛事群
□ 员工群
```

勾选后存到 `private_domain_groups.<group>.enabled = true`。

可选增加一句说明：

> 勾选后，AI 在生成群公告、活动通知、约局话术时会自动区分不同群的说法。

MVP 不要求每个群展开完整 purpose / tone / forbidden_content 表单，但 JSONB 结构必须预留这些字段。

---

## 七、会员群 / 竞技群 Prompt 语义

生成门店画像摘要时，必须区分群类型。

### 会员群

如果 `member_group.enabled = true`，画像摘要可包含：

```text
门店有会员群，可用于会员维护、空台提醒、活动通知、老客户复购提醒。
生成会员群内容时，不得自动编造会员专属优惠、充值规则、会员权益或会员专属价格，除非用户明确提供。
```

### 竞技群

如果 `competition_group.enabled = true`，画像摘要可包含：

```text
门店有竞技群，可用于约局、周赛/月赛通知、轻竞技活动、赛后战报、找搭子和练球局。
生成竞技群内容时，不得写赌博、追分、大额输赢、搞钱局或高风险对局表达。
```

### 搭子群

如果 `partner_group.enabled = true`，画像摘要可包含：

```text
门店有搭子群，可用于找人打球、拼局、新人融入、临时约球。表达要自然，不要写赌博或高风险对局。
```

### 助教客户群

如果 `assistant_customer_group.enabled = true`，画像摘要可包含：

```text
门店有助教客户群，可用于助教到店通知、助教可约提醒、助教服务推广和助教客户维护。不得写免费助教、送助教课或低俗擦边表达。
```

### 员工群

如果 `staff_group.enabled = true`，画像摘要可包含：

```text
门店有员工群，可用于员工通知、生日祝福、SOP提醒、卫生检查和开闭店事项。不得擅自安排调休、奖金、处罚或顶班。
```

---

## 八、Prompt 注入要求

请新增一个门店画像摘要生成逻辑。

建议函数名：

```python
render_operation_profile_context(store) -> str
```

或放在合适的 service/helper 中。

摘要原则：

1. 只注入与生成相关的短摘要
2. 不把完整 JSONB 全塞进 Prompt
3. 禁用规则优先于风格偏好
4. 无 operation_profile 时返回空字符串
5. 字段缺失时不报错
6. 不暴露内部隐私
7. 会员群和竞技群必须进入摘要
8. 输出尽量控制在 800-1200 中文字以内，MVP 可更短

### free_intent.yaml 注入

新增可选变量：

```jinja
{% if profile_context %}
{{ profile_context }}
{% endif %}
```

建议放在：

- 门店基础资料之后
- few-shot 之前或之后均可，但必须在最终生成要求之前
- 不要放在最前面压过系统规则
- 不要覆盖 baseline rules

---

## 九、后端要求

### 1. Migration

新增 Alembic migration：

- `stores.operation_profile`
- 类型：JSONB
- 默认：空 JSON 或 nullable，按项目风格决定
- 必须支持回滚

### 2. Store model

新增字段：

```python
operation_profile
```

类型按项目 SQLAlchemy 风格实现。

### 3. Store schema

请求 / 响应 schema 支持 operation_profile。

注意：

- 只保存用户可编辑配置
- 不要保存客户隐私 / 员工隐私
- 对未知字段可以保留或校验，按项目当前 schema 风格决定

### 4. Store API

`GET /stores/me` 返回 operation_profile。

`PUT /stores/me` 或当前更新接口支持更新 operation_profile。

### 5. Content service

Workbench 生成时读取当前 store 的 operation_profile，生成 `profile_context`，传给 Prompt。

旧 4 个 Tab 是否注入：

- 本轮只要求 Workbench 注入
- 不要影响旧 4 个 Tab
- 后续再评估是否给旧 Tab 也注入

---

## 十、前端要求

修改：

`web/src/app/dashboard/store-settings/page.tsx`

目标：

新增一个区域：

```text
AI 运营画像
让 AI 更懂你这家球房，生成内容更像本店的人写的。
```

### UI 要求

1. 不要太复杂
2. 不要做 88 字段长表单
3. MVP 快速配置为主
4. 多选用 checkbox / tag 风格
5. 保存后能回显
6. 没有 operation_profile 时使用默认空结构
7. 移动端不溢出
8. 保持现有项目 UI 风格
9. 不引入新 UI 库

### 必须包含会员群 / 竞技群

私域群多选中必须有：

- 会员群
- 竞技群

并配简短说明：

- 会员群：会员维护、空台提醒、活动通知
- 竞技群：约局、周赛、轻竞技、赛后战报

---

## 十一、测试要求

完成后必须执行：

### 后端

根据项目实际命令执行：

```bash
cd server
# 例如：
uv run python -m py_compile models/store.py schemas/store.py api/v1/stores.py services/content_service.py
```

如项目有测试命令，可跑相关轻量测试。

### Migration

必须确认：

- migration 文件生成
- upgrade / downgrade 逻辑存在
- 不直接执行生产迁移
- 如在本地执行迁移，报告说明

### Prompt / YAML

检查：

- `free_intent.yaml` 能正常加载
- `profile_context` 为空时不报错
- `profile_context` 有值时能渲染

### 前端

必须执行：

```bash
cd web
npx tsc --noEmit
pnpm lint
pnpm build
```

如 lint 有既有 warning，请说明是否为既有问题。

### 手动验证建议

1. 打开门店资料页
2. 填写 AI 运营画像 MVP 字段
3. 勾选会员群、竞技群
4. 保存
5. 刷新后回显
6. 去 AI 工作台生成会员群/竞技群相关内容
7. 检查 Prompt 或日志是否包含 profile_context
8. 检查旧 4 个 Tab 页面正常

不需要调用 DeepSeek。

---

## 十二、输出报告

请生成：

`docs/reports/10G-1-门店运营画像MVP编码报告.md`

报告必须包含：

### 1. 本次任务目标

说明只做门店运营画像 MVP，不做完整画像、不做岗位工作台。

### 2. 实际新增 / 修改文件

逐个列出。

必须包含是否新增 migration。

### 3. 数据库变更

说明：

- 新增字段
- 字段类型
- 默认值 / nullable
- 是否支持 downgrade
- 是否执行迁移

### 4. 后端实现

说明：

- model
- schema
- API
- profile_context 渲染
- Workbench 注入

### 5. 前端实现

说明：

- AI 运营画像区域
- MVP 字段
- 私域群矩阵
- 会员群 / 竞技群是否支持
- 保存 / 回显

### 6. Prompt 注入

说明：

- profile_context 变量名
- 注入位置
- 是否影响 few-shot
- 是否影响旧 4 个 Tab
- 无画像时是否降级

### 7. 是否修改旧 4 个 Tab

必须明确回答。

### 8. 是否修改数据库

必须为是，并说明 migration 文件。

### 9. 是否调用 DeepSeek

必须为否。

### 10. 检查结果

列出后端、migration、Prompt、前端 tsc/lint/build 结果。

### 11. 当前遗留问题

例如：

- 完整 88 字段未做
- 资料完整度评分未做
- 场景触发补充提示未做
- 旧 4 个 Tab 暂未注入画像
- 真实球房观察反哺未做

### 12. 是否建议进入 10G-2

建议：

- 如果 10G-1 通过，进入 10G-2：门店画像注入效果验证 + 小样本测试
- 或进入 10G-1.5：UI 微调 / 字段修正

---

## 十三、完成后只回复

完成后只回复：

1. 报告路径
2. 新增 / 修改了哪些文件
3. migration 文件名
4. 是否完成 operation_profile JSONB
5. 是否完成 Store API 读写
6. 是否完成前端 AI 运营画像区域
7. 是否支持会员群 / 竞技群
8. 是否完成 profile_context 注入 Workbench
9. 是否影响旧 4 个 Tab：必须为否
10. 是否修改数据库：必须为是
11. 是否调用 DeepSeek：必须为否
12. 后端 / migration / Prompt / 前端检查是否通过
13. 是否建议进入 10G-2
