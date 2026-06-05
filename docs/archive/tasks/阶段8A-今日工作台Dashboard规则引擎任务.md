# 阶段 8A：今日工作台 Dashboard 规则引擎任务文档

请先阅读项目根目录中的：

1. `CLAUDE.md`
2. `architecture-design.md`
3. `docs/tasks/阶段7A-整体产品冒烟测试与问题清单.md`
4. `docs/tasks/阶段7D-MVP演示验收与功能清单.md`

你现在只负责【阶段 8A：今日工作台 Dashboard 规则引擎】。

当前项目状态：

- 当前 MVP 已经完成核心闭环：
  - 注册 / 登录
  - 门店资料
  - Logo / 二维码上传
  - AI 朋友圈文案 / 群公告 / 活动方案生成
  - 生成历史
  - 海报生成
  - 海报历史接入
  - MVP 冒烟测试与体验打磨
- 当前无 P0 阻断问题
- 阶段 7D 建议近期优先优化：
  1. 今日工作台
  2. 更多海报模板
  3. 门店资料首次填写引导

当前阶段目标：

实现一个简单但实用的【今日工作台】，让老板登录后台后第一眼就知道：

1. 今天适合做什么运营动作
2. 可以一键去生成朋友圈文案
3. 可以一键去生成群公告
4. 可以一键去生成活动方案
5. 可以一键去生成海报
6. 可以看到门店资料完整度和最近生成情况

本阶段目标不是做复杂 AI Agent，也不是做大数据分析，而是先用规则引擎把 Dashboard 首页变得更像“AI 运营助手”。

---

## 一、本阶段核心思路

当前 Dashboard 首页如果只是功能入口，更像一个工具箱。

阶段 8A 要把它变成：

```text
老板每天打开后台
→ 系统根据日期 / 星期 / 时间段 / 门店资料完整度
→ 推荐今天该做的运营动作
→ 老板点一下就去生成对应内容
```

示例：

```text
今天是周五，适合做周末客流预热。

建议你今天做 3 件事：
1. 发一条朋友圈：周末约球预热
2. 发一条微信群公告：今晚约球接龙
3. 生成一张海报：周末活动宣传
```

---

## 二、本阶段边界

本阶段可以做：

- Dashboard 今日推荐接口
- Dashboard 首页展示今日推荐
- 简单规则引擎
- 基于星期 / 时间段 / 门店资料完整度的建议
- 跳转到现有页面：
  - `/dashboard/generate`
  - `/dashboard/posters`
  - `/dashboard/store-settings`
  - `/dashboard/history`

本阶段不要做：

- 不接新的 AI 接口
- 不调用 DeepSeek
- 不做复杂 Agent
- 不做自动生成内容
- 不做定时任务
- 不做推送通知
- 不做短信
- 不做微信接口
- 不做支付
- 不做配额
- 不做 OSS
- 不做小程序
- 不做数据统计大屏
- 不做复杂图表
- 不做用户行为分析
- 不做收藏
- 不做删除
- 不做搜索
- 不改 Prompt YAML
- 不改 AI Provider

---

## 三、本阶段允许修改

允许修改后端：

- `server/api/v1/`
- `server/schemas/`
- `server/services/`
- `server/api/v1/router.py`

允许修改前端：

- `web/src/app/dashboard/page.tsx`
- `web/src/lib/api.ts`
- `web/src/types/`
- `web/src/components/`

如果确实需要，可以新增：

- `server/api/v1/dashboard.py`
- `server/schemas/dashboard.py`
- `server/services/dashboard_service.py`
- `web/src/types/dashboard.ts`

---

## 四、本阶段禁止修改

禁止修改：

- `server/models/`
- `server/db/migrations/`
- `server/.env`
- `.env`
- `.env.example`
- `web/.env.local`
- `CLAUDE.md`
- `architecture-design.md`
- `docker-compose.yml`
- Prompt YAML
- AI Provider
- DeepSeek 配置
- 支付 / 配额相关内容

原则上本阶段不需要数据库迁移。

---

## 五、后端接口设计

请实现：

```text
GET /api/v1/dashboard/today
```

功能：

返回当前登录用户门店的今日工作台数据。

依赖：

- `get_current_user`
- `get_current_store`
- `get_db`

不允许前端传 `store_id`。

---

## 六、后端响应建议

响应结构建议：

```json
{
  "date": "2026-05-11",
  "weekday": "Monday",
  "greeting": "今天适合做一波工作日客流预热",
  "store_completeness": 85,
  "summary": {
    "total_generations": 12,
    "today_generations": 2,
    "latest_generation_at": "2026-05-11T10:30:00Z"
  },
  "recommendations": [
    {
      "id": "weekday_moments",
      "title": "发一条朋友圈文案",
      "description": "工作日适合提醒附近顾客下班后来打几局。",
      "action_label": "去生成朋友圈",
      "action_url": "/dashboard/generate",
      "action_type": "generate_copywriting",
      "priority": "high",
      "suggested_payload": {
        "sub_type": "moments",
        "tone": "friendly",
        "scenario": "daily",
        "extra_note": "今天工作日，下班后适合约朋友来打球"
      }
    }
  ],
  "tips": [
    "门店资料越完整，AI 生成内容越贴近你的真实经营情况。"
  ]
}
```

字段说明：

### date

当前日期。

### weekday

当前星期。

### greeting

一句今日运营提示。

### store_completeness

当前门店资料完整度。

### summary

简单汇总：

- total_generations：该门店累计生成数量
- today_generations：今天生成数量
- latest_generation_at：最近一次生成时间，可为空

### recommendations

今日推荐动作列表。

每条推荐包含：

- id
- title
- description
- action_label
- action_url
- action_type
- priority
- suggested_payload

### tips

提醒信息列表。

---

## 七、规则引擎要求

先做简单规则，不要做复杂 AI。

规则来源：

1. 星期几
2. 是否周末
3. 当前时间段
4. 门店资料完整度
5. 最近是否有生成记录
6. 是否上传 Logo / 二维码

### 规则 1：资料不完整优先提醒

如果门店资料完整度低于 70：

推荐优先级最高：

```text
完善门店资料
```

跳转：

```text
/dashboard/store-settings
```

说明：

```text
门店资料越完整，AI 生成的文案和海报越准确。
```

### 规则 2：没有 Logo / 二维码提醒

如果缺少 Logo 或二维码：

推荐：

```text
上传 Logo 和二维码
```

跳转：

```text
/dashboard/store-settings
```

说明：

```text
上传 Logo 和二维码后，生成海报会自动带上门店品牌和联系方式。
```

### 规则 3：工作日推荐

周一到周四：

推荐：

1. 朋友圈日常引流
2. 群公告约球接龙
3. 下午场 / 晚场轻活动

### 规则 4：周五推荐

周五：

推荐：

1. 周末约球预热朋友圈
2. 周末活动群公告
3. 周末宣传海报

### 规则 5：周末推荐

周六周日：

推荐：

1. 今日到店提醒
2. 比赛 / 活动海报
3. 会员卡 / 储值活动文案

### 规则 6：当天还没有生成内容

如果 today_generations = 0：

推荐：

```text
今天还没生成运营内容，先生成一条朋友圈或群公告。
```

### 规则 7：最近已经生成很多内容

如果 today_generations >= 5：

提示：

```text
今天已经生成了多条内容，可以优先挑选最合适的一条发布。
```

---

## 八、后端 Service 设计

可以新增：

```text
server/services/dashboard_service.py
```

建议方法：

```python
async def get_today_dashboard(
    db: AsyncSession,
    store: Store,
    user: User,
) -> DashboardTodayResponse:
    ...
```

内部逻辑：

1. 获取当前日期
2. 查询当前门店的 generations 总数
3. 查询今天的 generations 数量
4. 查询最近一次 generation
5. 读取 store.completeness
6. 根据规则生成 recommendations
7. 返回 DashboardTodayResponse

注意：

- 所有查询必须带 `store_id`
- 不允许查询其他门店数据
- 不需要新增数据库字段
- 不需要新增迁移

---

## 九、Schema 设计

可以新增：

```text
server/schemas/dashboard.py
```

建议类型：

```python
class DashboardSummary(BaseModel):
    total_generations: int
    today_generations: int
    latest_generation_at: datetime | None = None

class DashboardRecommendation(BaseModel):
    id: str
    title: str
    description: str
    action_label: str
    action_url: str
    action_type: str
    priority: Literal["high", "medium", "low"]
    suggested_payload: dict | None = None

class DashboardTodayResponse(BaseModel):
    date: str
    weekday: str
    greeting: str
    store_completeness: int
    summary: DashboardSummary
    recommendations: list[DashboardRecommendation]
    tips: list[str]
```

---

## 十、前端 Dashboard 页面要求

修改：

```text
web/src/app/dashboard/page.tsx
```

目标：

让首页从“入口卡片”升级成“今日工作台”。

页面结构建议：

### 1. 顶部欢迎区

显示：

```text
今日工作台
今天适合做一波周末客流预热
```

### 2. 门店状态卡片

显示：

- 门店名称
- 资料完整度
- 累计生成次数
- 今日生成次数
- 最近生成时间

### 3. 今日推荐区

显示 recommendations 列表。

每张推荐卡片展示：

- 标题
- 描述
- 优先级标签
- 按钮

按钮点击跳转：

- `/dashboard/generate`
- `/dashboard/posters`
- `/dashboard/store-settings`
- `/dashboard/history`

第一版不要求把 `suggested_payload` 自动带入目标页面，可以先只跳转。

### 4. 快捷入口区

保留原有入口卡片：

- AI 运营内容生成
- 海报生成
- 生成历史
- 门店资料

可以把它们放到下方。

### 5. 无门店状态

如果用户没有门店，Dashboard 应显示：

```text
先完善门店资料，AI 才能根据你的真实门店生成内容。
```

并提供按钮：

```text
去完善门店资料
```

跳转：

```text
/dashboard/store-settings
```

---

## 十一、前端 API Client 要求

修改：

```text
web/src/lib/api.ts
```

新增：

```ts
getTodayDashboard(): Promise<DashboardTodayResponse>
```

新增类型：

```text
web/src/types/dashboard.ts
```

类型建议：

```ts
export interface DashboardSummary {
  total_generations: number
  today_generations: number
  latest_generation_at: string | null
}

export interface DashboardRecommendation {
  id: string
  title: string
  description: string
  action_label: string
  action_url: string
  action_type: string
  priority: "high" | "medium" | "low"
  suggested_payload?: Record<string, unknown> | null
}

export interface DashboardTodayResponse {
  date: string
  weekday: string
  greeting: string
  store_completeness: number
  summary: DashboardSummary
  recommendations: DashboardRecommendation[]
  tips: string[]
}
```

---

## 十二、错误处理要求

前端错误提示：

- 401：请重新登录
- 404：请先完善门店资料
- 500：今日工作台加载失败，请稍后重试
- 网络错误：网络异常，请检查后重试

如果 Dashboard 接口失败，不要让整个页面白屏。

可以降级显示原有快捷入口卡片。

---

## 十三、测试要求

执行完成后请验证：

### 后端

1. 后端能正常启动
2. Swagger 能看到 `/api/v1/dashboard/today`
3. 未登录调用返回 401
4. 无门店用户调用返回合理错误
5. 有门店用户调用返回 200
6. 响应包含 date / weekday / greeting
7. 响应包含 store_completeness
8. 响应包含 summary
9. 响应包含 recommendations
10. recommendations 不为空
11. total_generations / today_generations 只统计当前门店
12. 跨门店数据隔离正常

### 前端

1. 前端能正常启动
2. `/dashboard` 可访问
3. 今日工作台能加载
4. 门店状态卡片显示正常
5. 今日推荐列表显示正常
6. 推荐按钮跳转正常
7. 快捷入口仍可用
8. 无门店状态正常
9. Dashboard 接口失败时不白屏
10. TypeScript 0 errors
11. build 成功

### 安全边界

1. 没有新增数据库迁移
2. 没有修改 server/models/
3. 没有调用 DeepSeek
4. 没有改 Prompt YAML
5. 没有新增支付 / 配额 / OSS
6. 没有新增依赖
7. 前端没有 API Key

---

## 十四、如果遇到问题

如果当前 store.completeness 字段名称或计算方式和预期不一致，不要大改。

请先说明：

```md
## 问题位置

## 问题说明

## 建议处理方式

## 需要修改的文件
```

等我确认后再改。

---

## 十五、输出要求

请先不要写代码。

请先输出：

1. 准备创建/修改的文件清单
2. Dashboard 今日接口设计
3. 规则引擎设计
4. Schema 设计
5. 前端页面改造设计
6. API client 设计
7. 是否需要数据库迁移
8. 是否会调用 AI 模型
9. 测试计划
10. 风险点

等我确认后再修改代码。
