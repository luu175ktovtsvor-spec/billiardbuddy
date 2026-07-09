# 22-补：语音输入 + 朗读 TTS

> **第二轮穷尽补齐**（2026-07-10）。归属：**App 外壳/输入区 = WorkBuddy** 侧（语音输入挂 composer，朗读挂助手消息操作条）。
> **可信度**：变量名被 mangle，但源码保留完整中文注释 + 原始 TS 路径 + i18n key + JSX + 设计稿节点号 + 精确色值。几乎 100% 明文可读。
> **务实取舍**：见第 10 节。语音/朗读都是服务端能力（ASR/TTS 走网关藏 key），前端组件几乎可整段搬。

代码位置：语音输入全部在 `renderer/assets/connector-CvFT3fv6.js`（`useVoiceInput` L105141-105453、`VoiceControls` L105458、`VoiceWaveform` L105581、`MicIcon`+`useVoiceButton` L105671、挂载 L116727）；朗读 `TtsPlaybackManager` L90557 + `useTtsPlayback` L90693 + 挂载 L118778；三态喇叭图标 `src-CMgU1OQk.js` L30828；桌面 IPC `preload/index.js`+`main/index.js`。

---

## 1. 语音输入：状态机
`useVoiceInput` 状态 `"idle"|"requesting_permission"|"recording"|"processing"|"error"`。外层 `isVoiceActive=recording||processing`。
**点麦克风（idle→录音）** `startRecording`：`state!=="idle"` return；有桌面权限 provider→置 requesting_permission→`getMicrophonePermission()`：`not-determined`→`requestMicrophonePermission()`（触发系统弹窗）；`denied/restricted`→回 idle + **弹应用内权限提示卡**，不调 getUserMedia；`granted/unknown`→继续。`getUserMedia({audio:true})` 失败进 `handlePermissionError`。建 `AudioContext({sampleRate:16000})` + `AnalyserNode(fftSize:256)`→置 recording，每 1s 自增计时。起 **60s 上限定时器**（到点自动停+送 ASR）。采集优先 `AudioWorkletNode`（内联 blob 注入 pcm-capture-processor），不支持降级 `ScriptProcessorNode(4096,1,1)`，往 `pcmBuffersRef` 堆 Float32 PCM。
**停止（recording→processing→送 ASR→idle）**：置 processing→`encodeWav(pcm)` 编 16k/mono/16bit WAV→base64。`handleStop`：无 `adapter.speechToText`→toast.error"当前环境不支持语音输入"。`Promise.race([speechToText(audio), 30s超时])`：`success && text`→**`onTextResult(text)`**（主对话 `cbChatRef.appendInputText(text)` + focusInput，**把识别文字塞进输入框、不自动发送**）；空 text→toast.info"未检测到语音内容,请重试。"；失败带 errorCode→查 `voice.error.code.{code}`（如 15053）否则"语音识别失败,请重试。"；超时→"语音识别超时,请重试。"。finally `cancelRecording()`。
**取消** `cancelRecording`：cleanup + 回 idle。**会话切换若正在录音会自动 `handleStop`（送 ASR 不丢）。**
**错误态**：`setError` 置 error + cleanup + toast.error，**3s 后自动回 idle**（`ERROR_AUTO_RECOVER_MS=3000`）。
常量：`WAV_SAMPLE_RATE=16000`、`ASR_TIMEOUT_MS=30000`、`ERROR_AUTO_RECOVER_MS=3000`、60s 录音上限。

## 2. 语音输入：每态 UI（精确）
插槽 `BottomSlotPositions.BEFORE_SEND_BUTTON`（永远发送按钮左侧）。
- **idle**：`.voice-mic-trigger`（32×32 圆，hover 底 `--cb-voice-mic-hover-bg`）+ MicIcon(16×16) + Tooltip"语音输入 (⌘D)"。
- **requesting_permission**：`.voice-mic-trigger--loading` 内 `.voice-mic-spinner`（16×16 2px 环 `voice-mic-spin 0.8s`），pointer-events:none。
- **recording**：`.voice-controls--recording`（高32 radius8 底 `--cb-voice-pill-bg` pad0 8 gap8）：VoiceWaveform(16×16) + duration(mm:ss tabular-nums min-width38 色 `--cb-voice-text`) + cancel-btn(× title"取消录制") + confirm-btn(✓ title"停止录制" 色 `--cb-voice-confirm-color` #00c29a)。设计稿 132×32。
- **processing**：`.voice-controls--processing`（32×32 透明）内 ProcessingLoadingIcon（12×13 base64 六齿 `voice-wb-spin 2s`）。**processing 态不显示任何文字**（见 §11 坑）。
**VoiceWaveform**：`SAMPLE_INTERVAL_MS=60`(~12fps)，`computeRms` 算响度，话筒筒内音量条以基线向上长，静音≈1.5px 满≈6px，上升系数.6 下降.25，fill `#00C29A`，clipPath 裁进筒体。

## 3. 麦克风错误 → toast（`error.name`）
`NotAllowedError`→"麦克风权限被拒绝,请在系统设置中授权。"/`NotFoundError`→"未检测到可用的麦克风设备。"/`NotReadableError`→"麦克风正被其他应用占用。"/其它→"录音启动失败。"。ASR 阶段：notSupported/asrFailed/code.15053/timeout/emptyResult。

## 4. "尚未获得麦克风权限"引导卡（MicrophonePermissionHint）
桌面权限 denied/restricted 时点麦克风→`showPermissionHint`。锚定麦克风上方小卡（非模态）`.mic-permission-hint`（`position:absolute bottom:calc(100%+8px) right:0 z100 width280 pad16 radius8 bg popover border shadow`）：右上 × 关闭 + `MicSlashIcon`(48×48 斜杠话筒) + 标题"尚未获得麦克风权限"(13/600) + 正文"语音输入提问需要开启麦克风权限,请点击前往设置进行开启。" + 链接"麦克风权限开启指南"（`provider.openMicrophoneSystemSettings()`）+ 底部主按钮"我知道了"（仅 onClose）。点外/Esc 关；权限变 granted 自动关。

## 5. 桌面端 IPC 桥
- **麦克风**（preload）：`microphone:getPermission/requestPermission/openSystemSettings/permissionChanged`。macOS `systemPreferences.getMediaAccessStatus/askForMediaAccess("microphone")`，设置 `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`；Win `shell.openExternal("ms-settings:privacy-microphone")`；Linux no-op。状态 granted/denied/restricted/not-determined/unknown。
- **ASR**：`asr:speechToText`。契约 `speechToText(audioData)→{success,text?,errorCode?}`。
- **TTS**：`tts:startTts/stopTts/tts:event`。契约 `startTts({text,requestId})→{success,error?}`；`stopTts({requestId})`；`onTtsEvent(cb)` 推 `{requestId,type:'audio'|'done'|'error',chunk?,error?}`。TTS 音频=流式 base64 PCM(16k/mono/16bit)分片，前端排队无缝播。

## 6. 开关 + 快捷键
- Feature flag：语音输入 `DisableVoiceInput`（默认启用）、朗读 `DisableVoiceOutput`；`isEnabled` 还要求 adapter 方法存在。→ **我们做成设置里一个开关，不必抄远程 flag。**
- 快捷键：id `toggle-voice-recording`，**默认 Mac `⌘D`/Win `Ctrl+D`**，可编辑，标签"语音录制开关"。idle 按=开录、recording 按=停并送 ASR。tooltip `{shortcut}` 用 `formatShortcut` 动态填。

## 7. 朗读 TTS：三态按钮 + 播放机
**位置**：助手消息底部操作条（`messageActions` 注入，与复制/点赞并列）。仅 `adapter.startTts` 且 `DisableVoiceOutput` 未开时出现。
**三态按钮**（action `id:"tts-speak"`）：label idle="朗读"/loading="加载语音中..."/playing="停止朗读"。icon playing(当前消息)→SpeakerPlayingIcon(喇叭+声波 呼吸 1.2s)/loading→SpeakerLoadingIcon(喇叭+3 点 0.9s)/其它→SpeakerIcon。onClick：点当前正播的→stopPlayback；否则 startPlayback（切歌：先停旧再播新）。
**取文本** `extractTextFromMessage`：只取 assistant `type==="text"` block，`stripThinkTags` 剥 `<think>`，trim `\n` 拼接。空文本→`console.warn` 不播（**i18n 有 `tts.error.noText`"没有可朗读的文本内容"但此 hook 未调用**，见 §11）。
**状态流** `useTtsPlayback`：`ttsState idle|loading|playing`、activeMessageId、activeRequestId。startPlayback 剥文本→有旧的先停→生成 requestId（`tts-{ts}-{rand}`）→置 loading→`adapter.startTts`。`onTtsEvent`（只认匹配 requestId）：audio→首帧 loading 切 playing + enqueue；done→markStreamDone；error→toast.error(event.error 或"语音合成失败")+stop。stopPlayback 调 `adapter.stopTts`+manager.stop。
**TtsPlaybackManager**：`AudioContext({sampleRate:16000})`，base64→Int16→Float32，`createBufferSource` 按 nextStartTime 无缝排队（首帧 currentTime+0.02 起播），onended 出队；markStreamDone 后队空即完成、否则按预估时长+500ms 兜底防 onended 丢失。

## 8. 完整文案表（zh）
**voice.***：start 语音输入 / tooltip 语音输入 ({shortcut}) / stop 停止录制 / cancel 取消录制 / processing 识别中... / error.permissionDenied 麦克风权限被拒绝,请在系统设置中授权。 / error.noDevice 未检测到可用的麦克风设备。 / error.deviceBusy 麦克风正被其他应用占用。 / error.unknown 录音启动失败。 / error.asrFailed 语音识别失败,请重试。 / error.code.15053 语音识别服务异常,请稍后重试。 / error.timeout 语音识别超时,请重试。 / error.notSupported 当前环境不支持语音输入。 / info.emptyResult 未检测到语音内容,请重试。 / permission.title 尚未获得麦克风权限 / permission.body 语音输入提问需要开启麦克风权限,请点击前往设置进行开启。 / permission.guide 麦克风权限开启指南 / permission.confirm 我知道了
**tts.***：play 朗读 / stop 停止朗读 / loading 加载语音中... / error.noText 没有可朗读的文本内容 / error.failed 语音合成失败
其它：`settings.keyboardShortcuts.actions.toggleVoiceRecording`="语音录制开关"。

## 9. 色值 token（明/暗 + WB 品牌桥）
| token | 暗 | 明 | WB 桥接 | 用途 |
|---|---|---|---|---|
| --cb-voice-pill-bg | rgba(255,255,255,.06) | #f7f7f7 | --wb-palette-gray-2 | 录音胶囊底 |
| --cb-voice-text | rgba(255,255,255,.65) | rgba(0,0,0,.7) | --wb-color-text-secondary | 时长/话筒/取消 |
| --cb-voice-confirm-color | #00c29a | #00c29a | --wb-brand-primary | ✓确认 + 音量条 |
| --cb-voice-mic-hover-bg | rgba(255,255,255,.08) | #f2f2f2 | --wb-color-bg-primary-active | 麦克风 hover 底 |
**白标要点**：确认色/音量条=品牌主色（WB 绿 #00c29a），**换成球房管家品牌主色**，其余灰阶照抄。keyframes `voice-wb-spin`/`voice-mic-spin`。

---

## 10. 务实取舍标注（必做 / 可简化 / 暂不做）

**必留**：16k/mono/16bit WAV + base64 契约、30s ASR 超时、60s 录音上限、3s 错误自恢复、`error.name→文案`四分支、"识别文字塞输入框不自动发送"、TTS 流式排队无缝播 + requestId 防串音 + `<think>` 剥离。权限：macOS `askForMediaAccess`/deep-link 设置照抄（桌面必须）；denied 弹应用内锚定小卡值得留。

**可务实简化/砍**：远程 feature-flag 体系（DisableVoiceInput/Output）→降成设置里两个本地开关；`webm/ogg` 分支（实际只用 wav）；ScriptProcessor 降级（目标只 Electron 可只留 AudioWorklet）。

**后端**：ASR/TTS 是服务端能力（走网关藏 key），前端只认上述 adapter 契约——照契约实现 sidecar/网关即可，前端组件几乎可整段搬。

## 11. 坑（实现时别踩）
- **`voice.start`"语音输入" 与 `voice.processing`"识别中..." 从未被引用**：idle tooltip 实际用 `voice.tooltip`；processing 态**只转图标、不显文字**。别照 i18n 以为会显示"识别中..."。
- **`tts.error.noText` 未被调用**：空文本只 `console.warn`，不弹 toast。要给用户提示需自己补。
- `onTextResult` 是 **append 到输入框**（不替换、不自动发送）——用户可编辑再发。
- 录音中切会话**自动停+送 ASR**（不丢）。
- ASR errorCode 走 `voice.error.code.{code}` 动态查表，命中才用否则回落 asrFailed（15053 只是已知一例，做成"查不到就用通用失败文案"）。

## 盲区
1. ASR/TTS 服务端真实实现（供应商/端点/鉴权/完整错误码表）在网关后端，本地包只见 adapter 契约与 IPC 通道名。
2. 三态喇叭/话筒/×/✓ SVG 完整 path 未全文粘贴（都在源码明文，给了文件+行号）。
3. processing 的六齿 loading 是内嵌 png（base64 L105456），想矢量化需按注释几何自绘。
4. WB 桥接 token 最终解析值未逐一追（对白标无意义，换自己品牌色）。
5. 朗读按钮在消息操作条里与其它 action 的确切排序属"消息操作条"切片（09 §1）。
6. Windows 上 getMediaAccessStatus 行为未验证（main 里 darwin 分支明确，win 只见 openExternal 设置）。
