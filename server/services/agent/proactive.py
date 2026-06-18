"""主动出击（P2.3）：管家从"你问才动"→"主动把今天该做的备成草稿等你过目"。

复用「今日推荐」引擎当素材源（它据日期/画像/节日/成长阶段/行为信号算出"今天该做啥"），
对其中【能直接出文字】的推荐逐条预生成草稿，老板打开就能看到"已经给你备好的几条"，改改就用。

铁律（对齐项目边界）：
- 只产【草稿/建议】，绝不自动发布、绝不自动群发（封号红线）。
- 只备【文字】草稿；海报/生图类（花钱、走审批）跳过——不背着老板烧钱、不占生图额度。
- 走 generate_workbench 既有管道：配额/落库/店脑/合规过滤全生效；故由老板主动触发（点一下），
  不做无人值守的定时自动生成（BYOK 下不能背着人花钱；要定时自动是另一个 opt-in 开关，后续做）。
"""
import logging

from services.content_service import generate_workbench
from services.dashboard_service import get_today_dashboard

logger = logging.getLogger(__name__)


def _is_text_draftable(rec) -> bool:
    """这条推荐能不能直接出一段文字草稿（排除海报/生图等花钱、走审批的）。"""
    payload = rec.suggested_payload or {}
    if not payload.get("user_intent"):
        return False
    # 海报/生图类：action_url 指向 posters，或主题是出图——跳过
    url = (rec.action_url or "")
    if "/posters" in url or "poster" in (payload.get("prompt_key") or ""):
        return False
    if "海报" in (rec.title or "") or "出图" in (rec.title or ""):
        return False
    return True


async def generate_daily_drafts(db, store, user, max_drafts: int = 3) -> list[dict]:
    """据今日推荐，预生成最多 max_drafts 条文字草稿。返回 [{title, category, prompt_key, content}]。

    单条生成失败（模板异常/配额耗尽）不影响其余——跳过该条、继续；最终返回成功的那些。
    """
    dash = await get_today_dashboard(db, store)
    role = getattr(user, "my_role", None) or "manager"
    drafts: list[dict] = []

    for rec in dash.recommendations:
        if len(drafts) >= max_drafts:
            break
        if not _is_text_draftable(rec):
            continue
        payload = rec.suggested_payload or {}
        intent = payload.get("user_intent")
        prompt_key = payload.get("prompt_key") or None
        try:
            gen = await generate_workbench(
                db, store, user,
                user_intent=intent,
                role=role,
                prompt_key=prompt_key,
                concise=True,
            )
        except Exception:
            logger.exception("每日草稿生成失败，跳过该条: %s", rec.title)
            continue
        drafts.append({
            "title": rec.title,
            "category": rec.category,
            "prompt_key": prompt_key,
            "content": gen.result,
        })

    return drafts
