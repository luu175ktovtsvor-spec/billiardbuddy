# 桌面 Agent · 国内生图 BYOK + 内部机制梳理（2026-06-19）

> 范围：`feat/desktop-agent` 分支（桌面盒子，可视作桌面端主分支，不碰 main）。本文梳理用户拍板的几件机制/接口事项，作为后续开发依据。

## 0. 铁律：盒子 = 纯 BYOK，不内置任何平台 key

- 盒子给门店用，**用他们自己的大模型 key**（文字 + 生图 + 将来视频），花的是门店的钱。
- 老 main（网页端）内置平台 key 是因为"会员付费、平台垫付"；**桌面盒子相反，绝不内置 key**。
- 已加固（代码强制，不靠 env 恰好为空）：`factory.get_image_config_for_store` 在 `DESKTOP_LOCAL=1` 下没配 BYOK 即返回**空 key**（逼老板去「模型设置」填自己的），绝不回退平台 key；云端 web 行为不变（仍回退平台默认垫付）。文字侧同理（空 key → 桌面 503 BYOK 卡点）。
- 审计确认：源码无硬编码 key（`config.py` 默认空）、无 `.env` 被 git 跟踪、`backend.js` 只注入 `DATABASE_URL/DESKTOP_LOCAL/RAG_EMBEDDER`，不注入模型 key。
- **gpt-image-2 不内置为默认，但保留为可选模型接口**：老板自带 OpenAI key（能直连的场景）可在模型设置里选它。

## 1. 国内生图模型怎么接入（核心：大陆调不了 OpenAI）

盒子在大陆，调不了 `api.openai.com`，**生图必须用国内模型 + 老板自己的 key**。已查证三档接入路径：

| 档 | 模型/平台 | 接入方式（查证） | 工作量 |
|---|---|---|---|
| **T1 已打通** | **硅基流动 SiliconFlow** | **OpenAI 兼容** `/images/generations`，一个 key 通吃 Kolors(快手可图)/FLUX 等。老板填 `base_url=https://api.siliconflow.cn/v1` + key + `model=Kwai-Kolors/Kolors` | 代码层已通（见下） |
| **T2 待适配器** | **通义万相**（阿里百炼 DashScope） | 文生图是**原生异步**（建任务→轮询，1-2 分钟），非 OpenAI 那套 | 写专属 ImageProvider 适配器 |
| **T3 待适配器(含视频)** | **即梦 / Seedance**（字节火山方舟） | 原生 API，按 token 计费；还能文生**视频** | 适配器；顺带解锁视频 |

**已落地的代码（T1 基础设施，本次提交）**：
- `openai_image.py`：① 用传入的 `model`（不再写死 gpt-image-2）；② `quality` 是 gpt-image 专有参数，仅 gpt-image 系列才传（国内端点多不接受）；③ 响应兼容 b64_json 与 **url**（国内端点多回 url，`_extract_image_bytes` 即时下载）。
- `poster_service.py`：把 `get_image_config_for_store` 取到的门店模型真正传下去（原来取了又写死 gpt-image-2）。
- 单测 `test_image_provider_byok.py`：模型透传 / quality 条件 / url 响应 / 桌面纯 BYOK 守卫。

**待办（按需做，需各自查证官方文档再写，勿凭记忆）**：
- 校准 T1 硅基流动的精确参数（其 image 端点用 `image_size`/`batch_size`，可能需薄适配层）——真机用老板 key 验。
- T2 通义万相、T3 即梦/Seedance 原生适配器（异步建任务→轮询）。
- **接入 UX**：模型设置页"我的 AI 模型"——文字 / 生图 /（将来）视频 三块；预设卡片（硅基流动 / 通义 / 即梦）一键预填 base_url，或手动粘 base_url+key+model（沿用现有 CC Switch 多供应商快切）。

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
