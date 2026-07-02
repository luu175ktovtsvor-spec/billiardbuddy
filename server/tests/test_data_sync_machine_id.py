from services.data_sync.machine_id import get_machine_id


def test_machine_id_stable(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    a = get_machine_id()
    b = get_machine_id()
    assert a and a == b
    assert (tmp_path / "machine_id").exists()
