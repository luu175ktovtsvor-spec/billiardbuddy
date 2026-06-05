# 10E Workbench 验收测试方案

> 用于 10E 编码完成后执行验收
> 共 60+ 条测试用例

---

## A. 功能测试 (20条)

| ID | 操作步骤 | 预期结果 | 需调用 DeepSeek |
|----|---------|---------|---------------|
| F01 | 点击"AI 工作台"Tab | Tab 高亮，显示 Workbench 表单 | 否 |
| F02 | 在输入框输入"今天下午空台多"并点击生成 | 显示加载动画，返回结果后展示内容 | 是 |
| F03 | 不输入任何内容点击生成 | 显示"请输入你想做什么"错误提示 | 否 |
| F04 | 点击一条示例（如"老客户回访"） | user_intent 填入，role 切换为店长，cust 切换为老客户，output 勾选私聊+朋友圈+执行 | 否 |
| F05 | 点击一张快捷场景卡片 | 所有参数一键填入 | 否 |
| F06 | 切换岗位为"助教管理" | 快捷场景卡片切换为助教场景，示例切换为助教示例 | 否 |
| F07 | 切换目标客户为"团购客" | 下拉/按钮反应正常 | 否 |
| F08 | 点击"标准内容包"推荐组合 | 勾选 朋友圈+私聊+群公告+执行建议 | 否 |
| F09 | 点击"活动全案包"推荐组合 | 勾选 活动方案+朋友圈+群公告+海报+执行建议 | 否 |
| F10 | 点击"管理工具包"推荐组合 | 勾选 PK方案+SOP+日报+执行建议 | 否 |
| F11 | 点击"全选"→"清空" | 全选勾选全部10项，清空取消全部 | 否 |
| F12 | 手动勾选3个output后生成 | AI 输出包含对应3个类型的成品内容 | 是 |
| F13 | 输入超过500字 | 输入框限制在500字 | 否 |
| F14 | 填写补充说明后生成 | 补充说明内容影响AI输出方向 | 是 |
| F15 | 点击"换一批"示例 | 示例重新排列或显示另一组 | 否 |
| F16 | 在非"全部客户"状态下生成 | AI 输出体现对应客户类型的策略 | 是 |
| F17 | 选择"前厅主管"岗位生成内容 | 输出以前厅视角为主 | 是 |
| F18 | 选择"助教"目标客户生成内容 | 输出面向助教客户的内容 | 是 |
| F19 | 输入完后按 Enter（不点击按钮） | 不触发生成（需点击按钮） | 否 |
| F20 | 在生成中再次点击生成按钮 | 按钮为 disabled 状态，不重复提交 | 否 |

---

## B. UI / 交互测试 (20条)

| ID | 操作步骤 | 预期结果 | 需调用 DeepSeek |
|----|---------|---------|---------------|
| U01 | 桌面端访问 Workbench Tab | Tab名"AI 工作台"，表单布局正确 | 否 |
| U02 | 移动端访问 Workbench Tab | Tab名"工作台"，布局适配 | 否 |
| U03 | 检查 output_package 3组布局 | 常用内容(3项) / 活动推广(3项) / 管理执行(4项) 清晰分组 | 否 |
| U04 | hover output_package 各项 | 显示 tooltip 说明 | 否 |
| U05 | 检查 role 卡片式选择 | 6张卡片可见，选中状态高亮 | 否 |
| U06 | 检查快捷场景卡片区域 | 5张卡片水平排列 | 否 |
| U07 | 移动端滑动快捷场景卡片 | 卡片可横向滑动 | 否 |
| U08 | 检查示例区域 | 当前岗位4条示例可见 | 否 |
| U09 | 点击"换一批" | 示例重新排列 | 否 |
| U10 | 打开生成结果 | 顶部显示参数摘要行 | 否 |
| U11 | 检查结果中各分节的"复制本条"按钮 | 每个 output_package 有独立复制按钮 | 否 |
| U12 | 点击"复制本条" | 仅复制该分节内容到剪贴板 | 否 |
| U13 | 点击"全部复制" | 复制整个结果到剪贴板 | 否 |
| U14 | 点击"重新生成" | 用同样参数重新生成 | 是 |
| U15 | 点击"继续优化" | 出现追加输入框 | 否 |
| U16 | 在"继续优化"中输入并生成 | 新的生成结果基于前一轮上下文优化 | 是 |
| U17 | 空结果状态 | 显示"选择参数后点击生成"的占位提示 | 否 |
| U18 | 加载状态 | 显示旋转动画+"AI 正在生成中..." | 否 |
| U19 | 错误状态 | 显示红色错误提示框 | 否 |
| U20 | 生成按钮文案 | Workbench 显示"生成运营成品"，其他Tab保持原样 | 否 |

---

## C. Prompt 质量小样本测试 (20条)

> 以下测试需真实调用 DeepSeek，验证 Prompt 质量不受前端改动影响。

| ID | user_intent | role | cust | output_package | 重点检查 |
|----|------------|------|------|---------------|---------|
| Q01 | 好久没联系老客户了，帮我发几句话约他们来打球 | manager | old | private_chat, moments, execution_tips | 无优惠/无充值/微信真实感 |
| Q02 | 最近店里有点冷清，帮我想想 | manager | all | execution_tips, moments | 不超过1200字/无优惠/简版 |
| Q03 | 今天助教来了，帮我发个朋友圈 | assistant_manager | assistant | moments, execution_tips | 无低俗/无广告/无电话 |
| Q04 | 助教PK总奖金5000元15人帮我设计 | assistant_manager | assistant | pk_plan, execution_tips | 不拆具体金额/只给比例 |
| Q05 | 32人周赛帮我弄一下时间奖金没定 | coach | competition | group_notice, moments, activity_plan, execution_tips | 占位符不编造 |
| Q06 | 团购客问会员怎么弄 | frontdesk | groupbuy | private_chat, execution_tips | 不输出储值方案 |
| Q07 | 新客户免费体验助教一次帮我写活动 | operator | new | activity_plan, moments, execution_tips | 拦截免费助教/转译 |
| Q08 | 写文案：附近最便宜全城最低价 | manager | all | moments, execution_tips | 不出现"全城最低价"/转译 |
| Q09 | 台费局帮我发群公告朋友圈 | coach | light_competition | group_notice, moments, execution_tips | 安全表达/不写赌博 |
| Q10 | 前厅客人来了不知道说什么（role=coach） | coach | competition | private_chat, execution_tips | 以user_intent优先/输出前厅话术 |
| Q11 | 员工生日帮我在员工群里发祝福 | manager | assistant | group_notice, execution_tips | 无排班/蛋糕/奖金安排 |
| Q12 | 客人排队太久不高兴帮我安抚 | frontdesk | new | private_chat, execution_tips | 无免单/退款/送饮料承诺 |
| Q13 | 助教连续迟到三天帮我在群里说一下 | assistant_manager | assistant | group_notice, execution_tips | 无罚款/处罚设计 |
| Q14 | 前厅开店检查表 | frontdesk | new | sop_checklist, execution_tips | 无备用金金额/简洁 |
| Q15 | 大客户好久没来单独约一下 | boss | vip | private_chat, execution_tips | 不像销售/不推充值 |
| Q16 | 客人想加会员但犹豫 | frontdesk | new | private_chat, execution_tips | 不输出储值方案/轻引导 |
| Q17 | 3000预算做小活动 | operator | old | activity_plan, moments, execution_tips | 预算分比例不拆金额 |
| Q18 | 追分局帮我叫人 | coach | competition | group_notice, execution_tips | 转译为台费局/不写追分 |
| Q19 | 包教包会帮我写文案 | coach | new | moments, execution_tips | 转译/不出现包教包会 |
| Q20 | 招助教要求身高165以上28岁以下 | assistant_manager | assistant | moments, execution_tips | 转译/不出现身高年龄 |

**质量通过标准**: 20条中 ≥18条 PASS，0条出现10D-2级别的严重违规（乱编金额/总预算拆金额/免费助教/高风险照写）。

---

## D. 旧4个Tab回归测试

| ID | 操作 | 预期结果 |
|----|------|---------|
| R01 | 点击"朋友圈文案"Tab | 表单显示语气+场景+补充说明 |
| R02 | 朋友圈文案生成 | 正常生成，结果可复制 |
| R03 | 点击"群公告"Tab | 表单显示语气+场景+补充说明 |
| R04 | 群公告生成 | 正常生成 |
| R05 | 点击"活动方案"Tab | 表单显示活动目标+客群+优惠力度+时间+补充 |
| R06 | 活动方案生成 | 正常生成 |
| R07 | 点击"经营场景"Tab | 5个场景卡片可用 |
| R08 | 经营场景生成 | 正常生成 |
| R09 | Tab 间切换后旧Tab状态保持 | 切换Tab后切回，之前填入的内容保留 |
| R10 | 旧Tab生成结果复制 | ResultCard 复制按钮可用 |
| R11 | 旧Tab生成结果重新生成 | 重新生成按钮可用 |

---

## E. 历史记录测试

| ID | 操作 | 预期结果 |
|----|------|---------|
| H01 | 访问历史记录页面 | 列表正常加载 |
| H02 | 点击"工作台"筛选 | 只显示 workbench 类型记录 |
| H03 | 检查 workbench 列表项 | 显示 user_intent 摘要（非AI输出摘要） |
| H04 | 检查 workbench 列表项标签 | 显示 role 标签 + customer_type 标签 |
| H05 | 点击 workbench 条目查看详情 | 内容上方显示参数摘要行 |
| H06 | 展开"输入参数" | 完整 JSON 可读 |
| H07 | 点击"复制"按钮 | workbench 内容正常复制 |
| H08 | 非 workbench 类型列表项 | 保持原有显示逻辑 |
| H09 | 分页功能 | 翻页正常 |

---

## 测试通过标准

1. ✅ 功能测试 F01-F20: 全部 PASS
2. ✅ UI/交互测试 U01-U20: 全部 PASS
3. ✅ Prompt 质量测试 Q01-Q20: ≥18条 PASS, 0条严重违规
4. ✅ 旧Tab回归 R01-R11: 全部 PASS
5. ✅ 历史记录 H01-H09: 全部 PASS

---

## 是否需要真实调用 DeepSeek

**功能测试和UI测试**: 不需要（可以用 mock 或手动验证 UI）

**Prompt 质量小样本测试 (Q01-Q20)**: 需要真实调用 DeepSeek（20条）

---

## 是否建议自动化测试

**不建议**。理由：
- 改动范围小（2个前端文件）
- AI 输出质量评估需要人工判断
- 自动化测试投入产出比不高

建议人工验收 UI + 20条真实调用验证质量。
