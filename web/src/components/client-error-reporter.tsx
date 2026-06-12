"use client";

import { useEffect } from "react";
import { api } from "@/lib/api";

/** 全局前端错误上报:window.onerror / unhandledrejection → 后端日志。
 * 用户端白屏/报错时后台才有迹可循。每次会话最多上报 5 条,静默失败不打扰用户。 */
export function ClientErrorReporter() {
  useEffect(() => {
    let reported = 0;
    const MAX_REPORTS = 5;

    const report = (message: string, stack?: string) => {
      if (reported >= MAX_REPORTS) return;
      reported += 1;
      api
        .reportClientError({
          message: message.slice(0, 500),
          stack: stack?.slice(0, 2000),
          url: window.location.pathname,
        })
        .catch(() => {});
    };

    const onError = (e: ErrorEvent) => {
      report(e.message || "未知错误", e.error?.stack);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason;
      report(
        reason instanceof Error ? reason.message : String(reason ?? "未知 Promise 错误"),
        reason instanceof Error ? reason.stack : undefined
      );
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
