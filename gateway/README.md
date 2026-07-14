# 球房 AI 网关阀门(并发控制 + 藏 key + 用量记录)

一台**国内服务器当总闸**,所有用户请求过这一个咽喉,才管得住全局并发 + 每人配额。
桌面 app 只拿 app 令牌,真 key 全在服务器。

## 架构(每家走最近的门)
```
桌面 app(国内) ──app令牌──► 大陆网关(总闸·39.106.214.21:8799)
	                               ├─ MiMo 对话        → 直连小米(国内→国内,快;流式透传)
	                               ├─ GPT 生图/改图     → 转发美国机 /relay(OpenAI 出口)
	                               ├─ 火山豆包视觉/文本  → 直连火山方舟(视频剪辑台"看懂画面"+"配文案/编排风格")
	                               ├─ 火山 Seedream 生图 → 直连火山方舟(原生端点,预留通道)
	                               └─ 语音/口播转写      → 本机 whisper.cpp 或受保护的 Qwen/ASR upstream
```

真平台 key(MiMo/OpenAI/火山 ARK)只在服务器 `gw.env`,客户端一律只带可吊销的 app 令牌——绝不打进 DMG/EXE。

## 三层阀门(`app.ts`)
1. **每家真实限流**(已查证):MiMo 令牌桶(账号 100 RPM 留余量 90)、生图 IPM 令牌桶 + 在途并发信号量、火山豆包视觉/文本令牌桶(默认 30 RPM)、Seedream IPM 令牌桶 + 在途并发。
2. **每用户每日配额**:对话/图/视觉文本/Seedream 图 各自封顶,防一个人烧光、挤垮所有人。
3. **满了排队**(最多等 `GW_QUEUE_MAX_WAIT` 秒)→ 超时背压拒,绝不硬撞 provider 触发 429/封号。

用量全记 SQLite(`/opt/qfgw/usage.db`),`GET /admin/usage?token=...` 查。

## 部署
```bash
# 配置(含 key,chmod 600,不进 git):/opt/qfgw/gw.env —— 见 deploy.sh 注释里的变量清单
scp app.ts transcription.ts gw.env deploy.sh root@<server>:/tmp/
ssh root@<server> 'bash /tmp/deploy.sh'   # Bun+systemd(qfgw)+起服务+healthz
```

## 配置项(环境变量 / `gw.env`)
| 变量 | 说明 |
|---|---|
| `GW_MIMO_KEY` / `GW_MIMO_BASE` | MiMo 真 key + 端点(api.xiaomimimo.com/v1) |
| `GW_RELAY_BASE` / `GW_RELAY_TOKEN` | 美国出口地址(zzyppz.cn/relay/openai/v1)+ 中转令牌 |
| `GW_ARK_KEY` / `GW_ARK_BASE` | 火山方舟真 key + 端点(ark.cn-beijing.volces.com/api/v3)——豆包视觉文本 / Seedream 生图共用同一把 |
| `GW_APP_TOKENS` | `{"令牌":"用户标识"}` —— 发给桌面 app 的令牌→用户映射 |
| `GW_ADMIN_TOKEN` | 看 `/admin/usage` 的口令 |
| `GW_MIMO_RPM` / `GW_IMG_IPM` / `GW_IMG_CONC` | 各家阀门参数 |
| `GW_ARK_CHAT_RPM` | 火山豆包视觉/文本令牌桶(默认 30 RPM) |
| `GW_ARK_IMG_IPM` / `GW_ARK_IMG_CONC` | 火山 Seedream 生图令牌桶 + 在途并发 |
| `GW_Q_CHAT` / `GW_Q_IMG` / `GW_Q_ARK_CHAT` / `GW_Q_ARK_IMG` | 每用户每日配额 |
| `GW_RELAY_TASKS_BASE` | 美国 relay 上 GPT 生图**异步任务服务**地址(`relay/app.ts`,如 `https://zzyppz.cn/relay/imgtasks`)。配了才开 `POST /v1/images/tasks` + `GET /v1/images/tasks/:id`(提交/轮询转发到美国 relay,根治大陆↔美国跨境长连接 60s 被掐);缺则返回 503、客户端退同步路径。当前链路见 `docs/生图-当前能力与设计.md` |
| `GW_TRANSCRIBE_BIN` / `GW_TRANSCRIBE_MODEL` / `GW_FFMPEG_BIN` | 服务器端 whisper.cpp、权重和 FFmpeg 绝对路径；缺失时转录端点失败关闭 |
| `GW_TRANSCRIBE_RPM` / `GW_TRANSCRIBE_CONC` / `GW_Q_TRANSCRIBE` | 转录请求速率、并发和每用户每日配额，当前 CPU 主机固定单并发 |
| `GW_TRANSCRIBE_MAX_BYTES` / `GW_TRANSCRIBE_TIMEOUT_MS` | 上传上限与执行超时；音频只进权限为 700 的临时目录，任务结束即删除 |
| `GW_TRANSCRIBE_PROVIDER` | `whisper` 使用本机 CPU/GPU 引擎；`upstream` 转发到独立 Qwen/ASR 服务，客户端契约不变 |
| `GW_TRANSCRIBE_UPSTREAM_URL` / `GW_TRANSCRIBE_UPSTREAM_TOKEN` | 独立 ASR 的服务器内部地址和凭据，只在 `upstream` 模式使用 |

语音端点为 `POST /v1/audio/transcriptions`，接收 `file`、`language` 与 `response_format=json|verbose_json`。必须使用 app token，不记录音频内容和识别文本。服务器运行时通过 `bash /tmp/deploy-transcription.sh` 安装，脚本固定源码和模型 SHA-256；发布顺序始终是先服务器、后客户端。当前 2 核大陆机使用 `ggml-small-q5_1` 单并发，只作为低频基线；需要聊天级低延迟或 Qwen3-ASR + ForcedAligner 时迁移到 GPU 主机。

服务器变量、nginx、令牌发放和验证步骤见 `docs/服务器与部署-当前拓扑.md`。

## 现状(2026-07-09)
- ✅ 网关已从 FastAPI 迁到 Bun/TS,保留原路径契约、三层阀门、SQLite 用量记录和 app 令牌模式;契约测试覆盖鉴权、配额、对话流式、GPT 生图/改图、ARK、AMAP。
- ✅ 装在大陆机、零干扰现网;MiMo(1.5s)、GPT 生图(国内→美国 16.7s)、ARK/AMAP 通道、401 拦截、用量记录都对。
- ✅ 新加:火山豆包视觉/文本(`/v1/ark/chat/completions`,视频剪辑台 VLM 打分 + AI 导演配文案/编排风格收编)、
  火山 Seedream 生图(`/v1/ark/images/generations`,预留通道)。
- ⏳ 待办:① Seedream 生图通道客户端接入(poster_service.py 仍直连火山,未切到网关这条)② nginx 对外暴露 + 重打 dmg
  ③ 按用户发 app 令牌 ④ 规模上来转企业认证 / Redis 共享限流 / 升配。
