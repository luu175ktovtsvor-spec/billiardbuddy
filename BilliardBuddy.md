# BilliardBuddy 项目指令

这是 BilliardBuddy 的项目指令文件，与 `AGENTS.md` 属于同一指令层：用户可任选一个文件为项目提供长期规则，也可同时使用。BilliardBuddy 会合并二者；同一目录中 `BilliardBuddy.md` 在 `AGENTS.md` 之后加载，因此只覆盖冲突规则。它还兼容 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md` 与 `CLAUDE.local.md`，并从仓库根目录到当前工作目录逐层收集，路径更深的文件优先。

本仓库的产品重构目标、架构边界和验收标准见 [BilliardBuddy-重构合同.md](./BilliardBuddy-重构合同.md)。执行任何架构或前端重构前，先阅读其中的源码研究方法与对应工作流合同。

本文件只放本项目的长期 Agent 指令；不要把临时任务、密钥、供应商配置、运行日志或大篇施工记录写入这里。
