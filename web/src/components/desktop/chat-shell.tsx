"use client";

/**
 * 桌面端 Agent 对话整壳：侧栏 + （空态欢迎页 | 对话流）+ 输入区，接 useAgentChat 真后端管道。
 * chat 路由唯一渲染本壳（单窗口产品，旧手机网页版分支已随单窗口化删除）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Target, X } from "lucide-react";

import { api, type NotificationItem, type RecentArtifact } from "@/lib/api";
import type { DashboardRecommendation } from "@/types/dashboard";
import { HELP_TEXT } from "@/lib/agent-copy";
import { toolMeta } from "@/lib/agent-tools";
import { useDesktop } from "@/hooks/use-desktop";
import { useAgentChat, type PermissionMode, type ChatMessage } from "@/hooks/use-agent-chat";
import { safeFileName } from "@/lib/utils";
import { DesktopShell, DesktopSidebar, type DesktopConversation } from "./macos-shell";
import { WelcomeScreen } from "./welcome-screen";
import { DesktopComposer } from "./desktop-composer";
import { DesktopChatThread } from "./chat-thread";
import { DesktopPreviewPanel, type PreviewItem } from "./preview-panel";
import { SettingsDrawer } from "./settings-drawer";
import { VideoStudioDrawer } from "./video-studio-drawer";
import { ConfirmDialog } from "./confirm-dialog";
import { StoreMemoryPanel } from "./store-memory-panel";
import { ScheduledTasksPanel } from "./scheduled-tasks-panel";
import { StoreDocsPanel } from "./store-docs-panel";
import { DeletedItemsPanel } from "./deleted-items-panel";
import { useToast } from "./toast";

function groupByDate(iso: string | null): string {
  if (!iso) return "更早";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "今天";
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
  return days < 7 ? "前 7 天" : "更早";
}

type PersistedWorkbenchState = {
  workingDir?: string | null;
  selectedFiles?: string[];
  knowledgePacks?: string[];
  outputStyle?: string;
  deepThinking?: boolean;
  permissionMode?: PermissionMode;
  preview?: PreviewItem | null;
};

function getWorkbenchId(): string {
  if (typeof window === "undefined") return "main";
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("workbench");
    if (fromUrl) return fromUrl;
  } catch { /* 忽略 */ }
  return "main";
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

// 报表提示「今天不再提示」的 localStorage key：按用户机器本地日期算，不用 toISOString()（那是 UTC，
// 国内用户的"当天"边界会错落到早 8 点：晚 11 点点了不感兴趣、次日早 6 点还会被当成"同一天"继续压着不提示）。
function reportDismissDayKey(): string {
  const d = new Date();
  return `report_hint_dismissed:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function isRestorablePreview(value: unknown): value is PreviewItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PreviewItem>;
  if (item.kind === "poster") return typeof item.imageUrl === "string";
  if (item.kind === "video") return typeof item.videoUrl === "string";
  if (item.kind === "content") return typeof item.text === "string";
  if (item.kind === "file") return typeof item.text === "string";
  if (item.kind === "sheet" || item.kind === "doc" || item.kind === "diff") return typeof item.path === "string";
  return false;
}

export function DesktopChatShell({
  storeName = "我的台球房",
}: {
  storeName?: string;
}) {
  const { electron } = useDesktop();
  const toast = useToast();
  const [workbenchId] = useState(getWorkbenchId);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<PermissionMode>("ask");
  // 已选定的本机文件（绝对路径）：授权管家读/改它们，像 Claude Code 一样改本地文件。随每次对话透传后端沙箱。
  // 注：桌面版后端默认放开「完全本地访问」（找/读/改任意文件+跑命令），无需前端再开开关；权限模式即安全闸。
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  // @ 挂载的知识库（如 ["billiards"]）：挂上=该领域专家，不挂=通用 Agent。随每次对话透传后端。
  const [knowledgePacks, setKnowledgePacks] = useState<string[]>([]);
  const [outputStyle, setOutputStyle] = useState<string>("");
  const [deepThinking, setDeepThinking] = useState(true); // F.2 深度思考默认开（mimo 默认就开）
  const [goal, setGoal] = useState<string>("");
  const [workingDir, setWorkingDir] = useState<string | null>(null);
  const [downloadsPath, setDownloadsPath] = useState<string | null>(null);
  // A4：Electron 首启自动建的作品文件夹（desktop:info 的 workspaceDir）；workingDir 没有已持久化值时的默认落点。
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const e2eAnswerSeededRef = useRef(false);
  const recentFilesKey = "agent_recent_files";
  const rememberFiles = useCallback((paths: string[]) => {
    const clean = paths.filter(Boolean);
    if (!clean.length) return;
    setRecentFiles((prev) => {
      const next = [...clean, ...prev.filter((p) => !clean.includes(p))].slice(0, 12);
      try { localStorage.setItem(recentFilesKey, JSON.stringify(next)); } catch { /* 忽略 */ }
      return next;
    });
  }, []);
  const addSelectedFiles = useCallback((paths: string[]) => {
    const clean = paths.filter(Boolean);
    if (!clean.length) return;
    setSelectedFiles((prev) => Array.from(new Set([...prev, ...clean])));
    rememberFiles(clean);
  }, [rememberFiles]);
  const wdKey = (id: string) => `agent_working_dir:${id}`;
  const persistWorkingDir = (id: string | null, wd: string | null) => {
    if (!id) return;
    try { wd ? localStorage.setItem(wdKey(id), wd) : localStorage.removeItem(wdKey(id)); } catch { /* 忽略 */ }
  };
  // 桌面默认全盘访问，模型本来就能读任何目录，"资料文件夹"概念已去掉；这里只对已选文件去重。
  const contextFiles = useMemo(
    () => Array.from(new Set(selectedFiles)),
    [selectedFiles],
  );
  const chat = useAgentChat({
    permissionMode: mode,
    selectedFiles: contextFiles,
    knowledgePacks,
    outputStyle,
    goal,
    deepThinking,
    workingDir,
    onGeneratedImage: (item) => setPreview({ kind: "poster", ...item }),
  });
  // 注：updateWorkingDir 必须声明在 chat 之后——它闭包引用 chat.conversationId，提前声明会触发 TDZ。
  const updateWorkingDir = (wd: string | null) => { setWorkingDir(wd); persistWorkingDir(chat.conversationId, wd); };
  const [preview, setPreview] = useState<PreviewItem | null>(null);
  // 设置抽屉（门店名 + AI key）：单窗口内打开，替代老 web 的门店设置页
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [videoStudioOpen, setVideoStudioOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [scheduledTasksOpen, setScheduledTasksOpen] = useState(false);
  const [storeDocsOpen, setStoreDocsOpen] = useState(false);
  const [deletedOpen, setDeletedOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteRecentTarget, setDeleteRecentTarget] = useState<RecentArtifact | null>(null);
  const [workbenchLoaded, setWorkbenchLoaded] = useState(false);
  const workbenchStateKey = `agent_workbench_state:${workbenchId}`;

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get("e2e_poster") !== "1") return;
      setPreview({
        kind: "poster",
        title: "E2E 海报预览",
        imageUrl: "/e2e-poster.svg",
        ratio: "9:16",
        width: 360,
        height: 640,
      });
    } catch { /* E2E helper only */ }
  }, []);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get("e2e_answer") !== "1" || e2eAnswerSeededRef.current) return;
      e2eAnswerSeededRef.current = true;
      setKnowledgePacks(["billiards"]);  // 种子是台球拉客答案 → 工作台设台球模式，对口下一步动作才会出(与 billiardsMode 门控一致)
      chat.pushAssistantMessage("今晚下雨没人，可以先做三件事：1. 客户群发雨天到店福利；2. 让助教约老客打练习局；3. 朋友圈发周赛预告。重点是今晚能执行，不写长篇理论。");
    } catch { /* E2E helper only */ }
  }, [chat]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(workbenchStateKey);
      if (!raw) {
        // decision #7：真·首次启动（既无工作台快照、也无独立知识库偏好）→ 默认挂台球模式（产品名就是台球）。
        // 不覆盖任何已保存选择：有 agent_knowledge_packs（哪怕是 [] = 用户特意选了通用）就交给下面的独立 effect 读。
        if (!localStorage.getItem("agent_knowledge_packs")) setKnowledgePacks(["billiards"]);
        setWorkbenchLoaded(true);
        return;
      }
      const saved = JSON.parse(raw) as PersistedWorkbenchState;
      if (saved.permissionMode === "ask" || saved.permissionMode === "auto_files" || saved.permissionMode === "full" || saved.permissionMode === "plan") {
        setMode(saved.permissionMode);
      }
      // 旧存档里的 resourceDirs（已废弃的"资料文件夹"）直接忽略，不再读取。
      if (Array.isArray(saved.selectedFiles)) setSelectedFiles(saved.selectedFiles.filter((p): p is string => typeof p === "string").slice(0, 20));
      if (Array.isArray(saved.knowledgePacks)) setKnowledgePacks(saved.knowledgePacks.filter((p): p is string => typeof p === "string"));
      if (typeof saved.outputStyle === "string") setOutputStyle(saved.outputStyle);
      if (typeof saved.deepThinking === "boolean") setDeepThinking(saved.deepThinking);
      if (typeof saved.workingDir === "string" || saved.workingDir === null) setWorkingDir(saved.workingDir || null);
      if (isRestorablePreview(saved.preview)) setPreview(saved.preview);
    } catch { /* 忽略坏快照 */ }
    finally { setWorkbenchLoaded(true); }
  }, [workbenchStateKey]);

  useEffect(() => {
    if (!workbenchLoaded) return;
    const payload: PersistedWorkbenchState = {
      workingDir,
      selectedFiles,
      knowledgePacks,
      outputStyle,
      deepThinking,
      permissionMode: mode,
      preview,
    };
    try { localStorage.setItem(workbenchStateKey, JSON.stringify(payload)); } catch { /* 忽略 */ }
  }, [deepThinking, knowledgePacks, mode, outputStyle, preview, selectedFiles, workbenchLoaded, workbenchStateKey, workingDir]);

  useEffect(() => {
    let cancelled = false;
    electron?.info?.()
      .then((info) => {
        if (cancelled) return;
        if (info.downloadsPath) setDownloadsPath(info.downloadsPath);
        // A4：首启自动建好的作品文件夹（~/Documents/台球助手），下面的默认值效果据此兜底 workingDir。
        if (info.workspaceDir) setWorkspaceDir(info.workspaceDir);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [electron]);

  // F1b 统一跨平台通知层：App 开着就持久轮询后端通知中心，拿到新条目就"叫一声"——
  // 桌面端调 Electron 桥弹系统原生通知（跨平台，替代旧的 mac-only osascript）；
  // 非桌面(web)兜底：优先浏览器原生 Notification，拿不到权限/不支持就退回全局 toast。
  // 旁路通知，不写进 chat.messages、不进对话历史。
  useEffect(() => {
    let cancelled = false;
    let after = -1;

    const showNotification = (n: NotificationItem) => {
      if (electron?.notification?.show) {
        electron.notification.show({ title: n.title, body: n.body }).catch(() => {});
        return;
      }
      if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
        try {
          new Notification(n.title || "台球运营助手", { body: n.body });
          return;
        } catch { /* 降级到 toast */ }
      }
      toast.success(n.body ? `${n.title}：${n.body}` : n.title);
    };

    // 非桌面端顺手问一次浏览器通知权限；用户拒绝也不重复打扰，代码会自动落回 toast。
    // 用 electron 判断而非 isDesktop：两者语义等价（isDesktop 也是由 window.electron 派生），
    // 但 electron 在首次渲染就已就绪、不像 isDesktop 要等一次 mount effect 才 false→true，
    // 避免把 isDesktop 放进下面的依赖数组导致这个轮询 effect 多重启一次、after 游标被重置。
    if (!electron && typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }

    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    (async () => {
      while (!cancelled) {
        try {
          const res = await api.getNotifications(after);
          if (cancelled) return;
          for (const item of res.items) showNotification(item);
          after = res.cursor;
        } catch {
          // 尽力而为：网络抖动/后端还没起来，不打扰用户，下一轮再试
        }
        await wait(4000);
      }
    })();

    return () => { cancelled = true; };
  }, [electron, toast]);

  // A4 零仪式：某会话/窗口没有已持久化的工作目录时，默认落到作品文件夹，不再要求用户开场先选。
  // 等 workbenchLoaded（已尝试读过窗口级缓存）+ workspaceDir 到手，workingDir 仍空才补上默认值——
  // 不覆盖用户已选过/历史会话记住的目录。
  useEffect(() => {
    if (!workbenchLoaded || workingDir || !workspaceDir) return;
    setWorkingDir(workspaceDir);
  }, [workbenchLoaded, workingDir, workspaceDir]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(recentFilesKey);
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) setRecentFiles(arr.filter((p): p is string => typeof p === "string").slice(0, 12));
    } catch { /* 忽略 */ }
  }, []);

  // 侧栏真数据：门店名 + 本月 AI 用量（拿不到就用传入的默认/占位，不阻断）
  const [liveStoreName, setLiveStoreName] = useState<string | undefined>();
  const [liveSpend, setLiveSpend] = useState<string | undefined>();
  // C1 当日店况简报：AI 先开口的多条洞察（含出处 category），欢迎屏用 BriefingCard 渲染
  const [briefing, setBriefing] = useState<{ greeting: string; weekday: string; items: DashboardRecommendation[] } | null>(null);
  // C1 首启特例：桌面/作品文件夹里检测到的报表提示（{ name, path } | null），出现在简报卡顶部。
  const [reportHint, setReportHint] = useState<{ name: string; path: string } | null>(null);
  // 极端情况下内置模型不可用时的兜底提示；正常桌面产品不要求用户先配 key。
  const [needsKey, setNeedsKey] = useState(false);
  const [keyHintDismissed, setKeyHintDismissed] = useState(false);
  // D-Task-8 读给我听：单一状态源——念的是哪一条(简报卡问候语固定用 "greeting" 键、对话消息用消息
  // 下标)。收在这一层统一管，简报卡/对话流两个展示组件不用各自一份 reading 状态，切换视图/会话时
  // 不会互相打架或漏管(Important#2 修复：避免"A 组件卸载误停 B 组件朗读")。
  const [readingKey, setReadingKey] = useState<string | number | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // allSettled：任一接口挂了不拖垮其它，拿不到的就保持默认/占位
      const [s, c, t] = await Promise.allSettled([
        api.getMyStore(),
        api.getCost(),
        api.getTodayDashboard(),
      ]);
      if (cancelled) return;
      if (s.status === "fulfilled" && s.value?.name) setLiveStoreName(s.value.name);
      if (c.status === "fulfilled" && typeof c.value?.est_cost_yuan === "number") {
        setLiveSpend(`¥${c.value.est_cost_yuan.toFixed(2)}`);
      }
      if (t.status === "fulfilled" && t.value) {
        setBriefing({ greeting: t.value.greeting, weekday: t.value.weekday, items: t.value.recommendations || [] });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // D.5 全内置 key·开箱即用：不再"必须先配 key"。BYOK 是可选高级档，没配也能用 → 不再弹"要配 key"引导。
  // （needsKey 维持 false；真没 key 的极端情况由生成时的错误提示兜底，不在门面常驻吓非技术老板。）

  // 会话历史列表（侧栏）：进页面拉一次 + 每拿到新会话 id 后刷新（新会话冒头）
  const [conversations, setConversations] = useState<DesktopConversation[]>([]);
  const [recentItems, setRecentItems] = useState<RecentArtifact[]>([]);
  const refreshConversations = useCallback(async () => {
    try {
      const r = await api.listAgentConversations();
      setConversations((r.conversations || []).map((c) => ({
        id: c.conversation_id,
        title: c.title || "新对话",
        group: groupByDate(c.last_at),
      })));
    } catch { /* 拿不到就空 */ }
  }, []);
  const refreshRecentItems = useCallback(async () => {
    try {
      const r = await api.listRecentArtifacts(8);
      setRecentItems(r.items || []);
    } catch { /* 拿不到不影响聊天 */ }
  }, []);
  useEffect(() => { void refreshConversations(); }, [refreshConversations]);
  useEffect(() => { void refreshRecentItems(); }, [refreshRecentItems]);
  useEffect(() => { if (chat.conversationId) void refreshConversations(); }, [chat.conversationId, refreshConversations]);
  useEffect(() => { if (chat.conversationId) void refreshRecentItems(); }, [chat.conversationId, refreshRecentItems]);
  // M2:生成工作室(独立窗口)出了成品 → 刷新主窗"最近作品",看得到工作室的产出
  useEffect(() => {
    if (!electron?.onStudioArtifact) return;
    return electron.onStudioArtifact(() => { void refreshRecentItems(); });
  }, [electron, refreshRecentItems]);
  // D-Task-10：全局快捷键小窗提交的内容 → 注入进当前对话。照 viewCurrentScreen(下方)的正确范式：
  // addSelectedFiles 是异步 setState，这一刻 state 还没刷新到位，显式带上 selectedFiles override 防漏发
  // ——别踩 C 批那个"addSelectedFiles 后紧接 send 漏 override"的时序坑。
  useEffect(() => {
    if (!electron?.onQuickInputInject) return;
    return electron.onQuickInputInject((payload) => {
      const text = String(payload?.text || "").trim();
      const imagePath = payload?.imagePath || null;
      if (!text && !imagePath) return;
      if (chat.generating) {
        // 任务跑动中弹的小窗内容暂不强行打断（同 viewCurrentScreen 的"运行中不发"约定）。
        toast.error("AI 正在处理上一个任务，等它忙完再问这个");
        return;
      }
      if (!imagePath) {
        void chat.send(text);
        return;
      }
      addSelectedFiles([imagePath]);
      const shown = imagePath.split(/[\\/]/).pop();
      void chat.send(
        text || `我刚在小窗里截了一张屏幕图，文件名是 ${shown}。先根据这张截图告诉我你看到了什么；如果需要点按或输入，先说明要做什么并等我确认。`,
        undefined,
        {
          selectedFiles: Array.from(new Set([...selectedFiles, imagePath])),
          ...(text ? {} : { displayText: "看一张截图" }),
        },
      );
    });
  }, [electron, chat, addSelectedFiles, selectedFiles, toast]);
  // 新会话首条消息后拿到 id → 把用户此前设的工作目录落盘到这个 id
  useEffect(() => { if (chat.conversationId) persistWorkingDir(chat.conversationId, workingDir); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [chat.conversationId]);

  // 点开一条历史会话 → 拉它的消息加载进来（可继续聊）
  const loadConv = useCallback(async (id: string) => {
    if (chat.generating) {
      // C1：UI 限制解释，不是 AI 说的话——删掉伪 AI 消息。
      // C4：侧栏会话项运行中已置灰 + tooltip"任务完成后可切换"(见 macos-shell.tsx DesktopSidebar
      // 的 selectDisabled)，正常操作点不到这里；这个判断留作兜底防御。
      return;
    }
    try {
      const r = await api.getAgentConversation(id);
      setSelectedFiles([]); // 切换会话：清掉上个会话的附件，避免误带
      // A4：这条历史会话没单独记过工作目录时，落回作品文件夹默认值（不再是 null）。
      try { setWorkingDir(localStorage.getItem(wdKey(id)) || workspaceDir); } catch { setWorkingDir(workspaceDir); }
      // C2 历史回放半：后端 display_content 映射成前端约定的 displayContent 字段，没有则不带（落回 content 全文）。
      const msgs: ChatMessage[] = (r.messages || []).map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.display_content ? { displayContent: m.display_content } : {}),
      }));
      chat.loadConversation(id, msgs);
    } catch { /* 忽略 */ }
  }, [chat, workspaceDir]);
  const openRecent = useCallback((item: RecentArtifact) => {
    if (item.kind === "poster" && item.url) {
      setPreview({
        kind: "poster",
        title: item.title,
        imageUrl: item.url,
        ratio: item.ratio || undefined,
        width: item.width || undefined,
        height: item.height || undefined,
      });
      return;
    }
    if (item.kind === "video" && item.url) {
      setPreview({
        kind: "video",
        title: item.title,
        videoUrl: item.url,
        ratio: item.ratio || undefined,
        duration: item.duration || undefined,
      });
      return;
    }
    if (item.kind === "task" && item.conversation_id) {
      void loadConv(item.conversation_id);
      return;
    }
    if (item.kind === "file_change" && item.path) {
      setPreview({ kind: "diff", title: item.title, path: item.path, backupPath: item.backup_path || item.id });
      return;
    }
    if (item.content) {
      setPreview({ kind: "content", title: item.title, text: item.content });
    }
  }, [chat, loadConv]);
  const deleteRecent = useCallback((item: RecentArtifact) => {
    if (!item.id || item.kind === "file_change") return;
    setDeleteRecentTarget(item);
  }, []);
  const confirmDeleteRecent = useCallback(async () => {
    const item = deleteRecentTarget;
    setDeleteRecentTarget(null);
    if (!item?.id) return;
    try {
      await api.deleteRecentArtifact(item.id);
      await refreshRecentItems();
      toast.success("已移入最近删除");
    } catch {
      toast.error("删除失败，可以稍后再试");
    }
  }, [deleteRecentTarget, refreshRecentItems, toast]);
  const continueLast = useCallback(() => {
    const last = conversations[0];
    if (last) { void loadConv(last.id); return; }
    const recentTask = recentItems.find((item) => item.conversation_id);
    if (recentTask?.conversation_id) void loadConv(recentTask.conversation_id);
  }, [conversations, recentItems, loadConv]);
  const newChat = useCallback(() => { setSelectedFiles([]); setPreview(null); chat.startNewChat(); }, [chat]);
  const newWorkspace = useCallback(() => {
    if (!electron?.newWindow) return;
    electron.newWindow().catch(() => {
      toast.error("新工作台没能打开，可以稍后再试");
    });
  }, [electron, toast]);

  // 删除一条历史会话（侧栏垃圾桶）：弹确认 → 软删 → 从列表移除；删的是当前会话则切到新会话。P1-3b。
  const deleteConv = useCallback((id: string) => { setDeleteTarget(id); }, []);
  const confirmDelete = useCallback(async () => {
    const id = deleteTarget;
    if (!id) return;
    if (chat.generating && chat.conversationId === id) {
      setDeleteTarget(null);
      // C1：UI 限制解释，不是 AI 说的话——删掉伪 AI 消息。
      // C4：侧栏对运行中会话的删除按钮已做禁用态(见 macos-shell.tsx DesktopSidebar)，
      // 正常操作不会走到这里；这个判断留作兜底防御。
      return;
    }
    setDeleteTarget(null);
    try {
      await api.deleteAgentConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (chat.conversationId === id) { setSelectedFiles([]); chat.startNewChat(); }
    } catch { /* 删失败：下次 refreshConversations 会纠正 */ }
  }, [deleteTarget, chat]);

  // P1-4 每日草稿：点欢迎页按钮 → 拉后端预生成的草稿(有当天缓存)→ 作为一条消息塞进对话,挑着用。
  const [dailyDraftsBusy, setDailyDraftsBusy] = useState(false);
  const loadDailyDrafts = useCallback(async () => {
    if (dailyDraftsBusy) return;
    setDailyDraftsBusy(true);
    try {
      const r = await api.dailyDrafts();
      const drafts = r.drafts || [];
      if (!drafts.length) { toast.success("今天没有现成草稿"); return; }
      const body = drafts.map((d, i) => `**${i + 1}. ${d.title}**\n\n${d.content}`).join("\n\n---\n\n");
      chat.pushAssistantMessage(`帮你备好了今天能发的几条，挑一条改改就能用：\n\n${body}`);
    } catch {
      toast.error("草稿加载失败，可以稍后再试");
    } finally {
      setDailyDraftsBusy(false);
    }
  }, [chat, dailyDraftsBusy, toast]);
  const viewCurrentScreen = useCallback(async () => {
    if (chat.generating) return;
    if (!electron?.captureScreen) {
      void chat.send(
        "先看一下我当前电脑屏幕，告诉我你看到了什么；如果需要点按或输入，先说明要做什么并等我确认。",
        undefined,
        { displayText: "看当前屏幕" },
      );
      return;
    }
    try {
      const r = await electron.captureScreen();
      if (!r?.ok || !r.path) {
        // C1：截屏结果通知（成功/失败）走 toast，不再进对话历史。
        // 例外：缺屏幕录制权限时,错误文案是「去系统设置→隐私与安全性→屏幕录制→勾选→重开 App」这种多步操作
        // 指引,用户要离开 App 照着做几分钟,2.5s 一闪而过的 toast 留不住、也没法滚回看——这条保留在对话流里。
        if (r?.needsPermission && r?.error) chat.pushAssistantMessage(r.error);
        else toast.error(r?.error ? `当前屏幕没截下来：${r.error}` : "当前屏幕没截下来，可以直接粘贴截图给我看");
        return;
      }
      addSelectedFiles([r.path]);
      // addSelectedFiles 是异步 setState，这一刻 state 还没刷新到位，显式带上"已选文件 + 这张截图"防止漏发。
      void chat.send(
        `我刚截了一张当前屏幕图，文件名是 ${r.path.split(/[\\/]/).pop()}。先根据这张截图告诉我你看到了什么；如果需要点按或输入，先说明要做什么并等我确认。`,
        undefined,
        { selectedFiles: Array.from(new Set([...selectedFiles, r.path])), displayText: "看当前屏幕" },
      );
    } catch {
      toast.error("当前屏幕没截下来，可以直接粘贴截图给我看");
    }
  }, [chat, electron, addSelectedFiles, selectedFiles, toast]);
  const startResearch = useCallback(() => {
    if (chat.generating) return;
    setInput("帮我查资料：");
  }, [chat.generating]);

  // 权限偏好持久化（与手机页同一套 localStorage key，体验一致）
  useEffect(() => {
    try {
      if (localStorage.getItem(workbenchStateKey)) return;
      const m = localStorage.getItem("agent_permission_mode");
      if (m === "ask" || m === "auto_files" || m === "full" || m === "plan") setMode(m);
    } catch { /* 忽略 */ }
  }, [workbenchStateKey]);
  const updateMode = (m: PermissionMode) => {
    setMode(m);
    try { localStorage.setItem("agent_permission_mode", m); } catch { /* 忽略 */ }
  };

  // @ 知识库挂载偏好持久化（记住上次挂了哪些领域包）
  useEffect(() => {
    try {
      if (localStorage.getItem(workbenchStateKey)) return;
      const k = localStorage.getItem("agent_knowledge_packs");
      if (k) { const arr = JSON.parse(k); if (Array.isArray(arr)) setKnowledgePacks(arr.filter((x): x is string => typeof x === "string")); }
    } catch { /* 忽略 */ }
  }, [workbenchStateKey]);
  const updateKnowledgePacks = (packs: string[]) => {
    setKnowledgePacks(packs);
    try { localStorage.setItem("agent_knowledge_packs", JSON.stringify(packs)); } catch { /* 忽略 */ }
  };

  // 输出风格偏好持久化
  useEffect(() => {
    try {
      if (localStorage.getItem(workbenchStateKey)) return;
      const s = localStorage.getItem("agent_output_style");
      if (s) setOutputStyle(s);
    } catch { /* 忽略 */ }
  }, [workbenchStateKey]);
  const updateOutputStyle = (name: string) => {
    setOutputStyle(name);
    try { localStorage.setItem("agent_output_style", name); } catch { /* 忽略 */ }
  };
  // F.2 深度思考开关持久化（默认开；存了 "0" 才是关）
  useEffect(() => {
    try {
      if (localStorage.getItem(workbenchStateKey)) return;
      if (localStorage.getItem("agent_deep_thinking") === "0") setDeepThinking(false);
    } catch { /* 忽略 */ }
  }, [workbenchStateKey]);
  const updateDeepThinking = (v: boolean) => {
    setDeepThinking(v);
    try { localStorage.setItem("agent_deep_thinking", v ? "1" : "0"); } catch { /* 忽略 */ }
  };

  // 选参考文件/图片/视频：回形针只做附件授权；换存放位置统一走「+」菜单，避免用户把目录当附件。
  const pickFiles = useCallback(async () => {
    if (!electron?.files?.pick) return;
    try {
      const r = await electron.files.pick({ multi: true });
      if (r.canceled || !r.paths?.length) return;
      addSelectedFiles(r.paths);
    } catch { /* 取消/失败：忽略 */ }
  }, [electron, addSelectedFiles]);
  const pickDownloads = useCallback(async () => {
    if (!electron?.files?.pick || !downloadsPath) return;
    try {
      const r = await electron.files.pick({
        title: "从下载文件夹选择素材",
        defaultPath: downloadsPath,
        multi: true,
      });
      if (r.canceled || !r.paths?.length) return;
      addSelectedFiles(r.paths);
    } catch { /* 取消/失败：忽略 */ }
  }, [electron, downloadsPath, addSelectedFiles]);
  // A4：换个存放位置——不再是开场必选项，收进「+」菜单当低调菜单项。一个入口既能选现有文件夹、
  // 也能在系统弹窗里当场新建文件夹（桌面主进程已支持 createDirectory）。不选的话默认就用作品文件夹。
  const pickWorkingDir = async () => {
    if (!electron?.files?.pick) return;
    try {
      const r = await electron.files.pick({
        directory: true,
        createDirectory: true,
        title: "选择或新建一个文件夹，管家的产出都存到这里",
      });
      if (r.canceled || !r.paths?.length) return;
      updateWorkingDir(r.paths[0]);
    } catch { /* 取消/失败:忽略 */ }
  };
  const removeFile = useCallback((p: string) => {
    setSelectedFiles((prev) => prev.filter((x) => x !== p));
  }, []);

  const onSend = () => {
    const t = input.trim();
    // 方向盘：任务跑动中也放行——send 会自动走"插话纠偏"路径（排队下一轮注入）；
    // 只有"在生成但没有可捎话的任务"（如审批工具执行中）才维持原来的不发。
    if (!t || (chat.generating && !chat.canSteer)) return;
    // /goal <条件>：设/清目标（本地处理，不发给 agent；之后每轮带 goal 让它对照自检）。
    if (t === "/goal" || t.startsWith("/goal ")) {
      const cond = t.slice(5).trim();
      if (!cond || cond === "clear") { setGoal(""); toast.success("目标已清除"); }
      else { setGoal(cond); toast.success(`目标已设定：${cond}`); }
      setInput("");
      return;
    }
    setInput("");
    void chat.send(t);
  };
  const pick = (prompt: string, recId?: string) => {
    if (chat.generating) return;
    setInput("");
    // 点的是"今日建议"（带 recId）：记一次采纳（隐式弱正反馈，故障安全），并随对话回传 recId 做"采纳上浮"。
    if (recId) api.adoptRecommendation(recId).catch(() => {});
    void chat.send(prompt, recId);
  };
  // 简报卡「不感兴趣」：后端记「今天收起」（故障安全，不阻断），本地当场移除该条
  const onDismissRec = useCallback((recId: string) => {
    api.dismissRecommendation(recId).catch(() => {});
    setBriefing((b) => (b ? { ...b, items: b.items.filter((r) => r.id !== recId) } : b));
  }, []);
  // 右侧"基于此调整"：把输入框预填好引子，老板补上要改什么、发出去，管家在原件上接着改
  const onRefine = (kind: PreviewItem["kind"]) => {
    setInput(kind === "poster" ? "把刚才那张海报改成：" : "把刚才这条改成：");
  };
  const onMakeVideo = (item: Extract<PreviewItem, { kind: "poster" }>) => {
    if (chat.generating) return;
    setInput("");
    void chat.send(
      [
        "把这张图做成一条抖音/视频号同城营销短视频。",
        `首帧图片：${item.imageUrl}`,
        `比例：${item.ratio || "9:16"}`,
        "时长：5 秒左右。",
        "要求：画面从这张图自然动起来，适合台球房周赛/活动宣传；先生成视频任务确认卡，说明耗时和额度，等我确认后再真正生成。",
      ].join("\n"),
      undefined,
      { displayText: "做成视频" },
    );
  };
  // 结果动作：把一段普通回答直接收束成门店员工能照着干的任务清单。
  const onMakeTask = useCallback((content: string) => {
    if (chat.generating) return;
    void chat.send(
      `把下面这段内容整理成门店员工能照着执行的任务清单。要求：按“负责人 / 今天什么时候做 / 具体动作 / 检查标准”输出，最多 6 条，优先今晚或明天能做的动作；不要写长篇解释。\n\n【原内容】\n${content.slice(0, 4000)}`,
      undefined,
      { displayText: "转成任务" },
    );
  }, [chat]);
  const onSaveArtifact = useCallback(async (content: string) => {
    if (!content.trim()) return;
    const title = content
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean)
      ?.slice(0, 48) || "保存的成品";
    try {
      await api.saveRecentArtifact({
        title,
        content,
        conversation_id: chat.conversationId,
        kind: "assistant_answer",
      });
      await refreshRecentItems();
      toast.success("已保存到最近作品");
    } catch {
      toast.error("保存失败，可以稍后再试");
    }
  }, [chat.conversationId, refreshRecentItems, toast]);
  const onExportArtifact = useCallback(async (content: string) => {
    if (!content.trim()) return;
    if (!electron?.files?.save) {
      // C1：UI 限制解释（当前环境没有这个能力），不是 AI 说的话——删掉伪 AI 消息。
      // C4：没有 electron.files.save 能力时，「导出到电脑」入口已在传给 DesktopChatThread 时
      // 整个不渲染（见下方 onExportArtifact={electron?.files?.save ? onExportArtifact : undefined}）；
      // 这里保留判断只作兜底防御，正常不会走到。
      return;
    }
    const rawTitle = content
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean)
      ?.slice(0, 36) || "AI成品";
    const defaultName = `${safeFileName(rawTitle)}.md`;
    try {
      const r = await electron.files.save({
        defaultName,
        base64: utf8ToBase64(content),
        title: "导出文本成品到电脑",
        filters: [
          { name: "Markdown 文档", extensions: ["md"] },
          { name: "文本", extensions: ["txt"] },
        ],
      });
      if (r.canceled) return;
      if (r.error || !r.path) {
        toast.error(r.error ? `导出失败：${r.error}` : "导出失败，可以稍后再试");
        return;
      }
      const path = r.path;
      toast.success(`已导出到电脑：${baseName(path)}`);
      if (electron.files.showInFolder) {
        window.setTimeout(() => { void electron.files.showInFolder?.(path); }, 300);
      }
    } catch {
      toast.error("导出失败，可以稍后再试");
    }
  }, [electron, toast]);
  // D-Task-8 读给我听：主进程 spawn 系统自带 TTS 念出声，不用 Web Speech API。故障安全——
  // electron.tts 拿不到/失败都只提示、不崩(入口本身已用 electron?.tts 判空只在桌面版露出)。
  // key 标识"念的是哪一条"(简报卡问候语传 "greeting"、对话消息传消息下标)，读写 readingKey 这个
  // 单一状态源——调用方(简报卡/对话流)不用自己攥一份 reading 状态。
  const onReadAloud = useCallback((content: string, key: string | number) => {
    if (!electron?.tts || !content.trim()) return;
    setReadingKey(key);
    void electron.tts.speak(content).then((r) => {
      if (!r?.ok) {
        toast.error(r?.error ? `朗读失败：${r.error}` : "朗读失败，可以稍后再试");
        setReadingKey((k) => (k === key ? null : k)); // 只清自己这条,防止期间用户已经点了别的条
      }
    });
  }, [electron, toast]);
  const onStopReadAloud = useCallback(() => {
    if (!electron?.tts) return;
    void electron.tts.stop();
    setReadingKey(null);
  }, [electron]);
  // 修复#1：spawn 后立即同步 return { ok:true } 不代表"念完了"——念完(close)/spawn 失败(error)是
  // 主进程那边异步才到的事件，订阅 tts:end 广播，自然念完/spawn 失败(如 say 二进制缺失)都在这统一
  // 复位，不然 UI 会一直卡在"正在朗读"，只能手动点停止或点别处顶掉。
  useEffect(() => {
    if (!electron?.tts?.onEnd) return;
    const off = electron.tts.onEnd((p) => {
      setReadingKey(null);
      if (p && p.ok === false) toast.error(p.error ? `朗读没成功：${p.error}` : "朗读没启动成功");
    });
    return off;
  }, [electron, toast]);
  const onRedoAnswer = useCallback((content: string) => {
    if (chat.generating) return;
    void chat.send(
      `刚才这一版先保留，不要覆盖。请换一个思路重新做一版，适合直接拿去用；如果是台球门店场景，优先给今晚/明天能执行的版本。\n\n【上一版】\n${content.slice(0, 3000)}`,
      undefined,
      { displayText: "重做一版" },
    );
  }, [chat]);
  const onRecoverFromError = useCallback((content: string) => {
    const clean = content.replace(/^⚠️\s*/, "").trim();
    setInput(`我换了素材/工作文件夹后再试一次。上次失败原因：${clean}\n\n这次请继续帮我：`);
  }, []);
  const onFollowUp = useCallback((prompt: string, label?: string) => {
    if (chat.generating) return;
    void chat.send(prompt, undefined, label ? { displayText: label } : undefined);
  }, [chat]);
  // 右侧"选中一段→基于此调整"（对齐 ChatGPT Canvas/Codex）：把【选中的原文 + 要改成啥】拼进消息直接发给管家，AI 只改这段。
  const onRefineSelection = (selectedText: string, instruction: string) => {
    if (chat.generating || !preview) return;
    const where = preview.kind === "file" && preview.path
      ? `文件「${preview.path}」里`
      : `右侧预览的「${preview.title || "成品"}」里`;
    void chat.send(
      `只改${where}下面这段，别动其它部分：\n\n【选中的原文】\n${selectedText}\n\n【改成】\n${instruction}`,
      undefined,
      // 气泡显示用户实际敲的改法（而非通用"基于此调整"），让老板看得到自己说了啥；真实长 prompt 照常发后端。
      { displayText: instruction.trim() ? `基于此调整：${instruction.trim()}` : "基于此调整" },
    );
  };
  // 右侧"确认采用/重做一版"定稿闸：看完拍板，把决定发回管家定稿或重出
  const onFinalize = (action: "accept" | "redo", finalText?: string) => {
    if (chat.generating || !preview) return;
    const label = preview.title || "这一版";
    if (action === "accept") {
      void chat.send(
        finalText && finalText.trim()
          ? `✅ 就用这一版定稿，按它继续后续步骤：\n\n${finalText}`
          : `✅ 我确认采用「${label}」这一版，按它定稿、继续后续步骤。`,
        undefined,
        { displayText: "确认采用" },
      );
    } else {
      void chat.send(
        `「${label}」这一版我不太满意，请换个思路重做一版。`,
        undefined,
        { displayText: "重做一版" },
      );
    }
    setPreview(null);
  };

  const empty = chat.messages.length === 0 && !chat.generating;

  // 修复#2：切会话／欢迎屏⇄对话流互相切换时，若还在念就先停掉——不然子进程在后台继续念、当前
  // 视图却没有按钮能停(孤儿朗读)。reading 状态收在这一层统一管，简报卡/对话流卸载不用各自猜
  // "是不是我在念"，也就不会出现"A 组件卸载把 B 组件的朗读也停了"的误伤(两者本就互斥挂载，
  // 但切换到另一个「非空」会话时对话流并不会卸载，必须靠这里主动 stop 才补得上这个缺口)。
  useEffect(() => {
    electron?.tts?.stop?.();
    setReadingKey(null);
    // 只想在"看的是哪个会话／欢迎屏还是对话流"变化时触发一次；readingKey 自己不放依赖，否则
    // 刚点开始朗读时 setReadingKey 也会触发这段，把刚开始念的又停掉。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.conversationId, empty]);

  // C1 首启特例：进欢迎屏时扫一次「桌面 + 作品文件夹」找最近一份报表，命中就在简报卡顶部主动开口。
  // 当天已「不感兴趣」过就不再扫（localStorage 按日）；扫描本身故障安全，扫不到/出错都静默当没有。
  useEffect(() => {
    const scan = electron?.files?.scanReports;
    if (!scan || !empty) return;
    let cancelled = false;
    const dayKey = reportDismissDayKey();
    try { if (localStorage.getItem(dayKey)) return; } catch { /* 忽略 */ }
    (async () => {
      try {
        const r = await scan();
        if (!cancelled && r?.path && r?.name) setReportHint({ name: r.name, path: r.path });
      } catch { /* 静默 */ }
    })();
    return () => { cancelled = true; };
  }, [electron, empty]);

  // 诊断：把报表加进 selectedFiles（授权 AI 读）+ 发一句诊断指令，复用现成的读文件授权机制，不自造读取逻辑。
  const onDiagnoseReport = useCallback((filePath: string, name: string) => {
    if (chat.generating) return;
    addSelectedFiles([filePath]);
    setReportHint(null);
    // addSelectedFiles 是异步 setState，这一刻 state 还没刷新到位，显式带上"已选文件 + 这份报表"防止漏发（同 viewCurrentScreen 的坑）。
    void chat.send(
      `帮我读一下这份报表《${name}》，挑 3 个我最该关注的问题，用大白话讲，别念数字。`,
      undefined,
      { selectedFiles: Array.from(new Set([...selectedFiles, filePath])), displayText: `诊断《${name}》` },
    );
  }, [chat, addSelectedFiles, selectedFiles]);

  // 不感兴趣：当场收起 + 记「当天不再提示」
  const onDismissReport = useCallback(() => {
    setReportHint(null);
    try { localStorage.setItem(reportDismissDayKey(), "1"); } catch { /* 忽略 */ }
  }, []);

  const sidebarEl = useMemo(() => (
    <DesktopSidebar
      storeName={liveStoreName || storeName}
      conversations={conversations}
      activeId={chat.conversationId ?? undefined}
      generating={chat.generating}
      onNewChat={newChat}
      onNewWorkspace={electron?.newWindow ? newWorkspace : undefined}
      onOpenStudio={electron?.openStudio ? () => { void electron.openStudio?.(); } : undefined}
      onSelect={loadConv}
      onDelete={deleteConv}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  ), [liveStoreName, storeName, conversations, chat.conversationId, chat.generating, newChat, newWorkspace, electron, loadConv, deleteConv]);

  return (
    <>
    <DesktopShell
      sidebar={sidebarEl}
      preview={preview ? <DesktopPreviewPanel item={preview} onClose={() => setPreview(null)} onRefine={onRefine} onRefineSelection={onRefineSelection} onFinalize={onFinalize} onMakeVideo={onMakeVideo} /> : undefined}
    >
      <div className="app-drag app-titlebar-safe-right flex h-[44px] items-center gap-2 border-b border-black/[0.08] px-5 dark:border-white/[0.06]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#10a37f]" />
        <span className="font-mono text-[12.5px] text-[#6e6e73] dark:text-[#9a9ca3]">{empty ? "新会话" : "会话"}</span>
        <button
          type="button"
          onClick={() => setMemoryOpen(true)}
          className="app-no-drag ml-auto rounded-md px-2 py-1 text-[12px] text-[#6e6e73] transition hover:bg-black/[0.04] hover:text-[#10a37f] dark:text-[#9a9ca3] dark:hover:bg-white/[0.06]"
        >
          我的球房资料
        </button>
        <button
          type="button"
          onClick={() => setScheduledTasksOpen(true)}
          className="app-no-drag rounded-md px-2 py-1 text-[12px] text-[#6e6e73] transition hover:bg-black/[0.04] hover:text-[#10a37f] dark:text-[#9a9ca3] dark:hover:bg-white/[0.06]"
        >
          定时任务
        </button>
        <button
          type="button"
          onClick={() => setStoreDocsOpen(true)}
          className="app-no-drag rounded-md px-2 py-1 text-[12px] text-[#6e6e73] transition hover:bg-black/[0.04] hover:text-[#10a37f] dark:text-[#9a9ca3] dark:hover:bg-white/[0.06]"
        >
          店铺资料库
        </button>
        <button
          type="button"
          onClick={() => setDeletedOpen(true)}
          className="app-no-drag rounded-md px-2 py-1 text-[12px] text-[#6e6e73] transition hover:bg-black/[0.04] hover:text-[#10a37f] dark:text-[#9a9ca3] dark:hover:bg-white/[0.06]"
        >
          最近删除
        </button>
      </div>

      {needsKey && !keyHintDismissed && (
        <div className="flex items-center gap-3 border-b border-[#007AFF]/20 bg-[#007AFF]/[0.06] px-5 py-2.5 text-[12.5px] text-[#1d1d1f] dark:text-[#e6e7e9]">
          <span className="flex-1">AI 服务暂时没准备好。普通使用不用自己配 key；可以先重试。</span>
          <button onClick={() => setSettingsOpen(true)} className="shrink-0 rounded-md bg-[#007AFF] px-3 py-1 text-[12px] font-medium text-white transition hover:bg-[#0066d6] active:scale-[0.97]">去配置</button>
          <button onClick={() => setKeyHintDismissed(true)} aria-label="关闭" className="shrink-0 px-1 text-[#86868b] transition hover:text-[#1d1d1f] dark:hover:text-[#e6e7e9]"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {empty ? (
        <WelcomeScreen
          briefing={briefing ?? undefined}
          onDismissRec={onDismissRec}
          reportHint={reportHint ?? undefined}
          onDiagnoseReport={onDiagnoseReport}
          onDismissReport={onDismissReport}
          billiardsMode={knowledgePacks.includes("billiards")}
          onPick={pick}
          onDailyDrafts={loadDailyDrafts}
          dailyDraftsBusy={dailyDraftsBusy}
          continueTitle={conversations[0]?.title || recentItems.find((item) => item.conversation_id)?.title}
          onContinueLast={(conversations[0] || recentItems.some((item) => item.conversation_id)) ? continueLast : undefined}
          recentItems={recentItems}
          onOpenRecent={openRecent}
          onDeleteRecent={deleteRecent}
          onOpenStoreMemory={() => setMemoryOpen(true)}
          onViewScreen={electron ? viewCurrentScreen : undefined}
          onResearch={startResearch}
          onReadAloud={electron?.tts ? onReadAloud : undefined}
          onStopReadAloud={electron?.tts ? onStopReadAloud : undefined}
          readingKey={readingKey}
        />
      ) : (
        <DesktopChatThread
          messages={chat.messages}
          draft={chat.draft}
          reasoningDraft={chat.reasoningDraft}
          liveSteps={chat.liveSteps}
          liveTodo={chat.liveTodo}
          generating={chat.generating}
          executingIdx={chat.executingIdx}
          onConfirm={chat.confirmApproval}
          onCancel={chat.cancelApproval}
          onPreview={setPreview}
          onAnswer={(label) => { void chat.send(label); }}
          onStop={chat.stop}
          onRetry={chat.retry}
          onRedoAnswer={onRedoAnswer}
          onRecoverFromError={onRecoverFromError}
          onMakeTask={onMakeTask}
          onSaveArtifact={onSaveArtifact}
          onExportArtifact={electron?.files?.save ? onExportArtifact : undefined}
          onReadAloud={electron?.tts ? onReadAloud : undefined}
          onStopReadAloud={electron?.tts ? onStopReadAloud : undefined}
          readingKey={readingKey}
          onFollowUp={onFollowUp}
          onRate={(id, r) => { void api.rateGeneration(id, r); }}
          billiardsMode={knowledgePacks.includes("billiards")}
        />
      )}

      {/* A4 零仪式：工作目录默认落作品文件夹，不再需要用户开场先选——这里只留纯提示信息，
          没有"还没选"欠账文案；换存放位置的动作已收进输入区「+」菜单（低调、任务内动作）。 */}
      {electron?.files?.pick && (
        <div className="mx-auto w-full max-w-[820px] px-4 pb-1">
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span
              className={`inline-flex items-center rounded-md px-2.5 py-1 ${
                knowledgePacks.includes("billiards")
                  ? "bg-[#10a37f]/10 text-[#10a37f]"
                  : "bg-black/[0.04] text-[#6e6e73] dark:bg-white/[0.05] dark:text-[#9a9ca3]"
              }`}
              title={knowledgePacks.includes("billiards") ? "台球项目：会自动挂上台球行业知识" : "通用项目：不注入台球门店知识"}
            >
              工作台：{knowledgePacks.includes("billiards") ? "台球项目" : "通用项目"}
            </span>
            {workingDir && (
              <span
                className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-black/[0.04] px-2.5 py-1 text-[#6e6e73] dark:bg-white/[0.05] dark:text-[#9a9ca3]"
                title={`${workingDir}（管家的产出默认存到这里；完全访问下仍能处理别处文件，想换个地方存就在输入框「+」菜单里选）`}
              >
                <span className="truncate">存放位置：{baseName(workingDir)}</span>
              </span>
            )}
          </div>
        </div>
      )}

      {goal && (
        <div className="mx-auto w-full max-w-[820px] px-4 pb-1">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#10a37f]/10 px-2.5 py-1 text-[12px] text-[#10a37f]">
            <Target className="h-3 w-3 shrink-0" /> 目标：{goal}
            <button
              type="button"
              onClick={() => { setGoal(""); toast.success("目标已清除"); }}
              className="ml-1 font-bold leading-none hover:opacity-70"
              aria-label="清除目标"
            >×</button>
          </span>
        </div>
      )}

      <DesktopComposer
        value={input}
        onChange={setInput}
        onSend={onSend}
        permissionMode={mode}
        onPermissionChange={updateMode}
        knowledgePacks={knowledgePacks}
        onKnowledgePacksChange={updateKnowledgePacks}
        outputStyle={outputStyle}
        onOutputStyleChange={updateOutputStyle}
        deepThinking={deepThinking}
        onDeepThinkingChange={updateDeepThinking}
        onCommand={(name) => {
          if (name === "new" || name === "clear") newChat();
          else if (name === "model" || name === "settings") setSettingsOpen(true);
          else if (name === "video-studio") setVideoStudioOpen(true);
          else if (name === "video-workspace") { void electron?.openVideoStudio?.(); }
          else if (name === "help") chat.pushAssistantMessage(HELP_TEXT);
          else if (name === "cost") chat.pushAssistantMessage(`本月 AI 用量 ≈ ${liveSpend || "—"}`);
          else if (name === "agents") chat.pushAssistantMessage(`可用子代理专家（我需要时会用「${toolMeta("run_subagent").label}」派工）：\n- general-purpose — 全能，可动手\n- explore — 只读探索·只查不改\n- plan — 只读规划·只出计划不执行`);
          else if (name === "mcp") {
            api.listMcp()
              .then((r) => {
                const s = r.servers || [];
                chat.pushAssistantMessage(s.length
                  ? "MCP 外部工具服务器：\n" + s.map((x) => `- ${x.name}：${x.status}（${x.tools} 个工具）`).join("\n")
                  : "还没配置 MCP 服务器（在 .mcp.json 里配，配好这里就能看到）。");
              })
              .catch(() => chat.pushAssistantMessage("MCP：暂时拿不到状态。"));
          }
          else if (name === "skills") {
            api.listSkills()
              .then((r) => {
                const s = r.skills || [];
                chat.pushAssistantMessage(s.length
                  ? "已安装技能：\n" + s.map((x) => `- /${x.name} — ${x.description}`).join("\n")
                  : "还没装技能（放 ~/.claude/skills 或装插件）。");
              })
              .catch(() => chat.pushAssistantMessage("技能：暂时拿不到。"));
          }
          else if (name === "plugins") {
            api.listPlugins()
              .then((r) => {
                const p = r.plugins || [];
                chat.pushAssistantMessage(p.length
                  ? "已装插件：\n" + p.map((x) => `- ${x.name}${x.enabled ? "" : "（停用）"} — 技能${x.components.skills}/风格${x.components["output-styles"]}/MCP${x.components.mcp}`).join("\n")
                  : "还没装插件（跟我说要装哪个插件，或放进 ~/.claude/plugins）。");
              })
              .catch(() => chat.pushAssistantMessage("插件：暂时拿不到。"));
          }
          else if (name === "context") {
            chat.pushAssistantMessage(`当前会话约 ${chat.messages.length} 条消息。聊长了可 /new 开新会话（更省、更准）。`);
          }
          else if (name === "export") {
            // F9：context_note 是低调系统提示（非真实对话内容），导出的对话记录里不掺它。
            const md = chat.messages.filter((m) => m.kind !== "context_note")
              .map((m) => `### ${m.role === "user" ? "我" : "助手"}\n\n${m.content}`).join("\n\n---\n\n");
            try {
              const blob = new Blob([md || "（空对话）"], { type: "text/markdown" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url; a.download = "对话.md"; a.click();
              URL.revokeObjectURL(url);
              toast.success("已导出为 Markdown");
            } catch {
              toast.error("导出失败");
            }
          }
        }}
        selectedFiles={selectedFiles}
        onPickFiles={electron?.files?.pick ? pickFiles : undefined}
        onPickDownloads={electron?.files?.pick && downloadsPath ? pickDownloads : undefined}
        recentFiles={recentFiles}
        onPickRecentFile={(path) => addSelectedFiles([path])}
        onAddFiles={electron?.files?.saveTemp ? addSelectedFiles : undefined}
        onRemoveFile={removeFile}
        onOpenFile={(p) => setPreview(/\.(xlsx|xlsm)$/i.test(p) ? { kind: "sheet", path: p } : { kind: "doc", path: p })}
        workingDir={workingDir}
        workspaceDir={workspaceDir}
        onPickWorkingDir={electron?.files?.pick ? pickWorkingDir : undefined}
        onResetWorkingDir={() => updateWorkingDir(workspaceDir)}
        disabled={chat.generating && !chat.canSteer}
        placeholder={chat.canSteer ? "任务进行中，可以随时补充或纠偏…" : undefined}
      />
    </DesktopShell>
    <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} onStoreNameChange={setLiveStoreName} />
    <VideoStudioDrawer open={videoStudioOpen} onClose={() => setVideoStudioOpen(false)} conversationId={chat.conversationId} />
    <StoreMemoryPanel open={memoryOpen} onClose={() => setMemoryOpen(false)} workingDir={workingDir} />
    <ScheduledTasksPanel open={scheduledTasksOpen} onClose={() => setScheduledTasksOpen(false)} />
    <StoreDocsPanel open={storeDocsOpen} onClose={() => setStoreDocsOpen(false)} />
    <DeletedItemsPanel
      open={deletedOpen}
      onClose={() => setDeletedOpen(false)}
      onRestored={() => { void refreshConversations(); void refreshRecentItems(); }}
    />
    <ConfirmDialog
      open={!!deleteTarget}
      title="删除这条会话？"
      message="它会从列表里消失（后台软删、可恢复）。"
      confirmLabel="删除"
      destructive
      onConfirm={confirmDelete}
      onCancel={() => setDeleteTarget(null)}
    />
    <ConfirmDialog
      open={!!deleteRecentTarget}
      title="移入最近删除？"
      message={`把「${deleteRecentTarget?.title || "这条作品"}」移入最近删除？之后可以从「最近删除」恢复。`}
      confirmLabel="移入删除"
      destructive
      onConfirm={confirmDeleteRecent}
      onCancel={() => setDeleteRecentTarget(null)}
    />
    </>
  );
}
