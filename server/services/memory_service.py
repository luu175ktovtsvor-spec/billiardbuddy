# -*- coding: utf-8 -*-
"""店脑（AI 记忆中枢）核心服务。

职责：从交互里抽取门店记忆、把新旧记忆整合成去重最新的一份、格式化注入 prompt。
设计要点（来自真实评估的结论）：
- 用 DeepSeek JSON 模式做抽取/整合（已验证支持且可靠）。
- consolidate 直接返回**整合后的最终列表**（不是 ADD/UPDATE 操作）——绕开标签模糊，按结果对错衡量。
- 严禁编造：prompt 明确"没提到的不写"，并在评估里用防幻觉用例守住。
- 验收标准见 tests/eval_store_brain.py。
"""
import json
import logging
from dataclasses import dataclass

import httpx
from openai import AsyncOpenAI

from config import settings

logger = logging.getLogger(__name__)


@dataclass
class Memory:
    type: str             # semantic | preference | operational | episodic
    content: str
    confidence: str = "medium"


_TYPE_MAP = {
    "semantic": "semantic", "语义事实": "semantic", "语义": "semantic", "事实": "semantic",
    "preference": "preference", "偏好": "preference",
    "operational": "operational", "运营模式": "operational", "运营": "operational",
    "episodic": "episodic", "情景": "episodic", "事件": "episodic",
}
_CONF_MAP = {"high": "high", "medium": "medium", "low": "low", "高": "high", "中": "medium", "低": "low"}


def _norm_type(t: str) -> str:
    return _TYPE_MAP.get((t or "").strip(), "semantic")


def _norm_conf(c: str) -> str:
    return _CONF_MAP.get((c or "").strip(), "medium")


_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(
            base_url=settings.deepseek_base_url,
            api_key=settings.deepseek_api_key,
            timeout=httpx.Timeout(60.0, connect=10.0),
        )
    return _client


async def _json_call(system: str, user: str) -> dict:
    """调 DeepSeek JSON 模式，解析失败返回 {}（不抛，调用方兜底）。"""
    resp = await _get_client().chat.completions.create(
        model=settings.text_model_name,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        response_format={"type": "json_object"},
        temperature=0.2,
        max_tokens=900,
    )
    raw = resp.choices[0].message.content or ""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("memory_service JSON 解析失败: %s", raw[:200])
        return {}


_EXTRACT_SYS = (
    "你是门店记忆抽取器。从下面这段门店对话/内容里，抽取值得长期记住的信息，输出 JSON。\n"
    "规则：\n"
    "1. 只抽对话里**明确说了**或**能可靠推断**的；**绝不编造没提到的信息**"
    "（没提价格就不写价格，没提助教/包厢就不写）。\n"
    "2. 否定也要如实记（说'没有包厢'就记'没有包厢'，不能记成有）。\n"
    "3. 每条精炼成一句可复用的事实/偏好；天气、吃饭等与门店运营无关的闲聊不要记。\n"
    "type 取值（英文）：semantic(门店客观事实) | preference(老板的风格/喜好) | "
    "operational(运营模式/客流节奏) | episodic(发生过的具体事件)\n"
    '格式：{"memories":[{"type":"semantic","content":"...","confidence":"high|medium|low"}]}\n'
    '没有值得记的就返回 {"memories":[]}。'
)

_CONSOLIDATE_SYS = (
    "你是门店记忆整合器。给你这家店的【已有记忆】和【新记忆】，"
    "合并成一份**去重、最新**的完整记忆列表，输出 JSON。\n"
    "规则：\n"
    "1. 同一件事有了新值（改价、数量变化等）→ 用新的**替换**旧的，**不要两条都留**。\n"
    "2. 重复或只是换个说法 → 合并成**一条**。\n"
    "3. 互相矛盾 → 以**新记忆**为准。\n"
    "4. 不同的事实 → 都保留。\n"
    "5. 新记忆没带来新信息 → 保留已有那条即可。\n"
    "输出整合后的**完整列表**（是结果列表，不是操作指令）。\n"
    "type：semantic|preference|operational|episodic\n"
    '格式：{"memories":[{"type":"...","content":"...","confidence":"high|medium|low"}]}'
)


def _to_memories(data: dict) -> list[Memory]:
    out: list[Memory] = []
    for m in (data.get("memories") or []):
        content = (m.get("content") or "").strip()
        if content:
            out.append(Memory(_norm_type(m.get("type")), content, _norm_conf(m.get("confidence"))))
    return out


async def extract_memories(interaction_text: str) -> list[Memory]:
    """从一次交互（对话/生成需求/反馈）里抽取值得长期记住的门店记忆。"""
    if not interaction_text or not interaction_text.strip():
        return []
    return _to_memories(await _json_call(_EXTRACT_SYS, interaction_text.strip()))


async def consolidate_memories(existing: list[Memory], new: list[Memory]) -> list[Memory]:
    """把新记忆并入已有记忆，返回去重、最新的**完整列表**。
    解析失败时兜底返回并集（宁可暂时重复，也不丢信息）。"""
    if not new:
        return list(existing)
    payload = (
        "【已有记忆】\n"
        + json.dumps([{"type": m.type, "content": m.content} for m in existing], ensure_ascii=False)
        + "\n【新记忆】\n"
        + json.dumps([{"type": m.type, "content": m.content} for m in new], ensure_ascii=False)
    )
    merged = _to_memories(await _json_call(_CONSOLIDATE_SYS, payload))
    return merged if merged else list(existing) + list(new)


def format_memories_for_prompt(memories: list[Memory]) -> str:
    """把店脑格式化成注入 prompt 的稳定前缀文本（空记忆返回空串）。"""
    if not memories:
        return ""
    lines = "\n".join(f"- {m.content}" for m in memories)
    return "【这家店的记忆（AI 已了解，按需自然运用，不要照抄）】\n" + lines
