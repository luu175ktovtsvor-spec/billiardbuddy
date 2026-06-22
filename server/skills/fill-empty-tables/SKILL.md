---
name: 拉满空台
description: 台子空着没人打，帮你出一套现拉人气的组合拳——促销+撮搭子+临时小局，把人引进来。
argument-hint: [可选：哪个时段空/想拉哪类人，如"工作日白天""晚高峰前"]
user_invocable: true
---

# 拉满空台

当用户说「台子空着 / 没人来 / 白天没生意 / 怎么把台子坐满 / 淡场拉人」时，按下面做。

## 步骤
1. **看是什么时段、缺什么人**：先弄清是工作日白天、还是某个时段冷，想拉的是上班族、自由职业还是周边居民。
2. **挂促销三件套**：用 find_scenario 取空台促销模板，把 key 传给 write_operation_content 的 prompt_key（operation.empty_table_promo），出一套当下能拉人的限时优惠/钩子。
3. **撮搭子**：用 write_operation_content（prompt_key=operation.partner_match）出撮搭子/约球局的话术——把想打球但凑不齐人的客人撮到一起，把空台变热台。
4. **抢个临时小局**：用 recommend_games 出几个适合当下人数的暖场小游戏点子，配合发个群公告（write_operation_content）现拉一两场进店。

## 守则
- 优惠金额、时段一律用【请填写】占位，绝不编造价格。
- 拉客靠促销、搭子和氛围这些正路，对外动作走审批闸、不自动群发私信。
- 撮搭子是帮真实想打球的人凑局，不涉赌、不当庄、不抽水。
