# 球房 AI 运营助手 — 代码问题与 Bug 分析报告

> 生成时间：2026-05-28
> 分析范围：前后端完整代码（server/ + web/）
> 分析维度：运行时 Bug、潜在问题、代码质量、安全与部署风险

---

## 一、高优先级问题（部署前必须修复）

### 问题 1：海报中文字体依赖系统字体（部署风险）

**位置：** `server/services/poster/composer.py:13-22`

```python
_FONT_SEARCH_PATHS = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    ...
]
```

**风险：** 这些字体路径是 macOS 系统字体。如果部署到 Linux 服务器（如阿里云 ECS），Pillow 找不到中文字体，海报上的中文会显示为方框。

**建议：**
1. 将思源黑体（SourceHanSansSC）字体文件放入项目 `server/assets/fonts/` 目录。
2. 修改 `_find_font_path()` 优先查找项目目录下的字体文件。
3. 在 Dockerfile 中安装中文字体（如 `fonts-noto-cjk`）。

---

### 问题 2：DeepSeek Provider 缺少错误处理和重试

**位置：** `server/services/ai/providers/deepseek.py:32-43`

```python
async def generate(self, request: TextRequest) -> TextResponse:
    # ... 直接调用 API，没有 try/except
    response = await client.chat.completions.create(...)
```

**风险：** AI API 调用可能失败（网络超时、API 限流、服务不可用等），当前代码没有处理这些情况，会导致 500 错误返回给前端。

**建议：**
1. 添加 try/except 捕获 API 调用异常。
2. 实现重试机制（指数退避）。
3. 返回友好的错误信息给前端。

---

### 问题 3：JWT Secret Key 使用默认值

**位置：** `server/config.py:13`

```python
secret_key: str = "change-me-to-a-random-string"
```

**风险：** 如果用户忘记在 `.env` 中设置 `SECRET_KEY`，系统会使用默认的弱密钥，JWT 签名可被轻易伪造。

**建议：**
1. 启动时检查 `secret_key` 是否为默认值，如果是则抛出警告或拒绝启动。
2. 或在生产环境配置中强制要求设置 `SECRET_KEY`。

---

### 问题 4：CORS 配置允许所有来源

**位置：** `server/main.py:36-44`

```python
cors_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

**风险：** 生产环境 `cors_origins` 包含 `http://localhost:3000,http://localhost:3001`，如果忘记修改，可能导致跨域安全问题。

**建议：** 生产环境必须修改为实际域名，不允许 `*` 或 `localhost`。

---

### 问题 5：content_service 中 prefixes_to_strip 硬编码

**位置：** `server/services/content_service.py:300-311`

```python
prefixes_to_strip = [
    "好的，店长！",
    "好的，店长",
    "好的！",
    "没问题，我来帮你",
    "以下是为你生成的",
    "好的，没问题！",
]
```

**风险：** 这些前缀是硬编码的中文字符串，如果 AI 模型输出其他前缀（如"好的，老板！""没问题"等），就无法去除。

**建议：**
1. 将前缀列表提取到配置文件中。
2. 使用正则表达式匹配更灵活。
3. 或者更好的做法是在 Prompt 中明确要求 AI 不要输出这些前缀。

---

## 二、中优先级问题（影响稳定性）

### 问题 6：缺少 usage_quotas 表但文档已规划

**位置：** 文档 `architecture-design.md` §5.5

文档中规划了 `usage_quotas` 表，用于按月计数文本/图片/海报生成次数。虽然文档 §20.1 说"P0 不做配额拦截，只在 generations 表记录调用"，但如果后续需要实现配额系统，需要重新设计。

**建议：** 在 P2 阶段实现配额系统时，参考文档中的表设计。

---

### 问题 7：缺少 ImageProvider 实现

**位置：** 文档 `architecture-design.md` §6.1

文档中规划了 `ImageProvider` 抽象基类和 `OpenAIImageProvider` 实现，但代码中只有基类定义，没有具体实现。

**建议：** 在 P2 阶段接入 AI 图片生成模型时，实现 `OpenAIImageProvider` 或 `DeepSeekImageProvider`。

---

### 问题 8：Prompt 模板目录结构不完整

文档规划（`architecture-design.md` §3.1）：

```
prompts/
├── copywriting/
│   ├── moments.yaml
│   ├── group_notice.yaml
│   └── invitation.yaml
├── activity/
│   └── planning.yaml
├── scripts/
│   └── employee.yaml
├── community/
│   └── daily.yaml
└── poster/
    └── background.yaml
```

实际代码：

```
prompts/
├── workbench/
│   └── free_intent.yaml
├── rules/
│   ├── baseline_rules.yaml
│   ├── customer/
│   └── role/
├── copywriting/
│   └── ...
└── activity/
    └── ...
```

**差异：** `scripts/` 和 `community/` 目录下的 YAML 模板未找到。当前主要使用 `workbench/free_intent.yaml` 作为统一入口。

**建议：** 确认是否还需要独立的 scripts 和 community 模板，还是统一通过 workbench 处理。

---

### 问题 9：前端 API 客户端缺少 SSE 支持

文档 §4.5 中规划了 SSE 流式输出组件（`hooks/use-sse-generate.ts`），但当前前端代码中没有找到这个 hook。

**建议：** 在 P2 阶段实现 SSE 流式输出时，参考文档中的实现方案。

---

### 问题 10：缺少测试覆盖

项目中没有测试文件（除了 `test_10g2.py`、`test_10g5.py` 等临时测试脚本）。

**建议：** 在 P2 阶段添加单元测试和集成测试。

---

## 三、低优先级问题（代码优化）

### 问题 11：前端 generate/page.tsx 文件过大（1048 行）

**位置：** `web/src/app/dashboard/generate/page.tsx`

该文件包含 5 个 Tab 的表单逻辑，代码量过大，维护困难。

**建议：**
1. 将每个 Tab 的表单拆分为独立组件。
2. 将业务逻辑提取到自定义 hooks 中。

---

### 问题 12：role-workbench-config.ts 文件过大（812 行）

**位置：** `web/src/lib/role-workbench-config.ts`

该文件包含 6 个岗位的 44 张任务卡片配置，代码量过大。

**建议：**
1. 将每个岗位的配置拆分为独立文件。
2. 使用动态导入（`import()`）按需加载。

---

### 问题 13：store_profile_service.py 文件过大（576 行）

**位置：** `server/services/store_profile_service.py`

该文件包含运营画像的完整度计算和上下文渲染，代码量过大。

**建议：**
1. 将完整度计算和上下文渲染拆分为独立模块。
2. 将各个模块的渲染逻辑提取为独立函数。

---

### 问题 14：workbench_fewshot_service.py 中的样例库路径硬编码

**位置：** `server/services/workbench_fewshot_service.py:25`

```python
_EXAMPLES_YAML_PATH = _PROJECT_ROOT / "docs" / "product-brain" / "workbench-结构化优质样例库.yaml"
```

**风险：** 如果文件路径变化，服务会静默失败（返回空字符串）。

**建议：**
1. 将路径配置化。
2. 添加文件存在性检查并记录日志。

---

### 问题 15：dashboard_service.py 中的规则引擎硬编码

**位置：** `server/services/dashboard_service.py`

规则引擎是硬编码的 Python 函数，没有使用数据库配置。

**建议：** 在 P2 阶段将规则配置化，支持动态调整。

---

## 四、安全风险检查

### 4.1 已通过的安全检查

1. **密码存储**：使用 bcrypt 哈希，不存储明文密码 ✅
2. **JWT 鉴权**：使用 HS256 算法，Token 有过期时间 ✅
3. **store_id 隔离**：所有业务查询都带 store_id 过滤 ✅
4. **API Key 不暴露**：DeepSeek API Key 只在后端环境变量中 ✅
5. **文件上传限制**：Logo/二维码上传有类型和大小限制 ✅

### 4.2 需要关注的安全问题

1. **CORS 配置**：`allow_origins` 包含 `http://localhost:3000,http://localhost:3001`，生产环境需要修改为实际域名。
2. **JWT Secret Key**：默认值为 `"change-me-to-a-random-string"`，生产环境必须修改。
3. **上传文件路径**：`upload_dir` 默认为 `"uploads"`，需要确保目录权限正确。
4. **SQL 注入**：使用 SQLAlchemy ORM，参数化查询，无 SQL 注入风险 ✅

---

## 五、部署准备度评估

### 5.1 已就绪

- [x] 前后端项目骨架
- [x] 数据库模型和迁移
- [x] 认证和门店资料
- [x] AI 生成链路（文本）
- [x] 海报合成（基础版）
- [x] 生成历史
- [x] 今日工作台
- [x] 岗位工作台

### 5.2 待完成（P2 阶段）

- [ ] SSE 流式输出
- [ ] 配额系统（usage_quotas）
- [ ] AI 图片生成模型接入
- [ ] OSS 文件存储
- [ ] 中文字体文件打包
- [ ] 生产环境配置（CORS、Secret Key、域名）
- [ ] 测试覆盖
- [ ] 日志和监控

---

## 六、总结与建议

### 6.1 总体评价

本项目代码质量较高，核心功能都已实现，且经过了多轮真实调用测试验证。但存在一些需要关注的问题，特别是部署相关的风险。

### 6.2 关键建议

1. **立即修复**：
   - 海报中文字体问题（部署到 Linux 服务器时会出问题）
   - DeepSeek Provider 错误处理
   - JWT Secret Key 默认值检查

2. **近期优化**：
   - 完善 API 错误处理和日志记录
   - 添加前端错误边界处理
   - 确认生产环境配置（CORS、Secret Key、域名）

3. **P2 阶段规划**：
   - SSE 流式输出
   - 配额系统
   - AI 图片生成模型
   - OSS 文件存储
   - 测试覆盖

---

> 报告生成完毕。如需进一步分析某个模块，请告知。
