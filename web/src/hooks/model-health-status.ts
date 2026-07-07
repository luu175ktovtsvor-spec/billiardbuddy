import type { ModelStatusResponse } from "@/lib/api";

export interface ModelHealthStatusText {
  label: string;
  detail: string;
  tone: "ok" | "warn" | "muted";
}

function retryLabel(ms: number | undefined): string {
  const seconds = Math.max(0, Math.ceil((ms || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `约 ${Math.ceil(seconds / 60)} 分钟`;
}

export function sanitizeModelHealthError(value: string | undefined): string {
  if (!value) return "";
  const cleaned = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9._-]+/gi, "sk-[redacted]")
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 140 ? `${cleaned.slice(0, 140)}...` : cleaned;
}

function failureLabel(category: string | undefined): string {
  if (category === "configuration") return "配置失败";
  if (category === "rate_limit") return "限流";
  return "失败";
}

export function modelHealthStatusText(status: ModelStatusResponse | null | undefined): ModelHealthStatusText {
  if (!status?.ok || !status.runtime) {
    return { label: "AI 通道未就绪", detail: "还没有可用的对话出口。", tone: "warn" };
  }
  const cooling = (status.health || []).filter((item) => item.state === "cooling");
  const fallbackCount = Math.max(0, status.fallbackCount || 0);
  const provider = status.runtime.providerName || status.runtime.summary.model || "当前出口";
  if (cooling.length > 0) {
    const detail = cooling
      .map((item) => {
        const error = sanitizeModelHealthError(item.lastError);
        return `${item.label} ${failureLabel(item.failureCategory)} ${item.failureCount} 次，${retryLabel(item.cooldownMsRemaining)}后重试${error ? `；${error}` : ""}`;
      })
      .join("\n");
    return {
      label: `备用接管中 · ${cooling.length} 个冷却`,
      detail: `当前优先使用：${provider}${detail ? `\n${detail}` : ""}`,
      tone: "warn",
    };
  }
  if (fallbackCount > 0) {
    return {
      label: `AI 通道正常 · ${fallbackCount} 个备用`,
      detail: `当前优先使用：${provider}；备用出口会在主出口失败时自动接上。`,
      tone: "ok",
    };
  }
  return {
    label: "AI 通道正常",
    detail: `当前优先使用：${provider}。`,
    tone: "ok",
  };
}
