export type McpConnectionConfig =
  | {
      type: 'stdio'
      command: string
      args: string[]
      env: Record<string, string>
    }
  | {
      type: 'http' | 'sse'
      url: string
      headers: Record<string, string>
      headersHelper?: string
      oauth?: {
        clientId?: string
        callbackPort?: number
      }
    }
  | {
      type: string
    }

export type McpServerRecord = {
  name: string
  scope: string
  transport: string
  enabled: boolean
  status: 'connected' | 'needs-auth' | 'failed' | 'disabled' | 'checking'
  canEdit: boolean
  canRemove: boolean
  canReconnect: boolean
  canToggle: boolean
  projectPath?: string
}

export type McpWritableScope = 'local' | 'project' | 'user'

export type McpUpsertPayload = {
  scope: McpWritableScope
  config: McpConnectionConfig
}

/** Safe result of applying an MCP toggle to the active product task. */
export type McpTaskSyncResult = {
  applied: boolean
  reason?: 'not_running' | 'failed'
}

export type McpToggleResponse = {
  server: McpServerRecord
  taskSync?: McpTaskSyncResult
}
