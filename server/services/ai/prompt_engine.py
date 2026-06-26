import asyncio
from datetime import datetime, timedelta
from pathlib import Path

import yaml

from core.exceptions import AppException
from core.timezone import BUSINESS_TZ
from models.store import Store

_WEEKDAY_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def build_date_context(now: datetime) -> dict:
    """生成上下文的日期锚点：今天日期 / 星期 / 本周末（周六+周日）。
    now 由调用方注入（生产侧传北京时间），便于测试确定性。
    解决"周末/明天/周五"等时间词没有锚点、AI 只能瞎猜的问题。"""
    wd = now.weekday()  # 周一=0 … 周日=6
    saturday = now + timedelta(days=(5 - wd))
    sunday = saturday + timedelta(days=1)
    return {
        "today_date": now.strftime("%Y-%m-%d"),
        "weekday_cn": _WEEKDAY_CN[wd],
        "this_weekend": f"{saturday.month}月{saturday.day}日（周六）、{sunday.month}月{sunday.day}日（周日）",
    }


class PromptTemplateNotFoundError(AppException):
    """模板 key 不存在。继承 AppException(400)：用户传了无效 prompt_key 时
    返回 4xx 而非裸 500（仍可被 _load_knowledge_for_role 的 except 捕获）。"""
    def __init__(self, template_key: str):
        super().__init__(f"场景模板不存在：{template_key}", status_code=400)


class PromptVariableMissingError(Exception):
    """必需变量缺失"""
    def __init__(self, missing_vars: list[str]):
        super().__init__(f"缺少必需变量: {', '.join(missing_vars)}")


class PromptEngine:
    def __init__(self):
        self._templates: dict[str, dict] = {}
        self._load_all()

    def _load_all(self) -> None:
        # 桌面全本地版：优先用加密知识库包（护城河不明文外泄）。设了 PROMPTS_PACK_KEY 且有 prompts.enc 才走。
        # web/dev 不设该 env → load_pack 返回 None → 落回下面的明文 YAML 加载，行为完全不变。
        from services.ai.prompt_pack import load_pack
        pack = load_pack()
        if pack is not None:
            self._templates = pack
            return

        prompts_dir = Path(__file__).parent.parent.parent / "prompts"
        if not prompts_dir.exists():
            return
        for yaml_file in prompts_dir.rglob("*.yaml"):
            with open(yaml_file, encoding="utf-8") as f:
                data = yaml.safe_load(f)
            # 宽松登记：凡有 key 的 YAML 都收进 _templates。不同消费方按 key 读各自的子结构
            # （render 读 template；预设库 list_templates 读 templates；fewshots 读 examples 等）。
            # 切勿在此加"必须有 template"校验——会把非渲染类条目(fewshots/templates 库)误删。
            if data and "key" in data:
                self._templates[data["key"]] = data

    def render(
        self,
        template_key: str,
        store: Store,
        extra_vars: dict | None = None,
        lenient: bool = False,
    ) -> str:
        template_data = self._templates.get(template_key)
        if template_data is None:
            raise PromptTemplateNotFoundError(template_key)

        variables = self._build_store_variables(store)
        if extra_vars:
            variables.update(extra_vars)

        required = template_data.get("variables", [])
        missing = [v for v in required if variables.get(v) is None]
        if missing:
            if not lenient:
                raise PromptVariableMissingError(missing)
            # 宽松模式：工作台卡片只提供通用变量，缺失的场景变量交给模型按用户需求处理
            for var in missing:
                variables[var] = "（未提供，请结合用户本次需求与门店情况合理处理）"

        # 用 str.replace 逐个替换，避免 format_map 的花括号转义问题
        rendered = template_data["template"]
        for key, value in variables.items():
            rendered = rendered.replace("{" + key + "}", str(value))
        # 生成类模板注入时间锚点（知识库类不注入），避免"今天/明天/周末/本周几"被 AI 瞎算
        if template_data.get("category") != "knowledge":
            d = build_date_context(datetime.now(BUSINESS_TZ))
            header = (
                f"【当前时间】今天 {d['today_date']}（{d['weekday_cn']}）；本周末是 {d['this_weekend']}。"
                "凡涉及今天/明天/周末/本周几，一律以此为准，不要自行推算。\n\n"
            )
            rendered = header + rendered
        return rendered

    def _build_store_variables(self, store: Store) -> dict:
        return {
            "store_name": store.name or "",
            "city": store.city or "",
            "district": store.district or "",
            "address": store.address or "",
            "phone": store.phone or "",
            "business_hours": store.business_hours or "",
            "price_info": self._format_price_field(store, store.pricing),
            "member_card_info": self._format_price_field(store, store.member_cards),
            "target_customer": store.target_customers or "",
            "store_advantages": store.advantages or "",
            "store_style": store.style or "",
            "table_count": str(store.table_count) if store.table_count else "",
            "table_types": store.table_types or "",
            "has_coaching": "有陪练" if store.has_coaching else "无陪练",
            "has_tournament": "有比赛" if store.has_tournament else "无比赛",
            "has_parking": "有停车" if store.has_parking else "无停车",
            "coach_count": str(store.coach_count) if store.coach_count else "未填写",
            "coach_service_types": store.coach_service_types or "未填写",
            "coach_price_range": store.coach_price_range or "未填写",
            "cue_price_range": store.cue_price_range or "未填写",
            "table_brands": store.table_brands or "未填写",
            "cue_brands": store.cue_brands or "未填写",
            "other_equipment": store.other_equipment or "未填写",
            "daily_avg_customers": str(store.daily_avg_customers) if store.daily_avg_customers else "未填写",
            "peak_hours": store.peak_hours or "未填写",
            "avg_spend_range": store.avg_spend_range or "未填写",
        }

    def _format_jsonb(self, data) -> str:
        if not data:
            return "暂无"
        if isinstance(data, list):
            return "、".join(str(item) for item in data)
        if isinstance(data, dict):
            return "；".join(f"{k}: {v}" for k, v in data.items())
        return str(data)

    def _format_price_field(self, store: Store, data) -> str:
        """价格类字段的单点策略(所有模板的 price_info/member_card_info 都走这里):
        - 资料没填 → "暂无"(模板规则:不提及或用占位符)
        - 已填 + 运营画像开启"允许写价格" → 输出真实数值,AI 直接写进文案
        - 已填 + 未开启 → 明确告知 AI 不公开写数字(写"价格私我/详询前台"),
          避免占位符和泄露门店不想公开的价格"""
        if not data:
            return "暂无"
        formatted = self._format_jsonb(data)
        profile = store.operation_profile if isinstance(store.operation_profile, dict) else {}
        commerce = profile.get("commerce_rules", {}) if isinstance(profile.get("commerce_rules", {}), dict) else {}
        if commerce.get("allow_price_copy"):
            return formatted
        return "门店已设置不在文案中公开写价格（需要提价格时写「价格私我/详询前台」，不要用占位符，也不要写具体数字）"

    def template_name(self, template_key: str) -> str:
        """返回模板的中文名称（用于知识筛选的意图文本），不存在时返回空串。"""
        data = self._templates.get(template_key)
        return data.get("name", "") if data else ""

    def list_templates(self, category: str | None = None) -> list[dict]:
        templates = list(self._templates.values())
        if category:
            templates = [t for t in templates if t.get("category") == category]
        return [
            {"key": t["key"], "name": t.get("name", ""), "category": t.get("category", "")}
            for t in templates
        ]


_instance: PromptEngine | None = None


def get_prompt_engine() -> PromptEngine:
    global _instance
    if _instance is None:
        _instance = PromptEngine()
    return _instance


async def prewarm_prompt_engine() -> PromptEngine:
    """Startup 时异步预热，不阻塞事件循环。"""
    global _instance
    if _instance is None:
        _instance = PromptEngine.__new__(PromptEngine)
        _instance._templates = {}
        await asyncio.to_thread(_instance._load_all)
    return _instance
