"""真实端到端冒烟：用真实 DeepSeek 跑一次 Agent 循环，验证 function calling 真能用。

⚠️ 会真实调用 DeepSeek（消耗少量文本 token，约几分钱），需 server/.env 配好 deepseek_api_key。
从 server/ 目录运行：  uv run python scripts/smoke_agent.py
铁律：只跑一次，不重试、不循环刷请求。
"""
import asyncio
import sys

sys.path.insert(0, ".")  # 允许从 server/ 直接跑，使 `from services...` 可用

import services.ai  # noqa: F401  注册 provider
import services.agent.tools  # noqa: F401  注册内置工具
from config import settings
from services.agent.loop import run_agent_loop_stream
from services.agent.registry import default_registry


async def main():
    print(f"编排模型: {settings.effective_orchestration_provider} / {settings.effective_orchestration_model}")
    print(f"可用工具: {default_registry.names()}")
    print("-" * 60)
    msg = "今天几号、星期几？这个时间点适合在台球房搞个什么活动？一句话建议。"
    print(f"用户: {msg}\n")
    saw_tool = False
    try:
        async for ev in run_agent_loop_stream(user_message=msg, registry=default_registry, max_turns=4):
            t = ev.get("type")
            if t == "token":
                print(ev["content"], end="", flush=True)
            elif t == "tool_call":
                saw_tool = True
                print(f"\n[调用工具] {ev['tool']} args={ev['args']}")
            elif t == "tool_result":
                print(f"[工具结果] {ev['content']}")
            elif t == "final":
                print(f"\n[最终答复] {ev['content']}")
            elif t == "done":
                print(f"\n[完成] turns={ev['turns']} reason={ev['stopped_reason']}")
            elif t == "error":
                print(f"\n[错误] {ev['error']}")
        print("-" * 60)
        print(f"冒烟结论: {'✅ 模型真实调用了工具' if saw_tool else '⚠️ 本轮模型未调用工具（可能直接作答）'}")
    except Exception as e:
        print(f"\n冒烟失败: {type(e).__name__}: {e}")
        print("（若是'AI 服务未配置'，说明 server/.env 没配 deepseek_api_key）")


if __name__ == "__main__":
    asyncio.run(main())
