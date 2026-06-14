"""报表表单 schema 加载器（单例）。一表一 YAML，放 server/report_forms/。

仿 prompt_engine 约定：递归扫描，缺 key/shape/groups 的文件静默跳过。
"""
from pathlib import Path

import yaml

_FORMS_DIR = Path(__file__).resolve().parent.parent / "report_forms"
_REQUIRED = ("key", "shape")
_SHAPES = ("flat", "roster", "personal")

_registry: dict[str, dict] | None = None


def _load_all() -> dict[str, dict]:
    registry: dict[str, dict] = {}
    for path in _FORMS_DIR.rglob("*.yaml"):
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not data or not all(k in data for k in _REQUIRED):
            continue  # 缺 key/shape 静默跳过（同 prompt_engine 约定）
        if "groups" not in data and "columns" not in data:
            continue  # flat/personal 用 groups、roster 用 columns，至少有一
        if data["shape"] not in _SHAPES:
            raise ValueError(f"{path.name}: 未知 shape {data['shape']}")
        registry[data["key"]] = data
    return registry


def get_report_schema(report_type: str) -> dict:
    """按 key 取一张表的 schema；未知 key 抛 KeyError。"""
    global _registry
    if _registry is None:
        _registry = _load_all()
    return _registry[report_type]


def all_report_schemas() -> dict[str, dict]:
    global _registry
    if _registry is None:
        _registry = _load_all()
    return _registry
