# BilliardBuddy 生产服务器

最后按服务器实测记录更新：2026-08-04。本文记录受控发布与 smoke 的实际结果；后续发布前仍必须重新只读盘点主机、容器、端口和 release revision，不能以本文替代现网核验。

## 当前拓扑

```text
桌面端
  -> https://zzyppz.cn/gw/
  -> Nginx :443
  -> Gateway（Docker，127.0.0.1:8799）
  -> Relay（Docker Compose 私有网络，relay:8790）

Desktop Sidecar
  -> https://zzyppz.cn/video-media/
  -> Nginx :443
  -> Video Media Relay（Docker，127.0.0.1:8791）
  -> Compose 私网 Gateway（http://gateway:8799/internal/v1/auth/introspect）
  -> 北京 OSS 私有 Bucket、北京 DashScope
```

Gateway、Relay 与 Video Media Relay 位于同一 Compose 主机。Gateway 是托管 DeepSeek Responses 与图片任务的薄网关：安装鉴权、额度、用量、限流、路由、幂等与安全转发；它不保存 Agent Thread、Turn、工具、审批、沙箱或图片项目事实。Relay 只承接图片/视频异步任务结果；Video Media Relay 只保存短期 lease、操作、额度预留、receipt 和清理状态，不保存桌面项目事实。

本次实测：主机 `96.9.225.212` 的 release 为 `3a15713250bcab9ea81ec797e0d9295383d01d23`。`billiardbuddy-gateway-1`、`billiardbuddy-relay-1` 与 `billiardbuddy-video-media-relay-1` 均使用该 revision 镜像且处于 healthy；Gateway 仅绑定 `127.0.0.1:8799`，Video Media Relay 仅绑定 `127.0.0.1:8791`，Relay 与 Gateway 的服务间路由都位于 Compose 私网。公网 `https://zzyppz.cn/video-media/readyz` 返回 200，公网访问 `/gw/internal/v1/auth/introspect` 返回 404。配置只位于权限为 `0600` 的 `/srv/billiardbuddy/secrets/video-media-relay.env`；盘点与日志检查不读取或输出 secret 值。

## 第 4 关生产实测

```text
Desktop Sidecar -> https://zzyppz.cn/video-media/ -> Nginx -> 127.0.0.1:8791 Video Media Relay
Video Media Relay -> Compose 私网 Gateway /internal/v1/auth/introspect
Video Media Relay -> 北京 OSS 私有 Bucket 与北京 DashScope
```

`video-media-relay` 使用独立 `/srv/billiardbuddy/data/video-media-relay` 与 `/srv/billiardbuddy/secrets/video-media-relay.env`，前者保存短期 lease/request/receipt SQLite 元数据，后者只包含变量值而不进入日志；Gateway 与 Relay 现有数据目录和端口不变。生产环境显式配置 `VIDEO_MEDIA_ACCOUNT_QUOTA_UNITS=2000`、`VIDEO_MEDIA_OBJECT_LEASE_QUOTA_UNITS=1`、`VIDEO_MEDIA_LEASE_TTL_MS=60000` 与 `VIDEO_MEDIA_OUTCOME_UNKNOWN_RETENTION_MS=259200000`：前两项分别限制单安装账户的远程调用单位和未消费的 OSS 写入能力，后两项分别限制客户端 URL 与不可判定结果的保留期。

该 release 的受控 smoke 使用临时 Gateway token，并在结束时注销，实测矩阵如下：无 bearer 返回 401；伪造 bearer 返回 401/403；公网拒绝 `/gw/internal/*`；错误 purpose/MIME 和租约到期分别被 Relay 拒绝；第二个未消费 lease 在签发前被 429 拒绝，过期 lease 返回 410 并释放配额；长 Fun-ASR 处于 submitted/running 时，2000 单位 Embedding 请求返回 429。9 MiB 流式 multipart 经初始化、ListParts 分页、完成、HEAD 和流式 SHA-256 校验后清理；同一签名 URL 的第二次写入被 OSS 以 409 拒绝；Qwen 视觉、Qwen 规划、Embedding（768 维）和长 Fun-ASR 异步轮询均返回 provider receipt，结果读回并 ACK。结束时未删除 lease、待清理对象、未 ACK 结果对象与临时 smoke 容器均为 0，Relay 最近 250 行日志未匹配到 AccessKey 或 DashScope key 形态。

北京 OSS RAM 凭据只限私有 Bucket 的 `video-media/input/*` 与 `video-media/result/*`：`oss:PutObject`、`oss:GetObject`、`oss:HeadObject`、`oss:DeleteObject`、`oss:ListParts`、`oss:AbortMultipartUpload`、`oss:CompleteMultipartUpload`。`oss:ListMultipartUploads` 必须在该 Bucket 级别授予（OSS 的上传列表请求不能安全携带可用的对象前缀限制），仍不得授予其他 Bucket、ACL、RAM 或账户管理权限。所有 lease、multipart 和结果对象写入均携带 `x-oss-forbid-overwrite: true`；该 OSS 专用条件写入语义在对象已存在时返回 409，避免重放覆盖已验证媒体或已 ACK receipt。

## 协议边界

- 托管文本入口为 `POST /gw/v1/responses`，不提供 `/v1/chat/completions`。
- 图片任务入口为 `POST /gw/v1/images/tasks`，并由 `GET /gw/v1/images/tasks/:id`、`POST .../:id/cancel` 和 `POST .../:id/ack` 组成同一幂等任务协议；Sidecar 不直连 Relay。
- 桌面端的个人 Key 不经过 Gateway；个人 Chat 转换也只在用户本机发生。
- Gateway 到 Relay 使用 Compose 私有网络 `http://relay:8790`；对外请求必须走 HTTPS。
- Relay 在本地 Candidate Group、CAS 与 SQLite 事务成功后才接受 ACK；远端结果、Provider 响应和 Relay credential 不进入公开投影或日志。
- 秘钥文件只留在服务器的受限权限目录，不打包进发布物，不写入日志或部署记录。

## 发布原则

只从已提交 revision 制作发布包，不从工作树复制文件。发布前检查 Compose 配置、镜像构建、环境变量和健康端点；发布后复核运行镜像 revision、容器健康、`/gw/healthz`、一次受控 `/v1/responses` SSE 调用，以及在明确预算开关下的一次 Gateway → Relay 图片协议 smoke。测试安装会话与输出必须清理。

不要使用会影响同主机其他项目的 `--remove-orphans`。Gateway/Relay 的部署不会替代桌面端、Windows/macOS、个人 Key 或原生工具/审批的用户旅程验证。
