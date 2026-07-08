"use client";

/**
 * Codex 风底部输入区（浅色默认 · 跟随系统深浅色）：附件 + 前导提示符 › + 输入框 + 工具条 + 发送。
 * - 附件：选定本机文件 → selected_files 授权 Agent 读/改（沙箱），像 Claude Code/Codex 那样改本地文件。
 * - A-Task-6「控件按需出现」：工具条常驻只留 附件 / 深度思考开关 / 发送；
 *   最近文件、从下载选素材、运行权限(default/acceptEdits/plan/bypassPermissions 单选)、输出风格、专家挂载
 *   统一收进一个「+」菜单(分区展示)，行为不变、只换入口——照 Warp/Dia 的「按需出现」思路减少默认可见按钮数。
 * - D-Task-9 语音输入：麦克风按钮插在 附件/深度思考 之间，走口播同一套「模型就绪门」
 *   (useWhisperReady)；录音生命周期(getUserMedia → MediaRecorder → 转写 → 回填输入框)全在本组件内部
 *   管理，仿贴图/拖拽的"内部处理+回调"模式，不上抛父层新状态。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Paperclip, ArrowUp, ShieldCheck, Check, X, FileText, UserRound, Palette, Brain, FolderDown, FolderOpen, History, Plus, Mic, MicOff, Loader2, type LucideIcon } from "lucide-react";
import { PERMISSION_MODES, WELCOME } from "@/lib/agent-copy";
import { api, type CommandMeta, type SkillMeta, type OutputStyleMeta } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import { useWhisperReady } from "@/hooks/use-whisper-ready";
import { SlashPalette, type PaletteItem } from "./slash-palette";
import { useToast } from "./toast";
import type { PermissionMode } from "@/hooks/use-agent-chat";

// 内置 `/` 命令（cc 风，先放能即时接上的；其余随命令系统扩展）。
// G.3：每条带中文名(cn,做主视觉) + 中文/拼音别名(aliases,让 /导出 /用量 也能搜到)。
const BASIC_COMMANDS: { name: string; cn: string; description: string; aliases?: string[] }[] = [
  { name: "new", cn: "新会话", description: "开个新会话", aliases: ["新对话", "xinhuihua", "xin"] },
  { name: "clear", cn: "清空会话", description: "清空当前会话", aliases: ["清空", "qingkong"] },
  { name: "settings", cn: "设置", description: "打开设置", aliases: ["shezhi"] },
  // P0-2：原 /video-studio(剪辑台抽屉,V1) + /video-workspace(视频工作区,V2 独立窗口)两条命令合一——
  // V1 抽屉已下线(P0-3)，统一开 V2 视频工作区；旧别名(剪辑/剪辑台等)保留，老习惯照样能找到。
  { name: "video-workspace", cn: "视频工作区", description: "AI 挑高光→配文案→秒级预览→说句话改任何东西→出带包装短视频", aliases: ["视频工作区", "剪辑", "剪视频", "剪辑台", "氛围片", "视频创作", "jianji", "jianjitai", "shipin", "gongzuoqu"] },
  { name: "goal", cn: "设目标", description: "设定目标，让我对照它自检直到完成", aliases: ["目标", "mubiao"] },
  { name: "cost", cn: "用量", description: "本月 AI 用量", aliases: ["花费", "账单", "yongliang", "huafei"] },
  { name: "export", cn: "导出对话", description: "导出当前对话为 Markdown", aliases: ["导出", "保存对话", "daochu"] },
  { name: "help", cn: "帮助", description: "查看命令与能力", aliases: ["能干嘛", "bangzhu"] },
];

const ADVANCED_COMMANDS: { name: string; cn: string; description: string; aliases?: string[] }[] = [
  { name: "model", cn: "模型设置", description: "配置 AI 模型 / Key", aliases: ["模型", "moxing", "key"] },
  { name: "agents", cn: "子代理", description: "可用的子代理专家", aliases: ["代理", "daili"] },
  { name: "mcp", cn: "外接工具", description: "MCP 外部工具服务器状态", aliases: ["waijiegongju"] },
  { name: "skills", cn: "技能", description: "已安装的技能", aliases: ["jineng"] },
  { name: "plugins", cn: "插件", description: "已安装的插件", aliases: ["chajian"] },
  { name: "context", cn: "会话信息", description: "当前会话信息", aliases: ["上下文", "huihuaxinxi"] },
];

const LOCAL_COMMAND_NAMES = new Set([...BASIC_COMMANDS, ...ADVANCED_COMMANDS].map((c) => c.name));

export type KnowledgePackOption = { id: string; label: string; desc: string; defaultEnabled?: boolean };

const FALLBACK_KNOWLEDGE_PACKS: KnowledgePackOption[] = [
  { id: "billiards", label: "台球运营专家", desc: "经营、活动、会员、短视频和海报工作流", defaultEnabled: false },
];

const OUTPUT_STYLE_LABELS: Record<string, string> = {
  concise: "简短点",
  explanatory: "边做边讲",
};

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// A-Task-6：「+」菜单里几个子分区(专家/最近素材/运行权限/输出风格)共用的小标题，图标+大写字距标签。
function MenuSectionHeader({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5">
      <Icon className="h-3 w-3 text-[#a1a1a6] dark:text-[#6e7077]" />
      <span className="font-mono text-[10px] uppercase tracking-wider text-[#a1a1a6] dark:text-[#6e7077]">{label}</span>
    </div>
  );
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
  permissionMode = "default",
  onPermissionChange,
  selectedFiles = [],
  onPickFiles,
  onPickDownloads,
  recentFiles = [],
  onPickRecentFile,
  onAddFiles,
  onRemoveFile,
  onOpenFile,
  workingDir,
  workspaceDir,
  onPickWorkingDir,
  onResetWorkingDir,
  knowledgePacks = [],
  knowledgePackOptions = FALLBACK_KNOWLEDGE_PACKS,
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
  onPickDownloads?: () => void;
  recentFiles?: string[];
  onPickRecentFile?: (path: string) => void;
  onAddFiles?: (paths: string[]) => void; // 贴图/拖图：把图片落成路径后加进附件（授权 AI 看）
  onRemoveFile?: (path: string) => void;
  /** 点开附件：报表(.xlsx/.xlsm) 在右侧用表格视图打开（可点格改）。 */
  onOpenFile?: (path: string) => void;
  /** A4：当前工作区（默认是首启自动建的作品文件夹），「+」菜单里显示当前值 + 切换入口。 */
  workingDir?: string | null;
  /** A4：首启自动建的默认作品文件夹；用于切换后提供「恢复默认工作区」入口。 */
  workspaceDir?: string | null;
  onPickWorkingDir?: () => void;
  onResetWorkingDir?: () => void;
  knowledgePacks?: string[];
  knowledgePackOptions?: KnowledgePackOption[];
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
  // A-Task-6：附件/下载选素材/最近文件/运行权限/输出风格/专家 统一收进一个「+」菜单，只留一个开关状态。
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const activePacks = knowledgePacks ?? [];
  const packOptions = knowledgePackOptions.length ? knowledgePackOptions : FALLBACK_KNOWLEDGE_PACKS;
  const activeExpertNames = packOptions.filter((pack) => activePacks.includes(pack.id)).map((pack) => pack.label);
  const expertLabel = activeExpertNames.length === 0
    ? "通用 Agent"
    : activeExpertNames.length === 1
      ? activeExpertNames[0]
      : `${activeExpertNames[0]} +${activeExpertNames.length - 1}`;
  const expertTitle = activeExpertNames.length
    ? `当前专家：${activeExpertNames.join("、")}`
    : "当前专家：通用 Agent";
  const toast = useToast();

  // D-Task-9 语音输入：走口播同一套「模型就绪门」——whisper 没下好前麦克风灰掉+大白话提示。
  const { ready: micReady, status: micStatus } = useWhisperReady();
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const micStreamRef = useRef<MediaStream | null>(null);
  // 组件卸载时若还在录音，停掉麦克风流，别让权限指示灯一直亮着。
  useEffect(() => () => { micStreamRef.current?.getTracks().forEach((t) => t.stop()); }, []);

  const startRecording = async () => {
    if (!micReady || recording || transcribing) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error("这台电脑不支持录音，换成打字输入吧");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      audioChunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        micStreamRef.current = null;
        const chunks = audioChunksRef.current;
        audioChunksRef.current = [];
        setRecording(false);
        if (!chunks.length) return;
        const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
        if (blob.size === 0) return;
        setTranscribing(true);
        const file = new File([blob], `voice_${Date.now()}.webm`, { type: blob.type || "audio/webm" });
        api.transcribeAudio(file)
          .then(({ text }) => {
            const clean = text?.trim();
            if (!clean) { toast.info("没听清，请再说一次"); return; }
            const sep = value && !/[\s]$/.test(value) ? " " : "";
            onChange(`${value}${sep}${clean}`);
          })
          .catch((e) => toast.error(getErrorMessage(e)))
          .finally(() => setTranscribing(false));
      };
      mediaRecorderRef.current = mr;
      mr.start();
      setRecording(true);
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
        toast.error(isMac
          ? "还没拿到麦克风权限：去 系统设置→隐私与安全性→麦克风 里允许本应用，再点一次麦克风试试"
          : "还没拿到麦克风权限：去 设置→隐私→麦克风 里允许桌面应用访问，再点一次麦克风试试");
      } else if (name === "NotFoundError") {
        toast.error("没找到麦克风设备，检查一下电脑麦克风");
      } else {
        toast.error("打不开麦克风：" + getErrorMessage(err));
      }
    }
  };

  const stopRecording = () => { mediaRecorderRef.current?.stop(); };

  // `/` 命令面板：已安装技能(拉一次) + 内置命令；输入以 / 开头且未输入空格时浮出。
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [commands, setCommands] = useState<CommandMeta[]>([]);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  // 输出风格：拉一次可选风格，收进「+」菜单一个子分区切换。
  const [styles, setStyles] = useState<OutputStyleMeta[]>([]);
  useEffect(() => {
    let cancelled = false;
    // A2：不再有"高级模式"门控——已安装的技能本来就是老板自己装的东西，直接常驻拉一次，
    // 面板里没装就是空、不冒 MCP/模型这类技术词。
    api.listSkills().then((r) => { if (!cancelled) setSkills(r.skills || []); }).catch(() => {});
    api.listOutputStyles().then((r) => { if (!cancelled) setStyles(r.output_styles || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    api.listCommands(workingDir, knowledgePacks).then((r) => { if (!cancelled) setCommands(r.commands || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [knowledgePacks, workingDir]);
  const styleOptions = [{ name: "", description: "默认（大白话）" }, ...styles.map((s) => ({ name: s.name, description: s.description }))];

  const slashQuery = value.startsWith("/") && !value.slice(1).includes(" ") ? value.slice(1).toLowerCase() : null;
  const paletteItems: PaletteItem[] = slashQuery !== null ? [
    ...BASIC_COMMANDS
      // G.3：英文名 / 中文名 / 描述 / 中文拼音别名 任一命中即列出（打 /导出 /用量 也搜得到）
      .filter((c) => c.name.toLowerCase().includes(slashQuery)
        || c.cn.includes(slashQuery)
        || c.description.includes(slashQuery)
        || (c.aliases || []).some((a) => a.toLowerCase().includes(slashQuery)))
      .map((c): PaletteItem => ({ kind: "builtin", name: c.name, cn: c.cn, description: c.description })),
    // A2：model/agents/mcp/skills/plugins/context 这组高级命令不在浏览列表里宣传（零技术词），
    // 但懂行的人手打出完整命令名/别名照样能用——给会折腾的人留门。
    ...ADVANCED_COMMANDS
      .filter((c) => c.name.toLowerCase() === slashQuery || (c.aliases || []).some((a) => a.toLowerCase() === slashQuery))
      .map((c): PaletteItem => ({ kind: "builtin", name: c.name, cn: c.cn, description: c.description })),
    ...commands
      .filter((c) => !LOCAL_COMMAND_NAMES.has(c.name))
      .filter((c) => c.name.toLowerCase().includes(slashQuery)
        || (c.description || "").toLowerCase().includes(slashQuery)
        || (c.whenToUse || "").toLowerCase().includes(slashQuery))
      .map((c): PaletteItem => ({ kind: "command", name: c.name, description: c.description, whenToUse: c.whenToUse })),
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
    if (!plusMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setPlusMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [plusMenuOpen]);

  // Electron 33+ 移除了 File.path，统一用 webUtils.getPathForFile 桥拿本机路径
  const getFilePath = (f: File): string | undefined => {
    try { return window.electron?.files?.getPathForFile?.(f); } catch { /* non-Electron / 无路径 */ }
    return (f as File & { path?: string }).path; // Electron 32 及以下回退
  };

  // 粘贴文件：① 访达复制的文件有真实路径 → 直接拿（与拖拽同路）；② 只有字节没路径的（截图工具图片）→ saveTemp 落临时文件。
  const handlePaste = async (e: React.ClipboardEvent) => {
    if (!onAddFiles) return;
    const items = Array.from(e.clipboardData?.items || []);
    const fileItems = items.filter((it) => it.kind === "file");
    if (fileItems.length === 0) return;
    // ① 有真实路径的文件(从访达复制任意文件)→ 通过 getPathForFile 拿路径
    const direct: string[] = [];
    const needTemp: File[] = [];
    for (const it of fileItems) {
      const f = it.getAsFile();
      if (!f) continue;
      const fpath = getFilePath(f);
      if (fpath) direct.push(fpath);
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
  // 拖入：从访达拖图片/文件进来 → 通过 getPathForFile 拿绝对路径 → 直接加进附件。
  const handleDrop = (e: React.DragEvent) => {
    if (!onAddFiles) return;
    const files = Array.from(e.dataTransfer?.files || []);
    const paths = files.map((f) => getFilePath(f)).filter((p): p is string => !!p);
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
                title="常用命令"
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

          {/* 工具条：常驻 附件 / 专家 / 深度思考 / 发送；其余(最近文件/下载选素材/运行权限/输出风格)收进「+」菜单(A-Task-6)。
              slash 命令面板(输入 `/` 浮出)是输入区固有交互，不算按钮堆，不动。 */}
          <div className="flex items-center gap-0.5 px-2.5 pb-2 pt-1.5">
            <button
              type="button"
              onClick={onPickFiles}
              title="添加文件、图片或视频"
              aria-label="添加文件、图片或视频"
              className="flex h-7 w-7 items-center justify-center rounded-md text-[#86868b] transition hover:bg-black/[0.05] hover:text-[#1d1d1f] dark:text-[#6e7077] dark:hover:bg-white/[0.06] dark:hover:text-[#c8cace]"
            >
              <Paperclip className="h-[16px] w-[16px]" />
            </button>

            {/* D-Task-9 语音输入：走口播同一套「模型就绪门」，没就绪灰掉+大白话提示；就绪时点击录音/再点停止。 */}
            {!micReady ? (
              <button
                type="button"
                onClick={() => { if (micStatus.phase === "error") void window.electron?.models?.retry(); }}
                title={
                  micStatus.phase === "downloading"
                    ? `语音功能正在准备中（首次要下载语音模型${micStatus.percent ? ` ${micStatus.percent}%` : ""}）`
                    : micStatus.phase === "error"
                      ? "语音模型下载失败，点击重试"
                      : "语音功能正在准备中…"
                }
                aria-label="语音输入（准备中）"
                className={`flex h-7 w-7 items-center justify-center rounded-md text-[#86868b] opacity-40 dark:text-[#6e7077] ${
                  micStatus.phase === "error" ? "cursor-pointer hover:opacity-70" : "cursor-not-allowed"
                }`}
              >
                <MicOff className="h-[16px] w-[16px]" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { if (recording) stopRecording(); else void startRecording(); }}
                disabled={transcribing}
                title={recording ? "点击停止录音" : transcribing ? "识别中…" : "语音输入"}
                aria-label={recording ? "停止录音" : "语音输入"}
                aria-pressed={recording}
                className={`flex h-7 w-7 items-center justify-center rounded-md transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  recording
                    ? "bg-red-500/10 text-red-500 hover:bg-red-500/15"
                    : "text-[#86868b] hover:bg-black/[0.05] hover:text-[#1d1d1f] dark:text-[#6e7077] dark:hover:bg-white/[0.06] dark:hover:text-[#c8cace]"
                }`}
              >
                {transcribing ? <Loader2 className="h-[16px] w-[16px] animate-spin" /> : <Mic className={`h-[16px] w-[16px] ${recording ? "animate-pulse" : ""}`} />}
              </button>
            )}

            {onKnowledgePacksChange && (
              <button
                type="button"
                onClick={() => setPlusMenuOpen((v) => !v)}
                title={expertTitle}
                aria-label={expertTitle}
                aria-pressed={activePacks.length > 0}
                className={`inline-flex h-7 max-w-[178px] items-center gap-1.5 rounded-md px-2 text-[12px] transition active:scale-[0.97] ${
                  activePacks.length > 0
                    ? "bg-[#10a37f]/10 text-[#10a37f]"
                    : "text-[#86868b] hover:bg-black/[0.05] hover:text-[#1d1d1f] dark:text-[#6e7077] dark:hover:bg-white/[0.06] dark:hover:text-[#c8cace]"
                }`}
              >
                <UserRound className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 truncate">专家：{expertLabel}</span>
              </button>
            )}

            {/* F.2 深度思考 开/关：A5 已解除 advancedMode 门控，常驻可用，不进「+」菜单。 */}
            {onDeepThinkingChange && (
              <button
                type="button"
                onClick={() => onDeepThinkingChange(!deepThinking)}
                title={deepThinking ? "深度思考：开" : "深度思考：关"}
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

            {/* 「+」收纳：专家 / 最近文件 / 从下载选素材 / 运行权限(单选子分区) / 输出风格(单选子分区)。
                每项 onClick/切换行为与原独立菜单完全一致，只是换了入口——单选类点选即应用并收起整个「+」菜单；
                专家切换后不收起，方便连续看勾选变化。 */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setPlusMenuOpen((v) => !v)}
                title="更多"
                aria-label="更多"
                aria-haspopup="menu"
                aria-expanded={plusMenuOpen}
                className={`flex h-7 w-7 items-center justify-center rounded-md transition active:scale-[0.97] ${
                  plusMenuOpen
                    ? "bg-black/[0.04] text-[#1d1d1f] dark:bg-white/[0.06] dark:text-[#e6e7e9]"
                    : "text-[#86868b] hover:bg-black/[0.05] hover:text-[#1d1d1f] dark:text-[#6e7077] dark:hover:bg-white/[0.06] dark:hover:text-[#c8cace]"
                }`}
              >
                <Plus className="h-[16px] w-[16px]" />
              </button>

              {plusMenuOpen && (
                <>
                  <button type="button" aria-hidden tabIndex={-1} onClick={() => setPlusMenuOpen(false)} className="fixed inset-0 z-40 cursor-default" />
                  <div role="menu" className="absolute bottom-[calc(100%+8px)] left-0 z-50 max-h-[75vh] w-[320px] overflow-y-auto rounded-lg border border-black/[0.1] bg-white p-1.5 shadow-[0_12px_40px_-10px_rgba(0,0,0,0.25)] dark:border-white/[0.1] dark:bg-[#1c1e24] dark:shadow-[0_12px_40px_-10px_rgba(0,0,0,0.7)]">
                    {/* 专家：通用 Agent 是默认底座；领域专家作为可挂载上下文进入输入流 */}
                    {onKnowledgePacksChange && (
                      <>
                        <MenuSectionHeader icon={UserRound} label="专家" />
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={activePacks.length === 0}
                          onClick={() => onKnowledgePacksChange([])}
                          className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                        >
                          <Check className={`mt-[2px] h-3.5 w-3.5 shrink-0 ${activePacks.length === 0 ? "text-[#10a37f]" : "text-transparent"}`} />
                          <span className="min-w-0">
                                <span className="block text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">通用 Agent</span>
                                <span className="mt-0.5 block text-[11.5px] leading-snug text-[#6e6e73] dark:text-[#8a8c93]">代码、文件、工具和本机任务</span>
                          </span>
                        </button>
                        {packOptions.map((k) => {
                          const on = activePacks.includes(k.id);
                          return (
                            <button
                              key={k.id}
                              type="button"
                              role="menuitemcheckbox"
                              aria-checked={on}
                              onClick={() => {
                                const next = on ? activePacks.filter((x) => x !== k.id) : [...activePacks, k.id];
                                onKnowledgePacksChange(next);
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
                        <div className="my-1 h-px bg-black/[0.06] dark:bg-white/[0.06]" />
                      </>
                    )}

                    {/* 最近素材 */}
                    {recentFiles.length > 0 && onPickRecentFile && (
                      <>
                        <MenuSectionHeader icon={History} label="最近素材" />
                        {recentFiles.slice(0, 8).map((p) => (
                          <button
                            key={p}
                            type="button"
                            role="menuitem"
                            title={p}
                            onClick={() => { onPickRecentFile(p); setPlusMenuOpen(false); }}
                            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                          >
                            <FileText className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
                            <span className="min-w-0">
                              <span className="block truncate text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{baseName(p)}</span>
                              <span className="block truncate text-[11px] text-[#86868b] dark:text-[#8a8c93]">{p}</span>
                            </span>
                          </button>
                        ))}
                      </>
                    )}

                    {/* 从下载文件夹选素材：微信/浏览器/相册导出的文件常在这里 */}
                    {onPickDownloads && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => { onPickDownloads(); setPlusMenuOpen(false); }}
                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                      >
                        <FolderDown className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
                        <span className="text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">从下载文件夹选素材</span>
                      </button>
                    )}

                    {/* A4：切换工作区——默认已经是首启自动建好的作品文件夹，用户不用先选；
                        想打开/新建另一个文件夹，这是低调的任务内入口（不再是开场必选项）。 */}
                    {onPickWorkingDir && (
                      <button
                        type="button"
                        role="menuitem"
                        title={workingDir || undefined}
                        onClick={() => { onPickWorkingDir(); setPlusMenuOpen(false); }}
                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                      >
                        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
                        <span className="min-w-0">
                          <span className="block text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">切换工作区</span>
                          {workingDir && <span className="block truncate text-[11px] text-[#86868b] dark:text-[#8a8c93]">当前：{baseName(workingDir)}</span>}
                        </span>
                      </button>
                    )}

                    {/* A4：切换过工作区后，给一条回到默认作品文件夹的低调入口（去仪式化但不去控制权）。 */}
                    {onResetWorkingDir && workingDir && workspaceDir && workingDir !== workspaceDir && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => { onResetWorkingDir(); setPlusMenuOpen(false); }}
                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                      >
                        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
                        <span className="block text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">恢复默认工作区</span>
                      </button>
                    )}

                    {(recentFiles.length > 0 && onPickRecentFile) || onPickDownloads || onPickWorkingDir ? (
                      <div className="my-1 h-px bg-black/[0.06] dark:bg-white/[0.06]" />
                    ) : null}

                    {/* 运行权限：单选(default/acceptEdits/plan/bypassPermissions)，当前档打勾 */}
                    <MenuSectionHeader icon={ShieldCheck} label="运行权限" />
                    {PERMISSION_MODES.map((m) => {
                      const active = m.value === permissionMode;
                      return (
                        <button
                          key={m.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          onClick={() => { onPermissionChange?.(m.value); setPlusMenuOpen(false); }}
                          className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                        >
                          <Check className={`mt-[2px] h-3.5 w-3.5 shrink-0 ${active ? "text-[#10a37f]" : "text-transparent"}`} />
                          <span className="min-w-0">
                            <span className="block text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{m.label}</span>
                            <span className="mt-0.5 block text-[11.5px] leading-snug text-[#6e6e73] dark:text-[#8a8c93]">{m.desc}</span>
                            <span className="mt-1 flex flex-wrap gap-1">
                              {m.effects.map((effect) => (
                                <span key={effect} className="rounded bg-black/[0.035] px-1.5 py-0.5 text-[10.5px] text-[#86868b] dark:bg-white/[0.05] dark:text-[#8a8c93]">
                                  {effect}
                                </span>
                              ))}
                            </span>
                          </span>
                        </button>
                      );
                    })}

                    <div className="my-1 h-px bg-black/[0.06] dark:bg-white/[0.06]" />

                    {/* 输出风格：单选 */}
                    <MenuSectionHeader icon={Palette} label="输出风格" />
                    {styleOptions.map((s) => {
                      const active = (s.name || "") === (outputStyle || "");
                      return (
                        <button
                          key={s.name || "__default__"}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          onClick={() => { onOutputStyleChange?.(s.name); setPlusMenuOpen(false); }}
                          className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                        >
                          <Check className={`mt-[2px] h-3.5 w-3.5 shrink-0 ${active ? "text-[#10a37f]" : "text-transparent"}`} />
                          <span className="min-w-0">
                            <span className="block text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{s.name ? (OUTPUT_STYLE_LABELS[s.name] || s.name) : "默认"}</span>
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
              title="发送"
              className="app-primary-action flex h-7 w-7 items-center justify-center rounded-md transition active:scale-[0.95] disabled:opacity-30 dark:disabled:opacity-25"
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
