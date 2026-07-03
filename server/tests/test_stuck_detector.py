"""stuck_detector.py 纯函数单测——四种打转模式各一例被检测 + 合法重复不被误伤 + 用户插话清零。

抄 OpenHands StuckDetector 四模式（同 action+observation 重复 / 同 action 连续报错 / 独白 /
A-B-A-B 交替），阈值照官方默认：action_observation=4 / action_error=3 / monologue=3 / alternating=6。
"""
import json

from services.agent.stuck_detector import detect_stuck


def _tc(name: str, cid: str, args: dict | None = None) -> dict:
    return {"id": cid, "type": "function",
            "function": {"name": name, "arguments": json.dumps(args or {}, ensure_ascii=False)}}


def _action_msg(name: str, cid: str, args: dict | None = None) -> dict:
    return {"role": "assistant", "content": "", "tool_calls": [_tc(name, cid, args)]}


def _result_msg(cid: str, content: str) -> dict:
    return {"role": "tool", "tool_call_id": cid, "content": content}


def _repeat_action_result(name: str, args: dict, result: str, n: int, start: int = 0) -> list[dict]:
    out = []
    for i in range(start, start + n):
        cid = f"{name}-{i}"
        out.append(_action_msg(name, cid, args))
        out.append(_result_msg(cid, result))
    return out


# ══════════════════════════════ 场景 1：同 action + 同 observation 重复 ══════════════════════════════

def test_action_observation_loop_detected():
    messages = [{"role": "user", "content": "帮我查一下今天的营业额"}]
    messages += _repeat_action_result("get_today_recommendation", {}, "查询失败，服务暂不可用", 4)
    # 上面的结果文案含"失败"，会被归类成 error，但 action_observation 场景不要求全是 observation，
    # 全一样的 error 结果同样满足"同 observation"（与 OpenHands 的 ObservationBaseEvent 一致）。
    result = detect_stuck(messages)
    assert result.stuck
    assert result.pattern in ("action_observation", "action_error")  # 两者都成立时按检测顺序取先命中的


def test_action_observation_loop_detected_success_case():
    """结果不是错误、纯粹是"问了 4 次一模一样的东西、答案也一样"——照样算打转。"""
    messages = [{"role": "user", "content": "查一下会员卡余额"}]
    messages += _repeat_action_result("query_member_balance", {"card": "8888"}, "余额 320 元", 4)
    result = detect_stuck(messages)
    assert result.stuck
    assert result.pattern == "action_observation"


# ══════════════════════════════ 场景 2：同 action 连续报错 ══════════════════════════════

def test_action_error_loop_detected():
    messages = [{"role": "user", "content": "帮我导出昨天的账单"}]
    messages += _repeat_action_result("diagnose_from_pos", {"date": "2026-07-02"},
                                       "[工具执行失败] diagnose_from_pos（ConnectionError）: 连不上POS", 3)
    result = detect_stuck(messages)
    assert result.stuck
    assert result.pattern == "action_error"


# ══════════════════════════════ 场景 3：独白 ══════════════════════════════

def test_monologue_detected():
    messages = [
        {"role": "user", "content": "帮我想想这周朋友圈怎么发"},
        {"role": "assistant", "content": "我先想想从哪个角度切入。"},
        {"role": "assistant", "content": "再想想有没有更好的切入点。"},
        {"role": "assistant", "content": "还是没想好，再想一下。"},
    ]
    result = detect_stuck(messages)
    assert result.stuck
    assert result.pattern == "monologue"


def test_monologue_not_triggered_when_interrupted_by_tool_call():
    """独白计数一旦被"真调了个工具"打断就该清零，不能跨过一次真实动作继续累计。"""
    messages = [
        {"role": "user", "content": "帮我想想这周朋友圈怎么发"},
        {"role": "assistant", "content": "我先想想。"},
        {"role": "assistant", "content": "再想想。"},
    ]
    messages.append(_action_msg("look_up_knowledge", "k1", {"q": "朋友圈"}))
    messages.append(_result_msg("k1", "查到若干条相关知识"))
    messages += [
        {"role": "assistant", "content": "好，有点思路了。"},
        {"role": "assistant", "content": "继续想。"},
    ]
    result = detect_stuck(messages)
    assert not result.stuck


# ══════════════════════════════ 场景 4：A-B-A-B 交替 ══════════════════════════════

def test_alternating_pattern_detected():
    messages = [{"role": "user", "content": "帮我把海报做出来"}]
    pattern = ["gen_a", "gen_b"] * 3  # A,B,A,B,A,B —— 6 个 action，正好卡在阈值上
    for i, name in enumerate(pattern):
        args = {"style": "复古"} if name == "gen_a" else {"style": "清新"}
        cid = f"c{i}"
        messages.append(_action_msg(name, cid, args))
        messages.append(_result_msg(cid, f"result-{name}"))
    result = detect_stuck(messages)
    assert result.stuck
    assert result.pattern == "alternating"


def test_alternating_not_triggered_below_threshold():
    """只交替了 2 轮（4 个 action，不到阈值 6）——不算打转，可能只是在正常比较两种方案。"""
    messages = [{"role": "user", "content": "帮我把海报做出来"}]
    pattern = ["gen_a", "gen_b"] * 2
    for i, name in enumerate(pattern):
        args = {"style": "复古"} if name == "gen_a" else {"style": "清新"}
        cid = f"c{i}"
        messages.append(_action_msg(name, cid, args))
        messages.append(_result_msg(cid, f"result-{name}"))
    result = detect_stuck(messages)
    assert not result.stuck


# ══════════════════════════════ 边界：短历史 / 空历史 ══════════════════════════════

def test_empty_or_short_history_not_flagged():
    assert not detect_stuck([]).stuck
    assert not detect_stuck([{"role": "user", "content": "你好"}]).stuck


# ══════════════════════════════ 用户插话清零 ══════════════════════════════

def test_user_message_clears_stuck_window():
    """打转窗口前半段已经很像在原地转了，但老板中途真插了一句话——扫描边界应该挪到插话之后，
    插话之后只剩 1 次重复，不该再判定为打转。"""
    messages = [{"role": "user", "content": "帮我查一下今天的营业额"}]
    messages += _repeat_action_result("get_today_recommendation", {}, "查询失败", 4)
    messages.append({"role": "user", "content": "[用户补充/纠偏] 等等，先别查这个了，帮我看看会员数据"})
    messages += _repeat_action_result("get_today_recommendation", {}, "查询失败", 1, start=10)
    result = detect_stuck(messages)
    assert not result.stuck


def test_synthetic_system_nudge_does_not_reset_window():
    """系统自己插的"继续吧"式 nudge（不是老板真插话）不该被当成边界——夹在中间的打转还是要能测出来。"""
    messages = [{"role": "user", "content": "帮我查一下今天的营业额"}]
    messages += _repeat_action_result("get_today_recommendation", {}, "查询失败", 2)
    messages.append({"role": "user", "content": "[系统提醒] 检测到你可能卡在重复模式里，换个思路。"})
    messages += _repeat_action_result("get_today_recommendation", {}, "查询失败", 2, start=10)
    result = detect_stuck(messages)
    assert result.stuck  # 4 次里虽然夹了个系统 nudge，但它不算真人打断，整体仍应判定为打转


# ══════════════════════════════ 合法重复不被误伤（Gemini"什么不算循环"判据的落地）══════════════════════════════

def test_legit_write_batch_single_call_not_flagged():
    """write_batch 一次写一批本身只是【一次】调用，压根没有重复可言。"""
    messages = [
        {"role": "user", "content": "帮我写一周朋友圈"},
        _action_msg("write_batch", "b1", {"need": "周末活动", "count": 7}),
        _result_msg("b1", "1、... 2、... 3、..."),
    ]
    result = detect_stuck(messages)
    assert not result.stuck


def test_legit_multi_image_different_prompt_not_flagged():
    """连续生成多张图，但每次描述都不同（正常的多样化出图），args 不同 → 不是同一个 action。"""
    messages = [{"role": "user", "content": "帮我出几张不同风格的海报"}]
    descriptions = ["复古台球厅海报，暖色调", "赛博朋克风台球海报，霓虹光", "简约北欧风台球海报，原木色", "国潮风台球海报，红金配色"]
    for i, desc in enumerate(descriptions):
        cid = f"img{i}"
        messages.append(_action_msg("generate_image", cid, {"description": desc}))
        messages.append(_result_msg(cid, f"已生成：{desc}"))
    result = detect_stuck(messages)
    assert not result.stuck


def test_legit_same_file_different_edits_not_flagged():
    """同一个文件连续编辑多处——old_string/new_string 不同，args 不同 → 不是同一个 action。"""
    messages = [{"role": "user", "content": "帮我把这份文案的几个地方改一下"}]
    edits = [("周末不开门", "周末正常营业"), ("电话010", "电话021"), ("满100减20", "满200减50"), ("地址A", "地址B")]
    for i, (old, new) in enumerate(edits):
        cid = f"edit{i}"
        messages.append(_action_msg("edit_file", cid, {"path": "文案.txt", "old_string": old, "new_string": new}))
        messages.append(_result_msg(cid, "已保存"))
    result = detect_stuck(messages)
    assert not result.stuck


def test_legit_cross_file_batch_not_flagged():
    """跨文件批量操作——同一个工具名、但每次目标文件不同，args 不同 → 不是同一个 action。"""
    messages = [{"role": "user", "content": "帮我把这几个文件都加上页眉"}]
    for i in range(5):
        cid = f"f{i}"
        messages.append(_action_msg("edit_file", cid, {"path": f"文件{i}.txt", "old_string": "", "new_string": "页眉"}))
        messages.append(_result_msg(cid, "已保存"))
    result = detect_stuck(messages)
    assert not result.stuck


def test_legit_retry_with_different_params_not_flagged():
    """换参数重试——每次查询词不同，args 不同 → 不是同一个 action，即便连续报错也不算打转。"""
    messages = [{"role": "user", "content": "帮我搜一下最近的台球比赛新闻"}]
    queries = ["台球比赛 2026", "斯诺克比赛 最新", "中式台球 赛事", "台球俱乐部 比赛"]
    for i, q in enumerate(queries):
        cid = f"s{i}"
        messages.append(_action_msg("search_web", cid, {"query": q}))
        messages.append(_result_msg(cid, "[工具执行失败] search_web（TimeoutError）: 请求超时"))
    result = detect_stuck(messages)
    assert not result.stuck
