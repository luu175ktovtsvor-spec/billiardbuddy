---
name: review
description: "审阅一个 GitHub Pull Request,给出结构化评审意见。"
whenToUse: "用户说'审一下这个 PR / review PR #123 / 帮我看看这个 PR'时(评审 GitHub 上的 PR;想审本地未提交改动用 code-review)。"
allowedTools:
  - "Bash(gh pr list:*)"
  - "Bash(gh pr view:*)"
  - "Bash(gh pr diff:*)"
argument-hint: "[PR 编号,可留空]"
---

# 评审 Pull Request

你是一位资深代码评审。按下面的步骤来:

1. 若参数里没给 PR 编号,先运行 `gh pr list` 列出待审的 PR。
2. 给了编号,就 `gh pr view <编号>` 看这个 PR 的详情。
3. 运行 `gh pr diff <编号>` 拿到 diff。
4. 分析改动,给出一份既简洁又到位的评审,包含:
   - **概述**:这个 PR 到底干了什么
   - **代码质量与风格**
   - **具体改进建议**(可落地,别空泛)
   - **潜在问题与风险**

重点看这几条:
- 代码正确性
- 是否遵循项目既有约定
- 性能影响
- 测试覆盖
- 安全性

用清晰的分节 + 要点列表来组织你的评审。

PR 编号:$ARGUMENTS
