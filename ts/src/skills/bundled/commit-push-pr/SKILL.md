---
name: commit-push-pr
description: "把本次任务相关改动整理成提交、推送分支并创建或更新 PR。用户说提交并开 PR、commit push pr、把这个提了发 PR 时使用；不得夹带无关工作树改动。"
whenToUse: "用户说'提交并开 PR / commit push pr / 把这个提了发个 PR'时。"
allowedTools:
  - "Bash(git checkout -b:*)"
  - "Bash(git add:*)"
  - "Bash(git status:*)"
  - "Bash(git diff:*)"
  - "Bash(git branch:*)"
  - "Bash(git commit:*)"
  - "Bash(git push:*)"
  - "Bash(gh pr create:*)"
  - "Bash(gh pr edit:*)"
  - "Bash(gh pr view:*)"
argument-hint: "[可选:额外说明或要求]"
---

# 提交、推送并创建 PR

用户的额外要求(如有):$ARGUMENTS

## 先摸清现状

真跑这些命令拿全貌:
- `git status`
- `git diff HEAD`
- `git branch --show-current`
- 默认分支(如 `main`)到 HEAD 的全量 diff:`git diff main...HEAD`(把默认分支换成本仓库真实的默认分支)
- 是否已有 PR:`gh pr view --json number 2>/dev/null || true`

## Git 安全口径

- 绝不改 git config
- 绝不跑破坏性 / 不可逆命令(`push --force`、hard reset 等),除非用户明确要求;**绝不 force push 到 main/master**,用户要也先警告
- 绝不跳过 hooks,除非用户明确要求
- 别提交疑似含密钥的文件(`.env`、`credentials.json` 等)
- 只暂存本次任务相关文件，保留工作树中不相关的用户改动
- 不用带 `-i` 的交互式 git 命令

## 你的任务

分析**将进入这个 PR 的全部改动**(不只是最新一条提交,而是上面 `main...HEAD` diff 里的所有提交),然后:

1. 用 `git symbolic-ref refs/remotes/origin/HEAD` 确认默认分支；若当前在默认分支上，先建一个新分支（遵守仓库规定的分支前缀）。
2. 逐个暂存本次任务文件并用 `git diff --cached` 复核，再用 heredoc 语法建单条提交（默认不加署名）:

```
git commit -m "$(cat <<'EOF'
提交说明写这里。
EOF
)"
```

3. 把分支推到 origin。
4. 若该分支已有 PR(看上面的 `gh pr view` 输出),用 `gh pr edit` 更新标题和正文以反映当前 diff;否则用 `gh pr create` 建 PR,正文用 heredoc 语法。
   - PR 标题保持简短(70 字符内),细节放正文。

```
gh pr create --title "简短有信息量的标题" --body "$(cat <<'EOF'
## 概述
<1-3 条要点>

## 测试计划
[验证这个 PR 的 TODO 清单...]
EOF
)"
```

完成后把 PR 链接返回给用户看。

> 口径提醒:用户调用本 Skill 已明确要求提交、推送和创建/更新 PR，这些动作直接执行，不再因它们属于对外操作重复请求授权。授权不包含 force push、合并 PR 或改写默认分支；只有用户另行明确要求时才处理这些动作。
