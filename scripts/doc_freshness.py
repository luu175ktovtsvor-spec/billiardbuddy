#!/usr/bin/env python3
"""文档新鲜度扫描 · 给每个新开的 Claude Code 窗口提醒"哪些文档该清/该核对"。

由 .claude/settings.json 的 SessionStart 钩子在【每个会话开始时】自动跑,stdout 注入上下文——
这样每个新窗口一开机就被动看到该处理的过时文档,不靠人自觉。清爽时静默、不打扰。
手动也行:python3 scripts/doc_freshness.py。深度体检(交叉验代码是否落地)走 `/文档体检` skill。

只看【入 git 的文档】——`.gitignore` 的本地工作档(如含敏感运营细节、不入库的"待改清单")不纳入,
免得它合法的"历史/本地档"措辞被误判成"该清"而每次开机瞎唠叨。

约定(见 CLAUDE.md「文档维护规约」):每份文档顶部一行状态 banner,如
    > 📌 状态:✅现行 · 最后核对 2026-06-26
    > 📌 状态:📦历史 · 工作已落地(提交 abc1234)· 可删
    > 📌 状态:❌已否决 · 仅参考
分类靠 banner 关键词:可删/历史/已落地/已否决/废弃/📦/❌ → "该清";现行+最后核对日期 → 超期提醒。

`docs/归档/` 是历史存档区(完工文档的最终归宿)——扫描时整目录跳过,不再被唠叨"该清"。
但如果一份"已完成/已否决"的文档还留在归档区**之外**(现行区),提醒"该挪进 docs/归档/"
(落实 CLAUDE.md 文档维护规约第 3 条「完工即处置」)。目录不存在时正常跳过、不报错。
"""
import re
import subprocess
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC_DIRS = [ROOT / "docs", ROOT / "交接-给新会话"]
ARCHIVE_DIR = ROOT / "docs" / "归档"
STALE_DAYS = 45  # 现行文档超这么多天没核对 → 提醒顺手核对

BANNER_RE = re.compile(r"📌\s*(?:文档)?状态")
DATE_RE = re.compile(r"最后核对\s*(\d{4})-(\d{1,2})-(\d{1,2})")
REMOVABLE = ("可删", "历史", "已落地", "已否决", "废弃", "弃用", "📦", "❌")


def _is_archived(f: Path) -> bool:
    """文档是否已在 docs/归档/ 下(该目录不存在时一律 False,不报错)。"""
    if not ARCHIVE_DIR.exists():
        return False
    try:
        f.relative_to(ARCHIVE_DIR)
        return True
    except ValueError:
        return False


def _ignored(paths):
    """这些路径里被 .gitignore 忽略的集合(本地工作档不入 git、不纳入唠叨)。git 不可用则返回空集。"""
    if not paths:
        return set()
    try:
        # core.quotePath=false:别把中文路径转义输出,否则下面 str(f) 匹配不上
        r = subprocess.run(["git", "-C", str(ROOT), "-c", "core.quotePath=false",
                            "check-ignore"] + [str(p) for p in paths],
                           capture_output=True, text=True, timeout=5)
        return set(r.stdout.splitlines())  # check-ignore 原样回显被忽略的路径
    except Exception:
        return set()


def scan():
    removable, stale = [], []
    today = date.today()
    files = [f for d in DOC_DIRS if d.exists() for f in sorted(d.rglob("*.md"))]
    ignored = _ignored(files)
    for f in files:
        if _is_archived(f):
            continue  # docs/归档/ 是历史存档区,已经"处置"过了,不再唠叨
        if str(f) in ignored:
            continue  # gitignore 的本地工作档不纳入
        rel = f.relative_to(ROOT)
        try:
            head = f.read_text(encoding="utf-8", errors="ignore").splitlines()[:8]
        except Exception:
            continue
        banner = next((ln for ln in head if BANNER_RE.search(ln)), None)
        if banner is None:
            continue  # 没 banner 不在自动唠叨里(交给 /文档体检 深扫),避免噪音
        if any(k in banner for k in REMOVABLE):
            removable.append(str(rel))
            continue
        m = DATE_RE.search(banner)
        if m:
            y, mo, dy = map(int, m.groups())
            try:
                age = (today - date(y, mo, dy)).days
                if age > STALE_DAYS:
                    stale.append(f"{rel}(核对于 {y}-{mo:02d}-{dy:02d},{age} 天前)")
            except ValueError:
                pass
    return removable, stale


def main():
    removable, stale = scan()
    if not (removable or stale):
        return  # 清爽 → 静默,不打扰
    print("📚 文档维护提醒(本项目规约见 CLAUDE.md「文档维护规约」):")
    if removable:
        print(f"🧹 这 {len(removable)} 份标了【可删/历史/已否决】却还留在现行区——建议挪进 docs/归档/(git mv,只搬不删、历史可查;"
              f"也可用 /整理归档 一键处理):")
        for x in removable:
            print(f"   · {x}")
    if stale:
        print(f"🕰 这 {len(stale)} 份现行文档久未核对——顺手核对并把顶部「最后核对」日期更新到今天:")
        for x in stale:
            print(f"   · {x}")
    print("拿不准哪些过时?跑 /文档体检 深扫(交叉验代码工作是否真落地)。")


if __name__ == "__main__":
    main()
