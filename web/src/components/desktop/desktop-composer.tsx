"use client";

/**
 * Codex 风底部输入区（浅色默认 · 跟随系统深浅色）：附件 + 前导提示符 › + 输入框 + 运行权限菜单 + 发送。
 * - 附件：选定本机文件 → selected_files 授权 Agent 读/改（沙箱），像 Claude Code/Codex 那样改本地文件。
 * - 运行权限：后端那套 ask / auto_files / full，收进克制的弹出菜单。完全磁盘访问并入同一菜单。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Paperclip, ArrowUp, ChevronDown, ShieldCheck, Check, X, FileText, BookOpen, Palette, Brain } from "lucide-react";
import { PERMISSION_MODES, WELCOME } from "@/lib/agent-copy";
import { api, type SkillMeta, type OutputStyleMeta } from "@/lib/api";
import { SlashPalette, type PaletteItem } from "./slash-palette";

export type PermissionMode = "ask" | "auto_files" | "full" | "plan";

// 内置 `/` 命令（cc-haha 风，先放能即时接上的；其余随命令系统扩展）。
// G.3：每条带中文名(cn,做主视觉) + 中文/拼音别名(aliases,让 /导出 /用量 也能搜到)。
const BUILTIN_COMMANDS: { name: string; cn: string; description: string; aliases?: string[] }[] = [
  { name: "new", cn: "新会话", description: "开个新会话", aliases: ["新对话", "xinhuihua", "xin"] },
  { name: "clear", cn: "清空会话", description: "清空当前会话", aliases: ["清空", "qingkong"] },
  { name: "model", cn: "模型设置", description: "配置 AI 模型 / Key", aliases: ["模型", "moxing", "key"] },
  { name: "settings", cn: "设置", description: "打开设置", aliases: ["shezhi"] },
  { name: "goal", cn: "设目标", description: "设定目标，让我对照它自检直到完成", aliases: ["目标", "mubiao"] },
  { name: "cost", cn: "用量", description: "本月 AI 用量", aliases: ["花费", "账单", "yongliang", "huafei"] },
  { name: "agents", cn: "子代理", description: "可用的子代理专家", aliases: ["代理", "daili"] },
  { name: "mcp", cn: "外接工具", description: "MCP 外部工具服务器状态", aliases: ["waijiegongju"] },
  { name: "skills", cn: "技能", description: "已安装的技能", aliases: ["jineng"] },
  { name: "plugins", cn: "插件", description: "已安装的插件", aliases: ["chajian"] },
  { name: "context", cn: "会话信息", description: "当前会话信息", aliases: ["上下文", "huihuaxinxi"] },
  { name: "export", cn: "导出对话", description: "导出当前对话为 Markdown", aliases: ["导出", "保存对话", "daochu"] },
  { name: "help", cn: "帮助", description: "查看命令与能力", aliases: ["能干嘛", "bangzhu"] },
];

// 可 @ 挂载的知识库：挂上 = 该领域专家，不挂 = 通用 Agent。目前一个，后续可扩展为多个领域包。
const KNOWLEDGE_SOURCES: { id: string; label: string; desc: string }[] = [
  { id: "billiards", label: "台球运营知识库", desc: "开启后，AI 按台球行业的专业运营知识来答" },
];

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// 贴图用：把图片 Blob 读成纯 base64（去掉 data:...;base64, 前缀）。
function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result || ""); resolve(s.includes(",") ? s.split(",")[1] : s); };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export function DesktopComposer({
  value,
  onChange,
  onSend,
  permissionMode = "ask",
  onPermissionChange,
  selectedFiles = [],
  onPickFiles,
  onAddFiles,
  onRemoveFile,
  onOpenFile,
  knowledgePacks = [],
  onKnowledgePacksChange,
  outputStyle = "",
  onOutputStyleChange,
  deepThinking = true,
  onDeepThinkingChange,
  onCommand,
  disabled,
  placeholder = WELCOME.placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  permissionMode?: PermissionMode;
  onPermissionChange?: (m: PermissionMode) => void;
  selectedFiles?: string[];
  onPickFiles?: () => void;
  onAddFiles?: (paths: string[]) => void; // 贴图/拖图：把图片落成路径后加进附件（授权 AI 看）
  onRemoveFile?: (path: string) => void;
  /** 点开附件：报表(.xlsx/.xlsm) 在右侧用表格视图打开（可点格改）。 */
  onOpenFile?: (path: string) => void;
  knowledgePacks?: string[];
  onKnowledgePacksChange?: (packs: string[]) => void;
  outputStyle?: string;
  onOutputStyleChange?: (name: string) => void;
  deepThinking?: boolean; // F.2 深度思考开关（默认开）
  onDeepThinkingChange?: (v: boolean) => void;
  onCommand?: (name: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [composing, setComposing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [kbMenuOpen, setKbMenuOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const current = PERMISSION_MODES.find((m) => m.value === permissionMode) ?? PERMISSION_MODES[0];
  const activePacks = knowledgePacks ?? [];
  const activeLabel = KNOWLEDGE_SOURCES.find((k) => k.id === activePacks[0])?.label;

  // `/` 命令面板：已安装技能(拉一次) + 内置命令；输入以 / 开头且未输入空格时浮出。
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  // 输出风格：拉一次可选风格，工具条一个下拉切换。
  const [styles, setStyles] = useState<OutputStyleMeta[]>([]);
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.listSkills().then((r) => { if (!cancelled) setSkills(r.skills || []); }).catch(() => {});
    api.listOutputStyles().then((r) => { if (!cancelled) setStyles(r.output_styles || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const styleOptions = [{ name: "", description: "默认（大白话）" }, ...styles.map((s) => ({ name: s.name, description: s.description }))];
  const activeStyleName = styles.find((s) => s.name === outputStyle)?.name;

  const slashQuery = value.startsWith("/") && !value.slice(1).includes(" ") ? value.slice(1).toLowerCase() : null;
  const paletteItems: PaletteItem[] = slashQuery !== null ? [
    ...BUILTIN_COMMANDS
      // G.3：英文名 / 中文名 / 描述 / 中文拼音别名 任一命中即列出（打 /导出 /用量 也搜得到）
      .filter((c) => c.name.toLowerCase().includes(slashQuery)
        || c.cn.includes(slashQuery)
        || c.description.includes(slashQuery)
        || (c.aliases || []).some((a) => a.toLowerCase().includes(slashQuery)))
      .map((c): PaletteItem => ({ kind: "builtin", name: c.name, cn: c.cn, description: c.description })),
    ...skills
      .filter((s) => s.user_invocable && (s.name.toLowerCase().includes(slashQuery) || (s.description || "").toLowerCase().includes(slashQuery)))
      .map((s): PaletteItem => ({ kind: "skill", name: s.name, description: s.description, argHint: s.argument_hint })),
  ] : [];
  const paletteOpen = slashQuery !== null && !paletteDismissed && paletteItems.length > 0;
  useEffect(() => { setPaletteIndex(0); }, [slashQuery]);

  const handleChange = (v: string) => { if (paletteDismissed) setPaletteDismissed(false); onChange(v); };
  const selectPaletteItem = (it: PaletteItem) => {
    if (it.kind === "builtin") {
      // /goal 要带参数 → 像技能一样填入 `/goal `，让用户接着打条件（onSend 里处理）。
      if (it.name === "goal") {
        onChange("/goal ");
        requestAnimationFrame(() => taRef.current?.focus());
        setPaletteDismissed(true);
        return;
      }
      onCommand?.(it.name);
      onChange("");
    } else {
      onChange(`/${it.name} `);
      requestAnimationFrame(() => taRef.current?.focus());
    }
    setPaletteDismissed(true);
  };

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }, [value]);

  useEffect(() => {
    if (!menuOpen && !kbMenuOpen && !styleMenuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenuOpen(false); setKbMenuOpen(false); setStyleMenuOpen(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen, kbMenuOpen, styleMenuOpen]);

  // 粘贴文件：① 访达复制的文件有真实路径 → 直接拿（与拖拽同路）；② 只有字节没路径的（截图工具图片）→ saveTemp 落临时文件。
  const handlePaste = async (e: React.ClipboardEvent) => {
    if (!onAddFiles) return;
    const items = Array.from(e.clipboardData?.items || []);
    const fileItems = items.filter((it) => it.kind === "file");
    if (fileItems.length === 0) return;
    // ① 有真实路径的文件(从访达复制任意文件)→ 直接拿 path(走与拖拽同一条路)
    const direct: string[] = [];
    const needTemp: File[] = [];
    for (const it of fileItems) {
      const f = it.getAsFile() as (File & { path?: string }) | null;
      if (!f) continue;
      if (f.path) direct.push(f.path);
      else needTemp.push(f);
    }
    // ② 只有字节没路径的(截图工具图片等)→ saveTemp 落临时文件
    const saved: string[] = [];
    if (needTemp.length && window.electron?.files?.saveTemp) {
      for (const f of needTemp) {
        if (!f.type.startsWith("image/")) continue;  // 无路径的非图字节跳过(没法可靠保存)
        const b64 = await fileToBase64(f);
        const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
        const r = await window.electron.files.saveTemp({ base64: b64, ext });
        if (r?.ok && r.path) saved.push(r.path);
      }
    }
    const paths = [...direct, ...saved];
    if (paths.length) { e.preventDefault(); onAddFiles(paths); }
  };
  // 拖入：从访达拖图片/文件进来 → Electron 的 File 带绝对路径 → 直接加进附件。
  const handleDrop = (e: React.DragEvent) => {
    if (!onAddFiles) return;
    const files = Array.from(e.dataTransfer?.files || []) as (File & { path?: string })[];
    const paths = files.map((f) => f.path).filter((p): p is string => !!p);
    if (paths.length) { e.preventDefault(); onAddFiles(paths); }
  };

  return (
    <div className="px-4 pb-4 pt-1">
      <div className="mx-auto max-w-[820px]">
        <div
          onDrop={handleDrop}
          onDragOver={(e) => { if (onAddFiles) e.preventDefault(); }}
          className="rounded-xl border border-black/[0.1] bg-white shadow-sm transition-colors focus-within:border-[#10a37f]/45 dark:border-white/[0.09] dark:bg-[#16181d] dark:shadow-[0_8px_28px_-16px_rgba(0,0,0,0.6)]">
          {/* 已选文件（附件） */}
          {selectedFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
              {selectedFiles.map((p) => {
                const openable = !!onOpenFile && /\.(xlsx|xlsm|pdf|docx|pptx|html|htm)$/i.test(p); // 报表/PDF/Word/PPT/网页可点开预览
                return (
                <span
                  key={p}
                  title={openable ? `${p}（点击在右侧预览）` : p}
                  className="inline-flex max-w-[220px] items-center gap-1.5 rounded-md bg-black/[0.05] py-1 pl-2 pr-1 font-mono text-[11.5px] text-[#3a3a3c] dark:bg-white/[0.05] dark:text-[#c8cace]"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
                  {openable ? (
                    <button
                      type="button"
                      onClick={() => onOpenFile?.(p)}
                      className="truncate text-[#10a37f] underline-offset-2 transition hover:underline"
                    >
                      {baseName(p)}
                    </button>
                  ) : (
                    <span className="truncate">{baseName(p)}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => onRemoveFile?.(p)}
                    aria-label={`移除 ${baseName(p)}`}
                    className="flex h-4 w-4 items-center justify-center rounded text-[#86868b] transition hover:bg-black/[0.08] hover:text-[#1d1d1f] dark:text-[#6e7077] dark:hover:bg-white/[0.08] dark:hover:text-[#e6e7e9]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
                );
              })}
            </div>
          )}

          {/* 输入行：前导提示符 + textarea（+ `/` 命令面板浮层） */}
          <div className="relative flex items-start gap-2 px-3.5 pt-3">
            {paletteOpen && (
              <SlashPalette
                items={paletteItems}
                activeIndex={paletteIndex}
                onSelect={selectPaletteItem}
                onHover={setPaletteIndex}
              />
            )}
            <span className="select-none pt-0.5 font-mono text-[14px] leading-relaxed text-[#10a37f]">›</span>
            <textarea
              ref={taRef}
              rows={1}
              value={value}
              onChange={(e) => handleChange(e.target.value)}
              onPaste={handlePaste}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              onKeyDown={(e) => {
                if (paletteOpen && !composing) {
                  if (e.key === "ArrowDown") { e.preventDefault(); setPaletteIndex((i) => (i + 1) % paletteItems.length); return; }
                  if (e.key === "ArrowUp") { e.preventDefault(); setPaletteIndex((i) => (i - 1 + paletteItems.length) % paletteItems.length); return; }
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); selectPaletteItem(paletteItems[paletteIndex]); return; }
                  if (e.key === "Tab") { e.preventDefault(); selectPaletteItem(paletteItems[paletteIndex]); return; }
                  if (e.key === "Escape") { e.preventDefault(); setPaletteDismissed(true); return; }
                }
                if (e.key === "Enter" && !e.shiftKey && !composing) {
                  e.preventDefault();
                  if (!disabled && value.trim()) onSend();
                }
              }}
              placeholder={placeholder}
              className="block max-h-[180px] flex-1 resize-none bg-transparent text-[14px] leading-relaxed text-[#1d1d1f] outline-none placeholder:text-[#b0b0b5] dark:text-[#e6e7e9] dark:placeholder:text-[#56585f]"
            />
          </div>

          {/* 工具条 */}
          <div className="flex items-center gap-0.5 px-2.5 pb-2 pt-1.5">
            <button
              type="button"
              onClick={onPickFiles}
              title="加文件 · 图片 · 视频 · 文件夹都行(授权助手读取或修改)"
              aria-label="添加文件、图片、视频或文件夹"
              className="flex h-7 w-7 items-center justify-center rounded-md text-[#86868b] transition hover:bg-black/[0.05] hover:text-[#1d1d1f] dark:text-[#6e7077] dark:hover:bg-white/[0.06] dark:hover:text-[#c8cace]"
            >
              <Paperclip className="h-[16px] w-[16px]" />
            </button>

            {/* F.2 深度思考 开/关：mimo 默认开，关掉更快更省思考 token。措辞大白话、不堆术语。 */}
            {onDeepThinkingChange && (
              <button
                type="button"
                onClick={() => onDeepThinkingChange(!deepThinking)}
                title={deepThinking ? "深度思考：开（更稳，慢一点）。点一下关掉" : "深度思考：关（更快）。点一下打开"}
                aria-pressed={deepThinking}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] transition ${
                  deepThinking
                    ? "bg-[#10a37f]/10 text-[#10a37f]"
                    : "text-[#86868b] hover:bg-black/[0.05] hover:text-[#1d1d1f] dark:text-[#6e7077] dark:hover:bg-white/[0.06]"
                }`}
              >
                <Brain className="h-3.5 w-3.5" />
                深度思考{deepThinking ? "" : " · 关"}
              </button>
            )}

            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-[#6e6e73] transition hover:bg-black/[0.05] hover:text-[#1d1d1f] dark:text-[#9a9ca3] dark:hover:bg-white/[0.06] dark:hover:text-[#c8cace]"
              >
                <ShieldCheck className="h-3.5 w-3.5 text-[#86868b] dark:text-[#6e7077]" />
                {current.label}
                <ChevronDown className={`h-3 w-3 text-[#b0b0b5] transition dark:text-[#56585f] ${menuOpen ? "rotate-180" : ""}`} />
              </button>

              {menuOpen && (
                <>
                  <button type="button" aria-hidden tabIndex={-1} onClick={() => setMenuOpen(false)} className="fixed inset-0 z-40 cursor-default" />
                  <div role="menu" className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-[306px] rounded-lg border border-black/[0.1] bg-white p-1.5 shadow-[0_12px_40px_-10px_rgba(0,0,0,0.25)] dark:border-white/[0.1] dark:bg-[#1c1e24] dark:shadow-[0_12px_40px_-10px_rgba(0,0,0,0.7)]">
                    <div className="px-2.5 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-[#a1a1a6] dark:text-[#6e7077]">运行权限</div>
                    {PERMISSION_MODES.map((m) => {
                      const active = m.value === permissionMode;
                      return (
                        <button
                          key={m.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          onClick={() => { onPermissionChange?.(m.value); setMenuOpen(false); }}
                          className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                        >
                          <Check className={`mt-[2px] h-3.5 w-3.5 shrink-0 ${active ? "text-[#10a37f]" : "text-transparent"}`} />
                          <span className="min-w-0">
                            <span className="block text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{m.label}</span>
                            <span className="mt-0.5 block text-[11.5px] leading-snug text-[#6e6e73] dark:text-[#8a8c93]">{m.desc}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            <div className="relative">
              <button
                type="button"
                onClick={() => setKbMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={kbMenuOpen}
                title="开启后 AI 懂台球运营、按行业专业知识作答；不开则是通用助手"
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] transition ${
                  activePacks.length
                    ? "bg-[#10a37f]/10 text-[#10a37f]"
                    : "text-[#6e6e73] hover:bg-black/[0.05] hover:text-[#1d1d1f] dark:text-[#9a9ca3] dark:hover:bg-white/[0.06] dark:hover:text-[#c8cace]"
                }`}
              >
                <BookOpen className="h-3.5 w-3.5" />
                {activeLabel ?? "台球运营知识库"}
                <ChevronDown className={`h-3 w-3 transition ${kbMenuOpen ? "rotate-180" : ""}`} />
              </button>

              {kbMenuOpen && (
                <>
                  <button type="button" aria-hidden tabIndex={-1} onClick={() => setKbMenuOpen(false)} className="fixed inset-0 z-40 cursor-default" />
                  <div role="menu" className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-[306px] rounded-lg border border-black/[0.1] bg-white p-1.5 shadow-[0_12px_40px_-10px_rgba(0,0,0,0.25)] dark:border-white/[0.1] dark:bg-[#1c1e24] dark:shadow-[0_12px_40px_-10px_rgba(0,0,0,0.7)]">
                    <div className="px-2.5 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-[#a1a1a6] dark:text-[#6e7077]">台球运营知识库</div>
                    {KNOWLEDGE_SOURCES.map((k) => {
                      const on = activePacks.includes(k.id);
                      return (
                        <button
                          key={k.id}
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={on}
                          onClick={() => {
                            const next = on ? activePacks.filter((x) => x !== k.id) : [...activePacks, k.id];
                            onKnowledgePacksChange?.(next);
                          }}
                          className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                        >
                          <Check className={`mt-[2px] h-3.5 w-3.5 shrink-0 ${on ? "text-[#10a37f]" : "text-transparent"}`} />
                          <span className="min-w-0">
                            <span className="block text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{k.label}</span>
                            <span className="mt-0.5 block text-[11.5px] leading-snug text-[#6e6e73] dark:text-[#8a8c93]">{k.desc}</span>
                          </span>
                        </button>
                      );
                    })}
                    <p className="px-2.5 pb-1 pt-1.5 text-[11px] leading-snug text-[#86868b] dark:text-[#6e7077]">不挂时是通用助手；挂上后按该领域专业知识作答。</p>
                  </div>
                </>
              )}
            </div>

            <div className="relative">
              <button
                type="button"
                onClick={() => setStyleMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={styleMenuOpen}
                title="输出风格"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-[#6e6e73] transition hover:bg-black/[0.05] hover:text-[#1d1d1f] dark:text-[#9a9ca3] dark:hover:bg-white/[0.06] dark:hover:text-[#c8cace]"
              >
                <Palette className="h-3.5 w-3.5 text-[#86868b] dark:text-[#6e7077]" />
                {activeStyleName ?? "默认风格"}
                <ChevronDown className={`h-3 w-3 text-[#b0b0b5] transition dark:text-[#56585f] ${styleMenuOpen ? "rotate-180" : ""}`} />
              </button>
              {styleMenuOpen && (
                <>
                  <button type="button" aria-hidden tabIndex={-1} onClick={() => setStyleMenuOpen(false)} className="fixed inset-0 z-40 cursor-default" />
                  <div role="menu" className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-[306px] rounded-lg border border-black/[0.1] bg-white p-1.5 shadow-[0_12px_40px_-10px_rgba(0,0,0,0.25)] dark:border-white/[0.1] dark:bg-[#1c1e24] dark:shadow-[0_12px_40px_-10px_rgba(0,0,0,0.7)]">
                    <div className="px-2.5 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-[#a1a1a6] dark:text-[#6e7077]">输出风格</div>
                    {styleOptions.map((s) => {
                      const active = (s.name || "") === (outputStyle || "");
                      return (
                        <button
                          key={s.name || "__default__"}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          onClick={() => { onOutputStyleChange?.(s.name); setStyleMenuOpen(false); }}
                          className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                        >
                          <Check className={`mt-[2px] h-3.5 w-3.5 shrink-0 ${active ? "text-[#10a37f]" : "text-transparent"}`} />
                          <span className="min-w-0">
                            <span className="block text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{s.name || "默认"}</span>
                            {s.description && <span className="mt-0.5 block text-[11.5px] leading-snug text-[#6e6e73] dark:text-[#8a8c93]">{s.description}</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            <span className="ml-1 hidden font-mono text-[11px] text-[#b0b0b5] sm:inline dark:text-[#54565d]">↵ 发送 · ⇧↵ 换行</span>

            <div className="flex-1" />

            <button
              onClick={() => !disabled && value.trim() && onSend()}
              disabled={disabled || !value.trim()}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-[#10a37f] text-white transition hover:bg-[#0e906f] active:scale-[0.95] disabled:opacity-30 dark:disabled:opacity-25"
              aria-label="发送"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
