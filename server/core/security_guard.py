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
    r"(告诉我|说出|显示|输出|打印)(你的|系统|后台)(prompt|指令|规则|提示词)",
    r"(忘记|忽略|无视|跳过)(你(之前|上面)的|所有)(指令|规则|设定|限制)",
    r"(假装|假设|扮演|模拟)(你是|你没有)(一个)?(没有|不限|无)(限制|规则|约束)",
    r"(用|以)(base64|编码|加密)(方式)?(告诉我|输出|显示)",
    r"(repeat|print|show|display|output|reveal)(your|the|system)(prompt|instructions|rules)",
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
    如果检测到泄露，替换为安全提示。
    """
    if not ai_output:
        return ai_output

    # 检测是否包含系统信息
    for pattern in LEAK_PATTERNS:
        if re.search(pattern, ai_output, re.IGNORECASE):
            # 替换为安全提示
            return "我是球房AI运营助手，专注于帮你生成球房运营内容。如果你有运营方面的需求，随时告诉我。"

    return ai_output
