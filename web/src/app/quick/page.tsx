"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CornerDownLeft, Loader2, X } from "lucide-react";
import { useDesktop } from "@/hooks/use-desktop";

/**
 * D-Task-10 全局快捷键小窗：打字/截屏 → 回车带进主窗对话。
 * 老板截美团后台/对手海报就地问，不用切来切去。
 *
 * 独立路由页，只在桌面壳里由 createQuickInputWindow()（desktop/src/main.js）单开一个置顶小窗加载。
 * 不是聊天主界面的一部分——没有侧栏/历史/工具栏，极简：一个输入框 + 截屏按钮。
 */
export default function QuickInputPage() {
  const { electron } = useDesktop();
  const [text, setText] = useState("");
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 唤起即聚焦：老板一按热键就能直接打字，不用再点一下输入框。
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const close = useCallback(() => {
    if (electron?.quickInput?.close) void electron.quickInput.close();
  }, [electron]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const clearImage = useCallback(() => {
    setImagePath(null);
    setThumb(null);
  }, []);

  // 截屏：复用桌面壳现成的 desktop:captureScreen（含屏幕录制权限的人话引导），不重写权限判断。
  const captureScreen = useCallback(async () => {
    if (!electron?.captureScreen || capturing) return;
    setCapturing(true);
    setError(null);
    try {
      const r = await electron.captureScreen();
      if (r?.ok && r.path) {
        setImagePath(r.path);
        setThumb(r.thumbDataUrl || null);
      } else if (r?.needsPermission && r?.error) {
        setError(r.error);
      } else {
        setError(r?.error || "截屏失败，可以重试一次");
      }
    } finally {
      setCapturing(false);
    }
  }, [electron, capturing]);

  const submit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed && !imagePath) return;
    if (!electron?.quickInput?.submit) return;
    await electron.quickInput.submit({ text: trimmed, imagePath: imagePath || undefined });
    setText("");
    clearImage();
  }, [text, imagePath, electron, clearImage]);

  const canSubmit = !!(text.trim() || imagePath);

  return (
    <div className="flex h-screen w-screen select-none flex-col justify-between bg-white px-4 py-3 dark:bg-[#1c1e24]">
      <div className="flex items-start gap-2.5">
        {thumb && (
          <div className="relative shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumb}
              alt="截图预览"
              className="h-11 w-11 rounded-md border border-black/[0.08] object-cover dark:border-white/[0.1]"
            />
            <button
              type="button"
              onClick={clearImage}
              aria-label="移除截图"
              className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[#8e8e93] text-white shadow-sm transition hover:bg-[#6e6e73]"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        )}
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
          placeholder="问点什么…（回车发送，截屏后一起问）"
          className="min-h-[44px] flex-1 resize-none bg-transparent text-[14px] leading-relaxed text-[#1d1d1f] outline-none placeholder:text-[#8e8e93] dark:text-[#e6e7e9] dark:placeholder:text-[#6e6e73]"
        />
      </div>
      {error && <div className="mt-1 text-[11.5px] leading-relaxed text-[#ff3b30]">{error}</div>}
      <div className="mt-1.5 flex items-center justify-between border-t border-black/[0.06] pt-2 dark:border-white/[0.08]">
        <span className="text-[11px] text-[#8e8e93] dark:text-[#6e6e73]">回车发送 · Esc 关闭</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={captureScreen}
            disabled={!electron?.captureScreen || capturing}
            aria-label="截屏"
            className="flex h-7 items-center gap-1 rounded-md border border-black/[0.1] px-2 text-[12px] text-[#1d1d1f] transition hover:bg-black/[0.03] disabled:opacity-40 dark:border-white/[0.1] dark:text-[#e6e7e9] dark:hover:bg-white/[0.06]"
          >
            {capturing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
            截屏
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            aria-label="发送"
            className="app-primary-action flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium transition disabled:opacity-30"
          >
            <CornerDownLeft className="h-3.5 w-3.5" />
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
