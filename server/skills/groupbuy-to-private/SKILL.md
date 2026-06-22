---
name: 团购转私域
description: 把用团购券进店的客人，顺手加到微信、引进对应的群，变成能反复触达的自己人。
argument-hint: [可选：哪类团购客/想往哪个群引]
user_invocable: true
---

# 团购转私域

当用户说「团购客留不住 / 把团购的人加微信 / 团购转私域 / 引进群」时，按下面做。

## 步骤
1. **理清转化链路**：团购客到店核销那一刻就是加微信的最佳时机——明确用什么由头加（领福利/进群专属优惠/约下次）。
2. **取转私域打法**：用 find_scenario 取团购转私域模板，把 key 传给 write_operation_content 的 prompt_key（operation.groupbuy_to_private），出一套「核销时加微信 → 当场给个进群理由 → 进群后怎么承接」的话术与动作。
3. **配进群引导**：再用 write_operation_content（prompt_key=operation.customer_group_guide）出「把客人引到对应客户群」的引导话术（不同客群进不同群）。
4. 拿不准群怎么分层维护时，用 look_up_knowledge 查「私域 / 客户分群」。

## 守则
- 加微信/进群的优惠面额、有效期一律用【请填写】占位，不编造。
- 加微信、拉群都靠当面/客人自愿同意，绝不自动群发、自动拉人、自动私信（封号红线）。
- 进群后靠真实福利和氛围留人，不靠刷屏轰炸。
