---
name: clean-project-documents
description: Quickly identify project documentation that explicitly marks itself completed, superseded, rejected, or removable; verify live references and authoritative status, present deletion candidates for approval, and clean confirmed files plus navigation. Use when the user asks to tidy, archive, or remove finished project docs.
---

# 清理项目文档

用于快速收尾明确过时的文档；复杂、冲突或证据不足的候选转交 `audit-project-documents` 深审。

## 清理流程

1. 读取根 `AGENTS.md`、`CLAUDE.md` 和 `docs/README.md`，排除权威入口与仍有效的稳定边界文档；不得把文档当作当前实现事实源。
2. 运行 `node scripts/doc_freshness.mjs` 获取显式标记为可删、历史、已否决或久未核对的候选。
3. 对每个候选搜索现行文档、代码注释和配置引用；仍被引用、状态冲突或包含未完成待办时，不列为直接删除。
4. 在修改前向用户提交候选清单，写明路径、状态依据、引用结果和建议；等待明确确认。
5. 确认后用 `git rm` 删除已跟踪文件，同步 `docs/README.md` 与其它现行引用；同一主题一次清理完整。
6. 运行 `git diff --check` 和引用复查，报告删除内容、保留内容与 Git 恢复命令。

## 约束

- banner 只用于发现候选，不是删除证据。
- 不在 `docs` 下创建“归档”目录或会话流水文档；需要恢复时使用 Git 历史。
- 不确定时停止删除并切换到 `audit-project-documents`。
- 用户只要求清单或审计时，不执行删除。
