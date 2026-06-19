"""SH-1 · 缺失 tool_result 自愈（消息配对修复）。

OpenAI/Anthropic 兼容端点有硬约束：每个 assistant 的 tool_calls 都必须配上一条
role:tool 回灌（同 tool_call_id），且不能有「孤儿 tool_result」（无对应 tool_call 的 role:tool）。
违反任一条，下一轮 provider.generate 会直接 400、整轮请求崩。

正常路径下 `loop.py` 总是逐个回灌配对结果，没问题。但①工具执行走某些异常分支没回灌、
②未来 SH-6/SH-7/SH-8 压缩或改历史造出孤儿/缺配对时，就会触发上面的 400。本模块是发请求前
的最后一道配对自检——纯函数、无新状态，在 `loop.py` 每次 provider.generate 之前调一遍兜住。

机制原理参见 Anthropic TU「When Claude uses tools」描述的「工具调用→结果回灌」闭环契约
（https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview）；本实现为 clean-room
自写，不含任何第三方源码片段。
"""

# 缺失 tool_result 的合成占位内容（让模型知道这步结果丢了、可重试，而非把缺失当真空答复）。
_MISSING_RESULT_MARK = "[工具结果因内部错误缺失，可重试]"


def ensure_tool_pairing(messages: list[dict]) -> list[dict]:
    """修复 messages 里 assistant.tool_calls 与 role:tool 结果的配对，返回修好的新列表。

    四件事（顺序固定）：
    1. 缺失补全：assistant 声明了 tool_calls 的某 id 没有配对的 role:tool → 紧跟该 assistant
       消息后插一条合成 tool 结果（占位文本，提示模型可重试）。
    2. 孤儿删除：role:tool 的 tool_call_id 不在任何 assistant.tool_calls 里 → 删掉（防 API 拒孤儿）。
    3. 去重：同一 tool_call_id 出现多条 role:tool，只保第一条（API 拒重复 id）。
    4. 顺序保持：除上述增删外，其余消息原样保留原相对顺序（不破 prompt-cache 前缀，配合 SH-9）。

    纯函数：不改入参列表（返回新列表）。无 id 的 tool_call/tool 消息按"无法配对"处理——
    缺 id 的 tool_call 不强行补（补了也对不上），缺 id 的 role:tool 视为孤儿删掉。
    """
    if not messages:
        return list(messages)

    # ① 收集 assistant 声明过的 tool_call id（expected）——保留出现顺序，供补全时定位插入点。
    expected: set[str] = set()
    for m in messages:
        if m.get("role") == "assistant":
            for tc in (m.get("tool_calls") or []):
                tc_id = tc.get("id")
                if tc_id is not None:
                    expected.add(tc_id)

    # ② 一遍扫：删孤儿 role:tool、对合法 role:tool 去重（同 id 只保第一条）；
    #    同时记录每个 assistant 后面已经实际给出了哪些 id 的结果（present_after[idx]）。
    out: list[dict] = []
    seen_results: set[str] = set()  # 已保留的合法 tool_call_id（用于去重）
    for m in messages:
        if m.get("role") == "tool":
            tc_id = m.get("tool_call_id")
            if tc_id not in expected:
                continue  # 孤儿：无对应 tool_call → 删
            if tc_id in seen_results:
                continue  # 重复 id：只保第一条 → 删后续
            seen_results.add(tc_id)
            out.append(m)
        else:
            out.append(m)

    # ③ 补缺失：逐个 assistant，紧随其后补齐它 tool_calls 里尚无结果的 id。
    #    "尚无结果" = 该 id 在整个对话里没有被任一保留的 role:tool 覆盖（seen_results）。
    #    在该 assistant 之后、下一条 assistant 之前的位置插入（紧贴其后即可，满足 API 配对要求）。
    repaired: list[dict] = []
    for m in out:
        repaired.append(m)
        if m.get("role") == "assistant" and m.get("tool_calls"):
            for tc in m["tool_calls"]:
                tc_id = tc.get("id")
                if tc_id is None or tc_id not in seen_results:
                    # 缺 id 或缺结果 → 补一条合成结果。缺 id 的也补（带原 id=None 也无害，但更稳是跳过）：
                    if tc_id is None:
                        continue  # 无 id 无法配对，补了也对不上，不补
                    repaired.append({
                        "role": "tool",
                        "tool_call_id": tc_id,
                        "content": _MISSING_RESULT_MARK,
                    })
                    seen_results.add(tc_id)  # 标记已补，防同 id 重复补
    return repaired
