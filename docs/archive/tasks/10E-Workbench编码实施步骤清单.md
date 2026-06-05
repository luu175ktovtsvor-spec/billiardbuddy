# 10E Workbench 编码实施步骤清单

> 用于下一轮执行模型按步骤编码
> 只改2个前端文件，0个后端改动，0个数据库改动

---

## 步骤总览

| 步骤 | 内容 | 涉及文件 | 难度 | 优先级 |
|------|------|---------|------|--------|
| 1 | 抽取 Workbench 常量配置 | `generate/page.tsx` | 低 | P0 |
| 2 | 重做示例数据 | `generate/page.tsx` | 低 | P0 |
| 3 | 优化Tab名和说明文案 | `generate/page.tsx` | 低 | P0 |
| 4 | 增加快捷场景卡片 | `generate/page.tsx` | 中 | P0 |
| 5 | output_package 分组展示 | `generate/page.tsx` | 中 | P0 |
| 6 | 增加推荐输出组合按钮 | `generate/page.tsx` | 低 | P1 |
| 7 | role 选择改为卡片式 | `generate/page.tsx` | 中 | P1 |
| 8 | 优化生成结果展示 | `generate/page.tsx` + `ResultCard` | 中 | P0 |
| 9 | 优化 history workbench 展示 | `history/page.tsx` | 低 | P0 |
| 10 | 前端类型检查 + 本地 UI 验收 | — | 低 | P0 |

---

## 步骤 1：抽取 Workbench 常量配置

**目标**: 将分散的常量集中到一个配置对象中，方便后续步骤引用。

**涉及文件**: `web/src/app/dashboard/generate/page.tsx`

**具体操作**:
1. 将 `WORKBENCH_EXAMPLES` 扩展为 `WORKBENCH_EXAMPLES_BY_ROLE` 对象，按 role 分组
2. 新增 `QUICK_SCENE_CARDS` 常量，按 role 分组的快捷场景卡片
3. 新增 `OUTPUT_GROUPS` 常量定义3组输出类型
4. 新增 `RECOMMENDED_COMBOS` 常量定义3个推荐组合
5. 保持现有 `ROLE_OPTIONS`, `CUSTOMER_OPTIONS`, `OUTPUT_OPTIONS` 不变

**验收标准**:
- 常量文件可被 TypeScript 正确类型推导
- 每个常量有明确的类型注释
- 不引入新的依赖

**风险点**: 低。纯常量抽取，不影响现有逻辑。

---

## 步骤 2：重做示例数据

**目标**: 将8条无分组示例替换为24条按岗位分组的示例。

**涉及文件**: `web/src/app/dashboard/generate/page.tsx`

**具体操作**:
1. 删除旧 `WORKBENCH_EXAMPLES` (8条)
2. 新增 `WORKBENCH_EXAMPLES_BY_ROLE: Record<WorkbenchRole, ExampleItem[]>`
3. 每条示例包含: `{ title, user_intent, role, target_customer_type, output_package, displayGroup }`
4. 默认展示逻辑: 根据当前选中的 role 展示对应分组示例
5. 增加"换一批"按钮: 从该岗位4条中随机排列
6. 点击示例时: 自动填入 user_intent + 切换 role + 切换 customer_type + 勾选 output_package

**数据来源**: `docs/tasks/10E-Workbench前端示例与标签配置方案.md` 第1节

**验收标准**:
- 6个岗位 × 4条 = 24条示例全部可用
- 默认显示当前岗位的4条示例
- 点击示例自动填入所有关联参数
- "换一批"可随机排列
- 示例不含"优惠""充值""免费""最低价"等诱导词

**风险点**: 低。纯前端数据替换。

---

## 步骤 3：优化 Tab 名和说明文案

**目标**: 让 Workbench Tab 更易理解。

**涉及文件**: `web/src/app/dashboard/generate/page.tsx`

**具体操作**:
1. Tab label 从 "我想做什么" 改为 "AI 工作台"
2. shortLabel 从 "自由输入" 改为 "工作台"
3. Workbench 表单顶部增加一行说明: "直接用大白话说你想做什么，AI 帮你生成可用的运营内容"
4. 输入框 placeholder 改为: "比如：今天下午空台多，帮我发条朋友圈拉人"
5. 补充说明 placeholder 改为: "比如：不要太长、别写优惠、用占位符、只要朋友圈"

**验收标准**:
- Tab 名在桌面端和移动端都显示正确
- 说明文案不占用太多纵向空间
- placeholder 更像真实用户会说的话

**风险点**: 低。

---

## 步骤 4：增加快捷场景卡片

**目标**: 用户点击卡片即可一键填入所有参数，降低使用门槛。

**涉及文件**: `web/src/app/dashboard/generate/page.tsx`

**具体操作**:
1. 在输入框下方、示例上方增加"📌 快捷场景"区域
2. 根据当前选中的 role 展示该岗位的5张场景卡片
3. 每张卡片显示: 图标 + 标题 + user_intent 摘要
4. 点击卡片: 自动填入 user_intent + 保持当前role + 切换customer_type + 勾选output_package
5. 卡片水平排列，移动端可横向滑动
6. 当前展示的岗位名显示在"快捷场景"旁边

**数据来源**: `docs/tasks/10E-Workbench前端示例与标签配置方案.md` 第5节

**验收标准**:
- 6个岗位 × 5张 = 30张场景卡片
- 切换岗位时场景卡片自动切换
- 点击卡片后表单参数正确填入
- "生成运营成品"按钮可用
- 移动端卡片可横向滑动

**风险点**: 中。卡片点击需要同时更新4个状态（intent, role, customer_type, output_package），注意避免状态冲突。

---

## 步骤 5：output_package 分组展示

**目标**: 10个checkbox按3组展示，降低选择负担。

**涉及文件**: `web/src/app/dashboard/generate/page.tsx`

**具体操作**:
1. 新增 `OUTPUT_GROUPS` 常量:
   ```typescript
   const OUTPUT_GROUPS = [
     { key: "content", label: "常用内容", items: ["moments","private_chat","group_notice"] },
     { key: "promo", label: "活动/推广", items: ["activity_plan","poster_copy","short_video"] },
     { key: "mgmt", label: "管理/执行", items: ["execution_tips","sop_checklist","daily_report","pk_plan"] },
   ] as const;
   ```
2. 替换当前的2列平铺为3组布局:
   - 每组有标题行
   - 组内 item 用2列 grid
3. 每个 checkbox 旁边增加简短 tooltip (hover 显示)
4. 默认勾选 `moments` + `execution_tips`

**验收标准**:
- 3组清晰可见，组间有分隔
- 每个checkbox旁边可见简短标签
- 默认勾选朋友圈+执行建议
- 点击不影响旧逻辑

**风险点**: 中。需要确保checkbox状态管理不被分组结构影响。

---

## 步骤 6：增加推荐输出组合按钮

**目标**: 提供"标准内容包""活动全案包""管理工具包"3个一键组合。

**涉及文件**: `web/src/app/dashboard/generate/page.tsx`

**具体操作**:
1. 在 output_package 区域下方增加3个按钮:
   - 📝 标准内容包 → 勾选 moments, private_chat, group_notice, execution_tips
   - 🏆 活动全案包 → 勾选 activity_plan, moments, group_notice, poster_copy, execution_tips
   - 📊 管理工具包 → 勾选 pk_plan, sop_checklist, daily_report, execution_tips
2. 点击组合按钮时: 替换（非追加）当前勾选
3. 旁边增加"全选"和"清空"小按钮

**验收标准**:
- 3个组合按钮都正确设置对应勾选
- "全选"勾选所有10项
- "清空"取消所有勾选
- 手动勾选后也能正常发送

**风险点**: 低。纯前端逻辑。

---

## 步骤 7：role 选择改为卡片式

**目标**: 6个岗位用更直观的卡片替代select下拉。

**涉及文件**: `web/src/app/dashboard/generate/page.tsx`

**具体操作**:
1. 将 `<select>` 替换为 3×2 的卡片 grid
2. 每张卡片显示: 图标 + 岗位名 + 简短描述(可选，hover tooltip)
3. 选中的卡片有蓝色边框和背景
4. 默认选中"店长"
5. 保留 select 作为移动端降级方案（可选，P2）

**验收标准**:
- 6张卡片视觉清晰
- 选中的卡片有明显高亮
- 切换卡片时快捷场景和示例自动切换
- 不影响功能

**风险点**: 中。卡片式需要更多纵向空间，注意移动端布局。

---

## 步骤 8：优化生成结果展示

**目标**: 增加分段复制、继续优化入口。

**涉及文件**: 
- `web/src/app/dashboard/generate/page.tsx`
- `web/src/components/generators/result-card.tsx`

**具体操作**:
1. 在 ResultCard 中，workbench 类型结果增加参数摘要行:
   "您刚才说：XXX · 岗位：店长 · 客户：老客户"
2. 检测 AI 输出中的 output_package 分节标记（如"朋友圈文案""私聊话术""执行建议"），为每个分节增加独立的"复制本条"按钮
3. 底部增加"继续优化"按钮，点击后:
   - 在输入框下方追加一个"继续优化"输入区
   - 用户输入追加需求（如"再给我加一条更活泼的"）
   - 发起新的 workbench 请求，extra_note 中包含前一轮上下文
4. 保留整体"全部复制"和"重新生成"按钮

**验收标准**:
- 参数摘要正确显示
- 每个分节有独立复制按钮
- "继续优化"入口可用
- 不影响非workbench类型的结果展示

**风险点**: 中。分节检测依赖AI输出格式的稳定性，需要做降级处理（如果检测不到分节，只显示"全部复制"）。

---

## 步骤 9：优化 history workbench 展示

**目标**: workbench 历史记录更易识别和追溯。

**涉及文件**: `web/src/app/dashboard/history/page.tsx`

**具体操作**:
1. 列表项渲染:
   - workbench 类型: 显示 `user_intent` 摘要（前40字）+ `role` 标签 + `customer_type` 标签
   - 非 workbench 类型: 保持现有逻辑
2. 详情页:
   - workbench 类型在内容上方显示参数摘要行
   - 从 `input_params` JSON 中提取 `user_intent`, `role`, `target_customer_type`, `output_package`
   - 友好展示（不直接展示 JSON）
3. workbench 筛选保持现有逻辑（type=workbench）

**辅助函数**:
```typescript
function workbenchSummary(item: GenerationHistoryItem): string {
  const params = item.input_params as any;
  return params?.user_intent?.slice(0, 40) || "";
}

function workbenchMeta(item: GenerationHistoryItem): { role: string; cust: string; pkgs: string[] } {
  const params = item.input_params as any;
  const ROLE_CN: Record<string, string> = {
    boss: "老板", manager: "店长", assistant_manager: "助教管理",
    coach: "教练", frontdesk: "前厅", operator: "运营"
  };
  const CUST_CN: Record<string, string> = {
    all: "全部", groupbuy: "团购", new: "新客", old: "老客",
    competition: "竞技", assistant: "助教", light_competition: "轻竞技", vip: "VIP"
  };
  return {
    role: ROLE_CN[params?.role] || params?.role || "",
    cust: CUST_CN[params?.target_customer_type] || params?.target_customer_type || "",
    pkgs: Array.isArray(params?.output_package) ? params.output_package : [],
  };
}
```

**验收标准**:
- workbench 条目列表显示 user_intent 摘要
- 列表项显示 role + customer_type 标签
- 详情页参数区友好展示
- 非 workbench 条目不受影响

**风险点**: 低。`input_params` 已在数据库中，只读不写。

---

## 步骤 10：前端类型检查 + 本地 UI 验收

**目标**: 确保改动不引入类型错误，不影响旧功能。

**具体操作**:
1. 运行 `pnpm lint` 检查
2. 手动验收清单:
   - 旧4个Tab (朋友圈/群公告/活动方案/经营场景) 功能正常
   - Workbench Tab 新UI完整
   - 24条示例点击可用
   - 30张场景卡片点击可用
   - output_package 分组正常
   - 生成结果分段复制正常
   - 历史记录 workbench 条目显示正确
   - 移动端布局不崩
3. 如果后端在运行，跑2-3条真实生成验证

**验收标准**:
- `pnpm lint` 0 error
- 旧4个Tab功能不受影响
- Workbench 新UI所有交互可用
- TypeScript 编译通过

**风险点**: 低。

---

## 推荐执行顺序

按步骤 1→2→3→4→5→6→7→8→9→10 顺序执行。

步骤1-4 可以一次性完成（都是纯UI改造，不涉及逻辑变更）。

步骤5-7 建议分两次提交（涉及交互逻辑变更）。

步骤8-9 可以一起做（结果展示+历史记录）。

步骤10 是最后的检查和验收。

## 是否建议一次性编码还是分两轮编码

**建议分两轮**:

**第一轮** (步骤1-5): Tab重命名 + 示例重做 + 快捷场景 + output_package分组 + 推荐组合
- 这是用户体验最核心的改动
- 改完后可以立刻看到效果

**第二轮** (步骤6-9): role卡片化 + 结果分段复制 + 历史记录优化
- 这是锦上添花的体验优化
- 可以在第一轮验收后再做

---

## 是否建议新建组件 / 常量文件

**建议新建**:
- `web/src/lib/workbench-config.ts` — 存放所有 Workbench 常量（示例数据、场景卡片、分组配置、推荐组合、标签映射）
- 理由: `page.tsx` 已经800+行，新增常量会让文件过长。抽取到独立文件提高可维护性

**不建议新建**:
- 不新建 Workbench 专用组件（改动范围小，拆组件收益不大）
- 不新建后端文件
