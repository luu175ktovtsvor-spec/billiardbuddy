"""后台任务测试：缺参 + 真起一条短命令、watcher 落盘输出。"""
import asyncio

from services.agent import background_tools as bt


def test_run_background_missing_command():
    out = asyncio.run(bt._run_background_handler({}, None))
    assert "[参数缺失]" in out


def test_run_background_runs_and_writes(monkeypatch, tmp_path):
    monkeypatch.setattr(bt, "_bg_dir", lambda: tmp_path)
    monkeypatch.setattr(bt, "_notify", lambda *a, **k: None)  # 别真弹通知

    async def _run():
        out = await bt._run_background_handler({"command": "echo hi"}, None)
        assert "后台启动" in out
        await asyncio.sleep(0.8)  # 等 watcher 跑完落盘

    asyncio.run(_run())
    files = list(tmp_path.glob("*.txt"))
    assert len(files) == 1
    content = files[0].read_text(encoding="utf-8")
    assert "echo hi" in content
    assert "hi" in content
