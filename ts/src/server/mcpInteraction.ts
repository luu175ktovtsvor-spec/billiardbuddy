// MCP sampling 与 elicitation 的人机交互桥:采样内容摘要转发主模型、
// elicitation schema 转问答表单与应答解析。

import type { McpElicitationHandlerInput, McpSamplingHandlerInput } from '../mcp/client'
import { textBlock, type Message } from '../types/message'
import type { AskQuestionField } from '../types/events'
import type { Model } from '../types/model'
import { delay, isRecord } from './requestParams'

export function stringifyForPrompt(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function mcpSamplingContentText(content: unknown): string {
  if (Array.isArray(content)) return content.map(mcpSamplingContentText).filter(Boolean).join('\n')
  if (!content || typeof content !== 'object') return stringifyForPrompt(content)
  const block = content as Record<string, unknown>
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if (block.type === 'image') return `[image mimeType=${typeof block.mimeType === 'string' ? block.mimeType : 'unknown'}]`
  if (block.type === 'audio') return `[audio mimeType=${typeof block.mimeType === 'string' ? block.mimeType : 'unknown'}]`
  if (block.type === 'tool_use') {
    const name = typeof block.name === 'string' ? block.name : 'unknown'
    return `<mcp_sampling_tool_use name="${name}">\n${stringifyForPrompt(block.input)}\n</mcp_sampling_tool_use>`
  }
  if (block.type === 'tool_result') {
    const id = typeof block.toolUseId === 'string' ? block.toolUseId : ''
    // 多模态兼容:tool_result.content 可能是 string 或 blocks 数组(#46)。string 直接取用;
    // 数组/其它形态交给本函数递归摘要(Array.isArray + typeof 分支已覆盖),不会 crash 也不产出 [object Object]。
    const inner = typeof block.content === 'string' ? block.content : mcpSamplingContentText(block.content)
    return `<mcp_sampling_tool_result id="${id}">\n${inner}\n</mcp_sampling_tool_result>`
  }
  if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
    const resource = block.resource as Record<string, unknown>
    if (typeof resource.text === 'string') return resource.text
    if (typeof resource.uri === 'string') return `[resource uri=${resource.uri}]`
  }
  if (typeof block.uri === 'string') return `[resource_link uri=${block.uri}]`
  return stringifyForPrompt(block)
}

export function mcpSamplingMessages(messages: McpSamplingHandlerInput['params']['messages']): Message[] {
  return messages.map(message => ({
    role: message.role,
    content: [textBlock(mcpSamplingContentText(message.content))],
  }))
}

export async function runMcpSampling(model: Model, modelName: string, params: McpSamplingHandlerInput['params'], signal?: AbortSignal) {
  const step = await model.step({
    system: params.systemPrompt,
    messages: mcpSamplingMessages(params.messages),
    tools: [],
    signal,
  })
  const text = step.kind === 'final'
    ? step.text
    : [
        step.text,
        step.calls.length > 0 ? `MCP sampling requested tool use, but this Agent only allows tool execution through the main permission gate: ${step.calls.map(call => call.name).join(', ')}` : '',
      ].filter(Boolean).join('\n\n')
  return {
    model: modelName || 'agent-model',
    role: 'assistant' as const,
    content: { type: 'text' as const, text },
    stopReason: step.kind === 'tool_calls' ? 'toolUse' as const : 'endTurn' as const,
  }
}

export const MCP_ELICITATION_TIMEOUT_MS = 120000

function schemaProperties(params: McpElicitationHandlerInput['params']): Record<string, unknown> {
  if (params.mode === 'url') return {}
  const schema = params.requestedSchema
  return isRecord(schema) && isRecord(schema.properties) ? schema.properties : {}
}

function schemaRequired(params: McpElicitationHandlerInput['params']): string[] {
  if (params.mode === 'url') return []
  const schema = params.requestedSchema
  return Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []
}

function primitiveDefault(value: unknown): string | number | boolean | string[] | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value
  return undefined
}

export function defaultsForSchema(params: McpElicitationHandlerInput['params']): Record<string, string | number | boolean | string[]> {
  const content: Record<string, string | number | boolean | string[]> = {}
  for (const [key, prop] of Object.entries(schemaProperties(params))) {
    if (!isRecord(prop) || !Object.prototype.hasOwnProperty.call(prop, 'default')) continue
    const value = primitiveDefault(prop.default)
    if (value !== undefined) content[key] = value
  }
  return content
}

function coerceElicitationValue(raw: unknown, propSchema: unknown): string | number | boolean | string[] | undefined {
  const schema = isRecord(propSchema) ? propSchema : {}
  const type = schema.type
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw
    if (typeof raw === 'string') {
      const text = raw.trim().toLowerCase()
      if (['true', 'yes', 'y', '1', '允许', '是', '对'].includes(text)) return true
      if (['false', 'no', 'n', '0', '取消', '否', '不'].includes(text)) return false
    }
    return undefined
  }
  if (type === 'number' || type === 'integer') {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN
    if (!Number.isFinite(n)) return undefined
    return type === 'integer' ? Math.trunc(n) : n
  }
  if (type === 'array') {
    if (Array.isArray(raw) && raw.every(item => typeof item === 'string')) return raw
    if (typeof raw === 'string') return raw.split(/[,\n，]/).map(item => item.trim()).filter(Boolean)
    return undefined
  }
  if (typeof raw === 'string') return raw
  if (raw === undefined || raw === null) return undefined
  return String(raw)
}

function parseKeyValueAnswer(answer: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const line of answer.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:=：]+)\s*[:=：]\s*(.+?)\s*$/)
    if (match) out[match[1]!.trim()] = match[2]!.trim()
  }
  return out
}

export function parseMcpFormAnswer(answer: string, params: McpElicitationHandlerInput['params']): Record<string, string | number | boolean | string[]> | null {
  if (params.mode === 'url') return null
  const properties = schemaProperties(params)
  const required = schemaRequired(params)
  const merged: Record<string, unknown> = { ...defaultsForSchema(params) }
  const trimmed = answer.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    parsed = parseKeyValueAnswer(trimmed)
  }
  if (isRecord(parsed) && Object.keys(parsed).length > 0) {
    Object.assign(merged, parsed)
  } else {
    const missing = required.filter(key => merged[key] === undefined)
    if (missing.length === 1) merged[missing[0]!] = trimmed
  }

  const content: Record<string, string | number | boolean | string[]> = {}
  for (const [key, raw] of Object.entries(merged)) {
    const prop = properties[key]
    if (!prop) continue
    const value = coerceElicitationValue(raw, prop)
    if (value !== undefined) content[key] = value
  }
  if (required.some(key => content[key] === undefined)) return null
  return content
}

export function mcpSchemaFieldLines(params: McpElicitationHandlerInput['params']): string[] {
  const required = new Set(schemaRequired(params))
  return Object.entries(schemaProperties(params)).map(([key, prop]) => {
    const schema = isRecord(prop) ? prop : {}
    const title = typeof schema.title === 'string' ? schema.title : key
    const description = typeof schema.description === 'string' ? ` - ${schema.description}` : ''
    const type = typeof schema.type === 'string' ? schema.type : 'value'
    const requiredMark = required.has(key) ? '必填' : '可选'
    const def = Object.prototype.hasOwnProperty.call(schema, 'default') ? `, 默认 ${stringifyForPrompt(schema.default)}` : ''
    return `- ${key} (${title}, ${type}, ${requiredMark}${def})${description}`
  })
}

export function mcpSchemaFields(params: McpElicitationHandlerInput['params']): AskQuestionField[] | undefined {
  if (params.mode === 'url') return undefined
  const required = new Set(schemaRequired(params))
  const fields = Object.entries(schemaProperties(params)).map(([key, prop]): AskQuestionField => {
    const schema = isRecord(prop) ? prop : {}
    const title = typeof schema.title === 'string' ? schema.title : key
    const description = typeof schema.description === 'string' ? schema.description : undefined
    const enumOptions = Array.isArray(schema.enum) ? schema.enum.filter((item): item is string => typeof item === 'string') : undefined
    const arrayItemSchema = isRecord(schema.items) ? schema.items : {}
    const arrayOptions = Array.isArray(arrayItemSchema.enum) ? arrayItemSchema.enum.filter((item): item is string => typeof item === 'string') : undefined
    const type = schema.type === 'boolean'
      ? 'boolean'
      : schema.type === 'number' || schema.type === 'integer'
        ? 'number'
        : schema.type === 'array'
          ? arrayOptions?.length ? 'multiselect' : 'textarea'
          : enumOptions?.length ? 'select' : 'text'
    return {
      name: key,
      label: title,
      type,
      required: required.has(key),
      ...(description ? { description } : {}),
      ...(primitiveDefault(schema.default) !== undefined ? { defaultValue: primitiveDefault(schema.default) } : {}),
      ...((enumOptions?.length || arrayOptions?.length) ? { options: (enumOptions ?? arrayOptions)!.slice(0, 30) } : {}),
      ...(schema.type === 'array' && !arrayOptions?.length ? { placeholder: '每行一个值' } : {}),
    }
  })
  return fields.length > 0 ? fields : undefined
}

export function isDeclineAnswer(answer: string): boolean {
  return ['取消', '拒绝', '不允许', 'decline', 'cancel', 'no', '否'].includes(answer.trim().toLowerCase())
}

export async function waitForInboxAnswer(inbox: string[], startLen: number, signal?: AbortSignal, timeoutMs = MCP_ELICITATION_TIMEOUT_MS): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return null
    if (inbox.length > startLen) {
      const [answer] = inbox.splice(startLen, 1)
      return typeof answer === 'string' ? answer : null
    }
    await delay(100)
  }
  return null
}
