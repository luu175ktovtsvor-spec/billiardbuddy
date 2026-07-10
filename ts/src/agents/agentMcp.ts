import type { Tool } from '../tools/Tool'
import { connectMcpServers, closeMcpConnections, type LoadMcpToolsOptions } from '../mcp/client'
import { loadMcpConfigFile, normalizeMcpConfig, type McpServerConfig } from '../mcp/config'
import type { AgentDefinition, AgentMcpServerSpec } from './agentLoader'

export interface AgentMcpRuntimeOptions {
  mcpConfigPath?: string
  loadOptions?: (input: { workspaceRoot: string; signal?: AbortSignal; taskId?: string }) => LoadMcpToolsOptions
}

export interface AgentMcpRuntimeInput extends AgentMcpRuntimeOptions {
  agent: AgentDefinition
  baseTools: Tool[]
  workspaceRoot: string
  signal?: AbortSignal
  taskId?: string
}

export interface AgentMcpRuntime {
  tools: Tool[]
  warnings: string[]
  close(): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function serverNameFromTool(tool: Tool): string[] {
  const names: string[] = []
  if (tool.name.startsWith('mcp__')) {
    const server = tool.name.split('__')[1]
    if (server) names.push(server, server.replace(/_/g, ' '))
  }
  const match = tool.description.match(/^MCP tool from server "([^"]+)":/m)
  if (match?.[1]) names.push(match[1])
  return names
}

export function mcpServerNamesFromTools(tools: Tool[]): string[] {
  return [...new Set(tools.flatMap(serverNameFromTool).filter(Boolean))]
}

export function hasRequiredMcpServers(agent: AgentDefinition, availableServers: string[]): boolean {
  if (!agent.requiredMcpServers?.length) return true
  return agent.requiredMcpServers.every(pattern =>
    availableServers.some(server => server.toLowerCase().includes(pattern.toLowerCase())),
  )
}

export function assertRequiredMcpServers(agent: AgentDefinition, tools: Tool[]): void {
  if (!agent.requiredMcpServers?.length) return
  const available = mcpServerNamesFromTools(tools)
  if (hasRequiredMcpServers(agent, available)) return
  const missing = agent.requiredMcpServers.filter(pattern =>
    !available.some(server => server.toLowerCase().includes(pattern.toLowerCase())),
  )
  throw new Error(
    `Agent '${agent.name}' requires MCP servers matching: ${missing.join(', ')}. ` +
    `MCP servers with tools: ${available.length > 0 ? available.join(', ') : 'none'}.`,
  )
}

function configName(config: McpServerConfig): string {
  return config.name.trim().toLowerCase()
}

async function configuredMcpServers(path: string | undefined): Promise<McpServerConfig[]> {
  if (!path) return []
  return loadMcpConfigFile(path).catch(() => [])
}

function inlineSpecConfigs(spec: Record<string, unknown>): McpServerConfig[] {
  if (typeof spec.name === 'string' && spec.name.trim()) {
    return normalizeMcpConfig({ mcpServers: { [spec.name.trim()]: spec } })
  }
  return normalizeMcpConfig({ mcpServers: spec })
}

async function resolveAgentMcpConfigs(
  agent: AgentDefinition,
  mcpConfigPath: string | undefined,
): Promise<{ configs: McpServerConfig[]; warnings: string[] }> {
  const configs: McpServerConfig[] = []
  const warnings: string[] = []
  const configured = await configuredMcpServers(mcpConfigPath)
  const byName = new Map(configured.map(config => [configName(config), config]))

  for (const spec of agent.mcpServers ?? []) {
    if (typeof spec === 'string') {
      const found = byName.get(spec.trim().toLowerCase())
      if (!found) {
        warnings.push(`Agent "${agent.name}" MCP server "${spec}" not found in configured MCP servers.`)
        continue
      }
      if (found.disabled) {
        warnings.push(`Agent "${agent.name}" MCP server "${spec}" is disabled.`)
        continue
      }
      configs.push(found)
      continue
    }
    if (!isRecord(spec)) continue
    const inlineConfigs = inlineSpecConfigs(spec).filter(config => !config.disabled)
    if (inlineConfigs.length === 0) {
      warnings.push(`Agent "${agent.name}" has an invalid mcpServers inline spec.`)
      continue
    }
    configs.push(...inlineConfigs)
  }

  const seen = new Set<string>()
  return {
    configs: configs.filter(config => {
      const key = configName(config)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
    warnings,
  }
}

function mergeTools(baseTools: Tool[], extraTools: Tool[]): Tool[] {
  const seen = new Set(baseTools.map(tool => tool.name))
  const merged = [...baseTools]
  for (const tool of extraTools) {
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    merged.push(tool)
  }
  return merged
}

export async function loadAgentMcpRuntime(input: AgentMcpRuntimeInput): Promise<AgentMcpRuntime> {
  const { configs, warnings } = await resolveAgentMcpConfigs(input.agent, input.mcpConfigPath)
  if (configs.length === 0) {
    assertRequiredMcpServers(input.agent, input.baseTools)
    return {
      tools: input.baseTools,
      warnings,
      close: async () => {},
    }
  }

  const loadOptions = input.loadOptions?.({
    workspaceRoot: input.workspaceRoot,
    signal: input.signal,
    taskId: input.taskId,
  }) ?? {}
  const loaded = await connectMcpServers(configs, {
    cwd: input.workspaceRoot,
    signal: input.signal,
    timeoutMs: 10000,
    // toolTimeoutMs 不在这里硬编码:留空走 mcp/client.ts 的 mcpToolTimeoutMs() 默认值(对齐 cc 近乎无限,
    // 可用 QF_MCP_TOOL_TIMEOUT 覆盖),别在调用方悄悄把 P0 修复顶掉。
    ...loadOptions,
  })
  const tools = mergeTools(input.baseTools, loaded.tools)
  try {
    assertRequiredMcpServers(input.agent, tools)
  } catch (error) {
    await closeMcpConnections(loaded.connections)
    throw error
  }
  return {
    tools,
    warnings: [...warnings, ...loaded.warnings],
    close: async () => {
      await closeMcpConnections(loaded.connections)
    },
  }
}
