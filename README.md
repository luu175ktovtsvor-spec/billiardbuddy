# 球房 AI 运营助手

面向台球房行业的 AI 运营辅助 SaaS 工具。帮助台球房老板/店长/员工完成文案生成、活动策划、海报制作、员工话术、社群运营等日常运营工作。

## 技术栈

- **前端**: Next.js 14 + React 18 + TypeScript + TailwindCSS + shadcn/ui
- **后端**: Python 3.12 + FastAPI + SQLAlchemy + Alembic
- **数据库**: PostgreSQL
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

## 项目结构

```
web/          # Next.js 前端
server/       # FastAPI 后端
```

## MVP 功能模块

| 优先级 | 模块 |
|--------|------|
| P0 | 用户注册/登录、门店资料管理、Prompt 引擎、AI 文案生成、活动策划 |
| P1 | 员工话术、社群内容、海报合成、今日工作台 |
| P2 | 生成历史、使用量配额、SSE 流式输出、OSS 文件存储、AI 图片生成 |
