# 球房 AI 运营助手

面向台球房行业的 AI 运营辅助 SaaS 工具。帮助台球房老板/店长/员工完成文案生成、活动策划、海报制作、员工话术、社群运营等日常运营工作。

## 在线访问

http://47.77.237.250

## 技术栈

- **前端**: Next.js 14 + React 18 + TypeScript + TailwindCSS + shadcn/ui
- **后端**: Python 3.12+ + FastAPI + SQLAlchemy + Alembic
- **数据库**: PostgreSQL 14
- **AI 文本模型**: DeepSeek V4 Flash
- **AI 图片模型**: OpenAI gpt-image-2（美国服务器直连）
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
| 用户注册/登录 | 手机号+密码，支持邀请码注册自动加入门店 |
| 门店资料管理 | 运营画像（98字段，10大模块），完整度评分 |
| 岗位工作台 | 6个岗位×80张任务卡，自然语言输入，SSE流式输出+Abort取消 |
| 文案生成 | 朋友圈/群公告/活动/日报/话术 |
| 海报生成 | gpt-image-2 + Logo/二维码直传AI + 以图生图 + 多轮对话 |
| Markdown 渲染 | AI内容格式化显示 |
| 模型选择 | DeepSeek V4 Flash + GPT Image 2 |
| thinking参数控制 | 简单任务禁用thinking节省token，复杂任务保留 |
| 行业知识库 | 38个knowledge YAML + 54个operation YAML + 15个fewshot YAML |
| 品牌声音学习 | 从"效果好"的历史内容提取风格特征注入prompt |
| Few-shot选择器 | 多维打分（角色/客户/输出/意图/助教类型），最多2条 |
| 生成历史 | 搜索、筛选、收藏、效果反馈 |
| 配额管理 | 月度使用量追踪 |
| 多租户安全 | 自动数据隔离 + RBAC权限矩阵 |
| 成员管理 | 邀请码/手动添加/角色调整/移除成员 |
| 角色tab/select状态合并 | 岗位切换体验优化 |
| inputHints可交互化 | 点击自动填入补充说明 |
| 输出包选择简化 | 推荐组合+折叠自定义 |
| 结果区按钮重新布局 | 操作按钮优化 |
| 基于此优化功能 | 支持abort+历史版本 |
| 生成完成后引导下一步 | 热门任务卡片推荐 |
| 生图场景卡片改造 | 灵感标签→卡片网格 |
| 生图基于此调整 | refine_from以图生图 |
| 生图Logo/二维码多图直传 | 最多16张图片直传AI |
| 对话历史截断 | 只保留最近3轮 |

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
  api/v1/              # API 路由（20个子路由）
  services/            # 业务逻辑
    ai/                # AI Provider（DeepSeek/OpenAI）
      prompt_engine.py # Prompt模板引擎（单例）
    content_service.py # 内容生成核心（4个生成函数）
    poster_service.py  # 海报生成
    dashboard_service.py # 今日工作台（9条推荐规则）
    brand_voice_service.py # 品牌声音学习
    workbench_fewshot_service.py # Few-shot选择器
    store_profile_service.py # 门店运营画像渲染
  prompts/             # Prompt 模板 YAML（127个）
    knowledge/         # 38个行业知识文件
    rules/             # 15个规则文件（6角色+7客户+2基线）
    operation/         # 54个运营场景模板
    fewshots/          # 15个样例库
    copywriting/       # 5个文案模板
    workbench/         # 1个自由意图模板
    templates/         # 3个预设模板
  models/              # SQLAlchemy ORM
  schemas/             # Pydantic 模型
```

## 行业知识体系

产品大脑文档在 `docs/product-brain/`。

核心知识模块（38个knowledge YAML）：
- 每日工作流程（6个角色：店长/助教管理/教练/前厅/收银/服务员）
- 核心运营逻辑、盈利模型、行业数据
- 助教体系（服务SOP/等级体系/薪资/推广/培训/刁钻问题应对）
- 赛事活动规则（10种活动类型、主持词模板）
- 绩效考核标准（5个岗位）
- 客户类型与标签体系
- 前厅培训手册、服务理念
- 合规规则、术语白名单
- 小游戏规则、台球玩法规则
- 竞技群运营、平台运营SOP
- 微信养号、管理层招聘
- 充值策略、PK激励机制
- 开业筹备、定价规则
- 核心指标公式库、客户档案模板、店长薪资结构

运营场景模板（54个operation YAML）：
- 覆盖6个岗位的日常运营场景
- 包含日报/周报/赛事/活动/推广/招聘/培训/PK/诊断等

## 不做的事

- 不做收银系统、灯控系统、会员管理系统
- 不做自动群发、自动私信
- 不做复杂权限系统
- 不做国际化
