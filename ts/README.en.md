# BilliardBuddy Agent Runtime

This directory contains the BilliardBuddy coding-agent core, local server, CLI, shared contracts, and Electron desktop application.

## Core capabilities

- Model-driven sessions, tool loops, subagents, background tasks, and worktrees.
- File, shell, editing, and search tools, plus the wired manual Browser/Preview. Agent browser automation is currently only a feature-gated stub; Computer Use still depends on Python, OS permissions, and packaged-app validation.
- Skills, Plugins, MCP, Hooks, permissions, plan mode, and context management.
- REST, WebSocket, Provider Proxy, workspace, diff, and terminal support.
- CLI and Electron GUI entry points.

Billiards-specific behavior belongs to the product layer, progressively loaded knowledge resources, Skills, and dedicated workbenches. The bundled media, recruiting, and five venue-operations Skills describe business goals and completion evidence while the Agent chooses the available connector, browser, script, code, or workbench. They do not replace or fork the agent loop. See `BilliardBuddy-当前重构任务.md` in the repository root for the current product scope and implementation status.

## Run from source

```bash
bun install
bun run start
```

Renderer development:

```bash
cd desktop
bun install
bun run dev
```

Electron development:

```bash
cd desktop
bun run electron:dev
```

## Focused checks

```bash
bun run check:server
cd desktop && bun run test -- --run
cd desktop && bun run lint
```

Use the current documents under the repository root `docs/` directory for model, credential, network, and deployment boundaries.
