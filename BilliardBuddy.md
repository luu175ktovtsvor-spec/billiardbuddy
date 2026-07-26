# BilliardBuddy 项目指令

这是 BilliardBuddy 的项目指令文件。在用户项目中，它与 `AGENTS.md` 属于同一指令层，作用等同于 Claude 的 `CLAUDE.md` 与 Codex 的 `AGENTS.md`：Harness 从仓库根目录到当前工作目录逐层收集并冻结为任务上下文，路径更深、后加载的规则优先。目录化入口为 `.BilliardBuddy/BilliardBuddy.md`、`.BilliardBuddy/rules/*.md` 与 `.BilliardBuddy/BilliardBuddy.local.md`。本仓库根目录的 `AGENTS.md` 仅是本仓库开发智能体的约束，不能与用户项目中的同名文件混淆。

本仓库的产品重构目标、架构边界和验收标准见 [BilliardBuddy-重构合同.md](./BilliardBuddy-重构合同.md)。执行任何架构或前端重构前，先阅读其中的源码研究方法与对应工作流合同。

本文件只放本项目的长期 Agent 指令；不要把临时任务、密钥、供应商配置、运行日志或大篇施工记录写入这里。
