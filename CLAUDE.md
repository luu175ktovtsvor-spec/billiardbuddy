# 球房 AI 运营助手

> **🧭 新会话先在这定位"项目当前状态"（权威来源，按此为准）：**
> 1. 本文件「已完成功能」表 = 已上线功能清单（实时维护）；
> 2. `docs/遗留工作清单.md` 顶部「现状速览」= 最近进展 + 还有效的待办；
> 3. `docs/耦合地图与改动检查清单.md` = **改前必看**，跨模块连带影响。
>
> ⚠️ **`docs/archive/` 里全是历史快照，别当现状**（里面可能写着已撤销的方案，如"8443独立端口"）。文档地图见 `docs/README.md`。生产当前提交以 `git -C 服务器 log` 或部署文档为准。

## 项目简介

面向台球房行业的 AI 运营辅助 SaaS 工具。帮助台球房老板/店长/员工完成文案生成、活动策划、海报制作、员工话术、社群运营等日常运营工作。

**这不是**收银系统、灯控系统、会员管理系统。不做开台、计费、灯控、收银、库存、会员充值。

## 线上环境

| 项目 | 值 |
|------|-----|
| **生产域名** | https://zzyppz.cn |
| **服务器 IP** | 47.77.237.250（阿里云 ECS 美国硅谷） |
| **SSH** | `ssh root@47.77.237.250`，密码 `Cch245461635` |
| **前端** | Next.js 14 standalone，端口 3000，Nginx 反代 |
| **后端** | FastAPI + uvicorn，端口 8000 |
| **数据库** | PostgreSQL 14，库名 `billiards_ai`，用户 `billiards`，密码 `billiards123` |
| **SSL** | Let's Encrypt 自动续期（Certbot） |
| **GitHub** | https://github.com/luu175ktovtsvor-spec/billiards-ai-ops（私有仓库） |

## AI 模型配置

| 用途 | 模型 | 说明 |
|------|------|------|
| 文本生成 | DeepSeek V4 Flash | 通过 `https://api.deepseek.com`；并发 2500/账户级（详见「AI 并发与限流」） |
| 图片生成 | OpenAI gpt-image-2 | 一律直连 `https://api.openai.com/v1`（生产+本地均实测可直连，~80ms）；旧 Worker 代理已废弃下线、勿用。⚠️ 限额/测试铁律见「AI 并发与限流」，**测试前必读** |

## 技术栈

- **前端**: Next.js 14 + React 18 + TypeScript + TailwindCSS + shadcn/ui
- **后端**: Python 3.12+ + FastAPI + SQLAlchemy + Alembic + borax（农历节日公历换算）
- **数据库**: PostgreSQL 14
- **海报合成**: Pillow (Python) + AI 生图（OpenAI gpt-image-2）
- **包管理**: pnpm (前端) / uv (Python 后端)
- **内容渲染**: react-markdown + remark-gfm + @tailwindcss/typography

## AI 图片生成架构说明

项目中有两个 OpenAI 图片 Provider，选择标准 Image API 而非 Responses API 是有原因的：

| Provider | 文件 | API | 状态 | 原因 |
|----------|------|-----|------|------|
| `OpenAIImageProvider` | `openai_image.py` | `images.generate` + `images.edit` | ✅ 在用 | 标准 Image API，无需组织验证 |
| `OpenAIResponseImageProvider` | `openai_response_image.py` | Responses API（gpt-4o） | ❌ 未注册 | 需要 Organization Verification，无法通过 |

**为什么用标准 Image API：**
- OpenAI 的 Responses API（支持真正多轮对话图片生成）需要完成 **API Organization Verification** 才能使用
- 我们的 OpenAI 账号无法通过组织验证，所以选择了标准 Image API

**"多轮对话"如何实现：**
- 标准 Image API 不支持 `previous_response_id`，无法真正传递多轮上下文
- 我们通过 `images.edit` 接口模拟：把上一张生成的图片作为 `refine_from` 传入，实现"基于此调整"的以图生图效果
- 这是一个务实的 workaround，效果满足需求

**OpenAI 接口地址（`OPENAI_BASE_URL`）：一律直连 `https://api.openai.com/v1`**
- **本机是美国网络**，直连 `api.openai.com` 正常；生产（美国硅谷节点）同样直连（~80ms）。本地开发也直连、不需要任何代理。
- ⚠️ **更正（2026-06-14）**：之前这里写"生图失败是临时网络抖动 + 余额"是**错的**。测试"扣了钱却没出图"的真因是 **超时设太短 + 重试风暴 + Tier1 的 IPM 限额** 叠加，与网络/地域/余额无关——详见下方「**AI 并发与限流**」专节（测试前必读）。
- ⚠️ **Cloudflare Worker 代理已废弃下线**（`openai-proxy.luu175ktovtsvor.workers.dev` 返回 404 / error 1042 "No Workers script found"）——**不要再用、不要依赖**。本地 `server/.env` 若仍把 `OPENAI_BASE_URL` 指向该代理，会导致生图全部 404，需改成直连。
- 出口 IP 为阿里云美国（AS45102），如遇 OpenAI 对机房 IP 风控再议。

## AI 并发与限流（生图/文本）— ⚠️ 测试前必读，否则会烧钱

> **2026-06-14 血泪教训。** 一次生图测试"扣了 $5、0 张图到手"，根因不是网络/余额，是 **超时太短 + 重试风暴 + Tier1 IPM 限额** 叠加。规则写在这，谁测都先看。

### 真实限额（官方文档当天实测，非凭记忆）

**OpenAI 生图（gpt-image-2，账户目前 Tier 2，2026-06-15 充值 $50 升级）**
- 分层按累计充值自动升级：Free / Tier 1（充 $5）/ **Tier 2（充 $50，当前）** / … / Tier 5（$1000）。
- 限流指标含 **IPM（每分钟图片数）** 与 TPM 等，任一打满即被限。**gpt-image-2 各层 IPM 是官方公开的**（来源 `developers.openai.com/api/docs/models/gpt-image-2`）：Tier1=5 / **Tier2=20（当前）** / Tier3=50 / Tier4=150 / Tier5=250。账户实时余量另可在 `platform.openai.com/settings/organization/limits` 或响应头 `x-ratelimit-remaining-requests` 查。（⚠️ 教训：此表第一次查时漏了——限流指南页已指路"per-model 去 models page 看"，要跟着指路走到模型详情页，别停在指南页就下"查不到"的结论。）
- ⚠️ 官方原话："失败/被拒的请求也计入每分钟限额，所以不停重发没用"——注意这说的是占**限额计数**、**不是扣费**。
- ⚠️ **被限流(429)拒绝的请求不生成图、不扣钱**；OpenAI 只对"实际生成的图"计费。所以"30 人挤 20 限额 → 多付 10 张钱"**不成立**。当年烧钱是"超时+重发把已生成(已扣费)的图重复生成"，是另一回事、已修。
- 单张生图慢：**5–10 分钟**很正常。因为慢，并发闸(同时最多几张)已把"每分钟起的张数"压到远低于 20，超出的请求是**排队等**、不是发出去被拒。

**DeepSeek 文本（deepseek-v4-flash）**
- **并发上限 2500**（v4-pro 是 500），**按账户算、与用哪个 API Key 无关**；超了返回 429。我们这个体量到不了，不是瓶颈。
- 真正风险是**共享预付余额**：余额不足返回 402（代码已映射成"余额不足"提示）。
- 可免费申请扩容；长请求有 keep-alive（最长 10 分钟）。`deepseek-chat`/`deepseek-reasoner` 旧名 2026-07-24 起弃用，对应 v4-flash 的非思考/思考模式。

### 烧钱是怎么发生的（务必理解，别再犯）

1. 生图要 5–10 分钟，但客户端读超时只设了 300 秒 → **还在生成就被判"超时失败"**；
2. SDK 默认重试 2 次 + 测试脚本自己又 for 循环重试 → **同一张反复重发**；
3. **每次重发都在服务端重新生成、重新扣费**，且失败请求还占 IPM → 触发 429 → 看着全失败、其实钱已扣光、0 图到手。

### 🔒 测试生图铁律（任何人、任何脚本都遵守）

1. **绝不重试生图请求**：不写 `for`/`while` 重发，不靠 SDK 自动重试（已 `max_retries=0`）。一次请求**就等它出**，超时也只算一次、不补发。
2. **超时拉满**：客户端读超时 ≥ 实际生图耗时。代码已设 `openai_image_timeout=900s(15min)`，别再调小。
3. **单张串行测**：一次只发 1 张，等出图再发下一张，绝不一次性丢 4-5 张。
4. **先设账户硬上限兜底**：测试前在 OpenAI 后台设 monthly budget hard limit，防脚本失控烧穿。
5. 看到 429/超时**先停下查原因**，别"再试一次"——重发只会更糟（占 IPM + 可能重复扣费）。

### 代码里已有的护栏（现状）

- `server/config.py`：`openai_image_timeout=900`、`poster_max_concurrency=4`（每 worker，2 worker→实际≈8 并发，远低于 L2 的 20 IPM；均可经环境变量上调）。
- `openai_image.py`：`max_retries=0`，读超时用 `openai_image_timeout`。
- `poster_service.py`：全局 `asyncio.Semaphore(poster_max_concurrency)` 给生图调用排队，护住 IPM；超出排队不立刻 429。
- `posters.py`：每用户同一时刻只允许 1 张在跑（`_GENERATING_USERS`），且强制 `count=1`。
- ⚠️ **多 worker 边界**：生产 2 worker，上面信号量/集合都是**进程内**的——同一用户两请求落不同 worker 可能各放行一张，全局并发实际 ≈ 2× 配置值。这是刻意取舍：429 是"被拒绝"不扣钱，不值得为精确全局限流上 Redis；真正烧钱的"超时+重试"已被进程内措施完全堵死。要精确全局限流再上 DB/Redis。

## 项目结构

```
web/                    # Next.js 前端
  src/
    app/
      (auth)/           # 登录/注册
      admin/            # 管理后台（总览/用户/套餐/订阅/收入）
      dashboard/        # 主界面（需登录）
        workbench/      # 岗位工作台（核心功能）
        posters/        # AI 海报生成
        history/        # 生成历史
        store-settings/ # 门店资料管理
          members/      # 团队成员管理
    components/
      ui/               # shadcn/ui 基础组件 + CardSelect
      layout/           # 布局组件（header, sidebar, mobile-nav）
      generators/       # AI 生成结果展示（copy-button）
      my-templates.tsx      # 我的收藏（服务端 is_favorite，非 localStorage）
      onboarding-guide.tsx  # 新手引导
      empty-store-guide.tsx # 无门店引导
      error-boundary.tsx    # 错误边界
    lib/
      api.ts            # API 客户端（统一 fetch 封装，token 刷新，SSE 流式）
      utils.ts          # 工具函数（cn, getErrorMessage）
      role-workbench-config.ts  # 岗位任务卡片配置（82 个任务卡片，其中 80 个带 promptKey）
    hooks/
      auth-context.tsx  # 认证上下文（login/register/logout）
    types/              # TypeScript 类型定义（api, auth, dashboard, generate, generation-history, poster, store）

server/                 # FastAPI 后端
  api/v1/
    router.py           # 路由注册（21 个子路由）
    auth.py             # 认证（注册/登录/刷新）
    stores.py           # 门店 CRUD
    generate.py         # 内容生成（文案/活动/经营）
    stream.py           # SSE 流式生成（工作台）
    posters.py          # 海报生成
    generations.py      # 生成历史 CRUD
    dashboard.py        # 今日工作台数据
    knowledge.py        # 知识库查询
    quota.py            # 配额管理
    models.py           # 模型列表
    members.py          # 团队成员管理
    admin.py            # 管理后台 API
    feedback.py         # 反馈（效果好/差）
    templates.py        # 用户模板 CRUD
    repurpose.py        # 内容变体（抖音/小红书/群公告/朋友圈）
    batch.py            # 批量生成
    outreach.py         # 助教约客
    sop.py              # 前厅 SOP
    games.py            # 玩法推荐
    performance.py      # 绩效考核
    diagnosis.py        # 经营诊断
  core/
    security.py         # JWT 认证（HS256，24小时有效期）
    rbac.py             # RBAC 权限矩阵（6个角色 × 10+权限）
    tenant.py           # 租户隔离（contextvars + SQLAlchemy 事件）
    quota.py            # 配额检查
    exceptions.py       # 自定义异常
  models/
    user.py             # 用户模型
    store.py            # 门店模型（含 brand_style、operation_profile）
    store_member.py     # 门店成员
    store_invitation.py # 邀请码
    generation.py       # 生成记录（含 is_deleted 软删除）
    conversation.py     # 对话记录
    quota.py            # 配额模型
  services/
    ai/
      prompt_engine.py  # Prompt 模板引擎（单例）
      factory.py        # Provider 工厂
      providers/
        deepseek.py     # DeepSeek 文本模型
        openai_image.py # OpenAI 图片模型（gpt-image-2）
        mock.py         # Mock Provider（测试用）
    content_service.py  # 文案生成核心逻辑
    poster_service.py   # 海报生成（AI 生图 + 对话历史）
    dashboard_service.py # 今日推荐规则引擎（日期+画像+节日[borax农历动态]+行为信号；节日出文案+海报双推荐）
    behavior_service.py  # 行为信号层（从 generations 算 BehaviorSnapshot：你常用/补缺口/深度）
    store_profile_service.py # 门店运营画像
    generation_service.py # 生成记录查询
    quota_service.py    # 配额管理
    storage_service.py  # 文件上传存储
  prompts/
    knowledge/          # 38 个行业知识 YAML
    rules/              # 角色规则 + 客户规则
    operation/          # 运营场景 prompt
    copywriting/        # 文案 prompt
    activity/           # 活动 prompt
    fewshots/           # fewshot 示例
  db/migrations/versions/ # 20 个 Alembic 迁移（001-019 主链 + add_new_tables_and_fields 旁支，head=019）
  main.py               # 入口
```

## 核心架构原则

1. **场景卡片为主 + 自由对话为辅（2026-06-13 用户拍板调整）** — 岗位工作台场景卡片仍是主路径；新增独立对话入口 `/dashboard/chat`（DeepSeek 式对话），走同一条 free_intent 生成管道：门店画像、行业知识库、合规过滤、配额、落库全部生效，不是裸聊大模型
2. **门店数据隔离** — 所有业务数据绑定 `store_id`，通过 `core/tenant.py` 自动过滤（contextvars + do_orm_execute 事件监听器），fail-safe 设计
3. **统一 RBAC 权限** — 通过 `core/rbac.py` 的权限矩阵 + `require_permission()` 依赖工厂实现集中式权限控制，6 个角色各有不同权限
4. **AI Provider 抽象** — 文本模型和图片模型各有独立抽象基类（`TextProvider` / `ImageProvider`），通过 `ProviderFactory` 创建实例
5. **Prompt 模板与业务解耦** — Prompt 存放在 `server/prompts/` 下的 YAML 文件中，支持 `{variable}` 占位符
6. **PromptEngine 是单例** — 通过 `get_prompt_engine()` 获取，不直接 `PromptEngine()`
7. **海报 = AI 生图 + Logo/二维码叠加** — AI 生成背景图，Pillow 叠加门店 Logo 和二维码
8. **不做自动触达** — 只生成内容供人工复制使用，不做自动群发、自动私信
9. **成员邀请机制** — 管理员生成邀请码 → 员工注册时输入 → 自动加入门店并获得指定角色
10. **内容变体** — 生成结果可一键转换为抖音文案/小红书文案/群公告/朋友圈格式

## 开发规范

### 前端

- 使用 Next.js App Router，不用 Pages Router
- 组件默认用 Server Component，需要交互时加 `"use client"`
- 样式用 TailwindCSS，不写自定义 CSS 文件
- API 请求统一通过 `lib/api.ts` 封装
- useEffect 中的 API 调用必须加 `cancelled` flag 防止卸载后 setState
- SSE 流式输出用于工作台生成（`streamWorkbench`）
- 错误处理用 `lib/utils.ts` 的 `getErrorMessage`
- 选择器组件用 `components/ui/card-select.tsx`（卡片式），不用原生 `<select>`

**设计系统（2026-06-12 起，微信内手机端是第一公民）：**
- 主色 `brand`（**iOS 系统蓝 #007AFF**，tailwind.config 定义；2026-06-12 由台呢绿改为苹果风）；**禁止再用 indigo**；tint 只给可点元素，页面底色 iOS 灰 #F2F2F7，卡片白底无边框靠灰白分层
- 视觉 token：卡片 `rounded-2xl`、按钮 `rounded-xl`；手机正文 `text-[15px]`、标题 `text-[17px]+`；按压态 `active:scale-[0.98]`，不做 hover-only 交互
- 触控目标 ≥44px（图标按钮至少 `h-10 w-10`）
- 手机弹层一律用 `components/ui/sheet.tsx`（底部抽屉），不用居中 modal
- 深层页（生成页/详情页/向导）：顶部用 `components/layout/page-header.tsx`（← + 标题，仅手机显示），底部 Tab 由 MobileNav 按路由前缀自动隐藏；页面主按钮吸底（`fixed bottom-0` + `pb-[calc(0.75rem+env(safe-area-inset-bottom))]` + 内容 `pb-24 lg:pb-0`）
- 列表页保留底部 Tab；桌面端（lg:）保持紧凑布局，Header/Breadcrumb 为桌面专属
- 微信 WebView 适配见 `lib/wechat.ts`：下载用"长按保存"引导，复制必须校验真实结果

### 后端

- API 版本前缀 `/api/v1/`
- 请求/响应模型用 Pydantic v2 的 `BaseModel`
- 数据库操作用 async SQLAlchemy
- 认证用 JWT（access token，24小时有效期），密码用 bcrypt 哈希
- 文件上传存**项目根目录** `uploads/`（config.py 默认 `<项目根>/uploads`；`server/uploads/` 是历史遗留死目录，勿用。服务器 .env 如设 UPLOAD_DIR 必须用绝对路径）
- AI 调用结果写入 `generations` 表，记录 prompt、model、tokens
- PromptEngine 是单例，通过 `get_prompt_engine()` 获取，不要直接 `PromptEngine()`
- Knowledge YAML 必须有 `template:` 和 `key:` 字段，否则 PromptEngine 加载会报错
- 所有 Generation 查询必须加 `is_deleted == False` 过滤

### Prompt 模板

```yaml
key: "operation.example"
name: "示例场景"
category: "operation"
variables:
  - store_name
template: |
  你是一个台球房运营专家...
  门店名称：{store_name}
```

修改 Prompt 不改业务代码，只改 YAML 文件。新增 knowledge YAML 必须包含 `template:` 字段。

**禁止事项：** YAML 文件中不得出现任何第三方品牌名、来源出处、文件名引用。

**品牌词豁免（2026-06-12 裁决）：** 球台/球杆等器材品牌（乔氏、星牌、百能、独牙等）属行业通用品类叫法（如"乔氏中八"近乎品类名，门店资料字段本身就存器材品牌），予以豁免。该禁令针对的是知识来源与机构名（培训机构、连锁品牌、文档出处），此类仍严格禁止。

## 代码同步与部署

代码通过 GitHub 同步，服务器通过 git pull 拉取。

**分支与发布流程（2026-06-13 起，保护线上用户体验）：**
- `main` = 线上稳定版，服务器只部署 main；**日常开发一律在 `dev` 分支**，不直接改 main
- 攒一批改动在 dev 验证完（tsc/build/pytest 全绿 + 本地过一遍），用户说"上线"才合并 main 并部署——避免频繁上线打扰正在使用的用户
- 紧急线上 bug 可直接在 main 修并立即部署，修完同步回 dev
- 落地页暂未启用：生产 `/` 直跳登录；落地页代码在 `/landing-preview`（无入口，内部调样式用），正式启用时搬回 `app/page.tsx`

```bash
# 本地：dev 验证通过后提交推送
git add . && git commit -m "描述"
git push origin dev
# 「上线」时合并到 main（服务器只部署 main）
git checkout main && git merge dev && git push origin main && git checkout dev

# 服务器部署：一条命令搞定（后端 + 前端 + 冒烟自检）
ssh root@47.77.237.250
cd /var/www/billiards-ai && bash deploy_us.sh
```

`deploy_us.sh` 一条命令完成全部：git pull → 后端依赖(uv sync) → 数据库迁移 → 重启后端 → **前端 `next build` + 拷贝 standalone 的 static/public + 重启前端** → **冒烟自检**（真测线上后端 API 与前端静态资源，漏拷/起不来会报错退出）。

⚠️ **不要再手动分步 build 前端**：standalone 模式下 `next build` 不含 static/public、且会清掉旧的，漏 `cp` 会让 `/_next/static` 全部返回 400 → **整站白屏**（2026-06-15 就这么踩过，且 `systemctl active` 照样显示正常、极具迷惑性）。统一走 `deploy_us.sh`，它末尾的冒烟检查会兜住这个坑。

## 常用命令

```bash
# 前端
cd web && pnpm dev          # 启动开发服务器
cd web && pnpm build        # 构建
cd web && pnpm lint         # 检查

# 后端
cd server && uv run fastapi dev main.py    # 启动开发服务器
cd server && uv run alembic upgrade head   # 执行数据库迁移
cd server && uv run alembic revision --autogenerate -m "描述"  # 生成迁移

# 测试（一条命令跑全套）
bash scripts/test.sh          # 快速门：后端pytest + 前端vitest + tsc（不花钱不联网AI，dev运行时安全）
bash scripts/test.sh --eval   # 额外跑店脑 LLM 验收 eval_store_brain.py（真实 DeepSeek，慢/花钱/需key）
# 注意：scripts/test.sh 不含 next build（会和 next dev 抢 .next 缓存）；上线构建走 deploy 流程

# 服务器
ssh root@47.77.237.250
systemctl status billiards-backend billiards-frontend
journalctl -u billiards-backend -n 50 --no-pager
```

## 已完成功能

| 模块 | 状态 |
|------|------|
| 用户注册/登录（手机号+密码） | ✅ |
| 门店资料管理（运营画像，分步向导 + 全部编辑） | ✅ |
| Prompt 引擎（YAML 模板，41 个 knowledge） | ✅ |
| 岗位工作台（6 角色 × 82 张卡片，SSE 流式输出） | ✅ |
| 文案生成（朋友圈/群公告/活动/日报） | ✅ |
| 海报生成（gpt-image-2 + Logo/二维码直传 AI + 二次调整） | ✅ |
| Markdown 渲染（react-markdown + remark-gfm） | ✅ |
| 文本模型（DeepSeek V4 Flash） | ✅ |
| 生成历史（筛选/搜索/收藏/独立全屏详情页 `/dashboard/history/[id]`/导出 CSV） | ✅ |
| 配额管理 | ✅ |
| 多 AI Provider（DeepSeek/OpenAI） | ✅ |
| fewshot 选择器 | ✅ |
| 多租户安全（自动 store_id 过滤 + RBAC 权限矩阵） | ✅ |
| 成员管理（邀请码 + 手动添加 + 角色调整 + 移除） | ✅ |
| 管理后台（用户管理/订阅管理/收入统计/套餐编辑） | ✅ |
| 反馈系统（效果好/差） | ✅ |
| 我的收藏（服务端 is_favorite 复用，"再写一条"走原卡片+原意图同管道；原 localStorage 模板已废弃） | ✅ |
| 内容变体（一键转换为抖音/小红书/群公告/朋友圈） | ✅ |
| 批量生成（一次生成 5 条同类内容） | ✅ |
| 新手引导（5 步向导） | ✅ |
| 今日推荐（行为感知：日期+画像+节日+成长阶段+你常用/补缺口/深度，类目多样，动态 tips"AI在学你"；已合并原"常用任务"、删除静态内容日历） | ✅ |
| 工作台卡片动态排序（`/dashboard/card-signals`：按跨设备 prompt_key 频次+效果好排序，"常用"标签；新店退回优先级排序） | ✅ |
| 模块动态化（门店设置按成长阶段引导横幅 / 协作场景馆按阶段排序 / 收藏按"效果好"优先 / 节日提醒：8 个节日，农历春节·端午·中秋由 borax 每年自动换算公历[1900-2100，不再硬编码]） | ✅ |
| 品牌风格选择（卡片式选择器，影响 AI 语气） | ✅ |
| 生图"基于此调整"（refine_from 以图生图） | ✅ |
| 生图 Logo/二维码多图直传 AI（最多 16 张） | ✅ |
| 对话历史截断（只保留最近 3 轮） | ✅ |
| 服务器部署（git + deploy_us.sh + SSL） | ✅ |
| 生产域名（zzyppz.cn + HTTPS） | ✅ |
| 业务时区单一来源（core/timezone.py，"今天"一律北京时间） | ✅ |
| 微信 WebView 适配（复制真实校验/图片长按保存引导/CSV 提示） | ✅ |
| 配额商业闭环（429 透传提额引导 + 额度用尽禁用生成按钮） | ✅ |
| 价格直出（资料已填+允许写价格→真实价格进文案；prompt_engine 单点策略） | ✅ |
| 工作台卡片搜索 + 默认岗位跟随 my_role | ✅ |
| 数据库每日备份（cron 4:30 + /var/backups/billiards 保留7天） | ✅ |
| 前端错误上报（POST /api/v1/logs/client，journalctl 查 client-error） | ✅ |
| AI 自由对话（/dashboard/chat，同管道含知识库；FAB"问AI·写文案"直达） | ✅ |
| 协作拆分（场景馆 8 卡含 4 个 custom 预设 + 独立执行页 /collaborate/run） | ✅ |
| 生成记录命名（migration 016 title 列 + PATCH /title + 历史改名/搜索含名） | ✅ |
| 海报续修（历史详情"继续调整这张图"→ 原对话 ?refine= 定位基准图） | ✅ |
| 管理后台重置密码（PUT /admin/users/{id}/password，不动用户数据） | ✅ |
| 场景图标体系（lib/scene-icons 语义映射 lucide，替代随机 emoji） | ✅ |
| 生成优化三件套（#1 prompt 注入北京时间日期上下文，AI 知道今天周几/周末几号；#2 占位符识别 `lib/placeholders` 横幅提示需补内容；#3"只出一条"开关 concise，避免多方案堆砌） | ✅ |
| 节日双推荐（节日临近出"文案"恒出 + "海报"：有 Logo/二维码→直达生图带节日视觉主题、缺→引导上传品牌页；前端 CAP.festival=2 两条都展示；海报走生图模型不自动出图） | ✅ |
| AI 对话回复行内编辑（/chat 回复"复制/编辑"→ textarea 改 → 保存修改，调 updateGenerationContent 存回历史；与工作台结果编辑同款） | ✅ |
| 行业术语对齐：会员卡→一卡通/充值（36 处 prompt + 3 处前端；保留"一卡通替代传统会员卡"对比句与"严禁输出会员卡档位"护栏；球房一卡通通吃商品/助教/台费，赠送通常只送台费） | ✅ |
| 店脑·AI记忆中枢（第一版）：生成/对话后台异步从用户输入抽取门店记忆→整合(改价更新不重复)→存`store_memories`；生成前注入 prompt 末尾(冲突以店脑为准)→越用越懂这家店；`/dashboard/store-brain`「AI眼里的你的店」可看/改/删(人在环)。memory_service + golden验收套件 `tests/eval_store_brain.py`(真实DeepSeek 5/5)。后台学习不计配额。生产加固：并发安全(每店 pg_advisory_xact_lock 防丢记忆)+ 防膨胀上限(情景25/总150)。详见 docs/product-brain/店脑-AI记忆中枢-架构与成本.md | ✅ |
| 海报独立额度池（migration 018）：海报不再与文案共用次数池，单独计数/限额(`monthly_poster_limit`/`monthly_posters_used`)；套餐 `poster_limit` 开通时同步、单店可调；生图前 `check_poster_quota` 校验、用尽走 429 提额引导；前端 QuotaBadge `mode="poster"` 单独显示"剩余N/M张(生图较耗额度)"。同时堵住免费版白嫖高清海报漏洞。比例尺寸修复：3:4→1152×1536、9:16→1152×2048、16:9→2048×1152、1:1→1024×1024(旧值全错且3:4与9:16撞同图) | ✅ |
| 管理后台权限模型（2026-06-14 定稿）：唯一管理员 = 老板本人账号 `is_admin`（既当普通客户端、有门店进 /dashboard 体验与普通用户一致，又能访问主域名 `/admin` 进后台）；客户端零管理入口（is_admin 仅影响登录跳转：无门店的纯 admin→/admin，有门店→/dashboard）。后台「用户管理→调整配额」给任意用户设文案/海报额度即时生效（`monthly_tokens_limit` 封顶 2e9 防溢出）。`scripts/manage_admin.py` 保留作应急授/撤管理员。曾试"专用超管号+8443独立端口"已撤销，详见 docs/耦合地图与改动检查清单.md | ✅ |
| 会员生命周期自动化（2026-06-14）：到期时间按**自然月**（3月5开2月=5月5，纯标准库 `_add_months`）；开通改 **UPSERT**（一店一订阅行，再开通/换档位从今天起算、不撞唯一约束）；续费**刷回该档位配额**（修过期降级后续费不恢复额度）；**到期自动降级** `scripts/expire_subscriptions.py` + 每小时 cron（过期订阅置 expired + 配额降回试用30/3，只动有过期订阅的店、无订阅/手动不限额账号不碰）。续费过期后从今天起算 | ✅ |
| 缴费/会员历史（migration 019）：`subscription_payments` 加 `plan_name`（快照缴费当时档位）；开通/续费写入；用户详情接口返回 `payment_history`（逐笔：日期/档位/开通或续费/金额，倒序）；前端「用户管理→详情」展示"缴费/会员历史"。到期降级不删流水，历史永久可查 | ✅ |
| 运营日报自动化（2026-06-14 上线）：4 张岗位日报——店长/前厅(flat)、教练主/副(personal·今日/本月累计)、助教管理(roster·按时长排名+明细/排名/播报三 sheet)；**填表或「说一句话」**(自然语言→DeepSeek JSON 抽取字段预填)→ AI 写叙事(**注入店脑记忆**"懂这家店"·环比对比前一天·喂中文 label 防 AI 把助教叫教练)→ **导出 Excel**(openpyxl)。配置化引擎(`server/report_forms/*.yaml` 一表一 YAML，前端按 shape 三态渲染)+ `reports.py` API + 复用 generations 表**零迁移**(走 run_generation 配额/落库)。配套：今日推荐"日报没写"信号(写过当天不催)、老板今日交付状态(`/reports/today-status`)、落地页式使用指南(`/dashboard/guide` + 侧栏/抽屉/首次弹窗入口)。**铁律：不重做收银系统**——POS 字段(营业额/上钟数)标"收银系统看"只瞄一眼填，主收"运营动作数据"(加微/约客/转化等 POS 采不到的)。详见 `docs/product-brain/运营日报自动化-设计.md` | ✅ |

## 行业知识体系

产品大脑文档在 `docs/product-brain/`。

核心知识模块（41 个 knowledge YAML）：
- **每日工作流程** (`daily_workflow.yaml`) — 6 个角色的每日工作流 + 5 个延伸场景
- **岗位专属流程** (`daily_workflow_manager/coach/frontdesk/assistant_manager.yaml`) — 4个岗位独立流程
- **核心运营逻辑** (`core_operations.yaml`) — 四大客户分类、岗位协作、定价铁律
- **盈利模型** (`profit_model.yaml`) — 收入结构、成本分析、四类球房定价策略、团购设计
- **竞技群运营** (`competitive_group_ops.yaml`) — 教练维护竞技群的日常动作
- **助教推广获客** (`assistant_promotion.yaml`) — 朋友圈/短视频/现场推荐/客户维护
- **助教服务 SOP** (`assistant_service_sop.yaml`) — 上钟前/中/后全流程
- **助教等级体系** (`assistant_tier_system.yaml`) — 五级晋升、7天赋能培训课程表
- **助教薪资体系** (`assistant_salary.yaml`) — 薪资结构、提成阶梯、保底规则
- **助教球技培训SOP** (`assistant_coaching_sop.yaml`) — 新手到高级训练大纲
- **助教刁钻问题** (`assistant_difficult_situations.yaml`) — 18 个真实场景话术
- **好评文案规范** (`review_generation_rules.yaml`) — 美团/抖音好评写法
- **PK 激励机制** (`pk_incentive.yaml`) — 三层PK体系 + 惩处制度 + 转介绍奖励
- **客户标签体系** (`customer_tagging.yaml`) — 6类客户 + ABCD分级 + 打标签方法
- **客户档案模板** (`customer_profile_template.yaml`) — 字段定义、打标签SOP、生命周期管理
- **开业筹备** (`opening_preparation.yaml`) — 30天时间线 + 开业SOP
- **管理层招聘** (`management_recruitment.yaml`) — 岗位画像 + 面试话术
- **充值策略** (`recharge_strategy.yaml`) — 一卡通模式 + 小比例赠送
- **绩效标准** (`performance_standards.yaml`) — 5个岗位考核维度
- **赛事规则** (`tournament_rules.yaml`) — 10种赛事类型 + 主持词模板
- **前厅培训** (`frontdesk_training.yaml`) — 培训手册 + 服务标准 + 台呢维护SOP
- **小游戏** (`mini_games.yaml`) — 12 个小游戏规则
- **合规规则** (`compliance_rules.yaml`) — 平台规则 + 禁用词
- **平台运营 SOP** (`platform_operations.yaml`) — 美团/抖音平台运营
- **核心指标公式库** (`core_metrics.yaml`) — 台费/助教/教练/前厅指标、趋势分析
- **店长薪资结构** (`manager_compensation.yaml`) — 各管理岗位薪资参考
- **球房选址指南** (`site_selection.yaml`) — 商业球房选址20个要点
- **球房引流手册** (`traffic_generation.yaml`) — 引流操作手册
- **球房合同基础** (`contract_basics.yaml`) — 合同基础知识
- 更多见 `server/prompts/knowledge/`

运营场景模板（54 个 operation YAML）：
- 覆盖6个岗位的日常运营场景
- 包含日报/周报/赛事/活动/推广/招聘/培训/PK/诊断等
- 更多见 `server/prompts/operation/`

## 不要做的事

- 不做微服务，单体应用
- 不做国际化
- 不做 Prompt 可视化编辑器
- 不做海报拖拽编辑器
- 不做 WebSocket 实时协作
- 不做自动群发、自动私信
- 不在 AI 生图 Prompt 中**主动**包含中文文字、价格、Logo、二维码（2026-06-12 调整：用户在生图页"把文字画进图里"输入框显式填写文字时例外，作为实验功能放行；系统侧仍不自动往 prompt 塞中文文字）
- 不使用原生 `<select>` 做选择器（用 CardSelect 组件）
- 不在代码中出现任何第三方品牌名或来源出处（器材品牌如乔氏/星牌/百能/独牙属行业通用品类叫法，豁免；禁的是知识来源与机构名）

## 文档维护规则

1. 完成工作后实时更新相关文档，不做完不更新
2. 过时文档移入 `docs/archive/`，不删除
3. 新增文档按类别放入 `docs/` 对应子目录，不堆根目录
4. `docs/product-brain/` 是活文档，调整 Prompt 或业务规则时必须同步更新
5. 文档导航见 `docs/README.md`
