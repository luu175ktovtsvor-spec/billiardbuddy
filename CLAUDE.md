# 球房 AI 运营助手

## 项目简介

面向台球房行业的 AI 运营辅助 SaaS 工具。帮助台球房老板/店长/员工完成文案生成、活动策划、海报制作、员工话术、社群运营等日常运营工作。

**这不是**收银系统、灯控系统、会员管理系统。不做开台、计费、灯控、收银、库存、会员充值。

## 当前状态

- **GitHub**: https://github.com/luu175ktovtsvor-spec/billiards-ai-ops （私有仓库）
- **服务器**: 阿里云 ECS `39.106.214.21`，Nginx + systemd
- **前端**: Next.js 14 standalone 模式，端口 3000
- **后端**: FastAPI + uvicorn，端口 8000
- **数据库**: PostgreSQL 14，库名 `billiards_ai`
- **AI**: DeepSeek API（文本），阿里云百炼 + OpenAI（图片，8 个模型）
- **部署文档**: `docs/服务器部署交接文档.md`

## 技术栈

- **前端**: Next.js 14 + React 18 + TypeScript + TailwindCSS + shadcn/ui
- **后端**: Python 3.12+ + FastAPI + SQLAlchemy + Alembic
- **数据库**: PostgreSQL 14
- **海报合成**: Pillow (Python) + AI 生图（阿里云百炼/OpenAI）
- **包管理**: pnpm (前端) / uv (Python 后端)

## 项目结构

```
web/                    # Next.js 前端
  src/
    app/
      (auth)/           # 登录/注册
      dashboard/        # 主界面（需登录）
        workbench/      # 岗位工作台（核心功能）
        posters/        # AI 海报生成
        history/        # 生成历史
        store-settings/ # 门店资料管理
    components/
      ui/               # shadcn/ui 基础组件
      layout/           # 布局组件（header, sidebar, mobile-nav）
      generators/       # AI 生成结果展示（copy-button）
    lib/
      api.ts            # API 客户端（统一 fetch 封装，token 刷新，SSE 流式）
      utils.ts          # 工具函数（cn, getErrorMessage）
      role-workbench-config.ts  # 岗位任务卡片配置（44 个任务卡片）
      workbench-config.ts       # 工作台配置
    hooks/
      auth-context.tsx  # 认证上下文（login/register/logout）
    types/              # TypeScript 类型定义

server/                 # FastAPI 后端
  api/v1/              # API 路由（auth, stores, generate, stream, posters, generations, knowledge, dashboard, outreach, sop, games, performance, diagnosis）
  core/                # 安全、配额、异常
  models/              # SQLAlchemy ORM 模型（user, store, generation, quota）
  schemas/             # Pydantic 请求/响应模型
  services/
    ai/
      prompt_engine.py # Prompt 模板引擎（单例，get_prompt_engine()）
      factory.py       # Provider 工厂
      providers/       # AI 模型实现
        deepseek.py    # DeepSeek 文本模型
        bailian.py     # 百炼文本模型
        openai_image.py # OpenAI 图片模型（GPT Image 2/1/Mini, DALL-E 3）
        aliyun_image.py # 阿里云图片模型（万相 2.1/2.7, Z-Image）
    content_service.py # 文案生成核心逻辑
    poster_service.py  # 海报生成（AI 生图 + Logo/二维码叠加）
    poster/
      composer.py      # Pillow 图片合成（Logo + 二维码叠加）
    store_profile_service.py  # 门店运营画像
    dashboard_service.py      # 今日工作台规则引擎
    quota_service.py   # 配额管理
    shared.py          # 共享工具函数（待创建）
  db/                  # 数据库连接 + Alembic 迁移
  prompts/             # Prompt 模板 YAML 文件
    knowledge/         # 29 个行业知识文件
    rules/             # 角色规则 + 客户规则
    operation/         # 运营场景 prompt
    copywriting/       # 文案 prompt
    activity/          # 活动 prompt
    recruitment/       # 招聘 prompt
    fewshots/          # fewshot 示例
  main.py              # 入口
```

## 核心架构原则

1. **场景驱动，不是对话驱动** — 用户通过岗位工作台（Workbench）的场景卡片+自然语言输入触发 AI 生成，不做自由聊天
2. **门店数据隔离** — 所有业务数据绑定 `store_id`，查询必须过滤 store_id
3. **AI Provider 抽象** — 文本模型和图片模型各有独立抽象基类（`TextProvider` / `ImageProvider`），通过 `ProviderFactory` 创建实例
4. **Prompt 模板与业务解耦** — Prompt 存放在 `server/prompts/` 下的 YAML 文件中，支持 `{variable}` 占位符
5. **PromptEngine 是单例** — 通过 `get_prompt_engine()` 获取，不直接 `PromptEngine()`
6. **海报 = AI 生图 + Logo/二维码叠加** — AI 生成背景图，Pillow 叠加门店 Logo 和二维码
7. **不做自动触达** — 只生成内容供人工复制使用，不做自动群发、自动私信

## 开发规范

### 前端

- 使用 Next.js App Router，不用 Pages Router
- 组件默认用 Server Component，需要交互时加 `"use client"`
- 样式用 TailwindCSS，不写自定义 CSS 文件
- API 请求统一通过 `lib/api.ts` 封装
- useEffect 中的 API 调用必须加 `cancelled` flag 防止卸载后 setState
- SSE 流式输出用于工作台生成（`streamWorkbench`）
- 错误处理用 `lib/utils.ts` 的 `getErrorMessage`

### 后端

- API 版本前缀 `/api/v1/`
- 请求/响应模型用 Pydantic v2 的 `BaseModel`
- 数据库操作用 async SQLAlchemy
- 认证用 JWT（access token），密码用 bcrypt 哈希
- 文件上传存本地目录 `server/uploads/`
- AI 调用结果写入 `generations` 表，记录 prompt、model、tokens
- PromptEngine 是单例，通过 `get_prompt_engine()` 获取，不要直接 `PromptEngine()`
- Knowledge YAML 必须有 `template:` 和 `key:` 字段，否则 PromptEngine 加载会报错

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

## 代码同步与部署

代码通过 GitHub 同步，服务器通过 git pull 拉取。

```bash
# 本地改完代码后
git add .
git commit -m "描述"
git push origin main

# 服务器上部署
ssh root@39.106.214.21
bash /var/www/billiards-ai/deploy.sh
```

一键脚本会自动：git pull → 重启后端 → 重新构建前端 → 重启前端 → 检查状态

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

# 服务器
ssh root@39.106.214.21
systemctl status billiards-backend billiards-frontend
journalctl -u billiards-backend -n 50 --no-pager
```

## 已完成功能

| 模块 | 状态 |
|------|------|
| 用户注册/登录（手机号+密码） | ✅ |
| 门店资料管理（运营画像） | ✅ |
| Prompt 引擎（YAML 模板，29 个 knowledge） | ✅ |
| 岗位工作台（Workbench，SSE 流式输出） | ✅ |
| 文案生成（朋友圈/群公告/活动/日报） | ✅ |
| 海报生成（8 个 AI 模型 + Logo 叠加 + 二次调整） | ✅ |
| 生成历史 | ✅ |
| 配额管理 | ✅ |
| 多 AI Provider（DeepSeek/百炼/OpenAI） | ✅ |
| fewshot 选择器 | ✅ |
| 服务器部署（git + deploy.sh） | ✅ |

## 行业知识体系

产品大脑文档在 `docs/product-brain/`，原始行业资料在桌面 `台球行业资料收集/`。

核心知识模块（29 个 knowledge YAML）：
- **每日工作流程** (`daily_workflow.yaml`) — 6 个角色的每日工作流 + 5 个延伸场景
- **竞技群运营** (`competitive_group_ops.yaml`) — 教练维护竞技群的日常动作
- **助教推广获客** (`assistant_promotion.yaml`) — 朋友圈/短视频/现场推荐/客户维护
- **助教服务 SOP** (`assistant_service_sop.yaml`) — 上钟前/中/后全流程
- **好评文案规范** (`review_generation_rules.yaml`) — 美团/抖音好评写法
- **教练刁钻问题** (`coach_difficult_situations.yaml`) — 18 个真实场景话术
- **PK 激励机制** (`pk_incentive.yaml`) — 三层 PK 体系
- **客户标签体系** (`customer_tagging.yaml`) — 6 类客户 + 打标签方法
- **开业筹备** (`opening_preparation.yaml`) — 30 天时间线 + 开业 SOP
- **管理层招聘** (`management_recruitment.yaml`) — 岗位画像 + 面试话术
- **充值策略** (`recharge_strategy.yaml`) — 一卡通模式 + 小比例赠送
- **绩效标准** (`performance_standards.yaml`) — 5 个岗位考核维度
- **赛事规则** (`tournament_rules.yaml`) — 赛事全流程 + 主持词模板
- **前厅培训** (`frontdesk_training.yaml`) — 培训手册 + 服务标准
- **小游戏** (`mini_games.yaml`) — 12 个小游戏规则
- **盈利模型** (`profit_model.yaml`) — 收入结构 + 成本分析
- **合规规则** (`compliance_rules.yaml`) — 平台规则 + 禁用词
- 更多见 `server/prompts/knowledge/`

## 不要做的事

- 不做微服务，单体应用
- 不做国际化
- 不做复杂权限系统（只需 boss/manager/assistant_manager/coach/frontdesk/operator 六角色）
- 不做 Prompt 可视化编辑器
- 不做海报拖拽编辑器
- 不做 WebSocket 实时协作
- 不做自动群发、自动私信
- 不在 AI 生图 Prompt 中包含中文文字、价格、Logo、二维码

## 文档维护规则

1. 完成工作后实时更新相关文档，不做完不更新
2. 过时文档移入 `docs/archive/`，不删除
3. 新增文档按类别放入 `docs/` 对应子目录，不堆根目录
4. `docs/product-brain/` 是活文档，调整 Prompt 或业务规则时必须同步更新
5. 文档导航见 `docs/README.md`
