---
name: commit
description: 看暂存区改动，按规范写一条简洁的 git 提交信息并提交（执行前会弹确认）
argument-hint: [可选：额外说明]
---

帮我提交当前**已暂存**的改动：

1. 先用 run_command 跑 `git status --short` 和 `git diff --staged --stat`，看清这次改了什么（没暂存的先别动）。
2. 写一条规范的提交信息：首行 `类型(范围): 一句话摘要`（类型如 feat/fix/docs/refactor/chore），必要时空一行再加 2-3 条要点。补充说明：$ARGUMENTS
3. 用 run_command 执行 `git commit -m "..."`（这步会弹确认，等点头再跑）。

不要 `git add`（只提交已暂存的）；不要 `git push`。
