# 10H-1：岗位工作台 MVP 前端入口编码任务

## 任务定位

你现在只负责【10H-1：岗位工作台 MVP 前端入口编码】。

本任务基于 10H-0 岗位工作台产品方案与信息架构设计结果执行，目标是做出第一版“岗位工作台”前端入口。

本轮只做前端 MVP，不改后端、不改数据库、不改 Prompt YAML、不调用 DeepSeek。

核心定位：

> 岗位工作台是“任务发现层”，AI 工作台是“内容生成引擎”。

用户在岗位工作台点击任务卡片后，跳转到现有 AI 工作台，并自动填入 role、target_customer_type、output_package、user_intent 等参数，然后复用现有 Workbench 生成链路。

---

## 一、前置背景

已完成：

1. 10G：门店运营画像全链路
2. 10G-5.5：桌型枚举与新设备编造边界修复
3. 10H-0：岗位工作台产品方案与信息架构设计

10H-0 结论：

- 推荐新建独立轻量页面：`/dashboard/workbench`
- 10H-1 优先做 3 个岗位：
  - 店长 `manager`
  - 助教管理 `assistant_manager`
  - 前厅 `frontdesk`
- 每个岗位 8 张任务卡片
- 点击任务卡片通过 URL 参数跳转到 AI 工作台填参生成
- 不改后端
- 不改数据库
- 不改 YAML

---

## 二、严禁事项

严禁：

1. 不要修改后端代码
2. 不要修改数据库
3. 不要新增 migration
4. 不要修改 Prompt YAML
5. 不要修改 PromptEngine
6. 不要修改 AI Provider
7. 不要调用 DeepSeek
8. 不要读取 `.env`
9. 不要输出 API Key
10. 不要做 10H-2 / 10H-3
11. 不要做岗位工作台真实调用测试
12. 不要做图片 / 视频能力
13. 不要改旧 4 个 Tab 的业务逻辑
14. 不要把风险词、低俗词、赌博/追分等内容作为前端用户文案直接展示

允许：

1. 新增前端页面
2. 新增岗位任务配置文件
3. 修改左侧导航 / Dashboard 导航入口
4. 修改 AI 工作台页面以支持 URL 参数自动填参
5. 读取门店资料完整度用于页面轻提示
6. 跑前端 tsc / lint / build
7. 生成编码报告

---

## 三、必须阅读的文档和代码

请先阅读以下文件，不要直接开改。

### 10H 方案

1. `docs/reports/10H-0-岗位工作台方案设计报告.md`
2. `docs/tasks/阶段10H-0-岗位工作台产品方案与信息架构.md`
3. `docs/product-brain/岗位工作台任务卡片配置草案.md`

### 当前前端

4. `web/src/app/dashboard/generate/page.tsx`
5. `web/src/lib/workbench-config.ts`
6. `web/src/app/dashboard/store-settings/page.tsx`
7. `web/src/types/generate.ts`
8. `web/src/types/store.ts`
9. 当前 dashboard 导航相关文件，如：
   - `web/src/app/dashboard/layout.tsx`
   - `web/src/components/*Sidebar*`
   - `web/src/components/*Nav*`
   - 或项目实际导航组件

如某些文件不存在，请记录在报告中，不要中断任务。

---

## 四、本轮功能范围

### 必做 P0

1. 新建岗位工作台页面：
   - 推荐路径：`web/src/app/dashboard/workbench/page.tsx`
2. 新增岗位任务配置：
   - 推荐文件：`web/src/lib/role-workbench-config.ts`
3. 只实现 3 个岗位：
   - 店长 `manager`
   - 助教管理 `assistant_manager`
   - 前厅 `frontdesk`
4. 每个岗位 8 张任务卡片
5. 页面顶部显示岗位工作台说明
6. 支持岗位 Tab / 分组切换
7. 点击任务卡片跳转到现有 AI 工作台并自动填参
8. AI 工作台 `/dashboard/generate` 支持从 URL 参数读取 Workbench 填参
9. 页面显示门店画像完整度轻提示
10. 左侧导航或 dashboard 导航新增“岗位工作台”入口
11. 不影响旧 4 个 Tab
12. 前端 tsc / lint / build 通过

### 不做

1. 不做后端新接口
2. 不做数据库变更
3. 不做岗位权限
4. 不做多门店任务推荐
5. 不做真实调用测试
6. 不做完整 6 岗位全部上线
7. 不做复杂拖拽 / 排序 / 自定义任务
8. 不做 AI 自动推荐今日任务

---

## 五、岗位任务卡片配置要求

新增：

`web/src/lib/role-workbench-config.ts`

建议结构：

```ts
export type RoleWorkbenchTask = {
  id: string
  role: Role
  title: string
  description: string
  userIntentTemplate: string
  targetCustomerType: TargetCustomerType
  outputPackage: OutputPackage[]
  sceneTags: string[]
  requiredProfileModules: string[]
  priority: "P0" | "P1" | "P2"
}
```

如项目已有 Role / TargetCustomerType / OutputPackage 类型，请复用。  
如类型名称不同，按项目实际修改。

---

## 六、10H-1 必须内置的 3 个岗位

### 1. 店长 manager：8 张卡

建议任务：

1. 今日朋友圈
2. 老客户回访
3. 会员群空台提醒
4. 竞技群约局通知
5. 助教到店推广
6. 周赛 / 活动通知
7. 员工群通知
8. 每日简报

要求覆盖：

- 会员群
- 竞技群
- 助教
- 老客户
- 周赛 / 活动
- 员工群
- 日报

### 2. 助教管理 assistant_manager：8 张卡

建议任务：

1. 今日助教可约通知
2. 新助教到店
3. 助教客户私聊
4. 助教短视频配文
5. 助教客户群维护
6. 助教 PK
7. 助教服务日报
8. 助教招聘文案

要求：

- 前端表达专业化
- 不要直接展示“美女助教 / 点助教 / 陪玩”等低俗或口语风险词
- 可以写“助教服务”“助教可约”“助教客户维护”“服务体验型助教”

### 3. 前厅 frontdesk：8 张卡

建议任务：

1. 团购核销后加微信
2. 新客接待
3. 客户问会员怎么回
4. 客户问助教怎么回
5. 客户问有没有人一起打
6. 投诉安抚
7. 开店检查表
8. 闭店检查表

要求：

- 话术实际、短、能用
- 不乱承诺补偿
- 不乱报价
- 不强推充值
- 不把助教服务写成免费

---

## 七、前端页面设计要求

### 页面路径

推荐：

```text
/dashboard/workbench
```

页面标题：

```text
岗位工作台
```

副标题：

```text
按岗位选择今天要做的事，一键带入 AI 工作台生成可直接发布/执行的内容。
```

### 页面结构

建议：

1. 顶部标题区
2. 门店画像完整度轻提示卡片
3. 岗位切换区
4. 当前岗位任务卡片网格
5. 使用说明小提示

### 岗位切换

MVP 支持 3 个岗位：

```text
店长
助教管理
前厅
```

可用 Tabs / Segmented control / Button group。

### 卡片设计

每张卡显示：

- 标题
- 一句话说明
- 推荐输出类型
- 需要的资料模块标签，如：会员群、竞技群、助教体系、桌型设备
- 点击按钮：`去生成`

### 风格要求

- 保持当前项目 UI 风格
- 简洁、清楚
- 不要太密
- 移动端不溢出
- 不引入新 UI 库

---

## 八、点击卡片跳转逻辑

点击卡片后跳转到：

```text
/dashboard/generate?tab=workbench&role=manager&customer=old&packages=moments,private_chat&intent=...
```

参数建议：

- `tab=workbench`
- `role`
- `customer`
- `packages`
- `intent`
- 可选：`source=role_workbench`
- 可选：`taskId`

要求：

1. URL 参数要 encode
2. `outputPackage` 多值用逗号或项目已有方式
3. 跳转后 AI 工作台自动填入：
   - role
   - target_customer_type
   - output_package
   - user_intent
4. 不自动调用生成
5. 用户可以二次修改后再点生成
6. 如果参数异常，安全忽略，不要页面崩溃

---

## 九、修改 AI 工作台页面要求

修改：

`web/src/app/dashboard/generate/page.tsx`

目标：

1. 进入页面时读取 URL 参数
2. 如果 `tab=workbench`，自动切换到 AI 工作台 Tab
3. 填入对应字段
4. 不影响普通用户手动使用
5. 不影响旧 4 个 Tab
6. 不重复覆盖用户正在编辑的内容
7. 如参数只在首次加载使用，避免每次渲染都覆盖状态

注意：

- 这是 10H-1 的关键链路
- 不要改生成 API
- 不要改后端

---

## 十、门店画像完整度轻提示

如果已有 Store API 返回 `operation_profile_completeness`，岗位工作台页面可读取并展示。

显示建议：

```text
AI 运营画像完整度：83%
已适合生成大部分内容
建议补充：赛事活动、助教预约规则
```

如果读取失败：

- 不阻塞页面
- 显示通用提示：

```text
完善门店资料后，岗位任务生成会更贴近本店。
```

不要因为门店资料接口失败导致岗位工作台不可用。

---

## 十一、导航入口

在 dashboard 导航中新增：

```text
岗位工作台
```

路径：

```text
/dashboard/workbench
```

图标按项目现有图标库选择，如没有合适图标可复用现有图标。

不要删除或改名现有入口。

---

## 十二、检查要求

完成后执行：

```bash
cd web
npx tsc --noEmit
pnpm lint
pnpm build
```

如 lint 有既有 warning，请说明是否既有问题。

不需要后端检查，除非你误改了后端。

---

## 十三、手动验证要求

请至少验证：

1. `/dashboard/workbench` 可访问
2. 页面展示 3 个岗位
3. 每个岗位 8 张卡
4. 点击店长“会员群空台提醒”能跳转 AI 工作台并填参
5. 点击店长“竞技群约局通知”能跳转 AI 工作台并填参
6. 点击助教管理“今日助教可约通知”能跳转并填参
7. 点击前厅“团购核销后加微信”能跳转并填参
8. URL 参数不会导致页面崩溃
9. 旧 4 个 Tab 正常
10. 不会自动生成，仍需用户点击生成

---

## 十四、输出报告

请生成：

`docs/reports/10H-1-岗位工作台MVP前端入口编码报告.md`

报告必须包含：

### 1. 本次任务目标

说明只做前端岗位工作台 MVP。

### 2. 新增 / 修改文件

逐个列出。

### 3. 岗位任务配置

说明：

- 配置文件路径
- 支持哪些岗位
- 每个岗位任务数量
- 是否覆盖会员群 / 竞技群 / 助教 / 前厅 / 日报

### 4. 页面实现

说明：

- 页面路径
- 岗位切换
- 任务卡片
- 门店画像完整度提示
- 导航入口

### 5. 跳转填参实现

说明：

- URL 参数
- 是否自动填入 AI 工作台
- 是否自动生成：必须为否
- 异常参数是否安全降级

### 6. 是否修改后端

必须为否。

### 7. 是否修改数据库

必须为否。

### 8. 是否修改 Prompt YAML

必须为否。

### 9. 是否调用 DeepSeek

必须为否。

### 10. 检查结果

列出 tsc / lint / build。

### 11. 手动验证结果

逐条列出验证结果。

### 12. 是否影响旧 4 个 Tab

必须明确回答。

### 13. 是否建议进入 10H-2

如果 UI 和跳转链路通过，建议进入 10H-2：UI 微调 / 链路修复 / 任务卡片校准。  
不要直接进入真实调用测试，先做截图和人工体验判断。

---

## 十五、完成后只回复

完成后只回复：

1. 报告路径
2. 新增 / 修改了哪些文件
3. 是否新增 `/dashboard/workbench`
4. 是否新增岗位任务配置文件
5. 3 个岗位每个是否 8 张卡
6. 是否完成点击卡片跳转 AI 工作台并自动填参
7. 是否自动生成：必须为否
8. 是否完成导航入口
9. 是否修改后端：必须为否
10. 是否修改数据库：必须为否
11. 是否修改 YAML：必须为否
12. 是否调用 DeepSeek：必须为否
13. 前端 tsc / lint / build 是否通过
14. 是否影响旧 4 个 Tab：必须为否
15. 是否建议进入 10H-2
