# -*- coding: utf-8 -*-
"""F-12 影子 git 检查点：把「改前备份单文件」升级成【工作区级快照】。

背景：`local_tools._backup` 只单文件级备份、落 `_library_root()/.backups`——够用但没法"回到几步前
的整个工作文件夹状态"。这里给用户工作文件夹（`ctx.working_dir`）建一个**影子 git 仓库**：
- **裸库**（bare）：`git init --bare` 建在 `UPLOAD_DIR/shadow-git/<工作夹标识>/`，跟用户工作文件夹
  完全物理隔离——`GIT_DIR` 指影子库、`GIT_WORK_TREE` 指用户工作文件夹，**绝不在用户目录里塞 `.git`**。
- 每次写改类工具成功执行后（见 `services/agent/shadow_git_hook.py`）打一个 commit（检查点），
  "跳过确认"模式才敢真的放开——出岔子能整目录回到某一步，不只是单个文件。

坑逐条抄自 Gemini CLI 的 `packages/core/src/services/gitService.ts`（已读源码核实，2026-07-03
从 `raw.githubusercontent.com/google-gemini/gemini-cli/main/...` 拉取确认）：
- **独立身份、完全不读用户全局 `~/.gitconfig`**：跟 Gemini 同款做法——用 `GIT_CONFIG_GLOBAL`
  指向一份我们自己写的专属配置文件（`<影子库>/gitconfig`，含固定的 `user.name/email` +
  `commit.gpgsign=false`），从根源替换掉 git 默认会读的 `$HOME/.gitconfig`（而不是只在裸库
  本地 config 里覆盖几个键——那样用户全局配置里的其它奇怪设置，如自定义 `hooksPath`、强制
  `gpgsign`，仍会漏进来）；另外双保险地在每次调用都显式传 `GIT_AUTHOR_NAME/EMAIL` 等环境变量
  （防沙箱环境配置文件读取时机不对导致 "Author identity unknown" 报错，Gemini 同款兜底）。
- **清洗 git 环境变量**：调子进程前把继承环境里所有 `GIT_*` 变量剥掉，只留我们显式设的那几个——
  防父进程/用户 shell 里残留的 `GIT_DIR`/`GIT_WORK_TREE`/`GIT_CONFIG_*` 串进来把我们的覆盖掉。
- **不读系统级配置**：`GIT_CONFIG_NOSYSTEM=1`（git 官方为"给测试/构建农场一个可预测环境"设计的
  开关，比 Gemini 那种"指一个空文件糊弄 GIT_CONFIG_SYSTEM"更干净直接）。
- **复制用户 `.gitignore`**：不像 Gemini 那样把 `.gitignore` 抄一份到历史目录里（那份文件不在
  `GIT_WORK_TREE` 内、也不是 `$GIT_DIR/info/exclude`，git 实际上不会去读它——核实后判断那是
  upstream 自己的一个死代码角落，没有照抄）；这里改用 git 原生、对"裸库 + 外部 work-tree"场景
  正确生效的位置——`$GIT_DIR/info/exclude`，把用户 `.gitignore`（若有）+ 一份内置默认排除
  （`node_modules/`、`__pycache__/`、`.venv/` 等）合并写进去，`git add -A` 才不会把这些也吃进去。
- **没有 git 就优雅降级**：mac 上 `/usr/bin/git` 在没装 Xcode Command Line Tools 时是苹果的转发桩，
  真的执行它会弹出系统级"安装命令行开发者工具"对话框——绝不能让探测本身触发这个。见
  `_find_system_git` 的 `xcode-select -p` 前置检查（这是安全的查询命令，不装不弹）。
- **恢复更保守（有意跟 Gemini 不同）**：Gemini 的 `restoreProjectFromSnapshot` 用
  `git restore --source=<hash> . && git clean -f -d`——`clean -f -d` 会删掉恢复目标点之后新增的
  【未跟踪】文件。我们的场景是普通用户的文档文件夹（不是软件项目 cwd），误删用户手动放进去的
  照片/文档代价比"回滚不够彻底"高得多，所以本模块的 `restore_files` 只做 `read-tree` +
  `checkout-index -f`（只覆盖/找回目标提交里存在的文件内容，**绝不删除任何文件**）——细节见
  `restore_files` 的 docstring。
"""
from __future__ import annotations

import hashlib
import logging
import os
import platform
import re
import subprocess
from pathlib import Path

from config import settings
from core.timezone import business_now

logger = logging.getLogger(__name__)

_SHADOW_SUBDIR = "shadow-git"
_SHADOW_AUTHOR_NAME = "台球助手（自动检查点）"
_SHADOW_AUTHOR_EMAIL = "checkpoint@billiards-desktop.local"

_DEFAULT_EXCLUDES = [
    ".git/", "node_modules/", "__pycache__/", "*.pyc", ".DS_Store", "Thumbs.db",
    ".venv/", "venv/", "dist/", "build/", ".next/", ".backups/", "*.tmp", "~$*",
]

_SHA_RE = re.compile(r"^[0-9a-fA-F]{4,40}$")

# ────────────────────────────── ① git 可执行探测（优雅降级的第一道闸） ──────────────────────────────

_git_probe_cache: dict = {}


def _repo_root() -> Path:
    """仓库根：server/services/shadow_git.py 往上 2 层。"""
    return Path(__file__).resolve().parents[2]


def _bundled_git_candidate() -> Path | None:
    """打包后 electron 注入的 git 路径（env GIT_BIN，见 desktop/src/backend.js resolveGitBin）；
    dev 环境下 `desktop/resources/git-bin/` 目前只是个占位空目录（真机打真二进制归 G2，见该目录说明），
    存在就用，不存在就交给下一步找系统 git。"""
    env = os.environ.get("GIT_BIN")
    if env and Path(env).is_file():
        return Path(env)
    name = "git.exe" if platform.system() == "Windows" else "git"
    candidate = _repo_root() / "desktop" / "resources" / "git-bin" / name
    if candidate.is_file():
        return candidate
    return None


def _clt_installed() -> bool:
    """mac 专用：Xcode Command Line Tools 是否真的装了。`xcode-select -p` 是安全的查询命令——
    不装 CLT 时它只是返回非零退出码 + 报错文案，绝不会弹出"安装命令行开发者工具"的系统对话框
    （那个弹窗只在真的【执行】/usr/bin/git、/usr/bin/cc 这些转发桩时才会触发）。"""
    try:
        r = subprocess.run(["xcode-select", "-p"], capture_output=True, timeout=3)
        return r.returncode == 0
    except Exception:
        return False


def _probe_git_version(path: str) -> bool:
    """静默探测某个候选路径是否是能真的跑起来的 git（`--version`）。任何异常（含超时/找不到/
    权限）一律当作"不可用"，绝不向上抛——这条路径本身就是"要不要用影子 git"的判定依据，
    不能因为探测失败连累调用方崩溃。"""
    try:
        r = subprocess.run([path, "--version"], capture_output=True, timeout=5)
        return r.returncode == 0 and b"git version" in (r.stdout or b"").lower()
    except Exception:
        return False


def _find_system_git() -> str | None:
    """PATH 里找 git。`shutil.which` 只做路径查找（stat/access），不会执行任何东西，本身绝对安全。
    ⚠️ 关键坑：macOS 上只要系统存在 `/usr/bin/git`（几乎所有 mac 都有，不管装没装 CLT），
    `which` 就会找到它——但那可能只是苹果的转发桩，真去跑 `--version` 会弹系统安装框。
    所以命中 `/usr/bin/git` 时先用安全的 `xcode-select -p` 确认 CLT 真装了，装了才敢碰。
    命中的是其它路径（Homebrew /opt/homebrew/bin/git、/usr/local/bin/git 等，或非 mac 平台）
    → 那些都是真实的 git 安装、不是转发桩，直接探测。"""
    import shutil

    found = shutil.which("git")
    if not found:
        return None
    if platform.system() == "Darwin" and found == "/usr/bin/git":
        if not _clt_installed():
            return None  # 没装 CLT：绝不去碰这个转发桩
    return found if _probe_git_version(found) else None


def git_binary_path() -> str | None:
    """返回可用的 git 可执行文件路径；进程内缓存（避免每次 checkpoint 都重新 fork 子进程去探测）。
    找不到 / 探测失败 → None，上层（`shadow_git_available` / `commit_checkpoint` / `restore_files`）
    据此一律走优雅降级，绝不因为没 git 而崩或报错。"""
    if "path" in _git_probe_cache:
        return _git_probe_cache["path"]
    bundled = _bundled_git_candidate()
    path = str(bundled) if bundled else _find_system_git()
    _git_probe_cache["path"] = path
    return path


def reset_git_probe_cache_for_tests() -> None:
    """测试专用：清掉探测缓存，让"有 git / 没 git"两种场景能在同一进程里切换测试。"""
    _git_probe_cache.clear()


# ────────────────────────────── ② 工作目录合法性（危险根目录拒绝） ──────────────────────────────

def _clean_working_dir(ctx) -> Path | None:
    """从 ctx.working_dir 解析出干净的绝对路径；没设置/空白/解析失败 → None。"""
    raw = (getattr(ctx, "working_dir", None) or "").strip()
    if not raw:
        return None
    try:
        return Path(raw).expanduser().resolve()
    except (OSError, ValueError):
        return None


def _is_dangerous_workspace_root(path: Path) -> bool:
    """家目录/桌面直接当工作区 → 拒绝开影子库（太危险：`git add -A` 会尝试吃下整个家目录，
    体积爆炸不说，还可能把用户其它项目/隐私文件一并纳入快照历史）。

    工作单只明确要求拦"家目录/桌面"两项；这里额外顺手拦了「Documents/Downloads 根目录本身」
    和「文件系统根/盘符根」——同样是"太宽泛、直接当工作区风险类似家目录"的情形，属于同一条铁律
    的自然延伸（**不影响**产品默认工作目录 `Documents/台球助手`这个子文件夹，那个仍正常放行）。
    命中任何一条 → 优雅降级到单文件备份，不影响功能，只是没有整目录快照。"""
    try:
        home = Path.home().resolve()
    except Exception:
        return True  # 连 home 都解析不出来，保守拒绝
    dangerous = {home, home / "Desktop", home / "Documents", home / "Downloads"}
    if path in dangerous:
        return True
    if path.parent == path:  # 文件系统根（"/"）或 Windows 盘符根（"C:\\"）：parent 是它自己
        return True
    return False


def shadow_git_available(ctx) -> bool:
    """本次上下文是否满足"可以用影子 git"的全部前提：有可用 git + 设了工作目录 + 工作目录不是
    家目录/桌面这类危险根。三者任一不满足 → False（上层静默走单文件备份兜底，不算错误）。"""
    if not git_binary_path():
        return False
    wd = _clean_working_dir(ctx)
    if wd is None:
        return False
    return not _is_dangerous_workspace_root(wd)


# ────────────────────────────── ③ 影子库路径 + git 调用封装 ──────────────────────────────

def _shadow_repo_dir(working_dir: Path) -> Path:
    """某工作文件夹对应的影子库落点：按工作目录绝对路径算一个稳定 hash 当"工作夹标识"
    （不直接拿路径明文当目录名——路径可能含中文/特殊字符，hash 更稳）。"""
    ident = hashlib.sha1(str(working_dir).encode("utf-8")).hexdigest()[:16]
    return Path(settings.upload_dir) / _SHADOW_SUBDIR / ident


def _shadow_gitconfig_path(shadow_dir: Path) -> Path:
    return shadow_dir / "gitconfig"


def _write_shadow_gitconfig(shadow_dir: Path) -> None:
    """独立的"全局配置"文件——通过 `GIT_CONFIG_GLOBAL` 指向它，从根源上替换掉 git 默认会读的
    `$HOME/.gitconfig`，而不是只覆盖 user.name/email 这几个键。**这样即使用户全局配置里有奇怪的
    设置（自定义 hooksPath、强制 gpgsign、alias 等），影子库也完全不会受影响**——比"只在裸库
    本地 config 里覆盖 3 个键"更彻底地实现了"别读用户全局 gitconfig"这条要求。
    故障安全：写失败只记日志，不抛（`GIT_CONFIG_GLOBAL` 指向一个不存在的文件时 git 按"空全局配置"
    处理、不会报错，所以就算这步没写成功也不会导致后续 git 调用失败，顶多退化成没有身份配置）。"""
    try:
        _shadow_gitconfig_path(shadow_dir).write_text(
            f"[user]\n\tname = {_SHADOW_AUTHOR_NAME}\n\temail = {_SHADOW_AUTHOR_EMAIL}\n"
            f"[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n",
            encoding="utf-8",
        )
    except Exception:
        logger.debug("写影子库专属 gitconfig 失败（忽略）", exc_info=True)


def _clean_env_base(shadow_dir: Path) -> dict:
    """跑 git 子进程的基础环境：剥掉所有继承来的 `GIT_*` 变量（防父进程/用户 shell 残留串进来），
    只留其它正常环境（PATH 等），再叠加"不读系统级 gitconfig" + "全局配置指向我们自己这份"两道闸，
    双重保证绝不读到用户真实的 `~/.gitconfig` / `/etc/gitconfig`。"""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_CONFIG_NOSYSTEM"] = "1"  # 官方开关：给这类"要可预测环境"的场景用，别读 /etc/gitconfig
    env["GIT_CONFIG_GLOBAL"] = str(_shadow_gitconfig_path(shadow_dir))  # 替换掉 $HOME/.gitconfig
    return env


def _identity_env() -> dict:
    """三保险身份（专属 gitconfig 是第一层、这是第二层显式环境变量）：防某些环境下配置文件读取
    时机不对导致 "Author identity unknown" commit 失败（Gemini gitService.ts 同款兜底）。"""
    return {
        "GIT_AUTHOR_NAME": _SHADOW_AUTHOR_NAME, "GIT_AUTHOR_EMAIL": _SHADOW_AUTHOR_EMAIL,
        "GIT_COMMITTER_NAME": _SHADOW_AUTHOR_NAME, "GIT_COMMITTER_EMAIL": _SHADOW_AUTHOR_EMAIL,
    }


def _run_git(git_bin: str, args: list[str], shadow_dir: Path, work_tree: Path | None = None,
             timeout: float = 20) -> subprocess.CompletedProcess:
    """统一的 git 子进程调用：GIT_DIR 恒定指影子库；给了 work_tree 才设 GIT_WORK_TREE
    （`git init --bare` 这类不需要 work tree 的调用不传）。"""
    env = _clean_env_base(shadow_dir)
    env["GIT_DIR"] = str(shadow_dir)
    if work_tree is not None:
        env["GIT_WORK_TREE"] = str(work_tree)
        env.update(_identity_env())
    return subprocess.run(
        [git_bin, *args], env=env, capture_output=True, text=True, timeout=timeout,
        cwd=str(work_tree) if work_tree is not None else None,
    )


# ────────────────────────────── ④ init / commit / restore ──────────────────────────────

def _sync_excludes(shadow_dir: Path, work_tree: Path) -> None:
    """把用户工作夹的 `.gitignore`（若有）+ 内置默认排除，写进 `$GIT_DIR/info/exclude`——
    这是 git 官方给"仓库自己的排除规则、不需要出现在被追踪的工作树里"设计的位置，
    对我们"裸库 + 外部 work-tree"的架构天然正确生效（不像把文件抄进历史目录那样读不到）。
    每次 commit 前都重新同步一遍（用户随时可能新增/改 .gitignore），故障安全：失败只跳过，
    不影响 add/commit 主流程（顶多这次没排除干净，不会崩）。"""
    try:
        lines = list(_DEFAULT_EXCLUDES)
        user_gi = work_tree / ".gitignore"
        if user_gi.is_file():
            try:
                lines.extend(user_gi.read_text(encoding="utf-8", errors="replace").splitlines())
            except Exception:
                pass
        info_dir = shadow_dir / "info"
        info_dir.mkdir(parents=True, exist_ok=True)
        (info_dir / "exclude").write_text("\n".join(lines) + "\n", encoding="utf-8")
    except Exception:
        logger.debug("影子库排除规则同步失败（忽略）", exc_info=True)


def init_shadow_repo(ctx) -> Path | None:
    """确保 ctx.working_dir 对应的影子库已初始化（幂等，已存在直接复用）。
    返回影子库（GIT_DIR）路径；没有可用 git / 没设工作目录 / 工作目录是危险根 → None
    （上层据此判定"这次没法用影子 git，落单文件备份兜底"，不是错误）。"""
    git = git_binary_path()
    if not git:
        return None
    wd = _clean_working_dir(ctx)
    if wd is None or _is_dangerous_workspace_root(wd):
        return None
    shadow_dir = _shadow_repo_dir(wd)
    if not (shadow_dir / "HEAD").exists():
        try:
            shadow_dir.mkdir(parents=True, exist_ok=True)
            wd.mkdir(parents=True, exist_ok=True)  # 工作目录本身也可能还没真的建出来
            _write_shadow_gitconfig(shadow_dir)  # 先写专属身份配置，GIT_CONFIG_GLOBAL 才有东西可指
            env = _clean_env_base(shadow_dir)
            r = subprocess.run([git, "init", "--bare", "-q", str(shadow_dir)],
                                env=env, capture_output=True, text=True, timeout=10)
            if r.returncode != 0:
                logger.warning("影子库 init 失败: %s", (r.stderr or "")[:300])
                return None
        except Exception:
            logger.warning("影子库初始化异常", exc_info=True)
            return None
    else:
        _write_shadow_gitconfig(shadow_dir)  # 幂等重写：保证不会因为文件意外丢失而"露"回用户全局配置
    _sync_excludes(shadow_dir, wd)
    return shadow_dir


def commit_checkpoint(ctx, label: str) -> str | None:
    """给当前工作目录打一个影子 git 检查点（commit）。返回新提交的 sha；以下情况返回 None
    （都不是异常，是正常的"这次没打上检查点"结果，调用方——PostToolUse hook——本就不强制要求
    每次都成功）：
    - 没有可用 git / 工作目录不合法或太危险；
    - git 操作本身失败（磁盘满、权限异常等，已记日志）；
    - **空改动**（`git status --porcelain` 干净）——没什么可存的，不留无意义的空提交刷屏历史。

    故障安全：整个函数不抛异常（外层 hook 本身也会吞异常，这里是双保险，方便直接单测/复用）。"""
    try:
        shadow_dir = init_shadow_repo(ctx)
        if shadow_dir is None:
            return None
        git = git_binary_path()
        wd = _clean_working_dir(ctx)
        if git is None or wd is None:
            return None
        _sync_excludes(shadow_dir, wd)
        add_r = _run_git(git, ["add", "-A"], shadow_dir, wd)
        if add_r.returncode != 0:
            logger.warning("影子库 add 失败: %s", (add_r.stderr or "")[:300])
            return None
        status_r = _run_git(git, ["status", "--porcelain"], shadow_dir, wd)
        if status_r.returncode != 0:
            logger.warning("影子库 status 失败: %s", (status_r.stderr or "")[:300])
            return None
        if not (status_r.stdout or "").strip():
            return None  # 空改动，不提交
        msg = f"{label} · {business_now().isoformat()}"
        commit_r = _run_git(git, ["commit", "-q", "--no-verify", "-m", msg], shadow_dir, wd)
        if commit_r.returncode != 0:
            logger.warning("影子库 commit 失败: %s", (commit_r.stderr or "")[:300])
            return None
        rev_r = _run_git(git, ["rev-parse", "HEAD"], shadow_dir, wd)
        if rev_r.returncode != 0:
            return None
        sha = (rev_r.stdout or "").strip()
        return sha or None
    except Exception:
        logger.warning("影子库 checkpoint 失败（已忽略，不影响主流程）", exc_info=True)
        return None


def restore_files(ctx, sha: str) -> dict:
    """把工作目录的文件内容恢复到某个检查点。**近破坏性操作，按以下规则求稳**：

    1. 恢复前先打一个"恢复前自动检查点"（可能因为无改动而返回 None，那也没关系——说明
       当前状态本来就跟上一个检查点一致，没有会丢失的东西）——防用户回滚后又后悔，回不去。
    2. **只覆盖/找回目标提交里存在的文件，绝不删除任何文件**——用 `git read-tree <sha>` 把索引
       整体换成目标提交的树，再 `git checkout-index -a -f` 把索引里的内容写盘（force 覆盖）。
       `checkout-index` 只【写】文件，从不删除磁盘上任何东西：
       - 目标提交里"存在"的文件 → 内容被覆盖/找回成那时的样子（含之后被工具删掉的文件，会被找回）；
       - 目标提交之后才新增的（被跟踪的）文件 → 不会被删除，只是索引不再记录它，物理文件原样留着；
       - 用户手动扔进文件夹、从没被任何工具碰过的"真·未跟踪"文件 → 完全不受影响。
       这比 Gemini CLI 自己 `restore + git clean -f -d` 的做法更保守——那样会真的删掉目标点之后
       新增的未跟踪文件，对"用户的文档文件夹"这个场景风险太高，本产品明确选择更保守的一侧。

    返回 `{"ok": bool, "sha", "pre_restore_checkpoint", "error"?}`。"""
    git = git_binary_path()
    if not git:
        return {"ok": False, "error": "本机没有可用的 git，恢复功能暂时用不了（单文件备份仍可用）"}
    wd = _clean_working_dir(ctx)
    if wd is None:
        return {"ok": False, "error": "没有工作目录，没法恢复"}
    if _is_dangerous_workspace_root(wd):
        return {"ok": False, "error": "这个目录范围太大（家目录/桌面等），不支持整目录回滚"}
    sha = (sha or "").strip()
    if not sha or not _SHA_RE.match(sha):
        return {"ok": False, "error": "检查点编号不对"}
    shadow_dir = _shadow_repo_dir(wd)
    if not (shadow_dir / "HEAD").exists():
        return {"ok": False, "error": "这个工作目录还没有任何检查点记录"}
    verify = _run_git(git, ["cat-file", "-e", sha], shadow_dir, wd)
    if verify.returncode != 0:
        return {"ok": False, "error": "找不到这个检查点"}

    pre_sha = commit_checkpoint(ctx, label="恢复前自动检查点")  # 留后悔药；可能是 None（本就没差异）

    try:
        rt = _run_git(git, ["read-tree", sha], shadow_dir, wd)
        if rt.returncode != 0:
            logger.warning("影子库恢复失败(read-tree): %s", (rt.stderr or "")[:300])
            return {"ok": False, "error": "恢复失败", "pre_restore_checkpoint": pre_sha}
        co = _run_git(git, ["checkout-index", "-a", "-f"], shadow_dir, wd)
        if co.returncode != 0:
            logger.warning("影子库恢复失败(checkout-index): %s", (co.stderr or "")[:300])
            return {"ok": False, "error": "恢复失败", "pre_restore_checkpoint": pre_sha}
    except Exception:
        logger.warning("影子库恢复异常", exc_info=True)
        return {"ok": False, "error": "恢复过程出错", "pre_restore_checkpoint": pre_sha}
    return {"ok": True, "sha": sha, "pre_restore_checkpoint": pre_sha}
