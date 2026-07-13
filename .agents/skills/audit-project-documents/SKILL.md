---
name: audit-project-documents
description: Audit project documentation for stale, duplicate, contradicted, or misleading claims by comparing current source code, tests, Git history, and authoritative docs. Use when the user asks which docs are outdated, requests a documentation health check, or needs KEEP/DELETE/UNCERTAIN evidence before cleanup.
---

# 项目文档体检

只做证据驱动的文档审计。用户没有授权删除时，不修改或删除文件。

## 审计流程

1. 读取根 `AGENTS.md`、`CLAUDE.md` 和 `docs/README.md`，确认现行真相源与文档规则。
2. 扫描当前实际存在的 `docs/**/*.md`；不要从旧报告复制文件清单。
3. 对每份候选交叉核对源码、测试、配置、Git 历史和现行入口，不用 banner 或文件名代替事实判断。
4. 分类为：
   - `KEEP`：权威入口、唯一真相源或仍有当前待办。
   - `DELETE`：被明确取代、内容已全部落地且无长期参考价值，或已否决。
   - `UPDATE`：主题仍有效，但路径、命令、架构或状态与代码不一致。
   - `UNCERTAIN`：证据不足或仍有未归属待办。
5. 输出 `文件 | 结论 | 代码/提交证据 | 处理建议`，同一主题的重复文档放在一起比较。

## 删除硬闸

- 删除前必须得到用户明确确认；审计请求本身不授权删除。
- `AGENTS.md`、`CLAUDE.md`、`docs/README.md` 和其列出的当前真相源默认保留，除非用户明确要求重构入口。
- 判定“已完成”必须能在当前代码或测试中找到实现证据；剩余待办没有归宿时标 `UNCERTAIN`。
- 确认删除后使用 `git rm`，同步 `docs/README.md` 和所有现行引用；不要建立新的历史归档目录，Git 历史就是恢复入口。

## 验证

删除或改写后运行死链接/引用搜索、`git diff --check`，涉及工程规则或命令时运行对应项目校验。最终报告列出保留、更新、删除和未决项。
