# 球房 AI 运营助手

面向台球房行业的 AI 运营辅助 SaaS 工具。帮助台球房老板/店长/员工完成文案生成、活动策划、海报制作、员工话术、社群运营等日常运营工作。

## 在线访问

http://47.77.237.250

## 技术栈

- **前端**: Next.js 14 + React 18 + TypeScript + TailwindCSS + shadcn/ui
- **后端**: Python 3.12+ + FastAPI + SQLAlchemy + Alembic
- **数据库**: PostgreSQL 14
- **AI 文本模型**: DeepSeek V4 Flash（默认）+ Mimo V2.5（可选）
- **AI 图片模型**: OpenAI gpt-image-2（通过 API2D 中转）
- **内容渲染**: react-markdown + remark-gfm + @tailwindcss/typography
- **包管理**: pnpm (前端) / uv (Python 后端)

## 快速启动

### 1. 启动数据库

```bash
docker compose up -d postgres
```

### 2. 启动后端

```bash
cd server
cp ../.env.example .env   # 按需修改配置
uv sync                    # 安装依赖
uv run fastapi dev main.py # 启动开发服务器
```

访问 http://localhost:8000/docs 查看 Swagger 文档。

### 3. 启动前端

```bash
cd web
pnpm install               # 安装依赖
pnpm dev                   # 启动开发服务器
```

访问 http://localhost:3000 查看页面。

## 部署

代码通过 GitHub 同步，服务器通过 git pull 部署。

```bash
# 本地改完代码后
git add . && git commit -m "描述" && git push origin main

# 服务器上部署
ssh root@47.77.237.250
bash /var/www/billiards-ai/deploy_us.sh
```

## 已完成功能

| 模块 | 说明 |
|------|------|
| 用户注册/登录 | 手机号+密码 |
| 门店资料管理 | 运营画像，98个字段 |
| 岗位工作台 | 6个岗位，自然语言输入，SSE流式输出 |
| 文案生成 | 朋友圈/群公告/活动/日报/话术 |
| 海报生成 | gpt-image-2 + Logo叠加 + 二维码叠加 + 二次调整 |
| Markdown 渲染 | AI内容格式化显示 |
| 模型选择 | DeepSeek V4 Flash + Mimo V2.5 |
| 行业知识库 | 29个knowledge YAML，覆盖6个岗位 |
| 生成历史 | 搜索、筛选、收藏 |
| 配额管理 | 月度使用量追踪 |

## 项目结构

```
web/                    # Next.js 前端
  src/
    app/                # App Router 页面
    components/         # UI 组件
    lib/                # 工具函数、API 封装
    hooks/              # 自定义 hooks
    types/              # TypeScript 类型

server/                 # FastAPI 后端
  api/v1/              # API 路由
  services/            # 业务逻辑
  prompts/             # Prompt 模板 YAML
    knowledge/         # 29 个行业知识文件
    rules/             # 角色+客户规则
    operation/         # 运营场景 prompt
  models/              # SQLAlchemy ORM
  schemas/             # Pydantic 模型
```

## 行业知识体系

产品大脑文档在 `docs/product-brain/`，原始行业资料在桌面 `台球行业资料收集/`。

核心知识模块：
- 每日工作流程（6个角色）
- 竞技群运营
- 助教推广获客
- 助教服务SOP
- 好评文案规范
- 教练刁钻问题应对
- PK激励机制
- 客户标签体系
- 开业筹备
- 管理层招聘
- 充值活动策略
- 赛事活动规则
- 前厅培训
- 小游戏规则
- 合规规则

## 不做的事

- 不做收银系统、灯控系统、会员管理系统
- 不做自动群发、自动私信
- 不做复杂权限系统
- 不做国际化
