"use client";

/**
 * 全局 toast：顶部居中浮出、2.5s 自动消失，成功(绿 #10a37f)/失败(红 #ff3b30)两种，配色对齐现有设计语言
 * （preview-panel.tsx 内部局部 flash 的同款配色，这里做成全局共享版，不共用那份局部实现）。
 * C1(前端文案与交互规范)：把"应用状态通知"从对话气泡里搬出来——toast 状态是独立的 useState，
 * 从不写进 chat.messages，天然不进对话历史、不随对话导出/持久化被带走。
 * 挂在根 Providers 里（见 components/providers.tsx），任意组件 useToast() 即可触发，不用逐层传 props。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, RefreshCw, XCircle } from "lucide-react";

type ToastKind = "success" | "error" | "info";
type ToastAction = { label: string; onClick: () => void };
type ToastEntry = { id: number; message: string; kind: ToastKind; action?: ToastAction };

export interface ToastApi {
  success: (message: string, action?: ToastAction) => void;
  error: (message: string, action?: ToastAction) => void;
  // 低调中性提示（灰色，非成功非报错）——F1c 断线重连这类"状态说明但不用大惊小怪"的场景用它。
  info: (message: string, action?: ToastAction) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const AUTO_DISMISS_MS = 2500;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastEntry | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = useRef(0);

  // 卸载时清掉挂起的定时器，防止对已卸载组件 setState。
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const dismiss = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setToast(null);
  }, []);

  const show = useCallback((message: string, kind: ToastKind, action?: ToastAction) => {
    idRef.current += 1;
    const id = idRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ id, message, kind, action });
    timerRef.current = setTimeout(() => {
      // 只有还是这条 toast 才清（防止晚到的旧定时器把新 toast 提前关掉）。
      setToast((prev) => (prev?.id === id ? null : prev));
      timerRef.current = null;
    }, AUTO_DISMISS_MS);
  }, []);

  const api = useMemo<ToastApi>(() => ({
    success: (message: string, action?: ToastAction) => show(message, "success", action),
    error: (message: string, action?: ToastAction) => show(message, "error", action),
    info: (message: string, action?: ToastAction) => show(message, "info", action),
  }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastHost toast={toast} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastHost({ toast, onDismiss }: { toast: ToastEntry | null; onDismiss: () => void }) {
  if (!toast) return null;
  const colorClass = toast.kind === "success"
    ? "border-[#10a37f]/25 text-[#10a37f]"
    : toast.kind === "error"
      ? "border-[#ff3b30]/25 text-[#ff3b30] dark:text-[#ff8585]"
      : "border-black/10 text-gray-500 dark:border-white/10 dark:text-gray-400"; // info：灰，低调不吵
  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[100] flex justify-center px-4">
      <div
        key={toast.id}
        role="status"
        aria-live="polite"
        className={`pointer-events-auto flex max-w-[420px] items-start gap-2 rounded-lg border bg-white px-3.5 py-2.5 text-[13px] leading-snug shadow-lg animate-[fadeIn_0.2s_ease-out] dark:bg-[#1c1e24] ${colorClass}`}
      >
        {toast.kind === "success"
          ? <CheckCircle2 className="mt-px h-4 w-4 shrink-0" />
          : toast.kind === "error"
            ? <XCircle className="mt-px h-4 w-4 shrink-0" />
            : <RefreshCw className="mt-px h-4 w-4 shrink-0" />}
        <span className="min-w-0 flex-1">{toast.message}</span>
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              onDismiss();
            }}
            className="ml-1 shrink-0 rounded-md border border-current/20 px-2 py-0.5 text-[12px] font-medium transition hover:bg-current/10"
          >
            {toast.action.label}
          </button>
        )}
      </div>
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
