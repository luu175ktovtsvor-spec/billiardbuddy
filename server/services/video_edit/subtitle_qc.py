"""字幕门(E4③)—— 三条确定性规则校验,零 token 纯规则,不调 LLM/VLM。

1. 字速 ≤5 字/秒(chars/duration)——超了只标记,不自动改文字(见下方"为什么不自动拆")。
2. 不与静音段错位——cue 整段落在静音区间里 = 可疑(口播都没声,字幕却在,大概率对不上),只标记。
3. 时间戳单调不重叠——排序后 `end[i] > start[i+1]` 判重叠;这条允许**确定性夹紧**(clamp 结束时间,
   不碰文字),因为夹紧是可复现的机械修正,不是"猜内容"。

为什么字速超限选择"只标记"而不是"自动拆句":字幕文字来自 whisper 转写(词有各自的真实时间戳),
拆句要么均分时间(不会改变整体字速比例,治标不治本)要么砍字(等于删内容,违反铁律)。产品铁律
明确写了"字幕红的不自动改内容"，所以这里跟静音错位一样，只标记回传给前端高亮，交给用户自己
决定精简哪句话或调整口播节奏。
"""
from __future__ import annotations

MAX_CHARS_PER_SEC = 5.0


def _cue_chars(text: str) -> int:
    """字幕"字数"——去首尾空白后的字符数(中文场景够用,不做分词/不刨标点,跟人眼观感一致)。"""
    return len(text.strip())


def _fully_inside_silence(a: float, b: float, silence: list[tuple[float, float]]) -> bool:
    """cue [a,b) 是否整段落在某一个静音区间内(必须整段包含,局部搭边是正常的收尾/起播,不算错位)。"""
    return any(s <= a and b <= e for s, e in silence)


def validate_cues(
    cues: list[tuple[float, float, str]],
    *,
    silence_intervals: list[tuple[float, float]] | None = None,
    max_chars_per_sec: float = MAX_CHARS_PER_SEC,
) -> dict:
    """三条规则校验。

    cues: [(start, end, text), ...],秒 + 文字,时间轴须跟 silence_intervals 同一坐标系
      (调用方如果 cue 是"成片时间轴"、静音探测是"源文件时间轴",要自己先做偏移换算——参考
      assemble.auto_captions_from_speech 的 seg_offset 算法)。
    silence_intervals: [(start, end), ...] 静音区间列表(通常来自 footage_qc.silence_intervals()),
      不传则跳过"静音错位"这条规则。

    返回 {"cues": 排序+夹紧后的[(start,end,text)], "problems": [...], "ok": bool}。
    problems 每条: {"index"(在返回 cues 里的下标), "start", "end", "text", "reasons": [...]}。
    只有"时间戳重叠"这一条会被自动夹紧(改时间不改字);字速/静音错位只标记,内容原样不动。
    """
    order = sorted(range(len(cues)), key=lambda i: (cues[i][0], cues[i][1]))
    clamped: list[list] = [[cues[i][0], cues[i][1], cues[i][2]] for i in order]

    overlap_flags = [False] * len(clamped)
    for i in range(len(clamped) - 1):
        end_i = clamped[i][1]
        start_next = clamped[i + 1][0]
        if end_i > start_next:
            overlap_flags[i] = True
            # 夹紧到下一条的开始;地板保护防止退化成零长/负长(极端情况:两条 start 相同)。
            clamped[i][1] = round(max(clamped[i][0] + 0.01, start_next), 3)

    silence = silence_intervals or []
    problems: list[dict] = []
    for idx, (a, b, text) in enumerate(clamped):
        reasons: list[str] = []
        dur = b - a
        chars = _cue_chars(text)
        rate = (chars / dur) if dur > 0 else float("inf")
        if rate > max_chars_per_sec:
            reasons.append(
                f"字速过快(约{rate:.1f}字/秒,超过{max_chars_per_sec:.0f}字/秒的阅读节奏,"
                "自己精简这句或放慢口播节奏)"
            )
        if silence and _fully_inside_silence(a, b, silence):
            reasons.append("这段字幕整段落在静音区间里,跟口播时间对不上,像是错位了,检查一下")
        if overlap_flags[idx]:
            reasons.append("跟下一条字幕时间重叠,已自动夹紧结束时间(文字没动)")
        if reasons:
            problems.append({"index": idx, "start": round(a, 3), "end": round(b, 3), "text": text, "reasons": reasons})

    return {
        "cues": [(round(a, 3), round(b, 3), t) for a, b, t in clamped],
        "problems": problems,
        "ok": not problems,
    }
