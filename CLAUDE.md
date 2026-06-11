# 球房 AI 运营助手

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
| 文本生成 | DeepSeek V4 Flash | 通过 `https://api.deepseek.com` |
| 图片生成 | OpenAI gpt-image-2 | 通过 Cloudflare Worker 代理 `https://openai-proxy.luu175ktovtsvor.workers.dev/v1` |

## 技术栈

- **前端**: Next.js 14 + React 18 + TypeScript + TailwindCSS + shadcn/ui
- **后端**: Python 3.12+ + FastAPI + SQLAlchemy + Alembic
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

**Cloudflare Worker 代理：**
- `OPENAI_BASE_URL` 指向 `https://openai-proxy.luu175ktovtsvor.workers.dev/v1`
- 这是一个 Cloudflare Worker 代理，用于优化 OpenAI API 的访问速度和稳定性
- 不是直连 `https://api.openai.com/v1`

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
      content-calendar.tsx  # 内容日历（静态）
      my-templates.tsx      # 我的模板
      onboarding-guide.tsx  # 新手引导
      empty-store-guide.tsx # 无门店引导
      error-boundary.tsx    # 错误边界
    lib/
      api.ts            # API 客户端（统一 fetch 封装，token 刷新，SSE 流式）
      utils.ts          # 工具函数（cn, getErrorMessage）
      role-workbench-config.ts  # 岗位任务卡片配置（54 个任务卡片）
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
    dashboard_service.py # 今日工作台规则引擎
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
  db/migrations/versions/ # 14 个 Alembic 迁移（001-013 + add_new_tables）
  main.py               # 入口
```

## 核心架构原则

1. **场景驱动，不是对话驱动** — 用户通过岗位工作台（Workbench）的场景卡片+自然语言输入触发 AI 生成，不做自由聊天
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

```bash
# 本地改完代码后
git add .
git commit -m "描述"
git push origin main

# 服务器上部署（后端自动，前端需手动构建）
ssh root@47.77.237.250
cd /var/www/billiards-ai && bash deploy_us.sh

# 前端有改动时需手动构建
cd /var/www/billiards-ai/web
npx next build --no-lint
cp -r .next/static .next/standalone/.next/static
systemctl restart billiards-frontend
```

`deploy_us.sh` 自动执行：git pull → 安装依赖 → 数据库迁移 → 重启后端。**前端构建需手动执行。**

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
| 岗位工作台（6 角色 × 54 张卡片，SSE 流式输出） | ✅ |
| 文案生成（朋友圈/群公告/活动/日报） | ✅ |
| 海报生成（gpt-image-2 + Logo/二维码直传 AI + 二次调整） | ✅ |
| Markdown 渲染（react-markdown + remark-gfm） | ✅ |
| 文本模型（DeepSeek V4 Flash） | ✅ |
| 生成历史（筛选/收藏/详情/导出 CSV） | ✅ |
| 配额管理 | ✅ |
| 多 AI Provider（DeepSeek/OpenAI） | ✅ |
| fewshot 选择器 | ✅ |
| 多租户安全（自动 store_id 过滤 + RBAC 权限矩阵） | ✅ |
| 成员管理（邀请码 + 手动添加 + 角色调整 + 移除） | ✅ |
| 管理后台（用户管理/订阅管理/收入统计/套餐编辑） | ✅ |
| 反馈系统（效果好/差） | ✅ |
| 用户模板（我的模板，localStorage 存储） | ✅ |
| 内容变体（一键转换为抖音/小红书/群公告/朋友圈） | ✅ |
| 批量生成（一次生成 5 条同类内容） | ✅ |
| 新手引导（5 步向导） | ✅ |
| 内容日历（静态，按星期推荐发什么内容） | ✅ |
| 品牌风格选择（卡片式选择器，影响 AI 语气） | ✅ |
| 生图"基于此调整"（refine_from 以图生图） | ✅ |
| 生图 Logo/二维码多图直传 AI（最多 16 张） | ✅ |
| 对话历史截断（只保留最近 3 轮） | ✅ |
| 服务器部署（git + deploy_us.sh + SSL） | ✅ |
| 生产域名（zzyppz.cn + HTTPS） | ✅ |

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
