"""
安全防护模块 — 输入/输出过滤
不依赖模型自觉，在代码层面拦截prompt注入和信息泄露
"""
import re
from typing import Optional

# 输入侧：检测prompt注入尝试
# M5 放宽：桌面单用户场景下"你是什么模型/你用什么AI/你的配置"是老板正常好奇心，
# 不是攻击——误拦返 500 是纯负收益。只保留真正的"覆盖/绕过系统指令"企图。
INJECTION_PATTERNS = [
    r"(忘记|忽略|无视|跳过).{0,10}(之前|上面|以前|所有|全部).{0,6}(指令|规则|设定|限制)",
    r"(假装|假设|扮演|模拟)(你是|你没有)(一个)?(没有|不限|无)(限制|规则|约束)",
    r"ignore.*(previous|above|all).*(instructions|rules|prompts)",
]

# 输出侧：检测系统信息泄露
# M5 收窄：只拦真正的系统内部结构泄露（代码路径/提示词变量名/系统指令原文），
# 不拦 AI 品牌词（GPT/Claude/DeepSeek）和"我是AI"——老板经常让写含这些词的正当营销文案，
# 静默删整行是纯负收益。
LEAK_PATTERNS = [
    r"(我的|系统的|后台的)(prompt|指令|规则|提示词)(是|为|如下)",
    r"(baseline_rules|role_rules|customer_rules|knowledge_context)",
    r"(content_service|stream\.py|prompt_engine)",
    r"(server/prompts|rules/role|rules/customer)",
]

# 命中泄露时统一替换为这句安全提示
LEAK_REPLACEMENT = "我是你的 AI 助手，有什么需要帮忙的随时说。"

# AI 回应口水前缀（流式与非流式共用同一份，避免两处维护）
AI_RESPONSE_PREFIXES = [
    "好的，店长！",
    "好的，店长",
    "好的！",
    "没问题，我来帮你",
    "以下是为你生成的",
    "好的，没问题！",
]


def _match_leak(text: str) -> bool:
    """判断文本中是否包含系统信息泄露。"""
    if not text:
        return False
    for pattern in LEAK_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            return True
    return False


def _strip_response_prefixes(content: str) -> str:
    """去除 AI 回应语前缀（命中一个即停）。"""
    for prefix in AI_RESPONSE_PREFIXES:
        if content.startswith(prefix):
            return content[len(prefix):].lstrip("\n").lstrip()
    return content


# ── 业务铁律·代码闸：绝对化广告词（违《广告法》） ──
# 把"靠模型自觉别写"改成"代码确定性兜底"——弱模型常忽略"别写全城最低/终身免费"，
# 这里在输出后把这些违法绝对化词替换成安全表达，不依赖模型遵循。
# ⚠️ 刻意【只收"任何渠道都违法"的绝对化词】，绝不收渠道相关词（露骨/追分/官方套话等）——
#    那些对内部文案/私域是真实卖点，一刀切会误伤（项目踩过"消毒一刀切"的坑）。
_AD_LAW_REPLACEMENTS = {
    "全城最低价": "实惠价格", "全网最低价": "实惠价格", "全市最低价": "实惠价格",
    "史上最低价": "超值价格", "全城最低": "实惠", "全网最低": "实惠", "全市最低": "实惠",
    "史上最低": "超值", "最低价": "优惠价",
    "终身免费": "长期优惠", "永久免费": "长期优惠",
}


def scan_compliance(text: str) -> list:
    """只检测不改：返回文本里命中的绝对化广告词（供观测/告警/eval 量化铁律命中率）。"""
    if not text:
        return []
    return [bad for bad in _AD_LAW_REPLACEMENTS if bad in text]


def filter_compliance(text: str) -> str:
    """输出后置铁律闸：把绝对化广告词替换成安全表达。长词优先替换，避免子串重复处理。
    只动这一类全渠道违法词，不碰其他——保证零误伤内部内容。"""
    if not text:
        return text
    out = text
    for bad in sorted(_AD_LAW_REPLACEMENTS, key=len, reverse=True):
        if bad in out:
            out = out.replace(bad, _AD_LAW_REPLACEMENTS[bad])
    return out


def check_input_injection(user_input: str) -> Optional[str]:
    """
    检测用户输入中的prompt注入尝试。
    返回None表示安全，返回警告信息表示检测到注入。
    """
    if not user_input:
        return None

    text = user_input.lower().strip()

    for pattern in INJECTION_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            return "检测到异常输入，请用正常方式描述你的运营需求。"

    return None


def filter_output_leak(ai_output: str) -> str:
    """
    输出统一安全出口：① 过滤系统信息泄露 ② 应用业务铁律代码闸(绝对化广告词)。

    泄露：只移除包含泄露内容的行，保留其余正文（避免正文偶然提到"AI/模型"
    时整段被丢弃）；若所有内容都命中泄露，才回退到统一安全提示。
    铁律：在两个返回分支都套 filter_compliance，让所有调用此出口的生成路径（含流式
    finalize）都确定性地把违广告法的绝对化词换掉——不靠模型自觉。
    """
    if not ai_output:
        return ai_output

    if not _match_leak(ai_output):
        return filter_compliance(ai_output)

    kept = [line for line in ai_output.split("\n") if not _match_leak(line)]
    cleaned = "\n".join(kept).strip()
    return filter_compliance(cleaned) if cleaned else LEAK_REPLACEMENT


# 泄露检测的尾部扫描窗口：覆盖最长泄露短语，足以捕获跨 token 边界形成的关键词
_LEAK_SCAN_WINDOW = 160


class StreamGuard:
    """流式输出的增量安全过滤器。

    解决的问题：原先流式路径把模型 token 原样下发给前端，去前缀和泄露过滤只在
    流结束后作用于落库文本，导致用户实时看到的内容从未被过滤。

    工作方式：
    - 起始阶段先缓冲一小段，去掉 AI 口水前缀后再下发；
    - 每喂入一个 token 就在累计文本尾部窗口上做泄露检测，一旦命中立即进入
      blocked 状态，停止下发后续内容；
    - finalize() 返回最终安全的完整文本（命中泄露则返回统一安全提示），
      供落库与 done 事件使用。
    """

    def __init__(self, prefixes: Optional[list] = None):
        self._prefixes = prefixes if prefixes is not None else AI_RESPONSE_PREFIXES
        self._buffer = ""          # 起始去前缀缓冲
        self._started = False      # 是否已结束起始缓冲、进入正常下发
        self._full = ""            # 累计完整文本
        self._blocked = False
        # 起始缓冲阈值：覆盖最长前缀，确保能完整匹配后再决定是否剥离
        self._warmup = max((len(p) for p in self._prefixes), default=0) + 8

    @property
    def full(self) -> str:
        return self._full

    @property
    def blocked(self) -> bool:
        return self._blocked

    def feed(self, token: str) -> str:
        """喂入一个 token，返回应当下发给前端的安全文本（可能为空字符串）。"""
        if not token:
            return ""
        self._full += token

        if self._blocked:
            return ""

        # 泄露检测（仅扫描尾部窗口，O(1) 摊销）
        if _match_leak(self._full[-_LEAK_SCAN_WINDOW:]):
            self._blocked = True
            return ""

        if not self._started:
            self._buffer += token
            if len(self._buffer) < self._warmup:
                return ""  # 继续缓冲，暂不下发
            cleaned = _strip_response_prefixes(self._buffer)
            self._started = True
            self._buffer = ""
            return cleaned

        return token

    def finalize(self) -> str:
        """流结束时调用，返回最终安全的完整文本（命中泄露时按行移除）。"""
        cleaned = _strip_response_prefixes(self._full)
        if self._blocked or _match_leak(cleaned):
            return filter_output_leak(cleaned)
        return cleaned
