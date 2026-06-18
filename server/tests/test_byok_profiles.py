"""多供应商配置档（CC Switch 式）本地存储测试。

锁住：保存/列出/取全量/激活(互斥)/删除/同名覆盖/不传key保留原key/跨店隔离。
"""
import pytest

from services import byok_profiles as bp


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("DESKTOP_BYOK_DIR", str(tmp_path / "byok"))
    bp.reset_for_test()
    yield
    bp.reset_for_test()


def test_save_list_and_mask_key():
    bp.save_profile("s1", "DeepSeek", "https://api.deepseek.com", "deepseek-v4-pro", "enc-aaa")
    bp.save_profile("s1", "备用号", "https://api.x.com/v1", "mimo-v2.5", None)  # 没 key
    profs = bp.list_profiles("s1")
    names = {p["name"] for p in profs}
    assert names == {"DeepSeek", "备用号"}
    ds = next(p for p in profs if p["name"] == "DeepSeek")
    assert ds["has_key"] is True and ds["base_url"] == "https://api.deepseek.com"
    assert next(p for p in profs if p["name"] == "备用号")["has_key"] is False
    # list 不回传密文
    assert "api_key_enc" not in ds


def test_get_full_includes_ciphertext():
    bp.save_profile("s1", "DeepSeek", "u", "m", "enc-secret")
    full = bp.get_profile("s1", "DeepSeek")
    assert full["api_key_enc"] == "enc-secret"   # 激活时要用密文拷进 store
    assert bp.get_profile("s1", "不存在") is None


def test_activate_is_mutually_exclusive():
    bp.save_profile("s1", "A", "u", "m", "encA")
    bp.save_profile("s1", "B", "u", "m", "encB")
    bp.set_active("s1", "A")
    actives = {p["name"]: p["is_active"] for p in bp.list_profiles("s1")}
    assert actives == {"A": True, "B": False}
    bp.set_active("s1", "B")   # 切到 B
    actives = {p["name"]: p["is_active"] for p in bp.list_profiles("s1")}
    assert actives == {"A": False, "B": True}   # 互斥，只有一个激活


def test_save_keeps_key_when_not_passed():
    bp.save_profile("s1", "A", "u1", "m1", "enc1")
    bp.save_profile("s1", "A", "u2", "m2", None)   # 只改 url/model，不传 key
    full = bp.get_profile("s1", "A")
    assert full["base_url"] == "u2" and full["api_key_enc"] == "enc1"  # key 保留


def test_delete_and_store_isolation():
    bp.save_profile("s1", "A", "u", "m", "enc")
    bp.save_profile("s2", "A", "u", "m", "enc")   # 别的店同名
    bp.delete_profile("s1", "A")
    assert bp.list_profiles("s1") == []
    assert len(bp.list_profiles("s2")) == 1        # 不串店
