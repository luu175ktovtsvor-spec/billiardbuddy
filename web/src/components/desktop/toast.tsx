"use client";

/**
 * 全局 toast：顶部居中浮出、2.5s 自动消失，成功(绿 #10a37f)/失败(红 #ff3b30)两种，配色对齐现有设计语言
 * （preview-panel.tsx 内部局部 flash 的同款配色，这里做成全局共享版，不共用那份局部实现）。
 * C1(前端文案与交互规范)：把"应用状态通知"从对话气泡里搬出来——toast 状态是独立的 useState，
 * 从不写进 chat.messages，天然不进对话历史、不随对话导出/持久化被带走。
 * 挂在根 Providers 里（见 components/providers.tsx），任意组件 useToast() 即可触发，不用逐层传 props。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";

type ToastKind = "success" | "error";
type ToastEntry = { id: number; message: string; kind: ToastKind };

export interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const AUTO_DISMISS_MS = 2500;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastEntry | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = useRef(0);

  // 卸载时清掉挂起的定时器，防止对已卸载组件 setState。
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const show = useCallback((message: string, kind: ToastKind) => {
    idRef.current += 1;
    const id = idRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ id, message, kind });
    timerRef.current = setTimeout(() => {
      // 只有还是这条 toast 才清（防止晚到的旧定时器把新 toast 提前关掉）。
      setToast((prev) => (prev?.id === id ? null : prev));
    }, AUTO_DISMISS_MS);
  }, []);

  const api = useMemo<ToastApi>(() => ({
    success: (message: string) => show(message, "success"),
    error: (message: string) => show(message, "error"),
  }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastHost toast={toast} />
    </ToastContext.Provider>
  );
}

function ToastHost({ toast }: { toast: ToastEntry | null }) {
  if (!toast) return null;
  const ok = toast.kind === "success";
  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[100] flex justify-center px-4">
      <div
        key={toast.id}
        role="status"
        aria-live="polite"
        className={`pointer-events-auto flex max-w-[420px] items-start gap-2 rounded-lg border bg-white px-3.5 py-2.5 text-[13px] leading-snug shadow-lg animate-[fadeIn_0.2s_ease-out] dark:bg-[#1c1e24] ${
          ok
            ? "border-[#10a37f]/25 text-[#10a37f]"
            : "border-[#ff3b30]/25 text-[#ff3b30] dark:text-[#ff8585]"
        }`}
      >
        {ok ? <CheckCircle2 className="mt-px h-4 w-4 shrink-0" /> : <XCircle className="mt-px h-4 w-4 shrink-0" />}
        <span>{toast.message}</span>
      </div>
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
