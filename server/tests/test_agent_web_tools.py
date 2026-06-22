"""第二批"真 Agent"工具（对标 Claude Code 的 WebFetch / WebSearch / TodoWrite / Task）。

锁住：
- 四个工具都注册进 default_registry 且能导出 OpenAI schema；read_only/无审批 等元信息正确。
- WebFetch：粗清 HTML 成纯文本、截断、非200/超时/网络错 → 友好错文本不抛崩。
- WebSearch：解析 DDG html 出 标题/链接/摘要、被挡/解析不出 → "暂时不可用"不抛崩。
- TodoWrite：字符串数组 / [{task,status}] 两种写法都归一、写进 ctx.todos、返回 ☐/◐/☑ 清单。
- run_subagent：递归跑一遍 run_agent_loop、子代理拿不到 run_subagent 自身（防递归）、子任务失败 → 友好兜底。
WebFetch/WebSearch 用 monkeypatch 假 httpx 响应，绝不真联网。
"""
import asyncio
from types import SimpleNamespace

import httpx

import services.agent.web_tools as web_tools
from services.agent.registry import default_registry


def _ctx():
    return SimpleNamespace(db=object(), store=SimpleNamespace(id="s1"), user=SimpleNamespace(id="u1"),
                           allowed_paths=[], permission_mode="ask", full_disk_access=False,
                           auto_spend_limit=None, provider=None, model=None, todos=[])


# ────────────────────────────── 注册 + 元信息 ──────────────────────────────

def test_web_tools_registered():
    names = set(default_registry.names())
    for n in ["web_fetch", "web_search", "todo_write", "run_subagent"]:
        assert n in names, f"工具 {n} 未注册"


def test_web_tools_export_openai_schema():
    schemas = {t["function"]["name"] for t in default_registry.to_openai_tools()}
    for n in ["web_fetch", "web_search", "todo_write", "run_subagent"]:
        assert n in schemas


def test_web_tools_metadata():
    # 查资料/子代理是只读、不需审批；TodoWrite 不需审批
    for n in ["web_fetch", "web_search", "run_subagent"]:
        t = default_registry.get(n)
        assert t.read_only is True, f"{n} 应为 read_only"
        assert t.requires_approval is False
    assert default_registry.get("todo_write").requires_approval is False


def test_register_web_tools_idempotent():
    # 重复注册不抛错、不重复（已存在跳过）
    before = len(default_registry.names())
    web_tools.register_web_tools()
    assert len(default_registry.names()) == before


# ────────────────────────────── WebFetch ──────────────────────────────

class _FakeResp:
    def __init__(self, status=200, text="", content_type="text/html"):
        self.status_code = status
        self.text = text
        self.headers = {"content-type": content_type}


class _FakeClient:
    """假 httpx.AsyncClient：__aenter__ 返回自己，get/post 返回预置响应或抛预置异常。"""
    def __init__(self, resp=None, exc=None):
        self._resp = resp
        self._exc = exc

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url, **kw):
        if self._exc:
            raise self._exc
        return self._resp

    async def post(self, url, **kw):
        if self._exc:
            raise self._exc
        return self._resp


def _patch_httpx(monkeypatch, resp=None, exc=None):
    monkeypatch.setattr(web_tools.httpx, "AsyncClient", lambda *a, **k: _FakeClient(resp=resp, exc=exc))


def test_web_fetch_cleans_html(monkeypatch):
    html_doc = (
        "<html><head><title>x</title><style>.a{color:red}</style>"
        "<script>var a=1;</script></head>"
        "<body><h1>台球房</h1><p>周末半价活动</p><p>欢迎来玩</p></body></html>"
    )
    _patch_httpx(monkeypatch, resp=_FakeResp(text=html_doc))
    out = asyncio.run(web_tools.web_fetch({"url": "example.com"}, _ctx()))
    assert "台球房" in out and "周末半价活动" in out and "欢迎来玩" in out
    # script/style 内容不应出现在正文里
    assert "var a=1" not in out and "color:red" not in out


def test_web_fetch_truncates(monkeypatch):
    big = "<p>" + ("台" * 20000) + "</p>"
    _patch_httpx(monkeypatch, resp=_FakeResp(text=big))
    out = asyncio.run(web_tools.web_fetch({"url": "https://x.com"}, _ctx()))
    assert "截断" in out
    assert len(out) < 20000


def test_web_fetch_non_200_friendly(monkeypatch):
    _patch_httpx(monkeypatch, resp=_FakeResp(status=404, text="nope"))
    out = asyncio.run(web_tools.web_fetch({"url": "https://x.com/404"}, _ctx()))
    assert "404" in out and "失败" in out


def test_web_fetch_timeout_friendly(monkeypatch):
    _patch_httpx(monkeypatch, exc=httpx.TimeoutException("slow"))
    out = asyncio.run(web_tools.web_fetch({"url": "https://x.com"}, _ctx()))
    assert "超时" in out  # 不抛异常，返回友好文本


def test_web_fetch_network_error_friendly(monkeypatch):
    _patch_httpx(monkeypatch, exc=httpx.ConnectError("boom"))
    out = asyncio.run(web_tools.web_fetch({"url": "https://x.com"}, _ctx()))
    assert "抓不到" in out


def test_web_fetch_empty_url():
    out = asyncio.run(web_tools.web_fetch({"url": "  "}, _ctx()))
    assert "网址" in out


# ────────────────────────────── WebSearch ──────────────────────────────

_DDG_HTML = """
<div class="result">
  <a class="result__a" href="https://a.com/1">台球房抖音引流</a>
  <a class="result__snippet">教你台球房怎么在抖音获客</a>
</div>
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.com%2F2">小红书笔记技巧</a>
  <a class="result__snippet">台球房小红书运营摘要</a>
</div>
"""


def test_web_search_parses_results(monkeypatch):
    _patch_httpx(monkeypatch, resp=_FakeResp(text=_DDG_HTML))
    out = asyncio.run(web_tools.web_search({"query": "台球房引流"}, _ctx()))
    assert "台球房抖音引流" in out
    assert "https://a.com/1" in out
    assert "教你台球房怎么在抖音获客" in out
    # uddg 包装的真实链接被解出
    assert "https://b.com/2" in out


def test_web_search_max_caps(monkeypatch):
    _patch_httpx(monkeypatch, resp=_FakeResp(text=_DDG_HTML))
    out = asyncio.run(web_tools.web_search({"query": "x", "max": 1}, _ctx()))
    # 只要 1 条 → 第二条不出现
    assert "台球房抖音引流" in out
    assert "小红书笔记技巧" not in out


def test_web_search_blocked_friendly(monkeypatch):
    # 两源都返回非 200（被挡）→ 友好"受限"提示，且引导改用 WebFetch
    _patch_httpx(monkeypatch, resp=_FakeResp(status=403, text="blocked"))
    out = asyncio.run(web_tools.web_search({"query": "x"}, _ctx()))
    assert "受限" in out and "WebFetch" in out


def test_web_search_network_error_friendly(monkeypatch):
    # 两源都抛网络错 → 不崩，返回友好"受限"提示
    _patch_httpx(monkeypatch, exc=httpx.ConnectError("boom"))
    out = asyncio.run(web_tools.web_search({"query": "x"}, _ctx()))
    assert "受限" in out  # 不抛异常


def test_web_search_no_results(monkeypatch):
    _patch_httpx(monkeypatch, resp=_FakeResp(text="<html><body>nothing here</body></html>"))
    out = asyncio.run(web_tools.web_search({"query": "冷门词"}, _ctx()))
    assert "没搜到" in out


def test_web_search_empty_query():
    out = asyncio.run(web_tools.web_search({"query": ""}, _ctx()))
    assert "搜索词" in out


# DDG 限流(202/空) → 退 Bing 兜底。用区分 post/get 的假客户端：post(DDG)给挑战页、get(Bing)给可解析结果。
_BING_HTML = (
    '<li class="b_algo"><h2 class=""><a target="_blank" href="https://x.com/a">台球房抖音引流实操</a></h2>'
    '<div class="b_caption"><p class="b_lineclamp2">教你台球房怎么在抖音获客</p></div></li>'
    '<li class="b_algo"><h2 class=""><a href="https://bing.com/nav">站内导航应跳过</a></h2>'
    '<div class="b_caption"><p class="b_lineclamp2">x</p></div></li>'
)


class _SplitClient:
    """假 httpx：post(DDG) 与 get(Bing) 各给不同响应，验证双源兜底链路。"""
    def __init__(self, ddg_resp, bing_resp):
        self._ddg, self._bing = ddg_resp, bing_resp

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, **kw):
        return self._ddg

    async def get(self, url, **kw):
        return self._bing


def test_web_search_falls_back_to_bing(monkeypatch):
    # DDG 返 202（限流、无结果）→ 自动退 Bing，拿到 Bing 结果；Bing 自身导航链接被过滤
    monkeypatch.setattr(
        web_tools.httpx, "AsyncClient",
        lambda *a, **k: _SplitClient(_FakeResp(status=202, text="challenge"), _FakeResp(text=_BING_HTML)),
    )
    out = asyncio.run(web_tools.web_search({"query": "台球房引流"}, _ctx()))
    assert "台球房抖音引流实操" in out and "https://x.com/a" in out
    assert "站内导航应跳过" not in out  # bing.com 自身链接被过滤


def test_web_search_ddg_first_skips_bing(monkeypatch):
    # DDG 有结果时不该再打 Bing（get 抛错来证明没被调用）
    class _DDGOnly(_SplitClient):
        async def get(self, url, **kw):
            raise AssertionError("DDG 有结果时不应调用 Bing")
    monkeypatch.setattr(
        web_tools.httpx, "AsyncClient",
        lambda *a, **k: _DDGOnly(_FakeResp(text=_DDG_HTML), None),
    )
    out = asyncio.run(web_tools.web_search({"query": "台球房引流"}, _ctx()))
    assert "台球房抖音引流" in out  # 来自 DDG


# ────────────────────────────── WebFetch · JS 壳/反爬识别 ──────────────────────────────

def test_web_fetch_detects_js_shell(monkeypatch):
    # 正文极短(有一点文字但<200字) + 一堆 <script> → 判为 JS 壳，提示靠 JS 渲染/反爬、换来源
    shell = ('<html><body><div id="root">加载中</div>'
             + ('<script src="a.js"></script>' * 5) + '</body></html>')
    _patch_httpx(monkeypatch, resp=_FakeResp(text=shell))
    out = asyncio.run(web_tools.web_fetch({"url": "https://spa.example.com"}, _ctx()))
    assert ("JavaScript" in out or "脚本" in out) and "来源" in out


def test_web_fetch_empty_shell_friendly(monkeypatch):
    # 完全空壳（解析不出任何正文）→ 也给"靠 JS 渲染/反爬、换来源"的友好提示，不崩
    empty_shell = '<html><body><div id="app"></div>' + ('<script src="b.js"></script>' * 4) + '</body></html>'
    _patch_httpx(monkeypatch, resp=_FakeResp(text=empty_shell))
    out = asyncio.run(web_tools.web_fetch({"url": "https://spa2.example.com"}, _ctx()))
    assert "JavaScript" in out and "来源" in out


def test_web_fetch_long_page_not_flagged(monkeypatch):
    # 正常长正文页不应被误判为 JS 壳
    good = "<html><body><h1>台球房运营</h1><p>" + ("正文内容很长很长。" * 40) + "</p></body></html>"
    _patch_httpx(monkeypatch, resp=_FakeResp(text=good))
    out = asyncio.run(web_tools.web_fetch({"url": "https://good.com"}, _ctx()))
    assert "网页正文" in out and "台球房运营" in out


# ────────────────────────────── TodoWrite ──────────────────────────────

def test_todo_write_string_array():
    ctx = _ctx()
    out = asyncio.run(web_tools.todo_write({"todos": ["列大纲", "写正文", "配图"]}, ctx))
    assert "列大纲" in out and "写正文" in out and "配图" in out
    assert "☐" in out  # 字符串数组默认全 pending
    assert len(ctx.todos) == 3
    assert ctx.todos[0] == {"task": "列大纲", "status": "pending"}


def test_todo_write_objects_with_status():
    ctx = _ctx()
    out = asyncio.run(web_tools.todo_write({"todos": [
        {"task": "列大纲", "status": "done"},
        {"task": "写正文", "status": "in_progress"},
        {"task": "配图", "status": "pending"},
    ]}, ctx))
    assert "☑ 列大纲" in out and "◐ 写正文" in out and "☐ 配图" in out
    assert "已完成 1 步" in out
    assert ctx.todos[0]["status"] == "done"


def test_todo_write_bad_status_falls_back():
    ctx = _ctx()
    asyncio.run(web_tools.todo_write({"todos": [{"task": "x", "status": "乱写"}]}, ctx))
    assert ctx.todos[0]["status"] == "pending"


def test_todo_write_empty_friendly():
    ctx = _ctx()
    out = asyncio.run(web_tools.todo_write({"todos": []}, ctx))
    assert "有效的清单项" in out
    assert ctx.todos == []  # 没写坏 ctx


# ────────────────────────────── run_subagent ──────────────────────────────

def test_subagent_registry_excludes_itself():
    sub = web_tools._subagent_registry()
    assert sub is not None
    assert sub.get("run_subagent") is None  # 防无限递归：子代理拿不到自己
    assert sub.get("web_fetch") is not None  # 其它工具仍在


def test_run_subagent_runs_loop_and_returns_text():
    from services.ai.base import TextResponse
    from services.ai.providers.mock import MockTextProvider

    # 子代理首轮就直接给最终答复（无 tool_calls），run_subagent 应原样拿回该文本
    provider = MockTextProvider(scripted=[
        TextResponse(content="子代理算出来周三上座率最低", model="mock", finish_reason="stop"),
    ])
    ctx = _ctx()
    ctx.provider = provider
    ctx.model = "mock"
    out = asyncio.run(web_tools.run_subagent({"task": "分析哪天上座率最低"}, ctx))
    assert "子代理已完成" in out
    assert "周三上座率最低" in out


def test_run_subagent_empty_task():
    out = asyncio.run(web_tools.run_subagent({"task": "  "}, _ctx()))
    assert "子任务" in out


def test_run_subagent_fault_safe_on_loop_error(monkeypatch):
    # 让子循环抛异常 → run_subagent 不崩、返回友好兜底
    import services.agent.loop as loop_mod

    async def boom(**kw):
        raise RuntimeError("loop blew up")

    monkeypatch.setattr(loop_mod, "run_agent_loop", boom)
    out = asyncio.run(web_tools.run_subagent({"task": "做点啥"}, _ctx()))
    assert "子代理这次没跑成" in out or "直接来" in out
