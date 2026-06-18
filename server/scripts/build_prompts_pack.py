#!/usr/bin/env python
"""桌面打包步骤：把全部明文 prompt/知识 YAML 加密成 server/prompts.enc。

用法（打包时，需先设 Fernet 密钥）：
  PROMPTS_PACK_KEY=<fernet> python scripts/build_prompts_pack.py
桌面 electron-builder 只把 prompts.enc + 同一个 PROMPTS_PACK_KEY 塞进后端，不塞明文 prompts/。
"""
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # server/
from services.ai.prompt_pack import build_pack, PACK_PATH  # noqa: E402


def main() -> None:
    prompts_dir = Path(__file__).resolve().parent.parent / "prompts"
    templates: dict[str, dict] = {}
    for yf in sorted(prompts_dir.rglob("*.yaml")):
        data = yaml.safe_load(yf.read_text(encoding="utf-8"))
        if data and "key" in data:
            templates[data["key"]] = data
    build_pack(templates, PACK_PATH)
    print(f"✅ 加密知识库包 → {PACK_PATH}  ({PACK_PATH.stat().st_size} bytes, {len(templates)} 模板)")


if __name__ == "__main__":
    main()
