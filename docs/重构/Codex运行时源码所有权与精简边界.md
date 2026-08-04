# Codex 运行时源码、更新与精简边界

## 源码所有权

`third_party/codex-engine` 是锁定的 OpenAI Codex 源码快照；当前 revision、许可与产品补丁清单由 `ts/shared/product/codexEngineContract.ts` 固定。BilliardBuddy 从同一份已应用审核补丁的源码以 Cargo 构建 App Server 与 Code Mode Host，并按该 revision 自带的官方打包清单取得目标平台 `rg`；三项运行资源、LICENSE、NOTICE、revision 和独立哈希清单一起进入安装包。

因此它既不是运行时下载的黑盒，也不是被复制进 TypeScript 的“参考实现”。运行时进程仍是独立的 App Server：这使 Rust 的崩溃、会话状态、工具执行和 JSON-RPC 流与 Electron 壳隔离。

## 仅有的产品补丁

产品只维护两份安全补丁：`0001-sanitize-hook-environment.patch` 与 `0002-sanitize-non-tool-child-environment.patch`。它们会从 Hook 和非工具子进程的环境中剥离名称包含 `KEY`、`SECRET` 或 `TOKEN` 的变量，避免用户控制的命令读取 Rust 子进程的 loopback 模型 capability。旧 notify 路径经源码审计未进入产品私有 `CODEX_HOME` 的可控配置、IPC 或迁移面，因此不保留第三份补丁。

这些补丁不改动 Agent Loop、Thread、Turn、上下文压缩、工具调度、沙箱、审批、MCP、Skill 或恢复。若上游以原生方式解决同一安全问题，应删除产品补丁而非长期分叉核心。

## 不增加的层

不新建 `native/billiardbuddy-agent`、FFI 绑定、第二个 Rust HTTP Agent 服务、TypeScript Harness、外层 Thread 数据库或 Gateway Agent Worker。它们都会制造第二个状态来源，且不能增加 Codex 原生能力。

本机媒体 Sidecar 只管理 BilliardBuddy 的图片、视频、设置、视频流程内部使用的音频转写，以及迁移期仍由产品使用的既有语音兼容数据；不得新建独立语音 Agent，不得启动或配置 App Server，也不得保存用户模型 Key 或 Agent Thread。

## 升级流程

1. 在独立提交中更新上游 revision；阅读上游差异和 Rust App Server 协议变化。
2. 重新应用最小安全补丁；若无法无冲突应用，先重新审计安全边界。
3. 运行 `bun run verify:codex-engine-source`、Electron 类型/构建检查与两个平台的 App Server、Code Mode Host、官方 `rg` 和本地插件构建。
4. 审计 JSON-RPC 方法：每个上游方法要么由产品正式透传，要么明确不暴露并说明原因。
5. 在真实桌面旅程中验证 Thread、工具审批、恢复和模型路由后，才更新发行清单。
