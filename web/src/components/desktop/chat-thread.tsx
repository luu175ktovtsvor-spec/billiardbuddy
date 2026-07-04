"use client";

/**
 * Codex 风对话流（浅色默认 · 跟随系统深浅色）：用户输入(› 前导) / 工具步骤块 / 成品卡 / 内联审批 / 提问卡。
 * 纯展示组件，状态与逻辑由 useAgentChat 提供。
 */
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, Check, Wrench, AlertTriangle, Send, Maximize2, BookOpen, Flag, Target, ShieldQuestion, MessageCircleQuestion, FileEdit, Terminal, ChevronRight, Brain, RotateCcw, ClipboardList, Save, MessageSquareText, Megaphone, ClipboardCheck, Paperclip, Download, ThumbsUp, Smartphone, Volume2, Film, ImageIcon } from "lucide-react";

import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import { CopyButton } from "@/components/generators/copy-button";
import { toolMeta, DELIVERABLE_TOOLS, INTERNAL_TOOLS, approvalLabel, approvalConfirmText } from "@/lib/agent-tools";
import type { ChatMessage, ToolStep, ApprovalState, QuestionData } from "@/hooks/use-agent-chat";
import type { PreviewItem } from "./preview-panel";
import { AgentSpinner } from "./agent-spinner";
import { OverflowMenu, type OverflowMenuItem } from "./overflow-menu";

const PROSE = "prose prose-sm prose-slate dark:prose-invert max-w-none leading-relaxed prose-p:my-1.5";

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

const IMAGE_TOOLS = new Set(["make_poster", "generate_image"]);

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

function MacStepList({ steps, active, onPreview }: { steps: ToolStep[]; active: boolean; onPreview?: (item: PreviewItem) => void }) {
  const [open, setOpen] = useState(active);
  if (steps.length === 0) return null;
  const doneCount = steps.filter((s) => s.done).length;
  const last = steps[steps.length - 1];
  const lastLabel = last ? toolMeta(last.tool).label : "";
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
            {active ? `正在${lastLabel ? `：${lastLabel}` : ""}` : `${doneCount}/${steps.length} 步完成`}
          </span>
        </span>
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-[#a1a1a6] transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {!open && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {steps.slice(0, 4).map((s, i) => {
            const { label, Icon } = toolMeta(s.tool);
            return (
              <span key={i} className="inline-flex max-w-[180px] items-center gap-1 rounded-md bg-white px-2 py-1 text-[11.5px] text-[#6e6e73] dark:bg-white/[0.04] dark:text-[#8a8c93]">
                <Icon className="h-3 w-3 shrink-0 text-[#86868b]" />
                <span className="truncate">{label}</span>
              </span>
            );
          })}
          {steps.length > 4 && <span className="rounded-md px-2 py-1 text-[11.5px] text-[#a1a1a6]">+{steps.length - 4}</span>}
        </div>
      )}
      {open && <div className="mt-2 flex flex-col gap-1.5">
        {steps.map((s, i) => {
          const { label, Icon } = toolMeta(s.tool);
          const running = active && !s.done && i === steps.length - 1;
          // P1-8 + B.1：内部/指令类工具（用技能/检索）结果是给 AI 看的原文，对老板零价值还吓人 → 绝不 dump、不进右侧。
          const isInternal = INTERNAL_TOOLS.has(s.tool);
          // 非成品、非内部工具（跑命令/抓网页/搜文件/读文件…）才把结果摊开展示；成品走成品卡，内部只留一行标签。
          // F4 Focus Chain：todo_write 的清单另有常驻卡片展示（见 message.todo / liveTodo，原地更新同一张），
          // 这里只留"列任务清单"这一行步骤标签，不重复摊开原文——避免同一份清单出现两遍。
          const showResult = s.done && !!s.result && !DELIVERABLE_TOOLS.has(s.tool) && !isInternal && s.tool !== "todo_write";
          // 命令边跑边显示：未结束 + 已有实时输出 → 渲染滚动中的终端块
          const showLiveCmd = !s.done && s.tool === "run_command" && !!s.progress;
          const cmdText = typeof s.args?.command === "string" ? s.args.command : "";
          // P0-1 任意工具进度:非命令工具(抓网页/子代理/生图/视频…)的实时进度用大白话单行露出,
          // 不套终端块(那是命令专用)。后端 handler 经 ctx.progress_emit 推大白话短句、这里只取最新一句。
          const liveNote = (!s.done && s.tool !== "run_command" && typeof s.progress === "string")
            ? (s.progress.split("\n").map((x) => x.trim()).filter(Boolean).pop() || "")
            : "";
          // 内部工具补一句人话副标题（用了哪个技能/查了什么）——从 args 取，绝不从结果原文截（截出来是乱码/指令稿）。
          const internalNote = isInternal
            ? (typeof s.args?.skill === "string" ? s.args.skill
              : typeof s.args?.name === "string" ? s.args.name
              : typeof s.args?.topic === "string" ? s.args.topic
              : typeof s.args?.query === "string" ? s.args.query : "")
            : "";
          // B.1：右侧只接"真有本机文件路径"的结果；任意工具文本不再借 file 兜底污染右侧成品台。
          const filePath = typeof s.args?.path === "string" ? s.args.path
            : typeof s.args?.file_path === "string" ? s.args.file_path : undefined;
          return (
            <div key={i} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-[13px] text-[#3a3a3c] dark:text-[#9a9ca3]">
                <span className={`shrink-0 text-[9px] leading-none ${running ? "animate-pulse text-[#d4901f]" : s.done ? "text-[#10a37f]" : "text-[#b0b0b5] dark:text-[#56585f]"}`}>⏺</span>
                <Icon className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
                <span>{label}{internalNote ? <span className="text-[#86868b] dark:text-[#6e7077]"> · {internalNote}</span> : null}</span>
                {running && <Loader2 className="h-3 w-3 animate-spin text-[#b0b0b5] dark:text-[#56585f]" />}
              </div>
              {showLiveCmd && <LiveTerminalBlock command={cmdText} output={s.progress as string} />}
              {liveNote && <div className="ml-5 text-[12px] leading-relaxed text-[#86868b] dark:text-[#6e7077]">{liveNote}</div>}
              {showResult &&
                (s.tool === "run_command" ? (
                  <TerminalBlock text={s.result as string} />
                ) : (
                  <ResultDisclosure
                    text={s.result as string}
                    onOpen={(onPreview && filePath) ? () => {
                      const p = filePath as string;
                      // B.2：AI 改了本机文本文件(edit_file/write_file)→右侧给"改前/改后"对比让老板确认；
                      // 报表→表格(可点格改)；PDF/Word/PPT/网页→文档原样预览；其它本机文件→纯文本预览
                      if ((s.tool === "edit_file" || s.tool === "write_file") && !/\.(xlsx|xlsm|pdf|docx|pptx|htm|html)$/i.test(p)) {
                        onPreview({ kind: "diff", title: label, path: p });
                      } else if (/\.(xlsx|xlsm)$/i.test(p)) onPreview({ kind: "sheet", title: label, path: p });
                      else if (/\.(pdf|docx|pptx|html|htm)$/i.test(p)) onPreview({ kind: "doc", title: label, path: p });
                      else onPreview({ kind: "file", title: label, path: p, text: s.result as string });
                    } : undefined}
                  />
                ))}
            </div>
          );
        })}
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
            className="inline-flex items-center gap-1.5 rounded-md bg-[#10a37f] px-3 py-1 text-[12.5px] font-medium text-white transition hover:bg-[#0e906f] active:scale-[0.98] disabled:opacity-40"
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
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{resultText}</ReactMarkdown>
        </div>
      )}
      {step.knowledgeUsed && step.knowledgeUsed.length > 0 && (
        <div className="flex items-start gap-1.5 px-4 pb-2.5 text-[12px] leading-relaxed text-[#86868b] dark:text-[#6e7077]">
          <BookOpen className="mt-[1px] h-3.5 w-3.5 shrink-0" />
          <span><span>依据：</span>{step.knowledgeUsed.join(" · ")}</span>
        </div>
      )}
      {onPublish && step.tool === "make_platform_content" && (
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
  onConfirm: (idx: number, ap: ApprovalState) => void;
  onCancel: (idx: number, ap?: ApprovalState) => void;
}) {
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
            {ap.preview && <div className={previewBox}>{ap.preview}</div>}
          </div>
        ) : (
          ap.preview && <div className={previewBox}>{ap.preview}</div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 px-4 pb-3">
        <button
          onClick={() => onCancel(idx, ap)}
          disabled={executing}
          className="rounded-md border border-black/[0.1] bg-white px-4 py-1.5 text-[13px] text-[#1d1d1f] transition hover:bg-black/[0.03] active:scale-[0.98] disabled:opacity-40 dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace] dark:hover:bg-white/[0.06]"
        >
          取消
        </button>
        <button
          onClick={() => onConfirm(idx, ap)}
          disabled={executing}
          className="flex items-center gap-1.5 rounded-md bg-[#10a37f] px-4 py-1.5 text-[13px] text-white transition hover:bg-[#0e906f] active:scale-[0.98] disabled:opacity-60"
        >
          {executing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {approvalConfirmText(ap.tool)}
        </button>
      </div>
    </div>
  );
}

function MacQuestionCard({ q, onAnswer }: { q: QuestionData; onAnswer: (label: string) => void }) {
  return (
    <div className="overflow-hidden rounded-lg border border-black/[0.08] bg-white shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
      <div className="flex items-center gap-1.5 border-b border-black/[0.06] px-4 py-2.5 text-[13px] font-medium text-[#1d1d1f] dark:border-white/[0.06] dark:text-[#e6e7e9]">
        <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0 text-[#10a37f]" /> {q.question}
      </div>
      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
        {q.options.map((o, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onAnswer(o.label)}
            className="rounded-md border border-black/[0.08] bg-black/[0.01] p-3 text-left transition hover:border-[#10a37f]/40 hover:bg-[#10a37f]/[0.06] active:scale-[0.99] dark:border-white/[0.08] dark:bg-white/[0.02]"
          >
            <div className="text-[13px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{o.label}</div>
            {o.description && <div className="mt-0.5 text-[12px] text-[#6e6e73] dark:text-[#8a8c93]">{o.description}</div>}
          </button>
        ))}
      </div>
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
  generating,
  executingIdx,
  onConfirm,
  onCancel,
  onPublish,
  onPreview,
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
  generating: boolean;
  executingIdx: number | null;
  onConfirm: (idx: number, ap: ApprovalState) => void;
  onCancel: (idx: number, ap?: ApprovalState) => void;
  onPublish?: (platform: unknown, content: string) => void;
  onPreview?: (item: PreviewItem) => void;
  onAnswer?: (label: string) => void;
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
              <div className="max-w-[78%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-[#007AFF] px-3.5 py-2 text-[14px] leading-relaxed text-white shadow-sm">
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
                  {m.steps && <MacStepList steps={m.steps} active={false} onPreview={onPreview} />}
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
                    ) : (
                      <div className={PROSE}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                      </div>
                    ))}
                  {onFollowUp && billiardsMode && !generating && posterPreviewFromText(m.content) && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {billiardsPosterFollowUps().map((action) => (
                        <button
                          key={action.label}
                          type="button"
                          onClick={() => onFollowUp(action.prompt, action.label)}
                          className="inline-flex items-center gap-1 rounded-md border border-[#007AFF]/15 bg-[#007AFF]/[0.05] px-2 py-1 text-[12px] font-medium text-[#007AFF] transition hover:bg-[#007AFF]/10 active:scale-[0.97] dark:border-[#66aaff]/20 dark:bg-[#66aaff]/10 dark:text-[#9bc8ff]"
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
                              className="inline-flex items-center gap-1 rounded-md border border-[#007AFF]/15 bg-[#007AFF]/[0.05] px-2 py-1 text-[12px] font-medium text-[#007AFF] transition hover:bg-[#007AFF]/10 active:scale-[0.97] dark:border-[#66aaff]/20 dark:bg-[#66aaff]/10 dark:text-[#9bc8ff]"
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
            {reasoningDraft && <ThinkingBlock text={reasoningDraft} active />}
            {liveSteps.length > 0 && <MacStepList steps={liveSteps} active onPreview={onPreview} />}
            {liveTodo && <TodoCard text={liveTodo} />}
            {draft ? (
              <>
                <div className={PROSE}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown>
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
              <AgentSpinner onStop={onStop} activeToolName={liveSteps.length ? (() => { const last = liveSteps[liveSteps.length - 1]; return !last.done ? last.tool : undefined; })() : undefined} />
            )}
          </div>
        )}
        <div ref={bottomRef} data-testid="desktop-chat-bottom" className="h-px" />
      </div>
    </div>
  );
}
