---
name: commit
user-invocable: false
description: "创建一次范围清晰的 Git 提交。用户说提交一下、commit、把改动提交了时使用；检查全部差异但只暂存本次任务相关文件，不夹带用户的无关改动。"
whenToUse: "用户说'提交一下 / commit / 把改动提交了'时。"
allowedTools:
  - "Bash(git add:*)"
  - "Bash(git status:*)"
  - "Bash(git diff:*)"
  - "Bash(git log:*)"
  - "Bash(git branch:*)"
  - "Bash(git commit:*)"
argument-hint: "[可选:提交说明或额外要求]"
---

# 创建规范提交

用户的额外要求(如有):$ARGUMENTS

## 先摸清现状

依次真跑这些命令了解改动(用工具跑,别凭记忆猜):
- `git status`
- `git diff HEAD`(已暂存 + 未暂存的全部改动)
- `git branch --show-current`
- `git log --oneline -10`(学本仓库的提交信息风格)

## Git 安全口径

- 绝不改 git config
- 绝不跳过 hooks(`--no-verify`、`--no-gpg-sign` 等),除非用户明确要求
- 只建「新」提交,绝不 `git commit --amend`,除非用户明确要求
- 别提交疑似含密钥的文件(`.env`、`credentials.json` 等);用户执意要提就先当面警告
- 没有可提交的改动就别建空提交
- 只暂存本次任务相关文件；工作树里不相关的用户改动原样保留
- 不用带 `-i` 的交互式 git 命令(`git rebase -i` / `git add -i`),它们要交互输入,这里不支持

## 你的任务

基于上面的改动,创建单条提交:

1. 分析全部改动,起草提交说明:
   - 跟随本仓库既有风格(看上面的近期提交)
   - 判断改动性质(新增功能 / 增强 / 修复 / 重构 / 测试 / 文档…):"add"=全新功能,"update"=对已有功能的增强,"fix"=修 bug
   - 说清「为什么」而非「改了啥」,1-2 句、简洁

2. 明确列出本次提交文件，逐个暂存；用 `git diff --cached` 复核后再用 heredoc 语法建提交:

```
git commit -m "$(cat <<'EOF'
提交说明写这里。
EOF
)"
```

一条消息里把暂存 + 提交一起做完,别再做别的、别发多余文字。

> 口径提醒:本 Skill 的授权边界只到“创建本地提交”，不擅自扩大为 `git push` 或创建 PR。用户若另行明确要求推送或建 PR，该请求本身就是授权，直接执行而不再重复询问。默认不额外加任何署名，除非用户要求。
