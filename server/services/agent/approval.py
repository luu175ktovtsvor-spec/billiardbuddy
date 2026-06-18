"""审批提案绑定（P3.2）：给"待确认"的工具调用签名，执行时校验参数没被篡改。

审批闸是 proposal 模式：loop 吐 approval_request（含 tool+args）→ 前端弹卡 → 人点确认 →
独立的 /agent/execute 带 tool+args 回来执行。缝在于：execute 信任前端回传的 args，没核对它
就是当初提案的那组。这里用 HMAC(SECRET_KEY, 规范化(tool,args)) 给提案签个 token，
execute 拿 token 重算比对——只有服务端能为某组 args 产出合法 token，前端改了 args 就对不上。

威胁其实不高（用户只能篡改自己会话的审批，等于自己让 Agent 干别的），但这是干净的完整性校验。
"""
import hashlib
import hmac
import json

from config import settings


def _canonical(tool: str, args: dict | None) -> str:
    """规范化 (tool, args)：sort_keys 消除键序差异，紧凑分隔符消除空格差异，保证两端一致。"""
    return json.dumps(
        {"tool": tool, "args": args or {}},
        sort_keys=True, ensure_ascii=False, separators=(",", ":"),
    )


def sign_approval(tool: str, args: dict | None) -> str:
    key = (settings.secret_key or "").encode("utf-8")
    return hmac.new(key, _canonical(tool, args).encode("utf-8"), hashlib.sha256).hexdigest()


def verify_approval(tool: str, args: dict | None, token: str | None) -> bool:
    """token 与 (tool,args) 是否匹配。token 为空 → False（由调用方决定是否放行旧客户端）。"""
    if not token:
        return False
    return hmac.compare_digest(sign_approval(tool, args), token)
