"""dataeye/tests/make_sample.py — 造一个 gzip 测试包,给本地/真机冒烟用。

用法:
    python dataeye/tests/make_sample.py
    # 在本文件同目录生成 sample.json.gz,然后:
    curl -s -X POST \
      -H "Authorization: Bearer <INGEST_TOKENS 里配的令牌>" \
      -H "Content-Encoding: gzip" \
      -H "Content-Type: application/json" \
      --data-binary @dataeye/tests/sample.json.gz \
      http://127.0.0.1:9100/ingest

也可以不落盘、一行内联生成(见 runbook.md 冒烟测试一节):
    python3 -c "import gzip,json; open('sample.json.gz','wb').write(gzip.compress(json.dumps({'machine_id':'m1','batch':[{'kind':'event','ref_id':'e1','payload':{'id':'e1','event':'agent_chat','props':{},'created_at':None}}]}).encode()))"
"""
import gzip
import json
from pathlib import Path

SAMPLE_BODY = {
    "machine_id": "smoke-test-machine",
    "batch": [
        {
            "kind": "event",
            "ref_id": "smoke-e1",
            "payload": {
                "id": "smoke-e1",
                "event": "agent_chat",
                "store_id": "store-1",
                "user_id": "user-1",
                "props": {"tool": "generate_image"},
                "created_at": "2026-07-02T10:00:00Z",
            },
        },
        {
            "kind": "gen",
            "ref_id": "smoke-g1",
            "payload": {
                "id": "smoke-g1",
                "store_id": "store-1",
                "type": "image",
                "sub_type": "poster",
                "prompt_used": "秋日促销海报",
                "result": "https://example.com/poster.png",
                "model_used": "gpt-image-2",
                "tokens_used": 1234,
                "effect_rating": "good",
                "effect_note": None,
                "is_favorite": True,
                "source_rec_id": None,
                "conversation_id": "conv-1",
                "created_at": "2026-07-02T10:01:00Z",
            },
        },
        {
            "kind": "trace",
            "ref_id": "conv-1",
            "payload": {
                "conversation_id": "conv-1",
                "path": "/local/path/conv-1.jsonl",
                "content": '{"role":"user","content":"帮我做张海报"}\n{"role":"assistant","content":"好的"}\n',
            },
        },
        {
            "kind": "store",
            "ref_id": "store-1",
            "payload": {
                "snapshot": {"id": "store-1", "name": "示例台球房", "city": "杭州"},
            },
        },
    ],
}


def main() -> None:
    out_path = Path(__file__).parent / "sample.json.gz"
    out_path.write_bytes(gzip.compress(json.dumps(SAMPLE_BODY, ensure_ascii=False).encode("utf-8")))
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
