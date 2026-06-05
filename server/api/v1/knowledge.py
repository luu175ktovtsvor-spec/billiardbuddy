"""知识库列表 API"""

from pathlib import Path
from fastapi import APIRouter, Depends
import yaml

from api.deps import get_current_user

router = APIRouter()

KNOWLEDGE_DIR = Path(__file__).resolve().parent.parent.parent / "prompts" / "knowledge"


@router.get("/list")
async def list_knowledge(_user=Depends(get_current_user)):
    """返回 AI 已掌握的行业知识列表"""
    items = []
    if KNOWLEDGE_DIR.exists():
        for f in sorted(KNOWLEDGE_DIR.glob("*.yaml")):
            try:
                with open(f, encoding="utf-8") as fp:
                    data = yaml.safe_load(fp)
                    if data:
                        items.append({
                            "key": data.get("key", f.stem),
                            "name": data.get("name", f.stem),
                        })
            except Exception:
                continue
    return {"items": items, "total": len(items)}
