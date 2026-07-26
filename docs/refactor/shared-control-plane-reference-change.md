# 共享控制面参考—改动证据

## 合同边界

- 唯一裁决：`BilliardBuddy-重构合同.md` 第 3.3、3.4、3.5、4.2、4.5 节。
- 前端参考门槛沿用本轮已完成的 `codex-frontend-reference/raw`、`reverse-readable`、`host-bridge` 阅读证据；本次只把已确认的项目/线程/运行/结果秩序用于“已安排”和任务终端，没有把参考 bundle 接入运行时。
- 当前代码事实来自本轮直接检查的 `CronService → CronScheduler → ProductTaskService → AgentWorkerSupervisor → ProductResourceScheduler`、Electron `node-pty` 终端链、Gateway/Relay 路由与测试。

## 计划任务改动

- Schedule 定义持久化标准五段表达式、IANA 时区、missed-run policy、固定无人值守权限和上下文模式。
- 计划触发使用 `schedule id + occurrence instant` 的确定性身份；同一 occurrence 重放同一 receipt，不重复启动。
- 默认每个 occurrence 建立独立 ProductTask/lineage；只有用户明确选择 `related_task` 才进入所选任务的现有 lineage，并要求工作目录一致。
- UI 显示时区、下一次时间、上次时间、最近结果、运行记录和上下文模式；运行中可取消。
- DST 按真实时区 instant 计算：不存在的本地分钟不触发；重复本地分钟以不同 UTC occurrence 区分。
- Cron 只负责 occurrence 和运行历史，实际执行仍走正常 ProductTask Turn 与 `schedule.dispatch + agent.worker` 资源 claim。

## 用户终端

- 用户终端继续使用 Electron 主进程拥有的独立 `node-pty`，绑定窗口、Task 和工作目录。
- 终端输入输出不经过 Agent worker，不回放 Agent Bash，也不读取 TaskRun 工具授权。
- IPC 继续执行 sender、payload、session owner 与 task owner 校验；PTY 环境剥离 Gateway、安装身份和 Core 私有凭据。

## Gateway / Relay

- Provider registry 仍是唯一模型与能力来源。
- Gateway 保持五条正式泳道：DeepSeek `TextReasoning`、MiMo `VisualEvidence`、MiMo `MediaReasoning`、Fun-ASR `SpeechTranscription`、转 Relay 的 `ImageGeneration`。
- `VisualEvidence` 与 `MediaReasoning` 使用同一 MiMo 账号的独立路由、operation usage receipt、队列和硬预留容量。
- Relay 只保存图片 operation、输入/结果 blob、provider receipt 与 ack；取消只在尚未提交上游时成功，未知结果不自动重提。
- 已删除无生产消费者的 `gateway/qwenChat.ts` 及对应旧自测；只保留不产生运行路由的旧值迁移 reader。

## 验证证据

- Gateway registry、五泳道路由、视觉桥接、原生搜索、Relay 代理：67 项定向测试通过。
- 计划任务服务、时区/DST、occurrence、ProductTask hand-off、独立上下文：46 项定向测试通过。
- 计划任务桌面页：4 项定向测试通过。
- 授权 requested/resolved 现在同时写入 durable dispatch receipt 与同一 approval Item 的游标事件。

## 尚未由本文件证明

- 两台服务器的最终部署状态、真实端口和真实环境变量以实际部署后重写的运行文档为准。
- 定向测试不等于完整门禁、安装包审计或真实上游容量证明。
