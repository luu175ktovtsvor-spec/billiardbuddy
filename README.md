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

## 生产网关容量约束

大陆网关由 [`gateway/deploy.sh`](./gateway/deploy.sh) 部署。新 `gw.env` 三项都缺失时，脚本会写入以下非敏感默认值；已有旧配置不会被单独插入新字段而破坏：

- `GW_MIMO_CONC=64`：一个 MiMo 账号在网关内允许的物理总在途数。
- `GW_MIMO_NATIVE_CONC=52`：原生 MiMo 文本与 Computer Use 图像请求的固定槽位。
- `GW_VISION_CONC=12`：DeepSeek→MiMo 图片理解桥接的固定槽位。

这不是可互相借用的软限流，而是 `52 + 12 = 64` 的硬预留：原生请求不会耗尽视觉槽，图片桥接也不会在 64 条原生请求之后继续等待。手工调整时必须使 `GW_MIMO_NATIVE_CONC + GW_VISION_CONC = GW_MIMO_CONC`；网关会拒绝未分配或超配的配置。视觉桥接仍受 24 个短队列和 3 秒等待限制，不能据此承诺 100 人多窗口图片请求全部无等待。

部署脚本会把 `gateway/validate-mimo-capacity-env.sh` 与网关源码一并复制到大陆机，并在重启 `qfgw` 前校验这三个非敏感字段；手工上传时也必须带上该脚本。旧环境只设置 `GW_MIMO_CONC` 时，会按网关同一规则自动推导分区；格式错误或不相加的显式配置会在服务重启前失败。
