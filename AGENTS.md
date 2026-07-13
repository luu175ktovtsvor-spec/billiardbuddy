# 仓库级 AI 开发规则

## 开工

任何代码实现、修复、重构或接口调整开始前，完整读取并执行 `.agents/skills/project-change-router/SKILL.md`。先说明改动类别、唯一主责模块、完整调用链、契约位置、预计修改范围、明确不改范围和验证清单，再编辑文件。

按总路由选择一个主单项 Skill；契约、远程服务、安全或发布改动叠加对应 Skill。完成实现后执行 `.agents/skills/verify-modular-change/SKILL.md`。

## 工程边界

- 跨层契约统一放在 `ts/shared/contracts`，由 Zod Schema 推导类型并在边界解析。
- 功能修改与结构重构分开。非平凡改动使用短生命周期分支和小提交。
- 新增、删除、改名、拆分或合并模块，或改变连接、部署、验证流程时，同次执行 `.agents/skills/maintain-project-skills/SKILL.md`。
- 安全敏感改动执行 `audit-security-boundaries`；打包发布执行 `release-desktop-safely`。
- 声明完成、提交或发布前运行 `bash scripts/quality_gate.sh`，保持 `main` 可构建、可回滚。

## 文档

文档只陈述当前事实、当前规则和当前待办。更新时直接改成最新状态，不写迁移经过、废止过程、会话流水或人员归属；同一主题只保留一个现行真相源。

进入 `ts/` 后继续遵守 `ts/AGENTS.md`；冲突时以路径更近、内容更新的指令为准。
