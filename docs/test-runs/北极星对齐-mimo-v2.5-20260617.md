# 北极星对齐测试报告 — mimo-v2.5-20260617

- 场景总数：**80**　谓词数：31
- 🟢 GREEN：**77**　🟡 YELLOW：**2**　🔴 RED：**1**　🟦 NO_JUDGE(裁判失败)：0　⚠️ ERROR(生成失败)：0
- **GREEN 率（占有效判定 80 个）：96.2%**（合并 main 门槛建议 ≥85%）

## 分类别
| 类别 | 🟢 | 🟡 | 🔴 | 🟦 | ⚠️ |
|---|---|---|---|---|---|
| activity | 10 | 0 | 0 | 0 | 0 |
| content | 12 | 0 | 0 | 0 | 0 |
| customer_pricing | 9 | 2 | 1 | 0 | 0 |
| diagnosis | 12 | 0 | 0 | 0 | 0 |
| games | 10 | 0 | 0 | 0 | 0 |
| outreach | 12 | 0 | 0 | 0 | 0 |
| report | 12 | 0 | 0 | 0 | 0 |

## 🔴 RED 明细（真问题，优先修）
- **[customer_pricing_010]** 店长问散客如何一步步培育成充值老客（customer_pricing/workbench_free/commercial）：硬红线=['充多少送多少'] judge=5「该产出完全贴合北极星核心逻辑：培育路径分五步（加微→回访→邀约→体验→转化），每步动作具体可执行；充值引导在关系建立后自然过渡，强调‘方便’和‘全场景通用’而非优惠；无大额赠送、无擦边、无编造信息，且要求补充门店具体信息，符合合规审查要求。」 违反=[]

## 🟡 YELLOW 明细（轻微偏离）
- [customer_pricing_001] 社区小店老板问如何设计一卡通充值档位（customer_pricing）：judge=3「方案整体结构清晰、赠送比例合规、强调自然推荐，但核心钩子仍以优惠为主，且未严格限定赠送金额仅限台位费，轻微偏离北极星'卖氛围/社交'和'赠送仅限台位费'原则。」
- [customer_pricing_003] 社区小店新开业充值活动方案（customer_pricing）：judge=3「活动设计整体合理，赠送比例合规，但核心钩子仍是价格优惠而非社交氛围，且一卡通赠送金额包含助教服务，违反了助教不搭赠的规则，需调整话术和钩子方向。」

## 🟦 NO_JUDGE / ⚠️ ERROR（系统问题，非内容问题）

## ⓘ 关键词参考（不参与判罚，供人工复核语境）
- [activity_004] GREEN：漏must_hit=[] 软禁词=['催']
- [activity_007] GREEN：漏must_hit=[['活动时间', '截止', '期间']] 软禁词=[]
- [activity_010] GREEN：漏must_hit=[] 软禁词=['免费助教']
- [content_001] GREEN：漏must_hit=[] 软禁词=['保证']
- [content_002] GREEN：漏must_hit=[['前三秒', '钩子', '开场', '标签', '#台球']] 软禁词=[]
- [content_006] GREEN：漏must_hit=[['每月', '条数', '频次', '计划', '排期']] 软禁词=['陪', '擦边']
- [content_008] GREEN：漏must_hit=[['联系', '私信', '报名', '告知']] 软禁词=[]
- [content_009] GREEN：漏must_hit=[['冠军', '夺冠', '胜出', '精彩']] 软禁词=[]
- [content_011] GREEN：漏must_hit=[] 软禁词=['陪你']
- [customer_pricing_002] GREEN：漏must_hit=[] 软禁词=['闭环', '闭环']
- [customer_pricing_004] GREEN：漏must_hit=[['A类', 'B类', 'C类', 'D类', 'ABCD']] 软禁词=[]
- [customer_pricing_010] RED：漏must_hit=[] 软禁词=['充多少送多少']
- [customer_pricing_011] GREEN：漏must_hit=[['4-5个', '品类', '控制', '精简']] 软禁词=[]
- [diagnosis_004] GREEN：漏must_hit=[] 软禁词=['私域流量', '流量池']
- [diagnosis_005] GREEN：漏must_hit=[['买赠', '秒杀', '抽奖', '一卡通'], ['活动执行', '动作链', '跟进']] 软禁词=[]
- [diagnosis_006] GREEN：漏must_hit=[] 软禁词=['闭环']
- [diagnosis_007] GREEN：漏must_hit=[['差异化', '定位', '特色'], ['老带新', '口碑', '裂变', '推荐']] 软禁词=[]
- [diagnosis_008] GREEN：漏must_hit=[] 软禁词=['护城河']
- [diagnosis_011] GREEN：漏must_hit=[['品类控制', '4-5个', '优化渠道']] 软禁词=[]
- [games_001] GREEN：漏must_hit=[['参与', '来玩', '来挑战', '欢迎']] 软禁词=[]
- [games_004] GREEN：漏must_hit=[['来试试', '先玩一把', '不用紧张', '随时来挑战']] 软禁词=[]
- [games_007] GREEN：漏must_hit=[['老带新', '高手', '新手都能参与', '欢迎加入']] 软禁词=[]
- [games_010] GREEN：漏must_hit=[['每周', '轮换', '新玩法', '保持新鲜', '下周又换']] 软禁词=[]
- [outreach_002] GREEN：漏must_hit=[['余额', '卡', '权益', '老位置', '台位']] 软禁词=[]
- [outreach_005] GREEN：漏must_hit=[['有人', '不愁没', '水平差不多']] 软禁词=[]
- [outreach_007] GREEN：漏must_hit=[['帮你', '留台', '方便']] 软禁词=[]
- [outreach_010] GREEN：漏must_hit=[] 软禁词=['打法']
- [outreach_011] GREEN：漏must_hit=[['打球', '台球', '球房'], ['氛围', '状态', '感觉', '这里']] 软禁词=[]
- [report_006] GREEN：漏must_hit=[] 软禁词=['闭环']
- [report_008] GREEN：漏must_hit=[['兑现', '发放时间', '次月'], ['可叠加', '累计', '叠加']] 软禁词=[]
- [report_009] GREEN：漏must_hit=[] 软禁词=['闭环']