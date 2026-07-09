# video-use 转写引擎 · 补活方案(task #41)

> 📌 状态:🚧进行中 · 任务〈转写引擎补活〉· 建于 2026-07-10
>
> **面向后续实现子代理,照着施工。** 本文只写方案,写这份时**未改任何代码**。
>
> **一手依据(真 clone 读了源码,不是凭记忆):** 已 `gh repo clone browser-use/video-use`,读完 README / SKILL.md / install.md / 全部 helpers(`transcribe.py`/`transcribe_batch.py`/`pack_transcripts.py`/`timeline_view.py`/`render.py`/`grade.py`)。本文"video-use 实情"一节所有结论均引自真源码。
>
> **关联文档:**
> - 研判(需按本文修正)= `docs/plans/video-use-剪辑编排适配研判-2026-07-09.md`
> - 工作台(依赖本文转写)= `docs/plans/生图与剪视频工作台-设计方案.md` §B.5
> - 内核 native 边界铁律 = `ts/CLAUDE.md` §8
> - 视频内核代码 = `ts/src/media/videoEditProjects.ts`
> - **已有 whisper.cpp 先例** = `ts/src/server/services/voiceTranscription.ts`(语音输入已在用 whisper.cpp,spawn 外部二进制,不进 package.json)

---

## 0. 一句话结论

1. **video-use 的转写 = 云端 ElevenLabs Scribe(`scribe_v1`)API,不是 whisper**。它甚至把"本地跑 whisper"明列为反模式(慢、会归一化语气词)。所以**它的转写实现我们一行都抄不了**——我们红线是全本地 + 免登录 + 离线,Scribe 要 key 要联网,直接出局。我们只能抄它转写**之上**那套(phrase 分组 / takes_packed / EDL / self-eval)。
2. **我们选定:whisper.cpp 作 bundled 二进制**(像 ffmpeg 一样 spawn),**不进 package.json、不装 npm、不加 `.node` 原生插件**。理由后述,最硬一条:**项目里已经有这条路在跑**(`voiceTranscription.ts` 已 spawn `desktop/binaries/whisper-cli`)。**⚠️ owner 追加两道硬约束后(2026 中文口播还够准吗 + 必须免费可商用分发),做了完整选型复评,见 §二·补**:结论是**主推仍走 whisper.cpp,但默认模型升到 `large-v3-turbo`(不是 medium),并把 `sherpa-onnx + zipformer-zh-en` 列为拿真口播 A/B 后可上位的并列候选**;更准的中文专用模型(Paraformer/SenseVoice/FireRedASR)因"时间戳 or 许可"卡在硬门外被排除。
3. **端到端一句话:** ffmpeg 抽 16k 单声道音频 → spawn whisper-cli 出词/段级 JSON(缓存到 `edits/<项目>/transcripts/<源>.json`)→ 按静音≥0.5s 分组成 `phrases{start,end,text}` → 回填 `videoEditProjects.ts` 4 处占位(L744 `phrases:[]`、L766/L618 占位字幕、L796/L783 报告口径)→ 派生 `takes_packed.md` 喂时间线/字幕/工作台。
4. **中文有坑:** whisper.cpp 的 `--max-len 1`(逐词切)对中文 CJK **产出乱码、不可用**(官方 issue #761)。中文正解 = **段级时间戳 + 静音分割**(正好对齐 video-use 的 phrase 级),需要更细就上 **`--dtw` DTW token 级时间戳**(`t_dtw`),不要用 `--max-len 1`。

---

## 一、video-use 转写那环的真源码实情(一手,凭真读的)

### 1.1 用什么转写 —— 云端 ElevenLabs Scribe,明确拒绝本地 whisper

`helpers/transcribe.py` 真代码:

- 端点 `SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text"`,模型 `model_id = "scribe_v1"`。
- 认证:HTTP header `xi-api-key: <ELEVENLABS_API_KEY>`(从 repo 根 `.env` 或环境变量读)。
- 抽音频:`ffmpeg -y -i <video> -vn -ac 1 -ar 16000 -c:a pcm_s16le <tmp.wav>`(**单声道 16kHz PCM WAV**)。
- 上传参数(multipart form):
  ```
  model_id=scribe_v1
  diarize=true              # 说话人分离
  tag_audio_events=true     # 标 (laughter)/(applause)/(sigh) 等音频事件
  timestamps_granularity=word   # 词级时间戳
  language_code=<可选>      # 省略则自动检测
  num_speakers=<可选>
  ```
- 缓存:结果整包 JSON 写 `<edit_dir>/transcripts/<视频名>.json`,**文件存在就跳过上传**(每源只转一次,SKILL.md 硬规则 #9)。
- 批量:`transcribe_batch.py` = 4 并发 `ThreadPoolExecutor` 跑同一个 `transcribe_one`,同样 per-file 缓存。

> **SKILL.md 反模式区原话(直接决定我们不能抄):**
> - "Running Whisper locally on CPU. Slow and it normalizes fillers. Use hosted Scribe."
> - "Word-level verbatim ASR only. Never SRT/phrase mode(loses sub-second gap data). Never normalized fillers."
>
> 也就是说 video-use 的产品前提是"联网 + 有 Scribe key",跟我们"全本地离线免登录"正好相反。**这是本方案与 video-use 唯一的根本分叉点。**

### 1.2 词级时间戳怎么产出 —— Scribe 直接给 `words[]`

Scribe 返回 JSON 里有一个 `words` 数组,每个元素结构(从 `pack_transcripts.py` 消费逻辑反推,确凿):

```jsonc
{
  "words": [
    { "type": "word",        "text": "Ninety",  "start": 2.52, "end": 2.79, "speaker_id": "speaker_0" },
    { "type": "spacing",     "text": " ",        "start": 2.79, "end": 2.83 },   // 词间空隙,携带静音信息
    { "type": "audio_event", "text": "laughter", "start": 5.10, "end": 5.60, "speaker_id": "speaker_0" },
    ...
  ]
}
```

- `type` 三种:`word`(正文词)、`spacing`(词间空隙,`end-start` = 静音时长)、`audio_event`(笑声等)。
- 词级时间戳就是每个 `word` 的 `start`/`end`(秒)。
- `speaker_id` 形如 `speaker_0`。

### 1.3 `takes_packed.md` 怎么来 —— phrase 分组(LLM 的主读视图)

`helpers/pack_transcripts.py` 把 `transcripts/*.json` 的 `words[]` 压成 phrase 级 markdown:

- **分组规则(`group_into_phrases`):遇到以下任一就断句成新 phrase:**
  1. 静音 ≥ `silence_threshold`(默认 **0.5s**)—— 通过 `spacing` 条目的 `end-start`,或相邻保留 token 的 `start - prev_end` 判定;
  2. `speaker_id` 变化。
- 每个 phrase = `{start, end, text, speaker_id}`。`text` = 组内 `word`+`audio_event` 文本用空格拼接,`audio_event` 补上括号 `(laughter)`,再把 ` ,`→`,` 等标点粘回。
- 输出 `<edit>/takes_packed.md`,每行格式:
  ```
  ## C0103  (duration: 43.0s, 8 phrases)
    [002.52-005.36] S0 Ninety percent of what a web agent does is completely wasted.
    [006.08-006.74] S0 We fixed this.
  ```
  时间戳 `[start-end]` 固定 6 字宽(`{:06.2f}`),`S0` = 去掉 `speaker_` 前缀的说话人号。
- 卖点:一小时素材压到 ~12KB,LLM 只读它选切点、不逐帧看视频。EDL 里就用这些 `[start-end]` 区间寻址下刀。

### 1.4 `timeline_view` PNG 怎么来(按需可视,非扫描)

`helpers/timeline_view.py`(纯 ffmpeg + PIL + numpy,无云):

- ffmpeg 每隔均匀时间抽 N 帧(默认 10,`-frames:v 1 -vf scale=320:-2`)拼成 filmstrip。
- 波形:ffmpeg 抽 16k 单声道 PCM → python `wave` 模块读 → numpy 窗口 RMS 包络(不硬依赖 librosa)。
- 叠加:从同源 transcript 读 `words` 画词标签 + 静音带(gap≥0.4s 阴影)+ 时间刻度尺。
- 只在决策点调(歧义停顿、重拍对比、切点复核),不在扫描循环里用。

### 1.5 整条管线每步真实现(Transcribe → Pack → LLM Reasons → EDL → Render → Self-Eval)

| 步 | 真实现 | 关键文件 |
|---|---|---|
| **Transcribe** | Scribe `scribe_v1` 云 API,词级 + 说话人 + 音频事件,per-source 缓存 JSON | `transcribe.py` / `transcribe_batch.py` |
| **Pack** | words→phrase(静音≥0.5s 或换人断句)→ `takes_packed.md` | `pack_transcripts.py` |
| **LLM Reasons** | **就是主编辑 LLM 自己**读 `takes_packed.md`(+ 决策点按需 `timeline_view` PNG)选 take/切点。**没有独立 VLM、没有打分函数**(SKILL.md 明列"hand-tuned moment-scoring functions"为反模式) | SKILL.md 流程 §5 + "Editor sub-agent brief" |
| **EDL** | 产出 `edl.json`:`{version, sources{name:path}, ranges[{source,start,end,beat,quote,reason}], grade, overlays[], subtitles, total_duration_s}`;切点须落词边界、两侧 padding 30–200ms、优先静音≥400ms 处 | SKILL.md "EDL format" |
| **Render** | 逐段抽取(grade + **30ms 音频淡入淡出** baked in)→ 无损 `-c copy` concat 成 base → filter_complex 叠 overlay(`setpts=PTS-STARTPTS+T/TB` 移位)→ **字幕最后烧(Rule 1)** → 两遍 loudnorm(**I=-14:TP=-1:LRA=11**) | `render.py` |
| **Self-Eval** | 对**渲染成品**在每个切点 ±1.5s 跑 `timeline_view`,查视觉跳变/爆音/字幕被遮/overlay 错帧;首尾 2s + 2~3 中点查 grade/字幕;ffprobe 核时长。不过 → 修 → 重渲,**最多 3 轮**,仍不过就报给用户 | SKILL.md 流程 §7 |

**master SRT(render.py `build_master_srt`)细节**(我们要抄的字幕对齐算法):
- 输出时间线偏移:`out_time = word.start - segment_start + segment_offset`(Rule 5,concat 后不错位)。
- 默认 2 词一组、遇标点断、**全大写**、`FontName=Helvetica,FontSize=18,Bold=1,...,Alignment=2,MarginV=90`。
- ⚠️ **2 词大写是英文玩法**,中文无空格分词、也不大写 → 我们中文字幕要改成"按 phrase/字数分块",见 §三.6。

---

## 二、我们选定的转写方案 + 理由

### 2.1 为什么不能照抄(红线冲突,一句话)

| video-use | 我们的红线 | 冲突 |
|---|---|---|
| 云 ElevenLabs Scribe,要 `ELEVENLABS_API_KEY`,要联网 | **全本地 + 免登录 + 离线 + 全内置分发**(权重/二进制打进 EXE、开箱即用不联网不配 key) | 直接互斥,Scribe 出局 |

所以研判文档里"内置 whisper sidecar **或** 云转写 provider 二选一"的说法要收紧:**红线强制走本地 whisper,云那条不成立。**

### 2.2 候选对比(四条路)

| 方案 | 词级时间戳 | 中文口播 | Windows 打包 | 动 package.json? | 离线 | 许可 | 结论 |
|---|---|---|---|---|---|---|---|
| **① whisper.cpp 作 bundled 二进制**(spawn,像 ffmpeg) | ✅ 段级(`-oj`)稳;词/token 级用 `-ojf --dtw`(`t_dtw`) | ✅ 段级+静音分割对中文最稳;**别用 `--max-len 1`**(CJK 乱码,issue #761) | ✅ 官方发 `whisper-bin-x64.zip`(`whisper-cli.exe`+`whisper.dll`+ggml dll),单文件夹丢 `desktop/binaries/` | ❌ **不动**(不是 npm 依赖,是二进制随包) | ✅ | MIT | **✅ 选它** |
| ② smart-whisper(npm 绑定 whisper.cpp) | ✅ 有 word ts | ✅ 同 whisper.cpp | 🟡 native `.node` 要跟平台编译/预编译 | ⚠️ **要改 package.json**(现只在 `trustedDependencies` 挂名、未真装) | ✅ | MIT | ❌ 撞 package.json + `.node` 在 Bun 进程内有段错误风险(§8 bun#28008 一类) |
| ③ faster-whisper / CTranslate2 | ✅ word ts | ✅ 好 | 🔴 要带 Python/CTranslate2 运行时,打进 Windows EXE 很重很脆 | ⚠️(另拉运行时) | ✅ | MIT/BSD | ❌ Windows 打包代价最高 |
| ④ transformers.js + onnxruntime-node | 🟡 弱 | 🟡 一般 | 🔴 服务端是**原生 onnxruntime-node**,**Bun+Windows 段错误**(§8/bun#28008),必须另起 Node sidecar | ⚠️ | ✅ | 各异 | ❌ 正是 §8 点名的雷 |

### 2.3 选定 = ① whisper.cpp bundled 二进制,五条理由

1. **项目里已经在用**:`voiceTranscription.ts`(语音输入)已经 spawn `desktop/binaries/whisper-cli[.exe]` + `ggml-*.bin`,`whisperCppCommand()` 现成、`resolveExecutable`/`resolveWhisperModel` 现成。**扩展它、不重造。**
2. **不动 package.json**:whisper-cli 是外部二进制(跟 ffmpeg、跟现有 `backend-sidecar-*.exe` 一个待遇),丢 `desktop/binaries/` 由 `electron-builder.yml` `extraResources` 随包。所以**不受"前端 React 地基要先腾 package.json"阻塞**——这正是 owner 让优先评估这条的原因。
3. **不碰 §8 的雷**:我们是 `child_process.spawn` 一个**外部 OS 进程**(whisper-cli.exe),**不是**在 Bun 进程里 `require('*.node')` 原生插件。§8 的段错误只针对 `.node`(smart-whisper/onnxruntime-node),**spawn 外部 exe 完全安全**(voiceTranscription 已证)。→ **纠正研判 §五(1) 的"whisper sidecar"措辞:不需要另起 Node 子进程包一层,Bun 后端直接 spawn 二进制即可。**
4. **Windows 打包最干净**:官方 release 直接给 x64 预编译 `whisper-cli.exe`(+ `whisper.dll`/`ggml*.dll`),放进 `desktop/binaries/` 完事;权重 `ggml-*.bin` 也只是文件,一起打包。全内置离线,零联网零 key。
5. **许可 MIT**,可自由分发进 DMG/EXE。

### 2.4 词级时间戳的具体拿法(中文关键)

whisper.cpp `whisper-cli` 输出档位:

- `-oj` / `--output-json`:段级 JSON。结构:`transcription[]`,每段 `{ timestamps:{from,to}, offsets:{from,to}(毫秒), text }`。**中文最稳的基线。**
- `-ojf` / `--output-json-full`:加 per-token `tokens[]`,每 token 有 `text`、`id`、`p`(置信)、`offsets{from,to}`,开了 DTW 还有 `t_dtw`。
- `--dtw <preset>`(如 `--dtw medium` / `--dtw large.v3`):启用 **DTW 交叉注意力对齐**出 token 级时间戳(`t_dtw`),比 `--max-len 1` 准得多、**且对中文可用**。
- ⚠️ **`--max-len 1`(逐词切段)对中文 CJK 出乱码、时间戳不可靠**(官方 issue #761 确认)——**禁用于中文**。

**我们的中文策略(分两级,先段级即可满足工作台):**
- **P0 = 段级 `-oj`**:whisper.cpp 段级 = 天然的"呼吸/短语组",直接当 video-use 的 phrase 用;再按段间静音≥0.5s 合并/拆分对齐 `takes_packed` 规则。**中文口播剪辑(按短语下刀、不切半句)段级足够。**
- **P1(要更细才做)= `-ojf --dtw <preset>`**:拿 `t_dtw` token 级时间戳做"吸附到最近字/词边界"。中文的"词边界"退化为"字/短语边界",DTW 的 token 边界够用。

### 2.5 模型选型(Windows CPU + 中文口播 + 体积无所谓)

| 模型 | 大小 | 中文口播 | CPU 速度 | 选? |
|---|---|---|---|---|
| tiny / base | 75MB / 142MB | 弱,中文常错 | 快 | ❌ 太差 |
| small | 466MB | 尚可 | 快 | 🟡 低配兜底 |
| **medium** | **1.5GB** | **好** | 中(CPU 可接受) | ✅ **默认档** |
| large-v3 | 2.9GB | 最好 | 慢(纯 CPU 偏重) | 🟡 高质量可选 |
| medium-q5_0 / large-v3-q5_0(量化) | ~514MB / ~1.1GB | 接近未量化 | 更快、更小 | ✅ **推荐:默认用 medium-q5_0,兼顾质量/速度/体积** |

**推荐(经 §二·补 复评修正):默认打包 `ggml-large-v3-turbo`(量化 q5_0/q8_0,~0.8–1.6GB)** —— turbo 中文质量≈large-v3、CPU 解码快得多,比原来的 medium 明显更准。体积无所谓,这个升级零成本。`voiceTranscription.ts` 的 `resolveWhisperModel` 已支持 `WHISPER_MODEL_PATH`/`WHISPER_MODEL_DIR` 环境变量选模型,沿用。

---

## 二·补、转写引擎选型对比(2026)+ 最终推荐

> **owner 追加两问 + 一道一票否决硬约束,专门复评"whisper 中文口播够不够准 / 有没有更该换的本地方案":**
> 1. 截至 2026,whisper(whisper.cpp)对中文口播还够准吗?
> 2. 有没有更准的本地方案该换掉?
> 3. **(一票否决)必须免费:零使用成本(无云/订阅/按量)+ 许可证允许免费商用并随 DMG/EXE 分发。**
>
> 方法同读 video-use:`gh` 查仓库/许可 + `WebSearch`/`WebFetch` 查 2026 中文 ASR CER 基准 + 真读候选文档,不凭记忆。来源列在本节末。

### 2·补.1 硬过滤门(任一不过 = 直接淘汰,不是打分项)

1. **免费零使用成本**:不能收费 API/订阅/按量;权重+二进制+运行全程零花钱。
2. **许可证免费商用 + 可随产品分发**:MIT/Apache-2.0/BSD 放行;**自定义"仅供研究/学习"、CC-BY-NC、copyleft 传染(GPL 类)、或模型权重单独有商用限制的 → 排除或高危**。
3. **全本地离线**(无联网、无 key)。
4. **Windows 可打包**,且优先 **spawn 外部二进制**(避开 `ts/CLAUDE.md` §8:Bun+Windows 载 `.node` 原生插件段错误 bun#28008)。
5. **词/token 级时间戳**——"改台词=改视频/点词跳帧"必须有,**没有直接淘汰**。
6. **CPU 友好**(客户机多半无 GPU)。

### 2·补.2 候选对比大表(2026)

| 引擎/模型 | 中文口播准确率(CER,有据) | 词/token 时间戳 | 离线 | Windows 打包 | §8 原生崩溃风险 | 模型大小 / CPU | 许可证 | **免费可商用分发?** | 硬门结论 |
|---|---|---|---|---|---|---|---|---|---|
| **whisper.cpp · large-v3 / large-v3-turbo** | AISHELL-1 **5.14%**(clean 口播接近此档);噪声会议 ~18–20% | ✅ 段级 + **DTW token 级**(`t_dtw`),可靠 | ✅ | ✅ 官方预编译 exe,spawn | ✅ 无(spawn 外部 exe) | 中(turbo 量化 CPU 可接受) | **MIT(码+OpenAI 权重都 MIT)** | ✅ **干净放行** | ✅ **过 · 主推** |
| **sherpa-onnx · zipformer-zh-en transducer** | 具体 CER 官方页未给数字(需真口播 A/B) | ✅ **原生 token 级**(`"timestamps":[...]`) | ✅ | ✅ 预编译 `sherpa-onnx-offline.exe`,spawn | ✅ 无(spawn 外部 exe;ONNX 在该进程内跑,不入 Bun) | int8 **~72MB**、CPU 极快 | **Apache-2.0(sherpa-onnx + icefall 模型)** | ✅ **干净放行** | ✅ **过 · 并列候选(A/B 后可上位)** |
| sherpa-onnx · **Paraformer-zh** | **1.68%**(最准之一) | ❌ **sherpa-onnx 运行时不吐时间戳**(多变体确认,`timestamps:[]`) | ✅ | ✅ | ✅ | int8 ~79–234MB、CPU 极快 | 权重=**FunASR 自定义"模型开源许可 v1.1"**("仅供参考学习",非 MIT/Apache) | ⚠️ **存疑/高危** | ❌ **淘汰**(无时间戳 **且** 权重许可商用存疑) |
| **SenseVoice-Small**(FunAudioLLM) | **2.96%**(很准 + 15× 快) | 🟡 CTC 对齐(2024-11 加),粒度弱 | ✅ | ✅(sherpa-onnx) | ✅ | 234M、<1GB、极快 | LICENSE 直接指向 **FunASR 自定义模型许可**;云端(百炼)已宣布弃用迁 Fun-ASR/Paraformer-v2 | ⚠️ **存疑/高危** | ❌ **淘汰**(权重许可商用存疑 + 时间戳弱 + 官方弃用信号) |
| FireRedASR-**AED**(小米) | AISHELL-1 **1.76%**、均值 3.18%(SOTA 级) | ✅ v2-AED 有 CTC 词级时间戳 | ✅ | 🟡(sherpa-onnx 支持) | ✅ | **1.1B,CPU 慢、模型大** | 仓库 **Apache-2.0**(权重许可需最终核) | 🟡 大概率可,但重 | 🟡 **备选**(极致准但 CPU 太重,预算够再评估) |
| FireRedASR-**LLM**(8B) | 更准(0.64%) | ❌ 无时间戳 | ✅ | 🔴 要 GPU | — | 8B,≥32GB VRAM | Apache-2.0 | — | ❌ **淘汰**(无时间戳 + 要 GPU) |
| faster-whisper(CTranslate2) | ≈whisper | ✅ word ts | ✅ | 🔴 带 Python/CTranslate2 运行时,Windows 打包重且脆 | ⚠️(另拉运行时) | 中 | MIT | ✅ | ❌ **淘汰**(Windows 打包代价高) |
| NVIDIA NeMo · Parakeet/Canary | Parakeet=英文;Canary 中文弱 | ✅(英文) | ✅ | 🔴 PyTorch 重 | — | 大 | 权重多为 **CC-BY-NC / NVIDIA 许可**(常**非商用**) | ⚠️/❌ | ❌ **淘汰**(中文弱 + 许可常非商用 + 重) |
| Moonshine(-zh) | 英文强;zh-tiny 27M 质量一般 | 🟡 | ✅ | ✅(sherpa-onnx) | ✅ | 27M 极小 | MIT | ✅ | 🟡 仅低配兜底(中文一般) |
| transformers.js + onnxruntime-node | 中文一般 | 🟡 弱 | ✅ | 🔴 **onnxruntime-node 在 Bun+Windows 段错误**(§8/bun#28008),必须另起 Node sidecar | 🔴 高 | 大 | 各异 | — | ❌ **淘汰**(正是 §8 点名的雷) |

### 2·补.3 关键发现(别嘴硬:中文专用模型确实更准,但被硬门卡住)

1. **whisper 中文确实不是最强**:2026 基准里,中文专用模型 CER 显著低于 whisper large-v3(AISHELL-1:Paraformer 1.68% / SenseVoice-Small 2.96% / FireRedASR-AED 1.76% **对** whisper large-v3 5.14%;真实会议场景 whisper 更是掉到 ~18–20%)。owner 的质疑成立。
2. **但"更准"那几个在我们的组合硬门下各自出局**——这是本次复评最重要的结论:
   - **Paraformer**:可打包的离线运行时(sherpa-onnx)**不吐时间戳**(官方多变体确认),直接违反"必须有词级时间戳";且权重是 **FunASR 自定义模型许可**(原文"仅供参考学习",非 MIT/Apache),商用随包分发存疑。**双杀。**
   - **SenseVoice**:仓库 LICENSE 直接指向同一份 **FunASR 自定义模型许可** → 商用分发同样存疑;叠加云端官方已宣布弃用(迁 Fun-ASR/Paraformer-v2)+ 时间戳粒度弱。**许可 + 弃用双风险。**
   - **FireRedASR-AED**:准且有词级时间戳、仓库 Apache-2.0,但 **1.1B、CPU 慢、模型大**;LLM 版无时间戳且要 GPU。
3. **同时满足"够准中文 + 可靠时间戳 + 干净 MIT/Apache 免费商用 + spawn 二进制离线 Windows + 无 §8"的,现实只剩两个:whisper.cpp(large-v3/turbo)与 sherpa-onnx zipformer-zh-en。** 这不是因为它们中文最准,而是因为别的都在某道硬门上掉了。

### 2·补.4 最终推荐

- **主推(可直接开工,风险最低):whisper.cpp,默认模型升到 `large-v3-turbo`(量化)。**
  - 为什么不是更准的中文模型:它们卡在"时间戳缺失 / 许可商用存疑",过不了硬门(见 2·补.3)。
  - 为什么是它:**MIT(代码+OpenAI 权重都 MIT,免费商用随包最干净)**、**DTW 词级时间戳可靠**、**已集成**(`voiceTranscription.ts`)、零 package.json、零 §8、离线。口播是较干净语音、更贴近 5% 而非 20% 那档,**large-v3(turbo)中文口播够用**;turbo 量化在 CPU 上比 large-v3 快很多、质量≈large-v3。比原方案的 medium 明显更准,升级零成本。

- **并列候选(拿真店主口播 A/B 后若明显更准/更快,可上位主推):`sherpa-onnx-offline.exe` + `zipformer-zh-en` transducer。**
  - 优点:**Apache-2.0(码+模型都干净可商用)**、**原生 token 级时间戳**、int8 **仅 ~72MB**、CPU 极快、同样 **spawn 外部二进制**(零 package.json、零 §8;ONNX 跑在该 exe 进程内、不进 Bun)。
  - 唯一不确定:该模型中文 CER 官方页没给硬数字,**必须用真口播 A/B 验证是否明显赢 whisper**;赢了就换主推(它更小更快)。这是"先验证后定"的一步,不拍脑袋。

- **明确排除(哪怕 CER 更低)**:Paraformer(无时间戳 + 权重许可存疑)、SenseVoice(权重许可存疑 + 云弃用 + 时间戳弱)、FireRedASR-LLM(无时间戳 + 要 GPU)、NeMo(中文弱 + 许可常非商用 + 重)、faster-whisper/transformers.js-onnx(Windows 打包重 或 §8 Bun 原生崩溃)。**FireRedASR-AED** 留作"未来极致中文准 + CPU 预算够"的再评估项(需最终核权重商用许可)。

### 2·补.5 迁移代价 · 是否动 package.json

- **两个推荐都是 spawn 外部二进制 → 零 package.json 改动、零 §8 原生插件风险**(与原 whisper.cpp 方案同架构,不受"前端 React 地基先腾 package.json"阻塞)。
- **选 whisper large-v3-turbo:迁移≈零** —— 只换 `desktop/binaries/models/` 里的权重文件,转写模块沿用 §三(加 `-oj`/`-ojf`/`--dtw` 解析)。
- **选 sherpa-onnx zipformer:小迁移** —— `desktop/binaries/` 加 `sherpa-onnx-offline.exe`(+ 依赖 dll)+ zipformer onnx 三件套(encoder/decoder/joiner)+ `tokens.txt`;转写模块把 spawn 目标与 JSON 解析换成 sherpa-onnx 格式(它的 JSON 直接带 `text`+`tokens`+`timestamps`,解析比 whisper 更简单)。**下游 phrases 分组 / takes_packed / 回填占位全不变。**
- 建议:**先按主推(whisper large-v3-turbo)落地跑通 §三 全链路,同时抓一段真店主口播对 sherpa-onnx zipformer 做一次 A/B**,数据说话再决定要不要切主推。两条都过硬门,切换成本低,不必现在死磕。

### 2·补.6 本节来源(2026 复评)

- 基准/CER:FunASR-vs-Whisper 中文基准(SenseVoice 7.81% / Paraformer 10.18% / whisper-large-v3 20.02%;AISHELL-1 SenseVoice-Small 2.96% vs whisper 5.14%);"ASR in 2025-2026 深评"(Paraformer-Large 1.68%、FireRedASR2-AED 0.57%、CPU RTF 0.05–0.1、时间戳能力、sherpa-onnx 部署);FireRedASR 论文(arXiv 2501.14350,AED 均值 3.18%、AISHELL-1 1.76%)。
- 时间戳/运行时:sherpa-onnx 官方文档(offline 支持 Whisper/Paraformer/SenseVoice/Zipformer/NeMo/Moonshine/FireRedASR;预编译 Windows x64 CLI `sherpa-onnx-offline`;**Paraformer 变体 `timestamps:[]` 不吐时间戳**;zipformer-zh-en `timestamps:[...]` 原生 token 级)。
- 许可(逐个核过):whisper.cpp **MIT**、sherpa-onnx **Apache-2.0**、FunASR 工具链 **MIT** 但**模型权重 = FunASR 自定义"模型开源许可 v1.1"("仅供参考学习")**、SenseVoice LICENSE **指向 FunASR 该许可**、FireRedASR 仓库 **Apache-2.0**(`gh api .../license` + 读 raw LICENSE/MODEL_LICENSE 实核)。

---

## 三、端到端落地设计

> 全部落在 `ts/src/media/`(内核),复用 `videoEditProjects.ts` 已有的 ffmpeg 封装与 `voiceTranscription.ts` 已有的 whisper.cpp 封装。产物进 `edits/<项目>/`,对齐 video-use "所有产物进 edit 目录"。

### 3.1 流水线总览

```
源视频(有音轨)
  └─(1) ffmpeg 抽音 → 16kHz 单声道 wav
        └─(2) spawn whisper-cli -oj [-ojf --dtw] → 词/段级 JSON
              └─(3) 缓存 edits/<项目>/transcripts/<源stem>.json   (per-source,存在即跳过)
                    └─(4) 分组 → phrases[{start,end,text,(speaker)}]  (静音≥0.5s 断句)
                          ├─(5a) 回填 videoEditProjects 占位点(见 3.5)
                          ├─(5b) 派生 edits/<项目>/takes_packed.md
                          └─(5c) 喂时间线字幕 / 工作台 / 后续 Pack→Reasons→EDL
```

### 3.2 (1) 抽音频 —— 复用已有 ffmpeg

- 复用 `videoEditProjects.ts` 的 `ffmpegBin(env)`(L408)与 `runProcess`(L448);参数照 video-use/voiceTranscription:`-vn -ac 1 -ar 16000 -c:a pcm_s16le`(或 `voiceTranscription.convertToWav` 的 `-ar 16000 -ac 1`)。
- 输出临时 wav 到 `mkdtemp`,转写完删。

### 3.3 (2)(3) 转写模块 —— 扩展 whisper.cpp 封装,per-source 缓存

**新建 `ts/src/media/videoTranscribe.ts`**(或在 `videoEditProjects.ts` 内加私有方法),导出:

```ts
export interface TranscriptWord { start: number; end: number; text: string; speaker?: string }
export interface TranscriptPhrase { start: number; end: number; text: string; speaker?: string }
export interface VideoTranscript {
  source: string          // 源片 stem
  language: string        // 'zh'
  duration: number
  words: TranscriptWord[]  // token/段级(段级时 words≈phrases)
  phrases: TranscriptPhrase[]
}
export async function transcribeVideoWordLevel(
  videoPath: string,
  editDir: string,        // edits/<项目>/
  opts: { env?; signal?; language?; onProgress?; wordLevel?: boolean }
): Promise<VideoTranscript>
```

实现要点:
- **复用 `voiceTranscription.ts` 的 whisper.cpp 解析封装**:`whisperCppCommand` / `resolveExecutable`(找 `desktop/binaries/whisper-cli[.exe]`)/ `resolveWhisperModel`。把 `-otxt` 换成 **`-oj`**(段级)或 **`-ojf --dtw <preset>`**(要 token 级时);语言固定 `-l zh`(§3.7)。
- **缓存**:输出 `editDir/transcripts/<stem>.json`,**存在即读缓存跳过**(对齐 video-use Rule 9 / voiceTranscription 无此缓存,这里新增)。缓存键 = 源片路径 + mtime(源变了才重转)。
- 解析 whisper.cpp JSON:段级取 `transcription[].offsets.from/to`(毫秒 → 秒)+ `text`;token 级取 `tokens[].t_dtw`/`offsets`。中文把每段当一个 phrase 基元。
- **建议独立小工具方法可单测**(纯函数解析 whisper JSON → phrases,行为对齐测试锁边界)。

### 3.4 (4) phrases 分组 —— 抄 pack_transcripts 的规则

- 移植 `group_into_phrases` 逻辑到 TS:**静音 ≥ 0.5s 断句**(中文再叠加"whisper 段边界"作天然断点),得 `phrases[{start,end,text}]`。
- 中文没有 `spacing` token 的话,用相邻段/词的 `start - prev_end ≥ 0.5` 判静音。

### 3.5 (5a) 回填 `videoEditProjects.ts` 占位点 —— **具体改这几处**

> 现状:媒体后端(老 Python)已删,`createLocalPlan`/`autoCaption` 全占位。真实行号见下(已核对当前文件)。

| # | 位置 | 现在(占位) | 改成 |
|---|---|---|---|
| **1** | `createLocalPlan` L744 `phrases: []` | 空数组 | 调 `transcribeVideoWordLevel(item.src, editDir, {language:'zh'})`,把返回 `phrases` 填进 `candidates[i].phrases`(仅当 `item.health.has_audio`) |
| **2** | `createLocalPlan` L766 字幕文本 `口播片段 N`/`门店高光 N` | 硬编占位 | speech 模式:用该镜头覆盖时间段内的 `phrases` 真台词生成 caption clips(按 phrase 时间切多条字幕,而非一条占位);无音轨/无台词才回退占位 |
| **3** | `createLocalPlan` L783 report + L796 `used_vlm` + L797 `has_speech` | "真实转写…仍需媒体后端" | report 改"已本地转写口播(whisper-cli/离线)";`has_speech` 用真转写是否出 phrases 判定;`used_vlm` 维持 false(video-use 本就无独立 VLM,见 §一.5,别虚报) |
| **4** | `autoCaption` L594 起(L618 `镜头 N`、L633 message) | 生成"镜头 N"占位、message 说依赖后端 | 有音轨:转写 → 按 phrases 生成真台词字幕 clips(每 phrase 一条,start/end 用真时间戳);message 改"已本地转写口播生成字幕";无音轨回退占位并说明 |
| **5** | `recaption` L637 / `editFeedback` L652 占位 | 占位文案 | **本轮不动**(这属 Pack→LLM Reasons 阶段,靠编排 LLM 读 takes_packed 重写,见 §五)。保留占位,message 更新为"文案重写待接编排 LLM" |

> 落点原则:**转写结果进 `TimelineDoc`/candidates,不新起数据结构**(研判 §三.1 铁律)。字幕仍走现有 `caption` 轨 + `captionsToSrt`(L434)+ `renderProject` 烧录链路。

### 3.6 (5b) 派生 `takes_packed.md` + (5c) 喂下游

- **takes_packed.md**:移植 `pack_transcripts.render_markdown` 到 TS,写 `edits/<项目>/takes_packed.md`,格式照 §一.3(中文行:`[start-end] 文本`,可无 speaker 标)。给后续编排 LLM 只读它选切点/重写文案。
- **喂时间线/字幕**:phrases → caption clips(§3.5 #2/#4)→ `docView.captions`(L996)→ 工作台字幕轨/预览 DOM 浮层直接消费(工作台方案 §B.5 缺口即此补上)。
- **喂工作台"按台词剪"**:phrases 的 `{start,end}` 给前端做"点词跳帧 / 按 phrase trim";whisper 段级已够 P0,DTW token 级(P1)再解锁更细吸附。
- **中文字幕分块(替代 video-use 2-词大写)**:按 phrase 出字幕;过长 phrase 按 ~12–16 字或标点软换行;不大写。`captionsToSrt`/`SUB_FORCE_STYLE` 相应用中文字体(§四)。

---

## 四、进度上报 / 长视频分段 / 中文 / 错误兜底

- **进度上报**:复用 `LocalVideoJobOptions.onProgress`(videoEditProjects L58)。转写在 `createLocalPlan` 的 8%~35% 探测段之后插入,按"第 i/N 个源片转写中"吐大白话(如"正在听懂第 2/3 段口播")。whisper-cli 有 stderr 进度,可解析百分比细化;不解析就按源片计数粗报。
- **长视频分段**:whisper.cpp 本身能整段跑(内部 30s 窗滑动),**默认整片交给它**;超长(如 >20 分钟)可选先 ffmpeg 按静音/固定时长切块并行转、再拼时间戳(加偏移),作后置优化,P0 不做。
- **中文**:固定 `-l zh`(`voiceTranscription` 默认已 `WHISPER_LANGUAGE || 'zh'`);模型选 medium-q5_0+(§2.5);**禁 `--max-len 1`**;字幕中文字体(Windows 用 `Microsoft YaHei`/思源黑体,`SUB_FORCE_STYLE` 的 `FontName` 换掉 Helvetica,字体文件确保随包或用系统自带)。
- **错误兜底**(不崩循环,错误文本回灌):
  - 二进制/模型缺失 → 回退现有占位路径(`口播片段 N`)+ message 说明"本地转写不可用",**不报错中断出片**;
  - 无音轨(`has_audio=false`)→ 跳过转写走占位(现 `footageHealth` 已判 speech 模式无音轨);
  - whisper-cli 超时(沿用 voiceTranscription `timeoutMs`)/非零退出 → 记 warning,该源退占位;
  - 转写出空 → 退占位;
  - 全程 `signal` 可取消(对齐 `runProcess` 的 abort)。

---

## 五、转写之上:后续接 Pack → LLM Reasons → EDL(标"先转写、后这些")

> **顺序铁律:先把 §三 转写落地(P0),下面这些是 P1+,依赖转写已就绪。**

1. **Pack**(P0 顺带):§3.6 的 `takes_packed.md` 已在本方案内,转写一好就派生。
2. **LLM Reasons**(P1):不新造 VLM/打分函数(video-use 反模式)。让**编排 LLM**读 `takes_packed.md`(决策点可选后端派生的 timeline PNG,或前端自足波形)选 take/切点/重写文案 → 落 `recaption`/`editFeedback`(§3.5 #5)。
3. **EDL**(P1):video-use 的 `edl.json` ≈ 我们的 `TimelineDoc` + 原子操作。**映射:** EDL `ranges[{source,start,end}]` → 我们 `add_media`+`add_clip`(`src_in/src_out`);`grade` → `set_grade`;`subtitles` → caption 轨。**不引入 video-use 的 EDL 文件格式,统一发原子操作**(`applyOperations` L574)进现有时间线——研判 §三.1 已定。
4. **切点手艺**(P1,不依赖大模型,可与转写并行排期):按词/短语边界下刀、两侧 30–200ms padding、切点 30ms `afade`、渲染后 self-eval(ffprobe 复验 + 切点体检)。这批研判 §五(3) 已列,转写就绪后"不切半句"才能真做。
5. **中文字幕对齐**(P1):抄 render.py `build_master_srt` 的输出时间线偏移算法(`out = word.start - seg_start + seg_offset`),但分块/大小写按中文改(§3.6)。

---

## 六、实现步骤清单(给后续实现子代理直接照做)

> **标注:全清单 0 步动 package.json**(whisper.cpp 是 bundled 二进制,不是 npm 依赖)。唯一"外部资产"步是往 `desktop/binaries/` 放二进制+权重,由 owner 确认打包。

**A. 打包资产(一次性,需 owner 点头下载)**
1. 从 whisper.cpp 官方 release 取 Windows x64 预编译:`whisper-cli.exe` + `whisper.dll` + `ggml*.dll` → 放 `ts/desktop/binaries/`(与现有 `backend-sidecar-*.exe` 同级)。mac 自测可另放 `whisper-cli`(arm64)。
2. 下载 **`ggml-large-v3-turbo`(量化 q5_0/q8_0,默认,§二·补 复评定)** → 放 `desktop/binaries/models/`(或由 `WHISPER_MODEL_DIR` 指)。**并列候选 A/B 用**:另下 `sherpa-onnx-offline.exe`(+ dll)+ `sherpa-onnx-zipformer-zh-en` 的 encoder/decoder/joiner onnx + `tokens.txt`,拿一段真店主口播对比 CER/时间戳/速度,数据决定是否切主推(见 §二·补.4/.5)。
3. 确认 `electron-builder.yml` `extraResources`(现已 `desktop/binaries → binaries`)把二进制+模型随包;prod 从 `process.resourcesPath/binaries` 找(voiceTranscription 的 `resolveExecutable` 已含该模式,核对 models 路径解析一并覆盖)。

**B. 转写模块(纯代码,不动 package.json)**
4. 新建 `ts/src/media/videoTranscribe.ts`:抽音(复用 `ffmpegBin`)→ spawn whisper-cli(`-oj`;可选 `-ojf --dtw`)→ 解析 JSON → `phrases`;per-source 缓存 `edits/<项目>/transcripts/<stem>.json`。复用 `voiceTranscription.ts` 的 `resolveExecutable`/`resolveWhisperModel`/`whisperCppCommand`(抽成共享或 import)。
5. 移植 `group_into_phrases`(静音≥0.5s 断句)+ `render_markdown`(takes_packed.md)到 TS,**配单测**(whisper JSON fixture → phrases,行为对齐锁边界)。

**C. 回填占位(改 `videoEditProjects.ts`,不动 package.json)**
6. `createLocalPlan`:插入转写(8–35% 探测后),回填 L744 `phrases`、L766 真台词字幕、L783/L796/L797 报告口径(§3.5 #1–3)。
7. `autoCaption`(L594):有音轨→转写→按 phrases 生成真字幕 clips;无音轨→占位(§3.5 #4)。
8. 派生 `takes_packed.md` 进 `edits/<项目>/`(§3.6)。
9. 错误兜底 + 进度上报 + `signal` 取消(§四)。

**D. 验收(声称好之前真跑)**
10. `cd ts && bun test`(含新转写单测)+ `bun run typecheck`。
11. 真机:拿一段中文口播视频跑 `createLocalPlan`/`autoCaption`,核对 `transcripts/<stem>.json`、`takes_packed.md`、字幕轨真台词、时间戳对得上音;成片字幕烧录中文正常。
12. 无音轨 / 缺二进制 / 缺模型 三种兜底路径各验一次不崩、退占位有说明。

**P1(转写就绪后再排):** LLM Reasons 重写文案(recaption/editFeedback 接编排 LLM)、切点手艺(不切半句/padding/afade/self-eval)、中文 master SRT 偏移、DTW token 级"点词跳帧"。

---

## 附:研判文档(`video-use-剪辑编排适配研判-2026-07-09.md`)需修正处

> 研判整体方向对(骨架已有、转写是最大缺口),但**转写那环有几处与真源码对不上,按下表修**(本方案不改研判文件,仅列出;后续可由维护者据此更新研判 banner/内容)。

| 研判原文 | 真源码 | 修正 |
|---|---|---|
| §二表:"用 ElevenLabs Scribe **等**做词级转写" / §五(1)"内置 whisper sidecar **或**接云转写 provider(走网关藏 key)"**二选一** | video-use 就是 Scribe 云 API,且**明列本地 whisper 为反模式** | 我们红线(全本地/离线/免登录)**强制走本地 whisper.cpp,云那条不成立**——不是二选一。研判把云列为等价选项,需删/降级 |
| §五(1)"内置 whisper **sidecar**(Node 子进程)" | 我们是 spawn 外部 `whisper-cli.exe` | **不需要另起 Node 子进程包一层**;Bun 后端 `child_process.spawn` 外部二进制即可(voiceTranscription 已证)。§8 的 `.node` 段错误雷只针对 npm 原生插件(smart-whisper/onnx),不针对 spawn exe。措辞需澄清 |
| §二表 & 全文多处:"VLM 挑高光"、L796 `used_vlm` | video-use **没有独立 VLM,也没有打分函数**(明列反模式);"看画面"= 主编辑 LLM 自己在决策点读 `timeline_view` PNG | "VLM 挑高光"表述不准。真相是"LLM 读 takes_packed 文本 + 按需读 timeline PNG 自己选"。`used_vlm` 维持 false 别虚报 |
| 未提及 | render.py loudnorm = **I=-14:TP=-1:LRA=11**(社媒标准);我们 `LOUDNESS_FILTER` = I=-16:TP=-1.5:LRA=11(L95) | 数值不同(video-use 用 -14)。非红线,后续可对齐社媒 -14 |
| 未提及 | 项目**已有 whisper.cpp 在跑**(`voiceTranscription.ts` 语音输入),且 `package.json` `trustedDependencies` 已挂 `smart-whisper`/`onnxruntime-node`(**未真装**) | 转写不是从零起;本方案 = 把语音输入那条 whisper.cpp 复用到视频转写。研判应指出这个现成先例 |
| §附:master SRT 2 词大写 | 是英文玩法 | 中文按 phrase/字数分块、不大写(§3.6) |

研判的骨架结论(时间线真相源/原子操作/渲染前校验已落地;padding/fade/不切词/self-eval 是可排期工程增量;`timeline_view` 后端 PNG 降级为可选)**均成立,不改**。
