"use client";

/**
 * 圈选+说话画布(阶段3·react-konva MIT):在成品图上圈一块(可选)+ 说一句指令。
 * E2-3・合并原来并列的"整图改"+"局部重绘"两个入口——圈了(有笔触)= 导出同尺寸 alpha mask 走局部重绘,
 * 不圈(没画一笔)= mask 传 undefined 走整图改,由外层 onApply 按有没有 mask 分流(page.tsx 的 onSubmitEdit)。
 * M1 关键:OpenAI mask 约定「透明(alpha=0)处=要改」,而涂的就是要改的地方 → 导出时用 destination-out
 * 把涂的区域抠成透明、其余不透明(自然尺寸 canvas 精确还原),不是直接拿笔触图当 mask。
 * 必须经 dynamic(ssr:false) 引入(konva 碰 canvas/window,不能 SSR)。
 */
import { useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Line } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { Undo2, Eraser, Check, X, Wand2 } from "lucide-react";

type Props = {
  imageUrl: string;
  busy?: boolean;
  onApply: (maskBase64: string | undefined, instruction: string) => void;
  onCancel: () => void;
};

const MAX_W = 560;
const MAX_H = 660;

export default function StudioMaskCanvas({ imageUrl, busy, onApply, onCancel }: Props) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [lines, setLines] = useState<number[][]>([]); // 每条:[x0,y0,x1,y1,...] 显示坐标
  const [brush, setBrush] = useState(44);
  const [instruction, setInstruction] = useState("");
  const drawing = useRef(false);

  useEffect(() => {
    const im = new window.Image();
    im.crossOrigin = "anonymous";
    im.onload = () => setImg(im);
    im.src = imageUrl;
  }, [imageUrl]);

  if (!img) {
    return <div className="flex items-center justify-center py-20 text-[13px] text-[#86868b]">加载图片中…</div>;
  }

  const scale = Math.min(MAX_W / img.naturalWidth, MAX_H / img.naturalHeight, 1);
  const dispW = Math.round(img.naturalWidth * scale);
  const dispH = Math.round(img.naturalHeight * scale);

  const point = (e: KonvaEventObject<MouseEvent>) => e.target.getStage()?.getPointerPosition() ?? null;

  const onDown = (e: KonvaEventObject<MouseEvent>) => {
    const p = point(e); if (!p) return;
    drawing.current = true;
    setLines((ls) => [...ls, [p.x, p.y]]);
  };
  const onMove = (e: KonvaEventObject<MouseEvent>) => {
    if (!drawing.current) return;
    const p = point(e); if (!p) return;
    setLines((ls) => {
      if (!ls.length) return ls;
      const last = ls[ls.length - 1];
      return [...ls.slice(0, -1), [...last, p.x, p.y]];
    });
  };
  const onUp = () => { drawing.current = false; };

  const exportMask = (): string => {
    // 自然尺寸 canvas:不透明白底 → 涂的地方 destination-out 抠透明 = OpenAI mask(透明=要改)
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = "destination-out";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = brush / scale; // 显示笔宽 → 自然尺寸
    for (const pts of lines) {
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i] / scale, y = pts[i + 1] / scale;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      // 单点(只点一下没拖)也画个圆点
      if (pts.length === 2) ctx.arc(pts[0] / scale, pts[1] / scale, (brush / scale) / 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();
    }
    return c.toDataURL("image/png").split(",")[1];
  };

  // E2-3・恢复合并语义:圈不圈都行,只要求说清楚想改什么——圈了 = 局部重绘,不圈 = 整图改。
  const canApply = instruction.trim().length > 0 && !busy;

  return (
    <div className="flex flex-col items-center gap-3 p-4">
      <div className="text-[12px] text-[#86868b] dark:text-[#6e7077]">想改哪块就圈一下(可选)，再在下面说想改成什么；不圈就整张一起改</div>
      <div className="overflow-hidden rounded-xl shadow-sm" style={{ width: dispW, height: dispH }}>
        <Stage width={dispW} height={dispH} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}>
          <Layer listening={false}><KonvaImage image={img} width={dispW} height={dispH} /></Layer>
          <Layer listening={false}>
            {lines.map((pts, i) => (
              <Line key={i} points={pts} stroke="rgba(16,163,127,0.45)" strokeWidth={brush} lineCap="round" lineJoin="round" tension={0.2} />
            ))}
          </Layer>
        </Stage>
      </div>

      <div className="flex w-full max-w-[560px] items-center gap-2">
        <span className="text-[11.5px] text-[#86868b]">笔粗</span>
        <input type="range" min={16} max={120} value={brush} onChange={(e) => setBrush(Number(e.target.value))} className="flex-1 accent-[#10a37f]" />
        <button type="button" onClick={() => setLines((ls) => ls.slice(0, -1))} disabled={!lines.length} title="撤销一笔"
          className="flex items-center gap-1 rounded-md border border-black/[0.08] bg-white px-2 py-1 text-[12px] text-[#3a3a3c] transition hover:bg-black/[0.03] disabled:opacity-40 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#c8cace]">
          <Undo2 className="h-3.5 w-3.5" /> 撤销
        </button>
        <button type="button" onClick={() => setLines([])} disabled={!lines.length} title="清空"
          className="flex items-center gap-1 rounded-md border border-black/[0.08] bg-white px-2 py-1 text-[12px] text-[#3a3a3c] transition hover:bg-black/[0.03] disabled:opacity-40 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#c8cace]">
          <Eraser className="h-3.5 w-3.5" /> 清空
        </button>
      </div>

      <textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="想改成什么？比如：背景换成夜晚、圈的这块换成台球桌、把这里的字去掉"
        rows={2}
        className="w-full max-w-[560px] resize-none rounded-lg border border-black/[0.08] bg-black/[0.02] px-3 py-2 text-[13px] outline-none transition placeholder:text-[#b0b0b5] focus:border-[#10a37f]/50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:placeholder:text-[#56585f]"
      />
      <div className="flex w-full max-w-[560px] items-center justify-end gap-2">
        <button type="button" onClick={onCancel}
          className="flex items-center gap-1 rounded-lg border border-black/[0.08] bg-white px-3 py-1.5 text-[13px] font-medium text-[#3a3a3c] transition hover:bg-black/[0.03] dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#c8cace]">
          <X className="h-3.5 w-3.5" /> 取消
        </button>
        <button type="button" disabled={!canApply} onClick={() => onApply(lines.length > 0 ? exportMask() : undefined, instruction.trim())}
          className="flex items-center gap-1 rounded-lg bg-[#10a37f] px-3 py-1.5 text-[13px] font-medium text-white transition hover:bg-[#0e906f] active:scale-[0.99] disabled:opacity-50">
          {busy ? <Wand2 className="h-3.5 w-3.5 animate-pulse" /> : <Check className="h-3.5 w-3.5" />} {lines.length > 0 ? "改这一块" : "改整张"}
        </button>
      </div>
    </div>
  );
}
