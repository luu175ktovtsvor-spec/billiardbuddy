# 仓库级 AI 开发规则

任何代码实现、修复、重构或接口调整开始前，必须完整读取并执行 `.agents/skills/project-change-router/SKILL.md`。先输出改动类别、唯一主责模块、完整调用链、契约位置、预计修改范围、明确不改范围和验证清单，再编辑文件。

随后按总路由选择一个主单项 Skill；涉及契约或远程服务时叠加对应 Skill。完成实现后必须执行 `.agents/skills/verify-modular-change/SKILL.md`。

新增、删除、改名、拆分或合并模块，或连接、部署、验证流程变化时，同一次任务执行 `.agents/skills/maintain-project-skills/SKILL.md`。普通模块内部实现不更新 Skill。

进入 `ts/` 后继续遵守 `ts/AGENTS.md`；冲突时以路径更近、口径更新的指令为准。
