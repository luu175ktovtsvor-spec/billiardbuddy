# 记忆机制对齐 cc-haha + 门店信息自动沉淀 · 方案

> 📌 状态:🚧进行中 · 任务〈记忆机制对齐 cc + 门店信息〉· 建于 2026-07-10 · 源自三路调研 workflow(cc记忆机制/WorkBuddy产品化/我们现状差距)

## 0. 一句话
当初把 AutoMem 砍早了。cc 那套"模型自己在对话里记事实"的自动记忆是完整现成的,正好就是"门店信息自动沉淀"要的地基。我们现在是**能读、能存、但模型不能自己写**,缺的就是这一环。**决定:掰回 cc 的 AutoMem,只落"门店专用轻量版",不追 autoDream/TeamMem。**owner 2026-07-10 拍板"纯 cc"**:砍掉自造店脑记忆(storeMemoryContext + desktopDataStore memories),纯照抄 cc memdir/AutoMem,不复用不归并(替换非叠加,被替换的旧代码该删的删)。**

## 1. cc 记忆机制(权威源头,全方位抄的对象)
- **两层**:①主指令层 `CLAUDE.md` 家族(人写定稿,每轮整段拼进 system prompt,必读)→ 我们已白标成 `BILLIARDBUDDY.md`,读已落地;②**AutoMem(memdir)**=模型攒的结构化事实草稿池,存 `~/.claude/projects/<git根>/memory/`,索引常驻 + 主题按相关性 top-5 召回。
- **三条自动通路**:①回合内主模型自己用 Write/Edit 写记忆;②回合后 `extractMemories` 后台 fork 抽取(权限只写记忆、预注入已有清单去重、与①互斥、节流);③隔 24h+5 会话 `autoDream` 做梦合并去重治陈旧。
- **数据结构**:每条 = 带 frontmatter 的 `.md`(name/description/type + 正文)+ `MEMORY.md` 索引一行。type 闭集 4 类:`user/feedback/project/reference`。门店事实→ `project` 型。
- **陈旧治理**:读取 >1 天注入 system-reminder 提醒核对;autoDream 删被推翻事实。
- **现成管理**:`/memory` 命令 + 桌面 REST(`server/api/memory.ts` 增删改查)+ `autoMemoryEnabled/autoDreamEnabled` 开关。

## 2. 我们现状与差距
| 能力 | cc | 我们 |
|---|---|---|
| 主指令**读**(BILLIARDBUDDY.md 四层) | ✅ | ✅ 真(claudemd.ts+projectInstructions.ts) |
| 主指令模型**自主写**(#/`/memory`) | ✅ | ❌ 只能当普通文件改 |
| AutoMem 类型 | ✅ | ❌ memoryNames.ts:41 明砍 |
| 对话后自动抽取 extractMemories | ✅ | ❌ 空 |
| memdir 目录体系 | ✅ | ❌ 只有扁平 memories[] |
| 店脑记忆**注入** storeMemoryContext | cc无 | ✅ **自造,比cc细**(打分/时效/age_warning/scope) |
| 店脑记忆**存储** desktopDataStore | — | ✅ 真落盘(source/scope/confidence) |
| 店脑记忆**模型自主写** source:'auto' | ✅(cc有生产者) | ❌ **字段留位、零处写入** |
| 门店画像注入聊天 | — | ❌ **getStore() 没进 chat 系统提示,只喂生图+仪表盘=断线** |

**关键**:是"从没建 AutoMem"(非砍残留桩),没有死代码要清,是**加地基**。店脑记忆的注入/存储是好底子,唯独缺"模型自主写"的生产者。

## 3. 冲突分析(owner 2026-07-10 提出)
cc AutoMem 与我们店脑记忆若**并存 = 两套自动记忆打架**(同一门店事实记两处/注入两次/更新不同步)。**必须二选一**。决定:**以 cc AutoMem 为唯一真源;**砍掉**自造店脑记忆(storeMemoryContext + desktopDataStore memories),纯照抄 cc memdir,不复用不归并;被替换旧代码该删的删(先查牵连)**。符合"全方位对标 cc、发现分叉掰回 cc、替换非叠加"。

## 4. WorkBuddy 产品化参考(抄外观,不填大表)
- **设置·记忆面板**:"生成对话记忆"开关(默认ON)+ "管理记忆"弹窗(摘要文本)+ 改记忆走**自然语言胶囊**("告诉它记住/忘记什么")不是字段编辑器 + "重置记忆"+ "从其他AI导入"。
- **设置·个性化**:语气下拉 + 一个"自定义指令"自由文本框(1500字)。
- **每个助理一颗"内存记忆"开关**。
- **结论**:AutoMem 当地基 + 一张"看得懂、说人话就能改"的记忆卡 + 门店备注框,**不做 101 字段大表**。门店画像退化成"这套记忆的结构化视图"。

## 5. 落地阶段
- **阶段1(先做,解决核心痛点)**:①门店画像/门店记忆**常驻注入 chat system prompt**(补断线,解决"填了没人读");②给模型**一等公民"存记忆"工具**(SaveStoreMemory → desktopDataStore.addMemory source='auto'),让模型对话里自主记门店事实;③`memoryNames.ts` 加回 AutoMem 类型(TeamMem 不做)。
- **阶段2**:extractMemories 回合后台抽取(照 cc stopHooks→extractMemories,门店专用 prompt、maxTurns 限死、权限只写记忆、预注入已有清单去重、与主模型互斥+节流)。
- **阶段3(前端)**:记忆面板(抄 WorkBuddy"管理记忆"卡:折叠摘要 + 自然语言改 + 开关);门店画像退化成结构化视图。
- **不做**:autoDream 做梦(复杂,第一版靠 extract 去重+memoryAge 提醒够用)、TeamMem(单用户)、依赖 tengu 旗标(改我们自己的 settings 开关)。

## 6. 安全红线协调
- 只记**对话里用户明确说过/纠正过**的门店事实,extract prompt 明写"拿不准不记、禁凭空补全字段"(≠"别编造外部信息",门店事实是用户亲口说的)。
- 陈旧即验证(memoryAge N天提醒);参谋卡引用门店事实标来源、不确定就问。
- 低置信度走 `pending` 不直接注入、由用户确认(已有机制,保留)。

## 7. 涉及现有文件
- `ts/src/harness/memoryNames.ts:41` 加回 AutoMem 类型。
- `ts/src/memory/storeMemoryContext.ts` 复用注入;补门店画像常驻注入。
- `ts/src/harness/systemPrompt.ts` / `projectInstructions.ts` 接门店画像常驻注入。
- `ts/src/server/services/desktopDataStore.ts` 复用 addMemory,接 source='auto' 生产者。
- 新增"存记忆工具"(tools/)+ 阶段2 extractMemories(照 cc)。
