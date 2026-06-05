# 10E Workbench 前端示例与标签配置方案

> 用于 10E 编码实施时直接引用

---

## 1. 24 条前端示例

### 分组：老板 (boss) — 4条

| # | 示例标题 | user_intent | role | target_customer_type | output_package | 推荐展示分组 | 为什么适合 | 默认展示 |
|---|---------|------------|------|---------------------|---------------|------------|-----------|---------|
| 1 | 老板看汇报 | 这个月店里运营情况，帮我整理个汇报框架 | boss | all | daily_report, execution_tips | 老板场景 | 老板高频需求，报表类 | ✅ |
| 2 | 大客户维护 | 有个大客户好久没来了，想单独约一下，别太刻意 | boss | vip | private_chat, execution_tips | 老板场景 | 老板视角的大客户关系维护 | ✅ |
| 3 | 门店冷清 | 最近店里有点冷清，帮我想想发点什么 | boss | old | moments, group_notice, execution_tips | 老板场景 | 老板常见的经营感知需求 | ✅ |
| 4 | 看助教状态 | 看看助教这个月整体怎么样，帮我弄个汇总 | boss | assistant | daily_report, execution_tips | 老板场景 | 老板关注团队整体状态 | — |

### 分组：店长 (manager) — 4条

| # | 示例标题 | user_intent | role | target_customer_type | output_package | 推荐展示分组 | 为什么适合 | 默认展示 |
|---|---------|------------|------|---------------------|---------------|------------|-----------|---------|
| 5 | 老客户回访 | 好久没联系老客户了，帮我发几句话约他们来打球 | manager | old | private_chat, moments, execution_tips | 店长场景 | 店长最核心的日常运营动作 | ✅ |
| 6 | 下午空台 | 今天下午空台多，帮我发条朋友圈拉人 | manager | all | moments, execution_tips | 店长场景 | 高频即时需求 | ✅ |
| 7 | 员工生日 | 今天有个员工生日，帮我在员工群里发个祝福 | manager | assistant | group_notice, execution_tips | 店长场景 | 内部管理常见场景 | ✅ |
| 8 | 下雨天 | 今天下雨，店里估计人少，帮我发个朋友圈拉人 | manager | old | moments, execution_tips | 店长场景 | 天气驱动的真实运营场景 | — |

### 分组：助教管理 (assistant_manager) — 4条

| # | 示例标题 | user_intent | role | target_customer_type | output_package | 推荐展示分组 | 为什么适合 | 默认展示 |
|---|---------|------------|------|---------------------|---------------|------------|-----------|---------|
| 9 | 助教到店 | 今天助教都在，帮我发个朋友圈让客户知道 | assistant_manager | assistant | moments, execution_tips | 助教管理场景 | 助教推广刚需 | ✅ |
| 10 | 助教PK | 这个月想搞个助教PK，帮我设计一下规则 | assistant_manager | assistant | pk_plan, execution_tips | 助教管理场景 | 助教管理核心场景 | ✅ |
| 11 | 助教发圈提醒 | 助教最近朋友圈发得少，帮我在群里提醒一下 | assistant_manager | assistant | group_notice, execution_tips | 助教管理场景 | 内部管理高频需求 | ✅ |
| 12 | 短视频配文 | 助教拍了条短视频，帮我配个文案 | assistant_manager | assistant | short_video, moments | 助教管理场景 | 内容运营需求 | — |

### 分组：教练/赛事 (coach) — 4条

| # | 示例标题 | user_intent | role | target_customer_type | output_package | 推荐展示分组 | 为什么适合 | 默认展示 |
|---|---------|------------|------|---------------------|---------------|------------|-----------|---------|
| 13 | 32人周赛 | 这周想搞个32人周赛，帮我弄一下 | coach | competition | group_notice, moments, activity_plan, execution_tips | 教练场景 | 赛事核心场景 | ✅ |
| 14 | 赛后战报 | 昨晚周赛打完了，帮我写个赛后战报 | coach | competition | moments, group_notice, poster_copy | 教练场景 | 赛事收尾标准动作 | ✅ |
| 15 | 拉人进群 | 今天有几个新客打得还可以，想拉他们进周赛群 | coach | groupbuy | private_chat, group_notice, execution_tips | 教练场景 | 教练视角的客户转化 | ✅ |
| 16 | 约球搭子 | 有个客户问今晚有没有人一起打，怎么回 | coach | competition | private_chat, group_notice, execution_tips | 教练场景 | 撮合类高频需求 | — |

### 分组：前厅主管 (frontdesk) — 4条

| # | 示例标题 | user_intent | role | target_customer_type | output_package | 推荐展示分组 | 为什么适合 | 默认展示 |
|---|---------|------------|------|---------------------|---------------|------------|-----------|---------|
| 17 | 团购客加微信 | 今天来了几个团购客，想加微信后面方便喊他们来打球 | frontdesk | groupbuy | private_chat, sop_checklist, execution_tips | 前厅场景 | 前厅最核心场景 | ✅ |
| 18 | 新客接待 | 第一次来的客户，前台怎么跟他说比较自然 | frontdesk | new | private_chat, sop_checklist, execution_tips | 前厅场景 | 前厅高频场景 | ✅ |
| 19 | 开店检查 | 前厅早班开店总是漏东西，帮我弄个检查表 | frontdesk | new | sop_checklist, execution_tips | 前厅场景 | SOP 需求 | ✅ |
| 20 | 客人问会员 | 有个客人问会员怎么弄，我怎么跟他说比较自然 | frontdesk | groupbuy | private_chat, execution_tips | 前厅场景 | 转化场景 | — |

### 分组：运营负责人 (operator) — 4条

| # | 示例标题 | user_intent | role | target_customer_type | output_package | 推荐展示分组 | 为什么适合 | 默认展示 |
|---|---------|------------|------|---------------------|---------------|------------|-----------|---------|
| 21 | 月度汇报 | 这个月运营数据帮我搭个汇报框架 | operator | all | daily_report, execution_tips | 运营场景 | 运营核心汇报需求 | ✅ |
| 22 | 周末活动 | 老板让我想一个周末小活动，别太复杂 | operator | old | activity_plan, moments, group_notice, execution_tips | 运营场景 | 活动策划高频需求 | ✅ |
| 23 | 内容规划 | 最近朋友圈发得太少了，帮我规划这周发什么 | operator | all | moments, execution_tips | 运营场景 | 内容运营刚需 | ✅ |
| 24 | 短视频更新 | 店里短视频太久没更新了，帮我写几条配文 | operator | all | short_video, moments, execution_tips | 运营场景 | 多平台内容需求 | — |

### 示例设计原则

1. **每句话都像真人随口说的** — 不是"请生成XXX"，而是"帮我弄一下""帮我发一下"
2. **不诱导违规** — 不含"优惠""充值""免费""最低价"等词
3. **不写太长** — 每条20-40字
4. **覆盖全角色×全客户类型** — 24条关联到6角色×7客户类型
5. **默认展示策略** — 每岗位前3条默认展示，3×(6岗位)=18条默认展示
6. **换一批** — 点击"换一批"随机打乱或显示另一组

---

## 2. role 中文标签

保持当前标签，微调：

| 枚举值 | 当前标签 | 10E 标签 | tooltip |
|--------|---------|---------|---------|
| boss | 老板 | 老板 | 我是投资人/老板，关注全店经营 |
| manager | 店长 | 店长 | 我负责门店日常运营，管全店 |
| assistant_manager | 助教管理 | 助教管理 | 我负责助教团队的管理和推广 |
| coach | 教练 / 赛事负责人 | 教练/赛事 | 我负责教学和赛事组织 |
| frontdesk | 前厅主管 | 前厅主管 | 我负责客户接待和前台管理 |
| operator | 运营负责人 | 运营负责人 | 我负责内容、活动和数据分析 |

默认值：**manager (店长)** — 理由：店长是全店最常使用的人。

---

## 3. target_customer_type 中文标签

| 枚举值 | 10E 标签 | 简短说明 |
|--------|---------|---------|
| all | 全部客户 | 不确定时选这个 |
| groupbuy | 团购客 | 美团/抖音团购第一次来的客户 |
| new | 新客户 | 第1-2次到店，还在观望 |
| old | 老客户 | 3次以上到店，对我们有认可 |
| competition | 竞技客户 | 喜欢约局、打比赛的老手 |
| assistant | 助教客户 | 预约过或想约助教的客户 |
| light_competition | 轻竞技客 | 熟人之间娱乐性打局 |
| vip | 大客户 | 高频到店、大额充值的VIP |

默认值：**all (全部客户)** — 理由：用户不确定时不应该被限制。

---

## 4. output_package 中文标签和分组

### 分组设计

```
📋 常用内容
├── moments         朋友圈
├── private_chat    私聊话术
└── group_notice    群公告

📢 活动/推广
├── activity_plan   活动方案
├── poster_copy     海报文案
└── short_video     短视频配文

📊 管理/执行
├── execution_tips  执行建议
├── sop_checklist   SOP/检查表
├── daily_report    日报/汇报
└── pk_plan         PK方案
```

### 标签映射

| 枚举值 | 当前标签 | 10E 标签 | 分组 | tooltip |
|--------|---------|---------|------|---------|
| moments | 朋友圈 | 朋友圈 | 常用内容 | 2-3条可直接发的朋友圈文案 |
| private_chat | 私聊话术 | 私聊话术 | 常用内容 | 分场景的微信/当面对话语术 |
| group_notice | 群公告 | 群公告 | 常用内容 | 可直接发到微信群的公告 |
| activity_plan | 活动方案 | 活动方案 | 活动/推广 | 含目标、规则、执行清单 |
| poster_copy | 海报文案 | 海报文案 | 活动/推广 | 标题+副标题+正文 |
| short_video | 短视频配文 | 短视频配文 | 活动/推广 | 标题+配文+话题标签 |
| execution_tips | 执行建议 | 执行建议 | 管理/执行 | 谁发、什么时候发、怎么发 |
| sop_checklist | SOP/检查表 | SOP/检查表 | 管理/执行 | 逐条可勾选的检查清单 |
| daily_report | 日报/汇报 | 日报/汇报 | 管理/执行 | 数据摘要+总结+明日计划 |
| pk_plan | PK方案 | PK方案 | 管理/执行 | 指标定义+目标表+追踪表 |

### 默认勾选

**默认勾选**: `moments` + `execution_tips`

理由：朋友圈是最常用的输出类型，执行建议让用户知道怎么发。这两个是"最小可用组合"。

### 推荐输出组合

提供3个快捷组合按钮：

| 组合名 | 勾选内容 | 适用场景 |
|--------|---------|---------|
| 📝 标准内容包 | 朋友圈 + 私聊 + 群公告 + 执行建议 | 日常运营发内容 |
| 🏆 活动全案包 | 活动方案 + 朋友圈 + 群公告 + 海报 + 执行建议 | 做活动/周赛 |
| 📊 管理工具包 | PK方案 + SOP/检查表 + 日报/汇报 + 执行建议 | 内部管理 |

---

## 5. 快捷场景卡片设计

按岗位展示高频场景卡片，用户点击后一键填入全部参数。

### 老板场景卡片 (5个)

| 卡片标题 | user_intent | role | cust | output_package |
|---------|------------|------|------|---------------|
| 📊 本月运营汇报 | 帮我整理这个月运营汇报框架 | boss | all | daily_report, execution_tips |
| 👑 大客户关系 | 有个大客户好久没来了，单独约一下 | boss | vip | private_chat, execution_tips |
| 📱 发朋友圈拉人 | 最近店里有点冷清，帮我想想发什么 | boss | old | moments, group_notice, execution_tips |
| 👥 看助教团队 | 看看助教这个月整体状态怎么样 | boss | assistant | daily_report, execution_tips |
| 💡 想想办法 | 最近生意一般，帮我想想怎么弄 | boss | all | execution_tips, activity_plan |

### 店长场景卡片 (5个)

| 卡片标题 | user_intent | role | cust | output_package |
|---------|------------|------|------|---------------|
| 💬 老客户回访 | 好久没联系老客户了，帮我发几句话约球 | manager | old | private_chat, moments, execution_tips |
| 🕐 空台拉人 | 今天下午空台多，帮我发朋友圈 | manager | all | moments, execution_tips |
| 🎂 员工生日 | 今天有个员工生日，群里发个祝福 | manager | assistant | group_notice, execution_tips |
| 🌧️ 下雨天邀约 | 今天下雨人少，发朋友圈拉人 | manager | old | moments, execution_tips |
| 🧹 卫生检查 | 最近卫生有点乱，做个检查表 | manager | all | sop_checklist, execution_tips |

### 助教管理场景卡片 (5个)

| 卡片标题 | user_intent | role | cust | output_package |
|---------|------------|------|------|---------------|
| 📱 助教在店朋友圈 | 今天助教都在，发朋友圈 | assistant_manager | assistant | moments, execution_tips |
| 🏆 助教PK | 这个月搞个助教PK，帮我设计 | assistant_manager | assistant | pk_plan, execution_tips |
| 📢 提醒发朋友圈 | 助教朋友圈发太少，群里说下 | assistant_manager | assistant | group_notice, execution_tips |
| 🎬 短视频配文 | 助教拍了短视频，帮我配文 | assistant_manager | assistant | short_video, moments |
| 👔 招助教 | 想招几个助教，帮我写招聘内容 | assistant_manager | assistant | moments, execution_tips |

### 教练/赛事场景卡片 (5个)

| 卡片标题 | user_intent | role | cust | output_package |
|---------|------------|------|------|---------------|
| 🏆 周赛全套 | 这周搞32人周赛，帮我弄 | coach | competition | group_notice, moments, activity_plan, execution_tips |
| 📝 赛后战报 | 昨晚周赛打完，帮我写战报 | coach | competition | moments, group_notice, poster_copy |
| 🤝 拉人进群 | 新客打得不错，拉他进周赛群 | coach | groupbuy | private_chat, group_notice, execution_tips |
| 🎱 撮合约球 | 有客户问有没有人一起打 | coach | competition | private_chat, group_notice, execution_tips |
| 📚 课程推广 | 想推基础教学课，发朋友圈 | coach | new | moments, execution_tips |

### 前厅主管场景卡片 (5个)

| 卡片标题 | user_intent | role | cust | output_package |
|---------|------------|------|------|---------------|
| ➕ 团购客加微信 | 团购客来了，加微信方便后面喊球 | frontdesk | groupbuy | private_chat, sop_checklist, execution_tips |
| 🆕 新客接待 | 第一次来的客户，前台怎么说 | frontdesk | new | private_chat, sop_checklist, execution_tips |
| ✅ 开店检查 | 早班开店老漏东西，做个检查表 | frontdesk | new | sop_checklist, execution_tips |
| 💳 客人问会员 | 客人问会员怎么弄，怎么回 | frontdesk | groupbuy | private_chat, execution_tips |
| 😤 投诉安抚 | 客人排队太久不高兴，安抚一下 | frontdesk | new | private_chat, execution_tips |

### 运营负责人场景卡片 (5个)

| 卡片标题 | user_intent | role | cust | output_package |
|---------|------------|------|------|---------------|
| 📊 月度汇报 | 运营汇报框架帮我搭一个 | operator | all | daily_report, execution_tips |
| 🎉 周末小活动 | 做个周末活动，别太复杂 | operator | old | activity_plan, moments, group_notice, execution_tips |
| 📅 本周内容规划 | 朋友圈太久没发，规划发什么 | operator | all | moments, execution_tips |
| 🎬 短视频更新 | 短视频太久没更新，写配文 | operator | all | short_video, moments, execution_tips |
| 📈 数据分析 | 最近客流什么情况，帮我理理 | operator | all | daily_report, execution_tips |

---

## 6. 默认展示策略

### Tab 默认状态

- **岗位**: manager (店长)
- **目标客户**: all (全部客户)
- **输出类型**: moments + execution_tips (朋友圈+执行建议)
- **快捷场景**: 默认展示店长场景卡片(5个)
- **示例**: 默认展示前18条（每岗位3条）

### 用户切换岗位时

- 快捷场景卡片自动切换到对应岗位
- 示例自动切换到对应岗位分组
- output_package 保持用户已选（不重置）

---

## 7. 随机换一批示例策略

"换一批"按钮：
- 每岗位准备了4条示例，默认展示3条
- 点击"换一批"，第4条替换第1条
- 再次点击，全部4条随机排列
- 不跨岗位混合（保持岗位分组清晰）
