export interface AgentUsageStatus {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastInputTokens: number;
  lastOutputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
}

interface RawAgentUsagePayload {
  input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
  last_input_tokens?: unknown;
  last_output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  context_window?: unknown;
  context_percent?: unknown;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function agentUsageFromPayload(payload: RawAgentUsagePayload): AgentUsageStatus | undefined {
  const inputTokens = finiteNumber(payload.input_tokens);
  const outputTokens = finiteNumber(payload.output_tokens);
  const totalTokens = finiteNumber(payload.total_tokens);
  const lastInputTokens = finiteNumber(payload.last_input_tokens);
  const lastOutputTokens = finiteNumber(payload.last_output_tokens);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    totalTokens === undefined ||
    lastInputTokens === undefined ||
    lastOutputTokens === undefined
  ) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    lastInputTokens,
    lastOutputTokens,
    cacheReadInputTokens: finiteNumber(payload.cache_read_input_tokens),
    cacheCreationInputTokens: finiteNumber(payload.cache_creation_input_tokens),
    contextWindow: finiteNumber(payload.context_window),
    contextPercent: finiteNumber(payload.context_percent),
  };
}

export function compactTokenCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) {
    const rounded = value / 1_000_000;
    return `${rounded >= 10 ? rounded.toFixed(0) : rounded.toFixed(1)}m`;
  }
  if (value >= 1000) {
    const rounded = value / 1000;
    return `${rounded >= 10 ? rounded.toFixed(0) : rounded.toFixed(1)}k`;
  }
  return `${Math.max(0, Math.round(value))}`;
}

export function agentUsageStatusText(usage: AgentUsageStatus | undefined): string | undefined {
  if (!usage) return undefined;
  const turnTokens = compactTokenCount(usage.totalTokens);
  const latestTokens = compactTokenCount(usage.lastInputTokens + usage.lastOutputTokens);
  const cacheTokens = (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
  const cacheText = cacheTokens > 0 ? ` · 缓存 ${compactTokenCount(cacheTokens)}` : "";
  if (usage.contextPercent !== undefined) {
    const pct = Math.max(0, usage.contextPercent);
    const pctText = pct >= 10 ? pct.toFixed(0) : pct.toFixed(1);
    return `≈${pctText}% · 本轮 ${turnTokens} · 最新 ${latestTokens}${cacheText}`;
  }
  return `本轮 ${turnTokens} · 最新 ${latestTokens}${cacheText}`;
}
