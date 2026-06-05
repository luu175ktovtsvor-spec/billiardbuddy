# 阶段10E：Workbench 产品化与体验收口深度实施方案

> 生成时间: 2026-05-12
> 前置阶段: 10D (已验收通过)
> 状态: 方案设计完成，待编码

---

## 1. 10E 阶段定位

10D 证明了 Workbench 能生成高质量内容。10E 要解决的问题是：**门店管理层打开页面后，一看就知道怎么用、愿意用、用完能找到结果。**

一句话：把 Workbench 从"功能可用"升级为"行业 AI 工作台入口"。

---

## 2. 10D 当前状态复盘

### 2.1 已完成

| 项 | 状态 |
|----|------|
| `/api/v1/generate/workbench` 端点 | ✅ 可用 |
| 第5个Tab "我想做什么" | ✅ 可用 |
| role / customer_type / output_package 三参数 | ✅ 可用 |
| 34条 baseline_rules + 6 role rules + 7 customer rules | ✅ 生效 |
| 150条暴力组合测试 (通过率92%, 均分7.6) | ✅ 通过 |
| 30条强约束回归测试 (通过率96.7%, 均分8.6) | ✅ 通过 |
| 优质样例库(20) + 反例库(30) + 回归用例(30) | ✅ 已建立 |
| 助教赠品边界补丁 | ✅ 已修复 |

### 2.2 当前体验问题

从代码阅读中发现以下问题：

1. **Tab名称"我想做什么"不够清晰** — 用户不知道这个Tab和前面4个Tab有什么区别
2. **8条示例偏少且无分组** — 无法覆盖6种岗位的需求
3. **示例诱导不够** — 8条示例中缺少教练、运营、老板视角的典型输入
4. **output_package 10个checkbox无分组** — 新用户面对10个选项不知道选什么
5. **role/customer_type 用select下拉** — 对新用户不直观，需要展开才能看到全部选项
6. **没有快捷场景卡片** — 用户需要自己填所有参数
7. **历史记录中workbench只显示role标签** — 看不到user_intent摘要、customer_type、output_package
8. **生成结果无分段复制** — ResultCard只有整体复制按钮
9. **无"继续优化"入口** — 用户无法在同一条结果上迭代
10. **示例含有潜在诱导词** — "促活""推一下""转化"等词可能诱导模型走向优惠/营销方向

---

## 3. 10E 目标

1. 降低 Workbench 使用门槛 — 用户不需要知道什么是 role/customer_type/output_package 也能用
2. 丰富快捷入口 — 每个岗位看到自己的常见需求
3. 优化输出结果体验 — 复制、分段、继续优化
4. 优化历史记录 — workbench 条目可读、可追溯
5. 保持旧4个Tab不受影响

---

## 4. P0 / P1 / P2 改造范围

### P0（必须做，影响可用性）

| 改造项 | 说明 |
|--------|------|
| 重命名Tab | "我想做什么"→"AI 工作台" |
| 扩充示例到24条+岗位分组 | 每个岗位至少3条，覆盖全客户类型 |
| 增加快捷场景卡片 | 按岗位展示3-5个高频场景，一键填入 |
| output_package 分组+默认推荐 | 3组（常用内容/活动推广/管理执行），默认选朋友圈+执行建议 |
| 生成结果增加分段复制 | 每个output_package对应内容单独复制 |
| 历史记录workbench条目优化 | 显示user_intent摘要+role+customer_type+output_package标签 |

### P1（应该做，提升体验）

| 改造项 | 说明 |
|--------|------|
| role选择改为卡片式 | 6个岗位用6张卡片，点击选择 |
| 增加"不确定默认用店长"提示 | 降低role选择焦虑 |
| 生成结果增加"继续优化"入口 | 在同一条结果上追加需求 |
| 增加结果标题显示 | 显示"您刚才说：XXX"作为上下文 |
| 示例随机换一批 | 每次显示8条，点击换一批 |
| 历史记录增加workbench专属筛选 | 按role筛选workbench记录 |

### P2（以后做，锦上添花）

| 改造项 | 说明 |
|--------|------|
| 基于当前role自动推荐output_package | 选店长→自动推荐朋友圈+群公告+执行建议 |
| 样例库few-shot接入Prompt | 动态选择相关样例注入 |
| 用户使用偏好记忆 | 记住上次的role和output_package |
| 生成结果评分/反馈 | 用户可对结果打分 |
| 移动端适配优化 | 快捷卡片竖滑 |

---

## 5. 前端改造方案

### 5.1 Tab 改造

```
当前: "我想做什么" → 改为: "AI 工作台"
```

理由："AI 工作台"比"我想做什么"更像一个产品入口，暗示这里可以做多种事情。短标签用"工作台"。

### 5.2 输入框区域改造

```
当前布局:
┌─────────────────────────┐
│ 💬 我想做什么 *          │
│ [textarea 4行]          │
│ 💡 试试这样说：          │
│ [8个示例chips平铺]      │
│ 我的岗位 [select]        │
│ 目标客户 [select]        │
│ 想要输出 [10个checkbox]  │
│ 补充说明 [textarea]      │
└─────────────────────────┘

10E 改造后:
┌─────────────────────────────┐
│ 💬 直接说你想做什么          │
│ [textarea 3行]              │
│                             │
│ 📌 快捷场景                   │
│ [老板场景] [店长场景] ...     │
│ 点击岗位展开该岗位5个高频场景   │
│                             │
│ 💡 试试这样说：              │
│ [按岗位分组的24条示例]        │
│ [换一批]                     │
│                             │
│ ⚙️ 我的岗位 [6张卡片]        │
│   默认：店长                  │
│                             │
│ 🎯 目标客户 [8个chip按钮]     │
│   默认：全部客户               │
│                             │
│ 📦 想要输出                  │
│   [常用内容组: 朋友圈 私聊 群公告]│
│   [活动推广组: 活动方案 海报 短视频]│
│   [管理执行组: 执行建议 SOP 日报 PK]│
│   [全选/清空] [推荐组合]       │
│                             │
│ 补充说明 [textarea 2行]       │
└─────────────────────────────┘
```

### 5.3 结果展示改造

在现有 ResultCard 基础上增加：

```
┌─────────────────────────────┐
│ 您刚才说：XXX                │
│ 岗位：店长 | 客户：老客户     │
│ 输出：朋友圈 私聊 执行建议    │
├─────────────────────────────┤
│ 📋 朋友圈文案    [复制本条]   │
│ 文案1...                    │
│ 文案2...                    │
├─────────────────────────────┤
│ 💬 私聊话术      [复制本条]   │
│ 话术1...                    │
├─────────────────────────────┤
│ ✅ 执行建议      [复制本条]   │
│ ...                        │
├─────────────────────────────┤
│ [全部复制] [重新生成] [继续优化]│
└─────────────────────────────┘
```

### 5.4 历史记录改造

workbench 类型的历史记录当前只显示 role 标签（如"工作台·店长"）。

改造为：
- 列表摘要：显示 user_intent 前40字 + role + customer_type标签
- 详情页：显示完整参数（user_intent, role, customer_type, output_package, extra_note）
- 筛选：workbench 下可按 role 筛选

具体修改 `TYPE_LABELS` 和列表渲染逻辑，从 `input_params` 中提取 `user_intent` 用于摘要展示。

---

## 6. 后端改造方案

**后端几乎不需要改。** 10E 不涉及新的 API、不涉及 schema 变更、不涉及数据库变更。

唯一可能需要的小改：
- 无需后端改动。前端从 `input_params` 中提取信息即可。

---

## 7. 示例输入重设计

见独立文档：`docs/tasks/10E-Workbench前端示例与标签配置方案.md`

核心原则：
- 每个岗位至少3条
- 覆盖全客户类型
- 像真实人随口说的话
- 不诱导优惠/金额/免费助教

---

## 8. output_package 标签和分组

见独立文档：`docs/tasks/10E-Workbench前端示例与标签配置方案.md`

3 组设计：
- **常用内容**: 朋友圈、私聊话术、群公告
- **活动/推广**: 活动方案、海报文案、短视频配文
- **管理/执行**: 执行建议、SOP/检查表、日报/汇报、PK方案

---

## 9. role / customer_type 标签

见独立文档：`docs/tasks/10E-Workbench前端示例与标签配置方案.md`

保持现有中文标签，增加辅助说明 tooltip。

---

## 10. 历史记录优化方案

### 当前问题
- workbench 类型只显示 `工作台·店长` 标签，看不到 user_intent
- 列表摘要显示 AI 输出前120字，不是用户输入
- 无法看出 customer_type 和 output_package

### 改造方案

**列表项改造 (history/page.tsx):**

```typescript
// 为 workbench 类型提取 user_intent 摘要
function workbenchSummary(item: GenerationHistoryItem): string {
  if (item.type !== "workbench") return "";
  const params = item.input_params;
  if (!params) return "";
  const intent = (params as any).user_intent || "";
  return intent.length > 40 ? intent.slice(0, 40) + "..." : intent;
}
```

在列表渲染中，workbench 类型显示 `workbenchSummary(item)` 而非 `contentSnippet(item)`。

**详情页改造:**
- workbench 类型在内容上方显示参数摘要行
- 从 `input_params` 中提取并友好展示

### 不需要后端改动

前端从已有的 `input_params` JSON 中提取信息即可。`input_params` 已包含 `user_intent`, `role`, `target_customer_type`, `output_package`, `extra_note`。

---

## 11. 样例库 / 反例库使用策略

### 10E 阶段：前端示例库

将优质样例库转为前端示例数据（24条），不接入 Prompt。

原因：
- 接入 Prompt 会导致 token 膨胀
- 样例选择逻辑复杂，10E 不应引入
- 前端示例零风险，直接提升用户体验

### 10F 阶段：结构化样例库 + Few-shot

- 将优质样例格式化为 YAML/JSON
- 按 role + customer_type + output_package 做索引
- 运行时根据用户参数动态选择 1-2 条相关样例注入 Prompt
- 控制注入量（每条样例精简到 200 字以内）

### 10G 阶段：反例库用于自动化回归

- 将反例库转为自动化测试用例
- 每次 Prompt 修改后自动跑反例库检查
- 不接入运行时 Prompt

---

## 12. 文件修改清单

| 文件 | 是否修改 | 改什么 | 风险 | 必须 |
|------|---------|--------|------|------|
| `web/src/app/dashboard/generate/page.tsx` | **是** | Tab改名、示例重做、output_package分组、快捷场景卡片、role卡片化 | 中 | P0 |
| `web/src/types/generate.ts` | 否 | — | — | — |
| `web/src/app/dashboard/history/page.tsx` | **是** | workbench列表摘要优化、详情参数展示 | 低 | P0 |
| `web/src/types/generation-history.ts` | 否 | — | — | — |
| `web/src/lib/api.ts` | 否 | — | — | — |
| `server/schemas/generate.py` | 否 | — | — | — |
| `server/services/content_service.py` | 否 | — | — | — |
| `server/api/v1/generate.py` | 否 | — | — | — |
| `server/prompts/workbench/free_intent.yaml` | 否 | — | — | — |
| `server/prompts/rules/baseline_rules.yaml` | 否 | — | — | — |

**只改2个前端文件。** 0个后端改动。0个数据库改动。

---

## 13. 是否需要数据库迁移

**否。** 10E 不改数据库。

---

## 14. 是否需要重新跑 DeepSeek 测试

10E 编码完成后建议跑 10-20 条轻量测试验证 UI 改动不影响生成质量。不需要重新跑 150 条或 30 条。

因为：前端改动不影响 Prompt 和 AI 调用链路。

---

## 15. 验收标准

1. ✅ Tab 显示"AI 工作台"
2. ✅ 24 条示例按岗位分组，6个岗位 × 4条
3. ✅ 点击示例自动填入 role + customer_type + user_intent
4. ✅ output_package 分3组展示，默认勾选"朋友圈"+"执行建议"
5. ✅ 生成结果每个 output_package 有独立复制按钮
6. ✅ 快捷场景卡片按岗位展示，点击一键填入
7. ✅ 历史记录 workbench 条目显示 user_intent 摘要
8. ✅ 旧4个Tab功能不受影响
9. ✅ 生成质量与 10D-4 一致

---

## 16. 是否建议开始 10E 编码

**建议开始。** 改动范围小（2个文件），风险可控，不改后端，不改数据库。
