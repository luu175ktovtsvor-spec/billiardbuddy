export type PluginScope = 'user' | 'project' | 'local' | 'managed' | 'builtin'

export type PluginCapabilityKey =
  | 'commands'
  | 'agents'
  | 'skills'
  | 'hooks'
  | 'mcpServers'
  | 'lspServers'

export type PluginComponentCounts = Record<PluginCapabilityKey, number>

export type PluginStatus = 'attention' | 'enabled' | 'disabled'

export type PluginDescriptionKind = 'workspace_extension'

export type PluginAction = 'enabled' | 'disabled' | 'updated' | 'uninstalled'

export type PluginRequestErrorCode =
  | 'PLUGIN_ACTION_FAILED'
  | 'PLUGIN_ACTION_INVALID'
  | 'PLUGIN_NOT_FOUND'
  | 'PLUGIN_REQUEST_FAILED'

export type PluginSummary = {
  id: string
  name: string
  scope: PluginScope
  enabled: boolean
  status: PluginStatus
  canManage: boolean
  descriptionKind: PluginDescriptionKind
  componentCounts: PluginComponentCounts
}

export type PluginDetail = PluginSummary

export type PluginListResponse = {
  plugins: PluginSummary[]
  summary: {
    total: number
    enabled: number
    attention: number
  }
}

export type PluginReloadSummary = {
  enabled: number
  disabled: number
  skills: number
  agents: number
  hooks: number
  mcpServers: number
  lspServers: number
  errors: number
}

export type PluginSessionReloadSummary = {
  applied: boolean
  reason?: 'not_running' | 'failed'
  commands: number
  agents: number
  plugins: number
  mcpServers: number
  errors: number
}
