"""循环打转检测 · 第二层（F-8/F3）——抄 OpenHands StuckDetector 四模式，移植到本项目 OpenAI 兼容的
`messages` 结构上。纯函数、不碰 ctx/网络/IO，只读最近一截 `messages` 判定是否卡在打转。

参考源码（2026-07 核实，OpenHands 已改组织名迁到 `OpenHands/software-agent-sdk`）：
`openhands-sdk/openhands/sdk/conversation/stuck_detector.py`，四个场景：
  1. 同 action（工具调用）+ 同 observation（工具结果）连续重复；
  2. 同 action 连续报错；
  3. 独白——连续多轮只出文本、不调工具、且中途没被"打断"；
  4. A-B-A-B 两个 action 交替（比较时隔 2 个位置的元素是否相等）。
阈值照抄官方默认：action_observation=4 / action_error=3 / monologue=3 / alternating_pattern=6；
只扫最近 `MAX_EVENTS_TO_SCAN` 条 messages，且只看窗口内【最后一条真人 user 消息】之后的部分——
这天然实现了"用户插话清零"（老板一开口，扫描边界就往后挪，旧的打转痕迹不再计入），不需要额外清零逻辑。

⚠️ 与 loop.py 里的"第一层"（`_execute_tool` 里连续 5 次同签名即断）不是一回事：
第一层只挡"字面完全相同的单个调用"（在工具真正执行前拦，防止真去跑第 5 次一样的东西）；
本层额外挡"跨轮花样打转"——同 action 但结果一直报错、纯交替、纯空转独白——这些第一层完全看不见
（因为参数没变但夹杂了别的调用，或参数根本没重复）。两层用同一套"签名=工具名+canonical(args)"判据，
但服务的粒度、拦截时机都不同，互不替代。

豁免规则（Gemini loop-detection-service 那份"什么不算循环"判定提示词的核心判据，整段搬来来指导本层
的比较逻辑——不是又接一次 LLM 判断，第三层 LLM 判定本单明确不做）：
  - 批量操作（write_batch 一次写一批，本身只是【一次】工具调用，压根不会被本层看见重复）；
  - 跨文件/跨位置的连续编辑、多图循环生成、换参数重试——只要 args 不同（canonical json 不相等），
    这些调用天然就不是"同 action"，从判据源头（下面的 `_action_key`）就不会被判成重复，不需要
    额外白名单硬编码。真正会被本层命中的，是【工具名 + 参数都完全一样】的重复，或者两个这样的调用
    来回交替——这才是货真价实的"在原地打转，没有向前推进"。
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

# 只扫最近这么多条 messages（消息，不是"逻辑事件"）——够覆盖四种模式所需的重复窗口
# （alternating 阈值 6 需要 6 组 action+observation，最紧凑情形 12 条消息，留够余量）。
MAX_EVENTS_TO_SCAN = 20

# 四个场景的阈值，照抄 OpenHands 官方默认（openhands-sdk StuckDetectionThresholds）。
_ACTION_OBSERVATION_THRESHOLD = 4
_ACTION_ERROR_THRESHOLD = 3
_MONOLOGUE_THRESHOLD = 3
_ALTERNATING_THRESHOLD = 6

# loop.py 里用方括号标注的"工具结果=出错"标记（_execute_tool / _plan_tool_call 回灌的错误文案）。
# 命中即判定这条 tool 结果是错误（用于场景 2：同 action 连续报错）。
_ERROR_PREFIXES = (
    "[工具执行失败]", "[工具超时]", "[入参校验失败]", "[已被拦截]",
    "[拒绝执行]", "[工具不存在]", "[别重复了]",
)
# 工具自己返回的失败文案未必套用上面的方括号标记（各工具措辞不同），加一道轻量兜底：
# 开头一小截里出现这些字眼也算错误（只看前 24 字，避免把"介绍创业失败率"这类正文内容误判）。
_ERROR_KEYWORDS = ("失败", "出错", "错误")

# 剥掉 id/时间戳等易变字段再比（同一操作两次跑，输出常见这类噪音差异，不剥掉会把"实质相同"误判成"不同"）。
_TIMESTAMP_RE = re.compile(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?")
_DURATION_RE = re.compile(r"(?:耗时|用时|花了|历时)\s*[\d.]+\s*(?:秒|ms|毫秒|分钟|小时)")
_UUID_RE = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")

# loop.py 里那几个"哄着继续"的系统旁白（续写恢复/预算催促/强制收尾/进度提醒）——这些是系统自己为了让
# 模型收敛而注入的 nudge，不代表老板亲自插话纠偏，不该被当成"真人打断"去重置扫描边界/独白计数。
# ⚠️ 字面量特意复制自 loop.py 对应常量（不反向 import，避免循环依赖）；loop.py 那几处措辞改了记得
# 同步这里——测试兜底见 tests/test_stuck_detector.py 里对应用例，改漏了会挂。
_SYNTHETIC_NUDGE_PREFIXES = (
    "你上一段被长度限制截断了",          # loop._CONTINUE_MSG
    "请抓紧基于已有结果给老板最终答复",     # loop._BUDGET_PUSH_MSG
    "请基于上面已有的工具结果",           # loop._FORCE_FINAL_MSG
    "[系统提醒]",                       # loop._PROGRESS_REMIND_* / loop._STUCK_NUDGE_MSG
)

_PATTERN_LABELS = {
    "action_observation": "反复调用同一个操作、结果也一样",
    "action_error": "反复调用同一个操作、一直报错",
    "monologue": "一直在自说自话、没有实际动作",
    "alternating": "两个操作来回切换、没有推进",
}


@dataclass
class StuckResult:
    stuck: bool
    pattern: str | None = None   # "action_observation" | "action_error" | "monologue" | "alternating"
    detail: str = ""             # 供日志/调试的一句话说明，不用于判定逻辑


def _canon_args(raw) -> str:
    """把工具入参规范化成可比较的字符串——dict 直接排序转 json；字符串先尝试当 json 解析再排序转，
    解析不出就原样比较（仍能识别"完全相同的原始字符串"，只是不再对键序/空白容错）。"""
    if isinstance(raw, dict):
        obj = raw
    elif isinstance(raw, str):
        s = raw.strip()
        if not s:
            obj = {}
        else:
            try:
                obj = json.loads(s)
            except (TypeError, ValueError):
                return raw
    else:
        obj = raw if raw is not None else {}
    try:
        return json.dumps(obj, sort_keys=True, ensure_ascii=False)
    except (TypeError, ValueError):
        return repr(obj)


def _normalize_text(text: str) -> str:
    """剥掉时间戳/耗时/uuid 等易变字段再比，避免把"实质相同的结果"误判成"不同"。"""
    if not isinstance(text, str):
        text = "" if text is None else str(text)
    t = _TIMESTAMP_RE.sub("<ts>", text)
    t = _DURATION_RE.sub("<dur>", t)
    t = _UUID_RE.sub("<uuid>", t)
    return t.strip()


def _is_error_text(text: str) -> bool:
    if not isinstance(text, str):
        return False
    if text.startswith(_ERROR_PREFIXES):
        return True
    head = text[:24]
    return any(k in head for k in _ERROR_KEYWORDS)


def _is_synthetic_nudge(text) -> bool:
    return isinstance(text, str) and text.startswith(_SYNTHETIC_NUDGE_PREFIXES)


def _last_genuine_user_index(window: list[dict]) -> int | None:
    """在窗口内【从后往前】找最后一条"真人打字"的 user 消息下标——排除 loop.py 自己注入的系统 nudge
    （虽然角色也标 role=user，但那是系统哄着模型继续，不是老板真插了句话）。没找到返回 None（窗口内
    没有真人边界，整段都参与判定，与 OpenHands 原逻辑一致）。"""
    for i in range(len(window) - 1, -1, -1):
        m = window[i]
        if m.get("role") != "user":
            continue
        content = m.get("content")
        if isinstance(content, str) and _is_synthetic_nudge(content):
            continue
        return i
    return None


def _to_units(events: list[dict]) -> list[dict]:
    """把一段 OpenAI 兼容 messages 转成扁平的"打转判定单元"列表，按时间顺序：
    - assistant 带 tool_calls → 每个 tool_call 一个 {"kind":"action", "tool":, "key":}；
    - assistant 纯文本（无 tool_calls，有内容）→ {"kind":"message","source":"agent"}；
    - role=tool（工具结果）→ {"kind":"observation"/"error", "tool":, "key":}（tool 名回溯自
      最近一次出现过这个 tool_call_id 的 action，取不到就 None，不影响 key 本身的可比较性）；
    - role=user → 真人插话 {"kind":"message","source":"user"}，系统 nudge 伪装的 user
      → {"kind":"message","source":"system"}（不算真人打断，但也不算"独白"里的 agent 消息）；
    - role=system（persona 等）忽略，不产生单元。
    """
    units: list[dict] = []
    tool_by_call_id: dict[str, str | None] = {}
    for m in events:
        role = m.get("role")
        if role == "assistant":
            tool_calls = m.get("tool_calls") or []
            if tool_calls:
                for tc in tool_calls:
                    fn = tc.get("function") or {}
                    name = fn.get("name")
                    tool_by_call_id[tc.get("id")] = name
                    units.append({
                        "kind": "action", "tool": name,
                        "key": f"{name}|{_canon_args(fn.get('arguments'))}",
                    })
            else:
                content = m.get("content")
                text = content if isinstance(content, str) else ("" if content is None else str(content))
                if text.strip():
                    units.append({"kind": "message", "source": "agent", "key": _normalize_text(text)})
        elif role == "tool":
            name = tool_by_call_id.get(m.get("tool_call_id"))
            content = m.get("content")
            text = content if isinstance(content, str) else ("" if content is None else str(content))
            kind = "error" if _is_error_text(text) else "observation"
            units.append({"kind": kind, "tool": name, "key": f"{name}|{_normalize_text(text)}"})
        elif role == "user":
            content = m.get("content")
            if isinstance(content, str) and _is_synthetic_nudge(content):
                units.append({"kind": "message", "source": "system"})
            else:
                units.append({"kind": "message", "source": "user"})
        # role == "system"（人设/安全红线等）：不参与打转判定，跳过。
    return units


def _last_n(units: list[dict], kinds: tuple[str, ...], n: int) -> list[dict]:
    """从后往前捞最近 n 个属于 kinds 的单元（保持"从最近到最早"的顺序，index0=最新）。"""
    out: list[dict] = []
    for u in reversed(units):
        if u["kind"] in kinds:
            out.append(u)
            if len(out) >= n:
                break
    return out


def _check_action_observation(units: list[dict]) -> bool:
    """场景 1：最近 N 次 action 字面全一样，且最近 N 次 observation/error 字面也全一样。"""
    threshold = _ACTION_OBSERVATION_THRESHOLD
    actions = _last_n(units, ("action",), threshold)
    obs = _last_n(units, ("observation", "error"), threshold)
    if len(actions) < threshold or len(obs) < threshold:
        return False
    return (all(a["key"] == actions[0]["key"] for a in actions)
            and all(o["key"] == obs[0]["key"] for o in obs))


def _check_action_error(units: list[dict]) -> bool:
    """场景 2：最近 N 次 action 字面全一样，且对应的最近 N 次结果全是错误（不要求错误文案一致，
    只要求"都是错误"——换参数重试的错误天然不算，因为 action 本身就不一样）。"""
    threshold = _ACTION_ERROR_THRESHOLD
    actions = _last_n(units, ("action",), threshold)
    obs = _last_n(units, ("observation", "error"), threshold)
    if len(actions) < threshold or len(obs) < threshold:
        return False
    if not all(a["key"] == actions[0]["key"] for a in actions):
        return False
    return all(o["kind"] == "error" for o in obs)


def _check_monologue(units: list[dict]) -> bool:
    """场景 3：从最后一个单元往前数，连续多少个是"agent 纯文本消息"——遇到用户/系统插话或
    任何工具调用/结果就断（不是独白，是真的在推进或被打断了）。"""
    threshold = _MONOLOGUE_THRESHOLD
    count = 0
    for u in reversed(units):
        if u["kind"] == "message" and u.get("source") == "agent":
            count += 1
            continue
        break  # 用户/系统插话、或任何 action/observation，都打断独白计数
    return count >= threshold


def _check_alternating(units: list[dict]) -> bool:
    """场景 4：最近 N 个 action（不要求相邻，只看"最近出现的 N 个"）呈两两相隔（i 与 i+2）相等，
    对应的最近 N 个 observation/error 也一样——即 A,B,A,B,... 交替、没有向前推进。"""
    threshold = _ALTERNATING_THRESHOLD
    actions = _last_n(units, ("action",), threshold)
    obs = _last_n(units, ("observation", "error"), threshold)
    if len(actions) < threshold or len(obs) < threshold:
        return False
    actions_ok = all(actions[i]["key"] == actions[i + 2]["key"] for i in range(threshold - 2))
    obs_ok = all(obs[i]["key"] == obs[i + 2]["key"] for i in range(threshold - 2))
    return actions_ok and obs_ok


def detect_stuck(messages: list[dict]) -> StuckResult:
    """主入口：给最近一截 `messages`（OpenAI 兼容格式），判定是否卡在打转 + 命中哪种模式。
    纯函数，不碰 ctx/IO；loop.py 在"一批工具结果全部追加完毕"或"要推一句催促语"之前调用它。
    """
    if not messages:
        return StuckResult(False)
    window = messages[-MAX_EVENTS_TO_SCAN:]
    boundary = _last_genuine_user_index(window)
    events = window[boundary + 1:] if boundary is not None else window
    if len(events) < min(_ACTION_OBSERVATION_THRESHOLD, _ACTION_ERROR_THRESHOLD, _MONOLOGUE_THRESHOLD):
        return StuckResult(False)
    units = _to_units(events)

    if _check_action_observation(units):
        return StuckResult(True, "action_observation", _PATTERN_LABELS["action_observation"])
    if _check_action_error(units):
        return StuckResult(True, "action_error", _PATTERN_LABELS["action_error"])
    if _check_monologue(units):
        return StuckResult(True, "monologue", _PATTERN_LABELS["monologue"])
    if len(events) >= _ALTERNATING_THRESHOLD and _check_alternating(units):
        return StuckResult(True, "alternating", _PATTERN_LABELS["alternating"])
    return StuckResult(False)
