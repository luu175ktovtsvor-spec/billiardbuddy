# 10E-1：Workbench 产品化 P0 第一轮编码任务

## 任务定位

你现在只负责【10E-1：Workbench 产品化 P0 第一轮编码】。

本任务基于以下 10E 方案文档执行：

1. `docs/reports/10E-方案设计完成报告.md`
2. `docs/tasks/阶段10E-Workbench产品化与体验收口深度实施方案.md`
3. `docs/tasks/10E-Workbench前端示例与标签配置方案.md`
4. `docs/tasks/10E-Workbench编码实施步骤清单.md`
5. `docs/tasks/10E-Workbench验收测试方案.md`

本任务只做 **10E 第一轮 P0 前端体验改造**，不做后端、不做 Prompt、不做数据库。

---

## 一、任务目标

把 Workbench 从“能用的第 5 个 Tab”优化成更容易理解、更容易上手的 AI 工作台入口。

本轮只做第一轮 P0：

1. Tab 名称从“我想做什么”改为“AI 工作台”
2. 新建 Workbench 配置常量文件
3. 24 条示例按 6 个岗位分组
4. 30 张快捷场景卡片，按岗位展示
5. `output_package` 按 3 组展示
6. 增加推荐输出组合按钮
7. 默认勾选 `moments + execution_tips`
8. 点击示例 / 快捷场景后自动填入 `user_intent`、`role`、`target_customer_type`、`output_package`
9. 旧 4 个 Tab 不受影响

---

## 二、本轮严禁事项

严禁：

1. 不要修改后端代码
2. 不要修改 Prompt YAML
3. 不要修改数据库
4. 不要创建迁移
5. 不要修改 PromptEngine
6. 不要修改 AI Provider
7. 不要调用 DeepSeek
8. 不要读取 `.env`
9. 不要输出 API Key
10. 不要删除文件
11. 不要做 10E-2 的功能
12. 不要改旧 4 个 Tab 的业务逻辑

本轮暂不做：

1. 生成结果分段复制
2. 继续优化入口
3. 历史记录 workbench 摘要优化
4. role 卡片式大改
5. 样例库 few-shot 接入
6. 反例库自动化测试
7. 任何后端接口变更

---

## 三、允许修改范围

### 必须新增

1. `web/src/lib/workbench-config.ts`

用于集中存放：

- role 标签
- customer_type 标签
- output_package 标签
- output_package 分组
- 推荐输出组合
- 24 条示例
- 30 张快捷场景卡片

### 允许修改

2. `web/src/app/dashboard/generate/page.tsx`

用于：

- 引入 `workbench-config.ts`
- Tab 改名
- Workbench 表单说明文案优化
- 示例按岗位展示
- 快捷场景卡片展示
- output_package 分组展示
- 推荐输出组合按钮
- 点击示例 / 场景卡片自动填入参数
- 默认 output_package 调整为 `moments + execution_tips`

### 谨慎修改

3. `web/src/types/generate.ts`

只有在 TypeScript 类型确实缺少必要类型时才允许修改。  
如果现有类型已经够用，不要改。

如需修改其他文件，必须在最终报告中说明原因，且不能改后端、YAML、数据库。

---

## 四、执行前必须确认

请先阅读以下文件，不要直接开改：

1. `web/src/app/dashboard/generate/page.tsx`
2. `web/src/types/generate.ts`
3. `web/src/lib/api.ts`
4. `docs/tasks/10E-Workbench前端示例与标签配置方案.md`
5. `docs/tasks/10E-Workbench编码实施步骤清单.md`

然后先确认：

1. 当前 Workbench Tab 的 label 写在哪里
2. 当前 `WORKBENCH_EXAMPLES` 写在哪里
3. 当前 `role / customer_type / output_package` 的状态变量叫什么
4. 当前 `output_package` checkbox 如何渲染
5. 当前默认 `output_package` 是什么
6. 当前旧 4 个 Tab 是否和 workbench 共用状态
7. 是否存在独立 `ResultCard` 组件

注意：

如果发现 `ResultCard` 是独立组件，本轮不要修改它。结果分段复制放到 10E-2。

---

## 五、真实枚举必须使用这些

根据 10D-3.5 已校准的真实枚举：

### role

- `boss`
- `manager`
- `assistant_manager`
- `coach`
- `frontdesk`
- `operator`

### target_customer_type

- `all`
- `groupbuy`
- `new`
- `old`
- `competition`
- `assistant`
- `light_competition`
- `vip`

### output_package

- `moments`
- `group_notice`
- `private_chat`
- `poster_copy`
- `short_video`
- `execution_tips`
- `daily_report`
- `activity_plan`
- `sop_checklist`
- `pk_plan`

严禁改成：

- `private_message`
- `video_caption`
- `execution_advice`

---

## 六、workbench-config.ts 设计要求

请新增：

`web/src/lib/workbench-config.ts`

建议导出以下内容：

1. `ROLE_OPTIONS`
2. `CUSTOMER_TYPE_OPTIONS`
3. `OUTPUT_PACKAGE_GROUPS`
4. `OUTPUT_PACKAGE_LABELS`
5. `RECOMMENDED_OUTPUT_COMBOS`
6. `WORKBENCH_EXAMPLES_BY_ROLE`
7. `QUICK_SCENE_CARDS_BY_ROLE`

### ROLE_OPTIONS

包含：

- `value`
- `label`
- `shortLabel`
- `description`

建议中文：

- `boss`：老板 / 经营负责人
- `manager`：店长
- `assistant_manager`：助教管理
- `coach`：教练 / 赛事
- `frontdesk`：前厅主管
- `operator`：运营负责人

### CUSTOMER_TYPE_OPTIONS

包含：

- `value`
- `label`
- `description`

建议中文：

- `all`：全部客户
- `groupbuy`：团购客
- `new`：新客户
- `old`：老客户
- `competition`：竞技客户
- `assistant`：助教客户
- `light_competition`：轻竞技客户
- `vip`：大客户

### OUTPUT_PACKAGE_GROUPS

分 3 组：

#### 常用内容

- `moments`：朋友圈
- `private_chat`：私聊话术
- `group_notice`：群公告

#### 活动 / 推广

- `activity_plan`：活动方案
- `poster_copy`：海报文案
- `short_video`：短视频配文

#### 管理 / 执行

- `execution_tips`：执行建议
- `sop_checklist`：SOP / 检查表
- `daily_report`：日报 / 汇报
- `pk_plan`：PK 方案

### RECOMMENDED_OUTPUT_COMBOS

至少 3 个：

#### 标准内容包

- `moments`
- `private_chat`
- `group_notice`
- `execution_tips`

#### 活动全案包

- `activity_plan`
- `moments`
- `group_notice`
- `poster_copy`
- `execution_tips`

#### 管理工具包

- `pk_plan`
- `sop_checklist`
- `daily_report`
- `execution_tips`

注意：推荐组合按钮点击后应该替换当前 output_package 选择，而不是叠加到已有选择。

---

## 七、24 条前端示例要求

请从：

`docs/tasks/10E-Workbench前端示例与标签配置方案.md`

中提取或整理 24 条示例。

要求：

1. 每个 role 至少 4 条
2. 示例必须像真实人说话
3. 不要写成标准 Prompt
4. 不要诱导优惠、金额、免费助教
5. 点击示例后自动填入：
   - `user_intent`
   - `role`
   - `target_customer_type`
   - `output_package`

建议结构：

```ts
export interface WorkbenchExample {
  id: string;
  title: string;
  userIntent: string;
  role: WorkbenchRole;
  targetCustomerType: TargetCustomerType;
  outputPackage: OutputPackageItem[];
  group: string;
}
```

---

## 八、快捷场景卡片要求

请从：

`docs/tasks/10E-Workbench前端示例与标签配置方案.md`

中提取或整理 30 张快捷场景卡片。

要求：

1. 6 个 role，每个 role 5 张卡片
2. 当前 role 改变时，只展示该 role 对应的 5 张
3. 点击卡片后自动填入：
   - `user_intent`
   - `role`
   - `target_customer_type`
   - `output_package`
4. 卡片文案要短，不要让页面太挤
5. 移动端可以横向滚动或自动换行，不能撑破页面

建议结构：

```ts
export interface QuickSceneCard {
  id: string;
  title: string;
  description: string;
  userIntent: string;
  role: WorkbenchRole;
  targetCustomerType: TargetCustomerType;
  outputPackage: OutputPackageItem[];
}
```

---

## 九、generate/page.tsx 改造要求

只改 Workbench 分支，不要影响旧 4 个 Tab。

### 1. Tab 改名

将：

“我想做什么”

改为：

“AI 工作台”

如果移动端空间不足，可以显示“工作台”。

### 2. Workbench 顶部说明

在 Workbench 表单顶部增加一句说明：

```text
直接说你想完成的运营动作，系统会按岗位、客户类型和输出形式生成可直接使用的内容。
```

也可以更短：

```text
像跟 AI 说话一样描述需求，适合朋友圈、私聊、群公告、活动、SOP、助教管理等场景。
```

### 3. 输入框 placeholder

建议改为：

```text
例如：好久没联系老客户了，帮我发几句话约他们来打球
```

### 4. 示例区

从原来的 8 个平铺示例，改为：

- 当前岗位示例优先展示
- 每个岗位 4 条
- 点击示例自动填入参数

可以先不做“换一批”，如果实现成本低可以做。

### 5. 快捷场景卡片

在输入框下方或示例区上方增加：

```text
常用场景
```

展示当前 role 的 5 张快捷场景卡片。

点击卡片自动填入参数。

### 6. output_package 分组展示

把当前 10 个 checkbox 改为 3 组：

- 常用内容
- 活动 / 推广
- 管理 / 执行

每组下展示对应 checkbox。

保留手动多选。

### 7. 推荐组合按钮

在 output_package 选择区上方或下方增加：

- 标准内容包
- 活动全案包
- 管理工具包

点击后替换 output_package 为对应组合。

### 8. 默认 output_package

默认值改为：

- `moments`
- `execution_tips`

如果当前已有默认值不同，请修改为上述两个。

### 9. 旧 4 个 Tab 不受影响

必须确认：

- 朋友圈文案 Tab 逻辑不变
- 群公告 Tab 逻辑不变
- 活动方案 Tab 逻辑不变
- 经营场景 Tab 逻辑不变

---

## 十、样式要求

保持现有项目风格，不引入新的 UI 库。

要求：

1. 简洁
2. 不要堆太多颜色
3. 卡片用现有圆角 / border / hover 风格
4. 选中状态清晰
5. 移动端不溢出
6. 不要让页面特别长；示例和卡片可以适度折叠或分组展示

---

## 十一、测试要求

完成后必须执行：

```bash
cd web
npx tsc --noEmit
pnpm lint
pnpm build
```

如果 `pnpm lint` 存在项目历史 warning，请说明是否为既有 warning，不能引入新的 error。

不需要调用 DeepSeek。

---

## 十二、输出报告

请生成：

`docs/reports/10E-1-Workbench产品化P0第一轮编码报告.md`

报告必须包含：

### 1. 实际新增 / 修改文件

列出：

- `web/src/lib/workbench-config.ts`
- `web/src/app/dashboard/generate/page.tsx`
- 如有其他文件，必须说明原因

### 2. 实际完成的功能

必须说明：

- Tab 是否改名
- 是否新增 24 条示例
- 是否新增 30 张快捷场景卡片
- 是否完成 output_package 分组
- 是否完成推荐输出组合
- 默认 output_package 是否为 `moments + execution_tips`
- 点击示例 / 卡片是否能自动填入参数

### 3. 是否影响旧 4 个 Tab

必须明确回答。

### 4. 是否修改后端

必须为否。

### 5. 是否修改 YAML

必须为否。

### 6. 是否修改数据库

必须为否。

### 7. 是否调用 DeepSeek

必须为否。

### 8. TypeScript / lint / build 结果

列出：

- `npx tsc --noEmit`
- `pnpm lint`
- `pnpm build`

### 9. 当前遗留问题

说明：

- 生成结果分段复制是否未做
- 历史记录 workbench 摘要优化是否未做
- role 卡片式是否未做
- 是否建议进入 10E-2

### 10. 是否建议进入 10E-2

如果本轮通过，建议进入。

---

## 十三、完成后只回复

1. 报告路径
2. 新增 / 修改了哪些文件
3. 是否完成 Tab 改名
4. 是否完成 24 条示例
5. 是否完成 30 张快捷场景卡片
6. 是否完成 output_package 分组
7. 是否完成推荐输出组合
8. 是否影响旧 4 个 Tab：必须为否
9. 是否修改后端：必须为否
10. 是否修改 YAML：必须为否
11. 是否修改数据库：必须为否
12. 是否调用 DeepSeek：必须为否
13. tsc / lint / build 是否通过
14. 是否建议进入 10E-2
