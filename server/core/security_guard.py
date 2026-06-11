"""
安全防护模块 — 输入/输出过滤
不依赖模型自觉，在代码层面拦截prompt注入和信息泄露
"""
import re
from typing import Optional

# 输入侧：检测prompt注入尝试
INJECTION_PATTERNS = [
    # 中文
    r"你的(系统|prompt|指令|规则|提示词|设定|配置)",
    r"(告诉我|说出|显示|输出|打印)\s*(你的|系统|后台)\s*(prompt|指令|规则|提示词)",
    r"(忘记|忽略|无视|跳过)(你(之前|上面)的|所有)(指令|规则|设定|限制)",
    r"(假装|假设|扮演|模拟)(你是|你没有)(一个)?(没有|不限|无)(限制|规则|约束)",
    r"(用|以)(base64|编码|加密)(方式)?(告诉我|输出|显示)",
    r"(repeat|print|show|display|output|reveal)\s*(your|the|system)\s*(prompt|instructions|rules)",
    r"ignore.*(previous|above|all).*(instructions|rules|prompts)",
    r"system\s*prompt",
    r"你(是|叫|叫什么)(什么|谁|啥)(模型|AI|机器人|助手)",
    r"(你用|用的|什么)(模型|AI|大模型|LLM)",
]

# 输出侧：检测系统信息泄露
LEAK_PATTERNS = [
    r"(我的|系统的|后台的)(prompt|指令|规则|提示词)(是|为|如下)",
    r"(system\s*prompt|系统指令|后台指令)",
    r"(DeepSeek|deepseek|GPT|gpt|Claude|claude|OpenAI|openai)",
    r"(我是|我是一个)(AI|人工智能|大模型|语言模型|LLM)",
    r"(baseline_rules|role_rules|customer_rules|knowledge_context)",
    r"(content_service|stream\.py|prompt_engine)",
    r"(server/prompts|rules/role|rules/customer)",
]

# 命中泄露时统一替换为这句安全提示
LEAK_REPLACEMENT = "我是球房AI运营助手，专注于帮你生成球房运营内容。如果你有运营方面的需求，随时告诉我。"

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
    过滤AI输出中的系统信息泄露。

    只移除包含泄露内容的行，保留其余正文（避免正文偶然提到"AI/模型"
    时整段被丢弃）；若所有内容都命中泄露，才回退到统一安全提示。
    """
    if not ai_output:
        return ai_output

    if not _match_leak(ai_output):
        return ai_output

    kept = [line for line in ai_output.split("\n") if not _match_leak(line)]
    cleaned = "\n".join(kept).strip()
    return cleaned if cleaned else LEAK_REPLACEMENT


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
