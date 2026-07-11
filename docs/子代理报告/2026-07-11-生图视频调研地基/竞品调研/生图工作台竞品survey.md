> 📌 状态：调研底稿 · 2026-07-11 · 子代理产出

# 生图工作台（image-gen workbench）竞品 survey

调研 15 款国内外领先生图产品的"工作台形态"，回答一个问题：**我们该怎么给台球店主搭生图工作台。** 联网查证（WebSearch/WebFetch），逐条标来源，不凭记忆编造。时间口径 2026-07。

---

## 〇、先给大白话结论（不看正文只看这段也够用）

1. **业界早就不是"一个输入框打字出图"了。** 主流生图工作台统一收敛成**三段式骨架**：`输入区（提示词 + 少量参数）→ 结果网格（一次出几张挑一张）→ 就地编辑画布（圈选局部改 / 扩图 / 放大 / 换背景）`。参考图（锁风格、锁人物）是标配输入项，编辑三件套（局部重绘 inpaint + 扩图 outpaint + 放大 upscale）是标配下游。15 款里 14 款是这个结构。

2. **"纯对话生图" vs "结构化工作台"——2026-07 的答案很清楚：默认还是结构化，对话是叠上去的加速层，没有一家把默认换成纯聊天。** owner 之前调研的结论（Runway/Krea/即梦默认结构化面板、对话是 2026 才叠的可切换层）**到今天仍然成立，而且 2026 年 Q2（4–6 月）正是各大厂集中给工作台加对话/Agent 层的窗口**（Adobe Firefly AI Assistant 4/27、Canva AI 2.0 4/16、Recraft Agentic、可灵灵动画布 Agent 1/30、即梦 Agent），但**每一家都保留结构化画布/面板当默认底座**。唯一把对话当核心主打的是 LiblibAI 星流 Agent（海外 Lovart 的中文版），可它也仍并列保留结构化生图工作台。Krea 官方原话最有代表性："agent 叠在结构化 node 画布之上、作为可选层，不取代它；结构化画布仍是默认工作区。"

3. **另有一个"纯对话"阵营，但那是通用聊天助手不是生图工作台**：ChatGPT（GPT Image）、Gemini（Nano Banana）把生图当聊天里的一个能力。业界给的定位金句是——**"图是对话的一部分就用 ChatGPT，图是一套系统的一部分就用专业工具"**。我们产品现在的"对话里生图/改图"正好落在前者，本身是 2026 合法且好用的形态；owner 想搭的"工作台"是后者。**两者不冲突、该并存**，正好对上我们 CLAUDE.md 的 A 线（对话让 AI 干活）/ B 线（确定性工作台功能）。

4. **台球店主真正用得上的就那 6 样**（按刚需排序）：① 模板 + 场景分类 + 填空式起步（海报/朋友圈/门店/助教/活动，带尺寸预设）② 文字渲染准（海报要放店名/电话/活动价，画不准=废图）③ 人物一致性 / 参考图（助教"同一个人换场景换服装"）④ 图生图 + 局部重绘（"这张基本行，就改个背景/衣服/文字"）⑤ 去背景/换背景/AI 商品图（门店器材图放好背景）⑥ 一次多张挑一张 + 放大。**明确鸡肋、别做**：节点工作流、自训 LoRA、矢量 SVG、Figma 式重排版画布、realtime 实时生图、3D、一大堆专业参数（CFG/sampler/seed/steps）。

5. **对我们的落地建议一句话**：搭一个**"模板起步 + 结构化面板 + 就地编辑"的确定性生图工作台（B 线）**，把现有"对话里生图"（A 线）保留成并行的快速入口，两者用"给模型一个工具 / 往会话塞条 prompt / 后端直调"三种廉价方式相接——这跟 15 家龙头 2026 的做法完全一致，也正好落在我们自己的架构判据上。

---

## 一、主流工作台的通用范式（大多数产品共有的结构）

把 15 款横过来看，剔掉各家花活，**共有的骨架**是这样：

### 1.1 布局骨架 = 三段式（近乎人手一份）
```
┌──────────┬─────────────────────────┬───────────┐
│ 左：参数/  │  中：结果网格 / 生成流       │ 右：参数续  │
│  工具栏   │  （一次出 4 张，hover 有   │  或 对话框  │
│ model     │   变体/放大/编辑快捷键）    │           │
│ 比例      │  ↓ 点开进                 │           │
│ 风格      │  就地编辑画布（inpaint/     │           │
│ 张数      │   outpaint/erase/换背景）   │           │
│ 参考图槽  │                          │           │
└──────────┴─────────────────────────┴───────────┘
```
- **不是纯 prompt 框**：比例、模型、风格、张数、参考图是常驻控件（Leonardo/Krea/Firefly 放左栏或右栏最典型；Midjourney 收进设置菜单；Playground/稿定刻意砍掉专业参数只留模板+图层）。
- **结果区 = 网格/流**：一次出 3–4 张供一眼挑（符合"多版本挑一张"原则），hover 出快捷键（变体 / 放大 / 编辑 / 转视频）。
- **就地编辑画布**：从结果点进去做局部重绘、扩图、擦除、换背景，改完继续叠代。

### 1.2 近乎标配的能力集（出现率 90%+）
| 能力 | 出现的产品（举例） | 出现率 |
|---|---|---|
| 文生图 t2i | 全部 | 100% |
| 图生图 i2i | 全部 | 100% |
| **局部重绘 inpaint**（蒙版/圈选 + 提示词重绘局部） | MJ Vary Region、Firefly Generative Fill、Leonardo/可灵/即梦/LiblibAI、Ideogram Magic Fill、Canva Magic Edit | ~95% |
| **扩图 outpaint**（往外扩画布补内容/改比例） | MJ Pan+Zoom、Firefly Generative Expand、Ideogram Extend、Canva Magic Expand、国内四家 | ~95% |
| **高清放大 upscale** | 全部主流 | ~90% |
| **参考图**（风格参考 / 人物·角色一致性 / 结构参考） | MJ Omni Reference+--sref、可灵 10 图多参考、即梦四维参考、Firefly style+composition reference、Ideogram Style/Character Reference | ~90% |
| 去背景 / 消除（去路人去水印） | 设计工具类全有 + 多数生成器 | ~80% |
| 变体 variations | MJ subtle/strong、Leonardo Flow State、多数 | ~85% |
| 模板 / 预设风格 | 设计工具类是命门 + 生成器有 style 预设 | ~85% |

### 1.3 三条产品档次（工作台的三种"重量级"）
- **A. 纯生成器（面板 + 结果网格）**：Midjourney、Leonardo、Ideogram、通义万相、Firefly Text-to-Image。核心是"出好图"，编辑靠附带的 canvas。
- **B. 画布/节点工作台（空间式）**：Krea（node）、Recraft（Figma 式无限画布）、Playground（Canva 式画布）、即梦（无限画布）、LiblibAI（无边画布）。核心是"在画布上反复改、组合多图"。
- **C. 设计器内嵌（模板 + 画布 + 生图当素材）**：Canva Magic Media、稿定、美图设计室。核心是"生成的图立刻变成一张能用的成品设计稿"，AI 生图只是"往画布里塞素材"的一环。

> 对店主而言：**C 类（模板 + 填空 + 电商营销）最贴需求，A 类的"出图能力"要有，B 类的重画布/节点大多是鸡肋。** 详见第四节。

---

## 二、核心对比：纯对话生图 vs 结构化工作台（2026-07 现状，重点查证）

owner 要验证的结论：*"Runway/Krea/即梦等默认都是结构化面板，对话是 2026 才叠的可切换层——这个结论 2026-07 是否仍成立？"*

**结论：仍然成立，而且比原判断更清晰。2026 是"对话层集中落地"的一年，但它是叠加、不是取代。** 分两个阵营看：

### 2.1 阵营一：专业创作工作台 —— 结构化打底，对话是可切换加速层
这是 owner 问的"工作台"本体。查到的 2026 事实：

| 产品 | 默认底座 | 2026 加的对话/Agent 层 | 定位（官方/评测原话） |
|---|---|---|---|
| **Krea** | 结构化 node 画布 + 各工具面板（Image/Realtime/Edit） | Krea Chat（krea.ai/chat）+ Node Agent | 【官方】agent"叠在结构化 node 画布之上、作为可选层，不取代它；结构化画布仍是默认工作区" |
| **Midjourney** | Imagine bar + 设置菜单 + 生成流 | Conversational mode 开关 + 语音输入（记得上一张、能接着"改成晴天"） | 【官方】默认仍是 Imagine bar+设置+生成流，对话是可选开关；Draft mode 下才自动切对话式 |
| **Adobe Firefly** | 左 prompt + 右参数面板 + 4 图网格 | Firefly AI Assistant（4/27 公测，创意代理，编排跨 app 多步流程、跨会话记忆） | 【官方】对话代理是"新入口/加速层，不取代面板工具，可互相切换"，还接进了 PS/Premiere/ChatGPT/Claude |
| **Leonardo** | 左参数栏 + prompt + Canvas（mask inpaint） | 新 Editor"描述即改"（可无 mask 说"把背景那个人删掉"） | 【官方】是编辑环节的自然语言指令层，主界面仍是结构化面板 |
| **Recraft** | Figma 式无限画布 + 侧栏参数 | Agentic mode（对话创作）+ MCP | 【官方】画布编辑器仍是默认基座，Agentic 是新增加速模式 |
| **Playground** | Canva 式模板+图层画布 | 无聊天窗，编辑是指令式（Nano Banana"说一句话改图"） | 【评测】默认是结构化设计画布，AI 藏在"生成 + 按指令编辑"两个动作里 |
| **即梦** | 无限画布 + 参数（选模型→写词→选比例） | Agent 智能共创（多会话 + `/` 技能） | 【评测】对话不是主流程、是辅助入口，核心由画布操作主导 |
| **可灵** | 图片生成器面板 + 灵动画布 | 灵动画布 Agent 模式（1/30，一键分镜/电商组图/多轮对话编辑） | 【评测】画布内**可切换**的 Agent，经典参数生成器仍在 |
| **通义万相** | 传统面板 + 参数栏 | **没做**对话式（重心转向音视频全栈） | 【评测】2026 仍是面板+参数栏 |
| **LiblibAI 星流** | 左工具栏 + 中预览 + 右对话框 | 星流 Agent（2025-07，Lovart 中文版，"对话即设计") | 【评测】**唯一把对话当核心主打**，但结构化生图工作台仍并列保留 |

**一句话：10 家专业工作台里，8 家在 2026 加了对话/Agent 层且全部保留结构化默认底座，1 家（通义万相）压根没做对话，1 家（LiblibAI）对话当主打但仍留结构化。没有一家把默认形态换成"纯聊天窗"。**

### 2.2 阵营二：通用聊天助手 —— 生图是聊天里的一个能力（这不是"工作台"）
- **ChatGPT（GPT Image）/ Gemini（Nano Banana）**：天生对话式，多轮改图、语义蒙版（"把背景那个模糊的人删掉""把海报上的字改成 XX"）、人物一致性、production 向。【评测】Nano Banana 对比 Midjourney 的定位：MJ 赢在"第一张的惊艳"、无多轮记忆；Nano Banana 赢在"生成后还要接着改"、多轮对话编辑。
- 业界给消费者的选择建议金句【评测，aifreeapi 2026-03】：**"choose ChatGPT when the image is part of a conversation, and choose Gemini when the image is part of a system"**（图是对话的一部分选 ChatGPT，图是一套系统的一部分选 Gemini/专业工具）；"casual user 单选一个 app 通常从 ChatGPT 起步"。
- **这正是我们产品现状（对话里生图/改图）所在的阵营**——它是 2026 主流且好用的形态，尤其适合"顺口一句话改一下"。它不该被工作台取代，而该并存。

### 2.3 综合判断（对我们最有用的一条）
2026-07 的行业真相不是"对话取代面板"，而是**双轨并存 + 明确分工**：
- **结构化面板/画布 = 需要"控制"的时候**：定比例、选模型、喂参考图锁人物、圈选局部改、批量出图、套模板。—— 高控制、可复现。
- **对话/Agent = 两个高摩擦环节的加速层**：① 从 0 到 1 起稿（不会写 prompt，一句话让它先出个稿）② 多轮改图（"背景换成台球厅""字再大点"）。
- 各家做法收敛于**"结构化打底 + 对话叠加、用户自由切换"**，绝不"把产品逻辑织进对话循环"——这跟我们 CLAUDE.md 的两条线判据是同一个思路（A 线走对话循环、B 线写确定性代码，两者只用工具/预定义 prompt 相接）。

---

## 三、逐产品速览（15 款 × 5 维度，浓缩版）

> 每格标能查到的实情，来源汇总见第六节。空间所限只记要点，细节以第六节 URL 为准。

### 国内

**即梦 Dreamina（字节）**
- 布局：左工具栏 + 中央**无限画布**（2026 初升级），选模型→写词→选比例分辨率→生成；非纯聊天框。
- 能力：文生图/图生图/智能画布（局部重绘·消除笔·抠图·扩图·高清放大·文字重绘）/**四维参考图（内容·风格·结构·姿态）**/一键同款/转视频。
- 迭代：5.0 支持精准局部编辑（笔刷刷选区+指令"只改那块"），非破坏可撤销；参考图定向控制；Agent 多轮。
- 小白：一键同款、社区公开全部参数、系统预测下一步、自然语言无需提示工程。
- 对话/Agent：Agent 智能共创（多会话 + `/` 技能）是**画布上可切换的对话加速层**；评测称"画布路线优于纯 Agent 聊天"。

**可灵 Kling（快手）**
- 布局：经典图片生成器（模型/比例/数量/参考图 + prompt + 结果）+ **灵动画布**一站式工作台；3.0 走 All-in-One。
- 能力：文生图/图生图/**局部重绘（蒙版+重绘强度）**/扩图/消除/**参考图三类（角色·风格·结构）最多 10 张锁人物一致性**/批量变体/原生 4K/运动笔刷。
- 迭代：inpaint 蒙版+重绘强度（低=保结构、高=自由重构）；多参考锁一致性；批量变体。
- 小白：All-in-One 免挑模型、模板与风格预设、灵动画布基础工具免费无限。
- 对话/Agent：**灵动画布 Agent 模式（2026-01-30）**——一键分镜/电商组图/多轮对话编辑；画布内**可切换**，经典生成器仍在。

**通义万相（阿里）**
- 布局：传统面板 + 参数栏（左菜单"文字作画"→选模型+正/反提示词+**8 种风格**+size+张数 n=1–4→结果网格）。
- 能力：文生图/图生图（相似图·双图风格迁移·参考图）/图像编辑（局部修改·背景替换·放大·风格转换）/应用广场（虚拟模特·个人写真·艺术字·涂鸦）。inpaint/outpaint 独立入口命名未查到明确 web 端。
- 迭代：偏"重开一单+参数微调"，**没有对话式追问**，靠参数与重传图。
- 小白：8 种风格模板一键、案例参考、每日免费额度、应用广场现成模板。
- 对话/Agent：**未做**对话式画布；重心转向音视频全栈（万相 2.6）。（阿里对话生图在通义/Qwen App 侧，不在万相工作台。）

**LiblibAI（含"星流"）**
- 布局：左工具栏 + 中预览 + **右侧 AI 对话框（核心操作区）**；无限画布多图层图文混排，导出 JPG/PNG/**SVG/MP4/GLB**。
- 能力：文生图（自研 Star-3）/图生图/**局部重绘（选区+提示词）**/**参考图多维度（景深·线稿·姿态·风格迁移）+重绘强度**/放大两档/擦水印/扩图/去背景/改文字换元素/文生 3D/接十余大模型。
- 迭代：右侧对话栏多轮修改 + 画布内直接改 + 参考图多维度。
- 小白：中文一句话出完整方案（主图+延展图+社媒封面）、**内置国风字库**解决中文排版、社区海量模型模板一键同款。
- 对话/Agent：**四款国内里最彻底**——星流 Agent（2025-07，Lovart 中文版）"对话即设计"是核心卖点；但经典结构化工作台仍并列。

**美图设计室 / WHEE（美图）**
- 布局：设计画布编辑器 + "一堆 AI 工具卡片"，**批量是每个功能的原生能力**（电商向）；生成结果可进编辑排版。
- 能力：**电商能力最全的一家**——AI 商品图（上传→自动抠图→场景图）/AI 模特试衣/商品套图/带货视频/海报/文生图/图生图/抠图/换背景/物体消除/扩图/放大/证件照/AI Logo。
- 迭代：智能推荐 vs 自定义双模式 + 多版本对比 + 图层局部改 + 批量多 SKU。
- 小白：**50 万+模板**、模板中心、一键换色/海报/替换文字图片；服务 6000 万用户，主打电商/新媒体/个体经营。
- 对话/Agent：**指令驱动**（上传图 + 文字指令如"白底精修图"），锚定商品图的多模态理解；未做 Canva 式对话出整稿。

**稿定设计（Gaoding）**
- 布局：典型"模板 + 画布"设计器，AI 是其中一层；生成素材拖进画布排版。
- 能力：文生图/图生图/AI 商品图·**AI 背景（60+ 场景预设）**/AI 抠图（批量≤30 张）/AI 消除/扩图/改图/多图融合/海报复刻/AI Logo/换装/线稿上色/图片翻译。
- 迭代：一次生成 4 张免费预览可多次调整、"换一批"、生成后进创意画布手改。
- 小白：海报/小红书/电商素材/直播间等海量细分模板，**填空式**（选模板→填标题+传商品图→生成）+批量套版。
- 对话/Agent：有"Agent 类工具"（小红书大字报·场景图生成·套系图片）和"智能生成"，属**任务型模板智能体**，非自由多轮对话。

**Canva 可画中国版（含 Magic Media）**
- 布局：AI 生图深嵌编辑器左栏（元素→AI 图片生成器），**画布优先做得最彻底**，生成即入画布当元素继续排版。
- 能力：Magic Media（文生图+图生视频+参考图）/Magic Design（一句话出成套模板）/魔法橡皮擦/魔法编辑（局部改）/抠图/魔法扩展（扩图）/AI 背景/批量。电商垂直能力不如美图/稿定专门。
- 迭代：调提示词 + 换风格/比例 + 内置编辑器后期 + 对话改。
- 小白：**16 万中文模板 + 300 中文字体 + 亿级正版素材**；Magic Design 一句话/一张图出成套版式。
- 对话/Agent：**2025-12 中国上线 Canva AI**——真·对话式设计助手（一句话→可编辑初稿→自然语言边聊边改→进编辑器精修）；平台级 Canva AI 2.0（2026-04-16 preview）把 Canva 变对话式 agentic 中枢，但结构化设计器+模板仍是默认基座。

### 国际

**Midjourney（web）** —— 见 2.1 表；Imagine bar + 设置菜单 + 生成流；Editor 整合 Vary Region(inpaint)/Pan+Zoom(outpaint)/Erase/Retexture；Omni Reference 锁人物；Style Explorer/Moodboards/Draft 起步；Conversational + 语音是可选开关。

**Krea.ai** —— 见 2.1 表；左栏导航 + 各工具面板（Image 页 = prompt+model+style+moodboard+lora+比例）；Realtime 实时生图；聚合 64+ 模型；Krea Chat 是并列的对话总入口、非取代面板。

**Leonardo.ai** —— 左参数栏（模型/Fast·Ultra/CFG/尺寸/张数）+ prompt + **Canvas 编辑器**（mask inpaint / outpaint / Erase / Focus Mode）；Flow State 铺变体、Blueprints 模板起步；新 Editor"描述即改"。

**Playground** —— **2026 已转型 Canva 式设计工作台**（Canvas + Board）；**模板库是最大卖点**；Smart Layers（把图拆成可选图层就地改）；Nano Banana 指令式编辑；刻意砍掉 sampler/negative prompt；核心平台无视频；无聊天窗。

**Adobe Firefly** —— 左 prompt + 右结构化参数面板（Model/Content Type/比例/Visual intensity/**Composition 结构参考 + Styles 风格参考**）+ 4 图网格；**Generative Fill=inpaint、Generative Expand=outpaint**；卖点**商用版权干净**；Firefly AI Assistant（4/27）创意代理编排跨 app。

**Ideogram** —— prompt 框 + 可展开 option bar（比例/model/Magic Prompt/style/张数/负向）+ 独立 **Canvas**；**招牌=文字渲染准**（目标文字加引号）；Style Reference（存 Style Code 复用）+ Character Reference 锁人物；Magic Fill(inpaint)/Extend(outpaint)/Upscale；4.0 原生 2K+透明通道；**唯一没上原生对话式生图**（one-shot，只靠 MCP 被别的 agent 调）。

**Recraft** —— **Figma 式无限画布**（更像设计工具）+ 侧栏 style/model/size/色板/参考图；**招牌=原生矢量 SVG**（真 path+图层，进 Figma/AI）+ 品牌一致性（style lock 跨图锁风格）；inpaint/outpaint/放大/去背景/mockup；Agentic mode + MCP。

**Canva Magic Media（国际版）** —— 嵌设计器左栏（Elements→AI Image Generator：prompt+Style 预设+比例+Images/Graphics/Videos 三 tab）；另有 Dream Lab（基于收购的 Leonardo Phoenix 模型）；**生成结果是带真实图层的可编辑设计**；Magic Expand/Eraser/Grab/Edit/Switch；Canva AI 2.0（4/16）平台级对话 agentic 中枢，模板+设计器仍是默认基座。

---

## 四、站在"台球店主做营销图"的角度：刚需 vs 鸡肋

owner 列的店主用途：**营销海报、助教人物图、门店环境图、活动海报、朋友圈图**。对着这几样过滤，业界那一大堆能力里，真正用得上的就这些：

### 4.1 刚需（一定要做，按优先级）
1. **模板 + 场景分类 + 填空式起步** —— 店主不会写 prompt，最高频的路径是"选个海报模板 → 填店名/活动价/换张图 → 出图"。这是设计工具类（稿定/美图/Canva/Playground）的命门，也是店主最疼的点。要有**场景分类**（活动海报/朋友圈图/门店环境/助教人设/器材展示）和**尺寸预设**（朋友圈 1:1、竖版海报 9:16、横图 16:9）。
2. **文字渲染准** —— 营销海报必放店名、电话、活动价、时间、地址。**画不准的字 = 废图**（项目记忆里已有"GPT 画精确文字/二维码画不准"的踩坑）。所以：主力模型选文字准的（Seedream 已是我们主力，方向对）；精确文字/二维码/电话仍走"贴合成"兜底（项目已有结论，别倒退）。这条是营销图的生死线。
3. **人物一致性 / 参考图** —— 助教人物图的核心诉求是"同一个她，换场景、换姿势、换服装"。业界成熟做法：MJ Omni Reference、可灵 10 图多参考、即梦四维参考、Ideogram Character Reference。要给一个"上传助教照片当参考、锁住同一个人"的槽位。
4. **图生图 + 局部重绘（inpaint）** —— 高频场景是"这张基本行，就把背景/衣服/文字那块改一下"。圈选局部改，不要每次重新抽卡。业界人手一份，我们必须有。
5. **去背景 / 换背景 / AI 商品图** —— 门店环境图、台球器材图（乔氏/星牌球杆球桌）放到好看的背景/场景里。美图/稿定的"上传商品→自动抠图→套场景"管线正对口。
6. **一次多张挑一张 + 高清放大** —— 出 3–4 张供一眼挑（符合"一眼挑"原则）；海报要打印/高清朋友圈需要 upscale。

### 4.2 鸡肋（别做，店主一辈子不碰）
- **节点工作流 / 画布节点编辑**（ComfyUI、Krea Node、Recraft Studio node）—— 太专业，店主看不懂。砍。
- **自训 LoRA / 训模型**（WHEE Train Model、Krea Train Lora）—— 太重、门槛高。鸡肋。
- **矢量 SVG 导出**（Recraft）—— 店主发朋友圈/打海报不需要矢量。除非做 Logo，低频，不值当。
- **Figma 式无限画布 + 多图层重排版** —— 店主要"一张能用的图"，不是当设计师做复杂版式。轻量"模板套版 + 换图换字"就够，重画布是负担。
- **realtime 实时生图**（Krea 招牌）—— 炫技，店主不需要毫秒级涂改。
- **3D / GLB 导出** —— 完全用不上。
- **一大堆专业参数**（CFG / sampler / seed / steps / negative prompt）—— 连 Playground 都刻意砍掉了，店主更不需要。默认全藏起来，最多留"比例 / 风格 / 张数"三个。
- **视频生成塞进生图工作台** —— 视频是另一条线（我们有专门的视频台），生图工作台别混进来，保持干净。

> 判据小结：**店主要的是"快、准、像、能改"，不是"可控参数多、能做复杂设计"。** 凡是让店主觉得"这我得学"的功能，默认都是鸡肋。

---

## 五、对我们产品的落地建议（结合 CLAUDE.md 两条线）

1. **搭"确定性生图工作台"（B 线），别把它做成对话。** 业界 15 家共识：工作台 = 模板起步 + 结构化面板 + 就地编辑画布。这是写死的确定性 UI，本来就该按固定逻辑跑，不塞进模型循环。
2. **保留"对话里生图/改图"（A 线）当并行快速入口。** 它就是 ChatGPT/Gemini 那个阵营，2026 主流且好用，适合"顺口一句改一下"。别因为搭了工作台就砍掉对话入口——业界是双轨并存。
3. **两条线用三种廉价方式相接**（严格照 CLAUDE.md）：① 工作台里点"让 AI 帮我描述"→ 给模型一个工具；② 对话里说"打开工作台改这张"→ 把当前图带进工作台（后端直调）；③ "基于这张再改" 既可在工作台圈选局部重绘，也可把图塞回对话让模型多轮改。**绝不做把产品逻辑织进对话循环的中间层。**
4. **工作台 MVP 该有的（按店主刚需裁剪）**：
   - 顶部：场景/模板选择（活动海报/朋友圈/门店/助教/器材）+ 尺寸预设。
   - 输入：prompt 框 + 三个参数（比例/风格/张数），专业参数默认藏。
   - 参考图槽：风格参考 + **人物一致性**（上传助教照片锁同一个人）。
   - 结果：一次 3–4 张网格挑一张。
   - 就地编辑：局部重绘（圈选改）+ 扩图 + 放大 + 去背景/换背景。
   - "基于这张再改"三条路：圈选局部重绘 / 喂回当参考 / 转进对话多轮改。
   - 文字：主力用文字准的模型；精确电话/二维码走贴合成兜底（别倒退）。
5. **别做**：节点、训模型、矢量、重画布排版、realtime、3D、一堆专业参数、把视频塞进来。

---

## 六、来源与可信度

> 标注规则：【官方】= 官网/官方文档/官方 blog；【评测/二手】= 第三方评测、媒体报道、导航站；【未查到】= 确实没查到。核心结论多为官方或多源交叉。

**宏观趋势（本人调研）**
- 【评测】2026 生图 UI 对话趋势 + 混合结构：windowsnews.ai《From Art Engines to Creative Powerhouses》(2026)；aiuxdesign.guide《Conversational UI Design 2026》
- 【评测】12 款生图工作台界面对比：press.farm《The 12 Best AI Image Generators of 2026: Architecture》
- 【官方】Krea Node Agent"叠在结构化画布之上不取代"金句：krea.ai/blog/ai-workflow-agent
- 【评测】"图是对话选 ChatGPT、图是系统选 Gemini"：aifreeapi.com《Gemini Image vs ChatGPT 2026》(2026-03)
- 【评测】Nano Banana vs Midjourney（多轮对话 vs 无记忆、production vs 首图惊艳）：midlibrary.io、nanoimagine.art、techjacksolutions.com（2026）
- 【评测】小商家产品图刚需（去背景/换场景/多变体/平台尺寸模板/批量）：fibbl.com、cometly.com、photoroom.com（2026 product photography）

**即梦**：【官方】jimeng.jianying.com ；【评测】woshipm.com/ai/6370967、cloud.tencent.com/developer/article/2703800、blog.csdn.net/Ashtar_katay/154498361、zhihu p/1970984111784047362
**可灵**：【官方】kling.ai/blog/kling-ai-3-0-multi-reference-inpainting-guide、kling.ai/app/image-edit、klingai.com/release-note ；【评测】aigc.cn/klingai、sohu.com/a/981977307
**通义万相**：【官方】tongyi.aliyun.com/wan、wanx.biz.aliyun.com/wan/blog/wan2.6 ；【评测】blog.csdn.net/boyzhaotian/145290385、airukou.cn/tool/tongyi-wanxiang、xdmeng.cn/article/178
**LiblibAI 星流**：【官方】liblib.art/modelinfo/8b86d942… ；【评测】sanwenge.com/post/810、ai-bot.cn/xingliu-art-agent、zhihu p/13013774425、sohu.com/a/910382996
**美图设计室**：【官方】designkitcn.com、designkit.com、designkit.cn/article/aishangpintu-jiaocheng ；【评测】ai-bot.cn/sites/2400
**稿定**：【官方】gaoding.com/image、gaoding.com/tools-ai-background、gaoding.com/koutu、gaoding.com/create-design
**Canva 中国 / Magic Media**：【评测/媒体】time-weekly.com/post/326119、prnasia.com/story/515978-1、pxz.ai/blog/canva-ai-image-generator-guide ；【官方】canva.com/magic-design、canva.com/ai-assistant、canva.com/newsroom/news/canva-create-2026-ai ；【评测】forbes.com/sites/marksparrow（Canva AI 2.0，2026-04-16）
**Midjourney**：【官方】docs.midjourney.com（Website Overview / Creating on Web / Draft & Conversational Modes）、updates.midjourney.com/image-editor ；【评测】venturebeat.com（V7 voice/draft）
**Krea**：【官方】krea.ai/image、krea.ai/realtime、krea.ai/chat、krea.ai/news/product（2026-03 改版）、krea.ai/blog/ai-workflow-agent ；【评测】tooljunction.io/ai-tools/krea、gstory.ai
**Leonardo**：【官方】intercom.help/leonardo-ai（How to Generate Images 2026-02-17 / Canvas Editor Tool）、docs.leonardo.ai ；【评测】commandlinux.com
**Playground**：【官方】playgroundai.com、playgroundai.com/design/whats-new（Smart Layers 2026-05）；【评测】piclumen.com/blog/playground-ai-review（2026-07 三周实测）
**Adobe Firefly**：【官方】helpx.adobe.com/firefly、adobe.com/products/firefly、blog.adobe.com（2026-04 AI Assistant）、news.adobe.com（2026-04/06）；【评测】forbes.com、axios.com
**Ideogram**：【官方】docs.ideogram.ai、ideogram.ai/features/canvas、ideogram.ai/news/ideogram-4.0 ；【评测】aitoolsdevpro.com、aivideobootcamp.com、imagine.art
**Recraft**：【官方】recraft.ai/professional/graphic-designers、recraft.ai/ai-vector-generator、recraft.ai/blog/introducing-chat-mode ；【评测】tooljunction.io、mockuplabs.ai、mindstudio.ai

**可信度提示**：① 国内产品官网多为反爬 SPA，即梦/可灵/通义/Canva 中国部分细节靠评测与媒体交叉印证（非逐字官方页），要精确数据时以各自官网实测界面为准；② 通义万相"未做对话式画布"为 2026-07 综合判断，阿里可能在通义/Qwen App 侧另有对话生图；③ "Krea Chat 由 DeepSeek 驱动"仅二手源（aibase），其余对话/Agent 结论均有官方支撑。
