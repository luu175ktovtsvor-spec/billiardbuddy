# BilliardBuddy 服务器运行与迁移手册

本文记录 BilliardBuddy 两台专用服务器的正式生产链路。以下 2026-07-24—26 内容是重构前的历史快照，不是新架构必须保留的部署方案。当前无人使用，Gateway、Relay、服务、数据库、队列、路由和两台服务器都允许整体替换；开始实施前盘点真实状态，实施完成后以真实服务、端口、路由、环境变量名称和运行状态重写本文。任何密钥值、启动凭据、License、私钥或用户数据都不得写入 Git。

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

- 2026-07-24 13:11 CST 以仓库 `cf416514…` 的运行闭包重新部署大陆 qfgw 和美国 qfrelay；两个部署脚本在重启前通过正式环境预检，未覆盖 `gw.env`、`authority.json`、`usage.db*`、`relay.env`、`relay.db*` 或 blob 数据。
- 大陆 `/opt/qfgw/app.ts` 与仓库 SHA-256 均为 `e495887520fb09a8d271815f80f8f4384153523c46d768cc75db572f7f4a9f3f`；美国 `/opt/qfrelay/app.ts` 与仓库 SHA-256 均为 `7a4cef9de932f7d0dd91c4c2dc4567979ee9da2bd77ff8f8e5e220be125295bb`。
- 大陆 `/opt/qfgw/providerRegistry.ts` 与仓库 SHA-256 均为 `e2cc5bce75448686204c07ea16857822e597c9d793b53eb2a6107929a4fad9ad`；GPT Image `gpt-image-2` 和豆包 Seedream `doubao-seedream-4-5-251128` 都是正式 `ImageGeneration` 注册项。
- 美国 `relay.db` 已原位增量增加 `acknowledged_at`。迁移后聚合审计发现 2030 条 2026-07-19—20 日旧容量测试终态记录（1968 cancelled、58 succeeded、4 failed，全部 `provider=legacy`）和 58 个对应结果 blob；在服务无活跃任务时停机一致性删除并重建空库，验收后 task/blob 均为 0，临时备份已删除。`RELAY_ARK_KEY` 已配置，Seedream 模型和并发值使用当前 relay 代码的正式缺省值。
- 快照验收时 `qfgw`、`qfrelay`、`qfgw-tunnel` 和 `nginx` 均为 active；大陆 loopback、美国隧道、美国 relay 和 `https://zzyppz.cn/gw/healthz` 全部通过。部署上传物和临时回滚包已在验收后删除。
- 美国真实主机使用临时 SQLite/blob 和假上游完成 34 项负载验收：1000 个小任务、500 个中等改图输入的持久排队、owner 公平、取消、恢复、TTL 和 ack 全部通过。未调用收费上游；这不是 OpenAI/Seedream 真实吞吐证明。
- 2026-07-24 13:27 CST 完成模块 15 实时复核：大陆 `qfgw` active，`GW_FUNASR_KEY` 非空且 Registry 仍只有 `fun-asr-flash-2026-06-15` 承担正式 `SpeechTranscription`；美国 `qfgw-tunnel`、`qfrelay`、`nginx` 全部 active，loopback、隧道和公网 `/gw/healthz` 均通过。relay 空闲且 task/blob 无新增测试垃圾，Seedream 仍为 configured，容量为全局 6、单 owner 1。本模块只改变桌面本地领域层和请求 operation header，远端运行闭包未变化，因此未做无意义重部署，上一条代码哈希继续有效。
- 2026-07-24 14:00 CST 完成模块 16 实时复核：大陆 `qfgw`、美国 `qfgw-tunnel`/`qfrelay`/`nginx` 均为 active，大陆 loopback、美国隧道/relay 和公网协议健康。qfgw、Registry、relay 的 SHA-256 仍分别为 `e4958875…`、`e2cc5bce…`、`7a4cef9d…`；Registry 中 Fun-ASR 和豆包 Seedream 正式项各存在一次，relay 报告 Seedream configured、全局 6/单 owner 1，正式 SQLite task 与 blob 文件均为 0。模块 16 只增加桌面 sidecar 的视频领域和 Electron Host 接线，远端闭包未变化，故不重部署或重启。
- 2026-07-26 05:51 CST 完成模块 21 qfgw 更新：先停止 qfgw 对 `/opt/qfgw` 和 `gw.env` 做一致性回滚备份，恢复健康后由 `gateway/deploy.sh` 完成授权、MiMo 64=48+16 分区和 1000-window 生产容量预检，再替换运行闭包并重启。大陆 `/opt/qfgw/app.ts` 与仓库 SHA-256 同为 `2355fc244b6e323270dccd4098819eb7316fadfd485fa1d72a51c656f18bba3f`，`usageBudget.ts` 同为 `31014e543b30804ce4ec005a2724cc42c35a1e3dfcd3d311f7616d7d19f8873`。正式 `usage.db` 完整性为 `ok`，`usage_budget_period_principal` 摘要索引已真实建立；qfgw active，大陆 loopback 和公网 `https://zzyppz.cn/gw/healthz` 均只返回最小组件清单。本次不改 relay 闭包，故美国 qfrelay 不重部署。

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

### 4.1 桌面语音记录不在服务器

Fun-ASR 的上游凭据和用量回执在大陆 qfgw；但产品的 `VoiceOperation`、`Transcript`、不可变 revision 与 consumer binding 保存在每台桌面自己的 sidecar 数据目录，不在两台服务器：

```text
<CLAUDE_CONFIG_DIR>/billiardbuddy/voice/
  operations/    # 来源摘要、状态、Transcript 引用；不含音频字节
  transcripts/   # raw、edit revisions 和 Composer/video Evidence bindings
  locks/         # 写入互斥文件，可重建，不需要迁移
```

迁移用户数据时，在桌面 sidecar 完全退出后复制 `operations/` 和 `transcripts/`，保持目录仅当前用户可读；不要只迁移 Transcript 而遗漏 operation。音频文件从不落入该目录。`BB_VOICE_RETENTION_DAYS` 缺省为 30，可设 1—365；未绑定终态记录到期删除，存在 consumer binding 的记录不由该 GC 删除。服务器备份不能替代桌面数据备份。

### 4.2 桌面媒体项目与视频素材

图片和视频的权威项目、持久任务、Asset、Timeline Version、删除回执与 CAS 都在桌面 sidecar 数据目录，不在两台服务器：

```text
<CLAUDE_CONFIG_DIR>/billiardbuddy/media/
  projects/      # MediaProject、Evidence、Brief、Scene 与不可变 Version
  tasks/         # image/video 持久 MediaJob
  assets/        # 项目私有托管资产
  cas/sha256/    # 按内容寻址的托管资产
  deletions/     # 删除与恢复回执
  trash/         # 保留期内可恢复数据
  locks/         # 写入互斥文件，可重建
```

视频源文件保持在用户选择的原位置，MediaProject 只保存路径、SHA-256 fingerprint、ffprobe 元数据和 missing 状态；迁移桌面时必须先退出 sidecar，完整复制 `media/`，再单独复制仍被项目引用的源文件与用户导出文件，并保持路径或由产品重新关联。不能只备份 `projects/`：否则任务恢复、托管 Asset、CAS、删除回执和历史 Version 会不完整。分析用代表帧/音轨是临时文件，成功、失败和取消后均应为空，不属于备份；导出文件由用户选择位置，不随服务器备份迁移。

`BB_MEDIA_BIN_DIR` 可指定受审核 FFmpeg/ffprobe 目录；安装包默认使用已校验的随包工具链。`BB_MEDIA_DELETION_RETENTION_DAYS` 缺省 30，可设 1—365；`BB_MEDIA_MAX_QUEUED_RENDERS` 和 `BB_MEDIA_MAX_QUEUED_VIDEO_PROBES` 控制本机有界排队。迁移后应从真实安装包打开旧项目，验证源 fingerprint、Evidence/Timeline 历史、锁定场景、预览和一次本机导出，不能只看 JSON 文件存在。

### 4.3 桌面计划任务与 ProductTask 运行

计划任务的时间表、执行历史和真实 ProductTask 权威运行都在桌面本地，不在两台服务器：

```text
<CLAUDE_CONFIG_DIR>/
  scheduled_tasks.json                         # schedule、工作目录、补跑策略和通知设置
  scheduled_tasks_log.json                     # 逻辑 occurrence 与最近运行结果
  billiardbuddy/
    product-tasks.json                         # 产品任务索引
    product-task-authority.v1.json             # 计划任务提交回执、TaskRun 与 dispatch 真相
    product-agent-worker-scheduler.json        # 本机资源 claim 与 fencing 状态
```

迁移桌面数据时，先完全退出桌面应用和 sidecar，再同一批复制上述五个 JSON 及 `billiardbuddy/` 中它们依赖的其他 ProductTask 数据。`*.guard` 和 `*.lock` 只是可重建互斥状态，应在进程停止后排除；不能只复制 `scheduled_tasks.json`，否则已接受但未结算的 ProductTask 会失去权威终态。

每个任务绑定的工作目录是它的固定 workspace-write grant，目录本身不随上述 JSON 备份。新机必须另行复制工作区；若路径改变，在重新启用任务前通过桌面页重新选择目录。`run_once` 最多回溯 7 天且只补最近一个逻辑时点，`skip` 不补历史时点；同一 occurrence 由持久 operation ID 去重。迁移验收应包括：任务列表、暂停状态、工作目录、补跑策略、历史记录、一次手动运行的真实 ProductTask 终态和桌面通知。

### 4.4 两台服务器一致性备份

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
