import type { AgentEvent } from '../types/events'

type RecordValue = Record<string, unknown>

export interface BridgeSdkProjectionOptions {
  includeUserText?: boolean
}

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const chunks: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text') chunks.push(stringField(block.text))
    else if (block.type === 'thinking') chunks.push(stringField(block.thinking))
    else if (block.type === 'tool_result') chunks.push(stringField(block.content))
    else if (block.type === 'image') chunks.push('[image]')
  }
  return chunks.filter(Boolean).join('\n')
}

function contentBlocks(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function note(text: string): AgentEvent[] {
  return text.trim() ? [{ type: 'context_note', text: text.trim() }] : []
}

function resultErrors(payload: RecordValue): string {
  const errors = Array.isArray(payload.errors) ? payload.errors.filter((item): item is string => typeof item === 'string') : []
  return errors.join('\n')
}

function projectStreamEvent(rawEvent: unknown): AgentEvent[] {
  if (!isRecord(rawEvent)) return []
  const eventType = stringField(rawEvent.type)
  if (eventType === 'content_block_delta') {
    const delta = isRecord(rawEvent.delta) ? rawEvent.delta : {}
    if (delta.type === 'text_delta') return stringField(delta.text) ? [{ type: 'commentary', text: stringField(delta.text) }] : []
    if (delta.type === 'thinking_delta') return stringField(delta.thinking) ? [{ type: 'thinking', text: stringField(delta.thinking) }] : []
    if (delta.type === 'input_json_delta') return stringField(delta.partial_json) ? [{ type: 'tool_progress', tool: 'remote_tool', chunk: stringField(delta.partial_json), stream: 'input_json' }] : []
    return []
  }
  if (eventType === 'content_block_start') {
    const block = isRecord(rawEvent.content_block) ? rawEvent.content_block : {}
    if (block.type === 'tool_use') {
      const id = stringField(block.id)
      const name = stringField(block.name) || 'remote_tool'
      return [{ type: 'tool_call', tool: name, input: isRecord(block.input) ? block.input : { ...(id ? { id } : {}) } }]
    }
    if (block.type === 'text') return stringField(block.text) ? [{ type: 'commentary', text: stringField(block.text) }] : []
    return []
  }
  if (eventType === 'message_delta') {
    const delta = isRecord(rawEvent.delta) ? rawEvent.delta : {}
    const stopReason = stringField(delta.stop_reason)
    return stopReason ? note(`Remote assistant stop: ${stopReason}`) : []
  }
  return []
}

function projectAssistantMessage(payload: RecordValue): AgentEvent[] {
  const message = isRecord(payload.message) ? payload.message : {}
  const events: AgentEvent[] = []
  for (const block of contentBlocks(message.content)) {
    if (block.type === 'text') {
      const text = stringField(block.text)
      if (text) events.push({ type: 'final', text })
    } else if (block.type === 'thinking') {
      const text = stringField(block.thinking)
      if (text) events.push({ type: 'commentary', text })
    } else if (block.type === 'tool_use') {
      events.push({
        type: 'tool_call',
        tool: stringField(block.name) || 'remote_tool',
        input: isRecord(block.input) ? block.input : {},
      })
    }
  }
  const error = isRecord(payload.error) ? JSON.stringify(payload.error) : stringField(payload.error)
  if (error) events.push({ type: 'context_note', text: `Remote assistant error: ${error}` })
  return events
}

function projectUserMessage(payload: RecordValue, options: BridgeSdkProjectionOptions): AgentEvent[] {
  const content = isRecord(payload.message) ? payload.message.content : undefined
  const blocks = contentBlocks(content)
  const toolResults = blocks.filter(block => block.type === 'tool_result')
  if (toolResults.length > 0) {
    return toolResults.map(block => ({
      type: 'tool_result',
      tool: 'remote_tool',
      output: stringField(block.content),
    }))
  }
  if (!options.includeUserText) return []
  const text = textFromContent(content)
  return text ? [{ type: 'steering', content: text }] : []
}

function projectSystemMessage(payload: RecordValue): AgentEvent[] {
  const subtype = stringField(payload.subtype)
  if (subtype === 'init') return note(`Remote session initialized${payload.model ? ` (${String(payload.model)})` : ''}`)
  if (subtype === 'status') return note(payload.status === 'compacting' ? 'Remote session compacting' : `Remote status: ${String(payload.status ?? '')}`)
  if (subtype === 'compact_boundary') return note('Remote conversation compacted')
  if (subtype === 'api_retry') return note(`Remote API retry ${String(payload.attempt ?? '')}/${String(payload.max_retries ?? '')}`.trim())
  if (subtype === 'streaming_fallback') return note(`Remote streaming fallback: ${String(payload.cause ?? '')}`)
  if (subtype === 'local_command_output') {
    const content = stringField(payload.content)
    return content ? [{ type: 'thinking', text: content }] : []
  }
  if (subtype === 'hook_progress') {
    const output = stringField(payload.output) || stringField(payload.stdout) || stringField(payload.stderr)
    return output ? [{ type: 'tool_progress', tool: stringField(payload.hook_name) || 'remote_hook', chunk: output }] : []
  }
  if (subtype === 'hook_response') {
    const output = stringField(payload.output) || stringField(payload.stdout) || stringField(payload.stderr)
    return output ? [{ type: 'tool_result', tool: stringField(payload.hook_name) || 'remote_hook', output }] : []
  }
  return []
}

export function projectBridgeSdkEvent(payload: RecordValue, options: BridgeSdkProjectionOptions = {}): AgentEvent[] {
  switch (payload.type) {
    case 'assistant':
      return projectAssistantMessage(payload)
    case 'stream_event':
      return projectStreamEvent(payload.event)
    case 'user':
      return projectUserMessage(payload, options)
    case 'result': {
      if (payload.subtype === 'success') {
        const text = stringField(payload.result)
        return text ? [{ type: 'final', text }] : []
      }
      const errors = resultErrors(payload)
      return note(errors || `Remote session ended: ${String(payload.subtype ?? 'error')}`)
    }
    case 'system':
      return projectSystemMessage(payload)
    case 'tool_progress':
      return [{
        type: 'tool_progress',
        tool: stringField(payload.tool_name) || 'remote_tool',
        id: stringField(payload.tool_use_id) || undefined,
        chunk: `running for ${String(payload.elapsed_time_seconds ?? 0)}s`,
      }]
    default:
      return []
  }
}
