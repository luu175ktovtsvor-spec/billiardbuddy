// 朗读播报(读给我听 · D-Task-8):Electron 主进程调【系统自带】命令行 TTS 念文案/简报。
//
// 不用 Web Speech API——Electron 里 speechSynthesis 声音获取历史上不稳(多个 electron issue
// 实锤:渲染进程拿不到系统语音列表/静默不出声)。系统命令零依赖、零打包负担(系统自带、天然满足
// "全打进包"铁律)、行为最确定,套用本文件夹已有的 child_process.spawn 套路(仿 backend.js/video.js)。
//
// speak(text):按平台 spawn 系统命令念出声;若已在念,先 kill 掉上一个再念新的,不叠着念。
// stop():kill 掉当前朗读子进程。
// 全程 try/catch 故障安全,失败返回 { ok:false, error },不抛异常崩主进程。

const { spawn, execFileSync } = require("child_process");
const os = require("os");
const { EventEmitter } = require("events");

let _proc = null;
let _macVoice; // undefined=未探测过;null=探测过但没找到中文语音;string=语音名

// 朗读"结束/失败"广播口——spawn 后 speak() 立即同步 return { ok:true }，那只代表"命令发出去了"，
// 不代表"念完了":念完(close)/被 kill(close)/启动失败如二进制缺失(error)都是之后才到的异步事件。
// main.js 订阅这个事件、广播给渲染进程，前端才能把"正在朗读"UI 复位，不然自然念完/spawn 失败后
// UI 会一直卡在"正在朗读"，得手动点停止或点别处顶掉。
const _emitter = new EventEmitter();
function onEnd(cb) {
  _emitter.on("end", cb);
  return () => _emitter.off("end", cb);
}

function _killCurrent() {
  if (_proc) {
    try { _proc.kill(); } catch { /* ignore:进程可能已自然退出 */ }
    _proc = null;
  }
}

// mac 自带 `say -v ?` 列出已装语音,挑一个中文语音(不同系统版本装的语音不同,常见的挨个试)。
// 探测失败(say 不存在/权限问题)就不带 -v,退回系统默认语音——不因探测失败而念不出来。
function _pickMacVoice() {
  if (_macVoice !== undefined) return _macVoice;
  try {
    const out = execFileSync("say", ["-v", "?"], { encoding: "utf-8", timeout: 3000 });
    const lines = out.split("\n");
    const preferred = ["Tingting", "Ting-Ting", "Sinji", "Meijia"];
    for (const name of preferred) {
      if (lines.some((l) => l.startsWith(name))) { _macVoice = name; return _macVoice; }
    }
    const zhLine = lines.find((l) => /\bzh_(CN|TW|HK)\b/.test(l));
    _macVoice = zhLine ? zhLine.trim().split(/\s+/)[0] : null;
  } catch {
    _macVoice = null; // 探测失败,不带 -v
  }
  return _macVoice;
}

function speak(text) {
  _killCurrent(); // 再点朗读时先掐掉上一个,避免叠着念
  const s = String(text || "").trim();
  if (!s) return { ok: false, error: "朗读内容为空" };
  try {
    let proc;
    if (os.platform() === "darwin") {
      const voice = _pickMacVoice();
      const args = voice ? ["-v", voice, s] : [s];
      proc = spawn("say", args);
    } else if (os.platform() === "win32") {
      // text 走 stdin 喂给 PowerShell,不把文案拼进命令行字符串——防引号/特殊字符/长度问题(P0 约束)。
      proc = spawn("powershell", [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.Speech; " +
          "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
          "$s.Speak([Console]::In.ReadToEnd())",
      ]);
      proc.stdin.write(s, "utf-8");
      proc.stdin.end();
    } else {
      // Linux 等其它平台系统朗读命令不统一(espeak/spd-say 不一定装),暂不支持——
      // 前端已用 electron?.tts 判空只在桌面版露出,这里仍需明确告知调用方,不能静默假成功。
      return { ok: false, error: "当前系统暂不支持朗读播报" };
    }
    _proc = proc;
    // spawn 失败(命令不存在)走 error 事件;正常播完/被 kill 走 close 事件——用"这个 proc 是否
    // 还是当前 _proc"做身份判断再清引用 + 广播,避免旧进程(被下一次 speak()/stop() 顶掉后)延迟
    // 触发的事件,误清掉/误报"当前正在念的"这一条(比如快速切着点了好几条要念的)。
    const finish = (ok, error) => {
      if (_proc !== proc) return; // 已经换成新的一次朗读、或已被 stop() 主动清空——这是旧进程的尾巴,别管
      _proc = null;
      _emitter.emit("end", { ok, error });
    };
    proc.on("error", (err) => finish(false, String((err && err.message) || err)));
    proc.on("close", () => finish(true));
    return { ok: true };
  } catch (err) {
    _proc = null;
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function stop() {
  try {
    _killCurrent();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = { speak, stop, onEnd };
