# 前端交互重构 + Agent 架构设计

> **日期**: 2026-06-11
> **状态**: 待实现
> **范围**: 前端交互重构 + 多 Agent 协作架构 + 移动端适配 + 异常处理

---

## 1. 需求概述

当前前端存在以下问题：
- 工作台页面 1169 行代码，所有内容（门店画像、配额、知识库、卡片列表、自由输入、生成结果）压缩在一个页面
- 角色排序不符合业务优先级（当前：店长→助教→前厅→老板→运营→教练）
- 没有使用频率驱动的卡片排序
- 没有多 Agent 协作能力
- 门店设置页面 ~1200 行，同样存在"信息墙"问题
- 移动端体验未针对性优化
- 缺少操作反馈的微交互动画

## 2. 设计目标

| 目标 | 度量方式 |
|------|---------|
| 缩短操作路径 | 从登录到生成结果 ≤ 3 步（当前 5 步） |
| 每个页面职责单一 | 页面代码行数 ≤ 400 行 |
| 支持跨角色协作 | 一个任务可自动调用多个 Agent |
| 移动端可用 | 手机端核心流程可完整走通 |
| 操作有反馈 | 所有交互有视觉响应（hover/click/loading/success） |

## 3. 角色排序

### 3.1 最终排列顺序

```
老板 → 店长 → 助教管理 → 教练 → 前厅 → 运营
```

### 3.2 需要修改的位置

| 文件 | 位置 | 当前顺序 | 修改后 |
|------|------|---------|--------|
| `role-workbench-config.ts` | `MVP_ROLES` (line ~1557) | manager, assistant_manager, frontdesk, boss, operator, coach | boss, manager, assistant_manager, coach, frontdesk, operator |
| `workbench-config.ts` | `ROLE_OPTIONS` | boss, manager, assistant_manager, coach, frontdesk, operator | boss, manager, assistant_manager, coach, frontdesk, operator（保持一致） |
| `store-settings/members/page.tsx` (line 36) | 角色列表 | manager, assistant_manager, coach, frontdesk, operator | manager, assistant_manager, coach, frontdesk, operator（保持一致） |

## 4. Agent 架构

### 4.1 核心概念

每个角色 = 一个 **Agent**，拥有：
- **专业能力**: 该角色的 knowledge YAML + operation YAML（已有 38 个 knowledge + 54 个 operation）
- **身份描述**: 角色的 system prompt（已有 ROLE_DESCRIPTIONS）
- **可调用的工具**: 生成文案、生成海报、查询知识库等（已有）

### 4.2 编排引擎

**后端新增 `server/services/orchestrator.py`**:

```
用户发起任务（如"策划一场周赛活动"）
        ↓
  编排引擎（Orchestrator）
        ↓
  分析任务 → 判断需要哪些 Agent
        ↓
  并发调用各 Agent 的 Prompt 模板
        ↓
  收集各 Agent 输出
        ↓
  汇总为结构化方案 → 返回给用户
```

**两种编排模式**:
1. **自动编排**: 用户描述任务，AI 自动判断需要哪些角色
2. **手动编排**: 用户显式选择要协作的角色组合

### 4.3 后端 API 变更

**新增接口**:

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/v1/orchestrate` | POST | 发起协作任务 |
| `/api/v1/orchestrate/{task_id}` | GET | 查询协作任务状态 |
| `/api/v1/orchestrate/{task_id}/cancel` | POST | 取消协作任务 |

**请求体** (`/api/v1/orchestrate`):
```json
{
  "task_type": "activity_planning",
  "description": "策划一场周末台球挑战赛，预算3000元",
  "store_id": "xxx",
  "roles": ["coach", "frontdesk", "operator", "manager"],
  "auto_orchestrate": true
}
```

**响应体**:
```json
{
  "task_id": "xxx",
  "status": "running",
  "agents": [
    {"role": "coach", "status": "completed", "content": "..."},
    {"role": "frontdesk", "status": "completed", "content": "..."},
    {"role": "operator", "status": "running", "content": null},
    {"role": "manager", "status": "pending", "content": null}
  ],
  "summary": null
}
```

### 4.4 前端新增路由

| 路由 | 页面 | 说明 |
|------|------|------|
| `/dashboard/workbench/[cardId]` | L3 任务执行页 | cardId 对应 ROLE_TASKS 中的卡片 ID |
| `/dashboard/workbench/collaborate` | L3' 协作任务页 | 新增 |
| `/dashboard/posters/[conversationId]` | L3 对话执行页 | 对应海报对话 ID |
| `/dashboard/store-settings/[module]` | L3 模块编辑页 | module: basic / profile / branding / pricing / slogan |

## 5. 页面层级设计

### 5.1 层级结构

```
L1 · Dashboard 首页（全局入口）
  ↓ 点击常用卡片
L2 · 工作台 / 生图 / 历史 / 设置（功能列表）
  ↓ 点击卡片/对话
L3 · 任务执行页 / 对话执行页 / 协作任务页（专注执行）
```

### 5.2 L1 · Dashboard 首页（改造）

**新增内容**:
- "常用任务"区域: 根据 localStorage 使用频率，展示 Top 6 常用卡片（跨角色）
- 每张常用卡片显示: emoji + 标题 + 角色来源 + 使用次数
- 点击常用卡片 → 直接进入 L3 任务执行页（跳过 L2）

**保留内容**:
- 门店信息卡片（名称 + 运营画像完整度）
- 配额使用情况
- 今日推荐（基于星期）

**移除/精简**:
- "快捷入口"卡片（首页已有常用任务，不需要重复入口）

### 5.3 L2 · 工作台（精简版）

**保留内容**:
- 角色 Tab 切换（新排序: 老板→店长→助教管理→教练→前厅→运营→协作）
- 任务卡片网格（按使用频率排序）
- 顶部面包屑导航

**移除内容**（移到 L3）:
- 门店画像完整度条
- 配额使用情况
- 知识库展开区
- 自由输入表单
- 生成结果区
- 下一步建议

**新增**:
- "协作" Tab（与角色 Tab 并列）
- 卡片 hover 上浮 + 阴影加深动画
- 卡片 click 缩放动画

### 5.4 L3 · 任务执行页

**完整闭环**:
```
输入区 → 生成按钮 → 流式结果 → 操作按钮组 → 基于此优化 → 下一步建议
```

**输入区**:
- "我想做什么" textarea（已有）
- 岗位选择 + 目标客户选择（已有）
- 输出包选择（已有）
- 补充说明（已有）
- 生成按钮

**结果区**:
- Markdown 流式渲染（已有）
- 操作按钮: 复制 / 编辑 / 变体为... / 生成海报 / 反馈
- "基于此优化"输入框
- "接下来你可以"推荐卡片

### 5.5 L3' · 协作任务页

**场景选择**:
- 策划活动（周赛/月赛/节日活动）
- 新店开业（开业筹备全流程）
- 员工培训（新人入职/技能提升）
- 经营复盘（月度/季度经营分析）

**协作进度展示**:
- 每个 Agent 一行，显示: 状态图标 + Agent 名称 + 职责描述 + 状态徽章
- 状态: ✅ 已完成 / ⏳ 生成中 / ⬜ 等待中 / ❌ 失败

**汇总结果**:
- 按 Agent 分段展示各部分
- 操作: 复制全部 / 按角色复制 / 导出

### 5.6 生图 · 页面拆分

**L2 · 对话列表页**:
- 对话列表（标题 + 轮次 + 日期）
- "新建对话"按钮
- 点击对话 → 进入 L3

**L3 · 对话执行页**:
- 面包屑: ← 返回列表 / 对话标题
- 对话流（用户消息 + AI 图片回复）
- 每张图片下方: 基于此调整 / 重新生成 / 下载
- 底部输入区: textarea + 比例选择 + 质量选择 + 参考图上传 + 发送按钮

### 5.7 门店设置 · 页面拆分

**L2 · 门店设置首页**:
- 各模块入口卡片: 基本信息 / 运营画像 / 品牌风格 / 定价体系 / 广告语
- 每个卡片显示完成状态（已完善/待补充）
- 点击卡片 → 进入 L3

**L3 · 模块编辑页**:
- 面包屑: ← 返回设置 / 模块名称
- 该模块的完整表单
- 保存按钮

**模块 slug 映射**:
| slug | 模块 | 对应表单 |
|------|------|---------|
| `basic` | 基本信息 | 门店名称、地址、电话、营业时间 |
| `profile` | 运营画像 | 门店类型、客群、定价、特色服务 |
| `branding` | 品牌风格 | 品牌调性选择、Logo、主色调 |
| `pricing` | 定价体系 | 台费标准、套餐设计、会员卡 |
| `slogan` | 广告语 | 门店宣传语、朋友圈文案风格 |

## 6. 卡片排序

### 6.1 排序规则

```typescript
// 每个角色 Tab 内的卡片排序
currentTasks.sort((a, b) => {
  const usage = getTaskCardUsage(); // localStorage
  const priorityOrder = { P0: 0, P1: 1, P2: 2 };
  const pa = priorityOrder[a.priority] ?? 9;
  const pb = priorityOrder[b.priority] ?? 9;

  // 同优先级按使用频率降序
  if (pa === pb) {
    return (usage[b.id] || 0) - (usage[a.id] || 0);
  }
  return pa - pb;
});
```

### 6.2 Dashboard 常用任务

```typescript
// 跨角色取 Top 6 常用卡片
function getTopCards(n: number = 6): RoleTaskCard[] {
  const usage = getTaskCardUsage();
  const allCards = Object.values(ROLE_TASKS).flat();
  return allCards
    .sort((a, b) => (usage[b.id] || 0) - (usage[a.id] || 0))
    .slice(0, n);
}
```

## 7. 交互反馈体系

### 7.1 操作类型区分

| 操作 | 反馈方式 | 示例 |
|------|---------|------|
| 导航跳转 | 页面过渡动画（slide/fade） | 侧边栏菜单、卡片进入详情 |
| 生成任务 | 原地展开结果面板 | "一键生成"按钮 |
| 选择切换 | 选中态动画（高亮+微弹） | 角色 Tab、卡片选择 |
| 确认操作 | Toast 提示 + 按钮状态变化 | 复制成功、收藏成功 |
| 危险操作 | 弹窗二次确认 | 删除、移除成员 |

### 7.2 微交互动画

| 元素 | 动画 | 实现方式 |
|------|------|---------|
| 卡片 hover | 轻微上浮 + 阴影加深 | `hover:-translate-y-0.5 hover:shadow-md transition-all duration-200` |
| 卡片 click | 轻微缩小再弹回 | `active:scale-[0.98] transition-transform duration-100` |
| Tab 切换 | 高亮滑动 | `transition-colors duration-150` |
| 生成中 | 脉冲动画 + 进度指示 | `animate-pulse` + 旋转图标 |
| 生成完成 | 结果区域从上滑入 + 淡入 | `animate-[slideIn_0.3s_ease-out]` |
| 复制成功 | 按钮图标切换 + 背景色变化 | 状态切换 2 秒后恢复 |
| Toast | 从顶部滑入，3 秒后滑出 | 固定定位 + CSS 动画 |

### 7.3 面包屑导航规则

| 页面 | 面包屑 |
|------|--------|
| Dashboard 首页 | 无 |
| L2 工作台 | ← 返回首页 / AI 工作台 |
| L3 任务执行页 | 工作台 / [角色名] / [任务名] |
| L3' 协作任务页 | 工作台 / 🤝 协作任务 |
| L2 生图列表 | ← 返回首页 / AI 生图 |
| L3 对话执行页 | ← 返回列表 / [对话标题] |
| L2 门店设置 | ← 返回首页 / 门店设置 |
| L3 模块编辑页 | 门店设置 / [模块名] |

## 8. 移动端适配

### 8.1 导航结构

- 保持底部 MobileNav（5 个 Tab: 首页、工作台、生图、历史、设置）
- 移动端跳过 L2，从 L1 常用卡片直接进入 L3
- L2 工作台在移动端仍然可用（通过底部导航进入）

### 8.2 布局适配

| 页面 | 桌面端 | 移动端 |
|------|--------|--------|
| L1 常用任务 | 2×3 网格 | 1×6 列表 |
| L2 卡片列表 | 3 列网格 | 1 列列表 |
| L2 角色 Tab | 横向排列 | 横向滚动 |
| L3 输入+结果 | 上下排列 | 上下排列（全宽） |
| L3 协作进度 | 竖向列表 | 竖向列表（全宽） |
| 门店设置 L2 | 2 列网格 | 1 列列表 |

### 8.3 移动端特有交互

- 卡片列表支持左右滑动切换角色（可选）
- 生成结果支持下拉刷新
- 输入区固定在底部（类似聊天界面）

## 9. 异常处理

### 9.1 Agent 协作失败

| 场景 | 处理方式 |
|------|---------|
| 单个 Agent 超时（30 秒） | 标记为"跳过"，其他 Agent 继续，汇总时标注缺失部分 |
| 所有 Agent 失败 | 显示错误提示 + "重试"按钮 |
| 用户中途取消 | 保留已完成的结果，标注"部分完成" |
| 网络断开 | 尝试重新连接，超时后提示"网络异常" |

### 9.2 门店资料不足

- 生成结果顶部显示黄色提示条（已有机制，保持）
- 提示条包含"去补充"链接，跳转到门店设置页
- 不阻断生成流程，只是标注"结果可能不够精准"

### 9.3 配额不足

- 生成按钮置灰 + 显示"本月额度已用完"
- 协作任务中某个 Agent 因配额不足失败 → 标记该 Agent 为"跳过"

## 10. 状态管理

### 10.1 localStorage 键

| 键 | 类型 | 说明 |
|----|------|------|
| `workbench_role` | string | 当前选中的角色 Tab |
| `workbench_target` | string | 目标客户类型 |
| `workbench_package` | string (JSON) | 输出包选择 |
| `workbench_card_usage` | string (JSON) | 卡片使用频率 `{ cardId: count }` |
| `onboarding_dismissed` | string | 新手引导是否已关闭 |
| `user_templates` | string (JSON) | 用户保存的模板 |

### 10.2 组件状态

- 无需引入 Redux/Zustand，继续使用 React Context + useState
- 协作任务状态通过轮询 `/api/v1/orchestrate/{task_id}` 获取
  - 轮询间隔: 2 秒
  - 最大轮询时间: 5 分钟（超时后提示用户刷新）
  - 所有 Agent 完成后停止轮询

## 11. 需要修改的文件清单

### 前端

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `web/src/lib/role-workbench-config.ts` | 修改 | 调整 MVP_ROLES 排序 |
| `web/src/lib/workbench-config.ts` | 修改 | 调整 ROLE_OPTIONS 排序 |
| `web/src/app/dashboard/page.tsx` | 重写 | 新增常用任务区域 |
| `web/src/app/dashboard/workbench/page.tsx` | 重写 | 精简为 L2（仅角色Tab+卡片列表） |
| `web/src/app/dashboard/workbench/[taskId]/page.tsx` | 新增 | L3 任务执行页 |
| `web/src/app/dashboard/workbench/collaborate/page.tsx` | 新增 | L3' 协作任务页 |
| `web/src/app/dashboard/posters/page.tsx` | 重写 | L2 对话列表页 |
| `web/src/app/dashboard/posters/[conversationId]/page.tsx` | 新增 | L3 对话执行页 |
| `web/src/app/dashboard/store-settings/page.tsx` | 重写 | L2 模块入口页 |
| `web/src/app/dashboard/store-settings/[module]/page.tsx` | 新增 | L3 模块编辑页 |
| `web/src/components/layout/sidebar.tsx` | 微调 | 适配新路由 |
| `web/src/components/layout/mobile-nav.tsx` | 微调 | 适配新路由 |
| `web/src/components/ui/toast.tsx` | 新增 | Toast 提示组件 |
| `web/src/components/ui/breadcrumb.tsx` | 新增 | 面包屑导航组件 |

### 后端

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `server/services/orchestrator.py` | 新增 | 编排引擎 |
| `server/api/v1/orchestrate.py` | 新增 | 协作任务 API |
| `server/api/v1/router.py` | 修改 | 注册新路由 |

## 12. 实施阶段建议

| 阶段 | 内容 | 依赖 |
|------|------|------|
| Phase 1 | 角色排序 + 卡片频率排序 + 微交互动画 | 无（纯前端配置） |
| Phase 2 | 工作台页面拆分（L2 + L3） | Phase 1 |
| Phase 3 | Dashboard 常用任务 + 生图页面拆分 | Phase 1 |
| Phase 4 | 门店设置页面拆分 | Phase 1 |
| Phase 5 | Agent 编排引擎（后端） | 无（可并行） |
| Phase 6 | 协作任务页（前端）+ 前后端联调 | Phase 2 + Phase 5 |
| Phase 7 | 移动端适配 | Phase 2-4 |
| Phase 8 | 异常处理 + 边界情况 | Phase 5-6 |

---

## 视觉参考

设计过程中的视觉 mockup 保存在 `.superpowers/brainstorm/` 目录下，包含：
- 导航流程图
- L1 Dashboard 首页
- L2 工作台
- L3 任务执行页
- L3' 协作任务页
- 生图页面拆分对比
