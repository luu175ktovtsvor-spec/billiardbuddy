export const MODEL_CONTEXT_WINDOWS_ENV_KEY = 'CLAUDE_CODE_MODEL_CONTEXT_WINDOWS'
export const MODEL_CONTEXT_WINDOW_MIN = 16_000
export const MODEL_CONTEXT_WINDOW_MAX = 10_000_000

const DIRECT_CONTEXT_WINDOWS: Record<string, number> = {
  'mimo-v2.5': 1_000_000,
  'deepseek-chat': 1_000_000,
  'deepseek-reasoner': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
  'deepseek-v4-flash': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5': 200_000,
  'glm-5.2': 1_000_000,
  'glm-5.1': 200_000,
  'glm-5': 200_000,
  'glm-4.6': 200_000,
  'glm-4.5': 128_000,
  'kimi-k2.7-code': 262_144,
  'kimi-k2.6': 262_144,
  'minimax-m3': 1_000_000,
}

const PATTERN_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/^anthropic\/claude-opus-4\.7\b/i, 1_000_000],
  [/^anthropic\/claude-sonnet-4\.6\b/i, 200_000],
  [/^openai\/gpt-4\.1\b/i, 1_047_576],
  [/^openai\/gpt-5(?:[.-]\d+)?\b/i, 400_000],
  [/^google\/gemini-(?:2\.0|2\.5|3)/i, 1_048_576],
  [/^gemini-(?:2\.0|2\.5|3)/i, 1_048_576],
  [/^zai-org\/glm-5\.2\b/i, 1_000_000],
  [/^(?:qwen\/)?qwen3\.7-(?:max|plus)(?:[-.][\w.-]+)?\b/i, 1_000_000],
  [/^(?:qwen\/)?qwen3\.6-(?:plus|flash)(?:[-.][\w.-]+)?\b/i, 1_000_000],
  [/^(?:qwen\/)?qwen3-coder-plus(?:[-.][\w.-]+)?\b/i, 1_000_000],
  [/qwen-long/i, 10_000_000],
]

export function normalizeModelContextKey(model: string): string {
  return model
    .trim()
    .replace(/\[1m\]$/i, '')
    .replace(/:1m$/i, '')
    .toLowerCase()
}

function normalizeWindow(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  if (value < MODEL_CONTEXT_WINDOW_MIN || value > MODEL_CONTEXT_WINDOW_MAX) return undefined
  return value
}

function normalizeConfiguredWindows(parsed: unknown): Record<string, number> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, number> = {}
  for (const [model, value] of Object.entries(parsed)) {
    const normalized = normalizeWindow(value)
    if (normalized !== undefined) out[normalizeModelContextKey(model)] = normalized
  }
  return out
}

function findConfiguredWindow(model: string, configured: Record<string, number>): number | undefined {
  const key = normalizeModelContextKey(model)
  const exact = configured[key]
  if (exact !== undefined) return exact

  for (const [configuredModel, window] of Object.entries(configured)) {
    if (key.endsWith(`/${configuredModel}`) || key.endsWith(`:${configuredModel}`)) return window
  }
  return undefined
}

export function getModelContextWindowFromEnvValue(model: string, raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined
  try {
    return findConfiguredWindow(model, normalizeConfiguredWindows(JSON.parse(raw) as unknown))
  } catch {
    return undefined
  }
}

export function getBuiltInModelContextWindow(model: string): number | undefined {
  const key = normalizeModelContextKey(model)
  const exact = DIRECT_CONTEXT_WINDOWS[key]
  if (exact !== undefined) return exact
  for (const [pattern, window] of PATTERN_CONTEXT_WINDOWS) {
    if (pattern.test(key)) return window
  }
  return undefined
}

export function getConfiguredOrBuiltInModelContextWindow(
  model: string,
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  return (
    getModelContextWindowFromEnvValue(model, env[MODEL_CONTEXT_WINDOWS_ENV_KEY]) ??
    getBuiltInModelContextWindow(model)
  )
}
