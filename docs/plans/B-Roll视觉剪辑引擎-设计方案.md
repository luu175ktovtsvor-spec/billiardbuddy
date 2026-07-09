# B-Roll 视觉剪辑引擎 + 内容分流器 · 设计方案(task #43)

> 📌 状态:🚧进行中 · 任务〈B-Roll 视觉引擎〉· 建于 2026-07-10
>
> **面向后续实现子代理,照着施工。写这份时未改任何代码,只 clone 读了 GitHub 仓库源码 + 读了本仓库现有代码。**
>
> **一手依据(真 clone 读了源码,不是凭记忆):**
> - `Breakthrough/PySceneDetect`(读了 `scenedetect/detectors/content_detector.py`/`adaptive_detector.py`/`transnet_v2.py`)
> - `WyattBlue/auto-editor`(Nim 重写版,读了 `src/analyze/audio.nim`/`motion.nim`、`src/editmethods.nim`、`src/conductor.nim`、`src/log.nim`)
> - `browser-use/video-use`(读了全部 helpers,确认它**纯转写驱动、无 B-Roll 路**)
> - `techie-ray/automatic-video-montage-editor`(读了 `main.py`,确认它其实是随机等分切,无真节拍)
> - 节拍检测选型经 WebSearch 核对 aubio / music-tempo / librosa 一手文档
>
> **关联文档:**
> - #41 口播路(次路,共用同一时间线/渲染)= `docs/plans/video-use转写引擎-补活方案.md`
> - 研判 = `docs/plans/video-use-剪辑编排适配研判-2026-07-09.md`
> - 工作台 = `docs/plans/生图与剪视频工作台-设计方案.md`
> - 视频内核代码 = `ts/src/media/videoEditProjects.ts`(时间线唯一真相源 + 原子操作 + 回滚)
> - whisper.cpp 先例 = `ts/src/server/services/voiceTranscription.ts`
> - native 边界铁律 = `ts/CLAUDE.md` §8(`.node`/onnx 在 Bun+Windows 段错误,必须 Node sidecar 或 spawn 外部 exe)

---

## 0. 一句话结论(大白话)

门店视频大多是**没人说话的环境镜头**(球厅、台球桌特写、灯光、顾客打球、吧台器材),靠**画面 + 音乐节奏**成片,不是靠台词。所以口播那套"转写→读台词选切点"对它没用。这份文档给的是**另一条视觉驱动的剪法**,分两大块:

1. **内容分流器**:先花几秒判断"这批素材到底有没有口播"。没音轨/几乎没人说话 → 走本文 B-Roll 视觉路(门店主路);有实打实口播 → 走 #41 whisper 转写路(次路)。
2. **B-Roll 视觉引擎五步**:①ffmpeg 切镜头 → ②本地打分挑好镜头(清晰/稳/曝光对) → ③把每个镜头的一张缩略图发给我们自己的模型(网关 VLM)打标签+排叙事顺序 → ④检测 BGM 节拍、把切点对齐到鼓点 → ⑤按节奏排蒙太奇 + 叠门店卖点文字。

**两条路最后落到同一份 `TimelineDoc` + 同一套原子操作 + 同一个 ffmpeg 渲染**,只有"初剪怎么生成"分流。

**三条硬约束贯穿全文**:全本地(用户素材不外流,除网关 VLM 那一步走的还是全产品统一的内置 key 网关)+ 免 key(不让用户配任何东西)+ Windows 能打包(所有二进制/权重打进 EXE,开箱即用)。

**最大的两个卡点(先说在前面):**
- **VLM 本地 vs 网关**:本地视觉模型(onnx/transformers.js)撞 `ts/CLAUDE.md` §8 的 Bun+Windows 段错误雷、还得塞大权重且小模型质量差;**推荐走网关 VLM(就是 agent 自己那颗多模态模型,已确认内核支持图片 content-block),离线时降级到纯启发式**。这是本文最重要的取舍。
- **渲染缺口**:现有 `renderProject` 用 `concat -c copy` 硬拼,**不混 BGM、不做转场、不读 clip 的 `gain`/`effects` 字段**。B-Roll 成片的灵魂是"画面配着音乐卡点走",所以**渲染层必须补 BGM 混音 + 可选转场**,这是必须动的后端缺口。

---

## 一、真读的 GitHub 项目 + 它们的一手做法

### 1.1 PySceneDetect(镜头切分,BSD-3,纯 OpenCV/numpy)

一手读了三个 detector,核心是"逐帧比差异、超阈值就判为切点":

- **`ContentDetector`(默认、无 ML)**:把相邻两帧转到 HSV,分别算 hue/sat/lum 三个通道的**平均像素差**(`_mean_pixel_distance`),按权重(默认 hue=sat=lum=1.0、edges=0)加权成一个 `content_val` 分数;分数 ≥ **阈值 27.0** 就是一个切点。可选把 luma 做 Canny 边缘再比(`delta_edges`)增强抗噪。`min_scene_len` 默认 **15 帧**(切了之后至少隔这么久才能再切),`FlashFilter` 合并过快的连切。**这套完全不用神经网络,只要 OpenCV 逐帧算。**
- **`AdaptiveDetector`(抗镜头运动)**:同样先算 `content_val`,但阈值不固定——用前后各 `window_width=2` 帧的**滚动平均**,`adaptive_ratio = 当前分/邻域平均分`,比值 ≥ **3.0** 且当前分 ≥ `min_content_val=15.0` 才判切点。**好处:摇镜头/推拉这种整体缓慢变化不会被误判成切点**(门店运镜多,这个很关键)。
- **`TransnetV2Detector`(ML,最准)**:加载 `transnetv2.onnx`,把帧缩到 **48×27**,按 **100 帧一窗**喂进去,输出每帧是不是镜头边界的概率,**阈值 0.5**。准是准,但**要 onnxruntime + 模型权重**——正好撞我们的段错误雷(见 §四),P0 不用。

> 对我们的意义:**切镜头的核心算法 = 相邻帧 HSV 差 + 阈值 + 最小镜头长 + 抗运动的滚动平均**。我们不搬 Python,而是**用 bundled ffmpeg 的 `scene` 分数/`scdet` 滤镜复刻**同一思路(ffmpeg 的 `scene` 就是帧间差),阈值可调、抗运动可以叠"最小镜头长 + 滚动平均"在 TS 侧后处理。PySceneDetect 的三个默认数值(27.0 → 归一到 ffmpeg 的 0~1 约 0.3~0.4;min_scene_len ≈ 0.5s;adaptive ratio 3.0)直接当我们的起始参数。

### 1.2 auto-editor(基于内容自动剪,去废镜/静止,Unlicense/公有领域)

现在是 Nim 重写(用 libav,不是调 ffmpeg CLI),但算法一手读清楚了。它的思路是:**把整条时间线按 timebase 切成一格一格,每格算一个"该不该保留"的布尔值,再做边距/平滑,最后把连续保留段拼起来。** 三个 `--edit` 分析方法(`src/editmethods.nim` 是唯一真相源):

- **`audio`(默认,阈值 0.04)**:每个 timebase 格里取**绝对值最大的采样 / 32767**(`readChunk`,有 NEON/SSE/WASM 向量化),超过阈值就算"响"(保留),否则静音(丢)。**这就是 auto-editor 招牌的"自动剪掉静音"。**
- **`motion`(阈值 0.02)**:把画面 `scale=width(400):-1,format=gray,gblur=sigma=9`,和上一帧**逐像素比,数有多少像素变了 / 总像素**(`motionness`),超阈值算"有动作"(保留)。可用 `x/y/w/h` 只看画面某块区域。**这正是 B-Roll 要的"去静止/去发呆镜头"。**
- **`blackdetect`(阈值 0.98,pixel-black 0.10)**:一帧里 ≥98% 的像素是黑的(灰度 luma ≤ 0.10)就判黑帧。
- **布尔组合子 `or`/`and`/`xor`/`not`**:可以写 `(or audio:0.04 motion:0.02)` = "有声音**或**有动作就保留",或 `(not blackdetect)` = "剪掉黑场"。**这是 B-Roll 分流的骨架:门店素材可能没声音,那就纯靠 motion + 非黑 + 非冻结判保留。**
- **边距 + 平滑(`src/conductor.nim` / `src/log.nim`)**:`margin` 默认 **(0.2s, 0.2s)** = 每个保留段前后各留 0.2s,别切太死;`smooth = (mincut, minclip)` = 太短的静音间隙不切、太短的保留片段直接丢,避免碎片。先 `mutMargin` 再 `smoothing`。

> 对我们的意义:**B-Roll 第 2 步"挑好镜头"的一半 = auto-editor 的 motion + blackdetect + 边距/平滑**。门店没口播时,"保留 = 有动作且不黑不冻",丢掉发呆/黑场/抖废镜。这些指标全能用 bundled ffmpeg 的 `signalstats`/`blackdetect`/`freezedetect` + 抽帧算像素差复刻,**零 ML、零新依赖**。margin 0.2s、丢碎片这些数值直接抄。

### 1.3 video-use(确认:纯转写驱动,没有任何 B-Roll 路)

一手确认:`helpers/` 只有 `transcribe.py`/`transcribe_batch.py`/`pack_transcripts.py`/`render.py`/`grade.py`/`timeline_view.py`——**全部围绕"先转写、LLM 只读台词摘要选切点"**。grep 全仓 `broll/scene/motion/silence` 只命中 install.md/gitignore/manim 子技能等无关处,**没有镜头切分、没有运动检测、没有无对白剪辑逻辑**。SKILL.md 甚至把"手写打分函数选高光"明列为反模式。

> 结论:**video-use 对 B-Roll 帮不上忙**,它的价值只在 #41 口播路(转写→phrase→takes_packed→按词剪)。B-Roll 这条得自己按 §1.1/§1.2 的思路搭。这也印证了 owner 的判断:whisper/转写那套对无口播素材"会很拉垮"。

### 1.4 节拍卡点(音乐驱动剪,选型经一手核对)

- `techie-ray/automatic-video-montage-editor`(读了 `main.py`):**名不副实**——它只是 `random.uniform` 随机取等长子片段拼起来配音乐,**根本没做节拍检测**。反面教材:说明"平均切"不叫卡点,真卡点必须检测鼓点。
- **真节拍检测的算法家底(WebSearch 核对官方文档):**
  - **librosa `beat_track`** = Ellis 2007《Beat tracking by dynamic programming》:①算 onset strength(起音强度包络)→ ②自相关估 tempo → ③动态规划挑出"既落在起音峰、又符合 tempo 周期"的拍点。**是黄金标准,但 Python。**
  - **aubio `aubio beat` / `aubiotrack`** CLI:直接吐出每个鼓点的秒数,用的是 Davies 因果节拍跟踪。C 库、有 CLI。**但 aubio 是 GPL-3.0——闭源分发进 EXE 有 copyleft 传染风险,必须让 owner 拍板**(见 §三步4)。
  - **`music-tempo`(npm,纯 JS,MIT)**:Simon Dixon 的 BeatRoot 算法,输入 Web Audio 那种 Float32 非交织 PCM,返回 `{tempo(BPM), beats[秒数组]}`。**纯 JS、无原生依赖、MIT 可自由分发**——最贴我们约束,只是要动 package.json。
  - `web-audio-beat-detector`(npm):要浏览器 `AudioContext`,只能在 Electron 渲染进程跑,后端 Bun 用不了。

> 对我们的意义:**节拍检测选 `music-tempo`(纯 JS/MIT)为主**,ffmpeg 抽 PCM 喂给它拿拍点秒数;想彻底不动 package.json,就在 TS 里手写"onset 包络 + 自相关 tempo + 梳状滤波定相位"(Ellis 法本身不复杂,~150 行)。**aubio 因 GPL 降为备选**。

---

## 二、内容分流器(VAD)——先判有没有口播,再选路

### 2.1 大白话

进来一批素材,分流器要回答一个问题:**"这是有人对着镜头说话的口播片,还是没人说话的环境片?"** 答案决定走 whisper 转写路还是 B-Roll 视觉路。做法是"从便宜到贵"三级闸,大多数门店素材第一级就分完了。

### 2.2 三级 VAD(全部复用已有能力,零新依赖)

| 级 | 手段 | 判定 | 成本 |
|---|---|---|---|
| **L0 无音轨直判** | `probeVideo` 的 `has_audio`(现成,`videoEditProjects.ts:499`) | `has_audio=false` → **直接 B-Roll**,不用再听 | 免费(探规格顺带) |
| **L1 ffmpeg 有声比** | bundled ffmpeg `silencedetect=noise=-30dB:d=0.5`,解析 stderr 的 silence_start/silence_end,算 `voiced_ratio =(总时长-静音总时长)/总时长` | `voiced_ratio < 0.15`(几乎全静音)→ **B-Roll**;很高但要 L2 确认(响≠有人说话,音乐也响) | 秒级,纯 ffmpeg |
| **L2 whisper 探针确认** | 有声但拿不准时,用**已 bundled 的 whisper.cpp**(#41 那条)只转**采样窗**(比如首/中/尾各 20~30s,或前 60s),看出不出**连贯文字** | 词/字密度 ≥ ~**0.5 字/秒**且多窗都有连贯文本 → **口播路 #41**;空/零碎/乱码 → **B-Roll**(响的是音乐/环境音) | 只转采样窗,比全片转写便宜得多;复用 #41 引擎,无新依赖 |

**判定阈值(可调起始值):** `voiced_ratio` 门槛 0.15;whisper 探针"算口播"的字密度门槛 0.5 字/秒、且至少 2 个采样窗有文本。低于则归 B-Roll。这些进 env/常量,真机调。

**关键点:** L0+L1 就能把绝大多数门店环境片(要么没音轨、要么只有环境嘈杂/背景音乐)分到 B-Roll;只有"听着像有人讲话"的少数才花 L2 的 whisper 探针。**分流器本身不引入任何新二进制/新 npm 包**——`has_audio` 现成、`silencedetect` 是 ffmpeg 自带、whisper.cpp 是 #41 已 bundled 的。

### 2.3 备选:Silero VAD(不推荐作 P0)

Silero VAD 是业界最准的轻量 VAD(ONNX,~1.8MB)。但它是 `.node`/onnxruntime 路子,**撞 `ts/CLAUDE.md` §8 的 Bun+Windows 段错误雷,必须包成 Node 子进程 sidecar**——为一个"判有没有口播"的辅助功能背这个包袱不划算。**P0 用 §2.2 三级闸即可;真嫌 whisper 探针慢,再评估 Silero 走 Node sidecar。**

### 2.4 混合素材的处理

一批里既有口播又有环境片时,P0 **按占比选主路**(多数是环境 → 整批走 B-Roll,口播片当普通镜头用其画面);P1 再做**逐片分流**(口播片进 whisper 出真台词字幕,环境片进 B-Roll 打标签),两种产物落到同一条时间线。现有 `createLocalPlan` 已有 `mode`('ambient'/'speech')入参和 `footageHealth` 对 speech 缺音轨的判断——**分流器就是把"用户手选 mode"升级成"自动判 mode"**。

---

## 三、B-Roll 视觉引擎五步(每步:选型 + 理由 + 全本地/Windows 可行性 + 输出原子操作 + 后端缺口)

> 落点铁律:每步产出**都是发给 `applyOperations`(`videoEditProjects.ts:574`)的原子操作数组**,拖进现有时间线,不新起数据结构(对齐研判 §三.1)。现有原子操作:`add_media`/`add_track`/`add_clip`/`add_caption`/`remove_clip`/`trim_clip`/`reorder_clip`/`edit_caption`/`set_music`/`set_grade`。

### 步 1 · 镜头切分(scene detect)

- **选型:bundled ffmpeg 的 `scene` 分数**(复刻 PySceneDetect `ContentDetector` 思路),**不带 Python/不带 onnx**。
  - 主实现:`ffmpeg -i <src> -filter:v "select='gt(scene,<T>)',showinfo" -an -f null -` → 解析 stderr 里每个命中帧的 `pts_time`,得到切点列表;或用 `scdet=threshold=<T>` 滤镜读 `lavfi.scd.time`。ffmpeg 的 `scene` 就是帧间差(和 PySceneDetect 的 HSV 差同源思路)。
  - TS 侧后处理复刻 PySceneDetect 的两个保护:**最小镜头长**(默认 ~0.5s,合并过近切点,= `min_scene_len`)、**抗运动**(可选:对 scene 分做滚动平均比值,复刻 `AdaptiveDetector` 的 ratio≥3,防摇镜误切)。
  - 起始阈值:`scene` T=**0.3~0.4**(对应 PySceneDetect 的 27.0/255),min_scene_len 0.5s。
- **理由:** 全本地、零新依赖(ffmpeg 已 bundled)、Windows 直接能打包;门店素材切点不需要 TransNetV2 那种电影级精度,帧间差 + 抗运动够用。
- **可行性:** ✅ 全本地 ✅ 免 key ✅ Windows(ffmpeg 已在 `desktop/binaries`/ffmpeg-static)。
- **输出原子操作:** 每个源片 `add_media`(src+duration,一次);每个切出的镜头段先记成候选 `{media, start, end}`,**待第 2/3 步筛完再 `add_clip`**(src_in/src_out = 镜头边界或其子区间)。
- **后端缺口:** 新建 `ts/src/media/videoSceneDetect.ts`(spawn ffmpeg + 解析 + 后处理)。**不动 package.json。**
- **升级位(非 P0):** 要更准可上 PySceneDetect/TransNetV2,但那要 Python 运行时或 onnx sidecar,与全本地/Windows 打包张力大,留给 owner 按需。

### 步 2 · 镜头质量 / 美学选段(heuristic,无 ML)

- **选型:每个镜头抽 1~3 帧,算几个便宜指标加权打分,砍掉差的**(思路 = auto-editor 的 motion/blackdetect + 常规画质指标):
  - **清晰/对焦**:抽帧算 **Laplacian 方差**(拉普拉斯响应越低越糊)——ffmpeg 无直接滤镜,抽帧成 PNG 后在 TS 做一次小卷积即可,或用 `signalstats` 的 `YDIF` 近似。糊镜头扣分。
  - **曝光**:ffmpeg `signalstats` 的 `YAVG`(太暗/过曝)。偏离中间调扣分。
  - **稳定/抖动**:复刻 auto-editor `motion`(scale 400→gray→gblur→帧间像素差),或 ffmpeg `vidstabdetect` 读位移量。过抖(手持废镜)扣分;**但也别全丢——完全静止(发呆镜)同样扣分**,B-Roll 要"有轻微生动感"的镜头。
  - **黑场/冻结**:ffmpeg `blackdetect`(阈 0.98)+ `freezedetect` → 直接淘汰。
  - 综合分 = 加权 → 排序,砍掉后段 + 淘汰黑/冻/糊废镜。
- **理由:** 纯 ffmpeg + 轻量 TS 计算,零 ML、零新依赖;门店"挑能看的镜头"靠这些客观指标足够,不需要审美大模型(语义好坏交给第 3 步 VLM)。
- **可行性:** ✅ 全本地 ✅ 免 key ✅ Windows。
- **输出原子操作:** 保留的镜头 → `add_clip`;被淘汰的候选 → 不 add(或已 add 的 `remove_clip`)。质量分写进候选元数据供第 3 步参考。
- **后端缺口:** 新建 `ts/src/media/videoShotScore.ts`。**不动 package.json**(抽帧算 Laplacian 用 TS 内置数组即可;若图省事引 sharp 做灰度会动 package.json,能不引就不引)。

### 步 3 · VLM 看懂每镜头(打标签 + 按营销叙事排序)

- **选型:走网关 VLM(= agent 自己那颗多模态模型),离线降级到启发式排序。**(详细取舍见 §四)
  - 每个保留镜头用 ffmpeg `thumbnail` 滤镜(自动挑该镜头最有代表性的一帧)抽 1 张关键帧 → 缩到 ~512px JPEG → base64。
  - 把这批缩略图批量发给网关 VLM,让它输出:每镜头**标签**(台球桌特写 / 球厅环境 / 顾客打球 / 吧台器材 / 灯光氛围 / 门头招牌…)、**营销叙事排序**(比如:门头/环境远景开场 → 台面细节/器材 → 顾客氛围 → 高光收尾)、**每镜头/每段建议卖点文案**。
  - 内核已确认支持图片 content-block(`AnthropicMessagesModel.ts:39` 的 `{type:'image',source:{base64}}`,proxy 会翻成 OpenAI `image_url`),所以这就是普通一次 agent 调用,**白标、内置 key、用户零配置**。
  - **离线/无网降级**:用启发式排序——按镜头亮度/景别(用画面尺寸/motion 近似远景 vs 特写)/时长排一个"远景开场→特写→人物→收尾"的通用模板,配通用文案。**保证断网也能出片,只是不"懂内容"。**
- **理由:** 本地小视觉模型质量差且撞段错误雷(§四);网关 VLM 质量高、零新依赖、零段错误、和产品每一次对话同一个信任模型(内置 key 网关)。
- **可行性:** 🟡 这一步**需要联网**(仅这步),但走的是全产品统一的网关,不需要用户任何 key;离线有启发式兜底。全本地红线的本意是"用户数据/登录/key 留本地"而非"永不调模型"——见 §四对红线的界定。
- **输出原子操作:** 叙事排序 → `reorder_clip`;每镜头/每段卖点 → `add_caption`;VLM 判"跑题/重复/不宜"的镜头 → `remove_clip`;整体色调建议 → `set_grade`。
- **后端缺口:** 新建 `ts/src/media/videoVlmTagger.ts`(抽关键帧 + 组多模态 prompt + 调网关 + 解析结构化返回 + 离线兜底)。复用 mediaJobs 已有的 `QF_GATEWAY_URL`/`QF_GATEWAY_TOKEN` 网关配置。**不动 package.json。**

### 步 4 · 音乐卡点(beat sync,全本地)

- **选型:`music-tempo`(纯 JS / MIT)为主,手写 Ellis 法为零依赖备选,aubio 因 GPL 降为末选。**
  - ffmpeg 把 BGM 抽成 raw PCM(`-f f32le -ac 1 -ar 44100`)→ 转 Float32Array → 喂 `music-tempo` → 拿 `{tempo, beats[秒]}`。
  - **把镜头切点吸附到最近鼓点**:按叙事顺序累积摆放镜头,每个镜头的时长(`src_out-src_in`)微调,让"上一镜头结束/下一镜头开始"这个切点落在 beats 数组里最近的拍上(或每 2/4 拍一切,看 tempo)。
  - BGM 选择:P0 打包几首**免版权** BGM(不同节奏/氛围)进 `desktop/binaries/bgm/`,或用户自带;`set_music` 记进 doc。
- **理由:** 卡点是 B-Roll 成片的灵魂;`music-tempo` 纯 JS 免原生依赖、MIT 可自由分发、Bun 直接能跑,只多一个小 npm 包。
- **可行性:** ✅ 全本地 ✅ 免 key ✅ Windows(纯 JS 无平台二进制)。
- **输出原子操作:** 逐镜头 `trim_clip`/`add_clip`(时长对齐拍网格)+ `set_music`(选定 BGM)。
- **后端缺口(两处):**
  1. 新建 `ts/src/media/videoBeatSync.ts`(抽 PCM + 节拍检测 + 吸附)。
  2. ⚠️ **渲染必须补 BGM 混音**:现 `renderProject`(`videoEditProjects.ts:802`)**完全没读 `doc.music`**(grep 确认:`set_music` 只写 `doc.music`,render 从不引用),成片里根本没有 BGM。要在 render 加 `-i <music>` + `amix`/替换音轨 + 对最终音频跑 `loudnorm`。**这是必须动的后端缺口。**
- **package.json:** ⚠️ **加 `music-tempo` 要动 package.json**(若改走手写 Ellis 法则不动)。这是本方案唯一可能动 package.json 的点,标清给 owner。

### 步 5 · 蒙太奇节奏 + 文字/字幕叠加

- **选型:节奏用时长/排序表达(现有 ops 够),文字用 caption 轨 + ffmpeg 烧录;转场/大字卡是渐进增强。**
  - **节奏**:强拍密集处放短镜头(快切,营造气氛)、开场/收尾放长镜头(establishing)。全靠"每个 clip 时长 + 顺序"表达,**现有 `add_clip`/`trim_clip`/`reorder_clip` 就能表达**,不需要新 op。
  - **门店卖点文字**:`add_caption`(第 3 步 VLM 给的文案)→ 走现有 `captionsToSrt`(`:434`)→ `renderProject` 的 `subtitles` 滤镜烧录(`:886`)。中文字体照 #41 §四(`Microsoft YaHei`/思源黑体,别用 Helvetica)。
  - **转场**:切点加短交叉淡入/淡出防生硬。⚠️ 现 render 是 `concat -c copy` 硬拼(`:871`),**加转场要改成重编码合成路径**(`xfade`/`acrossfade` 或段边界 `afade`),权衡耗时——研判 §五.3 已列。P0 可先硬切,P1 上转场。
  - **大字卡/定位文字**(比 SRT 更花的营销标题):现有只能烧 SRT 样式,**要 `drawtext` 滤镜或 ASS 才能做居中大标题/角标**——render 缺口,P1。
- **可行性:** ✅ 基础(caption 烧录、时长节奏)全本地已有;🟡 转场/大字卡要补 render 重编码路径。
- **输出原子操作:** `add_caption`(卖点)+ `reorder_clip`/`trim_clip`(节奏)+ 可选 `set_grade`(统一调色)。
- **后端缺口:** render 的转场/`drawtext` 大字卡(P1);现有 clip 的 `gain`(逐镜头音量)和 `effects`(如 Ken Burns 缓推)字段**存了但 render 从不消费**(grep 确认),要用得补 render——P1。

---

## 四、VLM:本地 vs 网关(推荐 + 理由)

**推荐:走网关 VLM(agent 自己那颗多模态模型),离线降级到纯启发式。不做本地视觉模型。**

| 维度 | 本地视觉(onnx/transformers.js) | **网关 VLM(推荐)** |
|---|---|---|
| Bun+Windows 稳定性 | 🔴 撞 `ts/CLAUDE.md` §8:onnxruntime-node 在 Bun+Windows **段错误**,必须包成 Node 子进程 sidecar | ✅ 就是普通一次 agent 调用,内核已支持图片 content-block(`AnthropicMessagesModel.ts:39`),无原生插件 |
| 打包体积/复杂度 | 🔴 要塞视觉模型权重进 EXE + 管 onnx 运行时 | ✅ 零额外权重、零二进制 |
| 语义质量("台球桌特写 vs 球厅环境") | 🔴 能塞进本地的小模型(CLIP/小 caption)语义弱,标签粗 | ✅ 大模型语义强,还能直接给营销叙事排序 + 中文卖点文案 |
| 免 key / 白标 | ✅ 本地免 key | ✅ 走内置 key 网关,用户零配置、不暴露底层模型(`QF_GATEWAY_URL` 现成) |
| 全本地红线 | ✅ 纯本地 | 🟡 **仅这一步联网**(发几张缩略图) |

**对"全本地红线"的界定(关键):** 红线的本意(见根 `CLAUDE.md`)是**用户数据留本地 + 免登录单用户 + 内置 key 不让用户配 + 不向客户端暴露底层模型**——**不是"永不联网调模型"**。这个产品的核心本来就是每一轮对话都走网关调 Claude。第 3 步把门店环境缩略图发给同一个网关,**和其它 agent 调用同一个信任模型**(内置 key、白标、用户零感知),没有破红线。而且**离线时有启发式兜底能出片**,所以"必须全本地才能用"这条也不破。

**一个隐私注意点(要在实现里处理):** 根 `CLAUDE.md` 安全边界要求"涉及真实顾客资料默认脱敏"。环境/器材/空场镜头缩略图敏感度低,直接发没问题;**但若关键帧里有可识别的顾客人脸(尤其未成年人),应先模糊或改走离线启发式路,别把顾客人脸传网关**。实现时在第 3 步加一个"关键帧含清晰人脸则降级/打码"的护栏。

---

## 五、两条路统一到现有时间线 / 原子操作(统一引擎入口)

### 5.1 统一入口设计

```
planEdit(project, sources, opts)                     // 统一初剪入口(新建 orchestrator)
  │
  ├─(0) inventory:probeVideo 逐源探规格 + footageHealth      [现成:videoEditProjects.ts]
  │
  ├─(1) 内容分流器 classifyContent(sources)                  [新建 videoContentRouter.ts]
  │        L0 has_audio? → L1 silencedetect 有声比 → L2 whisper 探针
  │        产出 route: 'speech' | 'broll'(混合按占比,P1 逐片)
  │
  ├─(2a) route==='speech' → 口播路(#41)                     [videoTranscribe.ts,#41 文档]
  │        转写 → phrases → takes_packed → 按 phrase 出 caption clips
  │        产出:原子操作数组(add_media/add_clip/add_caption…)
  │
  ├─(2b) route==='broll'  → B-Roll 视觉路(本文五步)         [videoSceneDetect/ShotScore/VlmTagger/BeatSync.ts]
  │        切镜头 → 挑好镜头 → VLM 标签+排序 → 卡点 → 蒙太奇+文字
  │        产出:原子操作数组(add_media/add_clip/reorder_clip/add_caption/set_music/set_grade…)
  │
  └─(3) applyOperations(project, ops)                       [现成::574 克隆→applyOne→validateDoc→回滚落盘]
           两条路产出的 ops 走完全相同的落盘/校验/回滚
                    │
                    ▼
        统一时间线 TimelineDoc(edits/<项目>/timeline.json)
                    │
   ┌────────────────┼────────────────┐
   ▼                ▼                ▼
预览(前端秒级)   renderProject(:802)   工作台改文案/拖拽
  客户端 seek     ffmpeg 出片(需补BGM混音/转场)  → 发原子操作回 applyOperations
```

**核心:两条路唯一的区别是"(2a) 还是 (2b) 生成初剪原子操作"。** 之后的 (3) 落盘校验回滚、时间线结构、渲染管线、前端预览与改稿——**全部共用**。B-Roll 路只是比口播路多用了 scene/quality/vlm/beat 四个模块、少用了 transcribe 模块。

### 5.2 为什么天然契合

- 现有 `applyOperations` 已经是"发原子操作 → 克隆 → 逐条 applyOne → validateDoc → 失败整体回滚"(`:574-592`),**两条路都只管吐操作数组,不碰落盘逻辑**。
- 现有 `TimelineDoc` 分 video/audio/caption 轨(`:34`),B-Roll 的镜头进 video 轨、BGM 进 `doc.music`、卖点文字进 caption 轨,**结构完全够用,不加新字段**。
- `createLocalPlan` 已有 `mode`('ambient'/'speech')和 `candidates`(带 `scenes`/`phrases`/`has_speech` 占位)——B-Roll 路把 `scenes` 填真(scene detect 结果)、`phrases` 留空;口播路反之。**分流器就是自动决定填哪个。**

---

## 六、实现步骤清单(给实现子代理直接照做 · 标清哪步动 package.json)

> **总标注:全清单只有【步4 的 music-tempo】可能动 package.json**;其余全是新建 TS 模块 + 复用 bundled 二进制(ffmpeg/whisper)+ 复用网关,均不动 package.json。渲染缺口是改 `videoEditProjects.ts`。

**A. 内容分流器(不动 package.json)**
1. 新建 `ts/src/media/videoContentRouter.ts`:L0 读 `has_audio` → L1 spawn ffmpeg `silencedetect` 解析有声比 → L2 复用 #41 whisper.cpp 只转采样窗判字密度。导出 `classifyContent(sources) → {route:'speech'|'broll', perSource[]}`。配单测(伪造 silencedetect stderr / whisper 空返回 → 路由判定,行为对齐锁边界)。

**B. B-Roll 五步模块(除步4 外不动 package.json)**
2. 新建 `ts/src/media/videoSceneDetect.ts`:spawn ffmpeg `select=gt(scene,T)`/`scdet` → 切点 → TS 后处理(min_scene_len 合并 + 可选抗运动滚动平均)→ 镜头段列表。复用 `videoEditProjects.ts` 的 `ffmpegBin`/`runProcess`。配单测(解析 showinfo pts_time)。
3. 新建 `ts/src/media/videoShotScore.ts`:抽帧算 Laplacian 方差(清晰)+ `signalstats` YAVG(曝光)+ motion 像素差(稳/动)+ `blackdetect`/`freezedetect`(淘汰)→ 加权分 + 排序。**不引 sharp**(能用 TS 内置就别动 package.json)。
4. 新建 `ts/src/media/videoBeatSync.ts`:ffmpeg 抽 PCM(`-f f32le`)→ **`music-tempo`** 拿拍点 → 吸附切点。⚠️ **加 `music-tempo` 依赖 = 动 package.json,需 owner 点头**;或改手写 Ellis 法(onset 包络+自相关+梳状滤波)则不动。
5. 新建 `ts/src/media/videoVlmTagger.ts`:ffmpeg `thumbnail` 抽关键帧 → 缩 512px JPEG base64 → 组多模态 prompt 调网关(复用 `QF_GATEWAY_URL`/`QF_GATEWAY_TOKEN`)→ 解析标签/排序/文案 → **含"含清晰人脸则降级/打码"护栏** + **离线启发式兜底**。不动 package.json。

**C. 统一编排(不动 package.json)**
6. 新建 `ts/src/media/brollPlan.ts`(或并入 `videoEditProjects` 一个方法):串起五步 → 产出原子操作数组 → 交 `applyOperations`。全程 `LocalVideoJobOptions.onProgress` 吐大白话进度("正在切镜头/挑镜头/看懂画面/对齐鼓点/叠文字")。
7. 改 `createLocalPlan`(`:685`):把"用户手选 mode"改成"先调 `classifyContent` 自动分流",再 dispatch 到 §2a(#41)或 §2b(brollPlan)。`candidates` 的 `scenes` 填真、`used_vlm` 按是否真走网关 VLM 如实报。

**D. 渲染缺口(改 `videoEditProjects.ts`,不动 package.json)**
8. ⚠️ **`renderProject` 补 BGM 混音**:读 `doc.music` → `-i <music>` + `amix`/替换音轨 + 最终 `loudnorm`(B-Roll 成片核心,当前完全没有)。
9. (P1)`renderProject` 补转场(`xfade`/`acrossfade`/段边界 `afade`,需从 `-c copy` 硬拼改重编码合成路径)+ `drawtext` 大字卡 + 消费 clip 的 `gain`/`effects` 字段。

**E. 打包资产(一次性,需 owner 点头)**
10. 免版权 BGM 若干首 → `desktop/binaries/bgm/`,`electron-builder.yml` 的 `extraResources`(现 `desktop/binaries → binaries`,现成)随包;prod 从 `process.resourcesPath/binaries` 找。ffmpeg/whisper 已在包内。

**F. 验收(声称好之前真跑)**
11. `cd ts && bun test`(含新单测)+ `bun run typecheck`。
12. 真机:拿一段**无口播门店环境视频**跑 `planEdit`,核对分流判到 broll、切出的镜头合理、VLM 标签/排序像样、成片切点对着鼓点、BGM 混进去了、卖点字幕烧录中文正常。
13. 再拿一段**中文口播视频**跑,核对分流判到 speech、走 #41 出真台词字幕。
14. 断网跑一次 B-Roll,核对 VLM 降级到启发式仍能出片。
15. 三种兜底(无音轨 / 缺 BGM / 网关不可达)各验一次不崩、有大白话说明。

---

## 七、后端缺口汇总(实现子代理一眼看清"哪些没有、要补什么")

| 能力 | 现状 | 缺口 | 动 package.json? |
|---|---|---|---|
| 内容分流器 VAD | 无(`mode` 靠手选) | 新建 `videoContentRouter.ts`(复用 has_audio/silencedetect/whisper) | 否 |
| 镜头切分 scene detect | 无 | 新建 `videoSceneDetect.ts`(ffmpeg scene) | 否 |
| 镜头质量打分 | 无 | 新建 `videoShotScore.ts`(ffmpeg 指标 + Laplacian) | 否 |
| VLM 标签/排序 | 无(`used_vlm:false` 占位) | 新建 `videoVlmTagger.ts`(网关 VLM + 离线兜底) | 否 |
| 节拍检测 | 无 | 新建 `videoBeatSync.ts` | ⚠️ music-tempo=是 / 手写=否 |
| 编排入口 | `createLocalPlan` 只顺序摆片 | 新建 `brollPlan.ts` + 改 `createLocalPlan` 自动分流 | 否 |
| **BGM 混音进成片** | ⚠️ `set_music` 写了 `doc.music` 但 render 从不读 | 改 `renderProject` 加 amix/loudnorm | 否 |
| 转场 / 大字卡 / gain / effects | render 硬拼 `-c copy`,字段存了不消费 | 改 render 重编码路径(P1) | 否 |
| 口播路(#41) | 转写占位 | 见 #41 文档(whisper.cpp bundled) | 否 |

---

## 八、和 owner 洞察 / 红线的对齐自检

- ✅ **门店主路 = B-Roll 视觉驱动**,whisper 口播是次路,分流器自动选——对齐 owner "环境镜头为主、画面+音乐节奏驱动"。
- ✅ **不生成视频**:全程真实素材剪辑(切/挑/排/卡点/叠字),不碰文生视频/图生视频,不触"删掉生成视频"红线。
- ✅ **全本地 / 免 key / Windows 打包**:切镜头/挑镜头/卡点全本地零 key;唯一联网点是网关 VLM(走全产品统一内置 key,离线有兜底)。
- 🟡 **两个要 owner 拍板的点**:①节拍检测是否引 `music-tempo`(动 package.json)还是手写零依赖;②aubio 因 GPL-3.0 不建议进闭源 EXE(已默认排除)。
- 🟡 **一个必须补的后端缺口**:render 的 BGM 混音(当前 B-Roll 成片没有音乐,等于废)。
