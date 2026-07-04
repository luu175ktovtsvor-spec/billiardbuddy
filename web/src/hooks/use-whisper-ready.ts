"use client";

import { useEffect, useState } from "react";
import type { ModelStatus } from "@/types/electron";

const DEFAULT_STATUS: ModelStatus = { phase: "ready", percent: 100 };

/**
 * 口播模式 / 语音输入按钮共用的"模型就绪门"(D-Task-9 从 video/page.tsx 抽出，两处共用同一套，别各造一份)：
 * 订阅 `window.electron.models`(whisper 1.4G 按需下载状态，纯 Electron IPC，没有对应后端端点)。
 * web 版(浏览器)没有 electron.models → 视作已就绪，不挡功能。
 */
export function useWhisperReady(): { ready: boolean; status: ModelStatus } {
  const [status, setStatus] = useState<ModelStatus>(DEFAULT_STATUS);

  useEffect(() => {
    const m = typeof window !== "undefined" ? window.electron?.models : undefined;
    if (!m) return;
    let alive = true;
    m.status().then((s) => { if (alive) setStatus(s); }).catch(() => {});
    const off = m.onProgress((s) => { if (alive) setStatus(s); });
    return () => { alive = false; off?.(); };
  }, []);

  return { ready: status.phase === "ready", status };
}
