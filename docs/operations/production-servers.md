# BilliardBuddy 生产服务器

最后实测更新时间：2026-08-02。

## 当前运行拓扑

```text
桌面端
  → https://zzyppz.cn/gw/
  → Nginx :443（同一台服务器）
  → Docker Gateway 127.0.0.1:8799
  → Docker 私有网络 relay:8790（仅图片异步任务）
```

当前正式环境只有一台 Compose 主机：`96.9.225.212`（主机名 `cch`）。此前文档中
`39.106.214.21`、`47.77.237.250`、SSH 隧道和 systemd 的双主机描述均不是现网，不能
再作为部署依据。

Gateway 与 Relay 是同一个 Compose 项目 `billiardbuddy`：

- 发布目录：`/srv/billiardbuddy/releases/<release-id>`
- 当前发布：`2323409abc8e`，源码 revision `2323409abc8e8c6f8eec07b0b87525d43d5d6aed`
- 当前目录软链接：`/srv/billiardbuddy/current`
- Compose 文件：`deploy/production/compose.yml`
- 密钥文件：`/srv/billiardbuddy/secrets/gateway.env`、`/srv/billiardbuddy/secrets/relay.env`，只记录在服务器，权限为 `0600`
- 持久数据：`/srv/billiardbuddy/data/gateway`、`/srv/billiardbuddy/data/relay`
- Gateway 仅绑定 `127.0.0.1:8799`；Relay 仅暴露给 Compose 私有网络的 `relay:8790`

同机的 `billiardbuddy-site` 与 `billiardbuddy-static-1` 不属于此 Compose 发布物；升级
Gateway/Relay 时不得使用 `--remove-orphans`，避免影响站点和桌面更新静态文件。

## 正式边界

- Gateway 负责安装鉴权、额度/用量、限流、DeepSeek 路由、幂等与终态 SSE 回放；不保存
  Agent Thread、Turn、工具、审批或沙箱状态。
- 托管文本模型只接受 `POST /v1/responses`，协议头为
  `X-BB-Provider-Protocol: bb-provider-gateway/1.0`；`/v1/chat/completions` 已在运行中
  Gateway 验证为 `404`。
- 用户自填 Chat Completions Key 的转换只在桌面本机无状态适配器发生，不经过 Gateway。
- 图片异步任务由 Relay 独立持久化；Gateway 与 Relay 的内部跳转固定为
  `http://relay:8790`。校验器只允许这一 Compose 私有 HTTP 地址，其他 Relay 地址必须
  使用 HTTPS。

## 本次已验证的运行事实

- `billiardbuddy-gateway-1` 运行镜像为 `billiardbuddy/gateway:2323409abc8e`，健康。
- `billiardbuddy-relay-1` 运行镜像为 `billiardbuddy/relay:2323409abc8e`，健康。
- 容器内 `/app/gateway/app.ts` SHA-256 与候选发布目录一致：
  `24f4950026290df39f6f3dc66f7716a2058aa38e47b77ce032f9c20c2e4d0b19`；旧
  `deepseekChat.ts` 不在镜像中。
- 本机与公网 `https://zzyppz.cn/gw/healthz` 均返回 200，并声明
  `bb-provider-gateway/1.0`。
- 真实临时安装身份经 `/v1/auth/bootstrap` 调用 DeepSeek `deepseek-v4-flash` 的
  `/v1/responses`，收到 `response.created`、文本/推理增量及 `response.completed`；测试
  会话已注销，输出和令牌未记录。
- 发布前静态容量校验通过：Gateway 1000 窗口，Relay 队列 2000；MiMo 总并发 64，拆分为
  Media 48 与 Vision 16。它们是配置上限检查，不是 1000 用户真实上游压测。

这证明当前的 Gateway/Relay 发布闭包、公开健康入口及托管 Responses 主路径可用；它不替代
桌面 Rust App Server 的真实 Thread、工具、审批、恢复与 Windows/macOS 用户旅程验收。

## 发布流程

只发布已提交的指定 revision；不要从工作树复制文件，也不要把密钥打进发布包。

1. 在开发机运行 `deploy/production/package-release.sh <输出包> <git-revision>`；包仅包含
   Gateway、Relay、共享协议、Compose 文件与校验脚本，并带 `release-manifest.json`。
2. 上传包到服务器，解压到新的
   `/srv/billiardbuddy/releases/<release-id>` 目录。先执行容量校验、
   `docker compose config --quiet`、镜像构建和 Compose 内 `--process-env` 预检。
3. 通过候选预检后，在该发布目录执行：

   ```bash
   BILLIARDBUDDY_RELEASE=<release-id> bash deploy/production/deploy.sh
   ```

   脚本只重建/替换 `gateway` 与 `relay`，等待两者健康后更新 `current` 软链接。
4. 复核本机及公网 `/gw/healthz`、运行镜像 tag、容器内源码哈希和托管
   `/v1/responses` 的受控调用。测试产生的临时安装会话必须注销。

旧双主机/systemd/SSH 隧道发布脚本已从仓库及当前服务器清理；生产环境唯一发布路径就是
本节的 Compose 流程。
