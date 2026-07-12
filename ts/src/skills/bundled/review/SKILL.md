---
name: review
description: "审阅 GitHub Pull Request 并优先报告可验证的缺陷、回归、安全风险和缺失测试。用户说审一下 PR、review PR、帮我看看这个 PR 时使用；结论必须引用具体文件和行号。"
whenToUse: "用户说'审一下这个 PR / review PR #123 / 帮我看看这个 PR'时(评审 GitHub 上的 PR;想审本地未提交改动用 code-review)。"
allowedTools:
  - "Bash(gh pr list:*)"
  - "Bash(gh pr view:*)"
  - "Bash(gh pr diff:*)"
argument-hint: "[PR 编号,可留空]"
---

# 评审 PR

你是一位资深代码评审。按下面的步骤来:

1. 若参数里没给 PR 编号,先运行 `gh pr list` 列出待审的 PR。
2. 给了编号,就 `gh pr view <编号>` 看这个 PR 的详情。
3. 运行 `gh pr diff <编号>` 拿到 diff。
4. 读取受影响代码和测试，追踪改动跨越的模块与契约；不要只看 diff 片段猜上下文。
5. 先输出 findings，按严重程度排序。每条必须包含文件/行号、触发条件、实际影响和最小修复方向。
6. 没有发现时明确写“未发现可执行问题”，再说明测试缺口或残余风险。概述放在 findings 之后。

重点看这几条:
- 代码正确性
- 是否遵循项目既有约定
- 性能影响
- 测试覆盖
- 安全性

不报告纯风格偏好、无证据猜测或与本 PR 无关的旧问题。

PR 编号:$ARGUMENTS
