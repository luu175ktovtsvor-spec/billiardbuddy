"use client";

/**
 * 改动对比视图：行级结构对齐 cc-haha（行号 + 上下文 + 红删/绿增），
 * 改动处再做字符级高亮（只标真正变了的字/词，对齐 GitHub/ChatGPT Canvas）。
 * 文案、网页 HTML 等任何文本改写都复用它。
 */
import { useMemo } from "react";
import { structuredPatch, diffChars } from "diff";

type DiffSeg = { text: string; hl: boolean };

// 把「删除文本/新增文本」做字符级 diff，拆回 删除侧 / 新增侧 的逐行高亮片段（中文无空格，字符级最稳）。
function inlineDiff(removed: string, added: string): { delRows: DiffSeg[][]; addRows: DiffSeg[][] } {
  const parts = diffChars(removed, added);
  const delRows: DiffSeg[][] = [[]];
  const addRows: DiffSeg[][] = [[]];
  const push = (rows: DiffSeg[][], text: string, hl: boolean) => {
    const segs = text.split("\n");
    segs.forEach((s, i) => {
      if (i > 0) rows.push([]);
      if (s) rows[rows.length - 1].push({ text: s, hl });
    });
  };
  for (const p of parts) {
    if (p.removed) push(delRows, p.value, true);          // 只进删除侧、深红
    else if (p.added) push(addRows, p.value, true);       // 只进新增侧、深绿
    else { push(delRows, p.value, false); push(addRows, p.value, false); } // 公共部分两侧都有、不高亮
  }
  return { delRows, addRows };
}

const DIFF_GUT = "w-9 shrink-0 select-none border-r border-black/[0.06] px-1 text-right text-[#b0b0b5] dark:border-white/[0.06] dark:text-[#56585f]";
const DIFF_MARK = "w-4 shrink-0 select-none text-center text-[#b0b0b5] dark:text-[#56585f]";

function renderSegs(segs: DiffSeg[], kind: "add" | "del") {
  if (segs.length === 0) return " ";
  return segs.map((s, i) =>
    s.hl ? (
      <span key={i} className={kind === "add" ? "rounded-[3px] bg-[#10a37f]/30 dark:bg-[#10a37f]/40" : "rounded-[3px] bg-[#ff3b30]/25 dark:bg-[#ff453a]/35"}>{s.text}</span>
    ) : (
      <span key={i}>{s.text}</span>
    ),
  );
}

export function DiffBlock({ before, after }: { before: string; after: string }) {
  const hunks = useMemo(
    () => structuredPatch("", "", before, after, "", "", { context: 3 }).hunks,
    [before, after],
  );
  if (hunks.length === 0) {
    return <div className="px-4 py-6 text-center text-[13px] text-[#86868b] dark:text-[#6e7077]">这段没有产生变化</div>;
  }
  return (
    <div className="overflow-auto rounded-lg border border-black/[0.1] bg-white font-mono text-[12.5px] leading-relaxed dark:border-white/[0.1] dark:bg-[#16181d]">
      {hunks.map((h, hi) => {
        const rows: JSX.Element[] = [];
        let oldLn = h.oldStart;
        let newLn = h.newStart;
        let delBuf: string[] = [];
        let addBuf: string[] = [];
        let rk = 0;
        // 把攒着的 删除块/新增块 做字符级 diff 后逐行输出（删除行用旧行号、新增行用新行号）
        const flush = () => {
          if (delBuf.length === 0 && addBuf.length === 0) return;
          const { delRows, addRows } = inlineDiff(delBuf.join("\n"), addBuf.join("\n"));
          if (delBuf.length > 0) {
            delRows.forEach((segs) => {
              rows.push(
                <div key={`d${rk++}`} className="flex bg-[#ff3b30]/[0.08] text-[#b3261e] dark:bg-[#ff453a]/[0.12] dark:text-[#ff8a82]">
                  <span className={DIFF_GUT}>{oldLn++}</span>
                  <span className={DIFF_MARK}>-</span>
                  <span className="whitespace-pre-wrap break-words px-1.5">{renderSegs(segs, "del")}</span>
                </div>,
              );
            });
          }
          if (addBuf.length > 0) {
            addRows.forEach((segs) => {
              rows.push(
                <div key={`a${rk++}`} className="flex bg-[#10a37f]/[0.10] text-[#0b7a5b] dark:bg-[#10a37f]/[0.14] dark:text-[#5fe0b0]">
                  <span className={DIFF_GUT}>{newLn++}</span>
                  <span className={DIFF_MARK}>+</span>
                  <span className="whitespace-pre-wrap break-words px-1.5">{renderSegs(segs, "add")}</span>
                </div>,
              );
            });
          }
          delBuf = [];
          addBuf = [];
        };
        for (const raw of h.lines) {
          const sign = raw[0];
          if (sign === "\\") continue; // “\ No newline at end of file”
          if (sign === "-") delBuf.push(raw.slice(1));
          else if (sign === "+") addBuf.push(raw.slice(1));
          else {
            flush(); // 先把变化块吐出，再吐上下文行
            const ln = newLn;
            oldLn++;
            newLn++;
            rows.push(
              <div key={`c${rk++}`} className="flex text-[#6e6e73] dark:text-[#9a9ca3]">
                <span className={DIFF_GUT}>{ln}</span>
                <span className={DIFF_MARK}> </span>
                <span className="whitespace-pre-wrap break-words px-1.5">{raw.slice(1) || " "}</span>
              </div>,
            );
          }
        }
        flush();
        return (
          <div key={hi} className={hi > 0 ? "border-t border-black/[0.08] dark:border-white/[0.08]" : ""}>{rows}</div>
        );
      })}
    </div>
  );
}
