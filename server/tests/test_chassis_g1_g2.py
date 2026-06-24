"""底盘/定位（专题 G.1/G.2）批次：工具统一超时 + 带图历史估算/截断 + 台球技能门控 + autocompact 默认窗口。

锁住：
- _execute_tool 给工具套统一超时兜底：挂死的工具被掐断、回灌"超时"而非卡死整轮；正常工具不受影响；
  tool.timeout=0/<=0 表示豁免兜底。
- _estimate_tokens 对多模态 content：图片按固定 token 计、绝不把 base64 当字符乱算（旧版 str(list) bug）。
- _cap_history 对多模态历史（list of parts）：逐 text 段截断、图片段保留，len(list) 当字符数的类型 bug 消除。
- 台球领域技能仅 @台球（billiards_mode）时披露，通用模式剔除（守"通用 Agent 为默认"定位）。
- _model_ctx_window：环境变量最高优先；内置 mimo 给安全网窗口；未知/BYOK 模型保持 None（不回归）。
"""
import asyncio
import os

from services.agent.context import AgentContext
from services.agent.loop import _execute_tool, _estimate_tokens, _IMG_TOKEN_EST, _DEFAULT_TOOL_TIMEOUT
from services.agent.registry import Tool, ToolRegistry
from services.agent import skills as sk


# ---------- G.1 工具统一超时兜底 ----------

def _reg_with(tool: Tool) -> ToolRegistry:
    reg = ToolRegistry()
    reg.register(tool)
    return reg


def test_tool_timeout_kills_hung_tool():
    """挂死的工具（睡得比 timeout 久）被掐断，回灌"超时"提示、不抛、不卡死。"""
    async def hang(a, c):
        await asyncio.sleep(5)
        return "永远到不了"

    reg = _reg_with(Tool(name="hang", description="x", parameters={"type": "object", "properties": {}},
                         handler=hang, timeout=0.05))
    out = asyncio.run(_execute_tool(reg, "hang", {}, AgentContext()))
    assert "超时" in out and "hang" in out


def test_tool_timeout_lets_fast_tool_finish():
    """正常很快返回的工具，套了 timeout 也照常拿到结果。"""
    async def quick(a, c):
        return "做完了"

    reg = _reg_with(Tool(name="quick", description="x", parameters={"type": "object", "properties": {}},
                         handler=quick, timeout=5))
    out = asyncio.run(_execute_tool(reg, "quick", {}, AgentContext()))
    assert out == "做完了"


def test_tool_timeout_zero_means_no_backstop():
    """tool.timeout<=0 = 豁免兜底：不套 wait_for，长跑工具不被掐（这里只验证能正常返回）。"""
    async def quick(a, c):
        return "ok"

    reg = _reg_with(Tool(name="free", description="x", parameters={"type": "object", "properties": {}},
                         handler=quick, timeout=0))
    out = asyncio.run(_execute_tool(reg, "free", {}, AgentContext()))
    assert out == "ok"


def test_default_tool_timeout_is_generous():
    """全局默认兜底足够宽，别误杀生图(≈900s)/子代理这类正经慢活。"""
    assert _DEFAULT_TOOL_TIMEOUT >= 900


# ---------- G.1 带图 _estimate_tokens ----------

def test_estimate_tokens_image_counted_as_fixed_not_base64():
    """多模态 content 里的图片按固定 token 计，绝不把 base64 正文当字符（否则量级爆炸）。"""
    big_b64 = "data:image/png;base64," + "A" * 200_000
    msgs = [{"role": "user", "content": [
        {"type": "text", "text": "看看这张图"},
        {"type": "image_url", "image_url": {"url": big_b64}},
    ]}]
    est = _estimate_tokens(msgs)
    # 文本极短(≈数 token) + 一张图(_IMG_TOKEN_EST)；远小于把 20 万 base64 字符当 token 的量级
    assert _IMG_TOKEN_EST <= est < _IMG_TOKEN_EST + 200
    assert est < 50_000  # 绝不接近 base64 字符数


def test_estimate_tokens_list_text_still_counted():
    """多模态里的纯文本段照常计字符。"""
    msgs = [{"role": "user", "content": [{"type": "text", "text": "啊" * 400}]}]
    assert _estimate_tokens(msgs) >= 400  # 中文一字≈1 token


# ---------- G.1 带图 _cap_history ----------

def test_cap_history_truncates_list_text_and_keeps_image():
    from api.v1.agent import _cap_history, _HIST_MAX_CHARS
    big_text = "好" * (_HIST_MAX_CHARS + 5000)
    hist = [{"role": "user", "content": [
        {"type": "text", "text": big_text},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}},
    ]}]
    out = _cap_history(hist)
    parts = out[0]["content"]
    text_parts = [p for p in parts if p.get("type") == "text"]
    img_parts = [p for p in parts if p.get("type") == "image_url"]
    assert len(img_parts) == 1  # 图片段保留
    assert len(text_parts[0]["text"]) <= _HIST_MAX_CHARS  # 文本被真截断（旧版 list 截断失效）


def test_cap_history_str_unchanged_behavior():
    from api.v1.agent import _cap_history, _HIST_MAX_CHARS
    hist = [{"role": "user", "content": "x" * (_HIST_MAX_CHARS + 100)}]
    out = _cap_history(hist)
    assert len(out[0]["content"]) == _HIST_MAX_CHARS


# ---------- G.2 台球技能门控 ----------

def _skill(name, pack=""):
    return sk.Skill(name=name, description=f"{name} 描述", body="正文", source="bundled",
                    path=f"/x/{name}/SKILL.md", knowledge_pack=pack)


def test_billiards_skill_classification():
    assert sk.is_billiards_skill(_skill("escort-service-sop")) is True       # 内置台球名单
    assert sk.is_billiards_skill(_skill("mystore-pack", pack="billiards")) is True  # frontmatter 自标
    assert sk.is_billiards_skill(_skill("research")) is False                # 通用技能
    assert sk.is_billiards_skill(_skill("spreadsheet")) is False


def test_filter_skills_hides_billiards_in_general_mode():
    skills = [_skill("research"), _skill("escort-service-sop"), _skill("dating-app-traffic"), _skill("commit")]
    general = {s.name for s in sk.filter_skills_by_mode(skills, billiards_mode=False)}
    assert general == {"research", "commit"}                                  # 台球技能被剔除
    billiards = {s.name for s in sk.filter_skills_by_mode(skills, billiards_mode=True)}
    assert "escort-service-sop" in billiards and "dating-app-traffic" in billiards


def test_render_skills_for_prompt_respects_mode():
    skills = [_skill("research"), _skill("escort-service-sop")]
    general_txt = sk.render_skills_for_prompt(skills=skills, billiards_mode=False)
    assert "escort-service-sop" not in general_txt and "research" in general_txt
    billiards_txt = sk.render_skills_for_prompt(skills=skills, billiards_mode=True)
    assert "escort-service-sop" in billiards_txt


def test_bundled_skills_do_not_leak_to_general():
    """真·扫内置技能：通用模式下擦边台球技能不出现在系统提示清单里。"""
    txt = sk.render_skills_for_prompt(billiards_mode=False)
    for leaked in ("escort-service-sop", "dating-app-traffic", "manage-stakes-customers"):
        assert leaked not in txt


# ---------- G.1 autocompact 默认窗口 ----------

def test_model_ctx_window_env_override(monkeypatch):
    from api.v1.agent import _model_ctx_window
    monkeypatch.setenv("DESKTOP_MODEL_CTX_WINDOW", "64000")
    assert _model_ctx_window() == 64000


def test_model_ctx_window_known_model_gets_safety_net(monkeypatch):
    from api.v1.agent import _model_ctx_window
    from config import settings
    monkeypatch.delenv("DESKTOP_MODEL_CTX_WINDOW", raising=False)
    monkeypatch.setattr(settings, "orchestration_model_name", "mimo-v2.5", raising=False)
    assert _model_ctx_window() == 1_000_000


def test_model_ctx_window_unknown_model_stays_optin(monkeypatch):
    from api.v1.agent import _model_ctx_window
    from config import settings
    monkeypatch.delenv("DESKTOP_MODEL_CTX_WINDOW", raising=False)
    monkeypatch.setattr(settings, "orchestration_model_name", "some-byok-model", raising=False)
    monkeypatch.setattr(settings, "text_model_name", "some-byok-model", raising=False)
    assert _model_ctx_window() is None


# ---------- P2 健壮性：MCP 状态缓存 ----------

def test_mcp_status_cached_within_ttl(monkeypatch):
    """设置页反复打开 → mcp_status 走 TTL 缓存，不每次重握手；force/invalidate 才重探。"""
    from services.agent import mcp_client as mc
    mc.invalidate_mcp_cache()
    calls = {"n": 0}

    def fake_cfg():
        calls["n"] += 1
        return {}  # 空配置：不 spawn 任何 server，但仍走探测+缓存路径

    monkeypatch.setattr(mc, "_load_mcp_config", fake_cfg)
    mc.mcp_status()
    mc.mcp_status()
    assert calls["n"] == 1            # 第二次命中缓存
    mc.mcp_status(force=True)
    assert calls["n"] == 2            # force 强制重探
    mc.invalidate_mcp_cache()
    mc.mcp_status()
    assert calls["n"] == 3            # 失效后重探
    mc.invalidate_mcp_cache()         # 清理，别污染其它测试


# ---------- P2 健壮性：run_command 超时整组掐断 ----------

def test_kill_proc_group_safe_on_none():
    from services.agent.local_tools import _kill_proc_group
    _kill_proc_group(None, os.name == "posix")  # 不抛即可


def test_kill_proc_group_terminates_child():
    """整组掐断真能把子进程杀掉（POSIX）。"""
    import sys
    if os.name != "posix":
        return  # Windows 走 taskkill 分支，这里只验 POSIX
    from services.agent.local_tools import _kill_proc_group

    async def _run():
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-c", "import time; time.sleep(30)", start_new_session=True)
        _kill_proc_group(proc, True)
        await asyncio.wait_for(proc.wait(), timeout=5)
        return proc.returncode

    rc = asyncio.run(_run())
    assert rc is not None  # 已终止，没卡满 30s


# ---------- P2 健壮性：execute 端台球过滤集合就位 ----------

def test_billiards_tool_names_cover_known_tools():
    from services.agent.registry import BILLIARDS_TOOL_NAMES
    for t in ("make_poster", "write_operation_content", "look_up_knowledge"):
        assert t in BILLIARDS_TOOL_NAMES
