# Repository-level Agent Guide

Reply in the same language as the user.

This repository is built for agent-assisted development. Keep the root `AGENTS.md` limited to hot-path rules that every task needs to know.

## Working Principles

- 当前产品边界、模块关系与运行架构见 `README.md` 和 `docs/重构/`。本仓库根目录的 `AGENTS.md` 只约束本仓库开发；BilliardBuddy 面向用户项目的指令语义与加载结果以锁定的 Codex Rust 运行时为目标。
- Think from first principles. Start from the user's real intent, the expected product result, current code facts, and verification results.
- If the goal or boundary is unclear, clarify it with the user before implementation.
- Treat the user's current task and designated construction document as the source of truth for product direction. Treat live code and tests as the source of truth for the current implementation.
- Before making code changes, read the relevant code, current constraints, and the nearest applicable `AGENTS.md`. Do not infer the implementation from historical names, old files, or previous architecture alone.
- Keep changes focused. Do not slip in unrelated refactors or cleanup.
- Preserve unrelated work already present in the worktree.
- Complete the task in the current agent by default. Do not start subagents, parallel agents, workers, or further delegation unless the user explicitly authorizes it.
- Do not add co-author attribution to commits. Do not identify Agent, Codex, or AI as the author in commit messages, pull request descriptions, or explanatory text.

## Architecture Refactors

- 改动聊天 Harness、图片/视频工作台、模型请求、网关或前端时，从当前真实不足和用户结果出发，自主决定参考、复用、改造、重写或删除。外部源码与本地参考用于提高判断质量，不是实施审批、固定流程或架构门禁；移植内容要成为 BilliardBuddy 自己的正式路径，不把参考 bundle 当作产品运行时。
- 本轮允许按重构合同整体替换 Gateway、Relay、服务、配置和两台服务器；当前无人使用，不把备份、回滚、最小化部署或先行本地验证当作改造前置条件。实施前只须盘点服务器上的真实文件、进程、端口、路由和凭据引用；实施完成后以实际部署状态更新服务器运行文档。

## General Coding Rules

- Follow the repository's existing architecture boundaries, naming, and local patterns unless the task explicitly changes them.
- Avoid creating unnecessary test files. Prefer adding cases to the corresponding existing test file when there is a clear home for them.
- If a user-requested change makes an old test expectation obsolete, update the test by default. Change the implementation only when the implementation is actually wrong.
- Do not sacrifice code quality merely for compatibility with an external implementation unless the user explicitly requires that compatibility.
- Use neutral placeholders in public text and test data, such as `example.com`, `example.test`, and `YOUR_API_KEY`. Do not introduce real credentials or user-specific data.

## Implementation Standard

- Judge an implementation by functional equivalence and engineering-quality equivalence, not by whether it reproduces an earlier implementation.
- Product documents define intent, direction, boundaries, and expected results. Unless a specific implementation is explicitly frozen, classes, interfaces, directories, names, and internal mechanisms may change.
- Prefer the smallest implementation that delivers the same user capability with the same stability and engineering quality.
- "Minimum code" means the fewest authoritative state sources, runtimes, execution paths, dependencies, and duplicated concepts. It does not mean omitting persistence, migration, security, recovery, or verification.
- Reuse mature, stable existing capabilities.


## Review and Verification

- Distinguish a missing capability from an equivalent implementation with a different internal design.
- Do not report a difference in code shape as a defect. Identify the missing user result, broken boundary, unstable behavior, or absent evidence.
- Verify the production call path and its failure behavior. Source presence, UI presence, type checks, or passing isolated tests are not sufficient on their own.
- Run the checks and tests relevant to the change, inspect the final diff, and report completed work, equivalent behavior, unverified claims, and real gaps separately.

## Workflow Requirements

- Prefer `rg` and `rg --files` for searching text and files.
- 任务中启动的临时进程、测试服务、终端辅助进程和打包进程，用完后必须主动停止并再次检查，避免持续占用 CPU、内存或导致设备发热；只有产品运行或后续验证明确仍需要的进程才可保留。
- Write commit messages in clear, plain Chinese that state the concrete change. Do not use vague, generic, or AI-style descriptions.
- When creating a pull request, use a Conventional Commit type prefix and write the specific title in Chinese, for example `fix: 修复会话恢复状态丢失`.
- If a pull request template exists, fill it in completely. Do not leave placeholders or use a generic summary.
- Write pull request descriptions in clear, plain Chinese. Describe the actual change, its boundary, relevant edge cases, and how it fits the repository; do not use vague AI-generated wording.
- Do not commit throwaway scratch files, agent working notes, handoff summaries, or disposable prototypes. Before committing or opening a pull request, inspect `git status` and `git diff --staged --stat` and remove unrelated temporary files.

## Where to Update Instructions

- Treat this file as a maintained hot-path memory, not a frozen policy. Update it whenever current evidence or the user's direction changes the best way to work; remove stale rules that obstruct the intended product result.
- Keep only durable guidance that helps a future compressed session recover the product direction, working boundaries, verification standard, and operational safety quickly. Do not encode temporary implementation plans, mandatory reference rituals, or architecture choices that should remain open to judgment.
- Keep rules that affect almost every task in the root `AGENTS.md`.
- Put task-specific product requirements and implementation details in the relevant construction document, not in this file.
- Keep instruction updates focused and supported by the user's stated intent.
