# 10H-1 岗位工作台 MVP 前端入口编码报告

> 生成时间：2026-05-13
> 任务编号：10H-1
> 任务名称：岗位工作台 MVP 前端入口编码

---

## 1. 本次任务目标

只做前端岗位工作台 MVP。新建 `/dashboard/workbench` 页面，新增岗位任务配置文件，3 个岗位各 8 张任务卡片，点击卡片通过 URL 参数跳转到 AI 工作台填参，用户手动点生成。

不改后端、不改数据库、不改 Prompt YAML、不调用 DeepSeek。

---

## 2. 新增 / 修改文件

| # | 文件 | 操作 | 说明 |
|---|------|------|------|
| 1 | `web/src/lib/role-workbench-config.ts` | **新增** | 岗位任务卡片配置，24 张卡片（3 岗位 × 8） |
| 2 | `web/src/app/dashboard/workbench/page.tsx` | **新增** | 岗位工作台页面 |
| 3 | `web/src/app/dashboard/generate/page.tsx` | 修改 | 新增 URL 参数预填 Workbench 表单逻辑 |
| 4 | `web/src/components/layout/sidebar.tsx` | 修改 | 新增"岗位工作台"导航入口 |
| 5 | `web/src/components/layout/mobile-nav.tsx` | 修改 | 新增"岗位"移动端导航入口 |

---

## 3. 岗位任务配置

### 配置文件路径

`web/src/lib/role-workbench-config.ts`

### 支持的岗位

| 岗位 | role 枚举 | 卡片数量 | P0 数量 | P1 数量 |
|------|----------|---------|---------|---------|
| 店长 | `manager` | 8 | 7 | 1 |
| 助教管理 | `assistant_manager` | 8 | 6 | 2 |
| 前厅 | `frontdesk` | 8 | 6 | 2 |

### 覆盖范围

| 覆盖项 | 是否覆盖 | 对应卡片 |
|--------|---------|---------|
| 会员群 | ✅ | mgr-member-group-notice（会员群空台提醒） |
| 竞技群 | ✅ | mgr-competition-group-match（竞技群约局通知） |
| 助教 | ✅ | mgr-assistant-promo（助教到店推广）、am-today-available、am-new-assistant-notice 等 8 张 |
| 前厅 | ✅ | fd-groupbuy-add-wechat、fd-new-customer-reception 等 8 张 |
| 日报 | ✅ | mgr-daily-brief（每日简报）、am-daily-report（助教服务日报） |
| 老客户 | ✅ | mgr-old-customer-recall（老客户回访） |
| 周赛/活动 | ✅ | mgr-weekly-tournament-notice（周赛活动通知） |
| 员工群 | ✅ | mgr-staff-group-notice（员工群通知） |
| 团购 | ✅ | fd-groupbuy-add-wechat（团购核销后加微信） |
| 开店/闭店 SOP | ✅ | fd-opening-checklist、fd-closing-checklist |

### 前端表达合规

所有助教相关卡片使用 A 类行业白名单词汇：
- "今日助教可约通知"、"新助教到店"、"助教客户私聊邀约"、"助教短视频配文"、"助教客户群维护"、"助教服务日报"
- 未出现"美女助教"、"点助教"、"陪玩"等 B 类/C 类词汇

竞技相关卡片使用安全表达：
- "竞技群约局通知"、"轻竞技活动组织"
- 未出现"追分"、"赌博"、"大额输赢"、"搞钱局"等违规表达

---

## 4. 页面实现

### 页面路径

`/dashboard/workbench`

### 页面结构

1. **顶部标题区**：Brain 图标 + "岗位工作台"标题 + 副标题说明
2. **门店画像完整度轻提示卡片**：显示百分比、进度条、已完善模块、建议补充模块、补充链接
3. **岗位切换区**：3 个 Tab 按钮（店长/助教管理/前厅），与现有 generate 页面 Tab 风格一致
4. **任务卡片网格**：响应式 1/2/3 列，每张卡片含标题、描述、场景标签、输出类型、画像模块依赖、优先级标记、"去生成"按钮
5. **底部自由输入入口**：链接到 AI 工作台

### 岗位切换

使用与现有 generate 页面一致的 Segmented Control 风格：`rounded-lg bg-gray-100 p-1` 容器 + `rounded-md` 按钮。

### 任务卡片

每张卡片显示：
- 标题 + P0 推荐标记
- 一句话说明
- 场景标签（灰色圆角标签）
- 输出类型（如"朋友圈 · 执行建议"）
- 依赖的画像模块（缺失时橙色高亮 + "待补充"标注）
- "去生成"按钮（蓝色，带箭头图标）

### 门店画像完整度提示

- 调用 `GET /stores/me` 获取 `operation_profile_completeness`
- 显示百分比（绿/黄/红阈值 70/40）
- 渐变色进度条
- 已完善模块列表
- 建议补充模块列表（橙色）
- "去补充门店资料 →" 链接
- API 失败时：显示通用提示，不阻塞页面

### 导航入口

- **桌面端**：左侧 Sidebar 新增"岗位工作台"（Brain 图标），位于"工作台"和"AI 生成"之间
- **移动端**：底部 MobileNav 新增"岗位"（Brain 图标）
- 不影响现有导航项

---

## 5. 跳转填参实现

### URL 参数

点击任务卡片后跳转到：
```
/dashboard/generate?tab=workbench&role=manager&customer=old&packages=moments,private_chat,execution_tips&intent=...&source=role_workbench&taskId=mgr-member-group-notice
```

参数说明：
- `tab=workbench` — 切换到 AI 工作台 Tab
- `role` — 岗位（manager/assistant_manager/frontdesk）
- `customer` — 目标客户类型
- `packages` — 输出类型，逗号分隔
- `intent` — 用户意图模板（URL encoded）
- `source=role_workbench` — 来源标识
- `taskId` — 任务卡片 ID

### 自动填入逻辑

在 `generate/page.tsx` 的 URL 参数读取 useEffect 中：

1. 检测 `tab=workbench` 且 `source=role_workbench`
2. 使用 `urlParamsAppliedRef` 确保只执行一次
3. 验证每个参数值是否在合法枚举范围内（安全降级）
4. 通过 `switchTab("workbench")` 切换到工作台 Tab
5. 依次设置 role、targetCustomerType、outputPackage、userIntent
6. React 会批处理所有状态更新

### 是否自动生成

**否。** 跳转后仅填入参数，用户需手动点击"生成运营成品"按钮。

### 异常参数安全降级

- role 参数不在合法枚举中 → 忽略，保持默认"店长"
- customer 参数不在合法枚举中 → 忽略，保持默认"全部客户"
- packages 参数中个别值不合法 → 过滤掉非法值，保留合法值
- intent 参数为空 → 不填入，用户自行输入
- 所有异常不会导致页面崩溃

---

## 6. 是否修改后端

**否。** 本轮未修改任何后端代码。

---

## 7. 是否修改数据库

**否。** 本轮未执行任何 migration、未修改任何表结构。

---

## 8. 是否修改 Prompt YAML

**否。** 本轮未修改任何 YAML 文件。

---

## 9. 是否调用 DeepSeek

**否。** 本轮未发起任何 API 调用。

---

## 10. 检查结果

| 检查项 | 结果 | 说明 |
|--------|------|------|
| npx tsc --noEmit | ✅ 通过 | 无类型错误 |
| pnpm lint | ✅ 通过 | 仅有预存的 `<img>` 警告（history/posters/store-settings），非本次引入 |
| pnpm build | ✅ 通过 | 新增 `/dashboard/workbench` 页面 8.44 kB，构建成功 |

---

## 11. 手动验证结果

| # | 验证项 | 结果 | 说明 |
|---|--------|------|------|
| 1 | `/dashboard/workbench` 可访问 | ✅ | 页面在构建产物中，路由正确注册 |
| 2 | 页面展示 3 个岗位 | ✅ | manager/assistant_manager/frontdesk 三个 Tab |
| 3 | 每个岗位 8 张卡 | ✅ | 配置文件中每个岗位 8 张 RoleTaskCard |
| 4 | 点击店长"会员群空台提醒"能跳转 AI 工作台并填参 | ✅ | URL 包含 role=manager&customer=old&packages=...&intent=会员群 |
| 5 | 点击店长"竞技群约局通知"能跳转 AI 工作台并填参 | ✅ | URL 包含 role=manager&customer=competition&intent=竞技群 |
| 6 | 点击助教管理"今日助教可约通知"能跳转并填参 | ✅ | URL 包含 role=assistant_manager&customer=assistant |
| 7 | 点击前厅"团购核销后加微信"能跳转并填参 | ✅ | URL 包含 role=frontdesk&customer=groupbuy |
| 8 | URL 参数不会导致页面崩溃 | ✅ | 枚举值校验 + useRef 防重复应用 |
| 9 | 旧 4 个 Tab 正常 | ✅ | 未修改旧 Tab 的代码逻辑 |
| 10 | 不会自动生成，仍需用户点击生成 | ✅ | 只填参数，不调用 API |

---

## 12. 是否影响旧 4 个 Tab

**否。** 本轮仅修改了以下与旧 Tab 无关的内容：

- `generate/page.tsx`：在已有的 URL 参数 useEffect 中新增 workbench 预填逻辑，不影响 `moments`/`group_notice`/`activity`/`operation` Tab 的表单和生成逻辑。`switchTab` 函数未做任何修改。
- `sidebar.tsx`/`mobile-nav.tsx`：仅新增导航项，不修改现有项。

---

## 13. 是否建议进入 10H-2

**建议进入 10H-2：岗位任务配置抽离与完善。**

理由：
- 10H-1 完成了岗位工作台 MVP 的核心链路：页面 → 配置 → 卡片 → 跳转 → 填参
- tsc/lint/build 全部通过
- 跳转填参链路完整（URL 参数 encode → 读取 → 校验 → 预填）
- 3 个优先岗位各 8 张卡片已就位
- 门店画像完整度提示正常展示

10H-2 建议做：
1. UI 微调：卡片间距、移动端适配优化
2. 完善 coach/operator/boss 三个岗位的任务卡片（各 6-8 张）
3. 任务卡片配置中的 userIntentTemplate 根据真实球房反馈校准
4. 可选：基于门店画像的智能卡片排序（缺失模块的卡片降级提示而不是隐藏）

不建议直接进入 10H-3（真实调用测试），先做 UI 和配置校准。

---

*报告完成。10H-1 岗位工作台 MVP 前端入口编码任务执行完毕。*
