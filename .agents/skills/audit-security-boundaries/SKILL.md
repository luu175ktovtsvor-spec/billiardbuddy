---
name: audit-security-boundaries
description: Audit security-sensitive changes across local files, shell commands, permissions, Electron IPC, credentials, model gateways, remote services, logs, telemetry, plugins, hooks, MCP, downloads, and updates. Use whenever a change crosses a trust boundary, handles secrets or user data, expands tool authority, performs external actions, or alters sandbox and approval behavior.
---

# 安全边界审计

从资产、攻击入口、信任边界和失败模式出发审查，不用“只在本机”或“只有 AI 会调用”作为安全理由。

## 必读边界

1. 本地文件和命令：路径归一化、工作区逃逸、符号链接、危险命令、备份和审批档。
2. Electron：renderer 不得获得裸 `ipcRenderer`、Node 或任意通道；main 校验所有不可信 payload。loopback sidecar 仍是网络控制面，除最小健康检查外必须有启动级身份凭据，WebSocket 还要限制 Origin，不能把“只监听本机”当成认证。
3. 凭据：真 provider key 只留服务器；本机敏感值加密落盘；日志、错误、遥测和截图不得泄密。
4. 网络：鉴权、SSRF、超时、重试、配额、幂等、响应大小和旧客户端兼容。
5. 扩展：workspace Skill、hook、plugin、MCP 和下载资产遵守信任门、校验和与来源约束。
6. 产品语义：只审计当前代码真实存在的信任边界，不臆造尚未实现的用户流程、限制类别或交互闸。

## 执行流程

1. 列出被保护资产、所有输入、执行身份、数据去向和最坏副作用。
2. 追踪输入从 renderer/模型/远程请求到最终文件、命令、网络或持久化操作。
3. 检查默认拒绝、最小权限、失败关闭、脱敏和可回滚；不得用前端校验替代后端校验。客户端只能选择后端策略允许的权限档，`full_disk_access` 等派生能力不得由传输字段单独提升。
4. 覆盖越界路径、畸形 payload、重放、并发、超时、断网、旧格式和敏感输出测试。
5. 运行 `bun scripts/quality/check-secrets.ts` 与受影响安全测试；扫描器会覆盖已跟踪及未跟踪且未被忽略的文件。需要远程验证时使用假 upstream 优先。

安全审计解决技术边界问题，不自动转化为新的产品文案、确认弹窗或用户使用限制。

## 完成条件

报告信任边界、攻击面、现有控制、实际测试、仍接受的风险和回滚方式。发现高风险缺口时先修复或明确阻止交付，不以文档提示代替代码控制。
