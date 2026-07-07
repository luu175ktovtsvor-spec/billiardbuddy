export type AgentRetryStatus =
  | { phase: "waiting"; attempt: number; maxAttempts: number; delayMs: number }
  | { phase: "retrying"; attempt: number; maxAttempts: number };

export function retryStatusText(status: AgentRetryStatus): string {
  if (status.phase === "waiting") {
    const seconds = Math.max(1, Math.ceil(status.delayMs / 1000));
    return `连接断开，${seconds} 秒后重连（第 ${status.attempt}/${status.maxAttempts} 次）`;
  }
  return `正在重连（第 ${status.attempt}/${status.maxAttempts} 次）`;
}
