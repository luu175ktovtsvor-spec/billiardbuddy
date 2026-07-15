---
name: skills
user-invocable: false
description: 列出可用技能，并建议什么时候调用哪个技能
whenToUse: 用户想看技能、安装技能、知道有哪些专项能力
allowedTools: [list_skills, read_skill]
---
# 技能列表

调用 `list_skills`，把技能按用途分组说明。

规则：
- 只在某个技能明显相关时才调用 `read_skill` 展开正文。
- 对台球门店技能，用老板能理解的业务词解释，不要讲内部文件结构。
- 如果用户想沉淀新流程，建议用 `create_skill`，但不要擅自创建，除非用户明确要求。
