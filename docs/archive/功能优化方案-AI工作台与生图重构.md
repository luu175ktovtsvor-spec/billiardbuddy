# 功能优化方案：AI 工作台与 AI 生图重构

> 基于项目源码分析 + PPT行业运营逻辑 + 竞品调研（Midjourney/即梦AI/通义万相/有赞/Canva/Jasper/Popmenu）
>
> 生成日期：2026-06-08

---

## 一、现状诊断

### 1.1 AI 工作台（Workbench）

**当前交互流程：**

```
选角色 → 选任务卡片 → 选客户类型 → 选输出包 → 写补充说明 → 一键生成 → SSE流式输出 → 复制/编辑/基于此优化
```

**核心问题：**

| 问题 | 具体表现 | 影响 |
|------|---------|------|
| **没有对话历史** | 每次生成都是独立请求，无法连续追问 | 用户无法基于上一轮结果深入调整 |
| **"基于此优化"是伪优化** | 只是把结果前500字拼到 extra_note 里重新生成 | 丢失上下文，用户期望 vs 实际体验严重不符 |
| **919行单体组件** | 16+ state变量全在一个文件里 | 维护困难，改一处容易破另一处 |
| **流式输出体验割裂** | 生成中显示纯文本，完成后突然切换成Markdown渲染 | 明显的布局跳动 |
| **角色状态不同步** | Tab选角色 和 下拉框选角色 是两个独立state | 用户在下拉框改角色后Tab高亮不跟随 |
| **门店资料一次性填写** | 11组98个字段的表单一次性展示 | 新用户填不完就离开，转化率低 |
| **任务卡片78张但无智能排序** | 按角色展示但没有使用频率排序、没有最近使用记录 | 高频任务找不到，低频任务占位置 |

### 1.2 AI 生图（Posters）

**当前交互流程：**

```
输入Prompt → 选比例/质量 → 上传参考图 → 高级选项 → 生成 → 对话式界面 → 基于此调整 → 下载
```

**核心问题：**

| 问题 | 具体表现 | 影响 |
|------|---------|------|
| **Logo/二维码叠加有Bug** | 后端用 add_overlay 门控 add_logo_overlay，前端未传 add_overlay | Logo/二维码叠加功能实际不可用 |
| **对话历史不完整** | 加载历史对话时assistant消息content为空 | 用户看不到之前生成了什么 |
| **"基于此调整"无视觉提示** | 点击后prompt清空，用户不知道正在用原图做参考 | 交互意图不明确 |
| **refineFrom只生效一次** | 生成后立即clearRefineFrom | 无法连续调整，必须每次都点按钮 |
| **参考图跨轮次残留** | references状态不随生成清空 | 每次生成都带上之前上传的所有参考图 |
| **高级选项不持久化** | 刷新页面后设置丢失 | 重复操作 |
| **只有1个结果** | 每次只生成1张图 | 没有选择余地，不如Midjourney的4图网格 |

### 1.3 门店资料管理

**当前状态：** 11组98个字段，Tab式表单一次性展示

**PPT揭示的实际情况：** 球房老板/店长最关心的核心字段只有：
- 门店名称、城市、球台数量、定位类型
- 当前经营重点、月度目标
- 助教数量、赛事频率
- 内容风格偏好（接地气 vs 品质感）

**98个字段中大量是"AI安全规则"（ban_xxx系列）和"高级偏好"**，不应该在前端暴露给用户，应该由系统根据行业默认值自动填充，用户只需在"高级设置"中微调。

---

## 二、优化方案

### 2.1 AI 工作台重构

#### 方案A：引入对话式工作台（推荐）

**借鉴：** ChatGPT的对话流 + 有赞的场景卡片 + Microsoft Copilot的持久工作区

**核心思路：** 工作台从"选参数 → 生成"变为"对话式交互"，保留任务卡片作为快捷入口。

**新交互流程：**

```
┌─────────────────────────────────────────────────┐
│  左侧：任务卡片列表（可折叠）                       │
│  右侧：对话区域（类似ChatGPT）                      │
│                                                   │
│  ┌─ 任务卡片 ──────────────┐  ┌─ 对话区 ──────────┐
│  │ [店长] 老客维护          │  │                   │
│  │ [店长] 周赛通知          │  │  用户：帮我写一条   │
│  │ [店长] 空台朋友圈        │  │  老客户邀约文案     │
│  │ [助教] 助教推广          │  │                   │
│  │ ...                     │  │  AI：[流式输出]     │
│  │                         │  │                   │
│  │ 最近使用：               │  │  [复制] [编辑]     │
│  │ • 老客维护 (2小时前)     │  │  [基于此优化]      │
│  │ • 周赛通知 (昨天)        │  │  [生成配套海报]    │
│  └─────────────────────────┘  │                   │
│                                │  用户：把语气改得   │
│                                │  更亲切一些        │
│                                │                   │
│                                │  AI：[基于上一轮    │
│                                │  完整上下文优化]    │
│                                └───────────────────┘
└─────────────────────────────────────────────────┘
```

**关键改动：**

1. **对话区域** — 不再是一次性生成，而是保留完整对话历史。用户可以连续追问："把语气改亲切些"、"加上周末活动信息"、"再出一个群公告版本"
2. **任务卡片保留但折叠到侧边** — 点击卡片 = 发送一条预设prompt，直接进入对话
3. **"基于此优化"改为真正的对话追问** — 不再拼接500字截断，而是把上一轮完整结果作为上下文传给后端
4. **流式输出保持Markdown渲染** — 用 react-markdown 的 streaming 渲染器，消除布局跳动

**后端改动：**

```
POST /api/v1/stream/workbench
├── 新增 conversation_id 字段（可选）
├── 如果有 conversation_id，加载最近5轮历史
├── history 格式：[{role: "user", content: "..."}, {role: "assistant", content: "..."}]
├── 拼接到 prompt 的 few-shot 之后、guardrails 之前
└── 不改变现有 prompt 组装逻辑，只增加 history 上下文
```

**数据库改动：**

```sql
-- generations 表新增 conversation_id 字段
ALTER TABLE generations ADD COLUMN conversation_id VARCHAR(36);
-- 已有数据的 conversation_id 为 NULL（向后兼容）
```

#### 方案B：保持卡片式但增强（轻量替代）

如果不想做对话式改造，可以做以下轻量增强：

1. **"基于此优化"去掉500字截断** — 改为传完整 content，后端截断到2000字
2. **增加"追问"输入框** — 生成后显示一个输入框，用户输入后追加到 extra_note 重新生成
3. **增加任务卡片使用频率排序** — localStorage 记录点击次数，高频卡片排前面
4. **增加"最近生成"快捷入口** — 生成结果保存到 localStorage，首页展示最近3条

**推荐：方案A（对话式），因为：**
- PPT中的运营场景天然是连续的：写完朋友圈 → 改语气 → 出群公告 → 出海报文案
- 竞品（有赞、Jasper、Canva）都在往对话式方向走
- 一次投入，长期收益——后续可以加"多轮优化"、"历史版本对比"等高级功能

---

### 2.2 AI 生图重构

#### 核心改动1：修复Logo/二维码叠加Bug

**问题根因：** 后端 `poster_service.py` 中：

```python
# 当前代码（有Bug）
add_logo = request.add_overlay and request.add_logo_overlay
add_qr = request.add_overlay and request.add_qrcode_overlay
```

前端没有传 `add_overlay` 字段，所以 `add_overlay` 默认为 `False`，导致 Logo 和二维码永远不叠加。

**修复：**

```python
# 修复后：直接使用独立字段
add_logo = request.add_logo_overlay
add_qr = request.add_qrcode_overlay
```

#### 核心改动2：生成结果改为2图网格

**借鉴：** Midjourney的4图网格 + 即梦AI的批量生成

**新交互流程：**

```
┌─ AI 生图对话 ──────────────────────────────────┐
│                                                  │
│  用户：帮我做一张周赛海报                           │
│                                                  │
│  AI：[生成中...]                                  │
│                                                  │
│  ┌──────────┐  ┌──────────┐                      │
│  │  图片 1   │  │  图片 2   │                      │
│  │          │  │          │                      │
│  │ [选择]   │  │ [选择]   │                      │
│  └──────────┘  └──────────┘                      │
│                                                  │
│  请选择一张，然后告诉我需要调整什么                   │
│                                                  │
│  用户：选第1张，背景颜色改成红色                     │
│                                                  │
│  AI：[基于选中图片 + 用户指令生成新图]               │
│                                                  │
│  ┌──────────┐  ┌──────────┐                      │
│  │  新图 1   │  │  新图 2   │                      │
│  └──────────┘  └──────────┘                      │
└─────────────────────────────────────────────────┘
```

**关键改动：**

1. **每次生成2张图**（而非1张）— gpt-image-2 支持 n 参数，一次请求返回多张
2. **"选择"按钮** — 用户点选后，该图作为下一轮的参考图（自动设置 refineFrom）
3. **对话式调整** — 不再需要点"基于此调整"按钮再手动输入，直接在对话框里说"背景改红色"
4. **Logo/二维码自动叠加** — 在生成后自动叠加（无需用户手动勾选高级选项）

#### 核心改动3：前端Logo/二维码入口精简

**用户原话：** "上传Logo、上传门店二维码这些入口，在前端界面其实没必要展示"

**方案：** Logo/二维码的上传入口从生图页面移到"门店资料管理"页面，在生图页面只显示状态指示：

```
门店资料页面：
  ┌─ 品牌素材 ─────────────────┐
  │  Logo上传 [上传按钮]         │
  │  二维码上传 [上传按钮]       │
  │  品牌主色 [颜色选择器]       │
  └────────────────────────────┘

生图页面：
  ┌─ 品牌状态 ─────────────────┐
  │  ✅ Logo 已设置              │
  │  ✅ 二维码已设置              │
  └────────────────────────────┘
```

#### 核心改动4：对话历史完整化

**当前问题：** 加载历史对话时assistant消息content为空

**修复：** 在 `poster_service.py` 的 `get_conversation_detail()` 中，不仅返回 prompt 和 image_url，还返回 assistant 的文字描述（如果有的话）。

#### 核心改动5：高级选项折叠但默认值合理化

**当前：** `showAdvanced` 默认 false，用户看不到高级选项

**优化：** 默认值改为：
- `addStoreInfo: true`（默认叠加门店信息）
- `addLogoOverlay: true`（默认叠加Logo）
- `addQrcodeOverlay: false`（二维码默认不叠加，太大了）
- `noText: false`（默认有文字）

用户不需要手动展开高级选项去勾选，系统默认给出最佳配置。

---

### 2.3 门店资料管理精简

#### 原则：前端只展示用户需要主动填写的字段，系统默认值由后端自动填充

**PPT中球房运营真正关心的字段（前端必填）：**

| 分组 | 字段 | 原因 |
|------|------|------|
| 基本信息 | 门店名称、城市、球台数量 | AI生成内容必须知道的基本信息 |
| 定位 | 定位类型（社区/商业/竞技/竞技商业） | PPT明确指出定位决定一切，影响所有生成内容的风格 |
| 经营重点 | 当前经营重点、月度目标 | 影响AI推荐的任务卡片优先级 |
| 助教 | 助教数量、是否有助教管理 | 影响助教相关内容生成 |
| 赛事 | 是否有周赛/月赛、赛事规模 | 影响赛事相关内容生成 |
| 内容风格 | 内容语气（接地气/品质感/活泼） | 影响所有生成内容的调性 |

**应该隐藏的字段（后端自动填充，高级设置中可微调）：**

| 分组 | 字段数 | 处理方式 |
|------|--------|---------|
| AI安全规则（ban_xxx系列） | 12个 | 后端默认值：全部禁止（赌博、低价承诺、虚假优惠等），前端不展示 |
| AI偏好（enable_xxx系列） | 8个 | 后端默认值：全部开启（fewshot、合规检查等），前端不展示 |
| 合规规则 | 12个 | 后端默认值：行业标准合规，前端不展示 |
| 内容风格细节（emoji、长度等） | 6个 | 后端根据定位类型自动推断，高级设置中可微调 |
| 前厅SOP细节 | 8个 | 后端默认值，高级设置中可微调 |

**新的前端资料页面结构：**

```
门店资料（简化版）
├── 必填信息（6个字段，首次使用必填）
│   ├── 门店名称
│   ├── 城市/区域
│   ├── 球台数量
│   ├── 定位类型（单选：社区/商业/竞技/竞技商业）
│   ├── 当前经营重点（单选：拉新/留存/活动/品牌）
│   └── 内容语气（单选：接地气/品质感/活泼专业）
│
├── 补充信息（按需填写，影响生成质量）
│   ├── 助教相关（助教数量、是否有助教管理）
│   ├── 赛事相关（是否有周赛/月赛、赛事规模）
│   ├── 团购相关（是否做团购、在哪些平台）
│   └── 会员相关（是否有会员体系、充值模式）
│
└── 高级设置（折叠，默认值已合理，极少需要改）
    ├── AI安全规则（12个开关）
    ├── AI偏好设置（8个开关）
    └── 内容风格细节（6个字段）
```

**关键改动：**
1. 首次注册只需要填6个字段即可开始使用
2. AI根据定位类型自动推断其他字段的默认值（如"商业球房"默认有助教、默认做团购）
3. 高级设置折叠，只有需要微调的用户才展开
4. **上传Logo/二维码的入口放在这里**，不放在生图页面

---

### 2.4 交互设计优化

#### 2.4.1 生图模板/灵感标签重新设计

**当前问题：** 15个灵感标签平铺，视觉效果和交互逻辑都不对

**优化方案：** 改为分类卡片网格，参考Canva的模板选择器

```
灵感标签（新设计）
├── 🏆 赛事类
│   ├── 周赛报名
│   ├── 月赛海报
│   └── 赛后战报
├── 📱 社交媒体
│   ├── 朋友圈配图
│   ├── 短视频封面
│   └── 门店品牌图
├── 🎯 营销推广
│   ├── 充值活动
│   ├── 团购引流
│   └── 开业活动
└── 👥 助教相关
    ├── 助教形象图
    ├── 助教推广
    └── 教练推广
```

每个分类可以展开，展开后显示具体的场景卡片，卡片上有预览效果图（如果有历史生成记录的话）。

#### 2.4.2 生成后动作统一化

**当前：** 工作台和生图的生成后动作不一致

**统一为：**

```
文本生成后：
  [复制] [编辑] [基于此优化] [重新生成] [生成配套海报]

图片生成后：
  [下载] [选择此图] [基于此调整] [换一种风格]
```

**新增"换一种风格"按钮：** 保留当前图片作为参考，但切换风格预设（如从"写实"切换到"插画"）

#### 2.4.3 页面跳转逻辑

**用户原话：** "是否可以实现跳转页面的逻辑？不一定非要在同一个页面完成所有操作"

**方案：** 生图可以从多个入口进入：

```
入口1：工作台 → "生成配套海报"按钮 → 跳转到生图页面（自动填充prompt）
入口2：工作台 → 任务卡片中包含"配图"标签 → 生成文本后自动弹出"是否生成配图？"
入口3：工作台 → 生成结果下方 → "为此内容生成海报"按钮
入口4：生图页面 → 直接访问 /dashboard/posters
入口5：生成历史 → 点击某条历史记录 → 可选择"基于此重新生成"
```

**跳转时携带参数：**

```
/dashboard/posters?prompt=周赛报名海报，时间周六下午2点，报名费10元&ratio=3:4&quality=high
```

#### 2.4.4 门店资料填写入口精简

**用户原话：** "球杆品牌、匠心这些信息不应该出现在前端填写入口"

**分析：** 当前门店资料中的"设备"分组有 `equipment.table_types`（球台类型：普通/独牙/乔氏/斯诺克）和 `equipment.table_type_note`。这些信息对AI生成内容的影响极小（除非生成赛事规则相关内容），不应该在首次填写时出现。

**处理方式：**
- `equipment.table_count` → 已在基本信息中（球台数量）
- `equipment.table_types` → 移到高级设置，或根据球台数量自动推断
- `equipment.table_type_note` → 删除（自由文本无实际价值）

---

### 2.5 前端组件拆分

**当前：** 工作台919行、生图615行，全是单体组件

**建议拆分：**

```
components/
├── workbench/
│   ├── workbench-page.tsx          # 主页面（~200行）
│   ├── role-tabs.tsx               # 角色Tab栏
│   ├── task-card-grid.tsx          # 任务卡片网格
│   ├── task-card.tsx               # 单个任务卡片
│   ├── chat-input.tsx              # 对话输入框
│   ├── generation-result.tsx       # 生成结果展示
│   ├── result-actions.tsx          # 生成后操作按钮
│   └── next-steps.tsx              # 下一步建议
│
├── posters/
│   ├── posters-page.tsx            # 主页面（~150行）
│   ├── poster-entry.tsx            # 入口表单
│   ├── poster-conversation.tsx     # 对话界面
│   ├── poster-message.tsx          # 单条消息（含图片）
│   ├── inspiration-tags.tsx        # 灵感标签（分类展示）
│   └── poster-actions.tsx          # 图片操作按钮
│
└── store-settings/
    ├── basic-form.tsx              # 必填信息（6字段）
    ├── supplement-form.tsx         # 补充信息
    └── advanced-settings.tsx       # 高级设置（折叠）
```

---

## 三、实施优先级

### P0（必须做，影响核心功能可用性）

| # | 改动 | 文件 | 预估工时 |
|---|------|------|---------|
| 1 | **修复Logo/二维码叠加Bug** | `server/api/v1/posters.py` + `server/services/poster_service.py` | 0.5h |
| 2 | **"基于此优化"去掉500字截断** | `web/src/app/dashboard/workbench/page.tsx` | 0.5h |
| 3 | **参考图跨轮次残留修复** | `web/src/app/dashboard/posters/page.tsx` | 0.5h |
| 4 | **对话历史assistant消息content为空修复** | `server/api/v1/posters.py` | 1h |

### P1（强烈建议，提升用户体验）

| # | 改动 | 文件 | 预估工时 |
|---|------|------|---------|
| 5 | **工作台引入对话历史**（后端支持） | `server/api/v1/stream.py` + `server/models/generation.py` | 3h |
| 6 | **工作台前端改为对话式** | `web/src/app/dashboard/workbench/page.tsx`（拆分+重构） | 8h |
| 7 | **门店资料简化为3层结构** | `web/src/app/dashboard/store-settings/page.tsx` + 后端 | 4h |
| 8 | **生图默认值合理化** | `web/src/app/dashboard/posters/page.tsx` | 1h |

### P2（建议做，提升产品竞争力）

| # | 改动 | 文件 | 预估工时 |
|---|------|------|---------|
| 9 | **生图改为2图网格** | 前端+后端 | 4h |
| 10 | **灵感标签分类展示** | `web/src/app/dashboard/posters/page.tsx` | 2h |
| 11 | **任务卡片使用频率排序** | `web/src/lib/role-workbench-config.ts` + 前端 | 2h |
| 12 | **流式输出Markdown实时渲染** | `web/src/app/dashboard/workbench/page.tsx` | 3h |
| 13 | **Logo/二维码上传入口移到门店资料** | 前端两个页面 | 2h |

---

## 四、技术实现要点

### 4.1 工作台对话历史（后端）

```python
# server/api/v1/stream.py 新增逻辑

# 在 workbench endpoint 中
conversation_id = request.conversation_id  # 新增字段，可选

# 如果有 conversation_id，加载历史
if conversation_id:
    history = await load_conversation_history(
        db, conversation_id, store_id, limit=5
    )
    # history 格式：[
    #   {"role": "user", "content": "帮我写老客邀约"},
    #   {"role": "assistant", "content": "【朋友圈文案】..."},
    # ]
else:
    history = []

# 将 history 注入到 prompt 中
# 位置：few-shot 之后、guardrails 之前
if history:
    history_text = "\n\n---\n【对话历史】\n"
    for msg in history:
        role_label = "用户" if msg["role"] == "user" else "助手"
        history_text += f"\n{role_label}：{msg['content'][:1000]}\n"
    prompt_parts.append(history_text)
```

### 4.2 工作台对话历史（前端）

```typescript
// 新增 conversationId state
const [conversationId, setConversationId] = useState<string | null>(null);
const [messages, setMessages] = useState<Array<{
  role: 'user' | 'assistant';
  content: string;
  generationId?: string;
}>>([]);

// 生成时传入 conversationId
const result = await api.streamWorkbench({
  role, targetCustomer, outputPackage,
  intent: userMessage,
  extra_note: extraNote,
  conversation_id: conversationId,  // 新增
  onChunk: (token) => { ... },
  onDone: (content, generationId) => {
    // 首次生成时保存 conversationId
    if (!conversationId) {
      setConversationId(generationId); // 用 generationId 作为 conversationId
    }
    setMessages(prev => [
      ...prev,
      { role: 'user', content: userMessage },
      { role: 'assistant', content, generationId }
    ]);
  }
});
```

### 4.3 生图2图网格（后端）

```python
# server/services/poster_service.py 修改
# 在 generate_images 函数中

# 原来：n=1
response = await client.images.generate(
    model="gpt-image-2",
    prompt=final_prompt,
    n=1,  # 改为 2
    size=size,
    quality=quality,
    ...
)

# 返回 2 张图片
images = response.data  # 现在有 2 个元素
```

### 4.4 门店资料分层（前端）

```typescript
// 新的 store-settings 页面结构
const BASIC_FIELDS = ['name', 'city', 'district', 'table_count', 'positioning', 'one_liner'];
const SUPPLEMENT_FIELDS = ['has_assistant', 'assistant_count', 'has_weekly_tournament', 'do_groupbuy'];
const ADVANCED_FIELDS = ALL_FIELDS.filter(f => !BASIC_FIELDS.includes(f) && !SUPPLEMENT_FIELDS.includes(f));

// 首次使用引导：只显示 BASIC_FIELDS
// 补充信息：在用户使用一段时间后提示
// 高级设置：折叠，默认值由后端填充
```

---

## 五、与PPT行业逻辑的对齐检查

| PPT核心观点 | 当前产品是否覆盖 | 优化后是否覆盖 |
|------------|----------------|--------------|
| 定位定江山（4类球房） | ✅ 定位类型字段存在 | ✅ 简化为必填字段 |
| 助教是核心岗位 | ✅ 助教管理有独立模块 | ✅ 助教信息简化录入 |
| 团队搭建=赛马机制 | ❌ 无相关功能 | ⚠️ 可在PK模块扩展 |
| 四大客户分类 | ✅ 8种客户类型 | ✅ 保持 |
| 数据管理四板块 | ❌ 无数据看板 | ⚠️ 可在Dashboard扩展 |
| PK激励机制 | ✅ 有PK相关prompt | ✅ 保持 |
| 岗位日报模板 | ✅ 有日报生成场景 | ✅ 保持 |
| 不乱编价格/奖金 | ✅ Prompt规则已内置 | ✅ 保持 |
| 输出要像成品 | ⚠️ 部分场景还是太"AI感" | ✅ 对话式可迭代优化 |
| 人情世故感 | ⚠️ 依赖prompt质量 | ✅ 对话式可迭代优化 |

---

## 六、风险与注意事项

1. **对话式改造影响范围大** — 工作台是核心功能，改造时必须保证现有用户不受影响。建议先做后端对话历史支持（P1-5），再做前端改造（P1-6），分两步上线
2. **Logo叠加Bug是紧急修复** — 用户可能已经上传了Logo但一直没生效，修复后需要通知用户重新生成测试
3. **门店资料简化需要数据迁移** — 现有用户的98字段数据不能丢，简化只是前端展示层的改动，后端数据模型不变
4. **生图2图网格会增加API成本** — 每次请求返回2张图，OpenAI按图片数量计费，需要评估成本影响
5. **对话历史存储** — 需要评估 generations 表的增长速度，建议设置对话历史最长保留30天

---

*本文档基于：项目源码分析（workbench/page.tsx, posters/page.tsx, poster_service.py, stream.py, role-workbench-config.ts）+ PPT行业运营逻辑（278页）+ 竞品调研（Midjourney, 即梦AI, 通义万相, 有赞, Canva, Jasper, Popmenu）*
