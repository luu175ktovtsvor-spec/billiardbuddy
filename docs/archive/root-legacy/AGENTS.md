# 球房 AI 运营助手

## 项目简介

面向台球房行业的 AI 运营辅助 SaaS 工具。帮助台球房老板/店长/员工完成文案生成、活动策划、海报制作、员工话术、社群运营等日常运营工作。

**这不是**收银系统、灯控系统、会员管理系统。不做开台、计费、灯控、收银、库存、会员充值。

## 技术栈

- **前端**: Next.js 14 + React 18 + TypeScript + TailwindCSS + shadcn/ui
- **后端**: Python 3.12 + FastAPI + SQLAlchemy + Alembic
- **数据库**: PostgreSQL
- **对象存储**: 阿里云 OSS
- **海报合成**: Pillow (Python)
- **包管理**: pnpm (前端) / uv (Python 后端)

## 项目结构

```
web/                    # Next.js 前端
  src/
    app/                # App Router 页面
      (auth)/           # 登录/注册
      (dashboard)/      # 主界面（需登录）
    components/
      ui/               # shadcn/ui 基础组件
      forms/            # 业务表单
      generators/       # AI 生成结果展示
      layout/           # 布局组件
    lib/                # 工具函数、API 封装
    hooks/              # 自定义 hooks
    types/              # TypeScript 类型

server/                 # FastAPI 后端
  api/v1/              # API 路由
  core/                # 安全、配额、异常
  models/              # SQLAlchemy ORM 模型
  schemas/             # Pydantic 请求/响应模型
  services/
    ai/                # AI Provider + Prompt 引擎
      providers/       # 具体模型实现 (DeepSeek/OpenAI/Codex)
    poster/            # 海报合成引擎
  db/                  # 数据库连接 + Alembic 迁移
  prompts/             # Prompt 模板 YAML 文件
  main.py              # 入口
```

## 核心架构原则

1. **场景驱动，不是对话驱动** — 用户通过场景按钮+表单触发 AI 生成，不做自由聊天
2. **门店数据隔离** — 所有业务数据绑定 `store_id`，查询必须过滤 store_id
3. **AI Provider 抽象** — 文本模型和图片模型各有独立抽象基类（`TextProvider` / `ImageProvider`），通过 `ProviderFactory` 创建实例，切换模型不改业务代码
4. **Prompt 模板与业务解耦** — Prompt 存放在 `server/prompts/` 下的 YAML 文件中，支持 `{variable}` 占位符，门店信息自动注入
5. **海报 = 背景图 + 模板引擎叠加** — P0/P1 阶段先用本地预置的静态背景图验证合成流程；P2 阶段接入 AI 图片模型生成动态背景。商业信息（文字/价格/Logo/二维码）始终由 Pillow 模板引擎叠加渲染
6. **不做自动触达** — 只生成内容供人工复制使用，不做自动群发、自动私信、爬虫

## 开发规范

### 前端

- 使用 Next.js App Router，不用 Pages Router
- 组件默认用 Server Component，需要交互时加 `"use client"`
- 样式用 TailwindCSS，不写自定义 CSS 文件
- 响应式用 TailwindCSS 断点 (`sm/md/lg`)，PC 和 H5 共用一套页面
- 表单用 react-hook-form + zod 校验
- API 请求统一通过 `lib/api.ts` 封装，不散落 fetch 调用
- 文案生成结果旁必须有"一键复制"按钮
- 文案类 AI 生成最终使用 SSE 流式输出（P2 阶段实现）。P0/P1 阶段先用普通 HTTP 请求返回完整结果

### 后端

- API 版本前缀 `/api/v1/`
- 请求/响应模型用 Pydantic v2 的 `BaseModel`
- 数据库操作用 async SQLAlchemy
- 认证用 JWT（access token），密码用 bcrypt 哈希
- 文件上传 P0 阶段存本地目录 `server/uploads/`，不接 OSS。后续通过 StorageProvider 抽象切换到阿里云 OSS（P2 阶段）
- AI 调用结果写入 `generations` 表，记录 prompt、model、tokens
- 所有 AI 生成接口需记录调用到 `generations` 表。P0 阶段只记录不拦截；P2 阶段再实现配额检查和超限拦截

### Prompt 模板

Prompt 模板 YAML 格式：

```yaml
key: "copywriting.moments"
name: "朋友圈文案"
category: "copywriting"
variables:
  - store_name
  - city
  - scenario
  - tone
template: |
  你是一个台球房运营专家...
  门店名称：{store_name}
  ...
```

修改 Prompt 不改业务代码，只改 YAML 文件。

### 数据库

- 主键用 UUID
- 时间字段用 `TIMESTAMPTZ`
- 灵活结构（价格、会员卡套餐）用 JSONB
- 新增表/字段通过 Alembic 迁移管理

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

# 本地文件存储（P0 阶段）
# 上传文件存放在 server/uploads/，不需要配置 OSS
# 后续切 OSS 时替换 StorageProvider 实现

# 数据库
docker compose up -d postgres   # 启动 PostgreSQL
```

## MVP 功能模块

| 优先级 | 模块 |
|--------|------|
| P0 | 用户注册/登录（手机号+密码）、门店资料管理（本地存储）、Prompt 引擎（YAML）、单文本 AI Provider、普通 HTTP 文案生成、活动策划 |
| P1 | 员工话术、社群内容、本地静态背景图 + Pillow 海报合成、今日工作台（规则引擎） |
| P2 | 生成历史、使用量配额控制、SSE 流式输出、OSS 文件存储、AI 图片生成模型接入 |

后续可选优化：多模型 fallback、模型成本优化、模型自动切换。

## 不要做的事

- 不做微服务，单体应用
- 不做国际化
- 不做复杂权限系统（只需 owner/manager/staff 三角色）
- 不做 Prompt 可视化编辑器
- 不做海报拖拽编辑器
- 不做 WebSocket 实时协作
- 不做复杂任务队列（用 FastAPI BackgroundTasks）
- 不在 AI 生图 Prompt 中包含中文文字、价格、Logo、二维码

### P0 阶段额外限制

- P0 不做 SSE 流式输出，先用普通 HTTP 返回完整结果
- P0 不做真实 OSS 上传，先用本地目录 `server/uploads/`
- P0 不做配额拦截，只在 generations 表记录调用
- P0 不做 AI 图片生成模型接入，海报先用本地静态背景图
- P0 不做多模型 fallback，先只接入一个文本模型
- P0 不做短信验证码，登录用手机号+密码
- P0 不做 usage_quotas 表，等 P2 再建
