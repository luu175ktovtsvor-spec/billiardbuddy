# 阶段 4B：前端 AI 文案 / 活动生成页面执行提示词

请先阅读项目根目录中的 `CLAUDE.md` 和 `architecture-design.md`。

你现在只负责【阶段 4B：前端 AI 文案 / 活动生成页面】。

当前项目进度：

- 阶段 1：项目骨架已完成
- 阶段 2A：后端基础已完成
- 阶段 2B：认证与门店资料后端已完成并通过端到端测试
- 阶段 3A：前端基础认证门店已完成并通过前后端联调
- 阶段 4A：AI Provider + Prompt Engine + DeepSeek 真实调用已完成并通过验收

当前阶段目标：

在前端后台中新增 AI 生成页面，让用户可以通过网页调用后端 AI 生成接口，生成：

1. 朋友圈文案
2. 群公告
3. 活动方案

本阶段只做前端页面和接口调用，不改后端接口，不做新后端功能。

---

## 一、如果当前 4B 任务已经开始但需要重来

如果你已经基于上一版提示词开始执行，请先暂停当前任务。

请先只做检查，不要修改文件：

1. 输出当前 4B 已经创建/修改的文件清单。
2. 输出每个文件大概修改了什么。
3. 执行 `git status`。
4. 等我确认后，再决定是继续、保留还是回退。

如果当前还没有修改文件，请直接继续阅读下面的完整 4B 任务说明。

---

## 二、已可用后端接口

后端已经提供以下接口。

### 1. 朋友圈 / 群公告生成

`POST /api/v1/generate/copywriting`

入参示例：

```json
{
  "sub_type": "moments",
  "tone": "friendly",
  "scenario": "daily",
  "extra_note": "今天下午空台比较多"
}
```

`sub_type` 可选：

- `moments`
- `group_notice`

### 2. 活动方案生成

`POST /api/v1/generate/activity`

入参示例：

```json
{
  "activity_goal": "traffic",
  "target_customer": "附近上班族",
  "budget_level": "medium",
  "duration": "3天",
  "extra_note": "希望提升下午场客流"
}
```

两个接口都需要登录 token，并且用户必须已经创建门店。

---

## 三、允许修改

只允许修改：

- `web/src/app/`
- `web/src/components/`
- `web/src/lib/`
- `web/src/hooks/`
- `web/src/types/`

如确实需要，也可以修改：

- `web/package.json`
- `web/tsconfig.json`
- `web/tailwind.config.ts`

---

## 四、禁止修改

禁止修改：

- `server/`
- `CLAUDE.md`
- `architecture-design.md`
- `docker-compose.yml`
- `README.md`
- `.env.example`
- `server/.env`

---

## 五、本阶段允许做

1. 在 dashboard 中新增 AI 生成入口
2. 新增一个 AI 生成中心页面
3. 支持生成朋友圈文案
4. 支持生成群公告
5. 支持生成活动方案
6. 在 API client 中新增：
   - `api.generateCopywriting()`
   - `api.generateActivity()`
7. 创建生成结果展示组件
8. 创建一键复制按钮
9. 创建 loading 状态
10. 创建错误提示
11. 如果用户没有门店，提示先去完善门店资料
12. 页面适配 PC 和手机 H5

---

## 六、本阶段不要做

不要做以下功能：

- 不做 SSE 流式输出
- 不做打字机效果
- 不做图片生成
- 不做海报生成
- 不做员工话术
- 不做社群复杂运营
- 不做生成历史页面
- 不做收藏
- 不做搜索
- 不做分页
- 不做配额显示
- 不做支付系统
- 不做 Prompt 管理后台
- 不改后端接口
- 不改数据库
- 不改 AI Provider
- 不改 Prompt YAML
- 不做富文本编辑器
- 不做 Markdown 编辑器
- 不引入新的大型 UI 库

---

## 七、页面结构建议

请使用一个 AI 生成中心页面：

```text
/dashboard/generate
```

页面中用 Tab 或按钮切换三个模块：

1. 朋友圈文案
2. 群公告
3. 活动方案

不要拆成多个复杂页面。第一版一个页面即可，方便维护。

---

## 八、页面功能要求

### 1. 朋友圈文案生成

表单字段：

#### 语气风格 `tone`

- `friendly`：亲切自然
- `lively`：活泼一点
- `professional`：专业稳重
- `humorous`：轻松幽默

#### 场景 `scenario`

- `daily`：日常营业
- `promotion`：活动促销
- `tournament`：比赛周赛
- `holiday`：节假日
- `evening`：晚间邀约
- `student`：学生优惠
- `comeback`：老客回归

#### 补充说明 `extra_note`

- `textarea`
- 可选
- 示例：今天下午空台比较多，想拉一波附近客户

点击生成后调用：

```text
POST /api/v1/generate/copywriting
sub_type = moments
```

返回后展示 `content`，并提供一键复制。

---

### 2. 群公告生成

表单字段：

#### 语气风格 `tone`

- `formal`：正式清楚
- `relaxed`：轻松互动
- `urgent`：重点提醒

#### 场景 `scenario`

- `activity_notice`：活动通知
- `game_matching`：约球接龙
- `tournament_notice`：比赛报名
- `newcomer_welcome`：新人欢迎
- `benefit_notice`：福利通知

#### 补充说明 `extra_note`

- `textarea`
- 可选
- 示例：今晚 8 点想组织一波约球接龙

点击生成后调用：

```text
POST /api/v1/generate/copywriting
sub_type = group_notice
```

返回后展示 `content`，并提供一键复制。

---

### 3. 活动方案生成

表单字段：

#### 活动目标 `activity_goal`

- `traffic`：拉人气 / 提升客流
- `membership`：卖会员卡 / 充值
- `tournament`：做周赛 / 比赛
- `comeback`：老会员回归
- `student`：学生客群
- `community`：搭子群活跃
- `team_building`：团建包场
- `holiday`：节日营销
- `coaching`：陪练体验

#### 目标客群 `target_customer`

- `input`
- 可选
- 示例：附近上班族、学生、新手玩家、老会员

#### 优惠力度 `budget_level`

- `light`：轻度优惠
- `medium`：中度优惠
- `heavy`：大力度优惠

#### 活动时间 `duration`

- `input`
- 可选
- 示例：3天、本周末、五一期间

#### 补充说明 `extra_note`

- `textarea`
- 可选
- 示例：希望提升下午场客流，不想做太大优惠

点击生成后调用：

```text
POST /api/v1/generate/activity
```

返回后展示 `content`，并提供一键复制。

---

## 九、结果展示要求

生成结果区域需要：

1. 显示生成内容
2. 纯文本展示即可
3. 支持一键复制
4. 显示 `generation_id`，可用小字显示
5. 显示生成时间
6. 支持重新生成
7. loading 时按钮禁用，显示“AI 正在生成中...”
8. 错误时显示中文可读提示
9. 不做富文本编辑器
10. 不做复杂排版编辑

---

## 十、登录和门店状态要求

1. 页面必须要求登录。
2. 如果未登录，跳转 `/login`。
3. 页面加载时需要检查当前门店状态。
4. 如果 `GET /api/v1/stores/me` 返回 404，提示：

```text
请先完善门店资料，AI 才能根据你的门店生成内容。
```

5. 提供按钮跳转：

```text
/dashboard/store-settings
```

6. 不要在没有门店的情况下调用生成接口。

---

## 十一、API Client 要求

所有请求必须统一走：

```text
web/src/lib/api.ts
```

不要在页面中散落 `fetch`。

请新增类型：

- `GenerateCopywritingRequest`
- `GenerateActivityRequest`
- `GenerationResponse`

可以放在：

```text
web/src/types/generate.ts
```

API 要求：

1. `generateCopywriting` 入参必须匹配后端：
   - `sub_type`
   - `tone`
   - `scenario`
   - `extra_note`

2. `generateActivity` 入参必须匹配后端：
   - `activity_goal`
   - `target_customer`
   - `budget_level`
   - `duration`
   - `extra_note`

3. 活动字段统一使用 `target_customer`。
4. 不要使用 `target_audience`。
5. 不要传 `store_id`。
6. 不要在前端直接调用 DeepSeek。
7. 不要在 `web/.env.local` 里放 `DEEPSEEK_API_KEY`。
8. 前端只调用后端 generate 接口。

---

## 十二、导航要求

请在 dashboard 侧边栏新增入口：

```text
AI 生成
```

点击进入：

```text
/dashboard/generate
```

移动端底部导航如果空间足够，也可以增加“AI 生成”。

如果空间不够，可以先在 dashboard 首页增加一个卡片入口：

```text
今日生成运营内容
```

不要重构整个导航系统。

---

## 十三、Dashboard 首页要求

可以在 `/dashboard` 首页增加一个简单入口卡片。

标题：

```text
AI 运营内容生成
```

描述：

```text
快速生成朋友圈文案、微信群公告和活动方案。
```

按钮：

```text
去生成
```

跳转：

```text
/dashboard/generate
```

---

## 十四、UI 要求

1. 简洁实用，不追求复杂设计。
2. PC 端可以使用左右布局或卡片布局。
3. 手机端表单和结果上下排列。
4. 使用 TailwindCSS。
5. 不引入新的大型 UI 库。
6. 不做动画。
7. 不做复杂编辑器。
8. 错误提示要中文可读。
9. loading 状态要明确。
10. 生成按钮要防重复点击，loading 时禁用按钮。

---

## 十五、错误提示要求

错误提示要用户能看懂：

- 401：请重新登录
- 404：请先创建或完善门店资料
- 422：请检查填写内容
- 500：AI 生成失败，请稍后重试
- 网络错误：网络异常，请检查后重试

不要把后端长错误堆栈直接展示给用户。

---

## 十六、测试要求

执行完成后请验证：

1. 前端能正常启动。
2. `/dashboard/generate` 可以访问。
3. 未登录访问会跳转 `/login`。
4. 无门店时提示先完善门店资料。
5. 有门店时可以生成朋友圈文案。
6. 有门店时可以生成群公告。
7. 有门店时可以生成活动方案。
8. 生成结果不是空。
9. 一键复制可用。
10. loading 时按钮禁用，不能重复点击。
11. API 请求都走 `web/src/lib/api.ts`。
12. 没有修改 `server/`。
13. 没有前端直连 DeepSeek。
14. 没有把任何 API Key 写入 `web/`。
15. 没有实现 SSE。
16. 没有实现图片生成。
17. 没有实现海报。
18. 没有实现配额。
19. 没有实现支付。

---

## 十七、输出要求

请先不要写代码。

请先输出：

1. 准备创建/修改的文件清单
2. 页面路由设计
3. 表单设计
4. API client 设计
5. 结果展示组件设计
6. 导航改动
7. Dashboard 首页入口改动
8. 执行计划
9. 风险点

等我确认后再修改代码。
