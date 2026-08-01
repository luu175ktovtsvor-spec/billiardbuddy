import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod/v4'
import type { ProductHarnessMessage } from '../../../shared/product/harnessMessages.js'
import { resolveProductTextModel } from '../product/productGatewayRuntime.js'
import { runProductAgentLoop } from './productAgentLoop.js'
import { buildProductTool, type ProductCommand, type ProductTool, type ProductToolContext } from './productTool.js'

const MAX_AGENTS = 128
const MAX_AGENT_BYTES = 512 * 1024
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const SAFE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9:_-]{0,127}$/

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function split(source: string): { metadata: Record<string, unknown>; body: string } | null {
  const normalized = source.replaceAll('\r\n', '\n')
  if (!normalized.startsWith('---\n')) return null
  const end = normalized.indexOf('\n---\n', 4)
  if (end < 0) return null
  const document = parseDocument(normalized.slice(4, end), { prettyErrors: false, strict: true })
  if (document.errors.length) return null
  const metadata = document.toJS({ maxAliasCount: 0 })
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  return { metadata: metadata as Record<string, unknown>, body: normalized.slice(end + 5).trim() }
}

function allowedTools(value: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return source.map(item => String(item).trim()).filter(item => SAFE_TOOL_NAME.test(item)).slice(0, 128)
}

function agentTool(input: { plugin: string; name: string; description: string; instructions: string; allowedTools: string[]; model?: string }): ProductTool {
  const inputSchema = z.strictObject({ prompt: z.string().min(1).max(100_000).describe('The bounded task for this named agent') })
  const toolName = `agent__${input.plugin.replace(/[^A-Za-z0-9_-]/g, '_')}__${input.name.replaceAll('-', '_')}`
  return buildProductTool({
    name: toolName,
    maxResultSizeChars: 100_000,
    inputSchema,
    async description() { return `Run the ${input.plugin}:${input.name} named agent: ${input.description}`.slice(0, 2_048) },
    async prompt() { return `Use ${toolName} for tasks matching this specialist: ${input.description}`.slice(0, 2_048) },
    isReadOnly() { return false },
    isConcurrencySafe() { return false },
    userFacingName() { return `${input.plugin}:${input.name}` },
    toAutoClassifierInput(value) { return value.prompt },
    async call({ prompt }, context, canUseTool) {
      if (!context.productPromptContext) throw new Error('PLUGIN_AGENT_CONTEXT_MISSING')
      const messages: ProductHarnessMessage[] = []
      const childTools = context.options.tools.filter(tool => (
        tool.name !== 'Subtask'
        && !tool.name.startsWith('agent__')
        && (input.allowedTools.length === 0 || input.allowedTools.includes(tool.name))
      ))
      const childContext: ProductToolContext = {
        ...context,
        options: { ...context.options, tools: childTools, commandQueue: undefined },
        messages,
      }
      let result = ''
      for await (const event of runProductAgentLoop({
        commands: context.options.commands,
        prompt: `<named_agent_profile name="${input.plugin}:${input.name}">\n${input.instructions}\n</named_agent_profile>\n\n<assigned_task>\n${prompt}\n</assigned_task>`,
        tools: childTools,
        toolUseContext: childContext,
        canUseTool,
        mutableMessages: messages,
        promptContext: context.productPromptContext,
        model: input.model ?? context.options.mainLoopModel,
        runModel: context.runProductModel as Parameters<typeof runProductAgentLoop>[0]['runModel'],
        executeTools: context.executeProductTools as Parameters<typeof runProductAgentLoop>[0]['executeTools'],
        toolHooks: context.toolHooks,
      })) {
        if (event.type === 'result') result = event.result
        else if (event.type !== 'model_delta') context.onProductHarnessMessage?.(event, context.toolUseId)
      }
      if (!result.trim()) throw new Error('PLUGIN_AGENT_EMPTY_RESULT')
      return { data: result }
    },
    mapToolResultToToolResultBlockParam(result, toolUseID) { return { type: 'tool_result', tool_use_id: toolUseID, content: result } },
    renderToolUseMessage() { return null },
    renderToolUseProgressMessage() { return null },
    renderToolUseQueuedMessage() { return null },
    renderToolUseRejectedMessage() { return null },
    renderToolResultMessage() { return null },
    renderToolUseErrorMessage() { return null },
  })
}

export async function loadProductPluginAgentTools(directory: string, pluginRoot: string, namespace: string): Promise<ProductTool[]> {
  let root: string
  let boundary: string
  try { root = await fs.realpath(directory); boundary = await fs.realpath(pluginRoot) } catch { return [] }
  if (!isWithinRoot(boundary, root)) return []
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const output: ProductTool[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (output.length >= MAX_AGENTS || !entry.isFile() || entry.isSymbolicLink() || !entry.name.toLowerCase().endsWith('.md')) continue
    const file = path.join(root, entry.name)
    const stat = await fs.lstat(file).catch(() => undefined)
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_AGENT_BYTES) continue
    const canonical = await fs.realpath(file).catch(() => '')
    if (!canonical || !isWithinRoot(root, canonical)) continue
    const parsed = split(await fs.readFile(canonical, 'utf8'))
    if (!parsed?.body) continue
    const name = typeof parsed.metadata.name === 'string' ? parsed.metadata.name.trim() : path.basename(entry.name, path.extname(entry.name))
    const description = typeof parsed.metadata.description === 'string' ? parsed.metadata.description.trim() : ''
    const requestedModel = typeof parsed.metadata.model === 'string' ? parsed.metadata.model.trim() : undefined
    const model = requestedModel ? resolveProductTextModel(requestedModel) : undefined
    if (!SAFE_NAME.test(name) || !description || description.length > 2_000 || (requestedModel && !model)) continue
    output.push(agentTool({ plugin: namespace, name, description, instructions: parsed.body, allowedTools: allowedTools(parsed.metadata.tools), ...(model ? { model } : {}) }))
  }
  return output
}

export function productAgentCommands(tools: readonly ProductTool[]): ProductCommand[] {
  return tools
    .filter(tool => tool.name.startsWith('agent__'))
    .map((tool) => {
      const displayName = tool.userFacingName()
      return {
        type: 'prompt' as const,
        name: `agent:${tool.name}`,
        description: `使用 ${displayName} 独立处理一项任务。`,
        argumentHint: '<prompt>',
        userInvocable: true,
        source: tool.name.startsWith('agent__project__') ? 'project' as const : 'plugin' as const,
        contentLength: displayName.length,
        progressMessage: `正在启动 ${displayName}`,
        directTool: { name: tool.name, argument: 'prompt' },
        async getPromptForCommand(args: string) {
          const prompt = args.trim()
          if (!prompt) throw new Error('PRODUCT_AGENT_PROMPT_REQUIRED')
          return [{ type: 'text' as const, text: `已明确指派给 ${displayName}：\n${prompt}` }]
        },
      }
    })
}
