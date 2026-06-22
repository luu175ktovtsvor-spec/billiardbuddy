"""IM 适配 · Telegram —— 对标 Claude Code 的 IM 渠道适配器（adapters/）。

把 Agent 接到 Telegram bot：长轮询收消息 → 跑 agent → 回消息。stdlib urllib（无依赖）。
配置（env / 桌面注入）：`TELEGRAM_BOT_TOKEN`、`TELEGRAM_ALLOWED_CHATS`（逗号分隔的 chat_id，空=全允许）。
安全：IM 无法弹审批卡 → **IM 安全工具集**：排除所有需审批/写改/跑命令/操作电脑/对外的工具，只查只生成。
其它平台（飞书/微信/钉钉）照此结构加一个适配器即可（poll/parse/send + 同一个 agent_runner）。
"""
import json
import os
import urllib.parse
import urllib.request

_IM_SYSTEM_PROMPT = (
    "你是「台球运营管家」的 IM 助手。老板通过聊天软件问你，你帮他查资料、写文案、出主意、做经营建议。"
    "你**只能查询和生成**：不能改本机文件、不能跑命令、不能操作电脑、不能对外发布——那些要老板在桌面 app 里亲自做。"
    "回答简洁、直接、口语化（这是手机聊天场景）。"
)


def _api_call(token: str, method: str, params: dict | None = None, timeout: int = 35) -> dict:
    url = f"https://api.telegram.org/bot{token}/{method}"
    try:
        if params:
            req = urllib.request.Request(url, data=urllib.parse.urlencode(params).encode())
        else:
            req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "description": str(e)}


def get_updates(token: str, offset: int) -> tuple[list, int]:
    res = _api_call(token, "getUpdates", {"offset": offset, "timeout": 30})
    if not res.get("ok"):
        return [], offset
    updates = res.get("result") or []
    new_offset = offset
    for u in updates:
        new_offset = max(new_offset, int(u.get("update_id", 0)) + 1)
    return updates, new_offset


def send_message(token: str, chat_id, text: str) -> None:
    _api_call(token, "sendMessage", {"chat_id": chat_id, "text": (text or "")[:4000]})


def _allowed(chat_id, allowed: set) -> bool:
    return not allowed or str(chat_id) in allowed


async def handle_update(update: dict, token: str, allowed: set, agent_runner) -> None:
    msg = update.get("message") or {}
    text = (msg.get("text") or "").strip()
    chat_id = (msg.get("chat") or {}).get("id")
    if not text or chat_id is None:
        return
    if not _allowed(chat_id, allowed):
        return
    try:
        reply = await agent_runner(text)
    except Exception as e:  # noqa: BLE001
        reply = f"处理出错：{type(e).__name__}"
    if reply:
        send_message(token, chat_id, reply)


def _im_safe_registry():
    """IM 安全工具集 = 通用工具去掉【需审批 / 写改 / 跑命令 / 操作电脑】的（IM 无法确认）。"""
    from services.agent.registry import general_registry, ToolRegistry
    reg = ToolRegistry()
    for t in general_registry().all():
        if getattr(t, "requires_approval", False) or getattr(t, "force_confirm", False):
            continue
        if t.name in ("run_command", "run_background") or t.name.startswith("computer_"):
            continue
        reg.register(t)
    return reg


async def _run_agent_for_im(text: str) -> str:
    """IM 收到消息 → 跑一遍受限 agent，返回最终文本。失败/没配 key 给友好提示。"""
    try:
        from sqlalchemy import select

        from db.session import async_session
        from models.store import Store
        from services.agent.context import AgentContext
        from services.agent.loop import run_agent_loop
        from services.ai.failover import build_resilient_text_provider

        async with async_session() as db:
            store = (await db.execute(select(Store).limit(1))).scalars().first()
            if store is None:
                return "还没配置门店/模型，请先在桌面 app 里配好。"
            provider = build_resilient_text_provider(store)
            ctx = AgentContext(db=db, store=store, permission_mode="ask")
            result = await run_agent_loop(
                user_message=text, registry=_im_safe_registry(), ctx=ctx,
                system_prompt=_IM_SYSTEM_PROMPT, provider=provider, max_turns=6,
            )
            return (getattr(result, "final_text", "") or "").strip() or "（没有产出）"
    except Exception as e:  # noqa: BLE001
        return f"处理出错：{type(e).__name__}"


async def handle_im_webhook(text: str, provided_secret: str | None) -> tuple[int, dict]:
    """通用 IM webhook：密钥校验 → 跑 IM 安全 agent → 回复。返回 (status, body)。

    secret 来自 env `IM_WEBHOOK_SECRET`（未设=端点禁用，403）。飞书/微信/钉钉/WhatsApp 的 bot
    配成 POST 到 `/api/v1/agent/im/webhook`（配内网穿透）、带 `X-Im-Secret` 头即可，与 Telegram 长轮询凑齐两条进入路径。
    """
    secret = os.environ.get("IM_WEBHOOK_SECRET")
    if not secret or provided_secret != secret:
        return 403, {"detail": "forbidden"}
    reply = await _run_agent_for_im(text or "")
    return 200, {"reply": reply}


async def telegram_loop(stop_event) -> None:
    """Telegram 长轮询 loop（配了 TELEGRAM_BOT_TOKEN 才起）。"""
    import asyncio
    token = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    if not token:
        return
    allowed = {c.strip() for c in (os.environ.get("TELEGRAM_ALLOWED_CHATS") or "").split(",") if c.strip()}
    offset = 0
    while not stop_event.is_set():
        updates = []
        try:
            updates, offset = await asyncio.to_thread(get_updates, token, offset)
            for u in updates:
                await handle_update(u, token, allowed, _run_agent_for_im)
        except Exception:
            pass
        if not updates:
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=2)
            except asyncio.TimeoutError:
                pass
