# Repository-level Agent Guide

Reply in the same language as the user.

This repository is built for agent-assisted development. Keep the root `AGENTS.md` limited to hot-path rules that every task needs to know.

## Working Principles

- `BilliardBuddy-重构合同.md` 是产品重构的唯一裁决。本仓库根目录的 `AGENTS.md` 只约束本仓库的开发；BilliardBuddy 面向用户项目的指令语义与加载规则以重构合同为准。
- Think from first principles. Start from the user's real intent, the expected product result, current code facts, and verification results.
- If the goal or boundary is unclear, clarify it with the user before implementation.
- Treat the user's current task and designated construction document as the source of truth for product direction. Treat live code and tests as the source of truth for the current implementation.
- Before making code changes, read the relevant code, current constraints, and the nearest applicable `AGENTS.md`. Do not infer the implementation from historical names, old files, or previous architecture alone.
- Keep changes focused. Do not slip in unrelated refactors or cleanup.
- Preserve unrelated work already present in the worktree.
- Complete the task in the current agent by default. Do not start subagents, parallel agents, workers, or further delegation unless the user explicitly authorizes it.
- Do not add co-author attribution to commits. Do not identify Agent, Codex, or AI as the author in commit messages, pull request descriptions, or explanatory text.

## Architecture Refactors

- 改动聊天 Harness、图片/视频工作台、模型请求、网关或前端前，先执行重构合同第 3.0 节的“参考—改动”证据链；本地 Codex 前端 bundle 只能按其 README 和证据等级推理，不能冒充原始或私有源码。
- 本轮允许按重构合同调整 Gateway、Relay 和两台服务器；仍须备份、先本地验证、最小化部署、健康检查并记录版本与配置摘要。

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
- Write commit messages in clear, plain Chinese that state the concrete change. Do not use vague, generic, or AI-style descriptions.
- When creating a pull request, use a Conventional Commit type prefix and write the specific title in Chinese, for example `fix: 修复会话恢复状态丢失`.
- If a pull request template exists, fill it in completely. Do not leave placeholders or use a generic summary.
- Write pull request descriptions in clear, plain Chinese. Describe the actual change, its boundary, relevant edge cases, and how it fits the repository; do not use vague AI-generated wording.
- Do not commit throwaway scratch files, agent working notes, handoff summaries, or disposable prototypes. Before committing or opening a pull request, inspect `git status` and `git diff --staged --stat` and remove unrelated temporary files.

## Where to Update Instructions

- Keep rules that affect almost every task in the root `AGENTS.md`.
- Put task-specific product requirements and implementation details in the relevant construction document, not in this file.
- Keep instruction updates focused and supported by the user's stated intent.
