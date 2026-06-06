# 球房 AI 运营助手 — 可开发架构落地设计

---

## 一、项目理解确认

**这个项目是什么：**

一个面向台球房行业的 AI 运营辅助 SaaS 网页工具。用户是台球房老板、店长、前台员工。他们通过系统里预设好的场景按钮和表单，一键触发 AI 生成朋友圈文案、活动方案、员工话术、社群内容、营销海报等运营物料。系统自动读取该门店的资料（名称、价格、地址、会员卡等）注入 AI Prompt，确保生成内容贴合真实店况。

**这个项目不是什么：**

- 不是收银系统——不做开台、计费、结账
- 不是灯控系统——不控制球桌灯光
- 不是会员充值系统——不做充值、扣费、余额查询
- 不是聊天机器人——用户不需要自己写 Prompt
- 不是自动化营销工具——不做自动群发微信、自动私信、自动加好友、爬虫抓取
- 不是数据分析平台——MVP 不做 BI 看板

**核心闭环：**

```
用户选场景 → 填表单 → 系统注入门店资料到 Prompt → 调用 AI 模型 → 输出内容/海报 → 用户复制/下载 → 手动发布
```

---

## 二、MVP 功能边界确认

### P0 — 最小闭环（必须能跑通）

| 模块 | 说明 |
|------|------|
| 用户注册/登录 | 手机号+密码，JWT 鉴权 |
| 门店资料管理 | 创建门店、填写/编辑资料、上传 Logo 和二维码 |
| AI Provider 层 | TextProvider + ImageProvider 抽象，至少接入一个文本模型 |
| Prompt 引擎 | YAML 模板加载、变量替换、门店资料自动注入 |
| 文案生成 | 朋友圈/群公告/邀约文案，SSE 流式输出，一键复制 |
| 活动策划 | 选目标 → AI 输出完整活动方案 |

**验收标准**：一个用户能注册登录 → 创建门店填资料 → 生成一条朋友圈文案并复制 → 生成一个活动方案。

### P1 — 增强功能

| 模块 | 说明 |
|------|------|
| 员工话术 | 10+ 场景的标准话术生成 |
| 社群内容 | 群话题/约球接龙/群规/新人欢迎语 |
| 海报生成 | AI 背景图 + Pillow 合成商业信息 + 预览 + 下载 |
| 今日工作台 | 基于日期/星期/节假日的规则引擎推荐 |

### P2 — 完善功能

| 模块 | 说明 |
|------|------|
| 生成历史 | 列表/搜索/收藏/删除 |
| 使用量控制 | 按月计数文本/图片/海报生成次数，达上限提示 |

**不在 MVP 范围内：** 会员唤醒、多门店切换、短视频脚本、经营报告、小程序、对接收银系统。

---

## 三、后端架构落地设计

### 3.1 目录结构细化

```
server/
├── main.py                          # FastAPI 应用入口
├── config.py                        # 环境变量 + 配置类
├── api/
│   ├── deps.py                      # 公共依赖（get_db, get_current_user, get_current_store）
│   └── v1/
│       ├── router.py                # 汇总所有路由
│       ├── auth.py                  # POST /register, /login, GET /me
│       ├── stores.py                # 门店 CRUD + 文件上传
│       ├── generate.py              # 文案/活动/话术/社群 生成
│       ├── poster.py                # 海报生成
│       ├── dashboard.py             # 今日工作台
│       ├── generations.py           # 生成历史
│       └── quota.py                 # 使用量查询
├── core/
│   ├── security.py                  # JWT 签发/验证, bcrypt 哈希
│   ├── quota.py                     # 配额检查逻辑
│   ├── exceptions.py                # 自定义异常 + 统一异常处理
│   └── store_context.py             # store_id 隔离中间件/依赖
├── models/
│   ├── base.py                      # 声明 Base, 公共字段 mixin
│   ├── user.py                      # User
│   ├── store.py                     # Store, StoreMember
│   ├── generation.py                # Generation
│   └── quota.py                     # UsageQuota
├── schemas/
│   ├── auth.py                      # RegisterRequest, LoginRequest, TokenResponse, UserResponse
│   ├── store.py                     # StoreCreate, StoreUpdate, StoreResponse
│   ├── generate.py                  # CopywritingRequest, ActivityRequest, ScriptRequest, etc.
│   ├── poster.py                    # PosterRequest, PosterResponse
│   ├── generation.py                # GenerationResponse, GenerationList
│   └── common.py                    # 分页、通用响应
├── services/
│   ├── auth_service.py              # 注册/登录业务逻辑
│   ├── store_service.py             # 门店 CRUD
│   ├── content_service.py           # 文案/活动/话术/社群 生成编排
│   ├── poster_service.py            # 海报生成编排
│   ├── dashboard_service.py         # 工作台推荐逻辑
│   ├── generation_service.py        # 历史记录 CRUD
│   ├── storage_service.py           # OSS 文件上传
│   ├── ai/
│   │   ├── base.py                  # TextProvider, ImageProvider 抽象基类
│   │   ├── factory.py               # ProviderFactory
│   │   ├── prompt_engine.py         # Prompt 模板加载 + 变量替换
│   │   └── providers/
│   │       ├── deepseek.py          # DeepSeek 实现
│   │       ├── openai_text.py       # OpenAI 文本实现
│   │       ├── openai_image.py      # OpenAI 图片实现
│   │       └── claude.py            # Claude 实现
│   └── poster/
│       ├── composer.py              # Pillow 合成引擎
│       ├── templates.py             # 海报模板定义（布局、字号、位置）
│       └── fonts/                   # 思源黑体等中文字体文件
├── db/
│   ├── session.py                   # async engine + async sessionmaker
│   └── migrations/                  # Alembic
│       ├── env.py
│       └── versions/
├── prompts/                         # Prompt YAML 模板
│   ├── copywriting/
│   │   ├── moments.yaml
│   │   ├── group_notice.yaml
│   │   └── invitation.yaml
│   ├── activity/
│   │   └── planning.yaml
│   ├── scripts/
│   │   └── employee.yaml
│   ├── community/
│   │   └── daily.yaml
│   └── poster/
│       └── background.yaml
└── pyproject.toml
```

### 3.2 API 路由分组

| 前缀 | 文件 | 职责 |
|------|------|------|
| `/api/v1/auth` | `auth.py` | 注册、登录、获取当前用户 |
| `/api/v1/stores` | `stores.py` | 门店 CRUD、文件上传 |
| `/api/v1/generate` | `generate.py` | 文案/活动/话术/社群内容生成 |
| `/api/v1/posters` | `poster.py` | 海报生成 |
| `/api/v1/dashboard` | `dashboard.py` | 今日工作台 |
| `/api/v1/generations` | `generations.py` | 生成历史 |
| `/api/v1/quota` | `quota.py` | 使用量查询 |

### 3.3 Service 层职责

```
API 路由层（薄层，只做参数校验和响应包装）
    ↓
Service 层（业务编排）
    ├── content_service  → 调用 prompt_engine 渲染 → 调用 ai.factory 获取 provider → 调用 provider.generate → 写 generation 记录
    ├── poster_service   → 调用 content_service 生成文案 → 调用 image_provider 生成背景 → 调用 poster.composer 合成 → 上传 OSS
    └── dashboard_service → 读取门店配置 + 当前日期 → 规则引擎输出推荐列表
    ↓
AI Provider 层（只负责模型调用，不含业务逻辑）
Prompt Engine（只负责模板加载和变量替换）
Poster Composer（只负责图片合成）
```

### 3.4 store_id 隔离方案

```python
# api/deps.py

async def get_current_store(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Store:
    """从当前用户获取其所属门店，所有业务接口依赖此函数"""
    member = await db.execute(
        select(StoreMember).where(StoreMember.user_id == current_user.id)
    )
    member = member.scalar_one_or_none()
    if not member:
        raise HTTPException(403, "未绑定门店")
    store = await db.get(Store, member.store_id)
    return store
```

所有业务 Service 方法的第一个参数是 `store_id: UUID`，所有数据库查询必须 `.where(Model.store_id == store_id)`。不存在不带 store_id 的业务查询。

### 3.5 配额检查方案

```python
# core/quota.py

async def check_quota(db: AsyncSession, store_id: UUID, gen_type: str) -> None:
    """在 AI 调用前检查配额，超限抛异常"""
    quota = await get_or_create_current_month_quota(db, store_id)
    field_map = {
        "text": ("text_gen_used", "text_gen_limit"),
        "image": ("image_gen_used", "image_gen_limit"),
        "poster": ("poster_gen_used", "poster_gen_limit"),
    }
    used_field, limit_field = field_map[gen_type]
    if getattr(quota, used_field) >= getattr(quota, limit_field):
        raise QuotaExceededError(f"{gen_type} 本月配额已用完")

async def increment_usage(db: AsyncSession, store_id: UUID, gen_type: str) -> None:
    """AI 调用成功后递增计数"""
    ...
```

调用位置：`content_service.generate()` 开头调用 `check_quota()`，成功后调用 `increment_usage()`。

### 3.6 AI 调用日志方案

不单独建日志表。每次 AI 调用的结果都写入 `generations` 表，里面已经有 `prompt_used`、`model_used`、`tokens_used` 字段。后端同时用 Python logging 记录调用耗时、错误信息到文件日志。MVP 不做前端日志展示面板。

---

## 四、前端架构落地设计

### 4.1 页面路由设计

```
src/app/
├── layout.tsx                       # 全局 layout（字体、全局 provider）
├── page.tsx                         # 首页重定向到 /login 或 /dashboard
├── (auth)/
│   ├── layout.tsx                   # 认证页面布局（居中卡片）
│   ├── login/page.tsx               # 登录页
│   └── register/page.tsx            # 注册页
├── (dashboard)/
│   ├── layout.tsx                   # 主界面布局：左侧导航 + 右侧内容区
│   ├── page.tsx                     # 今日运营工作台（默认首页）
│   ├── copywriting/page.tsx         # 文案生成
│   ├── activity/page.tsx            # 活动策划
│   ├── scripts/page.tsx             # 员工话术
│   ├── community/page.tsx           # 社群内容
│   ├── poster/page.tsx              # 海报生成
│   ├── history/page.tsx             # 生成历史
│   └── store-settings/page.tsx      # 门店资料设置
```

### 4.2 Dashboard 布局

```
┌──────────────────────────────────────────────────────┐
│  顶部栏：门店名称              用户头像 / 退出登录    │
├──────────┬───────────────────────────────────────────┤
│          │                                           │
│  导航栏   │           内容区域                        │
│          │                                           │
│  📊 工作台 │                                          │
│  📱 文案   │                                          │
│  🎯 活动   │                                          │
│  💬 话术   │                                          │
│  👥 社群   │                                          │
│  🖼 海报   │                                          │
│  📋 历史   │                                          │
│  ⚙️ 门店   │                                          │
│          │                                           │
└──────────┴───────────────────────────────────────────┘

手机端：导航栏收起为底部 Tab 或汉堡菜单
```

### 4.3 各页面设计要点

**登录/注册页**：居中卡片，手机号+密码，表单用 react-hook-form + zod。登录成功后 token 存 localStorage，跳转 dashboard。

**门店资料页**：长表单，分区块（基础信息/价格/会员卡/设施/风格），Logo 和二维码做图片上传预览。保存后 toast 提示。首次进入如果没有门店资料要引导填写。

**文案生成页**（核心页面模式，其他生成页面类似）：

```
┌────────────────────────────────────────┐
│  文案生成                               │
├────────────────────────────────────────┤
│                                        │
│  文案类型：[朋友圈] [群公告] [邀约文案]  │  ← 场景按钮组
│                                        │
│  语气：  [活泼 ▼]                       │  ← 下拉选择
│  场景：  [日常 ▼]                       │  ← 下拉选择
│  补充说明：[________________]           │  ← 可选输入
│                                        │
│  [✨ 生成文案]                          │  ← 主按钮
│                                        │
│  ┌──────────────────────────────────┐  │
│  │ 生成结果区域                      │  │
│  │                                  │  │
│  │ AI 流式输出的文案内容...          │  │  ← SSE 打字机效果
│  │                                  │  │
│  │          [📋 复制] [⭐ 收藏]      │  │  ← 操作按钮
│  └──────────────────────────────────┘  │
│                                        │
│  [🔄 重新生成]                         │
└────────────────────────────────────────┘
```

**海报生成页**：比文案页多一步——表单提交后显示进度（生成文案 → 生成背景 → 合成海报），最终展示海报预览图 + 下载按钮。

**今日工作台**：卡片列表，每张卡片有标题、一句话说明、"去生成"按钮跳转到对应页面。

### 4.4 关键组件

```
components/
├── ui/                          # shadcn/ui 原子组件（Button, Input, Select, Card, Toast...）
├── layout/
│   ├── sidebar.tsx              # 侧边导航
│   ├── mobile-nav.tsx           # 移动端底部导航
│   └── header.tsx               # 顶部栏
├── forms/
│   ├── store-form.tsx           # 门店资料表单
│   ├── copywriting-form.tsx     # 文案生成表单
│   ├── activity-form.tsx        # 活动策划表单
│   ├── script-form.tsx          # 话术生成表单
│   ├── community-form.tsx       # 社群内容表单
│   └── poster-form.tsx          # 海报生成表单
├── generators/
│   ├── stream-result.tsx        # SSE 流式文本展示组件
│   ├── result-card.tsx          # 生成结果卡片（含复制/收藏）
│   ├── copy-button.tsx          # 一键复制按钮
│   ├── poster-preview.tsx       # 海报预览 + 下载
│   └── generation-progress.tsx  # 海报生成进度展示
```

### 4.5 SSE 流式输出组件设计

```typescript
// hooks/use-sse-generate.ts

export function useSSEGenerate() {
  const [content, setContent] = useState("")
  const [isGenerating, setIsGenerating] = useState(false)

  const generate = async (url: string, body: object) => {
    setContent("")
    setIsGenerating(true)

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value)
      // 解析 SSE data: 行
      const lines = text.split("\n").filter(l => l.startsWith("data: "))
      for (const line of lines) {
        const chunk = line.slice(6)
        if (chunk === "[DONE]") break
        setContent(prev => prev + chunk)
      }
    }

    setIsGenerating(false)
  }

  return { content, isGenerating, generate }
}
```

### 4.6 API 客户端封装

```typescript
// lib/api.ts

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"

class ApiClient {
  private token: string | null = null

  setToken(token: string) { this.token = token }

  private async request<T>(method: string, path: string, body?: object): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const err = await res.json()
      throw new ApiError(res.status, err.detail)
    }
    return res.json()
  }

  // Auth
  login(phone: string, password: string) {
    return this.request<TokenResponse>("POST", "/api/v1/auth/login", { phone, password })
  }
  register(data: RegisterRequest) {
    return this.request<TokenResponse>("POST", "/api/v1/auth/register", data)
  }
  getMe() {
    return this.request<UserResponse>("GET", "/api/v1/auth/me")
  }

  // Store
  getMyStore() {
    return this.request<StoreResponse>("GET", "/api/v1/stores/me")
  }
  updateStore(data: StoreUpdate) {
    return this.request<StoreResponse>("PUT", "/api/v1/stores/me", data)
  }

  // Generate（文案类用 SSE，不走这个方法，用 useSSEGenerate hook 直接 fetch）
  generateActivity(data: ActivityRequest) {
    return this.request<GenerationResponse>("POST", "/api/v1/generate/activity", data)
  }

  // Generations
  getGenerations(params: ListParams) {
    return this.request<GenerationList>("GET", `/api/v1/generations?${qs(params)}`)
  }

  // Dashboard
  getTodayTasks() {
    return this.request<DashboardResponse>("GET", "/api/v1/dashboard/today")
  }
}

export const api = new ApiClient()
```

---

## 五、数据库表设计

### 5.1 users

| 字段 | 类型 | 说明 | store_id | 索引 |
|------|------|------|----------|------|
| id | UUID PK | 主键 | — | — |
| phone | VARCHAR(20) UNIQUE NOT NULL | 手机号 | — | UNIQUE |
| password_hash | VARCHAR(255) NOT NULL | bcrypt 哈希 | — | — |
| name | VARCHAR(100) | 姓名 | — | — |
| created_at | TIMESTAMPTZ | 创建时间 | — | — |
| updated_at | TIMESTAMPTZ | 更新时间 | — | — |

### 5.2 stores

| 字段 | 类型 | 说明 | store_id | 索引 |
|------|------|------|----------|------|
| id | UUID PK | 门店ID，即 store_id | 自身 | — |
| owner_id | UUID FK→users | 创建者 | — | INDEX |
| name | VARCHAR(200) NOT NULL | 门店名称 | — | — |
| city | VARCHAR(100) | 城市 | — | — |
| district | VARCHAR(100) | 区 | — | — |
| address | VARCHAR(500) | 详细地址 | — | — |
| phone | VARCHAR(50) | 联系电话 | — | — |
| business_hours | VARCHAR(200) | 营业时间 | — | — |
| table_count | INTEGER | 球桌数量 | — | — |
| table_types | VARCHAR(500) | 桌型描述 | — | — |
| pricing | JSONB | 价格体系 | — | — |
| member_cards | JSONB | 会员卡套餐 | — | — |
| logo_url | VARCHAR(500) | Logo 图片 URL | — | — |
| qrcode_url | VARCHAR(500) | 微信二维码 URL | — | — |
| has_private_room | BOOLEAN DEFAULT false | 是否有包间 | — | — |
| has_coaching | BOOLEAN DEFAULT false | 是否有陪练 | — | — |
| has_tournament | BOOLEAN DEFAULT false | 是否有比赛 | — | — |
| has_parking | BOOLEAN DEFAULT false | 是否有停车 | — | — |
| target_customers | VARCHAR(500) | 主要客群 | — | — |
| style | VARCHAR(200) | 门店风格 | — | — |
| advantages | TEXT | 门店优势 | — | — |
| common_activities | TEXT | 常用活动 | — | — |
| created_at | TIMESTAMPTZ | — | — | — |
| updated_at | TIMESTAMPTZ | — | — | — |

### 5.3 store_members

| 字段 | 类型 | 说明 | store_id | 索引 |
|------|------|------|----------|------|
| id | UUID PK | — | — | — |
| store_id | UUID FK→stores NOT NULL | 所属门店 | ✅ | INDEX |
| user_id | UUID FK→users NOT NULL | 用户 | — | INDEX |
| role | VARCHAR(20) NOT NULL | owner / manager / staff | — | — |
| created_at | TIMESTAMPTZ | — | — | — |
| UNIQUE(store_id, user_id) | — | 一个用户在一家店只有一个角色 | — | UNIQUE |

### 5.4 generations

| 字段 | 类型 | 说明 | store_id | 索引 |
|------|------|------|----------|------|
| id | UUID PK | — | — | — |
| store_id | UUID FK→stores NOT NULL | 所属门店 | ✅ | INDEX |
| user_id | UUID FK→users NOT NULL | 操作人 | — | — |
| type | VARCHAR(50) NOT NULL | copywriting / activity / script / community / poster | — | INDEX |
| sub_type | VARCHAR(50) | moments / group_notice / invitation 等 | — | — |
| input_params | JSONB | 用户提交的表单参数 | — | — |
| prompt_used | TEXT | 实际发送给模型的完整 Prompt | — | — |
| result | TEXT | AI 返回的文本内容 | — | — |
| image_url | VARCHAR(500) | AI 生成的背景图 URL | — | — |
| poster_url | VARCHAR(500) | 合成后海报 URL | — | — |
| model_used | VARCHAR(100) | 模型标识 | — | — |
| tokens_used | INTEGER | Token 消耗 | — | — |
| is_favorite | BOOLEAN DEFAULT false | 是否收藏 | — | — |
| created_at | TIMESTAMPTZ | — | — | INDEX (DESC) |

### 5.5 usage_quotas

| 字段 | 类型 | 说明 | store_id | 索引 |
|------|------|------|----------|------|
| id | UUID PK | — | — | — |
| store_id | UUID FK→stores NOT NULL | — | ✅ | — |
| period_start | DATE NOT NULL | 计费周期开始 | — | — |
| period_end | DATE NOT NULL | 计费周期结束 | — | — |
| text_gen_used | INTEGER DEFAULT 0 | 已用文本生成次数 | — | — |
| text_gen_limit | INTEGER DEFAULT 100 | 文本生成上限 | — | — |
| image_gen_used | INTEGER DEFAULT 0 | 已用图片生成次数 | — | — |
| image_gen_limit | INTEGER DEFAULT 30 | 图片生成上限 | — | — |
| poster_gen_used | INTEGER DEFAULT 0 | 已用海报生成次数 | — | — |
| poster_gen_limit | INTEGER DEFAULT 30 | 海报生成上限 | — | — |
| UNIQUE(store_id, period_start) | — | 每店每月一条 | — | UNIQUE |

### 5.6 关于 prompt_templates 表

MVP 阶段**不建表**。Prompt 模板全部用 YAML 文件管理，存放在 `server/prompts/` 目录。理由：
- 开发迭代快，改文件比改数据库快
- Prompt 调优频率高，不需要走迁移
- 后续如果需要做管理后台在线编辑 Prompt，再加表不迟

### 5.7 关于 poster_records 表

**不单独建表**。海报生成记录直接写入 `generations` 表，`type = "poster"`，`image_url` 存背景图，`poster_url` 存合成后海报。一张表够用，不过早拆分。

---

## 六、AI Provider 抽象设计

### 6.1 接口定义

```python
# services/ai/base.py

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator

@dataclass
class TextRequest:
    prompt: str
    system_prompt: str | None = None
    max_tokens: int = 2000
    temperature: float = 0.7

@dataclass
class TextResponse:
    content: str
    model: str
    tokens_used: int

@dataclass
class ImageRequest:
    prompt: str
    size: str = "1024x1024"
    style: str = "natural"

@dataclass
class ImageResponse:
    image_url: str          # 图片可下载 URL 或 base64
    model: str


class TextProvider(ABC):
    """文本模型抽象基类"""

    @abstractmethod
    async def generate(self, request: TextRequest) -> TextResponse:
        """一次性生成完整文本"""
        ...

    @abstractmethod
    async def generate_stream(self, request: TextRequest) -> AsyncIterator[str]:
        """流式生成，逐块 yield 文本片段"""
        ...


class ImageProvider(ABC):
    """图片模型抽象基类"""

    @abstractmethod
    async def generate(self, request: ImageRequest) -> ImageResponse:
        """生成图片"""
        ...
```

### 6.2 Provider 工厂

```python
# services/ai/factory.py

from config import settings

class ProviderFactory:
    _text_registry: dict[str, type[TextProvider]] = {}
    _image_registry: dict[str, type[ImageProvider]] = {}

    @classmethod
    def register_text(cls, name: str, provider_cls: type[TextProvider]):
        cls._text_registry[name] = provider_cls

    @classmethod
    def register_image(cls, name: str, provider_cls: type[ImageProvider]):
        cls._image_registry[name] = provider_cls

    @classmethod
    def get_text_provider(cls) -> TextProvider:
        """根据配置文件返回当前启用的文本模型 Provider"""
        name = settings.TEXT_MODEL_PROVIDER   # e.g. "deepseek"
        return cls._text_registry[name]()

    @classmethod
    def get_image_provider(cls) -> ImageProvider:
        name = settings.IMAGE_MODEL_PROVIDER  # e.g. "openai"
        return cls._image_registry[name]()
```

### 6.3 具体 Provider 实现（伪代码）

```python
# services/ai/providers/deepseek.py

class DeepSeekProvider(TextProvider):
    async def generate(self, request: TextRequest) -> TextResponse:
        # 调用 DeepSeek API（兼容 OpenAI SDK）
        client = AsyncOpenAI(base_url="https://api.deepseek.com", api_key=settings.DEEPSEEK_API_KEY)
        response = await client.chat.completions.create(
            model="deepseek-chat",
            messages=[
                {"role": "system", "content": request.system_prompt or ""},
                {"role": "user", "content": request.prompt},
            ],
            max_tokens=request.max_tokens,
            temperature=request.temperature,
        )
        return TextResponse(
            content=response.choices[0].message.content,
            model="deepseek-chat",
            tokens_used=response.usage.total_tokens,
        )

    async def generate_stream(self, request: TextRequest) -> AsyncIterator[str]:
        client = AsyncOpenAI(base_url="https://api.deepseek.com", api_key=settings.DEEPSEEK_API_KEY)
        stream = await client.chat.completions.create(
            model="deepseek-chat",
            messages=[...],
            stream=True,
        )
        async for chunk in stream:
            if chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content
```

### 6.4 设计要点

- 业务层（`content_service`）只调用 `ProviderFactory.get_text_provider().generate(request)`，不知道背后是哪个模型
- 切换模型只改 `config.py` 里的 `TEXT_MODEL_PROVIDER = "deepseek"` → `"openai"`
- ImageProvider 的 Prompt 必须包含 `NO text, NO words, NO letters, NO numbers`，确保不生成文字
- 后续扩展只需新增一个 `providers/xxx.py` 文件 + 注册到工厂

---

## 七、Prompt Engine 设计

### 7.1 加载流程

```
启动时扫描 server/prompts/ 目录
    ↓
解析所有 YAML 文件，按 key 索引到内存 dict
    ↓
业务调用时：template_key + store 对象 + 用户表单参数
    ↓
从 store 对象提取标准变量（store_name, city, price_info...）
    ↓
合并用户表单变量（tone, scenario, activity_goal...）
    ↓
检查模板所需变量是否齐全，缺少则抛出明确错误
    ↓
执行 {variable} 替换，输出最终 Prompt 字符串
    ↓
传给 TextProvider / ImageProvider
```

### 7.2 伪代码

```python
# services/ai/prompt_engine.py

import yaml
from pathlib import Path

class PromptEngine:
    def __init__(self):
        self._templates: dict[str, dict] = {}
        self._load_all()

    def _load_all(self):
        prompts_dir = Path(__file__).parent.parent.parent / "prompts"
        for yaml_file in prompts_dir.rglob("*.yaml"):
            with open(yaml_file) as f:
                data = yaml.safe_load(f)
            self._templates[data["key"]] = data

    def render(self, template_key: str, store: Store, extra_vars: dict) -> str:
        template_data = self._templates.get(template_key)
        if not template_data:
            raise PromptTemplateNotFoundError(f"模板 {template_key} 不存在")

        variables = self._build_store_variables(store)
        variables.update(extra_vars)

        # 检查必需变量
        required = template_data.get("variables", [])
        missing = [v for v in required if v not in variables or variables[v] is None]
        if missing:
            raise PromptVariableMissingError(f"缺少变量: {', '.join(missing)}")

        return template_data["template"].format(**variables)

    def _build_store_variables(self, store: Store) -> dict:
        return {
            "store_name": store.name,
            "city": store.city or "",
            "district": store.district or "",
            "address": store.address or "",
            "phone": store.phone or "",
            "business_hours": store.business_hours or "",
            "price_info": self._format_jsonb(store.pricing),
            "member_card_info": self._format_jsonb(store.member_cards),
            "target_customer": store.target_customers or "",
            "store_advantages": store.advantages or "",
            "store_style": store.style or "",
            "table_count": str(store.table_count or ""),
            "table_types": store.table_types or "",
            "has_coaching": "有陪练" if store.has_coaching else "无陪练",
            "has_tournament": "有比赛" if store.has_tournament else "无比赛",
            "has_parking": "有停车" if store.has_parking else "无停车",
        }

    def _format_jsonb(self, data) -> str:
        if not data:
            return "暂无"
        if isinstance(data, list):
            return "、".join(str(item) for item in data)
        if isinstance(data, dict):
            return "；".join(f"{k}: {v}" for k, v in data.items())
        return str(data)

    def list_templates(self, category: str = None) -> list[dict]:
        """列出可用模板（可选按类别过滤）"""
        templates = self._templates.values()
        if category:
            templates = [t for t in templates if t.get("category") == category]
        return [{"key": t["key"], "name": t["name"], "category": t["category"]} for t in templates]
```

### 7.3 不同 scene_type 对应关系

| 页面操作 | template_key | 用户表单补充变量 |
|---------|-------------|---------------|
| 朋友圈文案 | `copywriting.moments` | tone, scenario |
| 群公告 | `copywriting.group_notice` | topic, urgency |
| 邀约文案 | `copywriting.invitation` | target, time_slot |
| 活动策划 | `activity.planning` | activity_goal, budget_level |
| 员工话术 | `scripts.employee` | scene (嫌贵/问价/推卡...) |
| 社群内容 | `community.daily` | content_type (话题/接龙/群规...) |
| 海报背景 | `poster.background` | theme, mood, aspect_ratio |

---

## 八、海报生成流程设计

### 8.1 完整流程

```
步骤 1: 用户在海报页填表单
         ├── 选择海报类型（充值活动/周赛/搭子群/学生优惠/节日）
         ├── 填写活动标题、活动规则、卖点
         └── 选择视觉风格

步骤 2: 后端 poster_service 接收请求
         │
         ├── 2a. 调用 TextProvider 生成海报文案（如果用户没自己写标题/卖点）
         │        template_key = "poster.copywriting"
         │        → 输出: 标题、副标题、卖点列表
         │
         └── 2b. 调用 ImageProvider 生成背景图（并行执行）
                  template_key = "poster.background"
                  Prompt 关键词: NO text, NO words, NO numbers, NO logos
                  → 输出: 1024x1536 无文字背景图 URL

步骤 3: 下载背景图到本地临时文件

步骤 4: Pillow 合成引擎
         ├── 加载背景图
         ├── 叠加半透明暗色遮罩（提高文字可读性）
         ├── 按模板布局绘制：
         │   ├── 活动标题（大字，思源黑体 Bold，72px）
         │   ├── 副标题/卖点（中字，40px）
         │   ├── 活动规则/优惠内容（小字，28px）
         │   ├── 门店名称（底部）
         │   ├── 地址 + 电话（底部）
         │   ├── Logo（左上角或右上角，从 store.logo_url 加载）
         │   └── 微信二维码（右下角，从 store.qrcode_url 加载）
         └── 输出 PNG bytes

步骤 5: 上传 PNG 到 OSS → 获得 poster_url

步骤 6: 写入 generations 表（type="poster"）

步骤 7: 返回 poster_url 给前端 → 预览 + 下载
```

### 8.2 海报模板定义（伪代码）

```python
# services/poster/templates.py

@dataclass
class TextElement:
    content_key: str         # 对应哪个字段（title / subtitle / rule / store_name...）
    x: int                   # 左上角 x
    y: int                   # 左上角 y
    max_width: int           # 最大宽度（自动换行）
    font_size: int
    font_weight: str         # "bold" / "regular"
    color: str               # "#FFFFFF"
    align: str               # "center" / "left"

@dataclass
class ImageElement:
    content_key: str         # "logo" / "qrcode"
    x: int
    y: int
    width: int
    height: int

@dataclass
class PosterTemplate:
    name: str
    width: int               # 海报宽度 px
    height: int              # 海报高度 px
    overlay_color: tuple     # 遮罩颜色 RGBA
    text_elements: list[TextElement]
    image_elements: list[ImageElement]

# MVP 内置 3 种模板
TEMPLATES = {
    "recharge": PosterTemplate(
        name="充值活动",
        width=1080, height=1920,
        overlay_color=(0, 0, 0, 120),
        text_elements=[
            TextElement("title", x=540, y=400, max_width=900, font_size=80,
                        font_weight="bold", color="#FFFFFF", align="center"),
            TextElement("subtitle", x=540, y=520, max_width=800, font_size=44,
                        font_weight="regular", color="#FFD700", align="center"),
            TextElement("rules", x=540, y=700, max_width=800, font_size=32,
                        font_weight="regular", color="#FFFFFF", align="center"),
            TextElement("store_name", x=540, y=1650, max_width=800, font_size=36,
                        font_weight="bold", color="#FFFFFF", align="center"),
            TextElement("address_phone", x=540, y=1720, max_width=800, font_size=24,
                        font_weight="regular", color="#CCCCCC", align="center"),
        ],
        image_elements=[
            ImageElement("logo", x=40, y=40, width=120, height=120),
            ImageElement("qrcode", x=880, y=1500, width=160, height=160),
        ],
    ),
    "tournament": PosterTemplate(...),
    "student": PosterTemplate(...),
}
```

### 8.3 为什么不直接让 AI 生成完整带字海报

1. **中文文字渲染质量差**：当前所有图片生成模型对中文文字的渲染都不可靠，容易出现错字、模糊、变形、多余笔画
2. **价格数字容易出错**：AI 可能把"充值500送100"生成成"充值5OO送1OO"或者其他变体，商业海报绝对不能出现价格错误
3. **二维码无法生成**：AI 不能生成可扫描的真实二维码，必须用真实图片叠加
4. **Logo 无法还原**：每家店的 Logo 不同，AI 无法凭空生成特定 Logo
5. **布局不可控**：AI 生成的海报布局不可预测，同一 Prompt 每次生成的排版不同，无法保证商业信息的可读性
6. **修改成本高**：如果标题写错一个字，AI 全图方案需要重新生成整张图；分离方案只需改文字重新合成，1 秒完成

**结论：AI 负责"美"（背景视觉），模板引擎负责"准"（商业信息）。这是目前 AI 生图能力下的最佳实践。**

---

## 九、API 初步设计

### 9.1 认证

| 方法 | 路径 | 入参 | 出参 | 权限 | 消耗配额 | 写 generations |
|------|------|------|------|------|---------|--------------|
| POST | `/api/v1/auth/register` | `{phone, password, name}` | `{access_token, user}` | 公开 | 否 | 否 |
| POST | `/api/v1/auth/login` | `{phone, password}` | `{access_token, user}` | 公开 | 否 | 否 |
| GET | `/api/v1/auth/me` | — | `{id, phone, name}` | 需登录 | 否 | 否 |

### 9.2 门店

| 方法 | 路径 | 入参 | 出参 | 权限 | 消耗配额 | 写 generations |
|------|------|------|------|------|---------|--------------|
| POST | `/api/v1/stores` | `{name, city, address, ...全部资料}` | `{store}` | 需登录 | 否 | 否 |
| GET | `/api/v1/stores/me` | — | `{store}` | 需登录+绑定门店 | 否 | 否 |
| PUT | `/api/v1/stores/me` | `{name?, city?, pricing?, ...}` | `{store}` | owner/manager | 否 | 否 |
| POST | `/api/v1/stores/me/logo` | `multipart file` | `{logo_url}` | owner/manager | 否 | 否 |
| POST | `/api/v1/stores/me/qrcode` | `multipart file` | `{qrcode_url}` | owner/manager | 否 | 否 |

### 9.3 内容生成

| 方法 | 路径 | 入参 | 出参 | 权限 | 消耗配额 | 写 generations |
|------|------|------|------|------|---------|--------------|
| POST | `/api/v1/generate/copywriting` | `{sub_type, tone, scenario, extra_note?}` | SSE stream → 最终 `{generation_id, content}` | 需登录+绑定门店 | text ×1 | ✅ |
| POST | `/api/v1/generate/activity` | `{activity_goal, budget_level?, duration?, extra_note?}` | `{generation_id, content}` | 需登录+绑定门店 | text ×1 | ✅ |
| POST | `/api/v1/generate/script` | `{scene}` | `{generation_id, content}` | 需登录+绑定门店 | text ×1 | ✅ |
| POST | `/api/v1/generate/community` | `{content_type}` | `{generation_id, content}` | 需登录+绑定门店 | text ×1 | ✅ |

### 9.4 海报

| 方法 | 路径 | 入参 | 出参 | 权限 | 消耗配额 | 写 generations |
|------|------|------|------|------|---------|--------------|
| POST | `/api/v1/posters/generate` | `{template, title?, rules?, style, mood}` | `{generation_id, poster_url, image_url}` | 需登录+绑定门店 | image ×1 + poster ×1 | ✅ |
| GET | `/api/v1/posters/templates` | — | `[{name, preview_url}]` | 需登录 | 否 | 否 |

### 9.5 工作台

| 方法 | 路径 | 入参 | 出参 | 权限 | 消耗配额 | 写 generations |
|------|------|------|------|------|---------|--------------|
| GET | `/api/v1/dashboard/today` | — | `{date, tasks: [{title, description, action_type, action_params}]}` | 需登录+绑定门店 | 否 | 否 |

### 9.6 历史 & 配额

| 方法 | 路径 | 入参 | 出参 | 权限 | 消耗配额 | 写 generations |
|------|------|------|------|------|---------|--------------|
| GET | `/api/v1/generations` | `?type=&page=&size=` | `{items, total, page}` | 需登录+绑定门店 | 否 | 否 |
| GET | `/api/v1/generations/{id}` | — | `{generation}` | 需登录+绑定门店 | 否 | 否 |
| POST | `/api/v1/generations/{id}/favorite` | — | `{is_favorite}` | 需登录+绑定门店 | 否 | 否 |
| GET | `/api/v1/quota` | — | `{text_gen_used, text_gen_limit, ...}` | 需登录+绑定门店 | 否 | 否 |

---

## 十、开发顺序

### 阶段 1：项目初始化

**目标**：前后端项目骨架搭建完成，能启动运行，数据库能连接。

**涉及文件**：
- `server/main.py`, `config.py`, `pyproject.toml`
- `server/db/session.py`
- `web/package.json`, `next.config.js`, `tailwind.config.ts`
- `web/src/app/layout.tsx`, `web/src/app/page.tsx`
- `docker-compose.yml`（PostgreSQL）

**验收标准**：
- `cd server && uv run fastapi dev main.py` 启动成功，访问 `/docs` 看到 Swagger
- `cd web && pnpm dev` 启动成功，浏览器能打开
- `docker compose up -d postgres` 数据库启动成功
- 前端能显示一个空白首页

**不应该做**：不装多余的依赖包，不写业务逻辑，不创建数据库表。

---

### 阶段 2：认证与门店资料

**目标**：用户能注册、登录、创建门店、填写门店资料。

**涉及文件**：
- 后端：`models/user.py`, `models/store.py`, `schemas/auth.py`, `schemas/store.py`, `api/v1/auth.py`, `api/v1/stores.py`, `core/security.py`, `services/auth_service.py`, `services/store_service.py`, `services/storage_service.py`
- 前端：`(auth)/login/page.tsx`, `(auth)/register/page.tsx`, `(dashboard)/layout.tsx`, `(dashboard)/store-settings/page.tsx`, `lib/api.ts`, `components/layout/sidebar.tsx`
- 数据库迁移：users, stores, store_members 三张表

**验收标准**：
- 能用手机号注册和登录
- 登录后跳转到 dashboard
- 能创建门店并填写全部资料
- 能上传 Logo 和二维码（先存本地，OSS 可后补）
- 未登录访问 dashboard 重定向到登录页
- API 返回正确的 JWT token

**不应该做**：不写 AI 相关代码，不做复杂的角色权限校验（MVP 先默认 owner），不做邀请员工功能。

---

### 阶段 3：AI Provider 与 Prompt Engine

**目标**：AI 调用链路跑通，能通过 Prompt 模板 + 门店资料生成一段文案。

**涉及文件**：
- `services/ai/base.py`, `services/ai/factory.py`, `services/ai/prompt_engine.py`
- `services/ai/providers/deepseek.py`（或 `openai_text.py`，取决于先接哪个模型）
- `prompts/copywriting/moments.yaml`（第一个 Prompt 模板）
- `config.py`（新增 AI API Key 配置）

**验收标准**：
- 写一个测试脚本，传入 store 对象 + template_key，输出渲染后的完整 Prompt
- 调用 TextProvider.generate()，能拿到 AI 返回的中文文案
- 调用 TextProvider.generate_stream()，能逐块 yield 文本
- 缺少 Prompt 变量时抛出明确错误
- 切换 Provider 只需改配置文件

**不应该做**：不做前端页面，不接入图片模型（那是阶段 5），不做多 Provider fallback 逻辑，不做配额检查。

---

### 阶段 4：文案 / 活动 / 话术生成

**目标**：前后端打通，用户能在页面上生成文案、活动方案、员工话术、社群内容。

**涉及文件**：
- 后端：`api/v1/generate.py`, `services/content_service.py`, `models/generation.py`, `schemas/generate.py`, `core/quota.py`
- 前端：`(dashboard)/copywriting/page.tsx`, `(dashboard)/activity/page.tsx`, `(dashboard)/scripts/page.tsx`, `(dashboard)/community/page.tsx`
- 组件：`components/generators/stream-result.tsx`, `components/generators/copy-button.tsx`, `components/generators/result-card.tsx`, `hooks/use-sse-generate.ts`
- Prompt 模板：所有 `prompts/` 下的 YAML 文件
- 数据库迁移：generations 表

**验收标准**：
- 文案生成页面：选类型 → 填表单 → 点生成 → 看到流式输出 → 复制按钮可用
- 活动策划页面：选目标 → 生成完整方案
- 话术页面：选场景 → 生成标准话术
- 社群页面：选内容类型 → 生成社群文案
- 每次生成写入 generations 表
- 配额检查生效（超限提示）
- 手机端可用

**不应该做**：不做海报，不做工作台，不做历史记录页面（只做数据库写入）。

---

### 阶段 5：海报生成

**目标**：AI 生成背景图 + Pillow 合成商业信息 + 预览下载。

**涉及文件**：
- 后端：`services/ai/providers/openai_image.py`, `services/poster/composer.py`, `services/poster/templates.py`, `services/poster_service.py`, `api/v1/poster.py`, `schemas/poster.py`
- 前端：`(dashboard)/poster/page.tsx`, `components/generators/poster-preview.tsx`, `components/generators/generation-progress.tsx`
- 资源：`services/poster/fonts/SourceHanSansSC-Bold.otf`（思源黑体）
- Prompt 模板：`prompts/poster/background.yaml`

**验收标准**：
- 选择海报类型 → 填写活动信息 → 点生成
- 页面显示进度（生成文案... → 生成背景... → 合成海报...）
- 最终显示海报预览图
- 点击下载获得 PNG 文件
- 海报上的中文文字清晰可读，无乱码
- Logo 和二维码正确显示
- 至少 3 种海报模板可用

**不应该做**：不做海报编辑器（不能拖拽调整），不做超过 3 种模板，不做海报模板在线管理。

---

### 阶段 6：今日工作台

**目标**：用户打开系统看到今日运营建议卡片列表。

**涉及文件**：
- 后端：`services/dashboard_service.py`, `api/v1/dashboard.py`
- 前端：`(dashboard)/page.tsx`

**验收标准**：
- 根据星期几显示不同推荐
- 如果门店 has_tournament=true，推荐周赛通知
- 每张卡片有标题、说明、"去生成"按钮
- 点击"去生成"跳转到对应页面

**不应该做**：不做 AI 驱动的智能推荐（规则引擎足够），不接入节假日 API（先硬编码主要节日），不做推荐历史记录。

---

### 阶段 7：历史记录与配额

**目标**：用户能查看生成历史、收藏/取消收藏、查看当月使用量。

**涉及文件**：
- 后端：`api/v1/generations.py`, `api/v1/quota.py`, `services/generation_service.py`
- 前端：`(dashboard)/history/page.tsx`
- 数据库迁移：usage_quotas 表

**验收标准**：
- 历史列表分页显示，按时间倒序
- 可按类型筛选
- 可收藏/取消收藏
- 海报类生成记录显示缩略图
- 文案类记录可重新复制
- 配额页面显示当月已用/上限

**不应该做**：不做批量删除，不做导出 Excel，不做按日统计图表。

---

## 十一、多窗口并行开发建议

### 窗口 A：后端基础 + 数据库

**负责范围**：
- FastAPI 项目初始化（main.py, config.py）
- 数据库模型（所有 models/）
- 数据库连接（db/session.py）
- Alembic 迁移配置和初始迁移
- docker-compose.yml
- 公共依赖注入（api/deps.py）
- 统一异常处理（core/exceptions.py）

**不能碰**：不写业务 API 路由、不写 Service 层、不写 AI 相关代码

**依赖**：无

**交付物**：能启动的 FastAPI 空壳 + 全部数据库表创建完成 + deps.py 导出 `get_db`

---

### 窗口 B：认证 + 门店资料（后端）

**负责范围**：
- `core/security.py`（JWT + bcrypt）
- `api/v1/auth.py` + `services/auth_service.py` + `schemas/auth.py`
- `api/v1/stores.py` + `services/store_service.py` + `schemas/store.py`
- `services/storage_service.py`（文件上传）
- `core/store_context.py`（get_current_store 依赖）

**不能碰**：不写 AI 相关代码、不写生成接口、不写前端

**依赖**：窗口 A 的 models + db/session + deps.py

**交付物**：注册/登录/门店 CRUD 全部 API 可用，Swagger 可测试

---

### 窗口 C：AI Provider + Prompt Engine

**负责范围**：
- `services/ai/base.py`（抽象基类）
- `services/ai/factory.py`
- `services/ai/prompt_engine.py`
- `services/ai/providers/deepseek.py`（至少一个文本 Provider）
- `services/ai/providers/openai_image.py`（图片 Provider）
- 所有 `prompts/*.yaml` 模板文件
- 独立测试脚本验证调用链路

**不能碰**：不写 API 路由、不写前端、不碰数据库模型、不写海报合成

**依赖**：无（AI 层独立于数据库，store 对象通过参数传入）

**交付物**：`ProviderFactory.get_text_provider().generate()` 能返回文案；`PromptEngine.render()` 能输出完整 Prompt；至少 5 个 YAML 模板

---

### 窗口 D：前端页面和组件

**负责范围**：
- Next.js 项目初始化
- 全部页面路由和 layout
- shadcn/ui 组件安装
- 登录/注册页面
- Dashboard 布局（侧边栏 + 顶部栏 + 移动端适配）
- 门店资料表单页面
- 文案/活动/话术/社群生成页面（表单 + 结果展示）
- `lib/api.ts` API 客户端
- `hooks/use-sse-generate.ts`
- 所有 components（copy-button, stream-result, result-card）

**不能碰**：不写后端代码

**依赖**：需要窗口 B 的 API 接口定义（可先用 mock 数据开发页面）

**交付物**：全部前端页面可展示，表单可交互，SSE 组件就绪（对接真实 API 后即可使用）

---

### 窗口 E：海报合成引擎

**负责范围**：
- `services/poster/composer.py`
- `services/poster/templates.py`
- `services/poster/fonts/` 字体文件
- 独立测试脚本（输入一张背景图 + 文字参数 → 输出合成后 PNG）

**不能碰**：不写 API 路由、不写 AI 调用代码、不碰数据库

**依赖**：无（纯图片处理，输入输出都是文件/bytes）

**交付物**：`PosterComposer.compose(config) -> PNG bytes` 可用，至少 3 种模板，中文渲染正确

---

### 窗口 F：代码审查（项目负责人）

**负责范围**：
- 审查各窗口提交的代码
- 检查 store_id 隔离是否到位（所有查询都带 store_id）
- 检查 API 接口设计是否符合本文档定义
- 检查 Pydantic schema 字段命名和类型是否一致
- 检查前后端接口参数是否对齐
- 检查安全问题（SQL 注入、JWT 过期、密码明文等）
- 检查 Prompt 模板变量是否齐全

**不能碰**：不写业务代码

**依赖**：各窗口的产出

**交付物**：代码审查意见 + 通过/打回

---

### 并行时序

```
Week 1:
  窗口 A (后端骨架)  ████████
  窗口 C (AI 层)     ████████████████
  窗口 D (前端)      ████████████████████████
  窗口 E (海报引擎)  ████████████████

Week 2:
  窗口 B (认证+门店) ████████████████  ← 依赖 A 完成
  窗口 C (继续)      ████████
  窗口 D (继续)      ████████████████████████

Week 3:
  集成联调           ████████████████████████
  窗口 F (审查)      ████████████████████████
```

---

## 十二、风险审查

### 高风险

| 风险 | 严重性 | 规避方案 |
|------|--------|---------|
| **store_id 隔离遗漏** | 🔴 数据泄漏 | 每个 Service 方法必须接收 store_id 参数；代码审查重点检查所有 `.where()` 是否带 store_id；可写一个 lint 规则或测试用例批量验证 |
| **AI API Key 泄漏** | 🔴 安全+经济损失 | API Key 只放 server 端环境变量，绝不暴露给前端；.env 加入 .gitignore |
| **海报中文排版错位** | 🟡 用户体验差 | 用思源黑体（开源、中文渲染好）；所有模板预设字号和位置经实际渲染测试；自动换行逻辑要考虑中英文混排 |
| **AI 生图成本失控** | 🟡 运营成本高 | 严格配额限制；MVP 阶段每月每店 30 张图；后端日志监控调用量；考虑缓存相似主题的背景图 |
| **SSE 流式输出兼容性** | 🟡 部分浏览器/代理异常 | 微信浏览器对 SSE 支持有限，准备 fallback 方案：如果 SSE 失败，降级为非流式请求等结果 |

### 中风险

| 风险 | 规避方案 |
|------|---------|
| **AI Provider 过早复杂化** | MVP 只接入 1 个文本模型 + 1 个图片模型，抽象层保持最简单的接口。不做 fallback、不做负载均衡、不做 A/B 测试 |
| **Prompt 硬编码** | 严格执行 YAML 模板方案。代码审查时如果发现 Prompt 字符串出现在 .py 文件里（非 prompt_engine.py），立即打回 |
| **OSS 文件权限** | Logo/二维码/海报图片设为公开读；上传时校验文件类型和大小（Logo < 2MB, 海报 < 10MB）；文件名用 UUID 防猜测 |
| **多窗口接口不一致** | 本文档的 API 设计（第九节）作为唯一接口契约；各窗口开工前先对齐 schemas/；前端先用 mock，后端 API ready 后切换 |
| **配额系统过早设计** | MVP 阶段配额逻辑保持极简——一个函数检查计数、一个函数递增计数。不做套餐体系、不做按天限制、不做管理后台调整限额 |

### 低风险

| 风险 | 规避方案 |
|------|---------|
| AI API 延迟高 (3-10s) | 文案用 SSE 流式缓解体感；海报生成显示三步进度条；前端加 loading 状态 |
| 微信浏览器 clipboard API | 部分安卓微信不支持 `navigator.clipboard`，准备 fallback 用 `document.execCommand('copy')` |
| 手机端海报下载 | 微信浏览器不支持 `<a download>`，用长按保存方案，页面提示"长按图片保存" |

---

# 补充章节（基于原架构扩展，不推翻已有设计）

---

## 十三、台球房运营场景库

本章列出真实台球房日常运营中的所有场景。后续系统中的页面按钮、Prompt 模板、海报模板、表单选项都必须围绕这些场景展开，而不是做成通用 AI 工具。

### 13.1 日常促活场景

| 场景编号 | 场景名称 | 典型触发条件 | 对应系统功能 |
|---------|---------|-------------|-------------|
| D01 | 工作日下午空台促活 | 周一至周五 12:00-17:00 上座率低 | 文案生成 + 活动策划 |
| D02 | 晚间约球邀约 | 每天 17:00-19:00 邀约晚场客流 | 文案生成（群公告/朋友圈） |
| D03 | 周末活动预热 | 周四/周五发布周末活动 | 活动策划 + 海报生成 |
| D04 | 雨天/天冷临时促销 | 恶劣天气导致客流下降 | 文案生成 + 活动策划 |
| D05 | 节假日营销 | 法定节假日/寒暑假 | 活动策划 + 海报生成 |
| D06 | 新店开业曝光 | 开业前后 1-2 周 | 活动策划 + 海报 + 文案 |
| D07 | 老店客流下降促活 | 连续多日上座率走低 | 活动策划 + 会员唤醒文案 |
| D08 | 学生客群促活 | 放学后/周末/寒暑假 | 文案生成 + 海报（学生优惠） |
| D09 | 上班族下班邀约 | 工作日 17:00-20:00 | 文案生成（晚间邀约） |
| D10 | 附近居民休闲促活 | 日常，社区型球房 | 文案生成（温馨休闲风格） |
| D11 | 包间/高端桌型促销 | 包间或高端桌空置 | 文案生成 + 海报 |
| D12 | 陪练/教练课程推广 | 有陪练服务的门店 | 文案生成 + 海报 |
| D13 | 团建包场推广 | 周一至周五日间空闲时段 | 文案生成 + 海报 + 活动策划 |

### 13.2 社群运营场景

| 场景编号 | 场景名称 | 说明 | 对应系统功能 |
|---------|---------|------|-------------|
| S01 | 每日约球接龙 | 搭子群每天发起今晚/明天约球 | 社群内容生成 |
| S02 | 新人进群欢迎语 | 新成员入群自动欢迎 | 社群内容生成 |
| S03 | 群规说明 | 群行为规范，禁止广告等 | 社群内容生成 |
| S04 | 周赛/月赛报名提醒 | 比赛前 3 天发布报名通知 | 社群内容 + 海报 |
| S05 | 群内拼桌/拼局通知 | 有人想打球但缺搭子 | 社群内容生成 |
| S06 | 老会员群互动 | 话题讨论、技巧分享、晒球 | 社群内容生成 |
| S07 | 新手约球引导 | 引导新手不要怕水平不够 | 社群内容生成 |
| S08 | 台球技巧分享 | 每周分享 1-2 条技巧 | 社群内容生成 |
| S09 | 今日空桌提醒 | 空桌较多时在群里通知 | 社群内容生成 |
| S10 | 节假日活动群通知 | 配合活动策划发群公告 | 社群内容 + 活动策划 |
| S11 | 微信群长期沉默激活 | 群超过 3 天无人发言 | 社群内容生成（话题引导） |

### 13.3 员工话术场景

| 场景编号 | 场景名称 | 触发时机 | 话术目标 |
|---------|---------|---------|---------|
| T01 | 客户问价格 | 电话/到店/微信咨询 | 清晰报价 + 引导到店 |
| T02 | 客户嫌贵 | 报价后客户犹豫 | 共情 + 对比价值 + 推会员卡 |
| T03 | 客户第一次进店 | 新客到店 | 热情接待 + 介绍环境 + 引导办卡 |
| T04 | 客户咨询会员卡 | 客户主动问 | 介绍套餐 + 对比优惠 |
| T05 | 客户犹豫是否办卡 | 已了解套餐但未决定 | 限时优惠 + 使用场景引导 |
| T06 | 客户犹豫是否充值 | 已有会员卡考虑充值 | 充值赠送 + 到期提醒 |
| T07 | 客户问陪练 | 想提升水平的客户 | 介绍教练 + 课程安排 + 试课引导 |
| T08 | 客户问比赛 | 想参赛的客户 | 赛制说明 + 报名方式 + 奖励说明 |
| T09 | 客户问团建包场 | 企业/团体咨询 | 报价 + 配套服务 + 场地说明 |
| T10 | 客户投诉 | 服务/设备/环境问题 | 先道歉共情 + 解决方案 + 补偿 |
| T11 | 客户准备离店 | 结账后即将离开 | 感谢 + 下次邀约 + 引导办卡/加群 |
| T12 | 老会员很久没来 | 30天以上未到店 | 关怀问候 + 专属优惠 + 邀约到店 |
| T13 | 新会员充值后关怀 | 办卡/充值后 1-3 天 | 感谢 + 使用提醒 + 加群引导 |
| T14 | 客户问能否预约 | 电话/微信咨询 | 预约方式 + 可用时段 |
| T15 | 客户问停车/包间/桌型 | 到店前/到店时 | 如实说明设施情况 |

### 13.4 海报营销场景

| 场景编号 | 海报类型 | MVP 是否支持 | 对应模板 |
|---------|---------|-------------|---------|
| P01 | 充值活动海报 | ✅ 第一批 | recharge |
| P02 | 周赛报名海报 | ✅ 第一批 | tournament |
| P03 | 下午畅打海报 | ✅ 第一批 | afternoon |
| P04 | 老会员回归海报 | ✅ 第一批 | comeback |
| P05 | 搭子群招募海报 | ✅ 第一批 | matchmaking |
| P06 | 月赛报名海报 | ❌ V1.1 | — |
| P07 | 学生优惠海报 | ❌ V1.1 | — |
| P08 | 私教/陪练课程海报 | ❌ V1.1 | — |
| P09 | 团建包场海报 | ❌ V1.1 | — |
| P10 | 新店开业海报 | ❌ V1.1 | — |
| P11 | 节假日活动海报 | ❌ V1.1 | — |
| P12 | 生日会员福利海报 | ❌ V1.2 | — |
| P13 | 雨天特惠海报 | ❌ V1.2 | — |

### 13.5 活动策划场景

| 场景编号 | 活动类型 | 核心目标 | 适合客群 |
|---------|---------|---------|---------|
| A01 | 下午场促活 | 提升工作日下午上座率 | 退休人群/自由职业/学生 |
| A02 | 老客回归 | 唤醒沉睡会员 | 30天以上未到店会员 |
| A03 | 新会员二次到店 | 提高新客留存 | 首次到店客户 |
| A04 | 充值赠送 | 锁定长期客户 | 高频到店客户 |
| A05 | 周赛/月赛 | 活跃核心客群 + 口碑传播 | 中高水平球友 |
| A06 | 学生专属 | 吸引学生群体 | 大学生/高中生 |
| A07 | 情侣/朋友局 | 拓展社交场景 | 年轻人/情侣 |
| A08 | 搭子群约球 | 激活社群 + 带动散客 | 社群成员 |
| A09 | 团建包场 | 大额消费 | 企业/团体 |
| A10 | 陪练体验课 | 推广陪练服务 | 新手/想提升的客户 |
| A11 | 节日营销 | 借势节日拉客流 | 全客群 |

---

## 十四、MVP 用户主流程

### 14.1 首次使用流程

```
1. 用户打开系统网址（PC 或手机浏览器）
2. 点击"注册"
3. 输入手机号 + 设置密码 + 填写姓名
4. 注册成功，自动登录
5. 系统检测到该用户没有绑定门店 → 跳转到"创建门店"引导页
6. 填写门店名称（必填）
7. 填写城市/区域/详细地址（必填）
8. 填写营业时间（必填）
9. 填写联系电话（必填）
10. 填写基础价格（必填，JSONB 格式：如"中式 30元/小时, 美式 40元/小时"）
11. 上传 Logo（建议填写）
12. 上传微信二维码（建议填写）
13. 填写球桌数量、桌型、会员卡套餐（建议填写）
14. 填写是否有包间/陪练/比赛/停车（建议填写）
15. 填写门店风格、主要客群、门店优势（建议填写）
16. 点击"保存门店资料"
17. 系统计算门店资料完整度并显示
18. 跳转到今日运营工作台
19. 查看今日推荐运营任务
20. 点击"生成朋友圈文案"
21. 选择文案类型、语气、场景
22. 点击"生成"
23. 看到 AI 流式输出文案
24. 点击"复制" → 切换到微信 → 粘贴发朋友圈
```

### 14.2 日常使用流程

```
1. 店长每天上班后打开系统
2. 进入今日运营工作台
3. 看到今日推荐：
   - "发一条朋友圈，吸引下午客流"
   - "发一条搭子群约球接龙"
   - "准备员工推卡话术"
4. 点击"发朋友圈" → 跳转到文案生成页
5. 系统已预选"朋友圈"类型 + 当前时段匹配的场景
6. 店长微调语气和补充说明（可选）
7. 点击"生成"
8. AI 输出 3 条备选文案
9. 店长选中满意的一条 → 点击"复制"
10. 切换到微信发朋友圈
11. 返回系统 → 点击下一个推荐任务
12. 生成记录自动保存到历史
```

### 14.3 文案生成详细流程

```
用户操作                          系统行为
─────────                        ─────────
进入文案生成页面             →    显示文案类型按钮组：朋友圈 / 群公告 / 邀约文案
选择"朋友圈"                →    展开朋友圈专属表单
选择语气（活泼/专业/亲切）    →    记录 tone 参数
选择场景（日常/促销/赛事/节日）→    记录 scenario 参数
输入补充说明（可选）          →    记录 extra_note 参数
点击"生成文案"               →    1. 检查门店资料完整度
                                  2. 检查配额
                                  3. 从 Store 对象提取标准变量
                                  4. 加载 copywriting.moments YAML 模板
                                  5. 渲染 Prompt（门店变量 + 表单变量）
                                  6. 调用 TextProvider.generate_stream()
                                  7. SSE 流式返回文案内容
                                  8. 写入 generations 表
看到文案逐字输出              →    前端 stream-result 组件实时渲染
点击"复制"                   →    文案内容写入剪贴板，Toast 提示"已复制"
点击"收藏"                   →    更新 generation.is_favorite = true
点击"重新生成"               →    用相同参数重新调用，消耗 1 次配额
```

### 14.4 活动方案生成详细流程

```
用户操作                          系统行为
─────────                        ─────────
进入活动策划页面             →    显示活动目标选择：
                                  拉人气 / 卖会员卡 / 做比赛 / 老客回流 /
                                  学生优惠 / 搭子群活跃 / 团建包场 / 节日营销
选择"拉人气"                →    展开参数表单
选择目标客群                 →    记录 target_customer
选择优惠力度（轻度/中度/大力）→    记录 budget_level
选择活动时长                 →    记录 duration
输入补充说明（可选）          →    记录 extra_note
点击"生成活动方案"           →    1. 检查门店资料
                                  2. 加载 activity.planning YAML 模板
                                  3. 渲染 Prompt
                                  4. 调用 TextProvider.generate()
                                  5. 返回完整方案
看到完整活动方案              →    方案内容包括：
                                  - 活动名称和主题
                                  - 活动规则
                                  - 适合人群
                                  - 优惠建议（基于门店真实价格）
                                  - 执行流程（前中后）
                                  - 宣传节奏（提前几天做什么）
                                  - 员工执行 SOP
                                  - 1 条朋友圈文案
                                  - 1 条群公告
                                  - 1 条私聊话术
点击"生成配套海报"           →    跳转到海报生成页，预填活动标题和规则
```

### 14.5 海报生成详细流程

```
用户操作                          系统行为
─────────                        ─────────
进入海报生成页面             →    显示海报类型选择：
                                  充值活动 / 周赛报名 / 下午畅打 / 老会员回归 / 搭子群招募
选择"充值活动"               →    展开表单 + 切换到 recharge 模板
填写活动标题                 →    如不填，AI 自动生成
填写活动规则/优惠内容         →    如"充500送100"
选择视觉风格（大气/潮酷/温馨）→    记录 style 参数
点击"生成海报"               →    前端显示三步进度条：
                                  ① 生成文案... → 调用 TextProvider 生成标题/卖点
                                  ② 生成背景... → 调用 ImageProvider 生成无文字背景图
                                  ③ 合成海报... → Pillow 合成：
                                     背景图 + 暗色遮罩
                                     + 活动标题（大字居中）
                                     + 活动规则（中字）
                                     + 门店名称（底部）
                                     + 地址 + 电话（底部）
                                     + Logo（左上角）
                                     + 微信二维码（右下角）
                                  ④ 上传到 OSS → 返回 poster_url
看到海报预览                 →    显示完整海报图片
点击"下载海报"               →    PC：触发文件下载
                                  手机/微信：显示"长按图片保存"提示
```

---

## 十五、AI 功能输入输出规格

### 15.1 朋友圈文案生成

**输入字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sub_type | enum | 是 | `moments`（朋友圈）/ `group_notice`（群公告）/ `invitation`（邀约） |
| tone | enum | 是 | `lively`（活泼）/ `professional`（专业）/ `friendly`（亲切）/ `humorous`（幽默） |
| scenario | enum | 是 | `daily`（日常）/ `promotion`（促销）/ `tournament`（赛事）/ `holiday`（节日）/ `weather`（天气相关）/ `evening`（晚间邀约）/ `student`（学生） |
| extra_note | string | 否 | 用户补充说明，最多 200 字 |
| with_activity | boolean | 否 | 是否关联当前活动信息 |

**输出结构：**

```json
{
  "generation_id": "uuid",
  "contents": [
    {
      "text": "第一条文案正文...",
      "suggested_time": "建议下午 14:00-16:00 发布",
      "image_suggestion": "建议配一张球桌环境图或活动价格图"
    },
    {
      "text": "第二条文案正文...",
      "suggested_time": "建议晚上 18:00-19:00 发布",
      "image_suggestion": "建议配一张打球氛围图"
    },
    {
      "text": "第三条文案正文...",
      "suggested_time": "建议上午 10:00-11:00 发布",
      "image_suggestion": "建议配门店环境图"
    }
  ]
}
```

**说明**：每次生成输出 3 条备选文案，每条附带建议发布时间和配图建议。用户选择满意的一条复制使用。

### 15.2 群公告生成

**输入字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_type | enum | 是 | `general`（普通会员群）/ `matchmaking`（搭子群）/ `tournament`（赛事群）/ `vip`（VIP群） |
| purpose | enum | 是 | `activity_notice`（活动通知）/ `daily_topic`（日常话题）/ `matchmaking`（约球接龙）/ `rule`（群规）/ `welcome`（新人欢迎）/ `benefit`（福利通知） |
| activity_info | string | 否 | 关联的活动信息 |
| tone | enum | 是 | `formal`（正式）/ `casual`（轻松）/ `urgent`（紧急） |
| need_checkin | boolean | 否 | 是否需要接龙/报名格式 |
| extra_note | string | 否 | 补充说明 |

**输出结构：**

```json
{
  "generation_id": "uuid",
  "formal_version": "正式版群公告...",
  "casual_version": "轻松互动版群公告...",
  "checkin_version": "接龙版（含报名格式）...\n\n报名接龙：\n1. \n2. \n3. ",
  "tips": "注意事项：建议在晚上 19:00-20:00 发布，此时群成员在线率最高"
}
```

### 15.3 活动策划生成

**输入字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| activity_goal | enum | 是 | `traffic`（拉人气）/ `membership`（卖会员卡）/ `tournament`（做比赛）/ `comeback`（老客回流）/ `student`（学生优惠）/ `community`（搭子群活跃）/ `team_building`（团建包场）/ `holiday`（节日营销）/ `coaching`（陪练推广） |
| target_customer | enum | 否 | `all`（全部）/ `new`（新客）/ `old`（老客）/ `student`（学生）/ `office_worker`（上班族）/ `family`（家庭） |
| budget_level | enum | 否 | `light`（轻度优惠）/ `medium`（中度优惠）/ `heavy`（大力优惠） |
| duration | string | 否 | 活动持续时间，如"3天""1周""周末两天" |
| need_poster | boolean | 否 | 是否需要配套海报 |
| need_group_notice | boolean | 否 | 是否需要配套群公告 |
| extra_note | string | 否 | 补充说明 |

**输出结构：**

```json
{
  "generation_id": "uuid",
  "activity_name": "活动名称",
  "theme": "活动主题一句话描述",
  "rules": "活动规则详情（基于门店真实价格）",
  "target_audience": "适合人群说明",
  "schedule": {
    "preparation": "活动前准备事项",
    "promotion_timeline": "D-3: 朋友圈预热\nD-2: 群公告\nD-1: 私聊邀约\nD-Day: 执行",
    "execution": "活动当天流程",
    "followup": "活动后跟进"
  },
  "employee_sop": [
    "步骤1: 开门前检查活动物料...",
    "步骤2: 客户到店时主动提醒活动...",
    "步骤3: 活动结束前引导办卡/充值..."
  ],
  "copywriting": {
    "moments": "朋友圈文案...",
    "group_notice": "群公告文案...",
    "private_chat": "私聊邀约话术..."
  },
  "warnings": "注意事项：不要过度承诺，确保优惠在可承受范围内"
}
```

### 15.4 员工话术生成

**输入字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| scene | enum | 是 | 对应 T01-T15 场景编号，如 `price_inquiry` / `too_expensive` / `first_visit` / `membership_inquiry` / `hesitate_card` / `hesitate_recharge` / `coaching_inquiry` / `tournament_inquiry` / `team_building` / `complaint` / `leaving` / `old_member_recall` / `new_member_care` / `reservation` / `facility_inquiry` |
| reply_style | enum | 否 | `standard`（标准）/ `warm`（温和）/ `sales`（强转化），默认 standard |
| extra_note | string | 否 | 补充说明，如"客户是老会员""客户带了3个朋友" |

**输出结构：**

```json
{
  "generation_id": "uuid",
  "standard_reply": "标准回复话术...",
  "warm_reply": "温和版（更柔和，适合投诉/犹豫场景）...",
  "sales_reply": "转化版（引导办卡/充值/到店）...",
  "do_not_say": [
    "不要说'我们这很便宜'",
    "不要说'别人家更贵'",
    "不要说'你不办卡就亏了'"
  ],
  "tips": "注意事项：先回应客户关切，再引导消费"
}
```

### 15.5 社群内容生成

**输入字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_type | enum | 是 | `general` / `matchmaking` / `tournament` / `vip` |
| content_type | enum | 是 | `daily_topic`（今日话题）/ `matchmaking`（约球接龙）/ `welcome`（新人欢迎语）/ `rules`（群规）/ `tournament_notice`（比赛通知）/ `benefit`（福利提醒）/ `skill_sharing`（技巧分享）/ `empty_table`（空桌提醒） |
| related_activity | string | 否 | 关联活动信息 |
| extra_note | string | 否 | 补充说明 |

**输出结构：**

```json
{
  "generation_id": "uuid",
  "content": "主要内容文本...",
  "alternative": "备选版本...",
  "emoji_version": "带表情符号的活泼版本...",
  "tips": "建议在 XX 时间发布效果最好"
}
```

### 15.6 海报生成

**输入字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| template | enum | 是 | `recharge` / `tournament` / `afternoon` / `comeback` / `matchmaking` |
| title | string | 否 | 活动标题，不填则 AI 自动生成 |
| subtitle | string | 否 | 副标题/卖点 |
| rules | string | 否 | 活动规则/优惠内容 |
| style | enum | 是 | `luxury`（大气）/ `cool`（潮酷）/ `warm`（温馨）/ `sport`（运动）/ `neon`（霓虹灯风格） |
| use_ai_background | boolean | 否 | 是否使用 AI 生成背景图，默认 true |

**输出结构：**

```json
{
  "generation_id": "uuid",
  "poster_url": "https://oss.xxx.com/posters/uuid.png",
  "background_url": "https://oss.xxx.com/backgrounds/uuid.png",
  "poster_title": "合成到海报上的标题",
  "poster_subtitle": "合成到海报上的副标题",
  "moments_text": "配套朋友圈配文，可直接复制发布",
  "group_text": "配套群公告文案"
}
```

**说明**：海报生成同时输出配套的朋友圈配文和群公告文案，方便用户一站式使用。

---

## 十六、AI 内容质量标准

本章作为后续 Prompt 设计、测试验收和代码审查的硬性依据。

### 16.1 文案质量标准

**必须遵守：**
- 语气自然，像真人写的朋友圈/群消息，不像机器人广告
- 不夸张承诺：禁止出现"稳赚""爆满""100%成交""保证到店""全城最低"等用语
- 不编造信息：涉及价格、地址、营业时间、会员卡的内容，必须来自门店资料
- 朋友圈文案长度 80-180 字，不超过 200 字
- 群公告要清晰、直接、可执行，重点信息前置
- 私聊话术要像真人说话，不要过度营销
- 每条文案不超过 3 个 emoji
- 不要用"亲""宝""家人们"等过度营销称呼（除非门店风格明确要求）

**门店资料缺失时的处理规则：**
- 如果缺少价格信息：文案中不提具体价格，改为"到店咨询"或"详询前台"
- 如果缺少地址信息：文案中不提地址，改为"导航搜索门店名称"
- 如果缺少会员卡信息：文案中不提会员卡优惠
- 系统在生成结果中附加提示："建议补充门店价格信息，文案效果更好"

### 16.2 活动方案质量标准

**必须遵守：**
- 必须包含可执行的步骤，不只是创意口号
- 必须说明适合人群和活动时间
- 必须包含宣传节奏（提前几天做什么）
- 必须包含员工执行 SOP（至少 3 步）
- 必须包含至少 1 条朋友圈文案 + 1 条群公告 + 1 条私聊话术
- 优惠建议必须基于门店真实价格，不能随意编造折扣
- 如果门店价格为"中式 30元/小时"，不能建议"全场 5 元/小时"这种明显亏损方案
- 如果用户选择"轻度优惠"，不应输出"充500送500"这种重度优惠方案

### 16.3 员工话术质量标准

**必须遵守：**
- 口语化，前台员工可以直接照着说
- 不要太官方，不要像客服脚本
- 不要给客户压迫感
- 不得虚假承诺，不得诱导欺骗
- 对客户嫌贵、投诉等场景：先共情认同，再引导
- 会员卡和充值话术：不夸张收益承诺，不说"稳赚不亏"
- 每种场景提供标准版 + 温和版 + 转化版，让员工根据实际情况选用
- 附带"不建议说的话"清单

### 16.4 图片生成质量标准

**必须遵守：**
- AI 图片模型 Prompt 必须包含 `NO text, NO words, NO letters, NO numbers, NO logos, NO QR codes`
- 生成的背景图必须符合台球房场景（球桌、球杆、台球、灯光等元素）
- 背景图中心区域要留白或留暗区，方便后续叠加文字
- 不生成任何品牌商标或 Logo
- 不生成真人肖像
- 不生成与台球无关的内容
- 图片风格必须服务于海报模板，不是独立艺术作品

### 16.5 禁止 AI 编造规则（硬性红线）

**AI 不得编造以下信息，必须从门店资料读取：**

| 信息类型 | 如果门店资料中没有 |
|---------|------------------|
| 门店地址 | 不提地址，改为"导航搜索门店名称" |
| 营业时间 | 不提时间，改为"详询前台" |
| 价格 | 不提具体价格，改为"到店咨询" |
| 会员卡套餐 | 不提会员卡，不编造套餐 |
| 优惠活动 | 不编造折扣，只做一般性引导 |
| 联系电话 | 不提电话 |
| 停车信息 | 不提停车 |
| 比赛奖励 | 不编造奖金/奖品 |
| 教练资质 | 不编造教练头衔或成绩 |
| 包间情况 | 不编造包间数量或价格 |

**实现方式**：Prompt 模板末尾统一追加一段约束指令：

```
重要约束：
- 你只能使用上方提供的门店信息，不得编造任何价格、地址、电话、活动、会员卡等内容
- 如果上方某项信息标注为"暂无"，你不得在输出中提及该项，也不得自行编造
- 涉及具体金额时，必须与上方价格信息一致
```

---

## 十七、门店资料完整度机制

### 17.1 资料分类

**必填资料（完整度计算权重 60%）：**

| 字段 | 权重 |
|------|------|
| 门店名称 | 10% |
| 城市/区域 | 5% |
| 详细地址 | 10% |
| 营业时间 | 10% |
| 联系电话 | 5% |
| 基础价格 | 15% |
| 主要客群 | 5% |

**建议填写资料（完整度计算权重 40%）：**

| 字段 | 权重 |
|------|------|
| Logo | 5% |
| 微信二维码 | 5% |
| 球桌数量和桌型 | 3% |
| 会员卡套餐 | 7% |
| 是否有包间 | 2% |
| 是否有陪练 | 2% |
| 是否有比赛 | 2% |
| 是否有停车 | 2% |
| 门店风格 | 3% |
| 门店优势 | 4% |
| 常用活动 | 5% |

### 17.2 完整度等级与功能权限

| 完整度 | 等级 | 可用功能 | 系统提示 |
|--------|------|---------|---------|
| 0-39% | 🔴 不完整 | 只能生成通用文案（不含价格/地址/会员卡信息） | "门店资料不完整，生成内容可能不够精准，建议先完善资料" |
| 40-69% | 🟡 基本完整 | 可生成文案、活动策划、社群内容 | "建议补充会员卡和价格信息，AI 能生成更精准的内容" |
| 70-100% | 🟢 完整 | 全部功能可用，包括海报、个性化话术 | 不提示 |

### 17.3 生成前校验规则

| 用户操作 | 校验字段 | 缺失时行为 |
|---------|---------|-----------|
| 生成价格类话术 | pricing | 弹窗提示"请先完善门店价格信息"，跳转门店设置 |
| 生成会员卡推销话术 | member_cards | 弹窗提示"请先填写会员卡套餐信息" |
| 生成比赛活动方案 | has_tournament + 比赛相关信息 | 弹窗提示"请先确认门店是否举办比赛，并填写比赛信息" |
| 生成团建包场方案 | has_private_room | 弹窗提示"请先填写包间/包场信息" |
| 生成海报（任意类型） | name + address + phone | 缺 name 阻断；缺 address/phone 允许继续，提示"海报底部信息不完整" |
| 生成海报（任意类型） | logo_url, qrcode_url | 允许继续，合成时跳过缺失项，提示"建议上传 Logo 和二维码" |
| 生成陪练推广文案 | has_coaching | 弹窗提示"请先确认门店是否提供陪练服务" |

### 17.4 实现方式

```python
# services/store_service.py

def calculate_completeness(store: Store) -> int:
    """计算门店资料完整度百分比"""
    score = 0
    # 必填项 60%
    if store.name: score += 10
    if store.city: score += 5
    if store.address: score += 10
    if store.business_hours: score += 10
    if store.phone: score += 5
    if store.pricing: score += 15
    if store.target_customers: score += 5
    # 建议项 40%
    if store.logo_url: score += 5
    if store.qrcode_url: score += 5
    if store.table_count and store.table_types: score += 3
    if store.member_cards: score += 7
    if store.has_private_room is not None: score += 2
    if store.has_coaching is not None: score += 2
    if store.has_tournament is not None: score += 2
    if store.has_parking is not None: score += 2
    if store.style: score += 3
    if store.advantages: score += 4
    if store.common_activities: score += 5
    return score

def check_fields_for_generation(store: Store, gen_type: str, sub_type: str) -> list[str]:
    """检查生成特定内容所需的门店字段，返回缺失字段列表"""
    missing = []
    if gen_type == "script" and sub_type in ("price_inquiry", "too_expensive"):
        if not store.pricing:
            missing.append("pricing")
    if gen_type == "script" and sub_type in ("membership_inquiry", "hesitate_card", "hesitate_recharge"):
        if not store.member_cards:
            missing.append("member_cards")
    if gen_type == "activity" and sub_type == "tournament":
        if not store.has_tournament:
            missing.append("has_tournament")
    if gen_type == "poster":
        if not store.name:
            missing.append("name")
    # ... 更多规则
    return missing
```

---

## 十八、MVP 海报模板范围

### 18.1 第一批模板（MVP 5 个）

| 模板 ID | 名称 | 尺寸 | 主色调 | 适用场景 |
|---------|------|------|--------|---------|
| recharge | 充值活动 | 1080×1920 | 金色+深色 | 充值送、储值优惠 |
| tournament | 周赛报名 | 1080×1920 | 红色+黑色 | 周赛、月赛、挑战赛 |
| afternoon | 下午畅打 | 1080×1920 | 蓝色+白色 | 下午场优惠、时段特价 |
| comeback | 老会员回归 | 1080×1920 | 暖橙+深色 | 会员唤醒、老友回归 |
| matchmaking | 搭子群招募 | 1080×1920 | 绿色+白色 | 约球群招募、社交拼桌 |

### 18.2 统一布局结构

所有模板共用一套基础布局，只在色彩、字体大小、元素位置上有差异：

```
┌─────────────────────────────┐
│  [Logo]          [门店名称]  │  ← 顶部区域 (y: 40-160)
│                             │
│                             │
│                             │
│       ██ 主标题 ██           │  ← 中上区域 (y: 350-500)
│                             │
│       副标题 / 活动卖点       │  ← 中部 (y: 520-600)
│                             │
│     ─────────────────       │
│     活动规则 / 优惠详情       │  ← 中下区域 (y: 650-900)
│     第一条规则               │
│     第二条规则               │
│     第三条规则               │
│     ─────────────────       │
│                             │
│                             │
│     📍 门店地址              │  ← 底部区域 (y: 1600-1800)
│     📞 联系电话              │
│                 [二维码]     │  ← 右下角 (x: 860, y: 1500)
└─────────────────────────────┘
```

### 18.3 每个模板的差异点

| 模板 | 遮罩颜色 | 标题字色 | 副标题字色 | 规则字色 | 特殊元素 |
|------|---------|---------|-----------|---------|---------|
| recharge | rgba(0,0,0,0.5) | #FFD700 (金) | #FFFFFF | #FFFFFF | 价格数字放大加粗 |
| tournament | rgba(139,0,0,0.6) | #FF4444 (红) | #FFFFFF | #FFFFFF | 奖项信息高亮 |
| afternoon | rgba(0,0,80,0.4) | #FFFFFF | #87CEEB (天蓝) | #FFFFFF | 时间段信息突出 |
| comeback | rgba(80,40,0,0.5) | #FFA500 (橙) | #FFFFFF | #FFFFFF | "欢迎回来"装饰文字 |
| matchmaking | rgba(0,60,0,0.4) | #FFFFFF | #90EE90 (浅绿) | #FFFFFF | 群二维码放大 |

### 18.4 明确不做的功能

- ❌ 拖拽编辑器
- ❌ 自由图层编辑
- ❌ 在线 PS 类功能
- ❌ 用户自由改字体/字号/颜色
- ❌ 复杂模板管理后台
- ❌ 用户上传任意背景后自由设计
- ❌ 多人协同编辑海报
- ❌ 海报版本对比
- ❌ 视频海报/动态海报
- ❌ 批量生成海报

用户唯一能做的是：选模板 → 填内容 → 选风格 → 生成 → 下载。

---

## 十九、多模型开发协作规则

### 19.1 总原则

1. `CLAUDE.md` 是最高优先级项目规则，任何开发模型不得违反
2. `architecture-design.md` 是当前阶段架构依据，任何模型不得擅自推翻
3. 任何开发窗口不得擅自修改技术栈（如把 FastAPI 换成 Django，把 Next.js 换成 Nuxt）
4. 任何开发窗口不得新增未规划功能（如加聊天机器人、加自动群发）
5. 每个窗口只负责自己的模块，不跨模块修改文件
6. 涉及公共接口、数据库字段、目录结构修改，必须先向项目负责人确认

### 19.2 执行开发模型规则（适用于 Claude Code / DeepSeek）

**每次任务必须明确以下信息：**

```
任务：{具体任务描述}
当前阶段：{阶段 1-7}
当前模块：{模块名}
允许修改的文件：{文件路径列表}
禁止修改的文件：{文件路径列表}
验收标准：{具体标准}
```

**执行纪律：**

- 只负责写代码，不负责重新设计产品方向
- 不得擅自增加数据库表或字段
- 不得擅自增加 API 路由
- 不得擅自安装未规划的依赖包
- 不得跨模块修改文件（如写 AI Provider 时不能改 auth 模块）
- 不得提前实现未规划功能（如在阶段 3 就做 SSE）
- 如果遇到设计文档未覆盖的情况，应停下来问，而不是自行决定
- 代码提交前必须确保自己的模块能独立运行或通过测试

### 19.3 顾问审查模型规则（适用于 Opus）

**审查职责：**
- 架构审查：是否符合 CLAUDE.md 和 architecture-design.md
- 代码审查：代码质量、安全性、可维护性
- 风险识别：潜在的安全问题、性能瓶颈、设计缺陷

**审查输出格式：**

```
## 审查结果：{通过 / 需修改}

### 必须修改（阻断性问题）
- [ ] 问题描述 → 修改建议

### 建议优化（非阻断性）
- [ ] 问题描述 → 优化建议

### 可以接受
- [x] 对已实现功能的确认

### 潜在风险
- ⚠️ 风险描述 → 后续关注
```

**审查重点清单：**
- store_id 数据隔离：所有查询是否都带 store_id 过滤
- Prompt 硬编码：是否有 Prompt 字符串出现在 .py 文件中（prompt_engine.py 除外）
- AI Provider 抽象：业务代码是否直接调用具体模型 SDK（应通过 ProviderFactory）
- 海报合成稳定性：中文是否乱码、布局是否错位、缺失字段是否优雅降级
- 安全问题：JWT 是否正确校验、密码是否明文存储、API Key 是否暴露给前端
- 隐私问题：用户数据是否跨门店泄漏

### 19.4 公共接口变更规则

| 变更类型 | 流程 |
|---------|------|
| API 入参新增可选字段 | 开发者提出 → 更新 schemas/ → 通知前端 |
| API 入参修改/删除字段 | 必须先向项目负责人确认 → 更新 schemas/ + 前端类型 + 文档 |
| API 出参结构变更 | 必须先向项目负责人确认 → 更新 schemas/ + 前端类型 + 文档 |
| 数据库新增字段 | 说明业务用途 → 确认是否需要 store_id → 生成 Alembic 迁移 → 更新 schemas + service |
| 数据库删除/改名字段 | 必须先向项目负责人确认 |
| Prompt 模板变量变更 | 同步更新 YAML 模板 + prompt_engine 校验 + 前端表单 |

### 19.5 数据库字段变更规则

1. 不允许执行模型随意增加字段
2. 新字段必须说明业务用途
3. 所有业务表必须考虑 store_id 绑定
4. 所有涉及门店数据的查询必须过滤 store_id
5. 字段新增后需要同步更新：ORM 模型 → Pydantic schema → Service 层 → API 路由 → 前端 TypeScript 类型
6. 每次数据库变更必须生成 Alembic 迁移文件，不允许手动改数据库

---

## 二十、实际开发执行策略修正版

### 20.1 更保守的 MVP 执行策略

原架构文档的 Sprint 计划是理想化的。以下是更保守、更务实的执行策略，目的是降低第一版开发风险：

| 序号 | 策略 | 理由 |
|------|------|------|
| 1 | P0 先不做 SSE 流式输出，先做普通 HTTP 请求等结果返回 | SSE 涉及前后端联调复杂度高，先跑通核心链路再优化体验 |
| 2 | P0 先不做复杂配额检查，只在 generations 表记录调用次数 | 配额系统是运营层面的，先确保功能可用 |
| 3 | 登录先做手机号+密码，不接短信验证码 | 短信接口涉及第三方服务采购和审核，MVP 不必要 |
| 4 | Prompt Engine 先用本地 YAML，不做数据库管理 | YAML 修改快、迭代快、不需要后台管理 |
| 5 | AI Provider 先只接一个文本模型（DeepSeek 或 OpenAI），不做多模型 fallback | 先验证 Prompt 质量，多模型是锦上添花 |
| 6 | 海报先用本地预置的静态背景图 + Pillow 合成跑通 | 先验证合成流程和中文排版质量，再接 AI 生图 |
| 7 | 合成流程稳定后再接 AI 图片生成模型 | 避免一开始就依赖两个外部 API |
| 8 | 文件存储先用本地目录 `server/uploads/`，后续再切 OSS | 本地开发简单，不需要配置云服务 |
| 9 | 图片生成不做并发和队列，同步处理 | MVP 并发量低，FastAPI BackgroundTasks 足够 |
| 10 | 历史记录先只做保存和列表展示，不做搜索和筛选 | 先有数据，再做查询优化 |
| 11 | 今日工作台先用硬编码规则引擎，不做复杂 AI 推荐 | 规则引擎足够覆盖 80% 场景 |

### 20.2 修正后的阶段目标

```
第 1 步：项目骨架
         前后端能启动，数据库能连接，空白页面能打开
         ↓
第 2 步：认证和门店资料
         能注册登录，能创建门店填资料，能上传 Logo/二维码（存本地）
         ↓
第 3 步：Prompt Engine + 假 Provider
         YAML 模板能加载，变量能替换
         先写一个 MockTextProvider（返回固定文本），验证整条链路
         ↓
第 4 步：接入一个真实文本模型
         把 MockProvider 替换为 DeepSeekProvider 或 OpenAITextProvider
         验证门店资料注入 Prompt 后 AI 输出质量
         ↓
第 5 步：文案和活动生成（前后端联调）
         文案生成页面可用（选场景→填表单→生成→复制）
         活动策划页面可用
         话术和社群内容页面可用
         每次生成写入 generations 表
         ↓
第 6 步：Pillow 本地海报合成
         先用 3 张预置的静态背景图
         Pillow 合成引擎能叠加标题/规则/Logo/二维码
         验证中文排版效果
         海报预览和下载可用
         ↓
第 7 步：接入 AI 图片模型
         把静态背景图替换为 AI 生成的背景图
         验证 AI 生图质量 + 合成效果
         ↓
第 8 步：历史记录 + 今日工作台
         历史记录列表可查看
         收藏功能可用
         今日工作台显示推荐任务
         ↓
第 9 步：体验优化
         SSE 流式输出替换普通请求
         配额检查逻辑
         文件存储切换到 OSS
         移动端适配优化
         微信浏览器兼容性测试
```

### 20.3 策略目的

1. **降低第一版开发风险**：每一步都有明确的交付物和验收标准，不依赖多个外部服务同时 Ready
2. **避免一开始集成太多外部服务**：先跑通本地链路（Mock Provider + 本地存储 + 静态背景图），再逐步接入真实 API
3. **先验证产品核心体验**：在第 5 步结束时就有一个可用的文案生成工具，可以给真实台球房老板试用
4. **先验证 Prompt 质量**：第 4 步专门验证"门店资料注入后 AI 输出是否靠谱"，这是整个产品的核心
5. **先验证海报合成质量**：第 6 步用静态背景图验证 Pillow 合成效果和中文排版，不受 AI 生图质量影响
6. **逐步接入商业化能力**：SSE、OSS、配额、AI 生图都放到后期，确保核心功能稳定后再叠加
