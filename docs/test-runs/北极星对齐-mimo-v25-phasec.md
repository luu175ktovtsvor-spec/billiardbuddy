# 北极星对齐测试报告 — mimo-v25-phasec

- 场景总数：**80**　谓词数：31
- 🟢 GREEN：**79**　🟡 YELLOW：**1**　🔴 RED：**0**　🟦 NO_JUDGE(裁判失败)：0　⚠️ ERROR(生成失败)：0
- **GREEN 率（占有效判定 80 个）：98.8%**（合并 main 门槛建议 ≥85%）

## 分类别
| 类别 | 🟢 | 🟡 | 🔴 | 🟦 | ⚠️ |
|---|---|---|---|---|---|
| activity | 9 | 1 | 0 | 0 | 0 |
| content | 12 | 0 | 0 | 0 | 0 |
| customer_pricing | 12 | 0 | 0 | 0 | 0 |
| diagnosis | 12 | 0 | 0 | 0 | 0 |
| games | 10 | 0 | 0 | 0 | 0 |
| outreach | 12 | 0 | 0 | 0 | 0 |
| report | 12 | 0 | 0 | 0 | 0 |

## 🔴 RED 明细（真问题，优先修）

## 🟡 YELLOW 明细（轻微偏离）
- [activity_007] 国庆节假日引流充值活动方案（activity）：judge=3「活动设计有具体动作和节日氛围，但亚军充值赠送比例严重超标，且核心钩子仍依赖优惠而非社交/氛围，缺少验收标准。」

## 🟦 NO_JUDGE / ⚠️ ERROR（系统问题，非内容问题）

## ⓘ 关键词参考（不参与判罚，供人工复核语境）
- [activity_007] YELLOW：漏must_hit=[['国庆', '假期', '黄金周']] 软禁词=[]
- [activity_008] GREEN：漏must_hit=[] 软禁词=['赌钱']
- [content_006] GREEN：漏must_hit=[['每月', '条数', '频次', '计划', '排期']] 软禁词=[]
- [content_008] GREEN：漏must_hit=[['联系', '私信', '报名', '告知']] 软禁词=[]
- [content_009] GREEN：漏must_hit=[['下期', '下次', '报名', '参加', '下场']] 软禁词=[]
- [customer_pricing_007] GREEN：漏must_hit=[] 软禁词=['充多少送多少']
- [customer_pricing_011] GREEN：漏must_hit=[['爆款', '引流款', '主打', '核心套餐'], ['转化', '充值', '留客', '回头']] 软禁词=['打法']
- [customer_pricing_012] GREEN：漏must_hit=[] 软禁词=['充5000送2000', '充多少送多少']
- [diagnosis_004] GREEN：漏must_hit=[] 软禁词=['护城河']
- [diagnosis_005] GREEN：漏must_hit=[['活动执行', '动作链', '跟进']] 软禁词=['闭环']
- [diagnosis_006] GREEN：漏must_hit=[['充值', '一卡通', '套餐']] 软禁词=['闭环']
- [diagnosis_007] GREEN：漏must_hit=[['老带新', '口碑', '裂变', '推荐']] 软禁词=[]
- [diagnosis_008] GREEN：漏must_hit=[] 软禁词=['全店降价']
- [diagnosis_009] GREEN：漏must_hit=[] 软禁词=['抓手', '闭环', '颗粒度']
- [diagnosis_011] GREEN：漏must_hit=[['品类控制', '4-5个', '优化渠道']] 软禁词=['组合拳']
- [games_003] GREEN：漏must_hit=[['你敢来', '挑战一下', '有本事', '试试', '来战']] 软禁词=[]
- [games_004] GREEN：漏must_hit=[['来试试', '先玩一把', '不用紧张', '随时来挑战']] 软禁词=[]
- [games_005] GREEN：漏must_hit=[['围观', '热闹', '气氛', '欢迎加入']] 软禁词=[]
- [games_007] GREEN：漏must_hit=[['水平差', '公平', '拉平', '有机会赢'], ['老带新', '高手', '新手都能参与', '欢迎加入']] 软禁词=[]
- [outreach_006] GREEN：漏must_hit=[['对手', '水平', '进阶', '突破']] 软禁词=[]
- [outreach_011] GREEN：漏must_hit=[['氛围', '状态', '感觉', '这里']] 软禁词=[]
- [report_003] GREEN：漏must_hit=[['朋友圈', '截图', '发圈']] 软禁词=[]
- [report_008] GREEN：漏must_hit=[['兑现', '发放时间', '次月']] 软禁词=[]