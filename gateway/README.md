# 球房 AI 网关阀门(并发控制 + 藏 key + 用量记录)

一台**国内服务器当总闸**,所有用户请求过这一个咽喉,才管得住全局并发 + 每人配额。
桌面 app 只拿 app 令牌,真 key 全在服务器。

## 架构(每家走最近的门)
```
桌面 app(国内) ──app令牌──► 大陆网关(总闸·39.106.214.21:8799)
                               ├─ MiMo 对话   → 直连小米(国内→国内,快)
                               ├─ GPT 生图    → 转发美国机 /relay(OpenAI 出口)
                               └─ Seedance    → 留接口位(等火山 ARK key)
```

## 三层阀门(`app.py`)
1. **每家真实限流**(已查证):MiMo 令牌桶(账号 100 RPM 留余量 90)、生图 IPM 令牌桶 + 在途并发信号量、视频并发信号量(火山个人户 3)。
2. **每用户每日配额**:对话/图/视频各自封顶,防一个人烧光、挤垮所有人。
3. **满了排队**(最多等 `GW_QUEUE_MAX_WAIT` 秒)→ 超时背压拒,绝不硬撞 provider 触发 429/封号。

用量全记 SQLite(`/opt/qfgw/usage.db`),`GET /admin/usage?token=...` 查。

## 部署
```bash
# 服务器需要 python3-venv:apt install -y python3.10-venv python3-pip
# 配置(含 key,chmod 600,不进 git):/opt/qfgw/gw.env —— 见 deploy.sh 注释里的变量清单
scp app.py gw.env deploy.sh root@<server>:/tmp/
ssh root@<server> 'bash /tmp/deploy.sh'   # venv+依赖+systemd(qfgw)+起服务+healthz
```

## 配置项(环境变量 / `gw.env`)
| 变量 | 说明 |
|---|---|
| `GW_MIMO_KEY` / `GW_MIMO_BASE` | MiMo 真 key + 端点(api.xiaomimimo.com/v1) |
| `GW_RELAY_BASE` / `GW_RELAY_TOKEN` | 美国出口地址(zzyppz.cn/relay/openai/v1)+ 中转令牌 |
| `GW_APP_TOKENS` | `{"令牌":"用户标识"}` —— 发给桌面 app 的令牌→用户映射 |
| `GW_ADMIN_TOKEN` | 看 `/admin/usage` 的口令 |
| `GW_MIMO_RPM` / `GW_IMG_IPM` / `GW_IMG_CONC` / `GW_VIDEO_CONC` | 各家阀门参数 |
| `GW_Q_CHAT` / `GW_Q_IMG` / `GW_Q_VIDEO` | 每用户每日配额 |

## 现状(2026-06-25 实测)
- ✅ 装在大陆机、零干扰现网;MiMo(1.5s)、GPT 生图(国内→美国 16.7s)端到端验通;401 拦截、用量记录都对。
- ⏳ 待办:① Seedance 视频(等火山 ARK key,接口位+并发3已留)② nginx 对外暴露 + 客户端指向网关 + 重打 dmg ③ 按用户发 app 令牌 ④ 规模上来转企业认证 / Redis 共享限流 / 升配。
