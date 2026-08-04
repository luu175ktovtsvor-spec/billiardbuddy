# BilliardBuddy 生产服务器

最后按服务器实测更新：2026-08-04。本文是当前三服务发布与运行边界的操作手册，不替代每次发布前的只读盘点。

## 当前拓扑

```text
桌面安装包中的公开配置
  Agent（托管）  -> https://zzyppz.cn/gw/v1/responses
  Image Sidecar  -> https://zzyppz.cn/image-generation/v1/images/tasks
  Video Sidecar  -> https://zzyppz.cn/video-media/v1/video-media/...
                         │
                         ▼
                    Nginx :443
        ┌────────────────┼─────────────────┐
        ▼                ▼                 ▼
 Gateway :8799    Image Relay :8790  Video Media Relay :8791
        │                │                 │
 托管文本 Provider   图片 Provider      北京 OSS / DashScope
                         │                 │
             Gateway 私网 introspection（仅 Compose 网络）
```

三项公开地址只在 [`ts/desktop/build/product-config.json`](../../ts/desktop/build/product-config.json) 中随安装包发布；它们都必须是 HTTPS，分别固定为 `/gw`、`/image-generation`、`/video-media`。图片和视频 Sidecar 直接到各自 Relay，**不再经过 Gateway 转发任务或媒体字节**。Gateway 只提供托管 Agent 与 Relay 的私网身份内省。

Nginx 仅反代到本机回环端口：Gateway `127.0.0.1:8799`、Image Relay `127.0.0.1:8790`、Video Media Relay `127.0.0.1:8791`。公网访问 `/gw/internal/*` 和 Image Relay 详细 `/image-generation/healthz` 固定返回 `404`；后者只供容器回环健康检查，避免公开队列与容量快照。Relay 通过 Compose 私网 `http://gateway:8799/internal/v1/auth/introspect` 获取已验证的安装 owner，不能相信客户端提交的 owner 字段。

当前实测 release 为 `adf33a9d319c91d947a18c3ec68fbcf37062cdcc`。三个产品容器 `billiardbuddy-gateway-1`、`billiardbuddy-image-relay-1`、`billiardbuddy-video-media-relay-1` 均为 healthy。`https://zzyppz.cn/video-media/readyz` 返回 `200`，公网 POST `/gw/internal/v1/auth/introspect` 返回 `404`。

## 并发、模型与额度的分层

这三者必须分开，不能把数值散落到业务 handler，也不能只依赖 Nginx：

| 层 | 事实来源 | 职责 |
| --- | --- | --- |
| 模型目录 | 共享产品目录 | 逻辑模型、能力和工作负载；不含 API Key 或物理账号容量。 |
| 容量 policy | 三个服务各自的受控部署环境 | 每个物理账号/工作负载的并发、RPM、队列、等待时间、单 owner 上限和 policy revision。 |
| 准入执行 | 共享 admission kernel，位于 Gateway、Image Relay、Video Media Relay 的最终 Provider 边界 | 公平排队、取消/超时释放、最终硬上限；请求没有许可不得到达 Provider。 |
| 额度账本 | 对应受信服务的持久化账本 | 从安装身份派生 owner，做预留、结算、释放和幂等；不是 API Key 的镜像。 |

因此“配置外置”指的是**并发数字、账号绑定和 revision 在环境配置中**，通过完整候选环境、同版本 validator 和受控重启生效；并不意味着删除服务端准入。Nginx 可以做连接数、请求大小和粗粒度入口保护，但无法正确处理 owner、公平队列、异步恢复、Provider 账号和付费任务。

当前是单实例服务：容量 backend 为进程内实现，避免新增网络跳转和中央单点。未来才在多副本阶段，把同一 admission 接口替换为带租约和 fencing 的全局协调器；每个执行进程仍保留本地硬上限。不要为了“配置在外”现在额外搭建一个并发服务器。

图片工作台估算响应里的 `concurrency` 是一次创作 Round 的产品级并行计划提示，不是 Provider 的实际并发闸门；实际执行上限仍只以 Relay capacity policy 为准。

## 用户额度与 Key 边界

- 默认已认证安装可使用托管 Agent、图片和视频能力；三种额度各自结算，一项耗尽只限制该项托管能力。
- 托管 Agent 的文本账本和 Provider 密钥只在 Gateway；图片 Provider 密钥、准入和任务状态只在 Image Relay；视频 Provider/OSS 密钥、准入和短期租约只在 Video Media Relay。
- 用户给 Agent 配置个人 Provider Key 时，仅本机 Electron Main 的安全存储和本机短生命周期适配器使用它；该请求直连所选上游，不进入 Gateway 的托管账本，也不影响图片或视频额度。
- Renderer 不持有密钥、Relay service token 或公开结果凭据。当前运行合同不等于 Renderer 已完成所有产品 UI；界面阶段仍按各工作台合同推进。

对外错误只给稳定、可处理的能力状态，不泄漏账号、模型密钥、余额或内部队列细节。例如托管 Agent 额度返回 `USAGE_LIMIT_REACHED`；图片和视频 Relay 分别返回其已列入合同的 quota/queue 错误码和安全 retry 信息。

## 进程、数据与权限

Compose 文件是 [`deploy/production/compose.yml`](../../deploy/production/compose.yml)。三个产品容器均为只读根文件系统、`/tmp` tmpfs、删除 Linux capabilities、`no-new-privileges`、`pids_limit: 256`；Image Relay 内存上限 `2g`，Gateway 和 Video Media Relay 各 `1g`。它们不管理同主机的静态站点或桌面更新服务。

| 服务 | 密钥文件（`0600`） | 持久数据目录（`0700`、容器 uid/gid `1000:1000`） |
| --- | --- | --- |
| Gateway | `/srv/billiardbuddy/secrets/gateway.env` | `/srv/billiardbuddy/data/gateway` |
| Image Relay | `/srv/billiardbuddy/secrets/image-relay.env` | `/srv/billiardbuddy/data/image-relay` |
| Video Media Relay | `/srv/billiardbuddy/secrets/video-media-relay.env` | `/srv/billiardbuddy/data/video-media-relay` |

绝不把上述文件、API Key、service token、安装 bearer、完整 Provider 回执或用户媒体输入写入仓库、安装包、日志、聊天记录或发布包。视频 OSS Bucket 保持私有；Relay 只使用最小前缀权限和短期签名 URL。

## 发布与配置变更

1. 从已提交 revision 打包，不从工作树复制：`deploy/production/package-release.sh <输出包> <完整提交 SHA>`。
2. 在服务器解压到 `/srv/billiardbuddy/releases/<完整提交 SHA>`，核对 `release-manifest.json` 与审核 SHA 一致。
3. 修改并发、RPM、队列、额度或账号绑定时，先准备完整的三个候选环境文件；不要对运行容器零散热改变量。每个文件中的 policy revision 也要同步更新。
4. 以明确盘点过的 root vhost 执行发布：

   ```bash
   cd /srv/billiardbuddy/releases/<完整提交 SHA>
   sudo BILLIARDBUDDY_RELEASE=<发布标签> \
     BILLIARDBUDDY_NGINX_ROOT_VHOST=/etc/nginx/sites-available/billiardbuddy \
     bash deploy/production/deploy.sh
   ```

   脚本会构建三镜像、离线校验三份环境、校验数据目录、等待三个健康检查，再原子安装 Nginx 路由。不要使用会影响其他服务的 `--remove-orphans`。

5. 发布后复核实际运行镜像、三项健康检查和公网内部路由拒绝。付费 smoke 必须显式确认、使用临时安装 token、限制操作数，并在结束时注销/ACK/清理。服务器未安装 Bun 时，使用对应 release 的一次性、只读容器执行 smoke；不要为了 smoke 在主机全局安装运行时或把 token 落盘。

2026-08-04 对当前 release 的受控视频 smoke 已实测四项真实 Provider 操作（视觉、Embedding、规划、长 ASR）均 succeeded 且 ACK；所有对应 lease 已 deleted，没有待清理对象或未确认结果。这个结果证明当前 Video Media Relay → 北京 OSS/DashScope 的真实链路可用；每次新 release 仍应重新跑其受影响的受控 smoke。

## 操作禁区

- 不把 `/gw/internal/*`、Relay service token 或任一服务器 env 暴露给公网、桌面端或 Renderer。
- 不绕过 capacity policy 直接在业务 handler 调 Provider。
- 不用 Nginx 的连接上限替代应用层 owner/账号/付费准入。
- 不把个人 Agent Key 转发到 Gateway，也不以个人 Key 绕过图片或视频的托管安全边界。
- 不删除旧 release 目录或数据目录来“清理”发布；先完成数据盘点和明确的保留/回滚决策。可在成功部署后删除仅用于传输的临时 tar 包。
