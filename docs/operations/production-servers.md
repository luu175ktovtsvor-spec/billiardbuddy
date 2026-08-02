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

Gateway 与 Relay 位于同一 Compose 主机。Gateway 是托管 DeepSeek Responses 的薄网关：安装鉴权、额度、用量、限流、路由、幂等与 SSE 转发；它不保存 Agent Thread、Turn、工具、审批、沙箱或执行任务。Relay 只承接图片/视频异步任务结果。

## 协议边界

- 托管文本入口为 `POST /gw/v1/responses`，不提供 `/v1/chat/completions`。
- 桌面端的个人 Key 不经过 Gateway；个人 Chat 转换也只在用户本机发生。
- Gateway 到 Relay 使用 Compose 私有网络 `http://relay:8790`；对外请求必须走 HTTPS。
- 秘钥文件只留在服务器的受限权限目录，不打包进发布物，不写入日志或部署记录。

## 发布原则

只从已提交 revision 制作发布包，不从工作树复制文件。发布前检查 Compose 配置、镜像构建、环境变量和健康端点；发布后复核运行镜像 revision、容器健康、`/gw/healthz` 与一次受控 `/v1/responses` SSE 调用。测试安装会话与输出必须清理。

不要使用会影响同主机其他项目的 `--remove-orphans`。Gateway/Relay 的部署不会替代桌面端、Windows/macOS、个人 Key 或原生工具/审批的用户旅程验证。
