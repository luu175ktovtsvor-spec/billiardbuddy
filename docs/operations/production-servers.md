# BilliardBuddy 生产服务器

最后按服务器实测记录更新：2026-08-02。部署前必须重新只读盘点实际主机、容器、端口和发布 revision；本文不是用来推断现网的替代品。

## 当前拓扑

```text
桌面端
  -> https://zzyppz.cn/gw/
  -> Nginx :443
  -> Gateway（Docker，127.0.0.1:8799）
  -> Relay（Docker Compose 私有网络，relay:8790）
```

Gateway 与 Relay 位于同一 Compose 主机。Gateway 是托管 DeepSeek Responses 与图片任务的薄网关：安装鉴权、额度、用量、限流、路由、幂等与安全转发；它不保存 Agent Thread、Turn、工具、审批、沙箱或图片项目事实。Relay 只承接图片/视频异步任务结果。

## 协议边界

- 托管文本入口为 `POST /gw/v1/responses`，不提供 `/v1/chat/completions`。
- 图片任务入口为 `POST /gw/v1/images/tasks`，并由 `GET /gw/v1/images/tasks/:id`、`POST .../:id/cancel` 和 `POST .../:id/ack` 组成同一幂等任务协议；Sidecar 不直连 Relay。
- 图片理解入口为 `POST /gw/v1/media/reasoning`，只允许 Qwen3-VL-Flash 的版本化 `image_understanding` / `image_visual_assessment` schema；它不经 Relay，也不具备采纳、发布、删除或项目写权限。
- 桌面端的个人 Key 不经过 Gateway；个人 Chat 转换也只在用户本机发生。
- Gateway 到 Relay 使用 Compose 私有网络 `http://relay:8790`；对外请求必须走 HTTPS。
- Relay 在本地 Candidate Group、CAS 与 SQLite 事务成功后才接受 ACK；远端结果、Provider 响应和 Relay credential 不进入公开投影或日志。
- 秘钥文件只留在服务器的受限权限目录，不打包进发布物，不写入日志或部署记录。

## 发布原则

只从已提交 revision 制作发布包，不从工作树复制文件。发布前检查 Compose 配置、镜像构建、环境变量和健康端点；`gateway.env` 必须提供 `GW_QWEN_KEY`（可选 `GW_QWEN_BASE` 与 `GW_QWEN_REASONING_TIMEOUT_MS`），但不得记录其值。发布后复核运行镜像 revision、容器健康、`/gw/healthz`、一次受控 `/v1/responses` SSE 调用、在明确预算开关下的一次 Gateway → Relay 图片协议 smoke，以及一次 Qwen 严格 schema/脱敏 smoke。测试安装会话与输出必须清理。

不要使用会影响同主机其他项目的 `--remove-orphans`。Gateway/Relay 的部署不会替代桌面端、Windows/macOS、个人 Key 或原生工具/审批的用户旅程验证。
