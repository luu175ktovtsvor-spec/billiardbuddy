"""本地文件操作工具（桌面全本地版专属，DESKTOP_LOCAL=1 才注册）。

把"像 Claude Code 那样在本机读/写/改文件"的通用能力给 Agent——但配台球老板用得起的护栏：
- **范围锁**：只动「内容库」(用户数据目录下一个文件夹) + 库内文件。绝不漫游全盘、不碰系统文件。
- **改前备份**：写/改前自动把原件复制到 .backups/，可回滚。
- **审批闸**：write/edit 类 requires_approval=True，循环里不直接执行——先把"要怎么改"弹给老板(人看得懂的改动)，确认后才落盘。
- **不暴露裸 shell**：只给文件操作（改动是人能审的 diff），命令类另包成具体安全动作。

⚠️ 云端 web 版（PostgreSQL，多租户）绝不注册这些——文件操作只在用户自己机器上的本地后端有意义。
"""
import logging
import os
import shutil
from datetime import datetime
from pathlib import Path

from core.timezone import business_now
from services.agent.registry import Tool, default_registry

logger = logging.getLogger(__name__)


def _library_root() -> Path:
    """内容库根：Agent 只能在这里面(+库内)动手。默认在用户数据目录下。"""
    root = Path(os.environ.get("DESKTOP_LIBRARY_DIR") or (Path.home() / ".billiards-desktop" / "library"))
    root.mkdir(parents=True, exist_ok=True)
    return root


def _allowed_paths(ctx) -> list[Path]:
    """用户当场选定、显式授权的文件/目录（来自 OS 文件选择器）。解析为绝对 Path。"""
    raw = getattr(ctx, "allowed_paths", None) or []
    out: list[Path] = []
    for s in raw:
        try:
            out.append(Path(s).resolve())
        except (OSError, ValueError):
            continue
    return out


def _resolve(rel_or_abs: str, ctx=None) -> Path:
    """把传入路径解析进沙箱并校验不越界。沙箱 = 内容库 + 用户当场选定的文件/目录。
    返回绝对 Path；越界抛 ValueError。相对路径一律落到内容库内。
    ctx.full_disk_access=True 时不限范围（高级·全盘模式，老板显式开启）。"""
    root = _library_root().resolve()
    p = Path(rel_or_abs)
    path = (p if p.is_absolute() else root / p).resolve()
    # 高级·全盘模式：老板显式开启 → 不限范围（可碰任意路径）
    if getattr(ctx, "full_disk_access", False):
        return path
    # ① 内容库内 → 放行
    if path == root or root in path.parents:
        return path
    # ② 用户经文件选择器当场选定的文件/目录（或其子文件）→ 放行（显式授权）
    for a in _allowed_paths(ctx):
        if path == a or a in path.parents:
            return path
    raise ValueError(f"越界：只能操作内容库或你当场选定的文件，拒绝 {rel_or_abs}")


def _backup(path: Path) -> str | None:
    """改/写前备份原件，返回备份路径（原件不存在则 None）。"""
    if not path.exists():
        return None
    bdir = _library_root() / ".backups"
    bdir.mkdir(exist_ok=True)
    stamp = business_now().strftime("%Y%m%d-%H%M%S")
    dest = bdir / f"{path.stem}.{stamp}{path.suffix}.bak"
    shutil.copy2(path, dest)
    return str(dest)


# ────────────────────────────── 只读工具（无需审批） ──────────────────────────────

async def list_files(args: dict, ctx) -> str:
    """列内容库里的文件（生成过的文案/报表/海报/视频等）。"""
    root = _library_root()
    items = []
    for p in sorted(root.rglob("*")):
        if p.is_file() and ".backups" not in p.parts:
            items.append(f"- {p.relative_to(root)}  ({p.stat().st_size} 字节)")
    return "内容库文件：\n" + ("\n".join(items) if items else "（空）")


async def read_file(args: dict, ctx) -> str:
    """读一个文件的内容，给 Agent 看（编辑前先读）。文本直接读；Excel 列出非空单元格。"""
    path = _resolve(args["path"], ctx)
    if not path.exists():
        return f"文件不存在：{args['path']}"
    if path.suffix.lower() in (".xlsx", ".xlsm"):
        from openpyxl import load_workbook
        wb = load_workbook(path, data_only=True)
        lines = []
        for ws in wb.worksheets:
            lines.append(f"# 工作表「{ws.title}」")
            for row in ws.iter_rows():
                for cell in row:
                    if cell.value is not None:
                        lines.append(f"{cell.coordinate}={cell.value!r}")
        return "\n".join(lines) if lines else "（空表）"
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return f"（二进制文件，{path.stat().st_size} 字节，不便直接读取）"


# ────────────────────────────── 写/改工具（走审批闸） ──────────────────────────────

async def write_file(args: dict, ctx) -> str:
    """把内容写到内容库里的一个文件（新建或覆盖）。args: path, content。覆盖前自动备份。"""
    path = _resolve(args["path"], ctx)
    path.parent.mkdir(parents=True, exist_ok=True)
    backup = _backup(path)
    path.write_text(args["content"], encoding="utf-8")
    msg = f"已写入 {path.name}（{len(args['content'])} 字）。"
    if backup:
        msg += f" 原件已备份。"
    return msg


async def edit_file(args: dict, ctx) -> str:
    """改文本文件的某一段：把 old_text 精确替换成 new_text（同我改代码的方式）。改前备份。
    args: path, old_text, new_text。"""
    path = _resolve(args["path"], ctx)
    if not path.exists():
        return f"文件不存在：{args['path']}"
    text = path.read_text(encoding="utf-8")
    old, new = args["old_text"], args["new_text"]
    n = text.count(old)
    if n == 0:
        return f"没找到要替换的内容，未改动。"
    if n > 1:
        return f"要替换的内容出现 {n} 次（不唯一），为安全未改动；请给更具体的上下文。"
    backup = _backup(path)
    path.write_text(text.replace(old, new), encoding="utf-8")
    return f"已修改 {path.name}：\n- 原：{old[:80]}\n+ 新：{new[:80]}\n（原件已备份，可回滚）"


async def edit_excel(args: dict, ctx) -> str:
    """直接改 Excel 报表的单元格（改营业额、加一列提成等）。改前备份、改后回传逐格 diff。
    args: path, changes=[{cell:'B2', value:8600}, ...]（cell 用 A1 式坐标；多表加 sheet）。"""
    from openpyxl import load_workbook
    path = _resolve(args["path"], ctx)
    if not path.exists():
        return f"报表不存在：{args['path']}"
    backup = _backup(path)
    wb = load_workbook(path)
    diffs = []
    for ch in args.get("changes", []):
        ws = wb[ch["sheet"]] if ch.get("sheet") else wb.active
        cell = ch["cell"]
        old = ws[cell].value
        ws[cell] = ch["value"]
        diffs.append(f"{ws.title}!{cell}: {old!r} → {ch['value']!r}")
    wb.save(path)
    return f"已改 {path.name}：\n" + "\n".join(diffs) + f"\n（原件已备份，可回滚）"


# ────────────────────────────── 召回：翻老板本机攒下的历史内容（真 RAG·语义检索） ──────────────────────────────

async def recall_my_content(args, ctx) -> str:
    """语义检索老板过去生成的内容（"找我上次那条…""跟之前类似的"）。先惰性补建索引再搜。"""
    store = getattr(ctx, "store", None)
    if store is None or getattr(store, "id", None) is None:
        return "（拿不到当前门店，没法翻历史。）"
    from services.rag.recall import backfill_from_generations, recall
    await backfill_from_generations(ctx.db, store.id)
    hits = recall(str(store.id), args.get("query", "") or "", top=5)
    if not hits:
        return "没在你过去的内容里找到相关的。要不直接说需求，我现写一条。"
    lines = []
    for h in hits:
        snippet = " ".join((h["text"] or "").split())[:200]
        lines.append(f"- {snippet}")
    return "翻到这些你以前写过的相关内容（可参考/在此基础上改）：\n" + "\n".join(lines)


# ────────────────────────────── POS 真诊断：读老板导出的报表 → 基于真实数字诊断 ──────────────────────────────

async def diagnose_from_pos(args: dict, ctx) -> str:
    """读老板从收银系统导出的报表(Excel)，喂进经营诊断引擎(决策树+指标库)，给【有数有据】的诊断——
    不再凭老板一句口述泛泛而谈。桌面独有：报表在老板自己电脑上，要他先选定文件。"""
    file = (args.get("file") or "").strip()
    if not file:
        return "请先用文件选择器选一下你从收银系统导出的报表（.xlsx），我照着真实数据帮你看。"
    path = _resolve(file, ctx)
    if not path.exists():
        return f"没找到这个文件：{file}。麻烦用文件选择器重新选一下导出的报表。"
    # 复用 read_file 的读法（Excel 列出非空单元格）拿到真实数字
    data_text = await read_file({"path": file}, ctx)
    situation = (
        "以下是这家店从收银系统导出的【真实经营数据】。请**基于这些具体数字**诊断："
        "引用关键数字、算出关键比率(如台费占比/空台时段)、指出异常项，再给可落地建议，别泛泛而谈：\n"
        f"{data_text}"
    )
    focus = (args.get("focus") or "").strip()
    if focus:
        situation += f"\n\n老板想重点看：{focus}"
    from services.diagnosis_service import analyze_diagnosis  # 懒导入，避免顶层耦合
    gen = await analyze_diagnosis(
        ctx.db, ctx.store, getattr(ctx, "user", None),
        problem_area=(args.get("problem_area") or "revenue"),
        current_situation=situation,
    )
    return gen.result


# ────────────────────────────── 审批预览（确认前给老板看"会改成什么"，不再瞎确认） ──────────────────────────────

def _name_of(args: dict) -> str:
    return Path(args.get("path", "?") or "?").name


def preview_edit_excel(args: dict, ctx) -> str:
    """改 Excel 前的人话 diff：逐格 旧值→新值（读现值算）。读不到就只列要写的新值，绝不抛错。"""
    changes = args.get("changes", []) or []
    lines = [f"改报表《{_name_of(args)}》，共 {len(changes)} 处："]
    wb = None
    try:
        from openpyxl import load_workbook
        path = _resolve(args["path"], ctx)
        if path.exists():
            wb = load_workbook(path, data_only=True)
    except Exception:
        wb = None
    for ch in changes:
        cell, sheet = ch.get("cell", "?"), ch.get("sheet")
        old = "?"
        try:
            if wb is not None:
                ws = wb[sheet] if sheet else wb.active
                old = ws[cell].value
        except Exception:
            old = "?"
        loc = f"{sheet}!{cell}" if sheet else cell
        lines.append(f"  {loc}：{old!r} → {ch.get('value')!r}")
    return "\n".join(lines)


def preview_edit_file(args: dict, ctx) -> str:
    old = (args.get("old_text") or "")[:140]
    new = (args.get("new_text") or "")[:140]
    return f"改文件《{_name_of(args)}》：\n- 原：{old}\n+ 改：{new}"


def preview_write_file(args: dict, ctx) -> str:
    content = args.get("content") or ""
    exists = False
    try:
        exists = _resolve(args["path"], ctx).exists()
    except Exception:
        exists = False
    snippet = content[:200] + ("…" if len(content) > 200 else "")
    return f"{'覆盖' if exists else '新建'}文件《{_name_of(args)}》（{len(content)} 字）：\n{snippet}"


# ────────────────────────────── 工具定义（人看得懂的描述，大脑据此选） ──────────────────────────────

_LOCAL_TOOLS = [
    Tool(
        name="recall_my_content",
        description="检索老板【以前生成过】的内容（按意思找，不是按关键词）。当老板说"
                    "『找我上次那条…』『跟之前类似的』『把以前效果好的那条改改』『我之前写过的XX』时调用——"
                    "先翻历史找出相关的几条，再据此改写/参考，比从零写更贴老板的风格。",
        parameters={"type": "object", "properties": {
            "query": {"type": "string", "description": "要找的内容/主题，原话即可，如'双十一活动朋友圈'"},
        }, "required": ["query"]},
        handler=recall_my_content,
    ),
    Tool(
        name="diagnose_from_pos",
        description="读老板从【收银系统导出的报表 Excel】(营业额/台时/各项收入/上钟等)，基于真实数字做经营诊断。"
                    "当老板说『我导出了数据你帮我看看 / 看看这个月经营 / 分析下这张报表 / 照着我的真实数据诊断』"
                    "并且选定了一个报表文件时调用——比凭口述诊断准得多、会引用具体数字。",
        parameters={"type": "object", "properties": {
            "file": {"type": "string", "description": "老板选定的 POS 导出报表文件路径(.xlsx)"},
            "focus": {"type": "string", "description": "想重点看什么(可选)，如'为什么周二下午营收低'"},
            "problem_area": {"type": "string", "description": "问题领域(可选)：revenue/traffic/customer_loss/staff/competition/off_season"},
        }, "required": ["file"]},
        handler=diagnose_from_pos,
    ),
    Tool(
        name="list_files",
        description="列出本机「内容库」里已有的文件（之前生成的文案/报表/海报/视频等）。要找/改某个文件前先用它看看有啥。",
        parameters={"type": "object", "properties": {}},
        handler=list_files,
    ),
    Tool(
        name="read_file",
        description="读取内容库里某个文件的内容（编辑前必须先读，才知道里面是什么）。Excel 会列出各单元格。",
        parameters={"type": "object", "properties": {"path": {"type": "string", "description": "内容库内的文件名/相对路径，或老板当场选定文件的完整路径"}}, "required": ["path"]},
        handler=read_file,
    ),
    Tool(
        name="write_file",
        description="把内容写进本机内容库的一个文件（新建或覆盖，如保存一份文案/清单）。覆盖会先自动备份原件。",
        parameters={"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]},
        handler=write_file,
        requires_approval=True,
        approval_class="file",
        preview=preview_write_file,
    ),
    Tool(
        name="edit_file",
        description="修改一个文本文件的某一段：把指定原文精确替换成新文本。改前自动备份、可回滚。",
        parameters={"type": "object", "properties": {"path": {"type": "string"}, "old_text": {"type": "string"}, "new_text": {"type": "string"}}, "required": ["path", "old_text", "new_text"]},
        handler=edit_file,
        requires_approval=True,
        approval_class="file",
        preview=preview_edit_file,
    ),
    Tool(
        name="edit_excel",
        description="直接修改本机的 Excel 报表（改营业额、改某个数、加一列提成等）。先 read_file 看清单元格坐标，再给要改的单元格。改前自动备份、改后回传每格的前后对比。",
        parameters={"type": "object", "properties": {
            "path": {"type": "string"},
            "changes": {"type": "array", "items": {"type": "object", "properties": {
                "sheet": {"type": "string", "description": "工作表名，留空=第一个表"},
                "cell": {"type": "string", "description": "A1 式坐标，如 B2"},
                "value": {"description": "新值"},
            }, "required": ["cell", "value"]}},
        }, "required": ["path", "changes"]},
        handler=edit_excel,
        requires_approval=True,
        approval_class="file",
        preview=preview_edit_excel,
    ),
]


def register_local_tools(registry=None) -> int:
    """把本地文件工具注册进注册表。仅桌面本地模式调用。返回注册数。"""
    reg = registry or default_registry
    for t in _LOCAL_TOOLS:
        if reg.get(t.name) is None:
            reg.register(t)
    return len(_LOCAL_TOOLS)


# 仅桌面全本地模式自动注册（云端 web 版不设 DESKTOP_LOCAL → 拿不到文件操作工具）
if os.environ.get("DESKTOP_LOCAL") == "1":
    register_local_tools()
    logger.info("已注册 %d 个本地文件操作工具（桌面全本地模式）", len(_LOCAL_TOOLS))
