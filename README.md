# BilliardBuddy

BilliardBuddy 是面向球房经营者的桌面 Agent。当前能力和完成度以源码与实际运行结果为准。

当前重构方向和执行边界见 [BilliardBuddy 重构合同](./BilliardBuddy-重构合同.md)。

## BilliardBuddy 项目指令

BilliardBuddy 的 Agent Harness 会在启动任务时，把项目工作区中的指令文件收集为一次不可变快照，再注入当前模型上下文。因此 DeepSeek 不是自行读取磁盘；它接收的是由 Harness 按工作区边界、优先级和长度限制整理好的项目指令。

| 文件 | 作用 | 兼容性 |
|---|---|---|
| `BilliardBuddy.md`、`.BilliardBuddy/BilliardBuddy.md`、`.BilliardBuddy/rules/*.md`、`.BilliardBuddy/BilliardBuddy.local.md` | BilliardBuddy 项目指令 | `.BilliardBuddy` 是本产品唯一的目录化配置入口 |

指令从仓库根目录向当前工作目录逐层收集；同一目录的优先顺序为 `BilliardBuddy.md`、`.BilliardBuddy/BilliardBuddy.md`、`.BilliardBuddy/rules/*.md`、`.BilliardBuddy/BilliardBuddy.local.md`，后加载的规则在冲突时优先。根目录的 `AGENTS.md` 仅用于本仓库开发，不属于 BilliardBuddy 产品功能，也不会成为用户项目指令。

## 代码结构

| 路径 | 职责 |
|---|---|
| `ts/src` | Agent 内核、桌面本地服务、工具与扩展机制 |
| `ts/desktop` | React renderer、Electron 桌面宿主和本地 sidecar 打包 |
| `ts/shared` | 桌面与本地服务共享契约 |
| `gateway` | 模型、视觉和 Fun-ASR 网关 |
| `relay` | 图片生成与编辑异步中转 |

两台专用生产服务器的职责、目录、部署、备份和迁移步骤见
[服务器运行与迁移手册](./docs/operations/production-servers.md)。

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
- `GW_MIMO_NATIVE_CONC=48`：原生 MiMo 文本与 Computer Use 图像请求的固定槽位。
- `GW_VISION_CONC=16`：DeepSeek→MiMo 图片理解桥接的固定槽位。

这不是可互相借用的软限流，而是 `48 + 16 = 64` 的硬预留：原生请求不会耗尽视觉槽，图片桥接也不会在 64 条原生请求之后继续等待。手工调整时必须使 `GW_MIMO_NATIVE_CONC + GW_VISION_CONC = GW_MIMO_CONC`；网关会拒绝未分配或超配的配置。视觉桥接仍受 48 个短队列和 3 秒等待限制，不能据此承诺 100 人多窗口图片请求全部无等待。

部署脚本会把 `gateway/validate-mimo-capacity-env.sh` 与网关源码一并复制到大陆机，并在重启 `qfgw` 前校验这三个非敏感字段；手工上传时也必须带上该脚本。旧环境只设置 `GW_MIMO_CONC` 时，会按网关同一规则自动推导分区；格式错误或不相加的显式配置会在服务重启前失败。

面向 100 人 × 10 个 DeepSeek 窗口的部署会执行 `gateway/validate-production-capacity-env.sh` 做容量配置准入预检：显式旧 `800/8/800` 配置会被拒绝，必须改为至少 `1000/10/1000` 后才能重启。它只读取非敏感容量字段，不会执行或打印 `gw.env` 中的令牌和上游密钥；这只证明配置下限，不代表 1,000 个真实请求已经通过。图片 relay 的 `relay/validate-production-env.sh` 同样要求持久化 SQLite、blob 目录、至少 1000 个小任务队列和每装机 10 个任务额度，避免重启后丢失队列或悄然保留旧 `600/5` 档位。

计划真机验收时，可同时上传 `real-loadtest.ts`、`vision-real-loadtest.ts`、`image-real-loadtest.ts`、`mimo-mixed-real-loadtest.ts`；网关部署脚本只复制它们，不会自动发起收费或高并发请求。真实压测应从高档位逐级向下，并在每档确认网关已排空后再继续。
