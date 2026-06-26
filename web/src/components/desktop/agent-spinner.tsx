"use client";

/**
 * Agent 加载指示 —— 对标 Claude Code 的 spinner：✻ + 随机轮换动词 + 计时 + esc 中断。
 * 配色沿用现有 #10a37f；不引入新依赖。
 */
import { useEffect, useRef, useState } from "react";
import { SPINNER_VERBS } from "@/lib/agent-copy";
import { toolMeta } from "@/lib/agent-tools";

export function AgentSpinner({ onStop, activeToolName }: { onStop?: () => void; activeToolName?: string }) {
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * SPINNER_VERBS.length));
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    const roll = setInterval(() => setIdx((i) => (i + 7) % SPINNER_VERBS.length), 3500);
    return () => { clearInterval(tick); clearInterval(roll); };
  }, []);

  useEffect(() => {
    if (!onStop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.isComposing) return;
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (document.querySelector("[role=dialog], [data-modal-open]")) return;
      onStop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStop]);

  const stageLabel = activeToolName ? toolMeta(activeToolName).label : null;

  return (
    <div className="flex items-center gap-2 font-mono text-[12.5px] text-[#86868b] dark:text-[#6e7077]">
      <span className="animate-pulse text-[#10a37f]">✻</span>
      <span>{stageLabel ? `${stageLabel}…` : `${SPINNER_VERBS[idx]}…`}</span>
      <span className="text-[#b0b0b5] dark:text-[#54565d]">{elapsed}s</span>
      {onStop && <span className="text-[#b0b0b5] dark:text-[#54565d]">· esc 中断</span>}
    </div>
  );
}
