# GPT 生图异步任务服务(美国 relay)

> 📌 状态:✅现行 · 落地 2026-07-09 · GPT Image 2 大陆超时根治(A2 方案)

把 GPT 生图那次"几分钟的慢调用"收到**美国服务器本地**跑,彻底绕开"大陆↔美国跨境长连接约 60 秒被网络掐断"。

## 为什么需要它

GPT Image 2 是 OpenAI 的**同步**接口(`images.generate/edit`),单张 high 质量要 **2.5~4.5 分钟**。图在 **OpenAI 自己的服务器**(美国)生成——不是我们服务器生成、也不是用户本地生成。但请求必须从**美国 relay 出口**(大陆连不上 OpenAI,真 key 只在美国 relay)。

问题:若大陆客户机 / 大陆网关直接握这条跨境长连接死等,连接会在约 60 秒被网络物理掐断——**图在 OpenAI 已生成并扣了费,却传不回来**(图丢 + 白扣钱)。900s 的 nginx 超时没用,因为掐断在网络层、到不了超时判定。

根治 = 把慢调用挪到美国本地:

```
客户端(大陆) --短-- 大陆网关(39.106.214.21) --短-- 本服务(美国) --US→US ~80ms-- OpenAI
```

任何跨境请求都退化成"提交(短)/轮询(短)",没有任何一跳还握跨境长连接。

## 契约

- `POST /images/tasks` — 提交(立即返回,后台跑 OpenAI)
  - 鉴权:`Authorization: Bearer <RELAY_TOKEN>`(= 网关 `GW_RELAY_TOKEN`)
  - body(JSON):`{ mode:'generate'|'edit', model, prompt, n, size, response_format?, images?:string[](data-uri,edit用), mask?, input_fidelity? }`
  - 返回 `202 { task_id, status:'queued' }`
- `GET /images/tasks/:id` — 轮询
  - 返回 `200 { status:'queued'|'running'|'succeeded'|'failed', data?:[{b64_json|url}], error?, created }`
  - `404` 未知/过期(结果保留 `RELAY_TASK_TTL_MS`,默认 10 分钟)
- `GET /healthz` — `{ ok, tasks, img_conc }`

真 OpenAI key 只在本服务的 `RELAY_OPENAI_KEY`,绝不下发客户端。

## 配置(`relay.env`,chmod 600,不进 git)

| 变量 | 说明 |
|---|---|
| `RELAY_TOKEN` | 入站令牌,必须 = 大陆网关的 `GW_RELAY_TOKEN` |
| `RELAY_OPENAI_KEY` | 真 OpenAI key(生产) |
| `RELAY_OPENAI_BASE` | 默认 `https://api.openai.com/v1` |
| `RELAY_PORT` | 默认 `8790` |
| `RELAY_TASK_TTL_MS` | 结果保留毫秒,默认 `600000`(10 分钟) |
| `RELAY_IMG_CONC` | 对 OpenAI 的在途并发上限,默认 `6` |

## 部署(美国服务器)

```bash
scp relay/app.ts   root@<us-server>:/tmp/relay-app.ts
scp relay.env      root@<us-server>:/tmp/relay.env     # 本地准备好,含真 OpenAI key
scp relay/deploy.sh root@<us-server>:/tmp/relay-deploy.sh
ssh root@<us-server> 'bash /tmp/relay-deploy.sh'        # Bun + systemd(qfrelay) + /healthz
```

### nginx(该美国机已有 nginx,加一段)

```nginx
location /relay/imgtasks/ {
    proxy_pass http://127.0.0.1:8790/;
    proxy_read_timeout 120s;   # submit/poll 短请求
}
```

## 激活(大陆网关 + 桌面客户端)

1. **大陆网关** `gw.env` 加:`GW_RELAY_TASKS_BASE=https://zzyppz.cn/relay/imgtasks`,重启 `qfgw`。
2. **桌面客户端** `bundled.env` 加:`QF_GPT_IMAGE_ASYNC=1`(打进安装包)。
3. 关掉任一个即退回同步路径(仍带尺寸/input_fidelity 修复,适合快请求场景)。

## 测试

```bash
cd relay && bun test        # 提交→后台调 OpenAI→轮询成功、multipart 改图、失败捕获、鉴权、TTL 过期(mock OpenAI)
```

部署后执行带真实密钥和跨境链路的显式 live smoke，确认高质量图片稳定返回。
