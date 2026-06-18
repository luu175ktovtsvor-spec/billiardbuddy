"""Canvas（画布）定向改写——成品在右侧画布展开后，老板"指着某处说改这里"。

核心逻辑（成败处）：圈选了一段 → 让大模型【只返回改写后的那一段】，服务端精确把它
拼回原文（content.replace(选中段, 新段, 1)）——**改这里、不动别处**，避免整篇重写带来的"飘"
（模型顺手改了没让它动的地方）。没圈选 / 影响全篇的指令 → 整篇修订。

复用 run_generation 统一管道：配额、合规过滤、落库、BYOK 路由、店脑全部生效，不另起炉灶。
"""
import logging

from sqlalchemy.ext.asyncio import AsyncSession

from models.store import Store
from models.user import User
from services.content_service import run_generation

logger = logging.getLogger(__name__)

# 单段改写给的 token 上限（成品里一段通常不长，给够即可）；整篇修订给足。
_SPAN_MAX_TOKENS = 1200
_WHOLE_MAX_TOKENS = 3000


async def canvas_edit(
    db: AsyncSession,
    store: Store,
    user: User | None,
    *,
    content: str,
    instruction: str,
    selection: str | None = None,
    deliverable_type: str = "内容",
) -> dict:
    """成品定向改写。

    - selection 非空且能在 content 中找到 → 【只改这一段】，返回拼好的整篇 + 改后的那段。
    - 否则 → 整篇按指令修订。
    返回 {content, mode, changed_span?}。
    """
    content = content or ""
    instruction = (instruction or "").strip()
    dtype = (deliverable_type or "内容").strip() or "内容"
    if not instruction:
        return {"content": content, "mode": "noop"}

    sel = (selection or "").strip()
    # —— 定向改写：只换圈中那段（核心）——
    if sel and sel in content:
        prompt = (
            f"下面是一份已经写好的{dtype}成品。老板圈中了其中一段，要你【只改这一段】、其余一个字都别动。\n"
            f"直接返回改写后的【这一段】文本即可——不要返回整篇、不要解释、不要加引号或任何前后缀。\n\n"
            f"【整篇成品（仅供你理解上下文，不要返回它）】\n{content}\n\n"
            f"【老板圈中、要你改的这一段】\n{sel}\n\n"
            f"【怎么改】{instruction}"
        )
        gen = await run_generation(
            db, store, user, prompt=prompt, gen_type="canvas_edit", sub_type="span",
            user_input=instruction, max_tokens=_SPAN_MAX_TOKENS,
            thinking={"type": "disabled"},  # 机械改写不需思考：关掉，省额度、避免思考型模型吐空
        )
        new_span = (gen.result or "").strip()
        if not new_span:
            return {"content": content, "mode": "span", "changed_span": ""}
        # 服务端精确拼回：只替换第一处命中，其余原样 → 改这里不动别处
        new_content = content.replace(sel, new_span, 1)
        return {"content": new_content, "mode": "span", "changed_span": new_span}

    # —— 整篇修订：没圈选 / 圈的内容已找不到（成品被改过）/ 影响全篇的指令 ——
    prompt = (
        f"下面是一份已经写好的{dtype}成品。按老板的要求整体修订，返回【完整修订后的成品】，"
        f"保留原有结构与风格，只按要求改动，不要解释、不要加引号。\n\n"
        f"【成品】\n{content}\n\n【怎么改】{instruction}"
    )
    gen = await run_generation(
        db, store, user, prompt=prompt, gen_type="canvas_edit", sub_type="whole",
        user_input=instruction, max_tokens=_WHOLE_MAX_TOKENS,
        thinking={"type": "disabled"},  # 整篇修订同样不需思考
    )
    return {"content": (gen.result or "").strip() or content, "mode": "whole"}
