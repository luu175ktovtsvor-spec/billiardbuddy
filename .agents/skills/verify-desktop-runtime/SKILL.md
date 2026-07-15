---
name: verify-desktop-runtime
description: Verify the real Electron, React, preload IPC, and Bun sidecar user experience with Computer Use, natural-language tasks, screenshots, runtime logs, API evidence, and source-level diagnosis. Use for desktop UI changes, startup regressions, cross-layer bugs, and release acceptance without a scripted browser harness.
---

# 桌面真机验证

桌面验收使用当前本地 `main` 源码构建出的真实 Electron 应用。不要用 Playwright 或 DOM 脚本代替用户体验，也不要把自动化用例通过写成“100% 真机覆盖”。

## 验证原则

- 用普通用户会说的自然语言交代目标，例如“帮我看看这个文件夹里有什么”或“把这段视频剪得适合发朋友圈”。不要在主要产品验收里指定工具名、命令参数或内部实现。
- Computer Use 只负责真实操作和观察；问题归因必须回到源码、状态流、共享契约、运行日志、接口响应和落盘结果。
- 机械边界仍由单元、契约、集成和后端 E2E 负责。真机验收关注是否好用、反馈是否及时、流程是否自然以及产物是否真实。
- 当前任务没有 Computer Use 能力时，明确报告未完成真机验收；可以由人工操作补证据，但不能回退到浏览器脚本并宣称等价。

## 启动

```bash
cd ts
bun run ui:build
bun run desktop:build
bun run desktop:dev
```

确认操作对象是开发版 `cn.zzyppz.billiards.desktop.dev`，且页面来自当前仓库的 `desktop/renderer-dist/index.html`。不要连接已安装的旧版本。

## 默认场景

1. 项目与会话：原生文件夹选择器、新项目、多会话、重启恢复、不同项目目录隔离。
2. 自然语言 Agent：读取文件、整理资料、运行必要工具、联网搜索、停止长任务；观察首反馈、流式输出、工具活动、错误和最终结论是否一致。
3. 权限：以自然任务验证默认和接受修改；完全访问先在设置页显式允许，再在会话中二次确认，关闭设置后已有会话应回落默认。专门的强制工具输入只作为权限机制补充检查，不代表产品体验。
4. 右侧工作区：文件树、切项目竞态、文本、图片、视频、PDF、表格和文档预览，以及关闭、重开和刷新。
5. 产品页：生图、视频、已安排、插件/Skill/MCP 和设置；验证空态、加载、失败、取消、重试、恢复和真实产物。
6. 窗口体验：常用宽度、最小窗口、面板开合、原生对话框、键盘和焦点，确认文本不重叠且主要操作可见。

只覆盖与本次改动和风险相关的场景。历史截图不能替代修复后的复测。

## 证据

- 每个关键状态保存截图，并记录应用、项目目录、会话和输入原文。
- 对长任务记录从发送到首反馈、首工具、完成或停止的时间。
- 对文件和媒体产物核对真实路径、格式和可打开性；不要只相信模型回复。
- 对错误记录前端可见结果、Electron/sidecar 日志、相关接口和落盘状态。
- 涉及桌面连接边界时，额外验证无令牌 HTTP/WS 被拒、主 renderer 正常启动和外链不会替换主窗口；不得在截图或日志中记录控制令牌。
- 视觉疑点先作为线索；源码证明后再修改。

## 收尾

报告自然任务、实际观察、截图位置、源码根因、已修问题、未验证项和剩余风险。桌面发布前还要在目标平台干净环境安装并重复关键路径。
