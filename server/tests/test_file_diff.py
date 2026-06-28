"""B.2：get_file_backup_diff 返回"改前(最近备份)/改后(当前)"，供右侧 diff 视图。"""
import asyncio
from types import SimpleNamespace


def test_get_file_backup_diff(tmp_path, monkeypatch):
    import services.agent.local_tools as lt
    monkeypatch.setattr(lt, "_library_root", lambda: tmp_path)  # 备份落到 tmp/.backups
    f = tmp_path / "note.txt"
    f.write_text("旧内容第一版\n第二行", encoding="utf-8")
    lt._backup(f)                                   # 备份旧内容
    f.write_text("新内容改过了\n第二行", encoding="utf-8")  # 改成新内容
    d = lt.get_file_backup_diff(str(f))
    assert d["ok"] is True
    assert d["old"] == "旧内容第一版\n第二行"        # old = 最近备份
    assert d["new"] == "新内容改过了\n第二行"        # new = 当前内容


def test_get_file_backup_diff_no_backup(tmp_path, monkeypatch):
    """没备份(新建文件)→ old="" 当新建处理，不报错。"""
    import services.agent.local_tools as lt
    monkeypatch.setattr(lt, "_library_root", lambda: tmp_path)
    f = tmp_path / "fresh.txt"
    f.write_text("全新文件", encoding="utf-8")
    d = lt.get_file_backup_diff(str(f))
    assert d["ok"] is True and d["old"] == "" and d["new"] == "全新文件"


def test_get_file_backup_diff_missing():
    import services.agent.local_tools as lt
    d = lt.get_file_backup_diff("/no/such/file/xyz.txt")
    assert d["ok"] is False


def test_restore_file_backup_roundtrip(tmp_path, monkeypatch):
    import services.agent.local_tools as lt
    monkeypatch.setattr(lt, "_library_root", lambda: tmp_path)
    f = tmp_path / "note.txt"
    f.write_text("旧内容", encoding="utf-8")
    backup = lt._backup(f)
    f.write_text("新内容", encoding="utf-8")

    listed = lt.list_file_backups()
    assert listed[0]["path"] == str(f.resolve())
    assert listed[0]["backup_path"] == backup
    result = lt.restore_file_backup(str(f))
    assert result["ok"] is True
    assert f.read_text(encoding="utf-8") == "旧内容"
    assert result["current_backup_path"]


def test_get_file_backup_diff_for_deleted_file_with_backup_path(tmp_path, monkeypatch):
    import services.agent.local_tools as lt
    monkeypatch.setattr(lt, "_library_root", lambda: tmp_path)
    f = tmp_path / "deleted.txt"
    f.write_text("删除前内容", encoding="utf-8")
    backup = lt._backup(f)
    f.unlink()

    missing = lt.get_file_backup_diff(str(f))
    assert missing["ok"] is False
    d = lt.get_file_backup_diff(str(f), backup)
    assert d["ok"] is True
    assert d["old"] == "删除前内容"
    assert d["new"] == ""


def test_list_files_defaults_to_working_dir(tmp_path, monkeypatch):
    """选了工作文件夹后，不传 path 也应默认在那里干活，而不是回到内容库。"""
    import services.agent.local_tools as lt
    lib = tmp_path / "library"
    wd = tmp_path / "work"
    lib.mkdir()
    wd.mkdir()
    (lib / "library-only.txt").write_text("库文件", encoding="utf-8")
    (wd / "work-only.xlsx").write_text("工作目录文件", encoding="utf-8")
    monkeypatch.setattr(lt, "_library_root", lambda: lib)

    ctx = SimpleNamespace(working_dir=str(wd), full_disk_access=False, allowed_paths=[])
    out = asyncio.run(lt.list_files({}, ctx))

    assert "当前工作目录" in out
    assert "work-only.xlsx" in out
    assert "library-only.txt" not in out


def test_write_file_relative_path_lands_in_working_dir(tmp_path, monkeypatch):
    import services.agent.local_tools as lt
    lib = tmp_path / "library"
    wd = tmp_path / "work"
    lib.mkdir()
    wd.mkdir()
    monkeypatch.setattr(lt, "_library_root", lambda: lib)

    ctx = SimpleNamespace(working_dir=str(wd), full_disk_access=False, allowed_paths=[])
    out = asyncio.run(lt.write_file({"path": "today.md", "content": "今晚任务"}, ctx))

    assert "已写入 today.md" in out
    assert (wd / "today.md").read_text(encoding="utf-8") == "今晚任务"
    assert not (lib / "today.md").exists()


def test_path_in_workspace_resolves_relative_path_against_working_dir(tmp_path, monkeypatch):
    import services.agent.local_tools as lt
    lib = tmp_path / "library"
    wd = tmp_path / "work"
    other = tmp_path / "other"
    lib.mkdir()
    wd.mkdir()
    other.mkdir()
    monkeypatch.setattr(lt, "_library_root", lambda: lib)

    ctx = SimpleNamespace(working_dir=str(wd), full_disk_access=True, allowed_paths=[])

    assert lt.path_in_workspace("today.md", ctx) is True
    assert lt.path_in_workspace(str(wd / "today.md"), ctx) is True
    assert lt.path_in_workspace(str(other / "today.md"), ctx) is False
