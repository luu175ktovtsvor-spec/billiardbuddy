"""B.2：get_file_backup_diff 返回"改前(最近备份)/改后(当前)"，供右侧 diff 视图。"""


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
