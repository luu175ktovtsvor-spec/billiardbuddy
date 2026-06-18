# 北极星对齐测试报告 — mimo-v25pro-postfix

- 场景总数：**80**　谓词数：31
- 🟢 GREEN：**79**　🟡 YELLOW：**1**　🔴 RED：**0**　🟦 NO_JUDGE(裁判失败)：0　⚠️ ERROR(生成失败)：0
- **GREEN 率（占有效判定 80 个）：98.8%**（合并 main 门槛建议 ≥85%）

## 分类别
| 类别 | 🟢 | 🟡 | 🔴 | 🟦 | ⚠️ |
|---|---|---|---|---|---|
| activity | 10 | 0 | 0 | 0 | 0 |
| content | 12 | 0 | 0 | 0 | 0 |
| customer_pricing | 11 | 1 | 0 | 0 | 0 |
| diagnosis | 12 | 0 | 0 | 0 | 0 |
| games | 10 | 0 | 0 | 0 | 0 |
| outreach | 12 | 0 | 0 | 0 | 0 |
| report | 12 | 0 | 0 | 0 | 0 |

## 🔴 RED 明细（真问题，优先修）

## 🟡 YELLOW 明细（轻微偏离）
- [customer_pricing_006] 前厅主管向散客介绍一卡通充值权益（customer_pricing）：judge=3「话术整体自然，但核心钩子仍是充值优惠而非散客的社交/氛围需求，且使用了'会员卡'而非'一卡通'，轻微偏离北极星原则。」

## 🟦 NO_JUDGE / ⚠️ ERROR（系统问题，非内容问题）

## ⓘ 关键词参考（不参与判罚，供人工复核语境）
- [activity_003] GREEN：漏must_hit=[['套餐', '双人', '2人']] 软禁词=[]
- [activity_009] GREEN：漏must_hit=[['新手友好', '有人教', '零基础']] 软禁词=[]
- [content_001] GREEN：漏must_hit=[['氛围', '好玩', '轻松', '来打', '约球', '约上']] 软禁词=[]
- [content_004] GREEN：漏must_hit=[['3条', '三条', '不同角度', '差异']] 软禁词=[]
- [content_006] GREEN：漏must_hit=[['每月', '条数', '频次', '计划', '排期']] 软禁词=['闭环']
- [content_008] GREEN：漏must_hit=[['联系', '私信', '报名', '告知']] 软禁词=[]
- [content_009] GREEN：漏must_hit=[['战报', '比赛', '赛事', '结束', '落幕'], ['冠军', '夺冠', '胜出', '精彩']] 软禁词=[]
- [customer_pricing_001] GREEN：漏must_hit=[['10%', '15%', '9.9%', '比例', '小比例']] 软禁词=[]
- [customer_pricing_002] GREEN：漏must_hit=[] 软禁词=['打法']
- [customer_pricing_004] GREEN：漏must_hit=[] 软禁词=['打法']
- [customer_pricing_005] GREEN：漏must_hit=[['20%', '比例', '控制', '占比']] 软禁词=[]
- [customer_pricing_006] YELLOW：漏must_hit=[] 软禁词=['会员卡']
- [customer_pricing_007] GREEN：漏must_hit=[] 软禁词=['闭环']
- [customer_pricing_010] GREEN：漏must_hit=[] 软禁词=['闭环']
- [customer_pricing_012] GREEN：漏must_hit=[] 软禁词=['充5000送2000', '充多少送多少']
- [diagnosis_001] GREEN：漏must_hit=[] 软禁词=['私域流量']
- [diagnosis_002] GREEN：漏must_hit=[] 软禁词=['降价']
- [diagnosis_005] GREEN：漏must_hit=[] 软禁词=['闭环', '护城河']
- [diagnosis_006] GREEN：漏must_hit=[['充值', '一卡通', '套餐']] 软禁词=[]
- [diagnosis_007] GREEN：漏must_hit=[['差异化', '定位', '特色'], ['老带新', '口碑', '裂变', '推荐']] 软禁词=[]
- [diagnosis_008] GREEN：漏must_hit=[] 软禁词=['私域流量', '流量池']
- [diagnosis_010] GREEN：漏must_hit=[] 软禁词=['闭环']
- [diagnosis_011] GREEN：漏must_hit=[['品类控制', '4-5个', '优化渠道']] 软禁词=[]
- [diagnosis_012] GREEN：漏must_hit=[] 软禁词=['私域流量', '流量池']
- [games_001] GREEN：漏must_hit=[['参与', '来玩', '来挑战', '欢迎']] 软禁词=[]
- [games_007] GREEN：漏must_hit=[['老带新', '高手', '新手都能参与', '欢迎加入']] 软禁词=[]
- [games_010] GREEN：漏must_hit=[['每周', '轮换', '新玩法', '保持新鲜', '下周又换']] 软禁词=[]
- [outreach_009] GREEN：漏must_hit=[['对手', '高手', '强手', '水平']] 软禁词=[]
- [outreach_010] GREEN：漏must_hit=[['节', '国庆', '假期', '长假']] 软禁词=[]
- [outreach_012] GREEN：漏must_hit=[] 软禁词=['比赛台']
- [report_008] GREEN：漏must_hit=[['月度', '本月', '当月'], ['兑现', '发放时间', '次月'], ['可叠加', '累计', '叠加']] 软禁词=[]