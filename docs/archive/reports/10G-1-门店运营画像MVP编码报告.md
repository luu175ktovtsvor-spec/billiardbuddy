# 10G-1 门店运营画像 MVP 编码报告

> 生成时间：2026-05-13
> 任务编号：10G-1
> 任务名称：门店运营画像 MVP 编码

---

## 1. 本次任务目标

只做门店运营画像 MVP（12-15 个关键字段），不做完整 88 字段画像、不做岗位工作台、不做 10G-2。

核心闭环：
- 新增 `stores.operation_profile` JSONB 字段
- 后端 model/schema/API 支持读写
- 前端「AI 运营画像」快速配置区域
- 私域群矩阵必须支持会员群和竞技群
- Workbench 生成时注入门店画像摘要
- 无画像时安全降级为空字符串
- 不影响旧 4 个 Tab

---

## 2. 实际新增 / 修改文件

| # | 文件 | 操作 | 说明 |
|---|------|------|------|
| 1 | `server/db/migrations/versions/003_operation_profile.py` | **新增** | Migration：新增 operation_profile JSONB 字段 |
| 2 | `server/models/store.py` | 修改 | 新增 `operation_profile` mapped_column |
| 3 | `server/schemas/store.py` | 修改 | StoreCreate/StoreUpdate/StoreResponse 新增 `operation_profile: Any = None` |
| 4 | `server/services/store_profile_service.py` | **新增** | `render_operation_profile_context()` 画像摘要渲染函数 |
| 5 | `server/services/content_service.py` | 修改 | `generate_workbench()` 调用画像摘要，注入 `profile_context` extra_var |
| 6 | `server/prompts/workbench/free_intent.yaml` | 修改 | 新增 `profile_context` 变量和模板占位 |
| 7 | `web/src/types/store.ts` | 修改 | StoreCreate/StoreUpdate/StoreResponse 新增 `operation_profile` |
| 8 | `web/src/app/dashboard/store-settings/page.tsx` | 修改 | 新增「AI 运营画像」快速配置区域 |

未修改文件：`server/api/v1/stores.py`（通用 setattr 模式自动兼容新字段）、旧 4 个 Tab 页面。

---

## 3. 数据库变更

| 项目 | 说明 |
|------|------|
| 新增字段 | `stores.operation_profile` |
| 字段类型 | JSONB |
| 默认值 | NULL（nullable） |
| 是否支持 downgrade | 是（`op.drop_column("stores", "operation_profile")`） |
| 是否执行迁移 | 否（仅生成文件，未连接数据库执行） |

Migration 文件：`server/db/migrations/versions/003_operation_profile.py`

- revision: `0003_operation_profile`
- down_revision: `0002_generations`

---

## 4. 后端实现

### 4.1 Store Model

`server/models/store.py:37` — 新增一行：

```python
operation_profile: Mapped[dict | None] = mapped_column(JSONB)
```

与现有 `pricing`、`member_cards` 的 JSONB 模式一致。

### 4.2 Store Schema

- `StoreCreate.operation_profile: Any = None`
- `StoreUpdate.operation_profile: Any = None`
- `StoreResponse.operation_profile: Any = None`

`update_store()` 的通用 `setattr` 模式自动兼容，无需修改 API 路由代码。

### 4.3 Store API

无需修改。`GET /stores/me` 通过 `_store_to_response()` 自动返回 `operation_profile`。`PUT /stores/me` 通过 `update_store()` 的 `setattr` 自动写入。

### 4.4 profile_context 渲染

新增 `server/services/store_profile_service.py`，核心函数：

```python
render_operation_profile_context(store: Store) -> str
```

摘要生成原则：
- 无 `operation_profile` 时返回空字符串
- 只注入短摘要，不塞完整 JSONB
- 禁用规则优先于风格偏好
- 字段缺失不报错
- 会员群和竞技群必须进入摘要
- 摘要分 9 个分组（基础画像、经营目标、客户结构、私域群矩阵、助教体系、赛事活动、团购/价格规则、内容风格、AI偏好）
- MVP 输出约 250-800 中文字

### 4.5 Workbench 注入

`server/services/content_service.py:280` — `generate_workbench()` 中：

```python
"profile_context": render_operation_profile_context(store),
```

只在 Workbench（free_intent）注入，不影响旧 4 个 Tab（copywriting/activity/operation）。

---

## 5. 前端实现

### 5.1 AI 运营画像区域

在门店资料页新增「AI 运营画像」Section（使用 Brain 图标），位置在「经营信息」之后、「图片上传」之前。

附带文案：*"让 AI 更懂你这家球房，生成内容更像本店的人写的。"*

### 5.2 MVP 字段（15 个核心输入）

| # | 字段 | 类型 | 组件 |
|---|------|------|------|
| 1 | 门店定位/风格 | 单选下拉 | select（5 选项） |
| 2 | 所在商圈/区域 | 文本 | input |
| 3 | 主要客户类型 | 多选 | TagCheckbox（8 选项） |
| 4 | 当前最想提升目标 | 多选 | TagCheckbox（9 选项） |
| 5 | 私域群类型 | 多选 | TagCheckbox（7 选项） |
| 6 | 是否有助教 | 开关 | Toggle |
| 7 | 助教类型 | 多选 | TagCheckbox（条件显示） |
| 8 | 允许写「新助教到店」 | 开关 | Toggle（条件显示） |
| 9 | 允许写「今日助教可约」 | 开关 | Toggle（条件显示） |
| 10 | 固定做周赛/活动 | 开关 | Toggle |
| 11 | 做团购（美团/抖音） | 开关 | Toggle |
| 12 | 朋友圈语气 | 单选下拉 | select（5 选项） |
| 13 | 允许写优惠/折扣 | 开关 | Toggle |
| 14 | 允许带电话/地址 | 开关 | Toggle |
| 15 | 禁用表达 | 文本 | input（逗号分隔） |

### 5.3 私域群矩阵

7 种群类型多选，必须包含：
- 客户群（customer_group）
- **会员群（member_group）**
- **竞技群（competition_group）**
- 搭子群（partner_group）
- 助教客户群（assistant_customer_group）
- 赛事群（event_group）
- 员工群（staff_group）

勾选后，蓝色提示框动态显示对应群类型的用途说明和内容边界规则。

### 5.4 会员群 / 竞技群支持

**是，完全支持。**

- 会员群勾选后提示：*"会员维护、空台提醒、活动通知。不会自动编造会员专属优惠、充值规则或会员权益。"*
- 竞技群勾选后提示：*"约局、周赛/月赛、轻竞技活动、赛后战报、找搭子。不会写赌博、追分、大额输赢。"*

JSONB 存储层面，每个群类型的 `purpose`、`tone`、`forbidden_content` 字段已预留（MVP 阶段前端仅设置 `enabled` 开关）。

### 5.5 保存 / 回显

- 保存时 `profileFormDataToProfile()` 将前端表单状态转为 JSONB 结构，通过 `PUT /stores/me` 保存
- 加载时 `profileToFormData()` 将 `operation_profile` JSONB 还原为前端表单状态
- 无画像时使用空 `ProfileFormData`，所有字段显示默认空值

### 5.6 UI 组件

新增 `TagGroup` 和 `TagCheckbox` 两个轻量组件：
- `TagCheckbox` — 圆角标签风格的多选按钮，选中时蓝色高亮
- `TagGroup` — flex-wrap 容器

不引入新 UI 库，完全复用项目现有 TailwindCSS 风格。

---

## 6. Prompt 注入

| 项目 | 说明 |
|------|------|
| 变量名 | `profile_context` |
| 注入位置 | 门店背景段落之后、用户需求段落之前 |
| 是否影响 few-shot | 否，few-shot 在用户需求之后 |
| 是否影响旧 4 个 Tab | 否，仅 Workbench（free_intent）注入 |
| 无画像时降级 | 是，`render_operation_profile_context()` 返回空字符串，模板渲染为空 |
| 模板语法 | Python `str.format()`，`{profile_context}` 为空时输出空字符串 |

`free_intent.yaml` 变更：
- variables 列表新增 `profile_context`
- 模板中在"地址/电话/营业时间"行之后新增 `{profile_context}` 占位行

---

## 7. 是否修改旧 4 个 Tab

**否。** 本轮仅修改 Workbench（free_intent.yaml + generate_workbench()）。旧 4 个 Tab（文案生成/活动策划/经营场景/海报生成）的业务逻辑和 Prompt 未做任何修改。

---

## 8. 是否修改数据库

**是。** Migration 文件：`server/db/migrations/versions/003_operation_profile.py`

- 新增 `stores.operation_profile` JSONB 字段
- 支持 upgrade/downgrade
- 未在本地执行迁移（仅生成文件）

---

## 9. 是否调用 DeepSeek

**否。** 本次任务未发起任何 API 调用。

---

## 10. 检查结果

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 后端 Python 编译 | ✅ 通过 | model/schema/service 导入正常 |
| 画像摘要渲染 | ✅ 通过 | 空画像返回空字符串，有画像正确渲染并包含会员群/竞技群 |
| Prompt YAML 加载 | ✅ 通过 | `profile_context` 在 variables 和 template 中均正确 |
| Prompt 渲染（空） | ✅ 通过 | 空 `profile_context` 渲染 3502 chars，不报错 |
| Prompt 渲染（有值） | ✅ 通过 | 带摘要内容正确注入 |
| 前端 tsc --noEmit | ✅ 通过 | 无类型错误 |
| 前端 pnpm lint | ✅ 通过 | 仅有预存的 `<img>` 警告（history/posters/store-settings），非本次引入 |
| 前端 pnpm build | ✅ 通过 | store-settings 页面 9.57 kB，构建成功 |
| Migration 文件 | ✅ 生成 | `003_operation_profile.py`，upgrade/downgrade 完整 |

---

## 11. 当前遗留问题

| # | 遗留项 | 说明 |
|---|--------|------|
| 1 | 完整 88 字段未做 | MVP 仅 15 个核心字段，完整字段字典已就绪（`门店运营画像字段字典.md`） |
| 2 | 资料完整度评分未做 | 当前 `completeness` 仍基于旧字段计算，未纳入 operation_profile 内容 |
| 3 | 场景触发补充提示未做 | 用户生成内容时缺少字段信息不会主动提示补充 |
| 4 | 旧 4 个 Tab 暂未注入画像 | copywriting/activity/operation 三个 Tab 的 Prompt 未注入 profile_context |
| 5 | 真实球房观察反哺未做 | 无运营数据回填画像机制 |
| 6 | 私域群矩阵仅支持 enabled 开关 | MVP 阶段未展开每个群的 purpose/tone/forbidden_content 表单 |
| 7 | 助教条件字段仅在有助教时显示 | 符合预期设计，非遗留问题 |

---

## 12. 是否建议进入 10G-2

**建议进入 10G-2。**

10G-1 完成了 MVP 闭环：
- operation_profile JSONB 可读写
- 前端快速配置可用
- profile_context 正确注入 Workbench
- 会员群/竞技群完整支持
- 无画像时安全降级

建议 10G-2 做：
1. 门店画像注入效果验证 + 小样本测试（用真实 Workbench 输入验证 profile_context 提升效果）
2. 旧 4 个 Tab 评估是否注入画像
3. 资料完整度纳入 operation_profile

如果验证期间发现 MVP 字段不够用，可先进入 10G-1.5：UI 微调 / 字段修正。

---

*报告完成。10G-1 门店运营画像 MVP 编码任务执行完毕。*
