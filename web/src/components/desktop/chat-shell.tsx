"use client";

/**
 * 桌面端 Agent 对话整壳：侧栏 + （空态欢迎页 | 对话流）+ 输入区，接 useAgentChat 真后端管道。
 * 由 chat/page.tsx 在 isDesktop 时早返回渲染；手机网页版走原有页面，二者物理隔离。
 */
import { useCallback, useEffect, useState } from "react";

import { api } from "@/lib/api";
import { HELP_TEXT } from "@/lib/agent-copy";
import { useDesktop } from "@/hooks/use-desktop";
import { useAgentChat, type PermissionMode, type ChatMessage } from "@/hooks/use-agent-chat";
import { DesktopShell, DesktopSidebar, type DesktopConversation } from "./macos-shell";
import { WelcomeScreen } from "./welcome-screen";
import { DesktopComposer } from "./desktop-composer";
import { DesktopChatThread } from "./chat-thread";
import { DesktopPreviewPanel, type PreviewItem } from "./preview-panel";
import { SettingsDrawer } from "./settings-drawer";

function groupByDate(iso: string | null): string {
  if (!iso) return "更早";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "今天";
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
  return days < 7 ? "前 7 天" : "更早";
}

export function DesktopChatShell({
  storeName = "我的台球房",
  monthlySpend,
  todaySuggestion,
}: {
  storeName?: string;
  monthlySpend?: string;
  todaySuggestion?: string;
}) {
  const { electron } = useDesktop();
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<PermissionMode>("ask");
  // 已选定的本机文件（绝对路径）：授权管家读/改它们，像 Claude Code 一样改本地文件。随每次对话透传后端沙箱。
  // 注：桌面版后端默认放开「完全本地访问」（找/读/改任意文件+跑命令），无需前端再开开关；权限模式即安全闸。
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  // @ 挂载的知识库（如 ["billiards"]）：挂上=该领域专家，不挂=通用 Agent。随每次对话透传后端。
  const [knowledgePacks, setKnowledgePacks] = useState<string[]>([]);
  const [outputStyle, setOutputStyle] = useState<string>("");
  const [goal, setGoal] = useState<string>("");
  const chat = useAgentChat({ permissionMode: mode, selectedFiles, knowledgePacks, outputStyle, goal });
  const [preview, setPreview] = useState<PreviewItem | null>(null);
  // 设置抽屉（门店名 + AI key）：单窗口内打开，替代老 web 的门店设置页
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 侧栏真数据：门店名 + 本月 AI 用量（拿不到就用传入的默认/占位，不阻断）
  const [liveStoreName, setLiveStoreName] = useState<string | undefined>();
  const [liveSpend, setLiveSpend] = useState<string | undefined>();
  const [liveToday, setLiveToday] = useState<string | undefined>();
  // 今日建议的 rec.id：点「帮我写」时随对话回传后端做"采纳上浮"隐式反馈（拿不到就只发文本，不影响功能）
  const [liveTodayRecId, setLiveTodayRecId] = useState<string | undefined>();
  // 当前在用的文字模型名（侧栏底部显示「正在用：xxx」）：BYOK 启用且配了 key 才算在用
  const [liveModel, setLiveModel] = useState<string | undefined>();
  // 没配 AI key 时门面顶部弹一条引导（非技术老板最容易卡在"不知道要先配 key"）；配好/关掉设置后重查、自动消失
  const [needsKey, setNeedsKey] = useState(false);
  const [keyHintDismissed, setKeyHintDismissed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // allSettled：任一接口挂了不拖垮其它，拿不到的就保持默认/占位
      const [s, c, t, b] = await Promise.allSettled([
        api.getMyStore(),
        api.getCost(),
        api.getTodayDashboard(),
        api.getByokConfig(),
      ]);
      if (cancelled) return;
      if (s.status === "fulfilled" && s.value?.name) setLiveStoreName(s.value.name);
      if (c.status === "fulfilled" && typeof c.value?.est_cost_yuan === "number") {
        setLiveSpend(`¥${c.value.est_cost_yuan.toFixed(2)}`);
      }
      if (t.status === "fulfilled") {
        const rec = t.value?.recommendations?.[0];
        if (rec) { setLiveToday(rec.description || rec.title); setLiveTodayRecId(rec.id); }
      }
      if (b.status === "fulfilled" && b.value?.enabled && b.value?.key_configured && b.value?.model) {
        setLiveModel(b.value.model);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 设置关掉后重查 key 状态：老板配好了，顶部引导条就消失
  useEffect(() => {
    if (settingsOpen) return;
    let cancelled = false;
    api.getByokConfig()
      .then((b) => { if (!cancelled) setNeedsKey(!(b?.enabled && b?.key_configured)); })
      .catch(() => { /* 拿不到不弹，避免误扰 */ });
    return () => { cancelled = true; };
  }, [settingsOpen]);

  // 会话历史列表（侧栏）：进页面拉一次 + 每拿到新会话 id 后刷新（新会话冒头）
  const [conversations, setConversations] = useState<DesktopConversation[]>([]);
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
  useEffect(() => { void refreshConversations(); }, [refreshConversations]);
  useEffect(() => { if (chat.conversationId) void refreshConversations(); }, [chat.conversationId, refreshConversations]);

  // 点开一条历史会话 → 拉它的消息加载进来（可继续聊）
  const loadConv = useCallback(async (id: string) => {
    try {
      const r = await api.getAgentConversation(id);
      setSelectedFiles([]); // 切换会话：清掉上个会话的附件，避免误带
      chat.loadConversation(id, (r.messages || []) as ChatMessage[]);
    } catch { /* 忽略 */ }
  }, [chat]);
  const newChat = useCallback(() => { setSelectedFiles([]); chat.startNewChat(); }, [chat]);

  // 权限偏好持久化（与手机页同一套 localStorage key，体验一致）
  useEffect(() => {
    try {
      const m = localStorage.getItem("agent_permission_mode");
      if (m === "ask" || m === "auto_files" || m === "full" || m === "plan") setMode(m);
    } catch { /* 忽略 */ }
  }, []);
  const updateMode = (m: PermissionMode) => {
    setMode(m);
    try { localStorage.setItem("agent_permission_mode", m); } catch { /* 忽略 */ }
  };

  // @ 知识库挂载偏好持久化（记住上次挂了哪些领域包）
  useEffect(() => {
    try {
      const k = localStorage.getItem("agent_knowledge_packs");
      if (k) { const arr = JSON.parse(k); if (Array.isArray(arr)) setKnowledgePacks(arr.filter((x): x is string => typeof x === "string")); }
    } catch { /* 忽略 */ }
  }, []);
  const updateKnowledgePacks = (packs: string[]) => {
    setKnowledgePacks(packs);
    try { localStorage.setItem("agent_knowledge_packs", JSON.stringify(packs)); } catch { /* 忽略 */ }
  };

  // 输出风格偏好持久化
  useEffect(() => {
    try { const s = localStorage.getItem("agent_output_style"); if (s) setOutputStyle(s); } catch { /* 忽略 */ }
  }, []);
  const updateOutputStyle = (name: string) => {
    setOutputStyle(name);
    try { localStorage.setItem("agent_output_style", name); } catch { /* 忽略 */ }
  };

  // 选本机文件：弹系统选择器，把绝对路径加进 selectedFiles（去重）。授权管家读/改这些文件。
  const pickFiles = useCallback(async () => {
    if (!electron?.files?.pick) return;
    try {
      const r = await electron.files.pick({ multi: true });
      if (r.canceled || !r.paths?.length) return;
      setSelectedFiles((prev) => Array.from(new Set([...prev, ...r.paths])));
    } catch { /* 取消/失败：忽略 */ }
  }, [electron]);
  const removeFile = useCallback((p: string) => {
    setSelectedFiles((prev) => prev.filter((x) => x !== p));
  }, []);

  const onSend = () => {
    const t = input.trim();
    if (!t || chat.generating) return;
    // /goal <条件>：设/清目标（本地处理，不发给 agent；之后每轮带 goal 让它对照自检）。
    if (t === "/goal" || t.startsWith("/goal ")) {
      const cond = t.slice(5).trim();
      if (!cond || cond === "clear") { setGoal(""); chat.pushAssistantMessage("目标已清除。"); }
      else { setGoal(cond); chat.pushAssistantMessage(`目标已设定：${cond}\n（之后每轮我会对照它自检；没完成就继续做）`); }
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
  // 右侧"基于此调整"：把输入框预填好引子，老板补上要改什么、发出去，管家在原件上接着改
  const onRefine = (kind: PreviewItem["kind"]) => {
    setInput(kind === "poster" ? "把刚才那张海报改成：" : "把刚才这条改成：");
  };
  // 右侧"选中一段→基于此调整"（对齐 ChatGPT Canvas/Codex）：把【选中的原文 + 要改成啥】拼进消息直接发给管家，AI 只改这段。
  const onRefineSelection = (selectedText: string, instruction: string) => {
    if (chat.generating || !preview) return;
    const where = preview.kind === "file" && preview.path
      ? `文件「${preview.path}」里`
      : `右侧预览的「${preview.title || "成品"}」里`;
    void chat.send(`只改${where}下面这段，别动其它部分：\n\n【选中的原文】\n${selectedText}\n\n【改成】\n${instruction}`);
  };
  // 右侧"确认采用/重做一版"定稿闸：看完拍板，把决定发回管家定稿或重出
  const onFinalize = (action: "accept" | "redo", finalText?: string) => {
    if (chat.generating || !preview) return;
    const label = preview.title || "这一版";
    if (action === "accept") {
      void chat.send(finalText && finalText.trim()
        ? `✅ 就用这一版定稿，按它继续后续步骤：\n\n${finalText}`
        : `✅ 我确认采用「${label}」这一版，按它定稿、继续后续步骤。`);
    } else {
      void chat.send(`「${label}」这一版我不太满意，请换个思路重做一版。`);
    }
    setPreview(null);
  };

  const empty = chat.messages.length === 0 && !chat.generating;

  return (
    <>
    <DesktopShell
      sidebar={
        <DesktopSidebar
          storeName={liveStoreName || storeName}
          monthlySpend={liveSpend ?? monthlySpend}
          modelLabel={liveModel}
          conversations={conversations}
          activeId={chat.conversationId ?? undefined}
          onNewChat={newChat}
          onSelect={loadConv}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      }
      preview={preview ? <DesktopPreviewPanel item={preview} onClose={() => setPreview(null)} onRefine={onRefine} onRefineSelection={onRefineSelection} onFinalize={onFinalize} /> : undefined}
    >
      <div className="app-drag flex h-[44px] items-center gap-2 border-b border-black/[0.08] px-5 dark:border-white/[0.06]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#10a37f]" />
        <span className="font-mono text-[12.5px] text-[#6e6e73] dark:text-[#9a9ca3]">{empty ? "新会话" : "会话"}</span>
      </div>

      {needsKey && !keyHintDismissed && (
        <div className="flex items-center gap-3 border-b border-[#007AFF]/20 bg-[#007AFF]/[0.06] px-5 py-2.5 text-[12.5px] text-[#1d1d1f] dark:text-[#e6e7e9]">
          <span className="flex-1">👋 先花 1 分钟配一下你的 AI 钥匙，管家才能开工——点「去配置」选个供应商、贴上 key 就行。</span>
          <button onClick={() => setSettingsOpen(true)} className="shrink-0 rounded-md bg-[#007AFF] px-3 py-1 text-[12px] font-medium text-white transition hover:bg-[#0066d6] active:scale-[0.97]">去配置</button>
          <button onClick={() => setKeyHintDismissed(true)} aria-label="关闭" className="shrink-0 px-1 text-[#86868b] transition hover:text-[#1d1d1f] dark:hover:text-[#e6e7e9]">✕</button>
        </div>
      )}

      {empty ? (
        <WelcomeScreen todaySuggestion={liveToday || todaySuggestion} todaySuggestionRecId={liveTodayRecId} onPick={pick} />
      ) : (
        <DesktopChatThread
          messages={chat.messages}
          draft={chat.draft}
          liveSteps={chat.liveSteps}
          generating={chat.generating}
          executingIdx={chat.executingIdx}
          onConfirm={chat.confirmApproval}
          onCancel={chat.cancelApproval}
          onPreview={setPreview}
          onAnswer={(label) => { void chat.send(label); }}
          onStop={chat.stop}
        />
      )}

      {goal && (
        <div className="mx-auto w-full max-w-[820px] px-4 pb-1">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#10a37f]/10 px-2.5 py-1 text-[12px] text-[#10a37f]">
            🎯 目标：{goal}
            <button
              type="button"
              onClick={() => { setGoal(""); chat.pushAssistantMessage("目标已清除。"); }}
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
        onCommand={(name) => {
          if (name === "new" || name === "clear") newChat();
          else if (name === "model" || name === "settings") setSettingsOpen(true);
          else if (name === "help") chat.pushAssistantMessage(HELP_TEXT);
          else if (name === "cost") chat.pushAssistantMessage(`本月 AI 用量 ≈ ${liveSpend || "—"}`);
          else if (name === "agents") chat.pushAssistantMessage("可用子代理专家（用 run_subagent 派）：\n- general-purpose — 全能，可动手\n- explore — 只读探索·只查不改\n- plan — 只读规划·只出计划不执行");
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
                  : "还没装插件（用 install_plugin，或放进 ~/.claude/plugins）。");
              })
              .catch(() => chat.pushAssistantMessage("插件：暂时拿不到。"));
          }
          else if (name === "context") {
            chat.pushAssistantMessage(`当前会话约 ${chat.messages.length} 条消息。聊长了可 /new 开新会话（更省、更准）。`);
          }
          else if (name === "export") {
            const md = chat.messages.map((m) => `### ${m.role === "user" ? "我" : "助手"}\n\n${m.content}`).join("\n\n---\n\n");
            try {
              const blob = new Blob([md || "（空对话）"], { type: "text/markdown" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url; a.download = "对话.md"; a.click();
              URL.revokeObjectURL(url);
              chat.pushAssistantMessage("已导出当前对话为 Markdown。");
            } catch {
              chat.pushAssistantMessage("导出失败。");
            }
          }
        }}
        selectedFiles={selectedFiles}
        onPickFiles={electron?.files?.pick ? pickFiles : undefined}
        onRemoveFile={removeFile}
        onOpenFile={(p) => setPreview(/\.(xlsx|xlsm)$/i.test(p) ? { kind: "sheet", path: p } : { kind: "doc", path: p })}
        disabled={chat.generating}
      />
    </DesktopShell>
    <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} onStoreNameChange={setLiveStoreName} />
    </>
  );
}
