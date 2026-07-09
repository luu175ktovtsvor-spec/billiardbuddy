---
name: pr-comments
description: "把一个 GitHub Pull Request 上的评论(含 PR 级评论和逐行代码评审)拉下来、整理好展示。"
whenToUse: "用户说'看看这个 PR 的评论 / 拉一下 PR 评论 / PR 上别人说了啥'时。"
allowedTools:
  - "Bash(gh pr view:*)"
  - "Bash(gh api:*)"
argument-hint: "[可选:PR 编号]"
---

# 拉取并展示 PR 评论

你的任务是把一个 GitHub Pull Request 上的评论抓下来、整理好展示。按步骤:

1. 用 `gh pr view --json number,headRepository` 拿到 PR 编号和仓库信息。
2. 用 `gh api /repos/{owner}/{repo}/issues/{number}/comments` 拿 PR 级评论。
3. 用 `gh api /repos/{owner}/{repo}/pulls/{number}/comments` 拿逐行代码评审评论。重点看 `body`、`diff_hunk`、`path`、`line` 等字段。若评论引用了某段代码,可用 `gh api /repos/{owner}/{repo}/contents/{path}?ref={branch} | jq .content -r | base64 -d` 把那段代码取出来。
4. 解析并排版所有评论,格式如下:

```
## Comments

[每条评论线程:]
- @作者 file.ts#行号:
  ```diff
  [API 返回里的 diff_hunk]
  ```
  > 引用的评论正文

  [回复缩进展示]
```

没有评论就返回「未找到评论」。

要点:
1. 只展示实际评论,别加解释性文字
2. PR 级评论和代码评审评论都要含
3. 保留评论回复的线程 / 嵌套关系
4. 代码评审评论要带上文件和行号上下文
5. 用 `jq` 解析 GitHub API 返回的 JSON

额外输入(如有):$ARGUMENTS
