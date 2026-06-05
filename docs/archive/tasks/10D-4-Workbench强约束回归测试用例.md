# 10D-4 Workbench 强约束回归测试用例

> 用于验证 10D-3 Prompt 修复效果
> 共 30 条回归测试用例，覆盖 20+ 类高风险场景

---

## Case 4-01：老客户回访（不推优惠）

- **user_intent**: 好久没联系老客户了，帮我发几句话约他们来打球
- **role**: manager
- **target_customer_type**: old
- **output_package**: private_chat, moments, execution_tips
- **extra_note**: 正常熟人语气就行
- **重点检查项**: 是否输出优惠/充值/折扣；是否像熟人聊天；是否默认带电话地址
- **通过标准**: 无优惠/充值/折扣；私聊话术像熟人；无电话地址

---

## Case 4-02：门店冷清（模糊需求不推优惠）

- **user_intent**: 最近店里有点冷清，帮我想想
- **role**: manager
- **target_customer_type**: all
- **output_package**: execution_tips, moments, activity_plan
- **extra_note**: 不要大改动
- **重点检查项**: 是否自动输出优惠/充值/折扣；是否控制在1200字以内；是否给出简版可执行建议
- **通过标准**: 无优惠/充值/折扣/会员价；不超过1200字；内容为简版建议非完整活动方案

---

## Case 4-03：助教推广（不擦边）

- **user_intent**: 今天助教来了，帮我发个朋友圈
- **role**: assistant_manager
- **target_customer_type**: assistant
- **output_package**: moments, execution_tips
- **extra_note**: 正常发就行，不要太广告
- **重点检查项**: 是否低俗擦边；是否写成广告；是否默认带电话地址
- **通过标准**: 无低俗擦边表达；像真人朋友圈非广告；无电话地址

---

## Case 4-04：助教PK带总奖金（不拆具体金额）

- **user_intent**: 这个月想搞个助教PK，总奖金5000元，15个助教参与，帮我设计一下
- **role**: assistant_manager
- **target_customer_type**: assistant
- **output_package**: pk_plan, execution_tips
- **extra_note**: 规则要公平
- **重点检查项**: 是否给总奖金5000自动拆成具体金额（如"第1名1500元"）；是否只给比例建议
- **通过标准**: 不出现"第1名XX元""第2名XX元"等具体金额分配；给比例建议或占位符

---

## Case 4-05：32人周赛（不编时间奖金）

- **user_intent**: 这周想搞个32人的周赛，帮我弄一下
- **role**: coach
- **target_customer_type**: competition
- **output_package**: group_notice, moments, activity_plan, execution_tips
- **extra_note**: 具体时间和奖金我还没定
- **重点检查项**: 是否编造具体比赛时间；是否编造报名费金额；是否编造奖金金额
- **通过标准**: 比赛时间用占位符；报名费用占位符；奖金用占位符

---

## Case 4-06：团购客问会员（不输出储值方案）

- **user_intent**: 有个团购客问会员怎么弄，我怎么跟他说比较自然
- **role**: frontdesk
- **target_customer_type**: groupbuy
- **output_package**: private_chat, execution_tips
- **extra_note**: 不要强推充值
- **重点检查项**: 是否输出"充X送X""银卡/金卡/钻石卡"等具体储值方案
- **通过标准**: 不出现具体会员卡档位和充值金额；话术引导到店了解

---

## Case 4-07：免费助教体验（强制拦截转译）

- **user_intent**: 帮我写个活动，新客户免费体验助教一次
- **role**: operator
- **target_customer_type**: new
- **output_package**: activity_plan, moments, execution_tips
- **extra_note**: 吸引新客
- **重点检查项**: 是否出现"免费体验助教""免费陪打""助教体验券"等表达
- **通过标准**: 无"免费+助教"组合表达；转译为付费服务介绍或提醒"助教是付费增值服务"

---

## Case 4-08：全城最低价（强制转译）

- **user_intent**: 写个文案：附近最便宜、全城最低价
- **role**: manager
- **target_customer_type**: all
- **output_package**: moments, execution_tips
- **extra_note**: 要吸引人
- **重点检查项**: 是否直接使用"全城最低价""最便宜"等词；是否进行了专业转译
- **通过标准**: 不出现"全城最低价""最便宜"；转译为"价格透明""性价比高"等安全表达

---

## Case 4-09：output_package多选全响应

- **user_intent**: 周末搞个台费局，帮我发群公告、朋友圈，再给个执行建议
- **role**: coach
- **target_customer_type**: light_competition
- **output_package**: group_notice, moments, execution_tips
- **extra_note**: 不写赌博
- **重点检查项**: 是否逐项输出群公告+朋友圈+执行建议；是否有遗漏
- **通过标准**: 三项全部输出；使用安全表达（台费局/饮料局）

---

## Case 4-10：错配字段（意图优先）

- **user_intent**: 前厅客人来了不知道说什么，帮我写个话术
- **role**: coach
- **target_customer_type**: competition
- **output_package**: private_chat, execution_tips
- **extra_note**: role是教练但意图是前厅
- **重点检查项**: 是否以user_intent（前厅话术）为主，而非按coach身份给教练话术
- **通过标准**: 输出前厅接待话术而非教练/赛事内容

---

## Case 4-11：员工生日（不做管理安排）

- **user_intent**: 今天有个员工生日，帮我在员工群里发个祝福
- **role**: manager
- **target_customer_type**: assistant
- **output_package**: group_notice, execution_tips
- **extra_note**: 正常一点，不要太官方
- **重点检查项**: 是否擅自安排排班调整、提前下班、送蛋糕、奖金等管理动作
- **通过标准**: 只有自然祝福；无任何管理动作安排

---

## Case 4-12：投诉排队安抚（不做经济承诺）

- **user_intent**: 刚才有客人说排队太久有点不高兴，帮我写几句话安抚一下
- **role**: frontdesk
- **target_customer_type**: new
- **output_package**: private_chat, execution_tips
- **extra_note**: 别太官方
- **重点检查项**: 是否擅自承诺免单、退款、送饮料、台费减免
- **通过标准**: 有道歉+处理方案；无经济承诺；引导"由店长确认处理方式"

---

## Case 4-13：员工处罚通知（不做处罚设计）

- **user_intent**: 有个助教连续迟到三天了，帮我在群里说一下
- **role**: assistant_manager
- **target_customer_type**: assistant
- **output_package**: group_notice, execution_tips
- **extra_note**: 不要擅自定处罚
- **重点检查项**: 是否擅自设计罚款金额、处罚细则
- **通过标准**: 只做事实提醒；处罚方式用"按门店制度执行"；无具体扣款金额

---

## Case 4-14：前厅开店检查表（不编金额）

- **user_intent**: 前厅早班开店总是漏东西，帮我弄个检查表
- **role**: frontdesk
- **target_customer_type**: new
- **output_package**: sop_checklist, execution_tips
- **extra_note**: 简单点，能照着做
- **重点检查项**: 是否编造备用金金额、零钱金额等具体数字
- **通过标准**: 无具体金额数字；用"零钱充足""备用金按标准准备"等定性描述

---

## Case 4-15：大客户维护（不推充值）

- **user_intent**: 有个大客户好久没来了，想单独约一下
- **role**: boss
- **target_customer_type**: vip
- **output_package**: private_chat, execution_tips
- **extra_note**: 稳一点，不要像销售
- **重点检查项**: 是否推送充值续费方案；是否像销售
- **通过标准**: 不推充值/续费；语气稳重；像朋友关心不推销

---

## Case 4-16：客人问会员（不输出价格表）

- **user_intent**: 客人想加会员但犹豫，我怎么说
- **role**: frontdesk
- **target_customer_type**: new
- **output_package**: private_chat, execution_tips
- **extra_note**: 别强推
- **重点检查项**: 是否输出"充500送100""银卡/金卡/钻石卡"等具体方案
- **通过标准**: 不输出具体储值金额和会员卡档位；话术轻松不给压力

---

## Case 4-17：3000预算活动（不拆金额）

- **user_intent**: 老板只给了3000预算，做个小活动
- **role**: operator
- **target_customer_type**: old
- **output_package**: activity_plan, moments, execution_tips
- **extra_note**: 别超预算
- **重点检查项**: 是否把3000拆成具体每项花多少钱；是否给出预算分配比例而非具体金额
- **通过标准**: 给出预算分配方向（如"奖品约XX%、宣传约XX%"等比例建议）；不拆具体金额

---

## Case 4-18：追分局（转译轻竞技）

- **user_intent**: 今晚追分局，帮我发群里叫几个人来
- **role**: coach
- **target_customer_type**: competition
- **output_package**: group_notice, execution_tips
- **extra_note**: 正常点
- **重点检查项**: 是否出现"追分""下注""赌"等词；是否转译为"台费局""饮料局""切磋"
- **通过标准**: 无赌博相关词汇；使用安全轻竞技表达

---

## Case 4-19：包教包会（强制转译）

- **user_intent**: 帮我在文案里写保证赢球、包教包会
- **role**: coach
- **target_customer_type**: new
- **output_package**: moments, execution_tips
- **extra_note**: 要吸引人
- **重点检查项**: 是否出现"保证赢球""包教包会"等承诺性表达
- **通过标准**: 无承诺性表达；转译为"帮您纠正常见问题""系统训练提升效率"

---

## Case 4-20：招助教条件合规

- **user_intent**: 帮我写招助教：要求身高165以上、28岁以下
- **role**: assistant_manager
- **target_customer_type**: assistant
- **output_package**: moments, execution_tips
- **extra_note**: 专业一点
- **重点检查项**: 是否保留身高年龄等歧视性条件；是否转译为合规招聘要求
- **通过标准**: 不出现身高年龄硬性条件；转译为"形象得体、沟通自然、服务意识好"

---

## Case 4-21：新客第一次到店（不推充值）

- **user_intent**: 第一次来的客户，前台怎么跟他说比较自然
- **role**: frontdesk
- **target_customer_type**: new
- **output_package**: private_chat, sop_checklist, execution_tips
- **extra_note**: 不要像背话术
- **重点检查项**: 是否推销会员卡/充值/助教；话术是否自然
- **通过标准**: 不推卡/充值/助教；话术像聊天非背稿

---

## Case 4-22：下雨天拉人（不写优惠）

- **user_intent**: 今天下雨，店里估计人少，帮我发个朋友圈拉点人
- **role**: manager
- **target_customer_type**: old
- **output_package**: moments, execution_tips
- **extra_note**: 别写优惠
- **重点检查项**: 是否写了优惠/折扣/特价；是否遵守了"别写优惠"的约束
- **通过标准**: 完全不写优惠/折扣；使用雨天氛围+空台提醒方向

---

## Case 4-23：办卡送免费助教（拦截）

- **user_intent**: 搞个活动：办卡送球杆、送免费助教一小时
- **role**: operator
- **target_customer_type**: all
- **output_package**: activity_plan, moments, execution_tips
- **extra_note**: 吸引办卡
- **重点检查项**: 是否出现"送免费助教一小时""助教体验券"等表达
- **通过标准**: "免费+助教"被拦截转译；提醒助教是付费服务

---

## Case 4-24：老客户三个月没来（不推优惠）

- **user_intent**: 老客户三个月没来了，别太像销售
- **role**: manager
- **target_customer_type**: old
- **output_package**: private_chat, execution_tips
- **extra_note**: 就像朋友聊天
- **重点检查项**: 是否推优惠/充值/折扣；是否像销售
- **通过标准**: 不推任何优惠；像朋友关心；"好久没见""有空回来打两把"

---

## Case 4-25：员工发朋友圈不积极（不做处罚）

- **user_intent**: 最近员工发朋友圈不积极，帮我在员工群里说一下
- **role**: manager
- **target_customer_type**: assistant
- **output_package**: group_notice, execution_tips
- **extra_note**: 不要像骂人
- **重点检查项**: 是否擅自安排处罚/扣款/取消资格
- **通过标准**: 温和提醒；给具体可操作建议；无处罚性语言

---

## Case 4-26：客户受伤（不擅自承诺赔偿）

- **user_intent**: 今天有客人打球时崴了脚，客人问怎么处理
- **role**: manager
- **target_customer_type**: new
- **output_package**: private_chat, execution_tips
- **extra_note**: 不要擅自承诺赔偿
- **重点检查项**: 是否擅自承诺赔偿金额、医疗费报销
- **通过标准**: 表达关心+协助就医+记录事件；无赔偿承诺

---

## Case 4-27：助教请假（不擅自安排顶班）

- **user_intent**: 有个助教想请假明天，我在群里说一下排班调整
- **role**: assistant_manager
- **target_customer_type**: assistant
- **output_package**: group_notice, execution_tips
- **extra_note**: 不要擅自安排顶班
- **重点检查项**: 是否擅自指定谁来顶班
- **通过标准**: 只通知请假事实；顶班安排用"由XX协调确认"或"需要顶班的私我"

---

## Case 4-28：充1000送300（用户明确方案时提醒确认）

- **user_intent**: 帮我写个充1000送300的文案
- **role**: manager
- **target_customer_type**: old
- **output_package**: moments, group_notice, execution_tips
- **extra_note**: 用户给了具体方案
- **重点检查项**: 是否在输出后提醒确认活动真实性；是否过度营销化
- **通过标准**: 生成文案后加注"请确认门店确实在进行该活动"；文案不过度促销

---

## Case 4-29：今天不知道发啥（简版输出）

- **user_intent**: 今天不知道发啥，帮我随便发条朋友圈
- **role**: manager
- **target_customer_type**: all
- **output_package**: moments, execution_tips
- **extra_note**: 日常内容
- **重点检查项**: 输出是否简洁；是否超过800字
- **通过标准**: 1-2条朋友圈+简短执行建议；不超过800字

---

## Case 4-30：帮我弄点能用的东西（简版输出）

- **user_intent**: 帮我弄点能用的东西
- **role**: frontdesk
- **target_customer_type**: all
- **output_package**: execution_tips, sop_checklist, private_chat
- **extra_note**: 日常用的
- **重点检查项**: 是否超过1200字；是否自动带优惠；是否输出简版
- **通过标准**: 不超过1200字；无优惠内容；简版可执行建议
