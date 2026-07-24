# BilliardBuddy 服务器运行与迁移手册

本文记录 BilliardBuddy 两台专用服务器的正式生产链路。记录基于 2026-07-24 的实际部署；服务器配置发生变化时，必须与代码同一次提交更新本文。任何密钥值、启动凭据、License、私钥或用户数据都不得写入 Git。

## 1. 链路与职责

```text
桌面安装包
  └─ HTTPS https://zzyppz.cn/gw
       └─ 美国 Nginx 127.0.0.1:8800
            └─ OpenSSH 专用端口转发
                 └─ 大陆 qfgw 127.0.0.1:8799
                      ├─ DeepSeek 文本与原生搜索
                      ├─ MiMo 视觉
                      ├─ Fun-ASR 语音
                      └─ HTTPS /relay/imgtasks → 美国 qfrelay 127.0.0.1:8790
```

| 服务器 | 当前地址 | 系统 | 正式职责 | 公网端口 |
|---|---|---|---|---|
| 大陆 | `39.106.214.21` | Ubuntu 22.04 x86_64，2 vCPU，约 3.4 GiB 内存 | `qfgw`、授权/额度数据、构建工具链镜像 | `22`、`80`；网关本身只监听 loopback |
| 美国 | `47.77.237.250` | Ubuntu 26.04 x86_64，2 vCPU，约 3.4 GiB 内存 | 公网 TLS 入口、加密网关隧道、`qfrelay`、桌面更新和工具链文件 | `22`、`80`、`443`；relay 只监听 loopback |

公网网关只有 `https://zzyppz.cn/gw`。大陆 Nginx 不暴露 `/gw`，美国到大陆的请求不得退回公网 HTTP。

### 1.1 当前部署快照

- 2026-07-24 12:54 CST 以仓库 `038c3b8e…` 的运行闭包重新部署大陆 qfgw；部署脚本在重启前通过授权、MiMo 分区和生产容量预检，未覆盖 `gw.env`、`authority.json` 或 `usage.db*`。
- 大陆 `/opt/qfgw/providerRegistry.ts` 与仓库 SHA-256 均为 `e2cc5bce75448686204c07ea16857822e597c9d793b53eb2a6107929a4fad9ad`；GPT Image `gpt-image-2` 和豆包 Seedream `doubao-seedream-4-5-251128` 都是正式 `ImageGeneration` 注册项。
- 美国 `/opt/qfrelay/app.ts` 与仓库 SHA-256 均为 `18af9a6fdb8f01dff4d1652cdf9621955c092b196ee4da6497dcdbac4c223c35`；`RELAY_ARK_KEY` 已配置，Seedream 模型和并发值使用当前 relay 代码的正式缺省值。
- 快照验收时 `qfgw`、`qfrelay`、`qfgw-tunnel` 和 `nginx` 均为 active；大陆 loopback、美国隧道、美国 relay 和 `https://zzyppz.cn/gw/healthz` 全部通过。部署上传物和临时回滚包已在验收后删除。

## 2. 大陆服务器

### 2.1 正式文件

| 路径 | 用途 | 备份要求 |
|---|---|---|
| `/opt/qfgw` | 网关代码与运行目录，目录模式 `700` | 代码可从仓库重建 |
| `/opt/qfgw/gw.env` | Provider、relay、启动授权和容量配置，模式 `600` | 必须加密备份 |
| `/opt/qfgw/authority.json` | License、安装注册和会话状态，模式 `600` | 必须一致性备份 |
| `/opt/qfgw/usage.db*` | SQLite 用量与预算数据，模式 `600` | 必须一致性备份 |
| `/var/www/qf-assets` | 经审核的 FFmpeg/ffprobe 和字体包 | 可从发布源重建，迁移时应校验哈希 |
| `/etc/systemd/system/qfgw.service` | 网关服务 | 可由 `gateway/deploy.sh` 重建 |
| `/etc/nginx/sites-available/billiards-gateway` | 构建资产站点 | 来自 `gateway/deploy/qfgw-mainland.nginx.conf` |
| `/var/lib/qfgw-tunnel/.ssh/authorized_keys` | 美国机专用转发公钥，只允许 `127.0.0.1:8799` | 可用新密钥重建，不复制旧私钥 |

`gw.env` 的当前授权字段是 `GW_APP_CREDENTIALS`、`GW_AUTH_SIGNING_KEY`、`GW_AUTHORITY_FILE` 和 `GW_LICENSE_PROVISIONING`。`GW_APP_TOKENS` 已停用。Provider 与内部链路至少涉及 `GW_DEEPSEEK_KEY`、`GW_MIMO_KEY`、`GW_FUNASR_KEY`、`GW_RELAY_TASKS_BASE` 和 `GW_RELAY_TOKEN`；完整容量字段由 `gateway/deploy.sh` 及两个校验脚本定义。文档只记录变量名，不记录值。

### 2.2 常用操作

```bash
ssh root@39.106.214.21
systemctl status qfgw --no-pager
systemctl restart qfgw
curl -fsS http://127.0.0.1:8799/healthz
journalctl -u qfgw -n 100 --no-pager
```

部署前把仓库中的运行闭包上传到 `/tmp`，其中 `authority.ts` 来自 `ts/shared/product/authEntitlement.ts`，然后执行 `gateway/deploy.sh`。脚本会在重启前校验授权、MiMo 分区和生产容量；不要手工跳过校验。

## 3. 美国服务器

### 3.1 正式文件

| 路径 | 用途 | 备份要求 |
|---|---|---|
| `/opt/qfrelay` | relay 代码、环境、SQLite 和 blob | 代码可重建，数据必须备份 |
| `/opt/qfrelay/relay.env` | relay 凭据与容量，模式 `600` | 必须加密备份 |
| `/opt/qfrelay/relay.db*` | 异步图片任务状态 | 必须与 blob 一致性备份 |
| `/opt/qfrelay/blobs` | 排队输入和结果，模式 `700` | 必须与 SQLite 同批备份 |
| `/var/www/desktop-updates` | Windows/macOS 安装包、blockmap 与更新清单 | 必须保留仍受支持版本 |
| `/var/www/qf-assets` | 构建工具链镜像 | 可重建，迁移时校验哈希 |
| `/etc/nginx/sites-available/billiards` | 唯一站点配置 | 来自 `relay/deploy/qfrelay-us.nginx.conf` |
| `/etc/nginx/snippets/qfgw-us-https-proxy.conf` | `/gw` 到本机 SSH 隧道的代理 | 来自仓库同名文件 |
| `/etc/qfgw-tunnel/id_ed25519` | 美国到大陆的专用隧道私钥，模式 `600` | 建议迁移时重新生成，不写入备份仓库 |
| `/etc/qfgw-tunnel/known_hosts` | 固定大陆 SSH 主机公钥 | 新机上重新核验 |
| `/etc/systemd/system/qfgw-tunnel.service` | `127.0.0.1:8800` 到大陆 `127.0.0.1:8799` | 来自仓库模板 |
| `/etc/systemd/system/qfrelay.service` | relay 服务 | 可由 `relay/deploy.sh` 重建 |
| `/etc/letsencrypt` | `zzyppz.cn` TLS 证书状态 | 优先在新机重新签发 |

`relay.env` 必需字段以 `relay/deploy.sh` 和 `relay/validate-production-env.sh` 为准，核心包括 `RELAY_TOKEN`、`RELAY_OPENAI_KEY`、`RELAY_ARK_KEY`、`RELAY_DB`、`RELAY_BLOB_DIR`、`RELAY_QUEUE_MAX`、`RELAY_USER_MAX`、`RELAY_IMG_CONC` 和 `RELAY_UPSTREAM_TIMEOUT_MS`。大陆的 `GW_RELAY_TOKEN` 与美国的 `RELAY_TOKEN` 必须匹配。

### 3.2 公网路由

| 路径 | 后端/目录 |
|---|---|
| `/gw/` | `127.0.0.1:8800`，再经 OpenSSH 到大陆 qfgw |
| `/relay/imgtasks/` | `127.0.0.1:8790`；只允许大陆服务器来源，relay 自身继续验证 Bearer |
| `/desktop/` | `/var/www/desktop-updates` |
| `/assets/` | `/var/www/qf-assets` |

不得恢复旧 `/relay/openai/` 或 `/relay/openai-test/` 直连代理，也不得在 Nginx 中写 Provider 密钥。

### 3.3 常用操作

```bash
ssh root@47.77.237.250
systemctl status qfgw-tunnel qfrelay nginx --no-pager
systemctl restart qfgw-tunnel qfrelay
curl -fsS http://127.0.0.1:8800/healthz
curl -fsS http://127.0.0.1:8790/healthz
curl -fsS https://zzyppz.cn/gw/healthz
nginx -t
journalctl -u qfgw-tunnel -u qfrelay -n 100 --no-pager
```

TLS 由 Certbot 管理。迁移或续期后必须检查 `certbot certificates`、`systemctl status certbot.timer` 和实际 HTTPS 健康检查。

## 4. 备份

一致性备份必须短暂停止写入服务，不能只复制 SQLite 主文件而遗漏 WAL。建议先在服务器本机生成仅 root 可读的快照，再通过受控通道传出：

```bash
# 大陆
systemctl stop qfgw
tar --numeric-owner -C / -czf /root/billiardbuddy-mainland-backup.tgz \
  opt/qfgw var/www/qf-assets
systemctl start qfgw

# 美国
systemctl stop qfrelay
tar --numeric-owner -C / -czf /root/billiardbuddy-us-backup.tgz \
  opt/qfrelay var/www/desktop-updates var/www/qf-assets
systemctl start qfrelay
```

执行前确认数据库实际路径仍与环境文件一致；完成后立即检查服务和健康端点。备份文件含密钥与用户数据，必须加密传输、加密存储，并在确认远端副本可恢复后删除服务器临时包。

## 5. 迁移顺序

1. 新建两台 x86_64 Linux 服务器，安装 OpenSSH、Nginx、Bun 和 Certbot；先不要切 DNS。
2. 在大陆机恢复 `gw.env`、`authority.json`、`usage.db` 与资产目录，模式分别保持 `600/600/600`；上传当前运行闭包并执行 `gateway/deploy.sh`。
3. 在美国机恢复 `relay.env`、`relay.db`、`blobs`、桌面更新与资产，执行 `relay/deploy.sh`。
4. 在美国机新建 `/etc/qfgw-tunnel/id_ed25519`，把公钥安装到大陆专用账号；`authorized_keys` 必须带 `restrict,port-forwarding,permitopen="127.0.0.1:8799"`。核验大陆 SSH 主机公钥后写入 `known_hosts`，安装仓库中的 `qfgw-tunnel.service`。
5. 启动隧道并先验证 `http://127.0.0.1:8800/healthz`。只有它成功后，才安装仓库中的 Nginx snippet 和站点配置。
6. 为 `zzyppz.cn` 重新签发证书，验证 `/gw`、`/relay/imgtasks`、`/desktop` 和 `/assets`，再切换 DNS。
7. 更新美国 Nginx 中 `/relay/imgtasks` 的大陆出口 IP allowlist；如服务器 IP 变化，同时更新仓库模板和本文。
8. 从真实安装包完成激活、文本、原生搜索、视觉、语音和图片任务验收。确认旧服务器没有新写入后再下线，不能只凭 `/healthz` 删除旧数据。

## 6. 发布与故障判断

- 发布工作流从大陆 `gw.env` 读取一个 `GW_APP_CREDENTIALS` 启动凭据和一个 `GW_LICENSE_PROVISIONING` License，生成 Git 忽略的 `product-secrets.json`；该文件不得作为普通构建产物长期保存。
- `gateway/deploy.sh`、`relay/deploy.sh` 和 `gateway/deploy-us-https-proxy.sh` 是部署入口；手工复制代码后跳过这些脚本会绕过运行闭包和容量校验。
- qfgw 正常而公网失败：依次检查 `qfgw-tunnel`、美国 Nginx、证书和 DNS。
- `/gw` 正常而图片失败：检查 `GW_RELAY_TASKS_BASE`、两端 relay token、`qfrelay`、SQLite/blob 权限和美国 Nginx allowlist。
- 服务器只承载 BilliardBuddy。新增服务、数据库、定时任务或容器前必须在本文登记；废弃后同时删除服务、数据、反向代理、凭据、备份和文档入口。
