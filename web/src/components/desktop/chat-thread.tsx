"use client";

/**
 * Codex 风对话流（浅色默认 · 跟随系统深浅色）：用户输入(› 前导) / 工具步骤块 / 成品卡 / 内联审批 / 提问卡。
 * 纯展示组件，状态与逻辑由 useAgentChat 提供。
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, Check, Wrench, AlertTriangle, Send, Maximize2, BookOpen, Flag, Target, ShieldQuestion, MessageCircleQuestion, FileEdit, FileText, Terminal, ChevronRight, Brain, RotateCcw, ClipboardList, Save, MessageSquareText, Megaphone, ClipboardCheck, Paperclip, Download, ThumbsUp, Smartphone, Volume2, Film, ImageIcon, ExternalLink, Search, Users, GitBranch, Stethoscope, History } from "lucide-react";

import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import { CopyButton } from "@/components/generators/copy-button";
import { toolMeta, toolActionText, DELIVERABLE_TOOLS, INTERNAL_TOOLS, approvalLabel, approvalConfirmText, type ToolActionStatus } from "@/lib/agent-tools";
import type { ChatMessage, ToolStep, ApprovalState, QuestionData } from "@/hooks/use-agent-chat";
import { fileChangeEntriesFromContent } from "@/hooks/approved-tool-result-message";
import { retryStatusText, type AgentRetryStatus } from "@/hooks/agent-retry-status";
import type { PreviewItem } from "./preview-panel";
import { AgentSpinner } from "./agent-spinner";
import { OverflowMenu, type OverflowMenuItem } from "./overflow-menu";
import { SafeMarkdown } from "./safe-markdown";
import { DiffBlock } from "./diff-block";
import { approvalPreviewState, type ApprovalPlanPreview, type ProjectDiagnosticsApprovalPlan, type RunCommandApprovalPlan } from "./approval-preview-diff";
import { buildSubagentTrace, buildSubagentTraceView, parseBackgroundTaskStarted, type SubagentTracePhaseKind } from "./subagent-trace";
import { questionFieldAnswerDisplay, safeExternalQuestionUrl } from "./question-answer-display";
import { parseStoreDocSources, type StoreDocSourceHit } from "./store-doc-sources";
import { extractAssistantOutputTarget } from "./assistant-output-targets";
import { parseProjectInstructionScope } from "./project-instruction-scope";
import { parseGitStatusResult } from "./git-status-result";
import { parseGitHistoryResult } from "./git-history-result";
import { parseProjectDiagnosticsResult } from "./project-diagnostics-result";
import { parseStoredToolResult } from "./stored-tool-result";
import { parseStoredToolResultRead } from "./stored-tool-result-read";
import { parseFileHistoryResult } from "./file-history-result";
import { parseRestoreFileResult } from "./restore-file-result";
import { parseGrepRangesResult } from "./grep-ranges-result";
import { parseCodeOutlineRangesResult } from "./code-outline-ranges-result";
import { parseMcpResult, parseMcpTaskResult, type McpTaskTraceItem } from "./mcp-task-result";
import { parseMcpPromptList, parseMcpPromptRead, parseMcpResourceList, parseMcpResourceRead } from "./mcp-resource-prompt-result";

const PROSE = "prose prose-sm prose-slate dark:prose-invert max-w-none leading-relaxed prose-p:my-1.5";

// G-d(2026-07-04)：一键发布到平台整条线雪藏——默认安装包不带 publisher-bin，
// 会静默回退 python3(用户机器没装)，点了会失败但用户看不出为什么。入口先全部隐藏，
// 后端 /agent/publish 相关路由、window.electron.publish 桥接原样保留；
// 未来发布线补齐(内置 publisher-bin 或换实现)后，把这个常量翻回 true 即可接回，不用重写。
const SHOW_PUBLISH = false;

function posterUrl(content: string): string | null {
  const m = content.match(/!\[[^\]]*\]\(([^)\s]+)/);
  return m ? m[1] : null;
}

// E1-C2・generationId 可选透传：调用方传了就带上，"做成视频"靠它 openWorkbench({fromGen})找图——
// ⚠️ 不是 m.generationId(那是"本轮对话"这条 agent-chat 记录自己的 id，不是图的)，
// 真图 id 来自 step.imageGenerationIds(工具执行完真实落库的 Generation.id，见 use-agent-chat.ts)。
function posterPreviewFromText(content: string, title = "图片预览", generationId?: string): PreviewItem | null {
  const imageUrl = extractImageUrl(content);
  if (!imageUrl) return null;
  const ratio = content.match(/(?:尺寸|比例)：\s*([0-9]+:[0-9]+)/)?.[1];
  const dims = content.match(/([0-9]{2,5})x([0-9]{2,5})/i);
  return {
    kind: "poster",
    title,
    imageUrl,
    ratio,
    width: dims ? Number(dims[1]) : undefined,
    height: dims ? Number(dims[2]) : undefined,
    generationId,
  };
}

// G.3：从生图工具结果里稳健抓出图片地址——markdown 图片语法 ∪ 裸 URL ∪ 本机 /uploads 路径 ∪ 图片扩展名。
// 不再只认 markdown `![]()`，否则结果是纯路径/URL 时"说生成了图却看不到图"。
function extractImageUrl(text: string): string | null {
  if (!text) return null;
  const md = text.match(/!\[[^\]]*\]\(([^)\s]+)\)/);
  if (md) return md[1];
  const url = text.match(/(https?:\/\/[^\s)"']+\.(?:png|jpg|jpeg|webp|gif)|\/uploads\/[^\s)"']+\.(?:png|jpg|jpeg|webp|gif)|[^\s)"']+\.(?:png|jpg|jpeg|webp|gif))/i);
  return url ? url[1] : null;
}

function fileChangesFromToolStep(step: ToolStep): { path: string; backupPath?: string }[] {
  const result = typeof step.result === "string" ? step.result : "";
  const changes = fileChangeEntriesFromContent(result);
  if (changes.length > 0) return changes;
  return typeof step.args?.path === "string" ? [{ path: step.args.path }] : [];
}

function previewItemForLocalPath(title: string, path: string, text?: string, opts?: { backupPath?: string; mutation?: boolean }): PreviewItem {
  if (opts?.mutation && !/\.(xlsx|xlsm|pdf|docx|pptx|htm|html)$/i.test(path)) {
    return { kind: "diff", title, path, backupPath: opts.backupPath };
  }
  if (/\.(xlsx|xlsm)$/i.test(path)) return { kind: "sheet", title, path };
  if (/\.(pdf|docx|pptx|html|htm)$/i.test(path)) return { kind: "doc", title, path };
  return { kind: "file", title, path, text: text || "" };
}

const IMAGE_TOOLS = new Set(["make_poster", "generate_image"]);
const FILE_MUTATION_TOOLS = new Set(["edit_file", "edit_excel", "write_file", "multi_edit_file", "patch_file", "patch_files"]);

// E1-C2・模型自己回答文本里直接带的图片 markdown(非经 DeliverableCard 那条路径)按图片 URL 反查
// 同一条消息里对应的生图工具步骤，拿它落库的真实 Generation.id(m.generationId 是"本轮对话"记录，不是图)。
function imageGenerationIdForContent(steps: ToolStep[] | undefined, content: string): string | undefined {
  const url = extractImageUrl(content);
  if (!url || !steps) return undefined;
  for (const s of steps) {
    if (IMAGE_TOOLS.has(s.tool) && s.imageGenerationIds?.length && extractImageUrl(s.result || "") === url) {
      return s.imageGenerationIds[0];
    }
  }
  return undefined;
}

// 从生视频工具结果里稳健抓出视频地址——markdown 链接 `[..](url)` ∪ 裸 URL ∪ 本机 /uploads 路径 ∪ 视频扩展名。
function extractVideoUrl(text: string): string | null {
  if (!text) return null;
  const md = text.match(/\[[^\]]*\]\(([^)\s]+\.(?:mp4|mov|webm|m4v)[^)\s]*)\)/i);
  if (md) return md[1];
  const url = text.match(/(https?:\/\/[^\s)"']+\.(?:mp4|mov|webm|m4v)|\/uploads\/[^\s)"']+\.(?:mp4|mov|webm|m4v)|[^\s)"']+\.(?:mp4|mov|webm|m4v))/i);
  return url ? url[1] : null;
}

const VIDEO_TOOLS = new Set(["generate_video"]);

type FollowUpAction = {
  label: string;
  prompt: string;
  Icon: typeof ClipboardCheck;
};

function buildFollowUp(label: string, instruction: string, content: string, Icon: FollowUpAction["Icon"]): FollowUpAction {
  return {
    label,
    Icon,
    prompt: `${instruction}\n\n要求：直接给可复制成品，少讲道理；适合台球房今晚或明天就执行。\n\n【原回答】\n${content.slice(0, 3000)}`,
  };
}

function billiardsFollowUpActions(content: string): FollowUpAction[] {
  const text = content.replace(/\s+/g, "");
  const actions: FollowUpAction[] = [];
  const push = (action: FollowUpAction) => {
    // C3：动作栏整体收敛，追问 chip 上限从 3 个降到 2 个，别再跟按钮一起挤成一排。
    if (!actions.some((a) => a.label === action.label) && actions.length < 2) actions.push(action);
  };
  if (/拉客|下雨|没人|客流|获客|引流|到店|复购|客户群|朋友圈/.test(text)) {
    push(buildFollowUp("写客户群话术", "把原回答改成 3 条今晚能发到客户群的话术，每条 80 字以内，带一个明确到店理由。", content, MessageSquareText));
    push(buildFollowUp("做朋友圈文案", "把原回答改成一条朋友圈文案：标题、正文、配图建议、评论区引导都给出来。", content, Megaphone));
    push(buildFollowUp("转成今晚员工动作", "把原回答改成今晚员工执行清单，按前厅、助教、店长分工。", content, ClipboardCheck));
  }
  if (/报表|营业额|台费|助教费|商品费|充值|团购|经营数据|日报|月报/.test(text)) {
    push(buildFollowUp("出个活动方案", "针对原回答里最差的时段或品类，出一个能直接办的活动方案：目标、玩法、预算档、执行步骤，别写长理论。", content, ClipboardList));
    push(buildFollowUp("整理老板汇报", "把原回答整理成老板能听懂的汇报：一句结论、3 个问题、3 个改法。", content, ClipboardCheck));
  }
  if (/招聘|招人|助教|教练|前厅|员工|团队/.test(text)) {
    push(buildFollowUp("写招聘文案", "把原回答改成一条招聘文案，适合发朋友圈、同城群和小红书。", content, Megaphone));
    push(buildFollowUp("做招聘海报", "把原回答改成一段生图任务描述，生成台球房招聘海报，默认 9:16。", content, ClipboardList));
  }
  if (/客诉|投诉|差评|台泥|球杆|服务不好|脏|态度/.test(text)) {
    push(buildFollowUp("写平台回复", "把原回答改成一条平台差评/客诉回复，语气真诚、不甩锅、能挽回。", content, MessageSquareText));
    push(buildFollowUp("转成整改任务", "把原回答改成门店内部整改任务，写清谁去查、怎么补救、怎么复盘。", content, ClipboardCheck));
  }
  if (/周赛|比赛|活动|会员赛|挑战赛|赛事/.test(text)) {
    push(buildFollowUp("做活动海报", "把原回答改成一段台球活动海报生图任务描述，默认 9:16，避免虚假承诺。", content, ClipboardList));
    push(buildFollowUp("写朋友圈文案", "把原回答改成活动朋友圈文案，包含标题、时间、参与理由和报名引导。", content, Megaphone));
  }
  return actions;
}

// C3：出完海报后的组合拳追问（海报消息不是纯文本、不走 billiardsFollowUpActions，单独给）。
// prompt 自包含——"刚才那张海报"由对话历史解析。
function billiardsPosterFollowUps(): FollowUpAction[] {
  return [
    { label: "配条朋友圈文案", Icon: Megaphone,
      prompt: "给刚才这张海报配一条朋友圈文案：标题、正文、配图说明、评论区引导都给出来，适合台球房发。" },
    { label: "改成抖音竖版", Icon: Smartphone,
      prompt: "把刚才那张海报改成 9:16 抖音竖版（竖屏构图，适合发抖音、视频号同城）。" },
  ];
}

/** 解析 run_command 的结果文本（后端固定格式：命令／返回码／【标准输出】／【错误输出】）。 */
function parseCommandResult(
  text: string,
): { command: string; exitCode: number | null; stdout: string; stderr: string } | null {
  if (!text.startsWith("命令：")) return null;
  const nl = text.indexOf("\n");
  const command = (nl === -1 ? text.slice(3) : text.slice(3, nl)).trim();
  const rc = text.match(/返回码：(-?\d+)/);
  const exitCode = rc ? parseInt(rc[1], 10) : null;
  const SO = "【标准输出】";
  const SE = "【错误输出】";
  const soIdx = text.indexOf(SO);
  const seIdx = text.indexOf(SE);
  let stdout = "";
  let stderr = "";
  if (soIdx !== -1) stdout = text.slice(soIdx + SO.length, seIdx !== -1 ? seIdx : undefined).trim();
  if (seIdx !== -1) stderr = text.slice(seIdx + SE.length).trim();
  return { command, exitCode, stdout, stderr };
}

/** 终端式命令块：完整命令 + stdout/stderr + 退出码（对标 Claude Code 的 Bash 展示）。 */
function TerminalBlock({ text }: { text: string }) {
  const p = parseCommandResult(text);
  if (!p) {
    // 非标准格式（拒绝执行／需开启完全访问等提示）：当等宽提示展示
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-[#1e1e1e] px-3 py-2 font-mono text-[12px] leading-relaxed text-[#d4d4d4]">
        {text}
      </pre>
    );
  }
  const ok = p.exitCode === 0 || p.exitCode === null;
  return (
    <div className="overflow-hidden rounded-md border border-black/10 bg-[#1e1e1e] dark:border-white/10">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-[12px] text-[#d4d4d4]">
          <Terminal className="h-3.5 w-3.5 shrink-0 text-[#10a37f]" />
          <span className="truncate">{p.command}</span>
        </span>
        {p.exitCode !== null && (
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${ok ? "bg-[#10a37f]/20 text-[#3ddc97]" : "bg-[#ff3b30]/25 text-[#ff8585]"}`}
          >
            exit {p.exitCode}
          </span>
        )}
      </div>
      <div className="max-h-[320px] overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed">
        {p.stdout && <pre className="whitespace-pre-wrap text-[#d4d4d4]">{p.stdout}</pre>}
        {p.stderr && <pre className="whitespace-pre-wrap text-[#ff8585]">{p.stderr}</pre>}
        {!p.stdout && !p.stderr && <span className="text-[#888]">（无输出）</span>}
      </div>
    </div>
  );
}

/** 命令执行中的实时终端块（边跑边显示）：命令头 + 滚动累进的输出 + 运行中指示。 */
function LiveTerminalBlock({ command, output }: { command: string; output: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-black/10 bg-[#1e1e1e] dark:border-white/10">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-[12px] text-[#d4d4d4]">
          <Terminal className="h-3.5 w-3.5 shrink-0 text-[#10a37f]" />
          <span className="truncate">{command || "运行命令"}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] text-[#3ddc97]">
          <Loader2 className="h-3 w-3 animate-spin" /> 运行中
        </span>
      </div>
      <div className="max-h-[320px] overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed">
        {output ? <pre className="whitespace-pre-wrap text-[#d4d4d4]">{output}</pre> : <span className="text-[#888]">…</span>}
      </div>
    </div>
  );
}

/** 普通工具结果的可折叠披露（抓网页／搜文件／读文件等）：默认折叠显示一行预览，点开看全文。 */
function ResultDisclosure({ text, onOpen }: { text: string; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const oneLine = text.replace(/\s+/g, " ").trim();
  const preview = oneLine.length > 64 ? oneLine.slice(0, 64) + "…" : oneLine;
  return (
    <div className="ml-5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 items-center gap-1 font-mono text-[11.5px] text-[#86868b] transition hover:text-[#1d1d1f] dark:text-[#6e7077] dark:hover:text-[#c8cace]"
        >
          <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="truncate">{open ? "收起结果" : `结果：${preview}`}</span>
        </button>
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-[#10a37f] transition hover:underline"
          >
            <Maximize2 className="h-3 w-3" /> 打开
          </button>
        )}
      </div>
      {open && (
        <pre className="mt-1 max-h-[280px] overflow-auto whitespace-pre-wrap rounded-md border border-black/[0.06] bg-black/[0.02] px-2.5 py-2 font-mono text-[12px] leading-relaxed text-[#3a3a3c] dark:border-white/[0.06] dark:bg-white/[0.02] dark:text-[#9a9ca3]">
          {text}
        </pre>
      )}
    </div>
  );
}

function SubagentTraceCard({ step, active }: { step: ToolStep; active: boolean }) {
  const trace = buildSubagentTrace(step.args, step.progress, step.result);
  const [open, setOpen] = useState(!step.done);
  const [traceQuery, setTraceQuery] = useState("");
  const running = active && !step.done;

  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  if (!trace) return null;

  const traceView = buildSubagentTraceView(trace.lines, { maxLines: 14, query: traceQuery });
  const visibleLines = traceView.lineViews;
  const markers = traceView.markers.slice(-4);
  const phaseGroups = traceView.phaseGroups.slice(-5);
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-black/[0.06] bg-white/70 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]"
      >
        <Users className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        <span className="min-w-0 flex-1 truncate">
          子代理{trace.agent ? ` · ${trace.agent}` : ""}
          {trace.task ? <span className="text-[#86868b] dark:text-[#6e7077]"> · {trace.task}</span> : null}
        </span>
        {running && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[#b0b0b5] dark:text-[#56585f]" />}
        <ChevronRight className={`h-3 w-3 shrink-0 text-[#a1a1a6] transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-black/[0.05] px-2.5 py-2 dark:border-white/[0.06]">
          {trace.lines.length > 0 && (
            <div className="space-y-2">
              {(trace.lines.length > 6 || markers.length > 0 || traceView.hasQuery) && (
                <div className="space-y-1.5">
                  {markers.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      {markers.map((marker) => (
                        <button
                          key={`subagent-marker-${marker.index}`}
                          type="button"
                          title={marker.detail}
                          onClick={() => setTraceQuery(marker.query)}
                          className="max-w-full truncate rounded-md border border-[#ff9500]/25 bg-[#ff9500]/10 px-1.5 py-0.5 text-[10.5px] text-[#9a5a00] transition hover:brightness-95 dark:text-[#ffd08a]"
                        >
                          {marker.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {phaseGroups.length > 1 && (
                    <div className="flex flex-wrap items-center gap-1">
                      {phaseGroups.map((group, index) => (
                        <span
                          key={`subagent-phase-${index}-${group.phase}-${group.indexStart}-${group.indexEnd}`}
                          title={group.indexStart >= 0 ? `#${group.indexStart + 1}${group.indexEnd !== group.indexStart ? `-#${group.indexEnd + 1}` : ""}` : undefined}
                          className={`rounded border px-1.5 py-0.5 text-[10.5px] ${subagentTracePhaseClass(group.phase)}`}
                        >
                          {group.phaseLabel}{group.count > 1 ? ` ×${group.count}` : ""}
                        </span>
                      ))}
                    </div>
                  )}
                  <label className="flex h-7 items-center gap-1.5 rounded-md border border-black/[0.08] bg-white px-2 text-[11.5px] text-[#6e6e73] focus-within:border-[#10a37f]/45 dark:border-white/[0.08] dark:bg-[#111318] dark:text-[#9a9ca3]">
                    <Search className="h-3.5 w-3.5 shrink-0 text-[#10a37f]" />
                    <input
                      value={traceQuery}
                      onChange={(e) => setTraceQuery(e.target.value)}
                      placeholder="搜索子代理过程"
                      className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[#a1a1a6] dark:placeholder:text-[#6e7077]"
                    />
                    {traceView.hasQuery && (
                      <button
                        type="button"
                        onClick={() => setTraceQuery("")}
                        className="rounded px-1 text-[10.5px] text-[#86868b] transition hover:bg-black/[0.05] hover:text-[#3a3a3c] dark:text-[#8a8c93] dark:hover:bg-white/[0.06] dark:hover:text-[#c8cace]"
                      >
                        清除
                      </button>
                    )}
                  </label>
                  {traceView.hasQuery && (
                    <div className="text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">
                      匹配 {traceView.matchCount}/{traceView.totalLines} 条过程
                    </div>
                  )}
                </div>
              )}
              {visibleLines.length === 0 ? (
                <div className="text-[12px] text-[#86868b] dark:text-[#8a8c93]">没有匹配的子代理过程。</div>
              ) : visibleLines.map((line, index) => (
                <div key={`${line.text}-${index}`} className="flex min-w-0 items-start gap-1.5 text-[12px] leading-relaxed text-[#6e6e73] dark:text-[#8a8c93]">
                  <span className={`mt-0.5 shrink-0 rounded border px-1 py-0 font-mono text-[10px] leading-4 ${subagentTracePhaseClass(line.phase)}`}>{line.phaseLabel}</span>
                  <span className="min-w-0 break-words">{line.text}</span>
                </div>
              ))}
            </div>
          )}
          {trace.finalText && (
            <div className={visibleLines.length > 0 ? "mt-2 border-t border-black/[0.05] pt-2 dark:border-white/[0.06]" : ""}>
              <div className="mb-1 text-[11px] font-medium text-[#86868b] dark:text-[#6e7077]">结论</div>
              <div className={PROSE}>
                <SafeMarkdown>{trace.finalText}</SafeMarkdown>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function subagentTracePhaseClass(phase: SubagentTracePhaseKind): string {
  if (phase === "warning") return "border-[#ff9500]/25 bg-[#ff9500]/10 text-[#9a5a00] dark:text-[#ffd08a]";
  if (phase === "final") return "border-[#10a37f]/20 bg-[#10a37f]/10 text-[#0b8064] dark:text-[#70d7bd]";
  if (phase === "start" || phase === "tool") return "border-black/[0.06] bg-white text-[#6e6e73] dark:border-white/[0.08] dark:bg-[#111318] dark:text-[#9a9ca3]";
  return "border-black/[0.06] bg-black/[0.035] text-[#86868b] dark:border-white/[0.08] dark:bg-white/[0.045] dark:text-[#8a8c93]";
}

function BackgroundTaskStartedCard({ step, onOpenBackgroundTask }: { step: ToolStep; onOpenBackgroundTask?: (taskId: string) => void }) {
  const task = parseBackgroundTaskStarted(step.result);
  if (!task) return null;
  return (
    <div className="ml-5 rounded-md border border-black/[0.06] bg-white/70 px-2.5 py-2 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
        <Users className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        <span className="min-w-0 flex-1 truncate">
          后台子代理已启动
          {task.agent ? <span className="text-[#86868b] dark:text-[#6e7077]"> · {task.agent}</span> : null}
          {task.title ? <span className="text-[#86868b] dark:text-[#6e7077]"> · {task.title}</span> : null}
        </span>
        {task.status && <span className="shrink-0 rounded bg-[#10a37f]/10 px-1.5 py-0.5 text-[11px] text-[#0b8064] dark:bg-[#2fd39e]/10 dark:text-[#70d7bd]">{task.status}</span>}
      </div>
      {task.id && (
        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="min-w-0 truncate font-mono text-[11px] text-[#a1a1a6] dark:text-[#6e7077]">
            {task.id}
            {task.agentId && task.agentId !== task.id ? <span> · agent {task.agentId}</span> : null}
          </div>
          {onOpenBackgroundTask && (
            <button
              type="button"
              onClick={() => onOpenBackgroundTask(task.id!)}
              className="shrink-0 rounded-md px-2 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
            >
              查看过程
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function confidenceText(value?: string): string {
  if (value === "high") return "高";
  if (value === "medium") return "中";
  if (value === "low") return "低";
  return value || "未知";
}

function StoreDocSourceRow({
  hit,
  onPreview,
}: {
  hit: StoreDocSourceHit;
  onPreview?: (item: PreviewItem) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-black/[0.05] first:border-t-0 dark:border-white/[0.06]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]"
      >
        <span className="shrink-0 rounded bg-[#10a37f]/10 px-1.5 py-0.5 font-mono text-[10.5px] text-[#0b8064] dark:bg-[#2fd39e]/10 dark:text-[#70d7bd]">{hit.sourceId}</span>
        <span className="min-w-0 flex-1 truncate">
          {hit.fileName}
          {hit.chunkLabel ? <span className="text-[#86868b] dark:text-[#6e7077]"> · {hit.chunkLabel}</span> : null}
        </span>
        <span className="shrink-0 rounded bg-black/[0.04] px-1.5 py-0.5 text-[11px] text-[#6e6e73] dark:bg-white/[0.05] dark:text-[#8a8c93]">
          可信度 {confidenceText(hit.confidence)}
        </span>
        <ChevronRight className={`h-3 w-3 shrink-0 text-[#a1a1a6] transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="px-2.5 pb-2">
          {hit.why && (
            <div>
              <div className="mb-0.5 text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">引用原因</div>
              <div className="text-[12px] leading-relaxed text-[#6e6e73] dark:text-[#8a8c93]">{hit.why}</div>
            </div>
          )}
          {hit.matchedTerms.length > 0 && (
            <div className="mt-1.5">
              <div className="mb-1 text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">匹配词</div>
              <div className="flex flex-wrap gap-1">
                {hit.matchedTerms.map((term) => (
                  <span key={term} className="rounded bg-black/[0.04] px-1.5 py-0.5 text-[11px] text-[#6e6e73] dark:bg-white/[0.05] dark:text-[#8a8c93]">{term}</span>
                ))}
              </div>
            </div>
          )}
          {hit.excerpt && (
            <div className="mt-2">
              <div className="mb-1 text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">摘录</div>
              <div className="rounded-md bg-black/[0.025] px-2.5 py-2 text-[12px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.035] dark:text-[#9a9ca3]">
                {hit.excerpt}
              </div>
            </div>
          )}
          {hit.path && (
            <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
              <span className="min-w-0 truncate font-mono text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">{hit.path}</span>
              {onPreview && (
                <button
                  type="button"
                  onClick={() => onPreview(previewItemForLocalPath(hit.fileName, hit.path!, hit.excerpt))}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
                >
                  <Maximize2 className="h-3 w-3" /> 打开
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StoreDocSourcesCard({ text, onPreview }: { text: string; onPreview?: (item: PreviewItem) => void }) {
  const sources = parseStoreDocSources(text);
  if (!sources) return null;
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-black/[0.06] bg-white/70 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        <span className="min-w-0 flex-1 truncate">引用的店铺文件</span>
        <span className="shrink-0 font-mono text-[11px] text-[#a1a1a6] dark:text-[#6e7077]">{sources.hits.length} 条</span>
      </div>
      <div>
        {sources.hits.map((hit) => (
          <StoreDocSourceRow key={`${hit.sourceId}-${hit.path || hit.fileName}-${hit.chunkLabel || ""}`} hit={hit} onPreview={onPreview} />
        ))}
      </div>
    </div>
  );
}

function ProjectInstructionScopeCard({ text }: { text: string }) {
  const scope = parseProjectInstructionScope(text);
  if (!scope) return null;
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-black/[0.06] bg-white/70 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
        <ShieldQuestion className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        <span className="min-w-0 flex-1 truncate">项目规则范围</span>
        <span className="shrink-0 font-mono text-[11px] text-[#a1a1a6] dark:text-[#6e7077]">
          {scope.status === "found" ? scope.files.length : "空"}
        </span>
      </div>
      {scope.status === "empty" ? (
        <div className="border-t border-black/[0.05] px-2.5 py-2 text-[12px] leading-relaxed text-[#86868b] dark:border-white/[0.06] dark:text-[#8a8c93]">
          没有命中目录级项目规则{scope.targets ? ` · ${scope.targets}` : ""}{scope.omitted ? ` · 省略 ${scope.omitted} 个目标` : ""}
        </div>
      ) : (
        <div>
          {scope.files.map((file) => (
            <div key={file.file} className="border-t border-black/[0.05] px-2.5 py-2 dark:border-white/[0.06]">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[#3a3a3c] dark:text-[#c8cace]">{file.file}</span>
                {file.truncated && <span className="shrink-0 rounded bg-[#d4901f]/10 px-1.5 py-0.5 text-[10.5px] text-[#7a4d00] dark:text-[#f3c46b]">已截断</span>}
              </div>
              {file.excerpt && <div className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-[#86868b] dark:text-[#8a8c93]">{file.excerpt}</div>}
            </div>
          ))}
          {scope.omitted && (
            <div className="border-t border-black/[0.05] px-2.5 py-1.5 text-[11px] text-[#a1a1a6] dark:border-white/[0.06] dark:text-[#6e7077]">
              另有 {scope.omitted} 个目标省略
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const FILE_HISTORY_OPERATION_LABELS: Record<string, string> = {
  write_file: "写入前",
  edit_file: "编辑前",
  edit_excel: "改表前",
  multi_edit_file: "批量编辑前",
  patch_file: "补丁前",
  patch_files: "多文件补丁前",
  restore_file: "恢复前",
};

function FileHistoryCard({ text }: { text: string }) {
  const history = parseFileHistoryResult(text);
  const [openId, setOpenId] = useState<string | null>(null);
  if (!history) return null;
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-black/[0.06] bg-white/70 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
        <History className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        <span className="min-w-0 flex-1 truncate">文件历史</span>
        <span className="shrink-0 font-mono text-[11px] text-[#a1a1a6] dark:text-[#6e7077]">
          {history.status === "empty" ? "空" : history.status === "stored" ? "结果过长" : `${history.snapshots.length} 条`}
        </span>
      </div>
      {history.status === "empty" ? (
        <div className="border-t border-black/[0.05] px-2.5 py-2 text-[12px] leading-relaxed text-[#86868b] dark:border-white/[0.06] dark:text-[#8a8c93]">
          当前会话还没有可恢复的文件快照。
        </div>
      ) : (
        <div>
          {history.stored && (
            <div className="border-t border-black/[0.05] px-2.5 py-2 dark:border-white/[0.06]">
              {history.stored.path ? (
                <div className="truncate font-mono text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">完整结果：{history.stored.path}</div>
              ) : (
                <div className="text-[12px] leading-relaxed text-[#d4901f] dark:text-[#f3c46b]">文件历史结果过长，落盘失败。</div>
              )}
              {history.snapshots.length === 0 && (
                <div className="mt-1 text-[12px] leading-relaxed text-[#86868b] dark:text-[#8a8c93]">
                  头尾预览里没有完整快照行，需要时读取长工具结果窗口。
                </div>
              )}
            </div>
          )}
          {history.snapshots.slice(0, 10).map((snapshot) => {
            const diffOpen = openId === snapshot.id;
            const diffText = snapshot.diff || snapshot.diffError || "";
            return (
              <div key={snapshot.id} className="border-t border-black/[0.05] px-2.5 py-2 dark:border-white/[0.06]">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[#3a3a3c] dark:text-[#c8cace]">{snapshot.path}</span>
                  <span className="shrink-0 rounded bg-black/[0.04] px-1.5 py-0.5 font-mono text-[10.5px] text-[#6e6e73] dark:bg-white/[0.05] dark:text-[#8a8c93]">
                    {snapshot.id.slice(0, 10)}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#a1a1a6] dark:text-[#6e7077]">
                  <span>{FILE_HISTORY_OPERATION_LABELS[snapshot.operation] || snapshot.operation}</span>
                  {snapshot.sequence ? <span>seq {snapshot.sequence}</span> : null}
                  {typeof snapshot.size === "number" ? <span>{snapshot.size.toLocaleString()} bytes</span> : null}
                  {snapshot.beforeMissing ? <span>原文件不存在</span> : null}
                  {snapshot.skippedReason ? <span className="text-[#d4901f] dark:text-[#f3c46b]">{snapshot.skippedReason}</span> : null}
                </div>
                {diffText && (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => setOpenId(diffOpen ? null : snapshot.id)}
                      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
                    >
                      <ChevronRight className={`h-3 w-3 transition-transform ${diffOpen ? "rotate-90" : ""}`} />
                      {diffOpen ? "收起差异" : "展开差异"}
                      {snapshot.diffError ? <span className="text-[#d4901f]">预览失败</span> : null}
                    </button>
                    {diffOpen && (
                      <pre className="mt-1 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.025] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.035] dark:text-[#9a9ca3]">
                        {diffText}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {history.snapshots.length > 10 && (
            <div className="border-t border-black/[0.05] px-2.5 py-1.5 text-[11px] text-[#a1a1a6] dark:border-white/[0.06] dark:text-[#6e7077]">
              另有 {history.snapshots.length - 10} 条快照省略
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RestoreFileCard({ text }: { text: string }) {
  const restore = parseRestoreFileResult(text);
  const [open, setOpen] = useState(false);
  if (!restore) return null;
  const preview = restore.status === "preview";
  const stored = restore.status === "stored" || !!restore.stored;
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-black/[0.06] bg-white/70 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
        <RotateCcw className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        <span className="min-w-0 flex-1 truncate">
          {stored ? "恢复结果已收起" : preview ? "恢复预览" : "已恢复文件"}
          {restore.path ? <span className="text-[#86868b] dark:text-[#6e7077]"> · {restore.path}</span> : null}
        </span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${(preview || stored) ? "bg-[#d4901f]/10 text-[#8a5a00] dark:text-[#f3c46b]" : "bg-[#10a37f]/10 text-[#0b8064] dark:text-[#70d7bd]"}`}>
          {stored ? "结果过长" : preview ? "预览" : "完成"}
        </span>
      </div>
      <div className="border-t border-black/[0.05] px-2.5 py-2 dark:border-white/[0.06]">
        {restore.stored?.resultPath && (
          <div className="truncate font-mono text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">
            完整结果：{restore.stored.resultPath}
          </div>
        )}
        {restore.snapshotId && (
          <div className={`${restore.stored?.resultPath ? "mt-1 " : ""}truncate font-mono text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]`}>
            snapshot {restore.snapshotId}
          </div>
        )}
        {restore.diff && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
              {open ? "收起差异" : "展开差异"}
            </button>
            {open && (
              <pre className="mt-1 max-h-[320px] overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.025] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.035] dark:text-[#9a9ca3]">
                {restore.diff}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function GitStatusCard({ text }: { text: string }) {
  const status = parseGitStatusResult(text);
  const [open, setOpen] = useState(false);
  const [stagedOpen, setStagedOpen] = useState(false);
  const [untrackedOpen, setUntrackedOpen] = useState(false);
  if (!status) return null;
  const statusLines = status.status.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  const changedLines = statusLines.filter((line) => !line.startsWith("##"));
  const changedCount = status.summary?.files ?? changedLines.length;
  const clean = status.isGit && (status.summary?.clean ?? (changedLines.length === 0 || status.status === "(clean)"));
  const summaryItems = status.summary ? [
    { label: `${status.summary.files} 文件`, show: true, warning: false },
    { label: `暂存 ${status.summary.staged}`, show: status.summary.staged > 0, warning: false },
    { label: `未暂存 ${status.summary.worktree}`, show: status.summary.worktree > 0, warning: false },
    { label: `未跟踪 ${status.summary.untracked}`, show: status.summary.untracked > 0, warning: false },
    { label: `冲突 ${status.summary.conflicted}`, show: status.summary.conflicted > 0, warning: true },
  ].filter((item) => item.show) : [];
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-black/[0.06] bg-white/70 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
        {status.isGit ? (
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[#d4901f]" />
        )}
        <span className="min-w-0 flex-1 truncate">
          {status.isGit ? `Git 改动 · ${status.branch || "未知分支"}` : "不是 Git 仓库"}
        </span>
        {status.isGit && (
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${clean ? "bg-[#10a37f]/10 text-[#0b8064] dark:text-[#70d7bd]" : "bg-[#d4901f]/10 text-[#8a5a00] dark:text-[#f3c46b]"}`}>
            {clean ? "clean" : `${changedCount} 改`}
          </span>
        )}
      </div>
      <div className="border-t border-black/[0.05] px-2.5 py-2 dark:border-white/[0.06]">
        {summaryItems.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {summaryItems.map((item) => (
              <span
                key={item.label}
                className={`rounded border px-1.5 py-0.5 text-[11px] ${item.warning ? "border-[#d4901f]/20 bg-[#d4901f]/10 text-[#8a5a00] dark:text-[#f3c46b]" : "border-black/[0.06] bg-black/[0.025] text-[#6e6e73] dark:border-white/[0.06] dark:bg-white/[0.035] dark:text-[#9a9ca3]"}`}
              >
                {item.label}
              </span>
            ))}
          </div>
        )}
        <div className="mb-1 text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">状态</div>
        <pre className="max-h-[120px] overflow-auto whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-[#6e6e73] dark:text-[#9a9ca3]">
          {status.status}
        </pre>
        {status.diffStat && (
          <>
            <div className="mb-1 mt-2 text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">Diff 统计</div>
            <pre className="max-h-[120px] overflow-auto whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-[#6e6e73] dark:text-[#9a9ca3]">
              {status.diffStat}
            </pre>
          </>
        )}
        {status.stored?.path && (
          <div className="mt-2 truncate font-mono text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">
            完整结果：{status.stored.path}
          </div>
        )}
        {status.stagedDiffStat && (
          <>
            <div className="mb-1 mt-2 text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">已暂存 Diff 统计</div>
            <pre className="max-h-[120px] overflow-auto whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-[#6e6e73] dark:text-[#9a9ca3]">
              {status.stagedDiffStat}
            </pre>
          </>
        )}
        {status.diff && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
              {open ? "收起 diff" : "展开 diff"}
              {status.diff.truncated && <span className="text-[#d4901f]">已截断</span>}
            </button>
            {open && (
              <pre className="mt-1 max-h-[360px] overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.025] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.035] dark:text-[#9a9ca3]">
                {status.diff.text}
              </pre>
            )}
          </div>
        )}
        {status.stagedDiff && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setStagedOpen((value) => !value)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${stagedOpen ? "rotate-90" : ""}`} />
              {stagedOpen ? "收起已暂存 diff" : "展开已暂存 diff"}
              {status.stagedDiff.truncated && <span className="text-[#d4901f]">已截断</span>}
            </button>
            {stagedOpen && (
              <pre className="mt-1 max-h-[360px] overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.025] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.035] dark:text-[#9a9ca3]">
                {status.stagedDiff.text}
              </pre>
            )}
          </div>
        )}
        {status.untrackedFiles.length > 0 && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setUntrackedOpen((value) => !value)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${untrackedOpen ? "rotate-90" : ""}`} />
              {untrackedOpen ? "收起未跟踪文件" : `未跟踪文件 ${status.untrackedFiles.length} 个`}
              {status.untrackedTruncated && <span className="text-[#d4901f]">已截断</span>}
            </button>
            {untrackedOpen && (
              <div className="mt-1 overflow-hidden rounded-md bg-black/[0.025] dark:bg-white/[0.035]">
                {status.untrackedFiles.map((file) => (
                  <div key={file.path} className="border-t border-black/[0.05] first:border-t-0 dark:border-white/[0.06]">
                    <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
                      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[#3a3a3c] dark:text-[#c8cace]">{file.path}</span>
                      {file.binary && <span className="shrink-0 text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">binary</span>}
                      {file.truncated && <span className="shrink-0 text-[10.5px] text-[#d4901f]">截断</span>}
                    </div>
                    {file.error ? (
                      <div className="px-2.5 pb-2 text-[12px] text-[#d4901f] dark:text-[#f3c46b]">{file.error}</div>
                    ) : file.content ? (
                      <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap px-2.5 pb-2 font-mono text-[11.5px] leading-relaxed text-[#3a3a3c] dark:text-[#9a9ca3]">
                        {file.content}
                      </pre>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function GitHistoryCard({ text }: { text: string }) {
  const history = parseGitHistoryResult(text);
  const [open, setOpen] = useState(false);
  if (!history) return null;
  const warning = !history.isGit || history.status === "invalid_rev" || history.status === "error";
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-black/[0.06] bg-white/70 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
        <GitBranch className={`h-3.5 w-3.5 shrink-0 ${warning ? "text-[#d4901f]" : "text-[#86868b] dark:text-[#6e7077]"}`} />
        <span className="min-w-0 flex-1 truncate">
          {history.isGit ? `Git 历史 · ${history.rev || "HEAD"}` : "不是 Git 仓库"}
        </span>
        {history.isGit && <span className="shrink-0 font-mono text-[11px] text-[#a1a1a6] dark:text-[#6e7077]">{history.commits.length} commit</span>}
      </div>
      <div className="border-t border-black/[0.05] dark:border-white/[0.06]">
        {history.message && (
          <div className="px-2.5 py-2 text-[12px] leading-relaxed text-[#8a5a00] dark:text-[#f3c46b]">
            {history.message}
          </div>
        )}
        {history.stored?.path && (
          <div className="border-t border-black/[0.05] px-2.5 py-2 font-mono text-[10.5px] text-[#a1a1a6] dark:border-white/[0.06] dark:text-[#6e7077]">
            完整结果：{history.stored.path}
          </div>
        )}
        {history.commits.length > 0 && (
          <div>
            {history.commits.slice(0, 8).map((commit) => (
              <div key={`${commit.sha}-${commit.title}`} className="flex min-w-0 items-start gap-2 border-t border-black/[0.05] px-2.5 py-2 first:border-t-0 dark:border-white/[0.06]">
                <span className="mt-0.5 shrink-0 rounded bg-black/[0.04] px-1.5 py-0.5 font-mono text-[10.5px] text-[#6e6e73] dark:bg-white/[0.05] dark:text-[#8a8c93]">
                  {commit.shortSha || commit.sha.slice(0, 7)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">{commit.title || "(no title)"}</div>
                  <div className="mt-0.5 truncate text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">
                    {[commit.author, commit.date].filter(Boolean).join(" · ")}
                  </div>
                </div>
              </div>
            ))}
            {history.commits.length > 8 && (
              <div className="border-t border-black/[0.05] px-2.5 py-1.5 text-[11px] text-[#a1a1a6] dark:border-white/[0.06] dark:text-[#6e7077]">
                另有 {history.commits.length - 8} 个 commit 省略
              </div>
            )}
          </div>
        )}
        {history.patch && (
          <div className="border-t border-black/[0.05] px-2.5 py-2 dark:border-white/[0.06]">
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
              {open ? "收起 patch" : "展开 patch"}
              {history.patch.truncated && <span className="text-[#d4901f]">已截断</span>}
            </button>
            {open && (
              <pre className="mt-1 max-h-[360px] overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.025] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.035] dark:text-[#9a9ca3]">
                {history.patch.text}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function diagnosticsLabel(status: string, exitCode?: number): string {
  if (status === "completed") return exitCode === 0 ? "通过" : `失败${typeof exitCode === "number" ? ` · exit ${exitCode}` : ""}`;
  if (status === "missing_package_json") return "未找到 package.json";
  if (status === "invalid_package_json") return "package.json 无效";
  if (status === "missing_script") return "未找到脚本";
  if (status === "rejected") return "已拦截";
  if (status === "invalid_test_path") return "测试路径无效";
  if (status === "stored") return "结果过长";
  return status;
}

function ProjectDiagnosticsCard({ text }: { text: string }) {
  const diagnostics = parseProjectDiagnosticsResult(text);
  const [open, setOpen] = useState(false);
  if (!diagnostics) return null;
  const ok = diagnostics.status === "completed" && diagnostics.exitCode === 0 && !diagnostics.timedOut;
  const warning = diagnostics.status !== "completed" || diagnostics.timedOut || diagnostics.truncated || (diagnostics.exitCode !== undefined && diagnostics.exitCode !== 0);
  const badgeClass = ok
    ? "bg-[#10a37f]/10 text-[#0b8064] dark:text-[#70d7bd]"
    : "bg-[#d4901f]/10 text-[#8a5a00] dark:text-[#f3c46b]";
  const title = diagnostics.check ? `项目诊断 · ${diagnostics.check}` : "项目诊断";
  const target = diagnostics.packagePath || diagnostics.start || diagnostics.cwd || "";
  const outputText = diagnostics.output || diagnostics.stored?.previewTail || diagnostics.stored?.previewHead || "";
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-black/[0.06] bg-white/70 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
        <Stethoscope className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        <span className="min-w-0 flex-1 truncate">
          {title}
          {target ? <span className="text-[#86868b] dark:text-[#6e7077]"> · {target}</span> : null}
        </span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${badgeClass}`}>
          {diagnosticsLabel(diagnostics.status, diagnostics.exitCode)}
        </span>
      </div>
      <div className="border-t border-black/[0.05] px-2.5 py-2 dark:border-white/[0.06]">
        <div className="grid grid-cols-2 gap-2 text-[11.5px] text-[#6e6e73] dark:text-[#8a8c93] sm:grid-cols-4">
          {diagnostics.script && <div className="min-w-0 truncate"><span className="text-[#a1a1a6] dark:text-[#6e7077]">脚本</span> {diagnostics.script}</div>}
          {diagnostics.manager && <div className="min-w-0 truncate"><span className="text-[#a1a1a6] dark:text-[#6e7077]">包管理器</span> {diagnostics.manager}</div>}
          {typeof diagnostics.elapsedMs === "number" && <div><span className="text-[#a1a1a6] dark:text-[#6e7077]">耗时</span> {Math.max(1, Math.round(diagnostics.elapsedMs / 1000))}s</div>}
          {typeof diagnostics.exitCode === "number" && <div><span className="text-[#a1a1a6] dark:text-[#6e7077]">退出码</span> {diagnostics.exitCode}</div>}
        </div>
        {diagnostics.reason && (
          <div className="mt-2 rounded-md bg-[#d4901f]/[0.07] px-2.5 py-2 text-[12px] leading-relaxed text-[#7a4d00] dark:text-[#f3c46b]">
            {diagnostics.reason}
          </div>
        )}
        {diagnostics.error && (
          <div className="mt-2 rounded-md bg-[#d4901f]/[0.07] px-2.5 py-2 text-[12px] leading-relaxed text-[#7a4d00] dark:text-[#f3c46b]">
            {diagnostics.error}
          </div>
        )}
        {diagnostics.available && diagnostics.available.length > 0 && (
          <div className="mt-2 text-[12px] leading-relaxed text-[#86868b] dark:text-[#8a8c93]">
            可用脚本：{diagnostics.available.join(" · ")}
          </div>
        )}
        {diagnostics.testTargets && diagnostics.testTargets.length > 0 && (
          <div className="mt-2 min-w-0 text-[12px] leading-relaxed text-[#6e6e73] dark:text-[#8a8c93]">
            <span className="text-[#a1a1a6] dark:text-[#6e7077]">测试范围</span>{" "}
            {diagnostics.testTargets.join(" · ")}
          </div>
        )}
        {diagnostics.testSuggestions && diagnostics.testSuggestions.length > 0 && (
          <div className="mt-2 min-w-0 text-[12px] leading-relaxed text-[#6e6e73] dark:text-[#8a8c93]">
            <span className="text-[#a1a1a6] dark:text-[#6e7077]">附近测试</span>{" "}
            {diagnostics.testSuggestions.map((item) => item.path).join(" · ")}
          </div>
        )}
        {diagnostics.stored?.path && (
          <div className="mt-2 truncate font-mono text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">
            完整结果：{diagnostics.stored.path}
          </div>
        )}
        {diagnostics.command && (
          <div className="mt-2 rounded-md bg-black/[0.025] px-2.5 py-1.5 font-mono text-[11.5px] text-[#6e6e73] dark:bg-white/[0.035] dark:text-[#9a9ca3]">
            {diagnostics.command}
          </div>
        )}
        {outputText && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
              {open ? "收起输出" : "展开输出"}
              {(diagnostics.truncated || diagnostics.stored) && <span className="text-[#d4901f]">已截断</span>}
            </button>
            {open && (
              <pre className="mt-1 max-h-[360px] overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.025] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.035] dark:text-[#9a9ca3]">
                {outputText}
              </pre>
            )}
          </div>
        )}
        {warning && !outputText && !diagnostics.reason && (
          <div className="mt-2 text-[12px] leading-relaxed text-[#86868b] dark:text-[#8a8c93]">
            诊断未通过，未返回可展示输出。
          </div>
        )}
      </div>
    </div>
  );
}

function rangeLabel(range: { start_line?: number; end_line?: number }): string {
  if (typeof range.start_line === "number" && typeof range.end_line === "number") return `L${range.start_line}-${range.end_line}`;
  if (typeof range.start_line === "number") return `L${range.start_line}+`;
  if (typeof range.end_line === "number") return `L1-${range.end_line}`;
  return "";
}

function GrepRangesCard({ text }: { text: string }) {
  const result = parseGrepRangesResult(text);
  const [inputOpen, setInputOpen] = useState(false);
  const [matchesOpen, setMatchesOpen] = useState(false);
  if (!result) return null;
  const ranges = result.readManyFilesInput?.ranges ?? [];
  const visibleRanges = ranges.slice(0, 6);
  const readInput = result.readManyFilesInput ? JSON.stringify(result.readManyFilesInput, null, 2) : "";
  const badgeText = [
    typeof result.matches === "number" ? `${result.matches} 命中` : "",
    typeof result.ranges === "number" ? `${result.ranges} 范围` : "",
  ].filter(Boolean).join(" · ") || "已生成范围";
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-black/[0.06] bg-white/70 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
        <Search className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        <span className="min-w-0 flex-1 truncate">
          代码搜索范围
          {typeof result.rangeContext === "number" ? <span className="text-[#86868b] dark:text-[#6e7077]"> · 上下文 {result.rangeContext}</span> : null}
        </span>
        <span className="shrink-0 rounded bg-[#10a37f]/10 px-1.5 py-0.5 text-[11px] text-[#0b8064] dark:text-[#70d7bd]">
          {badgeText}
        </span>
      </div>
      <div className="border-t border-black/[0.05] px-2.5 py-2 dark:border-white/[0.06]">
        {visibleRanges.length > 0 ? (
          <div className="overflow-hidden rounded-md bg-black/[0.025] dark:bg-white/[0.035]">
            {visibleRanges.map((range, index) => (
              <div key={`${range.path}-${range.start_line ?? ""}-${range.end_line ?? ""}-${index}`} className="flex min-w-0 items-center gap-2 border-t border-black/[0.05] px-2.5 py-1.5 first:border-t-0 dark:border-white/[0.06]">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[#3a3a3c] dark:text-[#c8cace]">{range.path}</span>
                {rangeLabel(range) && <span className="shrink-0 font-mono text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">{rangeLabel(range)}</span>}
              </div>
            ))}
            {ranges.length > visibleRanges.length && (
              <div className="border-t border-black/[0.05] px-2.5 py-1.5 text-[11px] text-[#a1a1a6] dark:border-white/[0.06] dark:text-[#6e7077]">
                另有 {ranges.length - visibleRanges.length} 个范围省略
              </div>
            )}
          </div>
        ) : (
          <div className="text-[12px] leading-relaxed text-[#86868b] dark:text-[#8a8c93]">
            未返回可直接读取的范围。
          </div>
        )}
        {result.notes.length > 0 && (
          <div className="mt-2 space-y-1">
            {result.notes.map((note, index) => (
              <div key={`${note}-${index}`} className="rounded-md bg-[#d4901f]/[0.07] px-2.5 py-1.5 text-[11.5px] leading-relaxed text-[#8a5a00] dark:text-[#f3c46b]">
                {note}
              </div>
            ))}
          </div>
        )}
        {readInput && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setInputOpen((value) => !value)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${inputOpen ? "rotate-90" : ""}`} />
              {inputOpen ? "收起 read_many_files 输入" : "展开 read_many_files 输入"}
            </button>
            {inputOpen && (
              <pre className="mt-1 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.025] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.035] dark:text-[#9a9ca3]">
                {readInput}
              </pre>
            )}
          </div>
        )}
        {result.matchedLines.length > 0 && (
          <div className="mt-1">
            <button
              type="button"
              onClick={() => setMatchesOpen((value) => !value)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${matchesOpen ? "rotate-90" : ""}`} />
              {matchesOpen ? "收起命中行" : "展开命中行"}
            </button>
            {matchesOpen && (
              <pre className="mt-1 max-h-[220px] overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.025] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.035] dark:text-[#9a9ca3]">
                {result.matchedLines.join("\n")}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CodeOutlineRangesCard({ text }: { text: string }) {
  const result = parseCodeOutlineRangesResult(text);
  const [inputOpen, setInputOpen] = useState(false);
  const [symbolsOpen, setSymbolsOpen] = useState(false);
  if (!result) return null;
  const ranges = result.readManyFilesInput?.ranges ?? [];
  const visibleRanges = ranges.slice(0, 6);
  const readInput = result.readManyFilesInput ? JSON.stringify(result.readManyFilesInput, null, 2) : "";
  const badgeText = [
    typeof result.files === "number" ? `${result.files} 文件` : "",
    `${ranges.length} 范围`,
  ].filter(Boolean).join(" · ");
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-black/[0.06] bg-white/70 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
        <ClipboardList className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        <span className="min-w-0 flex-1 truncate">
          代码结构范围
          {typeof result.rangeContext === "number" ? <span className="text-[#86868b] dark:text-[#6e7077]"> · 上下文 {result.rangeContext}</span> : null}
        </span>
        <span className="shrink-0 rounded bg-[#10a37f]/10 px-1.5 py-0.5 text-[11px] text-[#0b8064] dark:text-[#70d7bd]">
          {badgeText}
        </span>
      </div>
      <div className="border-t border-black/[0.05] px-2.5 py-2 dark:border-white/[0.06]">
        <div className="overflow-hidden rounded-md bg-black/[0.025] dark:bg-white/[0.035]">
          {visibleRanges.map((range, index) => (
            <div key={`${range.path}-${range.start_line ?? ""}-${range.end_line ?? ""}-${index}`} className="flex min-w-0 items-center gap-2 border-t border-black/[0.05] px-2.5 py-1.5 first:border-t-0 dark:border-white/[0.06]">
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[#3a3a3c] dark:text-[#c8cace]">{range.path}</span>
              {rangeLabel(range) && <span className="shrink-0 font-mono text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">{rangeLabel(range)}</span>}
            </div>
          ))}
          {ranges.length > visibleRanges.length && (
            <div className="border-t border-black/[0.05] px-2.5 py-1.5 text-[11px] text-[#a1a1a6] dark:border-white/[0.06] dark:text-[#6e7077]">
              另有 {ranges.length - visibleRanges.length} 个范围省略
            </div>
          )}
        </div>
        {typeof result.omitted === "number" && result.omitted > 0 && (
          <div className="mt-2 rounded-md bg-[#d4901f]/[0.07] px-2.5 py-1.5 text-[11.5px] leading-relaxed text-[#8a5a00] dark:text-[#f3c46b]">
            另有 {result.omitted} 个文件未展开。
          </div>
        )}
        {readInput && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setInputOpen((value) => !value)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${inputOpen ? "rotate-90" : ""}`} />
              {inputOpen ? "收起 read_many_files 输入" : "展开 read_many_files 输入"}
            </button>
            {inputOpen && (
              <pre className="mt-1 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.025] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.035] dark:text-[#9a9ca3]">
                {readInput}
              </pre>
            )}
          </div>
        )}
        {result.symbolLines.length > 0 && (
          <div className="mt-1">
            <button
              type="button"
              onClick={() => setSymbolsOpen((value) => !value)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${symbolsOpen ? "rotate-90" : ""}`} />
              {symbolsOpen ? "收起符号行" : "展开符号行"}
            </button>
            {symbolsOpen && (
              <pre className="mt-1 max-h-[220px] overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.025] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.035] dark:text-[#9a9ca3]">
                {result.symbolLines.join("\n")}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function mcpTraceLabel(item: McpTaskTraceItem): string {
  if (item.kind === "task") {
    const head = item.event === "created" ? "创建" : "状态";
    return [head, item.status, item.message].filter(Boolean).join(" · ");
  }
  if (item.kind === "progress") {
    const count = typeof item.progress === "number"
      ? `${item.progress}${typeof item.total === "number" ? `/${item.total}` : ""}`
      : "";
    return [count, item.message].filter(Boolean).join(" · ") || "进度";
  }
  return item.raw || "";
}

function McpTaskResultCard({ text }: { text: string }) {
  const result = parseMcpTaskResult(text);
  const [traceOpen, setTraceOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  if (!result) return null;
  const lastTask = [...result.trace].reverse().find((item) => item.kind === "task" && item.status);
  const status = result.isError ? "错误" : lastTask?.status || "完成";
  const badgeClass = result.isError
    ? "bg-[#d4901f]/10 text-[#8a5a00] dark:text-[#f3c46b]"
    : "bg-[#10a37f]/10 text-[#0b8064] dark:text-[#70d7bd]";
  const resultPreview = result.result.replace(/\s+/g, " ").trim();
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-black/[0.06] bg-white/70 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
        <Wrench className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        <span className="min-w-0 flex-1 truncate">
          MCP 任务
          <span className="text-[#86868b] dark:text-[#6e7077]"> · {result.server}{result.tool ? ` · ${result.tool}` : ""}</span>
        </span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${badgeClass}`}>
          {status}
        </span>
      </div>
      <div className="border-t border-black/[0.05] px-2.5 py-2 dark:border-white/[0.06]">
        {resultPreview && (
          <div className="truncate text-[12px] text-[#6e6e73] dark:text-[#8a8c93]">
            {resultPreview.length > 140 ? `${resultPreview.slice(0, 140)}…` : resultPreview}
          </div>
        )}
        {result.trace.length > 0 && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setTraceOpen((value) => !value)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${traceOpen ? "rotate-90" : ""}`} />
              {traceOpen ? "收起过程" : `展开过程 ${result.trace.length} 条`}
            </button>
            {traceOpen && (
              <div className="mt-1 overflow-hidden rounded-md bg-black/[0.025] dark:bg-white/[0.035]">
                {result.trace.slice(-10).map((item, index) => (
                  <div key={`${item.kind}-${index}-${mcpTraceLabel(item)}`} className="flex min-w-0 items-center gap-2 border-t border-black/[0.05] px-2.5 py-1.5 first:border-t-0 dark:border-white/[0.06]">
                    <span className="shrink-0 rounded border border-black/[0.06] px-1.5 py-0.5 text-[10.5px] text-[#86868b] dark:border-white/[0.08] dark:text-[#8a8c93]">
                      {item.kind === "task" ? "任务" : item.kind === "progress" ? "进度" : "过程"}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-[#3a3a3c] dark:text-[#c8cace]">{mcpTraceLabel(item)}</span>
                    {item.kind === "task" && item.id && <span className="shrink-0 font-mono text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">{item.id}</span>}
                  </div>
                ))}
                {result.trace.length > 10 && (
                  <div className="border-t border-black/[0.05] px-2.5 py-1.5 text-[11px] text-[#a1a1a6] dark:border-white/[0.06] dark:text-[#6e7077]">
                    另有 {result.trace.length - 10} 条过程省略
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {result.result && (
          <div className="mt-1">
            <button
              type="button"
              onClick={() => setResultOpen((value) => !value)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${resultOpen ? "rotate-90" : ""}`} />
              {resultOpen ? "收起结果" : "展开结果"}
            </button>
            {resultOpen && (
              <pre className="mt-1 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.025] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.035] dark:text-[#9a9ca3]">
                {result.result}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function McpResultCard({ text }: { text: string }) {
  const result = parseMcpResult(text);
  const [open, setOpen] = useState(false);
  if (!result) return null;
  const badgeClass = result.isError
    ? "bg-[#d4901f]/10 text-[#8a5a00] dark:text-[#f3c46b]"
    : "bg-[#10a37f]/10 text-[#0b8064] dark:text-[#70d7bd]";
  const preview = result.result.replace(/\s+/g, " ").trim();
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-black/[0.06] bg-white/70 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
        <Wrench className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        <span className="min-w-0 flex-1 truncate">
          MCP 结果
          <span className="text-[#86868b] dark:text-[#6e7077]"> · {result.server}{result.tool ? ` · ${result.tool}` : ""}</span>
        </span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${badgeClass}`}>
          {result.isError ? "错误" : "完成"}
        </span>
      </div>
      <div className="border-t border-black/[0.05] px-2.5 py-2 dark:border-white/[0.06]">
        {preview && (
          <div className="truncate text-[12px] text-[#6e6e73] dark:text-[#8a8c93]">
            {preview.length > 140 ? `${preview.slice(0, 140)}…` : preview}
          </div>
        )}
        {result.result && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
              {open ? "收起结果" : "展开结果"}
            </button>
            {open && (
              <pre className="mt-1 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.025] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.035] dark:text-[#9a9ca3]">
                {result.result}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function McpResourceListCard({ text }: { text: string }) {
  const result = parseMcpResourceList(text);
  const [open, setOpen] = useState(false);
  if (!result) return null;
  const visible = result.entries.slice(0, 6);
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-black/[0.06] bg-white/70 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        <span className="min-w-0 flex-1 truncate">MCP 资源 <span className="text-[#86868b] dark:text-[#6e7077]">· {result.server}</span></span>
        <span className="shrink-0 rounded bg-[#10a37f]/10 px-1.5 py-0.5 text-[11px] text-[#0b8064] dark:text-[#70d7bd]">{result.entries.length} 项</span>
      </div>
      <div className="border-t border-black/[0.05] px-2.5 py-2 dark:border-white/[0.06]">
        <div className="overflow-hidden rounded-md bg-black/[0.025] dark:bg-white/[0.035]">
          {visible.map((entry, index) => (
            <div key={`${entry.kind}-${entry.uri || entry.uriTemplate || entry.name}-${index}`} className="flex min-w-0 items-center gap-2 border-t border-black/[0.05] px-2.5 py-1.5 first:border-t-0 dark:border-white/[0.06]">
              <span className="shrink-0 rounded border border-black/[0.06] px-1.5 py-0.5 text-[10.5px] text-[#86868b] dark:border-white/[0.08] dark:text-[#8a8c93]">{entry.kind === "template" ? "模板" : "资源"}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[#3a3a3c] dark:text-[#c8cace]">{entry.uri || entry.uriTemplate || entry.name}</span>
              {entry.mimeType && <span className="shrink-0 text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">{entry.mimeType}</span>}
            </div>
          ))}
          {result.entries.length > visible.length && <div className="border-t border-black/[0.05] px-2.5 py-1.5 text-[11px] text-[#a1a1a6] dark:border-white/[0.06] dark:text-[#6e7077]">另有 {result.entries.length - visible.length} 项省略</div>}
        </div>
        <button type="button" onClick={() => setOpen((value) => !value)} className="mt-2 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10">
          <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />{open ? "收起详情" : "展开详情"}
        </button>
        {open && <pre className="mt-1 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.025] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.035] dark:text-[#9a9ca3]">{text}</pre>}
      </div>
    </div>
  );
}

function McpResourceReadCard({ text }: { text: string }) {
  const result = parseMcpResourceRead(text);
  const [open, setOpen] = useState(false);
  if (!result) return null;
  const preview = result.content.replace(/\s+/g, " ").trim();
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-black/[0.06] bg-white/70 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        <span className="min-w-0 flex-1 truncate">MCP 资源内容 <span className="text-[#86868b] dark:text-[#6e7077]">· {result.server} · {result.uri}</span></span>
      </div>
      <div className="border-t border-black/[0.05] px-2.5 py-2 dark:border-white/[0.06]">
        {preview && <div className="truncate text-[12px] text-[#6e6e73] dark:text-[#8a8c93]">{preview.length > 140 ? `${preview.slice(0, 140)}…` : preview}</div>}
        {result.content && (
          <div className="mt-2">
            <button type="button" onClick={() => setOpen((value) => !value)} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10">
              <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />{open ? "收起内容" : "展开内容"}
            </button>
            {open && <pre className="mt-1 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.025] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.035] dark:text-[#9a9ca3]">{result.content}</pre>}
          </div>
        )}
      </div>
    </div>
  );
}

function McpPromptListCard({ text }: { text: string }) {
  const result = parseMcpPromptList(text);
  if (!result) return null;
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-black/[0.06] bg-white/70 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
        <MessageSquareText className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        <span className="min-w-0 flex-1 truncate">MCP Prompt <span className="text-[#86868b] dark:text-[#6e7077]">· {result.server}</span></span>
        <span className="shrink-0 rounded bg-[#10a37f]/10 px-1.5 py-0.5 text-[11px] text-[#0b8064] dark:text-[#70d7bd]">{result.prompts.length} 项</span>
      </div>
      <div className="border-t border-black/[0.05] dark:border-white/[0.06]">
        {result.prompts.slice(0, 8).map((prompt, index) => (
          <div key={`${prompt.name}-${index}`} className="flex min-w-0 items-start gap-2 border-t border-black/[0.05] px-2.5 py-2 first:border-t-0 dark:border-white/[0.06]">
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">{prompt.name}</span>
            {prompt.args.length > 0 && <span className="shrink-0 font-mono text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">{prompt.args.join(",")}</span>}
          </div>
        ))}
        {result.prompts.length > 8 && <div className="border-t border-black/[0.05] px-2.5 py-1.5 text-[11px] text-[#a1a1a6] dark:border-white/[0.06] dark:text-[#6e7077]">另有 {result.prompts.length - 8} 项省略</div>}
      </div>
    </div>
  );
}

function McpPromptReadCard({ text }: { text: string }) {
  const result = parseMcpPromptRead(text);
  const [open, setOpen] = useState(false);
  if (!result) return null;
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-black/[0.06] bg-white/70 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
        <MessageSquareText className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        <span className="min-w-0 flex-1 truncate">MCP Prompt 内容 <span className="text-[#86868b] dark:text-[#6e7077]">· {result.server} · {result.name}</span></span>
        <span className="shrink-0 rounded bg-[#10a37f]/10 px-1.5 py-0.5 text-[11px] text-[#0b8064] dark:text-[#70d7bd]">{result.messages.length} 消息</span>
      </div>
      <div className="border-t border-black/[0.05] px-2.5 py-2 dark:border-white/[0.06]">
        {result.description && <div className="text-[12px] text-[#6e6e73] dark:text-[#8a8c93]">{result.description}</div>}
        <button type="button" onClick={() => setOpen((value) => !value)} className="mt-2 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10">
          <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />{open ? "收起消息" : "展开消息"}
        </button>
        {open && (
          <div className="mt-1 overflow-hidden rounded-md bg-black/[0.025] dark:bg-white/[0.035]">
            {result.messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className="border-t border-black/[0.05] px-2.5 py-2 first:border-t-0 dark:border-white/[0.06]">
                <div className="mb-1 font-mono text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">{message.role}</div>
                <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-[#3a3a3c] dark:text-[#9a9ca3]">{message.content}</pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatCount(value: number | undefined, suffix: string): string | null {
  if (typeof value !== "number") return null;
  return `${value.toLocaleString()} ${suffix}`;
}

function StoredToolResultCard({ text }: { text: string }) {
  const stored = parseStoredToolResult(text);
  const [open, setOpen] = useState(false);
  if (!stored) return null;
  const { label } = toolMeta(stored.tool);
  const preview = [
    stored.previewHead ? `--- head ---\n${stored.previewHead}` : "",
    stored.previewTail ? `--- tail ---\n${stored.previewTail}` : "",
  ].filter(Boolean).join("\n\n");
  const sizeText = [formatCount(stored.chars, "chars"), formatCount(stored.bytes, "bytes")].filter(Boolean).join(" · ");
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-black/[0.06] bg-white/70 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
        <Save className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        <span className="min-w-0 flex-1 truncate">
          工具结果已收起
          <span className="text-[#86868b] dark:text-[#6e7077]"> · {label}</span>
        </span>
        {sizeText && <span className="shrink-0 font-mono text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">{sizeText}</span>}
      </div>
      <div className="border-t border-black/[0.05] px-2.5 py-2 dark:border-white/[0.06]">
        {stored.path ? (
          <div className="truncate font-mono text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">完整结果：{stored.path}</div>
        ) : (
          <div className="text-[12px] leading-relaxed text-[#d4901f] dark:text-[#f3c46b]">
            结果过长，落盘失败{stored.storageError ? `：${stored.storageError}` : ""}。
          </div>
        )}
        {preview && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
              {open ? "收起预览" : "展开预览"}
            </button>
            {open && (
              <pre className="mt-1 max-h-[320px] overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.025] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.035] dark:text-[#9a9ca3]">
                {preview}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StoredToolResultReadCard({ text }: { text: string }) {
  const result = parseStoredToolResultRead(text);
  const [open, setOpen] = useState(false);
  if (!result) return null;
  const ok = result.status === "completed";
  const windowText = [
    typeof result.offset === "number" ? `offset ${result.offset.toLocaleString()}` : "",
    typeof result.bytes === "number" ? `${result.bytes.toLocaleString()} bytes` : "",
    typeof result.size === "number" ? `size ${result.size.toLocaleString()}` : "",
  ].filter(Boolean).join(" · ");
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-black/[0.06] bg-white/70 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
        <FileText className={`h-3.5 w-3.5 shrink-0 ${ok ? "text-[#86868b] dark:text-[#6e7077]" : "text-[#d4901f]"}`} />
        <span className="min-w-0 flex-1 truncate">
          长工具结果窗口
          {result.path ? <span className="text-[#86868b] dark:text-[#6e7077]"> · {result.path}</span> : null}
        </span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${ok ? "bg-[#10a37f]/10 text-[#0b8064] dark:text-[#70d7bd]" : "bg-[#d4901f]/10 text-[#8a5a00] dark:text-[#f3c46b]"}`}>
          {ok ? "已读取" : result.status}
        </span>
      </div>
      <div className="border-t border-black/[0.05] px-2.5 py-2 dark:border-white/[0.06]">
        {windowText && <div className="font-mono text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">{windowText}</div>}
        {(result.truncatedTop || result.truncatedBottom) && (
          <div className="mt-1 text-[11.5px] text-[#d4901f] dark:text-[#f3c46b]">
            {result.truncatedTop ? "顶部已省略" : ""}{result.truncatedTop && result.truncatedBottom ? " · " : ""}{result.truncatedBottom ? "底部已省略" : ""}
          </div>
        )}
        {result.content && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
              {open ? "收起内容" : "展开内容"}
            </button>
            {open && (
              <pre className="mt-1 max-h-[360px] overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.025] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.035] dark:text-[#9a9ca3]">
                {result.content}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** F.1 思考块：保留透明度，但默认折叠，避免普通用户被 raw reasoning 淹没。 */
function ThinkingBlock({ text, active, defaultOpen }: { text: string; active?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  if (!text && !active) return null;
  return (
    <div className="ml-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 font-mono text-[11.5px] text-[#a1a1a6] transition hover:text-[#6e6e73] dark:text-[#6e7077] dark:hover:text-[#9a9ca3]"
      >
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <Brain className="h-3 w-3 shrink-0" />
        <span>{active ? "思考中…" : "已思考"}</span>
        {active && <span className="animate-pulse">▍</span>}
      </button>
      {open && text && (
        <div className="mt-1 whitespace-pre-wrap border-l-2 border-black/[0.06] pl-2.5 text-[12.5px] italic leading-relaxed text-[#86868b] dark:border-white/[0.08] dark:text-[#6e7077]">
          {text}
        </div>
      )}
    </div>
  );
}

/** todo_write 的结果（☐待办 / ◐进行中 / ☑已完成）渲染成常驻可见的清单卡（不折叠）。 */
function TodoCard({ text }: { text: string }) {
  return (
    <div className="ml-5 rounded-md border border-black/[0.06] bg-black/[0.02] px-3 py-2 dark:border-white/[0.06] dark:bg-white/[0.02]">
      <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-[#3a3a3c] dark:text-[#c8cace]">{text}</pre>
    </div>
  );
}

function RetryStatusBanner({ status }: { status: AgentRetryStatus }) {
  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-[#d4901f]/20 bg-[#d4901f]/[0.055] px-2.5 py-1.5 text-[12.5px] leading-relaxed text-[#7a5520] dark:border-[#d4901f]/25 dark:bg-[#d4901f]/10 dark:text-[#d8b06f]">
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      <span className="truncate">{retryStatusText(status)}</span>
    </div>
  );
}

type ToolStepGroup = {
  tool: string;
  steps: ToolStep[];
  firstIndex: number;
};

function stepStatus(step: ToolStep, active: boolean): ToolActionStatus {
  if (active && !step.done) return "running";
  return step.done ? "done" : "pending";
}

function groupStatus(steps: ToolStep[], active: boolean): ToolActionStatus {
  if (steps.some((step) => stepStatus(step, active) === "running")) return "running";
  if (steps.every((step) => step.done)) return "done";
  return "pending";
}

function buildToolStepGroups(steps: ToolStep[]): ToolStepGroup[] {
  const groups: ToolStepGroup[] = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (last && last.tool === step.tool) {
      last.steps.push(step);
    } else {
      groups.push({ tool: step.tool, steps: [step], firstIndex: groups.reduce((sum, group) => sum + group.steps.length, 0) });
    }
  }
  return groups;
}

function stringArg(args: Record<string, unknown> | undefined, names: string[]): string {
  for (const name of names) {
    const value = args?.[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function shortArg(value: string, max = 52): string {
  if (!value) return "";
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

function stepHint(step: ToolStep): string {
  if (step.tool === "run_command" || step.tool === "run_background") return shortArg(stringArg(step.args, ["command"]), 72);
  if (step.tool.startsWith("mcp__")) return shortArg(stringArg(step.args, ["query", "name", "path", "uri"]), 52);
  return shortArg(stringArg(step.args, ["path", "file_path", "query", "pattern", "name", "topic", "url"]), 52);
}

function groupHint(steps: ToolStep[]): string {
  const hints = steps.map(stepHint).filter(Boolean);
  if (!hints.length) return "";
  const unique = Array.from(new Set(hints));
  const text = unique.slice(0, 3).join(" · ");
  return unique.length > 3 ? `${text} · +${unique.length - 3}` : text;
}

function latestRunningStep(steps: ToolStep[]): ToolStep | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (!steps[index].done) return steps[index];
  }
  return undefined;
}

function ToolStepRow({
  step,
  active,
  onPreview,
  onOpenBackgroundTask,
  compact = false,
}: {
  step: ToolStep;
  active: boolean;
  onPreview?: (item: PreviewItem) => void;
  onOpenBackgroundTask?: (taskId: string) => void;
  compact?: boolean;
}) {
  const { label, Icon } = toolMeta(step.tool);
  const status = stepStatus(step, active);
  const running = status === "running";
  // P1-8 + B.1：内部/指令类工具（用技能/检索）结果是给 AI 看的原文，对老板零价值还吓人 → 绝不 dump、不进右侧。
  const isInternal = INTERNAL_TOOLS.has(step.tool);
  // 非成品、非内部工具（跑命令/抓网页/搜文件/读文件…）才把结果摊开展示；成品走成品卡，内部只留一行标签。
  // F4 Focus Chain：todo_write 的清单另有常驻卡片展示（见 message.todo / liveTodo，原地更新同一张），
  // 这里只留"列任务清单"这一行步骤标签，不重复摊开原文——避免同一份清单出现两遍。
  const showSubagentTrace = step.tool === "agent_task" && (!!step.progress || !!step.result);
  const showBackgroundTaskStarted = step.tool === "start_background_agent_task" && !!parseBackgroundTaskStarted(step.result);
  const showResult = step.done && !!step.result && !showSubagentTrace && !showBackgroundTaskStarted && !DELIVERABLE_TOOLS.has(step.tool) && !isInternal && step.tool !== "todo_write";
  const showStoreDocSources = showResult && step.tool === "search_store_docs" && !!parseStoreDocSources(step.result);
  const showProjectInstructionScope = showResult && step.tool === "list_project_instructions" && !!parseProjectInstructionScope(step.result);
  const showGitStatus = showResult && step.tool === "git_status" && !!parseGitStatusResult(step.result);
  const showGitHistory = showResult && step.tool === "git_history" && !!parseGitHistoryResult(step.result);
  const showProjectDiagnostics = showResult && step.tool === "project_diagnostics" && !!parseProjectDiagnosticsResult(step.result);
  const showStoredToolResultRead = showResult && (step.tool === "read_stored_tool_result" || step.tool === "read_agent_task_stored_result") && !!parseStoredToolResultRead(step.result);
  const showFileHistory = showResult && step.tool === "file_history" && !!parseFileHistoryResult(step.result);
  const showRestoreFile = showResult && step.tool === "restore_file" && !!parseRestoreFileResult(step.result);
  const showGrepRanges = showResult && step.tool === "grep_files" && !!parseGrepRangesResult(step.result);
  const showCodeOutlineRanges = showResult && step.tool === "code_outline" && !!parseCodeOutlineRangesResult(step.result);
  const showMcpTaskResult = showResult && step.tool.startsWith("mcp__") && !!parseMcpTaskResult(step.result);
  const showMcpResult = showResult && step.tool.startsWith("mcp__") && !showMcpTaskResult && !!parseMcpResult(step.result);
  const showMcpResourceList = showResult && step.tool === "list_mcp_resources" && !!parseMcpResourceList(step.result);
  const showMcpResourceRead = showResult && step.tool === "read_mcp_resource" && !!parseMcpResourceRead(step.result);
  const showMcpPromptList = showResult && step.tool === "list_mcp_prompts" && !!parseMcpPromptList(step.result);
  const showMcpPromptRead = showResult && step.tool === "read_mcp_prompt" && !!parseMcpPromptRead(step.result);
  const showStoredToolResult = showResult && !showGitStatus && !showGitHistory && !showProjectDiagnostics && !showFileHistory && !showRestoreFile && !showGrepRanges && !showCodeOutlineRanges && !showMcpTaskResult && !showMcpResult && !showMcpResourceList && !showMcpResourceRead && !showMcpPromptList && !showMcpPromptRead && !!parseStoredToolResult(step.result);
  // 命令边跑边显示：未结束 + 已有实时输出 → 渲染滚动中的终端块
  const showLiveCmd = !step.done && step.tool === "run_command" && !!step.progress;
  const cmdText = typeof step.args?.command === "string" ? step.args.command : "";
  // P0-1 任意工具进度:非命令工具(抓网页/子代理/生图/视频…)的实时进度用大白话单行露出,
  // 不套终端块(那是命令专用)。后端 handler 经 ctx.progress_emit 推大白话短句、这里只取最新一句。
  const liveNote = (!showSubagentTrace && !step.done && step.tool !== "run_command" && typeof step.progress === "string")
    ? (step.progress.split("\n").map((x) => x.trim()).filter(Boolean).pop() || "")
    : "";
  // 内部工具补一句人话副标题（用了哪个技能/查了什么）——从 args 取，绝不从结果原文截（截出来是乱码/指令稿）。
  const internalNote = isInternal
    ? (typeof step.args?.skill === "string" ? step.args.skill
      : typeof step.args?.name === "string" ? step.args.name
      : typeof step.args?.topic === "string" ? step.args.topic
      : typeof step.args?.query === "string" ? step.args.query : "")
    : "";
  const note = internalNote || stepHint(step);
  // B.1：右侧只接"真有本机文件路径"的结果；任意工具文本不再借 file 兜底污染右侧成品台。
  const fileChanges = fileChangesFromToolStep(step);
  const fileChange = fileChanges[0];
  const filePath = fileChange?.path
    ?? stringArg(step.args, ["file_path", "path"]);
  const dotClass = running
    ? "animate-pulse text-[#d4901f]"
    : step.done ? "text-[#10a37f]" : "text-[#b0b0b5] dark:text-[#56585f]";

  return (
    <div className={`flex flex-col gap-1 ${compact ? "ml-5 border-l border-black/[0.06] pl-3 dark:border-white/[0.06]" : ""}`}>
      <div className="flex min-w-0 items-center gap-2 text-[13px] text-[#3a3a3c] dark:text-[#9a9ca3]">
        <span className={`shrink-0 text-[9px] leading-none ${dotClass}`}>⏺</span>
        <Icon className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        <span className="min-w-0 truncate">
          {toolActionText(step.tool, status)}
          {note ? <span className="text-[#86868b] dark:text-[#6e7077]"> · {note}</span> : null}
        </span>
        {running && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[#b0b0b5] dark:text-[#56585f]" />}
      </div>
      {showLiveCmd && <LiveTerminalBlock command={cmdText} output={step.progress as string} />}
      {liveNote && <div className="ml-5 text-[12px] leading-relaxed text-[#86868b] dark:text-[#6e7077]">{liveNote}</div>}
      {showSubagentTrace && <SubagentTraceCard step={step} active={active} />}
      {showBackgroundTaskStarted && <BackgroundTaskStartedCard step={step} onOpenBackgroundTask={onOpenBackgroundTask} />}
      {showStoreDocSources && <StoreDocSourcesCard text={step.result as string} onPreview={onPreview} />}
      {showProjectInstructionScope && <ProjectInstructionScopeCard text={step.result as string} />}
      {showGitStatus && <GitStatusCard text={step.result as string} />}
      {showGitHistory && <GitHistoryCard text={step.result as string} />}
      {showProjectDiagnostics && <ProjectDiagnosticsCard text={step.result as string} />}
      {showStoredToolResultRead && <StoredToolResultReadCard text={step.result as string} />}
      {showFileHistory && <FileHistoryCard text={step.result as string} />}
      {showRestoreFile && <RestoreFileCard text={step.result as string} />}
      {showGrepRanges && <GrepRangesCard text={step.result as string} />}
      {showCodeOutlineRanges && <CodeOutlineRangesCard text={step.result as string} />}
      {showMcpTaskResult && <McpTaskResultCard text={step.result as string} />}
      {showMcpResult && <McpResultCard text={step.result as string} />}
      {showMcpResourceList && <McpResourceListCard text={step.result as string} />}
      {showMcpResourceRead && <McpResourceReadCard text={step.result as string} />}
      {showMcpPromptList && <McpPromptListCard text={step.result as string} />}
      {showMcpPromptRead && <McpPromptReadCard text={step.result as string} />}
      {showStoredToolResult && <StoredToolResultCard text={step.result as string} />}
      {showResult && !showStoreDocSources && !showProjectInstructionScope && !showGitStatus && !showGitHistory && !showProjectDiagnostics && !showStoredToolResultRead && !showFileHistory && !showRestoreFile && !showGrepRanges && !showCodeOutlineRanges && !showMcpTaskResult && !showMcpResult && !showMcpResourceList && !showMcpResourceRead && !showMcpPromptList && !showMcpPromptRead && !showStoredToolResult &&
        (step.tool === "run_command" ? (
          <TerminalBlock text={step.result as string} />
        ) : (
          <ResultDisclosure
            text={step.result as string}
            onOpen={(onPreview && filePath) ? () => {
              const p = filePath as string;
              if (FILE_MUTATION_TOOLS.has(step.tool) && fileChanges.length > 1) {
                onPreview({ kind: "diff_list", title: label, changes: fileChanges });
              } else {
                onPreview(previewItemForLocalPath(label, p, step.result as string, {
                  backupPath: fileChange?.backupPath,
                  mutation: FILE_MUTATION_TOOLS.has(step.tool),
                }));
              }
            } : undefined}
          />
        ))}
    </div>
  );
}

function ToolStepGroupRow({
  group,
  active,
  onPreview,
  onOpenBackgroundTask,
}: {
  group: ToolStepGroup;
  active: boolean;
  onPreview?: (item: PreviewItem) => void;
  onOpenBackgroundTask?: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(groupStatus(group.steps, active) === "running");
  const { Icon } = toolMeta(group.tool);
  const status = groupStatus(group.steps, active);
  const doneCount = group.steps.filter((step) => step.done).length;
  const hint = groupHint(group.steps);
  const dotClass = status === "running"
    ? "animate-pulse text-[#d4901f]"
    : status === "done" ? "text-[#10a37f]" : "text-[#b0b0b5] dark:text-[#56585f]";

  useEffect(() => {
    if (status === "running") setOpen(true);
  }, [status]);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex min-w-0 items-center gap-2 text-left text-[13px] text-[#3a3a3c] dark:text-[#9a9ca3]"
      >
        <span className={`shrink-0 text-[9px] leading-none ${dotClass}`}>⏺</span>
        <Icon className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
        <span className="min-w-0 flex-1 truncate">
          {toolActionText(group.tool, status, group.steps.length)}
          {hint ? <span className="text-[#86868b] dark:text-[#6e7077]"> · {hint}</span> : null}
        </span>
        {status === "running" && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[#b0b0b5] dark:text-[#56585f]" />}
        {doneCount < group.steps.length && (
          <span className="shrink-0 font-mono text-[11px] text-[#a1a1a6] dark:text-[#6e7077]">{doneCount}/{group.steps.length}</span>
        )}
        <ChevronRight className={`h-3 w-3 shrink-0 text-[#a1a1a6] transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="mt-0.5 flex flex-col gap-1.5">
          {group.steps.map((step, index) => (
            <ToolStepRow
              key={`${step.id || group.firstIndex}-${index}`}
              step={step}
              active={active}
              onPreview={onPreview}
              onOpenBackgroundTask={onOpenBackgroundTask}
              compact
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MacStepList({
  steps,
  active,
  onPreview,
  onOpenBackgroundTask,
}: {
  steps: ToolStep[];
  active: boolean;
  onPreview?: (item: PreviewItem) => void;
  onOpenBackgroundTask?: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(active);
  if (steps.length === 0) return null;
  const doneCount = steps.filter((s) => s.done).length;
  const last = steps[steps.length - 1];
  const summaryStep = active ? (latestRunningStep(steps) || last) : last;
  const summaryAction = summaryStep ? toolActionText(summaryStep.tool, stepStatus(summaryStep, active)) : "";
  const groups = buildToolStepGroups(steps);
  return (
    <div className="rounded-lg border border-black/[0.06] bg-black/[0.02] px-3 py-2.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] font-medium tracking-wide text-[#86868b] dark:text-[#6e7077]">
          <Wrench className="h-3 w-3 shrink-0" />
          <span>执行过程</span>
          <span className="font-sans text-[11px] normal-case tracking-normal text-[#a1a1a6] dark:text-[#6e7077]">
            {active ? (summaryAction || "正在执行") : `${doneCount}/${steps.length} 步完成`}
          </span>
        </span>
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-[#a1a1a6] transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {!open && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {steps.slice(0, 4).map((s, i) => {
            const { Icon } = toolMeta(s.tool);
            return (
              <span key={i} className="inline-flex max-w-[180px] items-center gap-1 rounded-md bg-white px-2 py-1 text-[11.5px] text-[#6e6e73] dark:bg-white/[0.04] dark:text-[#8a8c93]">
                <Icon className="h-3 w-3 shrink-0 text-[#86868b]" />
                <span className="truncate">{toolActionText(s.tool, stepStatus(s, active))}</span>
              </span>
            );
          })}
          {steps.length > 4 && <span className="rounded-md px-2 py-1 text-[11.5px] text-[#a1a1a6]">+{steps.length - 4}</span>}
        </div>
      )}
      {open && <div className="mt-2 flex flex-col gap-1.5">
        {groups.map((group) => (
          group.steps.length > 1 ? (
            <ToolStepGroupRow
              key={`${group.tool}-${group.firstIndex}`}
              group={group}
              active={active}
              onPreview={onPreview}
              onOpenBackgroundTask={onOpenBackgroundTask}
            />
          ) : (
            <ToolStepRow
              key={`${group.tool}-${group.firstIndex}`}
              step={group.steps[0]!}
              active={active}
              onPreview={onPreview}
              onOpenBackgroundTask={onOpenBackgroundTask}
            />
          )
        ))}
      </div>}
    </div>
  );
}

/**
 * C3：「这条不太合适」的触发按钮已收进成品卡头部的「…」溢出菜单(见 DeliverableCard)，
 * 这里只负责受控展开的表单本体——open/onOpenChange 由外部(溢出菜单项)驱动。
 */
function CorrectionAction({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    const rule = text.trim();
    if (!rule || saving) return;
    setSaving(true);
    setErr(null);
    try {
      await api.addStoreMemory(rule, "rule");
      setSaved(true);
      onOpenChange(false);
      setText("");
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setErr(getErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (saved) {
    return (
      <div className="flex items-center gap-1.5 px-4 pb-3 text-[12.5px] text-[#10a37f]">
        <Check className="h-3.5 w-3.5" /> 已记住，以后照此办。
      </div>
    );
  }

  if (!open) return null;

  return (
    <div className="px-4 pb-3">
      <div className="rounded-lg border border-black/[0.08] bg-black/[0.02] p-2.5 dark:border-white/[0.08] dark:bg-white/[0.02]">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
          autoFocus
          rows={2}
          placeholder="告诉我一条规矩，下次照办，比如：不要写绝对化广告词"
          className="w-full resize-none rounded-md border border-black/[0.08] bg-white px-2.5 py-2 text-[13px] text-[#1d1d1f] outline-none placeholder:text-[#b0b0b5] focus:border-[#10a37f]/50 dark:border-white/[0.08] dark:bg-[#0e0f11] dark:text-[#e6e7e9] dark:placeholder:text-[#56585f]"
        />
        {err && <div className="mt-1.5 text-[12px] text-[#ff3b30] dark:text-[#ff8585]">{err}</div>}
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => { onOpenChange(false); setText(""); setErr(null); }}
            disabled={saving}
            className="rounded-md px-3 py-1 text-[12.5px] text-[#86868b] transition hover:text-[#1d1d1f] active:scale-[0.97] disabled:opacity-40 dark:text-[#9a9ca3] dark:hover:text-[#e6e7e9]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || !text.trim()}
            className="app-primary-action inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-[12.5px] font-medium transition active:scale-[0.98] disabled:opacity-40"
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
            记住
          </button>
        </div>
      </div>
    </div>
  );
}

/** 把 args 里可能是 number/string 的字段安全转成数字，转不出来就 undefined（不瞎猜）。 */
function parseNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

// R2 替身卡的一行规格文案：海报/图片取尺寸比例，视频取比例+时长，文字类取字数——
// 够老板一眼判断"是不是这个"，全文/大图留给右侧画布，别在这行堆信息。
function posterSpecLine(noun: string, content: string): string {
  const ratio = content.match(/(?:尺寸|比例)：\s*([0-9]+:[0-9]+)/)?.[1];
  const dims = content.match(/([0-9]{2,5})x([0-9]{2,5})/i);
  const size = ratio || (dims ? `${dims[1]}x${dims[2]}` : "");
  return size ? `${noun} · ${size}` : noun;
}

function videoSpecLine(noun: string, args?: Record<string, unknown>): string {
  const ratio = typeof args?.ratio === "string" && args.ratio ? args.ratio : "9:16";
  const duration = parseNum(args?.duration) ?? 5;
  return `${noun} · ${ratio} · ${duration}s`;
}

function textSpecLine(noun: string, content: string): string {
  const chars = content.replace(/\s+/g, "").length;
  return `${noun} · ${chars}字`;
}

/** markdown 图片语法里的 alt 文字（如「门店海报」），抽出来当替身卡标题；没有就交给调用方兜底。 */
function imageAltFromText(text: string): string | null {
  return text.match(/!\[([^\]]*)\]/)?.[1]?.trim() || null;
}

/** 文字成品没有天然缩略图，退而求其次：抽首行当"标题"用（去 markdown 符号、截断防溢出）。 */
function firstLine(text: string, max = 26): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) || "";
  const clean = line.replace(/^#+\s*/, "").replace(/[*_`>]/g, "").trim();
  if (!clean) return "文字成品";
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

/**
 * R2 替身卡本体：缩略图（图片小图 / 视频首帧 / 文字用工具图标占位）+ 标题 + 一行规格 + 「打开」。
 * 全文大图/完整视频/长文只活在右侧画布——点缩略图或「打开」都跳过去，气泡里不再整段渲染成品，
 * 解决"成品在对话里全渲染一遍、画布里又一遍"的双重渲染 + 对话越滚越长。
 */
function PlaceholderRow({
  thumbKind,
  thumbSrc,
  FallbackIcon,
  title,
  spec,
  onOpen,
}: {
  thumbKind: "poster" | "video" | "none";
  thumbSrc?: string;
  FallbackIcon: typeof Wrench;
  title: string;
  spec: string;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`打开${title}`}
        className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md border border-black/[0.08] bg-black/[0.03] transition hover:opacity-80 dark:border-white/[0.08] dark:bg-white/[0.04]"
      >
        {thumbKind === "poster" && thumbSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbSrc} alt={title} className="h-full w-full object-cover" />
        ) : thumbKind === "video" && thumbSrc ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video src={thumbSrc} muted playsInline preload="metadata" className="h-full w-full object-cover" />
        ) : (
          <FallbackIcon className="h-5 w-5 text-[#86868b] dark:text-[#6e7077]" />
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{title}</div>
        <div className="truncate text-[12px] text-[#86868b] dark:text-[#6e7077]">{spec}</div>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-[#10a37f] transition hover:bg-[#10a37f]/10 active:scale-[0.97]"
      >
        <Maximize2 className="h-3.5 w-3.5" /> 打开
      </button>
    </div>
  );
}

function AssistantOutputTargetCard({ content, onPreview }: { content: string; onPreview: (item: PreviewItem) => void }) {
  const target = extractAssistantOutputTarget(content);
  if (!target) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-black/[0.08] bg-white shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
      <PlaceholderRow
        thumbKind="none"
        FallbackIcon={MessageSquareText}
        title={target.title}
        spec={target.spec}
        onOpen={() => onPreview({ kind: "content", title: target.title, text: content })}
      />
    </div>
  );
}

function DeliverableCard({
  step,
  onPublish,
  onPreview,
}: {
  step: ToolStep;
  onPublish?: (platform: unknown, content: string) => void;
  onPreview?: (item: PreviewItem) => void;
}) {
  const { label, Icon } = toolMeta(step.tool);
  const resultText = step.result || "";
  // G.3：生图工具 → 直接抓出图片地址（不靠结果恰好是 markdown 图片语法）；生视频工具 → 抓出视频地址。
  // 只用来判断替身卡缩略图该显示哪种——全文大图/完整视频不再整段内嵌，见下方 PlaceholderRow。
  const imgUrl = IMAGE_TOOLS.has(step.tool) ? extractImageUrl(resultText) : null;
  const vidUrl = VIDEO_TOOLS.has(step.tool) ? extractVideoUrl(resultText) : null;
  // C3：「这条不太合适」不再常驻一个文字按钮，收进头部「…」溢出菜单；点了才展开下面的纠偏表单。
  const [correctionOpen, setCorrectionOpen] = useState(false);

  // R2：点缩略图/「打开」→ 把对应成品送去右侧画布看全（大图/完整视频/长文）。
  const openDeliverable = () => {
    if (!onPreview) return;
    if (vidUrl) {
      onPreview({
        kind: "video",
        title: label,
        videoUrl: vidUrl,
        ratio: typeof step.args?.ratio === "string" ? step.args.ratio : undefined,
        duration: parseNum(step.args?.duration),
      });
    } else if (imgUrl) {
      const gid = step.imageGenerationIds?.[0];
      onPreview(posterPreviewFromText(resultText, label, gid) || { kind: "poster", title: label, imageUrl: imgUrl, generationId: gid });
    } else {
      onPreview({ kind: "content", title: label, text: resultText });
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-black/[0.08] bg-white shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
      <div className="flex items-center justify-between border-b border-black/[0.06] bg-black/[0.015] px-4 py-2 dark:border-white/[0.06] dark:bg-white/[0.02]">
        <span className="flex items-center gap-1.5 font-mono text-[12px] text-[#1d1d1f] dark:text-[#c8cace]">
          <Icon className="h-3.5 w-3.5 text-[#10a37f]" /> {label}
        </span>
        <div className="flex items-center gap-1">
          <CopyButton text={resultText} />
          <OverflowMenu items={[{ key: "flag", label: "这条不太合适", Icon: Flag, onClick: () => setCorrectionOpen(true) }]} />
        </div>
      </div>
      {onPreview ? (
        // R2 替身卡：不再整段渲染大图/完整视频/长文——只留缩略图+标题+规格+「打开」，全文只在右侧画布看。
        <PlaceholderRow
          thumbKind={vidUrl ? "video" : imgUrl ? "poster" : "none"}
          thumbSrc={vidUrl || imgUrl || undefined}
          FallbackIcon={Icon}
          title={vidUrl ? label : imgUrl ? (imageAltFromText(resultText) || label) : firstLine(resultText)}
          spec={vidUrl ? videoSpecLine(label, step.args) : imgUrl ? posterSpecLine(label, resultText) : textSpecLine(label, resultText)}
          onOpen={openDeliverable}
        />
      ) : vidUrl ? (
        // 没有 onPreview（没有画布可去）时的兜底：只能原样内嵌播放器，不然彻底看不到内容。
        <div className="px-4 py-3">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video src={vidUrl} controls className="max-h-[420px] w-auto rounded-md border border-black/[0.06] dark:border-white/[0.06]" />
        </div>
      ) : imgUrl ? (
        <div className="px-4 py-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imgUrl} alt={label} className="max-h-[420px] w-auto rounded-md border border-black/[0.06] dark:border-white/[0.06]" />
        </div>
      ) : (
        <div className={`${PROSE} px-4 py-3`}>
          <SafeMarkdown>{resultText}</SafeMarkdown>
        </div>
      )}
      {step.knowledgeUsed && step.knowledgeUsed.length > 0 && (
        <div className="flex items-start gap-1.5 px-4 pb-2.5 text-[12px] leading-relaxed text-[#86868b] dark:text-[#6e7077]">
          <BookOpen className="mt-[1px] h-3.5 w-3.5 shrink-0" />
          <span><span>依据：</span>{step.knowledgeUsed.join(" · ")}</span>
        </div>
      )}
      {SHOW_PUBLISH && onPublish && step.tool === "make_platform_content" && (
        <div className="flex items-center gap-2 px-4 pb-2">
          <button
            type="button"
            onClick={() => onPublish(step.args?.platform, resultText)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-[#10a37f] transition hover:bg-[#10a37f]/10 active:scale-[0.97]"
          >
            <Send className="h-3.5 w-3.5" /> 去发布
          </button>
        </div>
      )}
      <CorrectionAction open={correctionOpen} onOpenChange={setCorrectionOpen} />
    </div>
  );
}

function MacDeliverables({
  steps,
  onPublish,
  onPreview,
}: {
  steps: ToolStep[];
  onPublish?: (platform: unknown, content: string) => void;
  onPreview?: (item: PreviewItem) => void;
}) {
  const cards = steps.map((s, idx) => ({ s, idx })).filter(({ s }) => s.result && DELIVERABLE_TOOLS.has(s.tool));
  if (cards.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {cards.map(({ s, idx }) => (
        <DeliverableCard key={idx} step={s} onPublish={onPublish} onPreview={onPreview} />
      ))}
    </div>
  );
}

function MacApprovalCard({
  ap,
  idx,
  executing,
  onConfirm,
  onCancel,
}: {
  ap: ApprovalState;
  idx: number;
  executing: boolean;
  onConfirm: (idx: number, ap: ApprovalState, options?: { remember?: boolean; args?: Record<string, unknown> }) => void;
  onCancel: (idx: number, ap?: ApprovalState) => void;
}) {
  const originalArgsText = formatApprovalArgs(ap.args);
  const [argsText, setArgsText] = useState(originalArgsText);
  useEffect(() => setArgsText(originalArgsText), [originalArgsText]);
  const parsedArgs = parseApprovalArgs(argsText);
  const confirmArgs = parsedArgs.ok ? parsedArgs.value : ap.args;
  const argsChanged = argsText.trim() !== originalArgsText.trim();
  if (ap.status === "cancelled") {
    return <div className="text-[13px] text-[#86868b] dark:text-[#6e7077]">已取消</div>;
  }
  if (ap.status === "done") {
    return <div className="flex items-center gap-1.5 text-[13px] text-[#10a37f]"><Check className="h-3.5 w-3.5" /> 已确认执行</div>;
  }
  const r = ap.reason;
  const previewBox = "rounded-md border border-black/[0.08] bg-black/[0.03] px-3 py-2 font-mono text-[12.5px] text-[#3a3a3c] whitespace-pre-line dark:border-white/[0.08] dark:bg-black/30 dark:text-[#c8cace]";
  return (
    <div className="overflow-hidden rounded-lg border border-[#e0b84a]/40 bg-[#fffaf0] dark:border-[#d4a72c]/25 dark:bg-[#211c0d]">
      <div className="px-4 py-3">
        <div className="mb-2.5 flex items-center gap-2 text-[13px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">
          <span className="rounded bg-[#d4a72c]/15 px-1.5 py-0.5 text-[11px] font-medium tracking-wide text-[#b9770f] dark:text-[#e0b84a]">需要确认</span>
          {approvalLabel(ap.tool, ap.args)}
        </div>
        {r ? (
          <div className="space-y-2.5">
            {r.what && (
              <div className="flex items-start gap-2">
                <Target className="mt-[2px] h-3.5 w-3.5 shrink-0 text-[#10a37f]" />
                <div className="text-[13px] leading-relaxed text-[#3a3a3c] dark:text-[#c8cace]"><span className="font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">要做什么：</span>{r.what}</div>
              </div>
            )}
            {r.why && (
              <div className="flex items-start gap-2">
                <ShieldQuestion className="mt-[2px] h-3.5 w-3.5 shrink-0 text-[#d4901f] dark:text-[#e0b84a]" />
                <div className="text-[13px] leading-relaxed text-[#3a3a3c] dark:text-[#c8cace]"><span className="font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">为什么要你确认：</span>{r.why}</div>
              </div>
            )}
            {r.impact && (
              <div className="flex items-start gap-2">
                <FileEdit className="mt-[2px] h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#9a9ca3]" />
                <div className="text-[13px] leading-relaxed text-[#3a3a3c] dark:text-[#c8cace]"><span className="font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">影响：</span>{r.impact}</div>
              </div>
            )}
            <ApprovalPreview preview={ap.preview} argsChanged={argsChanged} fallbackClassName={previewBox} />
          </div>
        ) : (
          <ApprovalPreview preview={ap.preview} argsChanged={argsChanged} fallbackClassName={previewBox} />
        )}
        <details className="mt-3 rounded-md border border-black/[0.08] bg-white/60 dark:border-white/[0.08] dark:bg-white/[0.03]">
          <summary className="cursor-pointer select-none px-3 py-2 text-[12px] text-[#6e6e73] dark:text-[#9a9ca3]">参数</summary>
          <div className="border-t border-black/[0.06] p-2 dark:border-white/[0.06]">
            <textarea
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              spellCheck={false}
              disabled={executing}
              className="min-h-[92px] w-full resize-y rounded-md border border-black/[0.08] bg-black/[0.02] px-2 py-1.5 font-mono text-[12px] leading-relaxed text-[#1d1d1f] outline-none focus:border-[#10a37f]/40 disabled:opacity-50 dark:border-white/[0.08] dark:bg-black/20 dark:text-[#e6e7e9]"
            />
            {!parsedArgs.ok && <div className="mt-1 text-[12px] text-[#c2410c] dark:text-[#f59e0b]">{parsedArgs.error}</div>}
            {argsChanged && parsedArgs.ok && <div className="mt-1 text-[12px] text-[#0b8064] dark:text-[#70d7bd]">将按调整后的参数执行</div>}
          </div>
        </details>
      </div>
      <div className="flex items-center justify-end gap-2 px-4 pb-3">
        <button
          onClick={() => onCancel(idx, ap)}
          disabled={executing}
          className="rounded-md border border-black/[0.1] bg-white px-4 py-1.5 text-[13px] text-[#1d1d1f] transition hover:bg-black/[0.03] active:scale-[0.98] disabled:opacity-40 dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace] dark:hover:bg-white/[0.06]"
        >
          拒绝
        </button>
        <button
          onClick={() => onConfirm(idx, ap, { args: confirmArgs })}
          disabled={executing || !parsedArgs.ok}
          title={approvalConfirmText(ap.tool)}
          className="app-primary-action flex items-center gap-1.5 rounded-md px-4 py-1.5 text-[13px] transition active:scale-[0.98] disabled:opacity-60"
        >
          {executing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          允许一次
        </button>
        {ap.rememberable && (
          <button
            onClick={() => onConfirm(idx, ap, { remember: true, args: confirmArgs })}
            disabled={executing || !parsedArgs.ok}
            className="rounded-md border border-[#10a37f]/20 bg-[#10a37f]/10 px-4 py-1.5 text-[13px] text-[#0b8064] transition hover:bg-[#10a37f]/15 active:scale-[0.98] disabled:opacity-50 dark:border-[#2fd39e]/25 dark:bg-[#2fd39e]/10 dark:text-[#70d7bd]"
            title="仅记住本会话里完全相同的动作和参数"
          >
            本会话允许
          </button>
        )}
      </div>
    </div>
  );
}

function formatApprovalArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return "{}";
  }
}

function parseApprovalArgs(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "参数需要是 JSON 对象" };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "JSON 解析失败" };
  }
}

function ApprovalPreview({ preview, argsChanged, fallbackClassName }: { preview?: string; argsChanged: boolean; fallbackClassName: string }) {
  const state = approvalPreviewState(preview, argsChanged);
  if (state.kind === "none") return null;
  if (state.kind === "stale") {
    return (
      <div className="rounded-md border border-[#d4901f]/25 bg-[#d4901f]/[0.07] px-3 py-2 text-[12.5px] leading-relaxed text-[#7a4d00] dark:border-[#f3c46b]/25 dark:bg-[#f3c46b]/[0.08] dark:text-[#f3c46b]">
        参数已调整，原预览已失效。确认前请重新核对参数；执行后仍会显示实际结果。
      </div>
    );
  }
  if (state.kind === "plan") return <ApprovalPlanSummary plan={state.plan} />;
  if (state.kind === "text") return <div className={fallbackClassName}>{state.preview}</div>;
  return (
    <div className="max-h-[340px] overflow-auto rounded-md">
      <DiffBlock before={state.diff.before} after={state.diff.after} />
    </div>
  );
}

function ApprovalPlanSummary({ plan }: { plan: ApprovalPlanPreview }) {
  if (plan.type === "run_command") return <RunCommandPlanSummary plan={plan} />;
  return <ProjectDiagnosticsPlanSummary plan={plan} />;
}

function RunCommandPlanSummary({ plan }: { plan: RunCommandApprovalPlan }) {
  return (
    <div className="rounded-md border border-black/[0.08] bg-white/70 px-3 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.04]">
      <PlanHeader icon={<Terminal className="h-3.5 w-3.5" />} title="命令执行计划" chip={riskLabel(plan.risk)} chipClassName={riskClassName(plan.risk)} />
      <div className="mt-2 space-y-1.5">
        <PlanRow label="命令" value={plan.command} mono />
        <PlanRow label="目录" value={plan.cwd || "."} mono muted={plan.cwd?.startsWith("无效:")} />
        <PlanRow label="风险" value={riskLabel(plan.risk)} />
        <PlanMetaRow items={[
          plan.timeoutMs ? `超时 ${formatLimit(plan.timeoutMs, "ms")}` : "",
          plan.maxOutputBytes ? `输出 ${formatLimit(plan.maxOutputBytes, "B")}` : "",
        ]} />
      </div>
    </div>
  );
}

function ProjectDiagnosticsPlanSummary({ plan }: { plan: ProjectDiagnosticsApprovalPlan }) {
  const ready = plan.status === "ready";
  return (
    <div className="rounded-md border border-black/[0.08] bg-white/70 px-3 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.04]">
      <PlanHeader icon={<Stethoscope className="h-3.5 w-3.5" />} title="诊断执行计划" chip={diagnosticsStatusLabel(plan.status)} chipClassName={diagnosticsStatusClassName(plan.status)} />
      <div className="mt-2 space-y-1.5">
        <PlanRow label="包" value={plan.packagePath} mono />
        <PlanRow label="目录" value={plan.cwd || plan.start} mono />
        <PlanRow label="检查" value={plan.check} />
        <PlanRow label="脚本" value={plan.script ? `${plan.manager ? `${plan.manager} · ` : ""}${plan.script}` : undefined} />
        <PlanRow label="命令" value={plan.command} mono />
        <TestTargetsRow targets={plan.testTargets} />
        <PlanRow label="原因" value={plan.reason || plan.error} muted={!ready} />
        <AvailableScriptsRow scripts={plan.available} />
        <PlanRow label="脚本内容" value={plan.body} mono />
        <PlanMetaRow items={[
          plan.timeoutMs ? `超时 ${formatLimit(plan.timeoutMs, "ms")}` : "",
          plan.maxOutputBytes ? `输出 ${formatLimit(plan.maxOutputBytes, "B")}` : "",
        ]} />
      </div>
    </div>
  );
}

function PlanHeader({ icon, title, chip, chipClassName }: { icon: React.ReactNode; title: string; chip: string; chipClassName: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">
        <span className="text-[#6e6e73] dark:text-[#9a9ca3]">{icon}</span>
        <span className="truncate">{title}</span>
      </div>
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${chipClassName}`}>{chip}</span>
    </div>
  );
}

function PlanRow({ label, value, mono = false, muted = false }: { label: string; value?: string; mono?: boolean; muted?: boolean }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)] gap-2 text-[12.5px] leading-relaxed">
      <div className="text-[#86868b] dark:text-[#8a8c93]">{label}</div>
      <div className={`${mono ? "font-mono" : ""} ${muted ? "text-[#b45309] dark:text-[#f3c46b]" : "text-[#3a3a3c] dark:text-[#c8cace]"} whitespace-pre-wrap break-words`}>
        {value}
      </div>
    </div>
  );
}

function PlanMetaRow({ items }: { items: string[] }) {
  const visible = items.filter(Boolean);
  if (!visible.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 pt-0.5">
      {visible.map((item) => (
        <span key={item} className="rounded bg-black/[0.04] px-1.5 py-0.5 text-[11px] text-[#6e6e73] dark:bg-white/[0.06] dark:text-[#9a9ca3]">
          {item}
        </span>
      ))}
    </div>
  );
}

function TestTargetsRow({ targets }: { targets?: "all" | string[] }) {
  if (!targets) return null;
  if (targets === "all") return <PlanRow label="范围" value="全部测试" />;
  if (!targets.length) return null;
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)] gap-2 text-[12.5px] leading-relaxed">
      <div className="text-[#86868b] dark:text-[#8a8c93]">范围</div>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {targets.map((target) => (
          <span key={target} className="max-w-full rounded bg-[#10a37f]/10 px-1.5 py-0.5 font-mono text-[11px] text-[#0b8064] dark:bg-[#2fd39e]/10 dark:text-[#70d7bd]">
            {target}
          </span>
        ))}
      </div>
    </div>
  );
}

function AvailableScriptsRow({ scripts }: { scripts?: string[] }) {
  if (!scripts?.length) return null;
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)] gap-2 text-[12.5px] leading-relaxed">
      <div className="text-[#86868b] dark:text-[#8a8c93]">可用脚本</div>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {scripts.map((script) => (
          <span key={script} className="rounded bg-black/[0.04] px-1.5 py-0.5 font-mono text-[11px] text-[#3a3a3c] dark:bg-white/[0.06] dark:text-[#c8cace]">
            {script}
          </span>
        ))}
      </div>
    </div>
  );
}

function riskLabel(risk?: string): string {
  if (risk === "read") return "只读";
  if (risk === "file") return "文件";
  if (risk === "outreach") return "外部";
  if (risk === "destructive") return "高危";
  return risk || "未知";
}

function riskClassName(risk?: string): string {
  if (risk === "read") return "bg-black/[0.04] text-[#6e6e73] dark:bg-white/[0.06] dark:text-[#9a9ca3]";
  if (risk === "file") return "bg-[#d4901f]/10 text-[#8a5a00] dark:bg-[#f3c46b]/10 dark:text-[#f3c46b]";
  if (risk === "outreach") return "bg-[#2563eb]/10 text-[#1d4ed8] dark:bg-[#60a5fa]/10 dark:text-[#93c5fd]";
  if (risk === "destructive") return "bg-[#dc2626]/10 text-[#b91c1c] dark:bg-[#f87171]/10 dark:text-[#fca5a5]";
  return "bg-black/[0.04] text-[#6e6e73] dark:bg-white/[0.06] dark:text-[#9a9ca3]";
}

function diagnosticsStatusLabel(status: string): string {
  if (status === "ready") return "可执行";
  if (status === "missing_package_json") return "未找到包";
  if (status === "missing_script") return "缺少脚本";
  if (status === "invalid_package_json") return "配置异常";
  if (status === "invalid_test_path") return "路径无效";
  if (status === "rejected") return "已拦截";
  return status || "未知";
}

function diagnosticsStatusClassName(status: string): string {
  if (status === "ready") return "bg-[#10a37f]/10 text-[#0b8064] dark:bg-[#2fd39e]/10 dark:text-[#70d7bd]";
  if (status === "rejected" || status === "invalid_test_path") return "bg-[#dc2626]/10 text-[#b91c1c] dark:bg-[#f87171]/10 dark:text-[#fca5a5]";
  return "bg-[#d4901f]/10 text-[#8a5a00] dark:bg-[#f3c46b]/10 dark:text-[#f3c46b]";
}

function formatLimit(value: string, unit: "ms" | "B"): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return `${value} ${unit}`;
  if (unit === "ms" && numeric >= 1000 && numeric % 1000 === 0) return `${numeric / 1000}s`;
  return `${new Intl.NumberFormat("zh-CN").format(numeric)} ${unit}`;
}

function MacQuestionCard({ q, onAnswer }: { q: QuestionData; onAnswer: (answer: string, displayText?: string) => void }) {
  const [freeform, setFreeform] = useState("");
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const [fieldValues, setFieldValues] = useState<Record<string, string | boolean | string[]>>(() => initialQuestionFieldValues(q));
  const [formError, setFormError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const submit = (answer: string, displayText?: string) => {
    const text = answer.trim();
    if (!text || submitted) return;
    setSubmitted(true);
    onAnswer(text, displayText?.trim() || undefined);
  };
  const toggleOption = (label: string) => {
    setSelectedOptions((prev) => prev.includes(label) ? prev.filter((item) => item !== label) : [...prev, label]);
  };
  const submitFields = () => {
    if (!q.fields?.length || submitted) return;
    const payload: Record<string, unknown> = {};
    for (const field of q.fields) {
      const raw = fieldValues[field.name];
      const empty = Array.isArray(raw) ? raw.length === 0 : raw === "" || raw === undefined;
      if (field.required && empty) {
        setFormError(`请填写「${field.label}」`);
        return;
      }
      if (empty) continue;
      payload[field.name] = field.type === "number" ? Number(raw) : raw;
    }
    setFormError("");
    submit(JSON.stringify(payload), questionFieldAnswerDisplay(q.fields, payload));
  };
  const hasFields = !!q.fields?.length;
  const safeUrl = safeExternalQuestionUrl(q.url);
  return (
    <div className="overflow-hidden rounded-lg border border-black/[0.08] bg-white shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
      <div className="flex items-start gap-1.5 border-b border-black/[0.06] px-4 py-2.5 text-[13px] font-medium text-[#1d1d1f] dark:border-white/[0.06] dark:text-[#e6e7e9]">
        <MessageCircleQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#10a37f]" />
        <span className="whitespace-pre-wrap leading-relaxed">{q.question}</span>
      </div>
      {q.url && (
        <div className="border-b border-black/[0.06] px-3 py-2.5 dark:border-white/[0.06]">
          {safeUrl ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-black/[0.08] bg-black/[0.025] px-2.5 py-1.5 text-[12.5px] text-[#3a3a3c] dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#c8cace]">
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-[#10a37f]" />
                <span className="truncate">{safeUrl}</span>
              </span>
              <button
                type="button"
                disabled={submitted}
                onClick={() => window.open(safeUrl, "_blank", "noopener,noreferrer")}
                className="rounded-md border border-[#10a37f]/20 bg-[#10a37f]/[0.06] px-2.5 py-1.5 text-[12.5px] font-medium text-[#0b7f63] transition hover:bg-[#10a37f]/10 active:scale-[0.98] disabled:opacity-50 dark:text-[#70d7bd]"
              >
                打开链接
              </button>
              <button
                type="button"
                disabled={submitted}
                onClick={() => submit("取消")}
                className="rounded-md border border-black/[0.08] bg-white px-2.5 py-1.5 text-[12.5px] text-[#3a3a3c] transition hover:bg-black/[0.03] active:scale-[0.98] disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#c8cace]"
              >
                取消
              </button>
            </div>
          ) : (
            <div className="flex items-start gap-1.5 rounded-md border border-[#ff3b30]/20 bg-[#ff3b30]/[0.04] px-2.5 py-2 text-[12px] text-[#c4352b] dark:text-[#ff8585]">
              <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0" />
              <span>这个链接协议不受支持，已拦截。</span>
            </div>
          )}
        </div>
      )}
      {q.options.length > 0 && (
        <div className="p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {q.options.map((o, i) => {
              const checked = selectedOptions.includes(o.label);
              return (
                <button
                  key={i}
                  type="button"
                  disabled={submitted}
                  aria-pressed={q.multi ? checked : undefined}
                  onClick={() => q.multi ? toggleOption(o.label) : submit(o.label)}
                  className={`rounded-md border p-3 text-left transition active:scale-[0.99] disabled:opacity-50 ${checked ? "border-[#10a37f]/45 bg-[#10a37f]/[0.08]" : "border-black/[0.08] bg-black/[0.01] hover:border-[#10a37f]/40 hover:bg-[#10a37f]/[0.06] dark:border-white/[0.08] dark:bg-white/[0.02]"}`}
                >
                  <div className="flex items-start gap-2">
                    {q.multi && (
                      <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? "border-[#10a37f] bg-[#10a37f] text-white" : "border-black/[0.16] text-transparent dark:border-white/[0.18]"}`}>
                        <Check className="h-3 w-3" />
                      </span>
                    )}
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{o.label}</div>
                      {o.description && <div className="mt-0.5 text-[12px] text-[#6e6e73] dark:text-[#8a8c93]">{o.description}</div>}
                    </div>
                  </div>
                  {o.preview && (
                    <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-black/[0.04] p-2 text-[11px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.05] dark:text-[#c8cace]">
                      {o.preview}
                    </pre>
                  )}
                </button>
              );
            })}
          </div>
          {q.multi && (
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                disabled={submitted || selectedOptions.length === 0}
                onClick={() => submit(selectedOptions.join("\n"), selectedOptions.join("、"))}
                className="app-primary-action inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition active:scale-[0.98] disabled:opacity-45"
              >
                <Send className="h-3.5 w-3.5" /> 提交
              </button>
            </div>
          )}
        </div>
      )}
      {hasFields && (
        <div className="space-y-3 border-t border-black/[0.06] p-3 dark:border-white/[0.06]">
          {q.fields!.map((field) => (
            <QuestionFieldInput
              key={field.name}
              field={field}
              disabled={submitted}
              value={fieldValues[field.name]}
              onChange={(value) => setFieldValues((prev) => ({ ...prev, [field.name]: value }))}
            />
          ))}
          {formError && <div className="text-[12px] text-[#ff3b30]">{formError}</div>}
          <div className="flex justify-end">
            <button
              type="button"
              disabled={submitted}
              onClick={submitFields}
              className="app-primary-action inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition active:scale-[0.98] disabled:opacity-45"
            >
              <Send className="h-3.5 w-3.5" /> 提交
            </button>
          </div>
        </div>
      )}
      {q.allowFreeform && !hasFields && (
        <div className="border-t border-black/[0.06] p-3 dark:border-white/[0.06]">
          <textarea
            value={freeform}
            disabled={submitted}
            onChange={(e) => setFreeform(e.target.value)}
            placeholder={q.placeholder || "输入回复"}
            rows={3}
            className="min-h-[76px] w-full resize-y rounded-md border border-black/[0.08] bg-black/[0.015] px-3 py-2 text-[13px] leading-relaxed text-[#1d1d1f] outline-none transition placeholder:text-[#8a8a8e] focus:border-[#10a37f]/50 focus:bg-white disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#e6e7e9] dark:focus:bg-white/[0.05]"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              disabled={submitted || !freeform.trim()}
              onClick={() => submit(freeform)}
              className="app-primary-action inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition active:scale-[0.98] disabled:opacity-45"
            >
              <Send className="h-3.5 w-3.5" /> 发送
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function initialQuestionFieldValues(q: QuestionData): Record<string, string | boolean | string[]> {
  const values: Record<string, string | boolean | string[]> = {};
  for (const field of q.fields ?? []) {
    const value = field.defaultValue;
    if (field.type === "boolean") values[field.name] = typeof value === "boolean" ? value : false;
    else if (field.type === "multiselect") values[field.name] = Array.isArray(value) ? value : [];
    else values[field.name] = value === undefined ? "" : String(value);
  }
  return values;
}

function QuestionFieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: NonNullable<QuestionData["fields"]>[number];
  value: string | boolean | string[] | undefined;
  disabled: boolean;
  onChange: (value: string | boolean | string[]) => void;
}) {
  const label = (
    <label className="block text-[12px] font-medium text-[#3a3a3c] dark:text-[#c8cace]">
      {field.label}{field.required ? <span className="text-[#ff3b30]"> *</span> : null}
    </label>
  );
  const help = field.description ? <div className="mt-1 text-[11.5px] leading-relaxed text-[#6e6e73] dark:text-[#8a8c93]">{field.description}</div> : null;
  const inputCls = "mt-1 w-full rounded-md border border-black/[0.08] bg-black/[0.015] px-3 py-2 text-[13px] text-[#1d1d1f] outline-none transition placeholder:text-[#8a8a8e] focus:border-[#10a37f]/50 focus:bg-white disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#e6e7e9] dark:focus:bg-white/[0.05]";

  if (field.type === "boolean") {
    return (
      <div>
        <label className="flex items-center gap-2 text-[13px] text-[#1d1d1f] dark:text-[#e6e7e9]">
          <input
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 rounded border-black/[0.16] accent-[#10a37f] dark:border-white/[0.16]"
          />
          {field.label}{field.required ? <span className="text-[#ff3b30]">*</span> : null}
        </label>
        {help}
      </div>
    );
  }

  if (field.type === "select") {
    return (
      <div>
        {label}
        <select
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={inputCls}
        >
          <option value="">请选择</option>
          {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        {help}
      </div>
    );
  }

  if (field.type === "multiselect") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <div>
        {label}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(field.options ?? []).map((option) => {
            const checked = selected.includes(option);
            return (
              <button
                key={option}
                type="button"
                disabled={disabled}
                onClick={() => onChange(checked ? selected.filter((x) => x !== option) : [...selected, option])}
                className={`rounded-md border px-2 py-1 text-[12px] transition disabled:opacity-50 ${checked ? "border-[#10a37f]/40 bg-[#10a37f]/10 text-[#0b7f63] dark:text-[#70d7bd]" : "border-black/[0.08] bg-black/[0.015] text-[#3a3a3c] dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#c8cace]"}`}
              >
                {option}
              </button>
            );
          })}
        </div>
        {help}
      </div>
    );
  }

  if (field.type === "textarea") {
    return (
      <div>
        {label}
        <textarea
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          rows={3}
          placeholder={field.placeholder || "输入内容"}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputCls} min-h-[76px] resize-y`}
        />
        {help}
      </div>
    );
  }

  return (
    <div>
      {label}
      <input
        type={field.type === "number" ? "number" : "text"}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        placeholder={field.placeholder || "输入内容"}
        onChange={(e) => onChange(e.target.value)}
        className={inputCls}
      />
      {help}
    </div>
  );
}

/** P1-4 成品好评:点一下写 effect_rating="good"(喂 RAG 召回/brand voice),自管已评状态,不弹钱味文案。 */
function RateGoodButton({ generationId, onRate }: { generationId: string; onRate: (id: string, rating: "good" | "bad") => void }) {
  const [rated, setRated] = useState(false);
  return (
    <button
      type="button"
      disabled={rated}
      onClick={() => { onRate(generationId, "good"); setRated(true); }}
      className="flex h-7 w-7 items-center justify-center rounded-md text-[#86868b] transition hover:bg-[#10a37f]/10 hover:text-[#10a37f] active:scale-[0.97] disabled:text-[#10a37f] disabled:hover:bg-transparent dark:text-[#8a8c93]"
      title={rated ? "已好评" : "好评：以后多照这个来"}
    >
      <ThumbsUp className="h-3.5 w-3.5" />
    </button>
  );
}

export function DesktopChatThread({
  messages,
  draft,
  reasoningDraft = "",
  liveSteps,
  liveTodo,
  retryStatus,
  generating,
  executingIdx,
  onConfirm,
  onCancel,
  onPublish,
  onPreview,
  onOpenBackgroundTask,
  onAnswer,
  onStop,
  onRetry,
  onRedoAnswer,
  onRecoverFromError,
  onMakeTask,
  onSaveArtifact,
  onExportArtifact,
  onReadAloud,
  onStopReadAloud,
  readingKey,
  onFollowUp,
  onRate,
  billiardsMode,
}: {
  messages: ChatMessage[];
  draft: string;
  reasoningDraft?: string;
  liveSteps: ToolStep[];
  // F4 Focus Chain：本轮最新的任务进度清单展示文本（原地覆盖，不是数组）。
  liveTodo?: string;
  retryStatus?: AgentRetryStatus;
  generating: boolean;
  executingIdx: number | null;
  onConfirm: (idx: number, ap: ApprovalState, options?: { remember?: boolean }) => void;
  onCancel: (idx: number, ap?: ApprovalState) => void;
  onPublish?: (platform: unknown, content: string) => void;
  onPreview?: (item: PreviewItem) => void;
  onOpenBackgroundTask?: (taskId: string) => void;
  onAnswer?: (answer: string, displayText?: string) => void;
  onStop?: () => void;
  onRetry?: () => void;
  onRedoAnswer?: (content: string) => void;
  onRecoverFromError?: (content: string) => void;
  onMakeTask?: (content: string) => void;
  onSaveArtifact?: (content: string) => void;
  onExportArtifact?: (content: string) => void;
  // D-Task-8 读给我听：只在桌面版传入(electron?.tts 判空)，念系统 TTS；再点会先停掉上一段再念新的。
  // key 传消息下标给 chat-shell 层的单一 readingKey 状态源；readingKey 传回来判断"现在念的是不是
  // 这一条"，本组件不再自己攥一份 readingIdx 状态（避免切会话/离开视图时状态跟子进程实际情况脱节）。
  onReadAloud?: (content: string, key: number) => void;
  onStopReadAloud?: () => void;
  readingKey?: string | number | null;
  onFollowUp?: (prompt: string, label?: string) => void;
  onRate?: (generationId: string, rating: "good" | "bad") => void;
  billiardsMode?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);            // 用户是否贴在底部——只有贴底才跟随流式刷新
  const prevMsgLenRef = useRef(messages.length);

  // 监听滚动：用户上滑离开底部 → 取消跟随；滑回底部 → 恢复跟随
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const isNewMessage = messages.length > prevMsgLenRef.current;
    prevMsgLenRef.current = messages.length;
    // 新消息(刚发/刚落)总是滚到底；流式 token/步骤更新只在用户贴底时跟随——上滑看历史不被拽回(G8)
    if (!isNewMessage && !pinnedRef.current) return;
    const raf = window.requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ block: "end" });
      scrollEl.scrollTop = scrollEl.scrollHeight;
      pinnedRef.current = true;
    });
    return () => window.cancelAnimationFrame(raf);
  }, [messages.length, draft, reasoningDraft, liveSteps.length, generating]);

  // 停止键流式期间常驻:draft 一出现 AgentSpinner(连同它内部的 esc 监听)就卸载 →
  // 出字阶段在 thread 级补一个 esc 监听,让流式全程都能按 Esc 停止(配合下方常驻"停止"按钮)。
  useEffect(() => {
    if (!generating || !onStop || !draft) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (document.querySelector("[role=dialog], [data-modal-open]")) return;
      onStop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [generating, onStop, draft]);

  return (
    <div ref={scrollRef} data-testid="desktop-chat-scroll" className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[820px] space-y-5 px-5 py-6">
        {messages.map((m, idx) =>
          m.role === "user" ? (
            <div key={idx} className="flex justify-end">
              <div className="max-w-[78%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-[#eeeeF0] px-3.5 py-2 text-[14px] leading-relaxed text-[#1d1d1f] shadow-sm dark:bg-[#2a2825] dark:text-[#f2efea]">
                {m.displayContent ?? m.content}
              </div>
            </div>
          ) : m.kind === "context_note" ? (
            // F9：低调的灰色内联系统提示（AI 归纳了前文）——不是错误、不是 toast，就留在对话流里
            // 解释"接下来它可能记不清最前面的细节"，别用红色/惊叹号这类会让人误以为出错的样式。
            <div key={idx} className="flex justify-center">
              <div className="max-w-[85%] rounded-full bg-black/[0.035] px-3 py-1 text-center text-[12px] leading-relaxed text-[#8a8a8e] dark:bg-white/[0.06] dark:text-[#98989d]">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={idx} className="space-y-2.5">
              {m.error ? (
                <div className="rounded-lg border border-[#ff3b30]/20 bg-[#ff3b30]/[0.035] px-3.5 py-3 dark:border-[#ff8585]/20 dark:bg-[#ff8585]/[0.05]">
                  <div className="flex items-start gap-2 text-[14px] leading-relaxed text-[#ff3b30] dark:text-[#ff8585]">
                    <AlertTriangle className="mt-[2px] h-4 w-4 shrink-0" />
                    <div>
                      <div>{m.content.replace(/^⚠️\s*/, "")}</div>
                      {(() => {
                        // 报错副文案按错因分流(别每次甩同一句、别塞"配 key/服务配置"这种开发者词):
                        // 额度类不加"换素材"的误导;网络/超时给"稍等再试";其余给通用一句。
                        const c = m.content || "";
                        const hint = /上限|额度|次数已达/.test(c)
                          ? null
                          : /网络|超时|连接|稍等|小状况|忙/.test(c)
                            ? "稍等片刻后点「重试」。"
                            : "可以点「重试」，或换个说法再发一次。";
                        return hint ? (
                          <div className="mt-1 text-[12.5px] text-[#8a3a34] dark:text-[#e6a19a]">{hint}</div>
                        ) : null;
                      })()}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {onRetry && !generating && idx === messages.length - 1 && (
                      <button
                        type="button"
                        onClick={onRetry}
                        className="inline-flex items-center gap-1 rounded-md border border-[#ff3b30]/30 bg-white px-2 py-1 text-[12px] font-medium text-[#ff3b30] transition hover:bg-[#ff3b30]/[0.08] active:scale-[0.97] dark:border-[#ff8585]/30 dark:bg-white/[0.04] dark:text-[#ff8585]"
                      >
                        <RotateCcw className="h-3 w-3" /> 重试
                      </button>
                    )}
                    {onRecoverFromError && !generating && (
                      <button
                        type="button"
                        onClick={() => onRecoverFromError(m.content)}
                        className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1 text-[12px] font-medium text-[#6e6e73] transition hover:bg-black/[0.04] hover:text-[#1d1d1f] active:scale-[0.97] dark:bg-white/[0.04] dark:text-[#c8cace] dark:hover:bg-white/[0.08]"
                      >
                        <Paperclip className="h-3 w-3" /> 换素材再试
                      </button>
                    )}
                    <CopyButton text={m.content.replace(/^⚠️\s*/, "")} />
                  </div>
                </div>
              ) : (
                <>
                  {m.reasoning && <ThinkingBlock text={m.reasoning} />}
                  {m.steps && <MacStepList steps={m.steps} active={false} onPreview={onPreview} onOpenBackgroundTask={onOpenBackgroundTask} />}
                  {/* F4 Focus Chain：常驻清单卡，原地反映本轮最新进度（task_progress 参数 / todo_write 归并同一份），
                      不随每次工具调用叠新卡。 */}
                  {m.todo && <TodoCard text={m.todo} />}
                  {m.steps && <MacDeliverables steps={m.steps} onPublish={onPublish} onPreview={onPreview} />}
                  {m.content &&
                    (m.kind === "command" ? (
                      <TerminalBlock text={m.content} />
                    ) : m.kind === "video" && extractVideoUrl(m.content) ? (
                      onPreview ? (
                        // R2：非工具卡的视频消息(如审批执行直接回灌的结果)同样只留替身卡，
                        // 全文播放器搬去右侧画布——不然这里跟 DeliverableCard 是两条互不知情的全渲染路径。
                        <div className="overflow-hidden rounded-lg border border-black/[0.08] bg-white shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
                          <PlaceholderRow
                            thumbKind="video"
                            thumbSrc={extractVideoUrl(m.content) as string}
                            FallbackIcon={Film}
                            title="视频"
                            spec="视频成品"
                            onOpen={() => onPreview({ kind: "video", title: "视频", videoUrl: extractVideoUrl(m.content) as string })}
                          />
                        </div>
                      ) : (
                        // 没有 onPreview（没有画布可去）时的兜底：只能原样内嵌播放器。
                        <div className="py-1">
                          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                          <video
                            src={extractVideoUrl(m.content) as string}
                            controls
                            className="max-h-[420px] w-auto rounded-md border border-black/[0.06] dark:border-white/[0.06]"
                          />
                        </div>
                      )
                    ) : onPreview && posterPreviewFromText(m.content) ? (
                      // 同理：模型自己的回答文本里直接带图片 markdown（非经 DeliverableCard 那条路径）
                      // 也只留替身卡，别让 ReactMarkdown 把图整张画出来又双重渲染一遍。
                      <div className="overflow-hidden rounded-lg border border-black/[0.08] bg-white shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
                        <PlaceholderRow
                          thumbKind="poster"
                          thumbSrc={extractImageUrl(m.content) || undefined}
                          FallbackIcon={ImageIcon}
                          title={imageAltFromText(m.content) || "图片"}
                          spec={posterSpecLine("图片", m.content)}
                          onOpen={() => {
                            const item = posterPreviewFromText(m.content, undefined, imageGenerationIdForContent(m.steps, m.content));
                            if (item) onPreview(item);
                          }}
                        />
                      </div>
                    ) : onPreview && extractAssistantOutputTarget(m.content) ? (
                      <AssistantOutputTargetCard content={m.content} onPreview={onPreview} />
                    ) : (
                      <div className={PROSE}>
                        <SafeMarkdown>{m.content}</SafeMarkdown>
                      </div>
                    ))}
                  {onFollowUp && billiardsMode && !generating && posterPreviewFromText(m.content) && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {billiardsPosterFollowUps().map((action) => (
                        <button
                          key={action.label}
                          type="button"
                          onClick={() => onFollowUp(action.prompt, action.label)}
                          className="inline-flex items-center gap-1 rounded-md border border-[#10a37f]/15 bg-[#10a37f]/[0.05] px-2 py-1 text-[12px] font-medium text-[#10a37f] transition hover:bg-[#10a37f]/10 active:scale-[0.97] dark:border-[#2fd39e]/20 dark:bg-[#2fd39e]/10 dark:text-[#70d7bd]"
                        >
                          <action.Icon className="h-3.5 w-3.5" /> {action.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {m.memoryRefs && m.memoryRefs.length > 0 && (
                    <div className="flex items-start gap-1.5 rounded-md bg-black/[0.025] px-2.5 py-1.5 text-[12px] leading-relaxed text-[#86868b] dark:bg-white/[0.035] dark:text-[#8a8c93]">
                      <BookOpen className="mt-[1px] h-3.5 w-3.5 shrink-0" />
                      <span>用了这些资料：{m.memoryRefs.join(" · ")}</span>
                    </div>
                  )}
                  {m.content && !m.kind && !posterPreviewFromText(m.content) && (
                    <div className="space-y-1.5">
                      {onFollowUp && billiardsMode && !generating && billiardsFollowUpActions(m.content).length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {billiardsFollowUpActions(m.content).map((action) => (
                            <button
                              key={action.label}
                              type="button"
                              onClick={() => onFollowUp(action.prompt, action.label)}
                              className="inline-flex items-center gap-1 rounded-md border border-[#10a37f]/15 bg-[#10a37f]/[0.05] px-2 py-1 text-[12px] font-medium text-[#10a37f] transition hover:bg-[#10a37f]/10 active:scale-[0.97] dark:border-[#2fd39e]/20 dark:bg-[#2fd39e]/10 dark:text-[#70d7bd]"
                            >
                              <action.Icon className="h-3.5 w-3.5" /> {action.label}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-1.5">
                        {/* C3：动作栏收敛——常驻只留 3 个高频纯图标(复制/好评/重做一版)，其余次要动作收进「…」溢出菜单 */}
                        <CopyButton text={m.content} label="复制" iconOnly />
                        {onRate && m.generationId && !generating && (
                          <RateGoodButton generationId={m.generationId} onRate={onRate} />
                        )}
                        {onRedoAnswer && !generating && (
                          <button
                            type="button"
                            onClick={() => onRedoAnswer(m.content)}
                            title="重做一版"
                            className="flex h-7 w-7 items-center justify-center rounded-md text-[#86868b] transition hover:bg-black/[0.04] hover:text-[#1d1d1f] active:scale-[0.97] dark:text-[#8a8c93] dark:hover:bg-white/[0.06] dark:hover:text-[#e6e7e9]"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {(() => {
                          const moreItems: OverflowMenuItem[] = [];
                          // 打开:原逻辑不受 generating 门控(流式生成时也能把历史消息开到右侧面板)——别裹进 !generating。
                          if (onPreview) moreItems.push({ key: "open", label: "打开", Icon: Maximize2, onClick: () => onPreview({ kind: "content", title: "回答", text: m.content }) });
                          // 保存/导出/转任务:原逻辑各带 !generating(生成中不出)——保持。
                          if (!generating && onSaveArtifact) moreItems.push({ key: "save", label: "保存成品", Icon: Save, onClick: () => onSaveArtifact(m.content) });
                          if (!generating && onExportArtifact) moreItems.push({ key: "export", label: "导出到电脑", Icon: Download, onClick: () => onExportArtifact(m.content) });
                          if (!generating && onMakeTask) moreItems.push({ key: "task", label: "转成任务", Icon: ClipboardList, onClick: () => onMakeTask(m.content) });
                          // D-Task-8 读给我听：只桌面版有(electron?.tts 判空后才传 onReadAloud)；
                          // 再点同一条切成"停止朗读"，点别的条主进程会先掐掉上一段再念新的。
                          // isReading 由 chat-shell 层的 readingKey 单一状态源算出来，本组件不再自
                          // 己攥一份 readingIdx(念完/失败的复位、切会话时的 stop 都收在那一层做)。
                          if (!generating && onReadAloud) {
                            const isReading = readingKey === idx;
                            moreItems.push({
                              key: "read",
                              label: isReading ? "停止朗读" : "读给我听",
                              Icon: Volume2,
                              onClick: () => {
                                if (isReading) {
                                  onStopReadAloud?.();
                                } else {
                                  onReadAloud(m.content, idx);
                                }
                              },
                            });
                          }
                          return moreItems.length > 0 ? <OverflowMenu items={moreItems} /> : null;
                        })()}
                      </div>
                    </div>
                  )}
                  {m.approval && (
                    <MacApprovalCard ap={m.approval} idx={idx} executing={executingIdx === idx} onConfirm={onConfirm} onCancel={onCancel} />
                  )}
                  {m.question && onAnswer && <MacQuestionCard q={m.question} onAnswer={onAnswer} />}
                </>
              )}
            </div>
          )
        )}

        {generating && (
          <div className="space-y-2.5">
            {retryStatus && <RetryStatusBanner status={retryStatus} />}
            {reasoningDraft && <ThinkingBlock text={reasoningDraft} active />}
            {liveSteps.length > 0 && <MacStepList steps={liveSteps} active onPreview={onPreview} onOpenBackgroundTask={onOpenBackgroundTask} />}
            {liveTodo && <TodoCard text={liveTodo} />}
            {draft ? (
              <>
                <div className={PROSE}>
                  <SafeMarkdown>{draft}</SafeMarkdown>
                </div>
                {onStop && (
                  <button
                    type="button"
                    onClick={onStop}
                    className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-black/[0.08] bg-white px-2 py-0.5 text-[11.5px] text-[#86868b] transition hover:bg-black/[0.03] hover:text-[#1d1d1f] active:scale-[0.97] dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#8a8c93] dark:hover:bg-white/[0.06] dark:hover:text-[#e6e7e9]"
                  >
                    停止 · 按 Esc
                  </button>
                )}
              </>
            ) : (
              <AgentSpinner onStop={onStop} activeToolName={latestRunningStep(liveSteps)?.tool} />
            )}
          </div>
        )}
        <div ref={bottomRef} data-testid="desktop-chat-bottom" className="h-px" />
      </div>
    </div>
  );
}
