# -*- coding: utf-8 -*-
"""F-12 影子 git 检查点服务（真系统 git 测，dev 机都有）。

锁住契约：
- 探测：mac 上 `/usr/bin/git` 在没装 CLT 时绝不真的执行（只调安全的 `xcode-select -p`），
  防弹出系统"安装命令行开发者工具"对话框。
- init/commit/restore 幂等 + 故障安全；空改动不提交；家目录/桌面拒绝开影子库。
- 恢复保守：只覆盖/找回目标提交里存在的文件，绝不删除检查点之后新增的文件。
- 身份隔离：不读用户全局 gitconfig（哪怕它被"下毒"也不影响提交）。
- 没有 git → 优雅降级，不抛异常，不崩。
"""
import os
import subprocess
from pathlib import Path
from unittest import mock

import pytest

from services import shadow_git as sg
from services.agent.context import AgentContext


@pytest.fixture(autouse=True)
def _reset_probe_cache():
    sg.reset_git_probe_cache_for_tests()
    yield
    sg.reset_git_probe_cache_for_tests()


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    """把 UPLOAD_DIR 指向临时目录（影子库落点），另建一个独立的"用户工作文件夹"。"""
    monkeypatch.setattr(sg.settings, "upload_dir", str(tmp_path / "uploads"))
    wd = tmp_path / "workdir"
    wd.mkdir()
    return wd


def _ctx(wd, conversation_id=None):
    return AgentContext(working_dir=str(wd), conversation_id=conversation_id)


# ────────────────────────────── 探测 · mac 弹框防护 ──────────────────────────────

def test_no_clt_never_invokes_git_binary_only_queries_xcode_select():
    """核心铁律：没装 Xcode CLT 时，命中 /usr/bin/git 绝不真的去执行它（会弹系统安装框）——
    只能调用安全的 `xcode-select -p` 查询。"""
    calls = []

    def fake_run(args, **kwargs):
        calls.append(list(args))
        if args[:2] == ["xcode-select", "-p"]:
            return subprocess.CompletedProcess(args, returncode=1)  # 没装 CLT
        raise AssertionError(f"不该真的调用: {args}（会触发系统安装框）")

    with mock.patch("platform.system", return_value="Darwin"), \
         mock.patch("shutil.which", return_value="/usr/bin/git"), \
         mock.patch("subprocess.run", side_effect=fake_run):
        result = sg._find_system_git()

    assert result is None
    assert calls == [["xcode-select", "-p"]]


def test_clt_installed_probes_version_normally():
    """CLT 已装时，/usr/bin/git 是真 git，才敢真的探测 --version。"""
    calls = []

    def fake_run(args, **kwargs):
        calls.append(list(args))
        if args[:2] == ["xcode-select", "-p"]:
            return subprocess.CompletedProcess(args, returncode=0, stdout=b"/Library/Developer/CommandLineTools")
        if args == ["/usr/bin/git", "--version"]:
            return subprocess.CompletedProcess(args, returncode=0, stdout=b"git version 2.39.2")
        raise AssertionError(f"未预期调用: {args}")

    with mock.patch("platform.system", return_value="Darwin"), \
         mock.patch("shutil.which", return_value="/usr/bin/git"), \
         mock.patch("subprocess.run", side_effect=fake_run):
        result = sg._find_system_git()

    assert result == "/usr/bin/git"
    assert calls[0] == ["xcode-select", "-p"]
    assert calls[1] == ["/usr/bin/git", "--version"]


def test_non_stub_git_path_probed_directly_without_clt_check():
    """非 /usr/bin/git 的路径（如 Homebrew git）不是苹果转发桩，不需要 xcode-select 前置检查。"""
    calls = []

    def fake_run(args, **kwargs):
        calls.append(list(args))
        return subprocess.CompletedProcess(args, returncode=0, stdout=b"git version 2.43.0")

    with mock.patch("platform.system", return_value="Darwin"), \
         mock.patch("shutil.which", return_value="/opt/homebrew/bin/git"), \
         mock.patch("subprocess.run", side_effect=fake_run):
        result = sg._find_system_git()

    assert result == "/opt/homebrew/bin/git"
    assert calls == [["/opt/homebrew/bin/git", "--version"]]  # 没调 xcode-select


def test_no_git_anywhere_returns_none():
    with mock.patch("shutil.which", return_value=None):
        assert sg._find_system_git() is None


def test_git_binary_path_caches_result():
    calls = {"n": 0}

    def fake_which(name):
        calls["n"] += 1
        return "/usr/bin/git"

    with mock.patch("shutil.which", side_effect=fake_which), \
         mock.patch.object(sg, "_probe_git_version", return_value=True), \
         mock.patch.object(sg, "_clt_installed", return_value=True):
        sg.git_binary_path()
        sg.git_binary_path()
    assert calls["n"] == 1  # 第二次命中缓存，没再探测


# ────────────────────────────── init / commit ──────────────────────────────

def test_init_creates_bare_shadow_repo(workspace):
    ctx = _ctx(workspace)
    assert sg.shadow_git_available(ctx) is True
    shadow_dir = sg.init_shadow_repo(ctx)
    assert shadow_dir is not None
    assert (shadow_dir / "HEAD").exists()
    # 裸库：不应该在用户工作文件夹里出现任何 .git
    assert not (workspace / ".git").exists()


def test_commit_creates_checkpoint_and_returns_sha(workspace):
    ctx = _ctx(workspace)
    (workspace / "a.txt").write_text("v1", encoding="utf-8")
    sha = sg.commit_checkpoint(ctx, label="write_file:a.txt")
    assert sha and len(sha) == 40


def test_empty_change_does_not_commit(workspace):
    ctx = _ctx(workspace)
    (workspace / "a.txt").write_text("v1", encoding="utf-8")
    sha1 = sg.commit_checkpoint(ctx, label="first")
    assert sha1
    sha2 = sg.commit_checkpoint(ctx, label="second, no real change")
    assert sha2 is None  # 没有改动，不应该产生新提交


def test_second_commit_after_real_change_gets_new_sha(workspace):
    ctx = _ctx(workspace)
    (workspace / "a.txt").write_text("v1", encoding="utf-8")
    sha1 = sg.commit_checkpoint(ctx, label="v1")
    (workspace / "a.txt").write_text("v2", encoding="utf-8")
    sha2 = sg.commit_checkpoint(ctx, label="v2")
    assert sha2 and sha2 != sha1


def test_init_is_idempotent(workspace):
    ctx = _ctx(workspace)
    d1 = sg.init_shadow_repo(ctx)
    d2 = sg.init_shadow_repo(ctx)
    assert d1 == d2


# ────────────────────────────── 危险根目录拒绝 ──────────────────────────────

def test_home_dir_as_workspace_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(sg.settings, "upload_dir", str(tmp_path / "uploads"))
    with mock.patch.object(Path, "home", return_value=tmp_path / "fake-home"):
        (tmp_path / "fake-home").mkdir()
        ctx = _ctx(tmp_path / "fake-home")
        assert sg.shadow_git_available(ctx) is False
        assert sg.commit_checkpoint(ctx, label="x") is None
        assert sg.init_shadow_repo(ctx) is None


def test_desktop_dir_as_workspace_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(sg.settings, "upload_dir", str(tmp_path / "uploads"))
    fake_home = tmp_path / "fake-home"
    (fake_home / "Desktop").mkdir(parents=True)
    with mock.patch.object(Path, "home", return_value=fake_home):
        ctx = _ctx(fake_home / "Desktop")
        assert sg.shadow_git_available(ctx) is False


def test_filesystem_root_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(sg.settings, "upload_dir", str(tmp_path / "uploads"))
    ctx = _ctx(Path("/"))
    assert sg.shadow_git_available(ctx) is False


def test_subfolder_of_documents_is_allowed(tmp_path, monkeypatch):
    """产品默认工作目录是 Documents/台球助手 这个子文件夹——不应被"Documents 根目录"那条规则误伤。"""
    monkeypatch.setattr(sg.settings, "upload_dir", str(tmp_path / "uploads"))
    fake_home = tmp_path / "fake-home"
    workdir = fake_home / "Documents" / "台球助手"
    workdir.mkdir(parents=True)
    with mock.patch.object(Path, "home", return_value=fake_home):
        ctx = _ctx(workdir)
        assert sg.shadow_git_available(ctx) is True


def test_no_working_dir_set_is_unavailable(tmp_path, monkeypatch):
    monkeypatch.setattr(sg.settings, "upload_dir", str(tmp_path / "uploads"))
    ctx = AgentContext(working_dir=None)
    assert sg.shadow_git_available(ctx) is False
    assert sg.commit_checkpoint(ctx, label="x") is None


# ────────────────────────────── 恢复：保守语义 ──────────────────────────────

def test_restore_reverts_content_without_deleting_later_files(workspace):
    ctx = _ctx(workspace)
    (workspace / "a.txt").write_text("v1", encoding="utf-8")
    sha1 = sg.commit_checkpoint(ctx, label="v1")

    (workspace / "a.txt").write_text("v2", encoding="utf-8")
    sg.commit_checkpoint(ctx, label="v2")

    # 检查点之后新建的文件
    (workspace / "b.txt").write_text("created after sha1", encoding="utf-8")
    sg.commit_checkpoint(ctx, label="add b")

    result = sg.restore_files(ctx, sha1)
    assert result["ok"] is True
    assert (workspace / "a.txt").read_text(encoding="utf-8") == "v1"
    # 铁律：不删除检查点之后新增的（已跟踪）文件
    assert (workspace / "b.txt").exists()


def test_restore_brings_back_deleted_file(workspace):
    """检查点之后被工具删掉的文件，恢复到检查点前的 sha 应该能找回来。"""
    ctx = _ctx(workspace)
    (workspace / "a.txt").write_text("important", encoding="utf-8")
    sha1 = sg.commit_checkpoint(ctx, label="create a")

    os.remove(workspace / "a.txt")
    sg.commit_checkpoint(ctx, label="delete a")
    assert not (workspace / "a.txt").exists()

    result = sg.restore_files(ctx, sha1)
    assert result["ok"] is True
    assert (workspace / "a.txt").read_text(encoding="utf-8") == "important"


def test_restore_leaves_pre_restore_checkpoint_when_uncommitted_changes_exist(workspace):
    ctx = _ctx(workspace)
    (workspace / "a.txt").write_text("v1", encoding="utf-8")
    sha1 = sg.commit_checkpoint(ctx, label="v1")
    # 恢复前有未提交的改动
    (workspace / "a.txt").write_text("uncommitted", encoding="utf-8")

    result = sg.restore_files(ctx, sha1)
    assert result["ok"] is True
    assert result["pre_restore_checkpoint"]  # 留了"恢复前"检查点，没丢东西


def test_restore_unknown_sha_fails_gracefully(workspace):
    ctx = _ctx(workspace)
    (workspace / "a.txt").write_text("v1", encoding="utf-8")
    sg.commit_checkpoint(ctx, label="v1")
    result = sg.restore_files(ctx, "0" * 40)
    assert result["ok"] is False
    assert "error" in result


def test_restore_without_any_checkpoint_fails_gracefully(workspace):
    ctx = _ctx(workspace)
    result = sg.restore_files(ctx, "a" * 40)
    assert result["ok"] is False


def test_restore_rejects_dangerous_root(tmp_path, monkeypatch):
    monkeypatch.setattr(sg.settings, "upload_dir", str(tmp_path / "uploads"))
    with mock.patch.object(Path, "home", return_value=tmp_path / "fake-home"):
        (tmp_path / "fake-home").mkdir()
        ctx = _ctx(tmp_path / "fake-home")
        result = sg.restore_files(ctx, "a" * 40)
        assert result["ok"] is False


# ────────────────────────────── 无 git 优雅降级 ──────────────────────────────

def test_no_git_degrades_gracefully_everywhere(workspace):
    ctx = _ctx(workspace)
    with mock.patch.object(sg, "_bundled_git_candidate", return_value=None), \
         mock.patch.object(sg, "_find_system_git", return_value=None):
        sg.reset_git_probe_cache_for_tests()
        assert sg.git_binary_path() is None
        assert sg.shadow_git_available(ctx) is False
        assert sg.init_shadow_repo(ctx) is None
        assert sg.commit_checkpoint(ctx, label="x") is None
        result = sg.restore_files(ctx, "a" * 40)
        assert result["ok"] is False
        assert "git" in result["error"]
    sg.reset_git_probe_cache_for_tests()


# ────────────────────────────── 身份隔离 · .gitignore ──────────────────────────────

def test_commit_ignores_user_gitignore_patterns(workspace):
    ctx = _ctx(workspace)
    (workspace / ".gitignore").write_text("ignored_dir/\n", encoding="utf-8")
    (workspace / "ignored_dir").mkdir()
    (workspace / "ignored_dir" / "junk.txt").write_text("junk", encoding="utf-8")
    (workspace / "kept.txt").write_text("kept", encoding="utf-8")

    sha = sg.commit_checkpoint(ctx, label="respect gitignore")
    assert sha

    git = sg.git_binary_path()
    shadow_dir = sg._shadow_repo_dir(sg._clean_working_dir(ctx))
    r = sg._run_git(git, ["ls-tree", "-r", "--name-only", "HEAD"], shadow_dir, workspace)
    tracked = r.stdout.strip().splitlines()
    assert "kept.txt" in tracked
    assert "ignored_dir/junk.txt" not in tracked


def test_commit_ignores_default_junk_even_without_user_gitignore(workspace):
    ctx = _ctx(workspace)
    (workspace / "__pycache__").mkdir()
    (workspace / "__pycache__" / "x.pyc").write_text("x", encoding="utf-8")
    (workspace / "kept.txt").write_text("kept", encoding="utf-8")

    sha = sg.commit_checkpoint(ctx, label="default excludes")
    assert sha

    git = sg.git_binary_path()
    shadow_dir = sg._shadow_repo_dir(sg._clean_working_dir(ctx))
    r = sg._run_git(git, ["ls-tree", "-r", "--name-only", "HEAD"], shadow_dir, workspace)
    tracked = r.stdout.strip().splitlines()
    assert "kept.txt" in tracked
    assert not any("__pycache__" in t for t in tracked)


def test_commit_identity_isolated_from_poisoned_global_gitconfig(workspace, tmp_path, monkeypatch):
    """伪造一个"下毒"的用户全局 gitconfig（假身份 + 强制 gpgsign + 不存在的 gpg 程序），
    确认影子库提交完全不受影响——既不会因为 gpgsign 卡住失败，身份也不是被下毒的那个。"""
    poison_home = tmp_path / "poison-home"
    poison_home.mkdir()
    (poison_home / ".gitconfig").write_text(
        "[user]\n\tname = 坏蛋\n\temail = evil@evil.com\n"
        "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /definitely/not/exist\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HOME", str(poison_home))

    ctx = _ctx(workspace)
    (workspace / "c.txt").write_text("isolation test", encoding="utf-8")
    sha = sg.commit_checkpoint(ctx, label="isolation test")
    assert sha, "毒化 HOME 不该导致提交失败"

    git = sg.git_binary_path()
    shadow_dir = sg._shadow_repo_dir(sg._clean_working_dir(ctx))
    r = sg._run_git(git, ["log", "-1", "--format=%an <%ae>"], shadow_dir, workspace)
    assert "坏蛋" not in r.stdout
    assert sg._SHADOW_AUTHOR_NAME in r.stdout
