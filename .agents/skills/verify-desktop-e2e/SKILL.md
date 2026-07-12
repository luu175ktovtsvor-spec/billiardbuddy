---
name: verify-desktop-e2e
description: Verify the Electron, React, preload IPC, and Bun sidecar user path with Playwright Test, isolated app state, web-first assertions, API evidence, screenshots, traces, and process logs. Use for desktop UI changes, IPC changes, startup or packaging regressions, cross-layer bugs, and pre-release smoke verification.
---

# 桌面端到端验证

使用 Playwright Test 驱动当前 worktree 构建出的 Electron，不连接已安装旧版本。桌面 E2E 只覆盖必须经过真实窗口和主进程才能证明的关键路径；Agent 细节交给更快的 `verify-backend-e2e`。

## 为什么采用这套方案

- Electron 官方支持 Playwright；`_electron.launch` 可操作 Chromium renderer，并通过 `electronApp.evaluate` 检查 main 进程。
- `@playwright/test` 提供隔离 fixture、自动等待断言、单测超时、失败重试、trace、截图和标准报告，优于自写串行脚本。
- Playwright 的 Electron 支持仍标为 experimental，因此固定依赖版本，升级时必须重跑本 Skill。

## 默认覆盖

1. 首次启动显示引导，跳过后进入真实对话界面。
2. React、preload `DesktopHost`、动态 sidecar 地址和 `/health` 接通。
3. 斜杠面板消费 sidecar 的真实命令/Skill 列表。
4. 筛选、Esc、重开、Enter 选择等关键键盘语义。
5. Electron 最小窗口 `720x480` 下输入区可用且无页面级横向溢出。

每个测试独立启动 Electron，使用临时 userData、state、workspace 和 library；禁用资产自动下载、调度和遥测。失败时保留 trace，所有测试附最终截图和 Electron/sidecar 日志。

## 运行

```bash
cd ts
bun run e2e:desktop
```

产出位于 `ts/test-results/desktop-e2e/`：`results.json`、HTML `report/` 和失败 `artifacts/`。

Linux CI 使用 `xvfb-run` 提供显示环境；macOS/Windows 直接运行。不要为了 E2E 安装浏览器，Electron 自带 Chromium。

## 新增测试

在 `ts/e2e/desktop/desktop.e2e.ts` 以一个用户可完成的行为为一个测试。优先使用 role、可见文字和稳定 `data-testid`；使用 `expect` 的自动等待，不写固定 sleep。用 UI 断言证明用户行为，用 sidecar API/日志证明后端事实；不要通过 UI 重测所有领域分支。

涉及真模型、生图、远程网关或付费调用时，另建显式 live smoke，默认不进 CI。跨平台截图会受字体和系统渲染影响，默认作为人工证据；只有建立各平台独立基线后才做像素快照硬闸。
