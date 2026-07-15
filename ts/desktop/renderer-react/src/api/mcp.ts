// MCP 服务 api(接后端 /api/v1/agent/mcp*)。前端插件页/连接器用它:
// 列已装、列预设(Playwright/高德一键启用)、增/删/停。契约对齐 src/mcp/configStore + server/index。
import {
  extensionMutationResultSchema,
  mcpAddRequestSchema,
  mcpListResponseSchema,
  mcpPresetsResponseSchema,
  workspaceTrustRequestSchema,
  workspaceTrustResponseSchema,
  type ExtensionMutationResult,
  type McpAddRequest,
  type McpListResponse,
  type McpPreset,
  type McpServerStatus,
} from '../../../../shared/contracts/extensions'
import { api } from './client'

export type { McpPreset, McpServerStatus }
export type AddMcpInput = McpAddRequest
export type McpListResult = McpListResponse
export type McpMutationResult = ExtensionMutationResult

export const mcpApi = {
  /** 已装 MCP 列表 + 连接/工具数状态。 */
  list: async (workspaceRoot?: string) => mcpListResponseSchema.parse(
    await api.get<unknown>(`/api/v1/agent/mcp${workspaceRoot ? `?workspaceRoot=${encodeURIComponent(workspaceRoot)}` : ''}`),
  ),
  /** 预设目录(一键启用:Playwright / 高德)。 */
  presets: async () => mcpPresetsResponseSchema.parse(await api.get<unknown>('/api/v1/agent/mcp/presets')),
  /** 添加(本机 command 或远程 url)。url 含 <占位> 时后端拒(需先填真实 key)。 */
  add: async (input: AddMcpInput) => extensionMutationResultSchema.parse(
    await api.post<unknown>('/api/v1/agent/mcp/add', mcpAddRequestSchema.parse(input)),
  ),
  /** 删除。 */
  remove: async (name: string) => extensionMutationResultSchema.parse(
    await api.post<unknown>('/api/v1/agent/mcp/remove', { name }),
  ),
  /** 停用/启用。 */
  toggle: async (name: string, disabled: boolean) => extensionMutationResultSchema.parse(
    await api.post<unknown>('/api/v1/agent/mcp/toggle', { name, disabled }),
  ),
  trust: async () => workspaceTrustResponseSchema.parse(await api.get<unknown>('/api/v1/agent/mcp/trust')),
  setWorkspaceTrusted: async (workspaceRoot: string, trusted: boolean) => workspaceTrustResponseSchema.parse(
    trusted
      ? await api.post<unknown>('/api/v1/agent/mcp/trust', workspaceTrustRequestSchema.parse({ workspaceRoot }))
      : await api.delete<unknown>(`/api/v1/agent/mcp/trust?workspaceRoot=${encodeURIComponent(workspaceRoot)}`),
  ),
}

/** 从预设生成 add 入参:stdio 带 command+args;远程带 url+transport(需 key 的调用方先把 <占位> 换成真实值)。 */
export function addInputFromPreset(preset: McpPreset, filledUrl?: string): AddMcpInput {
  if (preset.transport === 'stdio') {
    return { name: preset.id, command: preset.command, args: preset.args }
  }
  return { name: preset.id, url: filledUrl ?? preset.url, transport: preset.transport, headers: preset.headers }
}
