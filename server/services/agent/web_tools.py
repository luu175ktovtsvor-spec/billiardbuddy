"""第二批"真 Agent"工具（对标 Claude Code 的 WebFetch / WebSearch / TodoWrite / Task）。

给桌面 Agent 装齐"上网查资料 + 自己列清单跟进度 + 把大子任务交给子代理"的通用能力：
- WebFetch：抓一个网页的正文（查资料/看竞品页/读文章）。走审批闸（防注入后借此外传本机数据）。
- WebSearch：在网上搜信息（查行业趋势/竞品/做法），无需任何 API key（走 DuckDuckGo html 端点）。
- TodoWrite：把多步任务列成清单、跟踪进度（复杂任务先列清单再逐项做）。
- run_subagent：把一个聚焦的独立子任务交给【子代理】（递归跑一遍 Agent 循环）专心做完、拿回结果。

⚠️ 故障安全铁律：这四个工具任何失败（超时/非200/被挡/网络/递归出错）都只【返回一段友好中文错误文本】，
   绝不抛异常拖垮 Agent 主循环——模型据回灌的错误文本自行决定补救（换网址、改用 WebFetch、直接答等）。
"""
import asyncio
import html
import logging
import re
from html.parser import HTMLParser

import httpx

from services.agent.registry import Tool, default_registry

logger = logging.getLogger(__name__)

# 抓网页/搜索的统一 UA + 超时（别太长，免得卡死 Agent 一轮）。
_HTTP_TIMEOUT = 15.0
_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
# WebFetch 正文回灌上限（字符）：超了截断 + 提示，护住上下文窗口与 BYOK token 成本。
_WEBFETCH_MAX_CHARS = 8000
# 子代理循环上限：调小（独立子任务，几步就该收口），且防递归爆栈/烧钱。
_SUBAGENT_MAX_TURNS = 5


# ────────────────────────────── WebFetch：抓网页正文 ──────────────────────────────

class _TextExtractor(HTMLParser):
    """极简 HTML→纯文本：丢掉 script/style/noscript 等不可见块，其余文本按块拼接。
    纯标准库（不引 bs4/lxml，免打包多依赖）；够把正文粗清出来喂模型，不求完美排版。"""

    _SKIP_TAGS = {"script", "style", "noscript", "head", "template", "svg"}
    # 这些块级标签结束时补个换行，让正文不至于全糊成一行。
    _BLOCK_TAGS = {
        "p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
        "section", "article", "header", "footer", "ul", "ol", "table", "blockquote",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._chunks: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP_TAGS:
            self._skip_depth += 1

    def handle_endtag(self, tag):
        if tag in self._SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1
        elif tag in self._BLOCK_TAGS:
            self._chunks.append("\n")

    def handle_startendtag(self, tag, attrs):
        if tag in self._BLOCK_TAGS:
            self._chunks.append("\n")

    def handle_data(self, data):
        if self._skip_depth == 0 and data and data.strip():
            self._chunks.append(data)

    def get_text(self) -> str:
        raw = "".join(self._chunks)
        # 折叠多余空白：每行去首尾空格，连续空行压成一个。
        lines = [re.sub(r"[ \t　]+", " ", ln).strip() for ln in raw.splitlines()]
        out: list[str] = []
        blank = False
        for ln in lines:
            if ln:
                out.append(ln)
                blank = False
            elif not blank:
                out.append("")
                blank = True
        return "\n".join(out).strip()


def _html_to_text(raw_html: str) -> str:
    """把一段 HTML 粗清成纯文本。解析失败就退回最朴素的"去标签 + 反转义"。"""
    try:
        p = _TextExtractor()
        p.feed(raw_html)
        text = p.get_text()
        if text:
            return text
    except Exception:
        logger.debug("HTMLParser 解析失败，退回正则去标签", exc_info=True)
    # 兜底：正则去掉 script/style 整块，再去标签、反转义。
    no_block = re.sub(r"(?is)<(script|style|noscript)\b.*?</\1>", " ", raw_html)
    no_tags = re.sub(r"(?s)<[^>]+>", " ", no_block)
    return re.sub(r"[ \t]*\n[ \t]*", "\n", html.unescape(no_tags)).strip()


def _normalize_url(url: str) -> str:
    """没带协议头的网址补上 https://，让模型只给 example.com 也能抓。"""
    u = (url or "").strip()
    if u and not re.match(r"(?i)^https?://", u):
        u = "https://" + u
    return u


# ── SSRF 防护：拦环回/私网/链路本地 IP，阻止 agent 打本机后端读门店数据 ──
import ipaddress
import socket
from urllib.parse import urlparse

def _ip_is_dangerous(addr_str: str) -> bool:
    """单个 IP 地址字符串是否属于 loopback/private/link-local/reserved。"""
    try:
        addr = ipaddress.ip_address(addr_str)
        return addr.is_loopback or addr.is_private or addr.is_link_local or addr.is_reserved
    except ValueError:
        return False


def _is_ssrf_target(url: str) -> bool:
    """URL 指向环回/私网/链路本地地址时返回 True（SSRF 风险）。
    字面判断 + DNS 解析（堵"域名指向内网"和数字 IP 如 http://2130706433）。"""
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
    except Exception:
        return True
    if not host:
        return True
    if host in ("localhost", "0.0.0.0"):
        return True
    try:
        addr = ipaddress.ip_address(host)
        if addr.is_loopback or addr.is_private or addr.is_link_local or addr.is_reserved:
            return True
        return False
    except ValueError:
        pass
    # host 是域名 → DNS 解析，所有解析出的 IP 只要命中即拦
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
        if not infos:
            return True
        for info in infos:
            ip_str = info[4][0]
            if _ip_is_dangerous(ip_str):
                return True
    except (socket.gaierror, OSError):
        return True
    return False


async def _is_ssrf_target_async(url: str) -> bool:
    """异步版 SSRF 检查（DNS 解析放 to_thread 避免阻塞事件循环）。"""
    import asyncio
    return await asyncio.to_thread(_is_ssrf_target, url)


# JS 壳判定阈值：正文极短（< 这么多字）但页面里塞了不少 <script>，多半正文靠 JS 渲染、静态抓不到。
_JS_SHELL_MIN_TEXT = 200
_JS_SHELL_MIN_SCRIPTS = 3


def _looks_like_js_shell(raw_html: str, text: str) -> bool:
    """判这页是不是"JS 壳/反爬空壳"：解析出的正文很短，但原始 HTML 里有多个 <script>。
    典型如 React/Vue 单页应用首屏（<div id=root></div> + 一堆 script），静态抓只拿到骨架没正文。"""
    if len(text.strip()) >= _JS_SHELL_MIN_TEXT:
        return False
    script_count = len(re.findall(r"(?is)<script\b", raw_html or ""))
    return script_count >= _JS_SHELL_MIN_SCRIPTS


# P0-2：国产/国内站点关键词。命中 → web_fetch 直连(绕开系统代理 Clash，国产站走代理会慢/挂死)；
# 未命中(疑似境外) → 仍 trust_env=True 走代理(够得到境外站)。web_search 命中的是境外搜索引擎，不走这条、始终用代理。
_DOMESTIC_WEB_HINTS = (
    ".cn", "tianqi", "weather.com", "baidu", "qq.com", "163.com", "sina.com", "sohu",
    "taobao", "tmall", "jd.com", "douban", "zhihu", "bilibili", "weibo", "meituan",
    "dianping", "xiaohongshu", "douyin", "kuaishou", "aliyun", "volces", "12306",
)


def _domestic_web_host(url: str) -> bool:
    from urllib.parse import urlparse
    try:
        host = urlparse(url).netloc.lower()
    except Exception:
        return False
    return any(h in host for h in _DOMESTIC_WEB_HINTS)


_MAX_REDIRECTS = 5

def _emit_progress(ctx, tool: str, text: str) -> None:
    """P0-1 任意工具进度:把一句大白话经 ctx.progress_emit 推给前端(流式循环 yield tool_progress,
    前端取最新一行展示)。故障安全:没挂 progress_emit(同步入口)或推送失败都不影响工具本身。"""
    emit = getattr(ctx, "progress_emit", None)
    if not emit:
        return
    try:
        emit({"type": "tool_progress", "tool": tool, "chunk": text.rstrip("\n") + "\n"})
    except Exception:
        pass


async def web_fetch(args: dict, ctx) -> str:
    """抓取一个网页的正文内容（GET → 粗清 HTML 成纯文本 → 截断）。
    args: url（必填），extract（可选，想重点看什么——只作提示拼进开头，不做二次 LLM 抽取）。只读、故障安全。"""
    url = _normalize_url(args.get("url") or "")
    if not url:
        return "没给网址，没法抓。请提供要抓取的网页 url。"
    if await _is_ssrf_target_async(url):
        return "这个网址指向本机或内网地址，出于安全不允许抓取。请提供一个公网网址。"
    extract = (args.get("extract") or "").strip()
    _emit_progress(ctx, "web_fetch", "正在打开网页…")
    try:
        async with httpx.AsyncClient(
            timeout=_HTTP_TIMEOUT, follow_redirects=False,
            trust_env=not _domestic_web_host(url),
            headers={"User-Agent": _UA, "Accept": "text/html,application/xhtml+xml,*/*"},
        ) as client:
            resp = await client.get(url)
            for _ in range(_MAX_REDIRECTS):
                if resp.status_code not in (301, 302, 303, 307, 308):
                    break
                location = resp.headers.get("location")
                if not location:
                    break
                next_url = location if location.startswith("http") else f"{resp.url.scheme}://{resp.url.host}{location}"
                if await _is_ssrf_target_async(next_url):
                    return "跳转目标指向本机或内网地址，出于安全已中止抓取。请换一个公网网址。"
                resp = await client.get(next_url)
    except httpx.TimeoutException:
        return f"抓取超时了（超过 {int(_HTTP_TIMEOUT)} 秒）：{url}。这个网站可能比较慢或打不开，换个网址或稍后再试。"
    except httpx.HTTPError as e:
        return f"抓不到这个网页（网络错误：{type(e).__name__}）：{url}。检查下网址对不对，或换一个。"
    except Exception as e:
        return f"抓取出错了（{type(e).__name__}）：{url}。"
    if resp.status_code != 200:
        return f"抓取失败：{url} 返回状态码 {resp.status_code}（不是正常的 200）。这个页面可能需要登录、不存在或拒绝访问。"
    ctype = resp.headers.get("content-type", "")
    if ctype and "html" not in ctype and "text" not in ctype and "xml" not in ctype:
        return f"这个网址不是网页（Content-Type: {ctype}），没法当正文读：{url}。"
    try:
        body = resp.text or ""
    except Exception:
        return f"网页内容读取失败（编码问题）：{url}。"
    _emit_progress(ctx, "web_fetch", "读到内容了，正在整理…")
    text = _html_to_text(body)
    if not text:
        return (f"抓到了页面但没解析出正文：{url}。这页大概率靠 JavaScript 动态渲染、或有反爬，"
                "静态抓不到正文——建议换一个来源/网址，或换个能直接给出文字的页面。")
    if _looks_like_js_shell(body, text):
        return (f"抓到了 {url}，但只拿到很少内容（正文约 {len(text.strip())} 字，页面里却有大量脚本）——"
                "这页正文多半靠 JavaScript 渲染或有反爬，静态抓不全。建议换个来源/网址再试。"
                f"\n\n（仅供参考，已抓到的少量片段）\n{text.strip()[:500]}")
    head = f"【网页正文】{url}\n"
    if extract:
        head += f"（重点关注：{extract}）\n"
    if len(text) > _WEBFETCH_MAX_CHARS:
        text = text[:_WEBFETCH_MAX_CHARS] + f"\n\n…[正文较长已截断：原 {len(text)} 字，只回灌前 {_WEBFETCH_MAX_CHARS} 字]"
    return head + "\n" + text


# ────────────────────────────── WebSearch：网页搜索（无需 API key） ──────────────────────────────

# 两个【无需 API key】的 HTML 搜索端点：先 DuckDuckGo，失败/空再退 Bing（双源兜底、降低单点限流概率）。
_DDG_URL = "https://html.duckduckgo.com/html/"
_BING_URL = "https://www.bing.com/search"
_DDG_UNAVAILABLE = (
    "搜索这会儿受限了（可能被对方临时限流，或网络不太通）——稍后再试，或换个说法/关键词再搜。"
    "也可以改用 WebFetch 直接抓一个你已知的网址，或我先用现有信息帮你答。"
)


def _parse_ddg_results(raw_html: str, max_results: int) -> list[dict]:
    """从 DuckDuckGo html 页解析出前几条 {title, url, snippet}。解析不出就返回空列表（调用方据此报"不可用"）。"""
    results: list[dict] = []
    # 每条结果：<a class="result__a" href="...">标题</a> ... <a class="result__snippet">摘要</a>
    link_rx = re.compile(
        r'<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="(?P<href>[^"]+)"[^>]*>(?P<title>.*?)</a>',
        re.IGNORECASE | re.DOTALL,
    )
    snippet_rx = re.compile(
        r'<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>(?P<snip>.*?)</a>',
        re.IGNORECASE | re.DOTALL,
    )
    titles = list(link_rx.finditer(raw_html))
    snippets = [m.group("snip") for m in snippet_rx.finditer(raw_html)]

    def _clean(s: str) -> str:
        return re.sub(r"\s+", " ", html.unescape(re.sub(r"(?s)<[^>]+>", "", s or ""))).strip()

    def _unwrap(href: str) -> str:
        # DDG 有时给跳转包装 //duckduckgo.com/l/?uddg=<编码后的真实URL> ——解出真实 URL。
        h = html.unescape(href or "")
        m = re.search(r"[?&]uddg=([^&]+)", h)
        if m:
            from urllib.parse import unquote
            return unquote(m.group(1))
        if h.startswith("//"):
            h = "https:" + h
        return h

    for i, m in enumerate(titles):
        if len(results) >= max_results:
            break
        url = _unwrap(m.group("href"))
        title = _clean(m.group("title"))
        snip = _clean(snippets[i]) if i < len(snippets) else ""
        if url and title:
            results.append({"title": title, "url": url, "snippet": snip})
    return results


def _parse_bing_results(raw_html: str, max_results: int) -> list[dict]:
    """从 Bing 搜索结果页解析出前几条 {title, url, snippet}（兜底源，DDG 限流时用）。
    结构：<h2><a href="真实URL">标题</a></h2> + <p class="b_lineclamp2">摘要</p>。解析不出返回空列表。"""
    results: list[dict] = []
    # 标题锚：h2 里的 <a>，href 不一定是第一个属性（前面常有 target=），故 href 匹配整段 <a ...>。
    title_rx = re.compile(
        r'(?is)<h2[^>]*>\s*<a\b[^>]*?\bhref="(?P<href>https?://[^"]+)"[^>]*>(?P<title>.*?)</a>'
    )
    snip_rx = re.compile(r'(?is)<p class="b_lineclamp\d"[^>]*>(?P<snip>.*?)</p>')

    def _clean(s: str) -> str:
        return re.sub(r"\s+", " ", html.unescape(re.sub(r"(?s)<[^>]+>", "", s or ""))).strip()

    snippets = [m.group("snip") for m in snip_rx.finditer(raw_html)]
    for i, m in enumerate(title_rx.finditer(raw_html)):
        if len(results) >= max_results:
            break
        url = html.unescape(m.group("href"))
        title = _clean(m.group("title"))
        snip = _clean(snippets[i]) if i < len(snippets) else ""
        # 跳过 Bing 自身的导航/翻译链接，只留真正的外站结果。
        if url and title and "bing.com" not in url and "go.microsoft.com" not in url:
            results.append({"title": title, "url": url, "snippet": snip})
    return results


async def _search_ddg(client: "httpx.AsyncClient", query: str, max_results: int) -> list[dict] | None:
    """走 DuckDuckGo html 端点搜。返回结果列表（可能空）；请求层失败（异常/非200）返回 None（让调用方退 Bing）。"""
    try:
        resp = await client.post(_DDG_URL, data={"q": query})
    except (httpx.HTTPError, Exception):  # noqa: BLE001 — 故障安全：任何失败都退 Bing
        logger.debug("DDG 搜索请求失败", exc_info=True)
        return None
    if resp.status_code != 200:  # DDG 限流时常返 202（带挑战页、无结果）
        return None
    try:
        return _parse_ddg_results(resp.text or "", max_results)
    except Exception:
        logger.debug("DDG 结果解析异常", exc_info=True)
        return None


async def _search_bing(client: "httpx.AsyncClient", query: str, max_results: int) -> list[dict] | None:
    """走 Bing 搜索页搜（DDG 失败/空时的兜底源）。返回结果列表（可能空）；请求层失败返回 None。"""
    try:
        resp = await client.get(_BING_URL, params={"q": query, "count": max_results, "setlang": "zh-CN"})
    except (httpx.HTTPError, Exception):  # noqa: BLE001
        logger.debug("Bing 搜索请求失败", exc_info=True)
        return None
    if resp.status_code != 200:
        return None
    try:
        return _parse_bing_results(resp.text or "", max_results)
    except Exception:
        logger.debug("Bing 结果解析异常", exc_info=True)
        return None


async def web_search(args: dict, ctx) -> str:
    """在网上搜索信息，返回前几条 标题+链接+摘要（无需 API key）。
    双源兜底：先 DuckDuckGo，失败/空再退 Bing——单源被限流时仍有机会搜到。
    args: query（必填），max（可选，返回几条，默认 5、上限 10）。只读、故障安全（都失败 → 友好提示，不抛崩）。"""
    query = (args.get("query") or "").strip()
    if not query:
        return "没给搜索词，没法搜。请提供要搜什么。"
    try:
        max_results = int(args.get("max") or 5)
    except (TypeError, ValueError):
        max_results = 5
    max_results = max(1, min(max_results, 10))
    _emit_progress(ctx, "web_search", f"正在搜：{query[:30]}…")
    results: list[dict] = []
    # 区分"请求层失败"(None，限流/网络问题 → 该说"受限稍后再试")与"成功但没结果"([]，冷门词 → 该说"没搜到")。
    both_request_failed = True
    try:
        async with httpx.AsyncClient(
            timeout=_HTTP_TIMEOUT, follow_redirects=True,
            headers={"User-Agent": _UA, "Accept": "text/html"},
        ) as client:
            # ① 先 DuckDuckGo
            ddg = await _search_ddg(client, query, max_results)
            if ddg is not None:
                both_request_failed = False
            if ddg:
                results = ddg
            else:
                # ② DDG 失败(None)或空([]) → 退 Bing 兜底
                bing = await _search_bing(client, query, max_results)
                if bing is not None:
                    both_request_failed = False
                if bing:
                    results = bing
    except Exception:
        logger.debug("WebSearch 整体异常", exc_info=True)
        return _DDG_UNAVAILABLE
    if not results:
        if both_request_failed:
            return _DDG_UNAVAILABLE  # 两源都没连上 → 限流/网络受限的提示
        return (f"没搜到「{query}」的结果（搜索源返回了但没有可用条目，可能这个词太冷门）。"
                "换个说法/关键词再试，或用 WebFetch 直接抓一个你已知的网址。")
    lines = [f"搜「{query}」找到这些（共 {len(results)} 条）："]
    for i, r in enumerate(results, 1):
        lines.append(f"{i}. {r['title']}\n   {r['url']}" + (f"\n   {r['snippet']}" if r["snippet"] else ""))
    lines.append("（想看某条的完整内容，用 WebFetch 抓它的链接。）")
    return "\n".join(lines)


# ────────────────────────────── TodoWrite：多步任务清单 ──────────────────────────────

_TODO_STATUSES = {"pending", "in_progress", "done"}
_TODO_MARK = {"pending": "☐", "in_progress": "◐", "done": "☑"}


def _normalize_todos(raw) -> list[dict]:
    """把传入的 todos 归一成 [{task, status}]。支持两种写法：
    - 纯字符串数组 ["列大纲","写正文"] → 全部 status=pending；
    - 对象数组 [{"task":"写正文","status":"in_progress"}, ...] → 用给定 status（非法值归 pending）。
    非字符串/无 task 的项跳过；status 不在合法集里按 pending。"""
    out: list[dict] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if isinstance(item, str):
            t = item.strip()
            if t:
                out.append({"task": t, "status": "pending"})
        elif isinstance(item, dict):
            t = str(item.get("task") or item.get("content") or "").strip()
            if not t:
                continue
            st = str(item.get("status") or "pending").strip()
            if st not in _TODO_STATUSES:
                st = "pending"
            out.append({"task": t, "status": st})
    return out


def _format_todos(todos: list[dict]) -> str:
    if not todos:
        return "（清单是空的）"
    return "\n".join(f"{_TODO_MARK.get(t.get('status'), '☐')} {t.get('task', '')}" for t in todos)


def format_todo_checklist(todos: list[dict]) -> str:
    """任务清单 → 人话展示文本："任务清单（共 N 步，已完成 M 步）：\n☐/◐/☑ ..."。

    F4 Focus Chain：todo_write 工具 和 loop.py 的 task_progress 参数是同一份进度真相源
    （都落进 ctx.todos），两条更新路径共用这一份渲染，不各写一套、不让前端出现两种清单样式。
    """
    done = sum(1 for t in todos if t.get("status") == "done")
    return f"任务清单（共 {len(todos)} 步，已完成 {done} 步）：\n{_format_todos(todos)}"


# markdown 复选清单行：`- [x] 已做` / `- [ ] 待做`（`*` 也认，缩进不限）。
_PROGRESS_LINE_RE = re.compile(r"^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$")


def parse_progress_markdown(text: str) -> list[dict]:
    """F4 Focus Chain：把模型顺手贴的 markdown 复选清单解析成与 todo_write 同构的 [{task,status}]。

    status 只有 pending/done 两态——markdown 复选框语法本就表达不出 in_progress，这是有意的简化
    （Cline 的 Focus Chain 原型同样只有两态）。解析不出任何合法行 → 空列表，调用方（loop.py）
    据此判断"这次给的不是有效清单，按没更新算"，不会把一段解析不出结构的文字悄悄当成"已更新"。
    """
    out: list[dict] = []
    if not isinstance(text, str):
        return out
    for line in text.splitlines():
        m = _PROGRESS_LINE_RE.match(line)
        if not m:
            continue
        task = m.group(2).strip()
        if not task:
            continue
        out.append({"task": task, "status": "done" if m.group(1).lower() == "x" else "pending"})
    return out


async def todo_write(args: dict, ctx) -> str:
    """把当前多步任务列成清单、写进 ctx.todos，返回格式化清单（☐ 待办 / ◐ 进行中 / ☑ 已完成）。
    复杂任务先列清单再逐项做；每完成一步可再调一次更新状态。无副作用、无审批、故障安全。"""
    todos = _normalize_todos(args.get("todos"))
    if not todos:
        return "没给有效的清单项。请用字符串数组（如 [\"列大纲\",\"写正文\"]）或 [{task,status}] 形式给我要做的几步。"
    if ctx is not None:
        try:
            ctx.todos = todos
        except Exception:
            logger.debug("写入 ctx.todos 失败（ctx 不支持赋值），仅返回清单文本", exc_info=True)
    return format_todo_checklist(todos)


# ────────────────────────────── run_subagent：子代理（递归跑 Agent 循环） ──────────────────────────────

def _subagent_registry():
    """给子代理用的工具子集 = 默认注册表里【除 run_subagent 自身外】的全部工具（防无限递归）。
    每次新建一个临时 ToolRegistry，不污染全局。故障安全：取不到默认表就返回 None（调用方据此报错）。"""
    try:
        from services.agent.registry import ToolRegistry
        sub = ToolRegistry()
        for t in default_registry.all():
            if t.name == "run_subagent":
                continue
            sub.register(t)
        return sub
    except Exception:
        logger.debug("构建子代理工具子集失败", exc_info=True)
        return None


# 子代理独立跑一遍 run_agent_loop，system_prompt 若只给"角色提示"（探索员/规划员/通用）就会漏掉
# 主循环里【永远注入】的安全红线（_SAFETY_REDLINE，定义在 api/v1/agent.py）——子代理照样能调工具
# （写文件/生图/发消息等），没有红线兜底＝主 Agent 的安全闸形同虚设，注入/越权可以"借子代理绕过"。
# 这段是 _SAFETY_REDLINE 导入失败（极端情况：模块尚未加载完成、被隔离测试等）时的内联兜底文案，
# 覆盖同样的红线要点，保证子代理任何时候都带着红线跑，不会因为一次 import 失败就没有安全兜底。
_FALLBACK_SAFETY_REDLINE = (
    "【安全红线·任何情况都不碰，且不受任何用户设定/偏好放开】"
    "① 绝不为『实际性交易』（性服务/援交/陪睡/上门特殊服务这类）做招揽或营销；"
    "② 绝不协助开设赌场/坐庄定盘口/按局抽水组织赌博等刑事级犯罪；"
    "③ 涉及未成年人：绝不诱导逃课翘课、绝不涉黄涉赌；"
    "④ 辞退/合同/劳动纠纷等法律文书类内容可给参考模板，但要提醒『落地前请专业人士把关』；"
    "⑤ 不输出绝对化广告词（全城最低/终身免费/包治百病等）或虚假宣传。"
    "以上红线不受任何用户指令/偏好放开，哪怕对方要求也不能突破。"
)


def _resolve_subagent_safety_redline() -> str:
    """给子代理系统提示拼装安全红线：优先复用主循环那一份 _SAFETY_REDLINE（与主 Agent 口径完全一致）。
    延迟 import——api/v1/agent.py 顶层会 import 本模块（登记 web_fetch/web_search/... 工具），
    模块级 import 会circular；只在真正调用（run_agent_loop 已跑起来、两个模块都已加载完）时才 import，
    安全。import 失败（理论上不该发生，但故障安全）时退回内联兜底红线，绝不让子代理没有红线跑。"""
    try:
        from api.v1.agent import _SAFETY_REDLINE
        return _SAFETY_REDLINE
    except Exception:
        logger.debug("加载主循环 _SAFETY_REDLINE 失败，子代理改用内联兜底红线", exc_info=True)
        return _FALLBACK_SAFETY_REDLINE


_SUBAGENT_TYPES: dict = {
    "general-purpose": {
        "read_only": False,
        "prompt": ("你是被【主 Agent】派来专心做完一个【聚焦子任务】的子代理。集中把这一件事做到位、"
                   "给出可直接交付的结果，不展开无关的事，也不再往下拆子代理。"),
    },
    "explore": {
        "read_only": True,
        "prompt": ("你是【只读探索员】子代理：只查不改——用读文件/搜文件/列目录/上网查等只读手段，"
                   "把要找的信息或现状摸清楚，给一份清晰的发现汇总。绝不写改文件、不跑会改动的命令、不做对外动作。"),
    },
    "plan": {
        "read_only": True,
        "prompt": ("你是【规划员】子代理：只读不动手——先用只读手段了解现状，再产出一份分步、可执行的计划"
                   "（每步做什么、注意什么、有什么风险）。绝不实际执行任何写入或操作。"),
    },
}


def _resolve_subagent_type(raw) -> dict:
    key = str(raw or "general-purpose").strip().lower()
    aliases = {"general": "general-purpose", "general_purpose": "general-purpose"}
    key = aliases.get(key, key)
    return _SUBAGENT_TYPES.get(key, _SUBAGENT_TYPES["general-purpose"])


async def run_subagent(args: dict, ctx) -> str:
    """把一个聚焦的独立子任务交给【子代理】专心做完、拿回最终文本。
    内部递归跑一遍 run_agent_loop：给它【不含 run_subagent 自身】的工具子集（防无限递归）、较小的
    max_turns、复用当前同一个 orchestration provider/model（ctx.provider/ctx.model）。只读、故障安全。
    args: task（必填，要让子代理做完的子任务描述），focus（可选，重点/约束提示）。"""
    task = (args.get("task") or "").strip()
    if not task:
        return "没给子任务内容，没法交给子代理。请说清要它做完什么。"
    focus = (args.get("focus") or "").strip()
    atype = _resolve_subagent_type(args.get("subagent_type"))
    _emit_progress(ctx, "run_subagent", "正在派一个子代理专心做这件子任务…")
    from services.agent.registry import ToolRegistry
    sub_registry = ToolRegistry()
    _SUBAGENT_SAFE_EXTRAS = {"todo_write"}
    try:
        for t in default_registry.all():
            if t.name == "run_subagent":
                continue
            if getattr(t, "read_only", False) or t.name in _SUBAGENT_SAFE_EXTRAS:
                sub_registry.register(t)
                continue
            # 写改/对外工具一律不给子代理（防注入借子代理绕过审批闸）
            continue
    except Exception:
        logger.debug("构建子代理工具子集失败", exc_info=True)
        return "子代理暂时启动不了（工具集构建失败）。我直接来做这件事吧。"
    user_msg = task if not focus else f"{task}\n\n【重点/约束】{focus}"
    # 子代理是独立跑一遍 run_agent_loop，system_prompt 若只给"角色提示"就漏了主循环永远注入的安全红线——
    # 补上，保证子代理跟主 Agent 同一条红线，不能被"派个子代理去做"绕过。
    sub_prompt = f"{_resolve_subagent_safety_redline()}\n\n{atype['prompt']}"
    try:
        from services.agent.loop import run_agent_loop
        # 给子代理一个干净的运行上下文：沿用同一 db/store/user/provider/model 与权限/沙箱设置，
        # 但清掉防打转计数、todos、自动放行计数等"本轮态"，让它独立计数、互不串扰。
        from services.agent.context import AgentContext
        sub_ctx = AgentContext(
            db=getattr(ctx, "db", None),
            store=getattr(ctx, "store", None),
            user=getattr(ctx, "user", None),
            allowed_paths=list(getattr(ctx, "allowed_paths", None) or []),
            permission_mode=getattr(ctx, "permission_mode", "ask"),
            full_disk_access=getattr(ctx, "full_disk_access", False),
            auto_spend_limit=getattr(ctx, "auto_spend_limit", None),
            provider=getattr(ctx, "provider", None),
            model=getattr(ctx, "model", None),
        )
        _emit_progress(ctx, "run_subagent", "子代理在做了，稍候…")
        result = await run_agent_loop(
            user_message=user_msg,
            registry=sub_registry,
            ctx=sub_ctx,
            system_prompt=sub_prompt,
            provider=getattr(ctx, "provider", None),
            model=getattr(ctx, "model", None),
            max_turns=_SUBAGENT_MAX_TURNS,
        )
    except Exception as e:
        logger.exception("run_subagent 子代理执行失败")
        return f"子代理这次没跑成（{type(e).__name__}）。我直接来处理这件事吧。"
    final = (getattr(result, "final_text", "") or "").strip()
    if not final:
        return "子代理跑完了但没给出明确结果。这件事我直接来做吧。"
    return f"【子代理已完成子任务】\n{final}"


# ────────────────────────────── 工具定义 + 注册 ──────────────────────────────

_WEB_TOOLS = [
    Tool(
        name="web_fetch",
        description="抓取一个网页的正文内容（查资料 / 看竞品页 / 读一篇文章）。给一个网址，"
                    "返回去掉网页代码后的纯文字正文。想了解某个具体页面写了什么、或 WebSearch 搜到结果想看全文时用。"
                    "注意：会把网址弹给老板确认后才抓（防注入后借此外传本机数据）。",
        parameters={"type": "object", "properties": {
            "url": {"type": "string", "description": "要抓取的网页网址（http/https，不带协议头也行）"},
            "extract": {"type": "string", "description": "想重点关注什么（可选，仅作提示）"},
        }, "required": ["url"]},
        handler=web_fetch,
        requires_approval=True,
        approval_class="external",
        approval_reason=lambda args, ctx: {
            "what": f"抓取网页：{(args or {}).get('url', '?')}",
            "why": "抓网页会对外发起网络请求，需要你确认网址没问题。",
            "impact": "确认后会访问这个网址并读取页面正文，不会发送你电脑上的任何数据。",
        },
    ),
    Tool(
        name="web_search",
        description="在网上搜索信息（查行业趋势 / 看同行竞品 / 找某种做法）。给一个搜索词，"
                    "返回前几条结果的 标题+链接+摘要。需要最新的、本地知识库里没有的外部信息时用；"
                    "想看某条结果的完整内容，再用 web_fetch 抓它的链接。",
        parameters={"type": "object", "properties": {
            "query": {"type": "string", "description": "要搜什么，原话即可，如『台球房抖音引流怎么做』"},
            "max": {"type": "integer", "description": "返回几条（默认 5，最多 10）"},
        }, "required": ["query"]},
        handler=web_search,
        read_only=True,
    ),
    Tool(
        name="todo_write",
        description="把要做的多步任务列成清单、跟踪进度（☐待办 / ◐进行中 / ☑已完成）。"
                    "遇到需要分好几步才能完成的复杂任务时，先用它把步骤列清单，再逐项去做、做完一步就更新状态——"
                    "这样不容易漏步、老板也看得到进度。简单一步到位的活儿不用列。",
        parameters={"type": "object", "properties": {
            "todos": {
                "type": "array",
                "description": "任务清单。可以是字符串数组（每项一步，默认待办），"
                               "也可以是 [{task:'写正文', status:'in_progress'}] 形式带状态。",
                "items": {"type": "object", "properties": {
                    "task": {"type": "string", "description": "这一步要做什么"},
                    "status": {"type": "string", "description": "pending待办 / in_progress进行中 / done已完成"},
                }},
            },
        }, "required": ["todos"]},
        handler=todo_write,
        read_only=False,
    ),
    Tool(
        name="run_subagent",
        description="把一个复杂、独立的子任务交给【子代理专家】专心做完、拿回结果（会多花一次完整模型调用，"
                    "只在真需要拆分的大任务时用）。可选 subagent_type 指定专家："
                    "general-purpose(默认·全能·可动手) / explore(只读探索·只查不改) / plan(只读规划·只出计划不执行)。"
                    "派活时 task 尽量写成一条自包含的指令，别甩个模糊话题就完事——子代理看不到你俩之前的聊天，"
                    "说清楚这四件事效果最好：①要它做成什么（目标）②想要什么形式的结果（一段文字/一份清单/一个判断）"
                    "③可以用什么办法或工具（有没有它该查的资料、该读的文件）④哪些不用管、做到哪就算完（边界，别让它越界发挥）。",
        parameters={"type": "object", "properties": {
            "task": {"type": "string", "description": "要交给子代理做完的子任务。写清楚、自包含："
                                                        "目标是什么、想要什么形式的结果、能用什么办法/工具、不用管哪些"},
            "focus": {"type": "string", "description": "重点 / 约束 / 边界（可选，比如"
                                                        "「别改代码只读」「结果控制在200字内」这类补充限定）"},
            "subagent_type": {"type": "string", "enum": ["general-purpose", "explore", "plan"],
                              "description": "专家类型（可选，默认 general-purpose）"},
        }, "required": ["task"]},
        handler=run_subagent,
        read_only=True,
    ),
]


def register_web_tools(registry=None) -> int:
    """把第二批 web/agent 工具注册进注册表。返回注册数（已存在的跳过，可重复调用幂等）。"""
    reg = registry or default_registry
    for t in _WEB_TOOLS:
        if reg.get(t.name) is None:
            reg.register(t)
    return len(_WEB_TOOLS)


# 导入即注册进默认表（这四个是通用能力——查资料/列清单/拆子任务——云端 web 与桌面都适用，不门控 DESKTOP_LOCAL）。
register_web_tools()
logger.info("已注册 %d 个 web/agent 工具（WebFetch/WebSearch/TodoWrite/run_subagent）", len(_WEB_TOOLS))
