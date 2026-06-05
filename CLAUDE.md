# 球房 AI 运营助手

## 项目简介

面向台球房行业的 AI 运营辅助 SaaS 工具。帮助台球房老板/店长/员工完成文案生成、活动策划、海报制作、员工话术、社群运营等日常运营工作。

**这不是**收银系统、灯控系统、会员管理系统。不做开台、计费、灯控、收银、库存、会员充值。

## 当前状态

- **已部署**: 阿里云 ECS `39.106.214.21`，Nginx + systemd
- **前端**: Next.js 14 standalone 模式，端口 3000
- **后端**: FastAPI + uvicorn，端口 8000
- **数据库**: PostgreSQL 14，库名 `billiards_ai`
- **AI**: DeepSeek API（文本），阿里云百炼（图片）
- **部署文档**: `docs/服务器部署交接文档.md`

## 技术栈

- **前端**: Next.js 14 + React 18 + TypeScript + TailwindCSS + shadcn/ui
- **后端**: Python 3.12+ + FastAPI + SQLAlchemy + Alembic
- **数据库**: PostgreSQL 14
- **海报合成**: Pillow (Python)
- **包管理**: pnpm (前端) / uv (Python 后端)

## 项目结构

```
web/                    # Next.js 前端
  src/
    app/
      (auth)/           # 登录/注册
      dashboard/        # 主界面（需登录）
    components/
      ui/               # shadcn/ui 基础组件
      forms/            # 业务表单
      generators/       # AI 生成结果展示
      layout/           # 布局组件（header, sidebar, mobile-nav）
    lib/
      api.ts            # API 客户端（统一 fetch 封装）
      utils.ts          # 工具函数
      role-workbench-config.ts  # 岗位任务卡片配置
      workbench-config.ts       # 工作台配置
    hooks/
      auth-context.tsx  # 认证上下文
    types/              # TypeScript 类型定义

server/                 # FastAPI 后端
  api/v1/              # API 路由（auth, stores, generate, stream, posters, generations, knowledge, dashboard）
  core/                # 安全、配额、异常
  models/              # SQLAlchemy ORM 模型（user, store, generation, quota）
  schemas/             # Pydantic 请求/响应模型
  services/
    ai/                # AI Provider + Prompt 引擎
      prompt_engine.py # Prompt 模板引擎（单例）
      factory.py       # Provider 工厂
      providers/       # 具体模型实现 (DeepSeek/OpenAI/百炼)
    content_service.py # 文案生成核心逻辑
    poster_service.py  # 海报合成
    store_profile_service.py  # 门店运营画像
    dashboard_service.py      # 今日工作台规则引擎
    quota_service.py   # 配额管理
  db/                  # 数据库连接 + Alembic 迁移
  prompts/             # Prompt 模板 YAML 文件（98 个模板）
  main.py              # 入口
```

## 核心架构原则

1. **场景驱动，不是对话驱动** — 用户通过岗位工作台（Workbench）的场景卡片+自然语言输入触发 AI 生成，不做自由聊天
2. **门店数据隔离** — 所有业务数据绑定 `store_id`，查询必须过滤 store_id
3. **AI Provider 抽象** — 文本模型和图片模型各有独立抽象基类（`TextProvider` / `ImageProvider`），通过 `ProviderFactory` 创建实例
4. **Prompt 模板与业务解耦** — Prompt 存放在 `server/prompts/` 下的 YAML 文件中，支持 `{variable}` 占位符
5. **海报 = 背景图 + 模板引擎叠加** — 商业信息（文字/价格/Logo/二维码）由 Pillow 模板引擎叠加渲染
6. **不做自动触达** — 只生成内容供人工复制使用，不做自动群发、自动私信

## 开发规范

### 前端

- 使用 Next.js App Router，不用 Pages Router
- 组件默认用 Server Component，需要交互时加 `"use client"`
- 样式用 TailwindCSS，不写自定义 CSS 文件
- API 请求统一通过 `lib/api.ts` 封装
- useEffect 中的 API 调用必须加 `cancelled` flag 防止卸载后 setState
- SSE 流式输出用于工作台生成（`streamWorkbench`）

### 后端

- API 版本前缀 `/api/v1/`
- 请求/响应模型用 Pydantic v2 的 `BaseModel`
- 数据库操作用 async SQLAlchemy
- 认证用 JWT（access token），密码用 bcrypt 哈希
- 文件上传存本地目录 `server/uploads/`
- AI 调用结果写入 `generations` 表，记录 prompt、model、tokens
- PromptEngine 是单例，通过 `get_prompt_engine()` 获取

### Prompt 模板

```yaml
key: "copywriting.moments"
name: "朋友圈文案"
category: "copywriting"
variables:
  - store_name
  - city
template: |
  你是一个台球房运营专家...
  门店名称：{store_name}
```

修改 Prompt 不改业务代码，只改 YAML 文件。

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

# 数据库
docker compose up -d postgres   # 启动本地 PostgreSQL

# 服务器部署
ssh root@39.106.214.21
systemctl status billiards-backend billiards-frontend
journalctl -u billiards-backend -n 50 --no-pager
```

## 已完成功能

| 模块 | 状态 |
|------|------|
| 用户注册/登录（手机号+密码） | ✅ |
| 门店资料管理（运营画像） | ✅ |
| Prompt 引擎（YAML 模板） | ✅ |
| 岗位工作台（Workbench） | ✅ SSE 流式输出 |
| 文案生成（朋友圈/群公告/活动） | ✅ |
| 海报生成（AI 图片 + Pillow 合成） | ✅ |
| 生成历史 | ✅ |
| 配额管理 | ✅ |
| 多 AI Provider（DeepSeek/百炼/OpenAI） | ✅ |
| fewshot 选择器 | ✅ |
| 服务器部署 | ✅ |

## 不要做的事

- 不做微服务，单体应用
- 不做国际化
- 不做复杂权限系统（只需 boss/manager/assistant_manager/coach/frontdesk/operator 六角色）
- 不做 Prompt 可视化编辑器
- 不做海报拖拽编辑器
- 不做 WebSocket 实时协作
- 不做自动群发、自动私信

## 行业知识来源

产品大脑文档在 `docs/product-brain/`，原始行业资料在桌面 `台球行业资料收集/`。

核心知识模块：
- **产品大脑** (`台球房AI运营工作台-产品大脑.md`) — 产品定义、用户角色、核心价值
- **岗位场景库** (`台球房岗位场景库.md`) — 6 个岗位的工作场景和任务
- **助教业务规则库** (`助教业务规则库.md`) — 助教管理全流程
- **前厅 SOP 规则库** (`前厅SOP规则库.md`) — 前厅接待标准流程
- **赛事活动规则库** (`赛事活动规则库.md`) — 赛事策划和执行
- **Prompt 规则库** (`Prompt规则库.md`) — AI 生成的风格和边界规则

## 文档维护规则

1. 完成工作后实时更新相关文档，不做完不更新
2. 过时文档移入 `docs/archive/`，不删除
3. 新增文档按类别放入 `docs/` 对应子目录，不堆根目录
4. `docs/product-brain/` 是活文档，调整 Prompt 或业务规则时必须同步更新
5. 文档导航见 `docs/README.md`
