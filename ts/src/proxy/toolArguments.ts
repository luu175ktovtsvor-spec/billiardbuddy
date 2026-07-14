// OpenAI-compatible 工具参数容错 + {raw} 兜底。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface EmbeddedToolCall {
  name: string
  input: Record<string, unknown>
}

const TOOL_CALL_RE = /<tool_call>\s*<function=([^>\s]+)>\s*([\s\S]*?)<\/function>\s*<\/tool_call>/gi
const TOOL_PARAMETER_RE = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/gi

function parseEmbeddedValue(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return trimmed
  }
}

/** 部分 OpenAI-compatible provider 会把完整 XML 工具调用写进 content，却只给结构化 arguments 半截 JSON。 */
export function extractEmbeddedToolCalls(...values: string[]): EmbeddedToolCall[] {
  const source = values.filter(Boolean).join('\n')
  const calls: EmbeddedToolCall[] = []
  for (const match of source.matchAll(TOOL_CALL_RE)) {
    const name = match[1]?.trim()
    if (!name) continue
    const input: Record<string, unknown> = {}
    const body = match[2] ?? ''
    for (const parameter of body.matchAll(TOOL_PARAMETER_RE)) {
      const key = parameter[1]?.trim()
      if (key) input[key] = parseEmbeddedValue(parameter[2] ?? '')
    }
    calls.push({ name, input })
  }
  return calls
}

export function stripEmbeddedToolCalls(value: string): string {
  return value.replace(TOOL_CALL_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

export function parseOpenAIToolArguments(value: unknown, fallback?: Record<string, unknown>): Record<string, unknown> {
  if (value == null || value === '') return {}
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return isRecord(parsed) ? parsed : { raw: parsed }
    } catch {
      return fallback ?? { raw: value }
    }
  }
  if (isRecord(value)) return value
  return { raw: value }
}

export function stringifyOpenAIToolArguments(value: unknown): string {
  if (value == null || value === '') return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}
