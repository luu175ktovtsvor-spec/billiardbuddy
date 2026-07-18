# BilliardBuddy

BilliardBuddy 是面向球房经营者的桌面 Agent。当前能力和完成度以源码与实际运行结果为准。

当前重构方向和执行边界见 [BilliardBuddy 总迁移与清理任务](./BilliardBuddy-总迁移与清理任务.md)。

## 代码结构

| 路径 | 职责 |
|---|---|
| `ts/src` | Agent 内核、桌面本地服务、工具与扩展机制 |
| `ts/desktop` | React renderer、Electron 桌面宿主和本地 sidecar 打包 |
| `ts/shared` | 桌面与本地服务共享契约 |
| `gateway` | 模型、视觉和 Fun-ASR 网关 |
| `relay` | 图片生成与编辑异步中转 |

## 本地开发

```bash
cd ts
bun install
cd desktop
bun install
bun run electron:dev
```
