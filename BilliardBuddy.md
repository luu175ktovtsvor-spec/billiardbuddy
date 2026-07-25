# BilliardBuddy 项目指令

这是 BilliardBuddy 原生识别的项目指令文件，语义等同 Claude Code 的 `CLAUDE.md`。BilliardBuddy 同时兼容 `AGENTS.md`、`CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md` 与 `CLAUDE.local.md`；它从仓库根目录到当前工作目录逐层收集，路径更深的文件在冲突时优先。同一目录中，`BilliardBuddy.md` 在 `AGENTS.md` 之后加载，因此只覆盖与它冲突的规则。

本仓库的产品重构目标、架构边界和验收标准见 [BilliardBuddy-重构合同.md](./BilliardBuddy-重构合同.md)。执行任何架构或前端重构前，先阅读其中的源码研究方法与对应工作流合同。

本文件只放本项目的长期 Agent 指令；不要把临时任务、密钥、供应商配置、运行日志或大篇施工记录写入这里。
