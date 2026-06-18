# 桌面 Agent · 国内生图 BYOK + 内部机制梳理（2026-06-19）

> 范围：`feat/desktop-agent` 分支（桌面盒子，可视作桌面端主分支，不碰 main）。本文梳理用户拍板的几件机制/接口事项，作为后续开发依据。

## 0. 铁律：盒子 = 纯 BYOK，不内置任何平台 key

- 盒子给门店用，**用他们自己的大模型 key**（文字 + 生图 + 将来视频），花的是门店的钱。
- 老 main（网页端）内置平台 key 是因为"会员付费、平台垫付"；**桌面盒子相反，绝不内置 key**。
- 已加固（代码强制，不靠 env 恰好为空）：`factory.get_image_config_for_store` 在 `DESKTOP_LOCAL=1` 下没配 BYOK 即返回**空 key**（逼老板去「模型设置」填自己的），绝不回退平台 key；云端 web 行为不变（仍回退平台默认垫付）。文字侧同理（空 key → 桌面 503 BYOK 卡点）。
- 审计确认：源码无硬编码 key（`config.py` 默认空）、无 `.env` 被 git 跟踪、`backend.js` 只注入 `DATABASE_URL/DESKTOP_LOCAL/RAG_EMBEDDER`，不注入模型 key。
- **gpt-image-2 不内置为默认，但保留为可选模型接口**：老板自带 OpenAI key（能直连的场景）可在模型设置里选它。

## 1. 国内生图模型怎么接入（核心：大陆调不了 OpenAI）

盒子在大陆，调不了 `api.openai.com`，**生图必须用国内模型 + 老板自己的 key**。逐项查证官方文档后，国内生图分**两大阵营，不是"接口一样只换 key"**：

| 阵营 | 厂商（查证 base_url） | 关键差异 | 代码状态 |
|---|---|---|---|
| **OpenAI 兼容**（base_url+key+model 三件套，复用 `OpenAIImageProvider`） | 火山方舟·即梦 Seedream `ark.cn-beijing.volces.com/api/v3`（同步直返，同平台还能视频）/ 智谱 CogView `open.bigmodel.cn/api/paas/v4`（cogview-3-flash 免费）/ 阶跃 Step `api.stepfun.com/v1` / 百度千帆 `qianfan.baidubce.com/v2` / OpenAI gpt-image-2(海外) | 标准 `/images/generations`，回 url 或 b64 | ✅ 已支持（openai_image 用配置模型 + url/b64 双响应 + 条件 quality） |
| **硅基流动**（聚合平台·一个 key 通吃 Kolors/Qwen-Image/SD…最省事） `api.siliconflow.cn/v1` | 字段 `image_size`/`batch_size`、回 `images[].url`(1h) | ✅ `SiliconFlowImageProvider`（字段映射） |
| **通义万相**（阿里）`dashscope.aliyuncs.com/api/v1` | 原生**异步**：建任务→轮询 task_id（1-2 分钟），size 用星号 `*`，url 24h | ✅ `DashScopeImageProvider`（异步轮询） |
| **腾讯混元 / MiniMax** | 原生（腾讯云签名鉴权 / 下划线端点 `image_generation`、`aspect_ratio`、`data.image_base64`） | 🔜 适配器待写（已登记目录，调用给清晰报错引导） |

**计费**：国内生图全是**按张后付费、无包月订阅**（约 0.06–0.25 元/张；cogview-3-flash 免费、通义新人送 50 张/90天、文心每日免费额度）。订阅/TPM 套餐是文本模型的，与生图无关。url 多 1–24h 有效，生成后立即下载落盘。

**"口子"已落地（本次提交）**：
- `services/ai/providers/image_catalog.py`：CC Switch 式供应商目录 `IMAGE_PROVIDER_CATALOG`（前端据此渲染"选供应商"卡片 + 预填 base_url）+ `resolve_image_kind(base_url)`（按 base_url 自动路由 kind，**免新增 DB 字段**）+ `fetch_image_bytes`（下载短期 url）。
- `factory.build_image_provider(key, base_url, model)`：按 kind 选 provider 类；`poster_service` 改用它（不再写死 OpenAIImageProvider）。
- **扩展方式（口子）**：新增 OpenAI 兼容厂商 = 往目录加一条；新增原生厂商 = 写一个 `ImageProvider` 子类 + 在 `build_image_provider` 登记。
- 单测 `test_image_providers_domestic.py` + `test_image_provider_byok.py`（路由 / 字段映射 / 异步轮询 / 纯 BYOK 守卫，mock httpx）。**真机出图需老板的 key 在盒子上验。**

**待办**：① 真机用老板 key 验各家出图（尤其硅基流动 image_size、通义异步轮询）；② 腾讯混元/MiniMax 原生适配器；③ 火山 Seedream 关水印（extra_body watermark=false）；④ 视频(Seedance)适配器。
- **接入 UX（待前端做）**：模型设置页"我的 AI 模型"——文字 / 生图 /（将来）视频；预设卡片（硅基流动/火山/智谱/阶跃/百度/通义…）一键预填 base_url，老板填 key + 选 model（沿用现有 CC Switch 多供应商快切）。

## 2. 海报"风格 → 提示词"机制（模型无关）

用户问：选的色调/风格会不会喂给大模型？**会，但方式是安全、模型无关的：**
- 风格选项（暖色温馨/动感霓虹/…）→ **我们自己的 Python 提示词构建器** → 一段"视觉风格"提示词 → 喂给老板 BYOK 的那个模型。换任何模型都通用。
- **只有"视觉风格"进提示词；文字/价格/Logo/二维码不进提示词**，由 Pillow 叠加（沿用现有"海报=AI生图+叠加"架构）。原因：国内模型中文渲染参差、二维码 API 渲染必不可扫——文字交给叠加才稳。
- 风格做成**数据驱动的清单（可扩展）**，不止 3 条。建议起手集：暖色温馨 / 动感霓虹 / 简约高级 / 节日喜庆 / 高端轻奢 / 活力运动 / 清新 ins / 复古港风（老板也可"自己说"自定义）。

## 3. 省 token / Harness / 智能体（内部机制 roadmap）

- **省 token**（已做：店脑按需召回、history 封顶 12 条/2000 字、超大工具结果截断；待做：渐进式披露——SOP/工具先给摘要按需加载、autoCompact 长对话自动摘要）。
- **Harness 更强**：我们**自己的 Python harness**（非内置 Claude Code 代码）——已做循环状态机化+去重、入参校验+失败回灌、结构化结果、权限瀑布+force_confirm；待做：AskUserQuestion、Pre/PostToolUse hooks、子 Agent。
- **智能体更好**：北极星 eval（`server/evals/`）量化对齐；模型遵循是天花板 → BYOK 多供应商快切让老板换更强模型；铁律代码闸兜底。

## 我们的定位
**只做壳子**：harness（脑的调度）+ 工具执行层 + 四层防御 + UI + BYOK 接入管道。**模型由老板自带**，我们不内置 key、不托管模型、不内置 Claude Code 的代码（架构借鉴、代码自写）。
