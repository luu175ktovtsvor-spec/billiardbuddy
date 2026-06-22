"use client";

/**
 * 面板左右拖拽改宽的通用 hook（左侧栏 / 右侧预览栏共用）。
 * - 返回 { width, onHandleMouseDown }：把 width 套到面板 style.width，把回调挂到边缘那条拖拽手柄。
 * - edge="right"：手柄在面板右边（向右拖变宽，如左侧栏）；edge="left"：手柄在面板左边（向左拖变宽，如右侧预览）。
 * - 拖拽中锁 body 光标/选区；松手把宽度写进 localStorage，下次进来记得住。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export function useHorizontalResize(opts: {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  edge: "right" | "left";
}) {
  const { storageKey, defaultWidth, min, max, edge } = opts;
  const [width, setWidth] = useState(defaultWidth);
  const widthRef = useRef(width);
  widthRef.current = width;

  // 读取上次记住的宽度（仅客户端；越界值忽略）
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(storageKey));
      if (v && v >= min && v <= max) setWidth(v);
    } catch {
      /* 忽略：localStorage 不可用时用默认宽 */
    }
  }, [storageKey, min, max]);

  const onHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = widthRef.current;
      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const next = edge === "right" ? startW + delta : startW - delta;
        setWidth(Math.max(min, Math.min(max, next)));
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        try {
          localStorage.setItem(storageKey, String(Math.round(widthRef.current)));
        } catch {
          /* 忽略 */
        }
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [edge, min, max, storageKey],
  );

  return { width, onHandleMouseDown };
}
