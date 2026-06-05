from pathlib import Path

import yaml

from models.store import Store


class PromptTemplateNotFoundError(Exception):
    """模板 key 不存在"""
    def __init__(self, template_key: str):
        super().__init__(f"Prompt 模板不存在: {template_key}")


class PromptVariableMissingError(Exception):
    """必需变量缺失"""
    def __init__(self, missing_vars: list[str]):
        super().__init__(f"缺少必需变量: {', '.join(missing_vars)}")


class PromptEngine:
    def __init__(self):
        self._templates: dict[str, dict] = {}
        self._load_all()

    def _load_all(self) -> None:
        prompts_dir = Path(__file__).parent.parent.parent / "prompts"
        if not prompts_dir.exists():
            return
        for yaml_file in prompts_dir.rglob("*.yaml"):
            with open(yaml_file, encoding="utf-8") as f:
                data = yaml.safe_load(f)
            if data and "key" in data:
                self._templates[data["key"]] = data

    def render(self, template_key: str, store: Store, extra_vars: dict | None = None) -> str:
        template_data = self._templates.get(template_key)
        if template_data is None:
            raise PromptTemplateNotFoundError(template_key)

        variables = self._build_store_variables(store)
        if extra_vars:
            variables.update(extra_vars)

        required = template_data.get("variables", [])
        missing = [v for v in required if variables.get(v) is None]
        if missing:
            raise PromptVariableMissingError(missing)

        # 用 str.replace 逐个替换，避免 format_map 的花括号转义问题
        rendered = template_data["template"]
        for key, value in variables.items():
            rendered = rendered.replace("{" + key + "}", str(value))
        return rendered

    def _build_store_variables(self, store: Store) -> dict:
        return {
            "store_name": store.name or "",
            "city": store.city or "",
            "district": store.district or "",
            "address": store.address or "",
            "phone": store.phone or "",
            "business_hours": store.business_hours or "",
            "price_info": self._format_jsonb(store.pricing),
            "member_card_info": self._format_jsonb(store.member_cards),
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
            "beverage_price_range": store.beverage_price_range or "未填写",
            "snack_price_range": store.snack_price_range or "未填写",
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
