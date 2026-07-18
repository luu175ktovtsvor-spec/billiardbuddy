import { basename, dirname, sep } from 'node:path'
import { getBuiltinPluginDefinition } from '../../plugins/builtinPlugins.js'
import {
  disablePluginOp,
  enablePluginOp,
  type InstallableScope,
  uninstallPluginOp,
  updatePluginOp,
} from '../../services/plugins/pluginOperations.js'
import { getAgentDefinitionsWithOverrides } from '../../tools/AgentTool/loadAgentsDir.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js'
import { loadInstalledPluginsV2 } from '../../utils/plugins/installedPluginsManager.js'
import { loadPluginLspServers } from '../../utils/plugins/lspPluginIntegration.js'
import { loadPluginMcpServers } from '../../utils/plugins/mcpPluginIntegration.js'
import { parsePluginIdentifier } from '../../utils/plugins/pluginIdentifier.js'
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js'
import { loadPluginHooks } from '../../utils/plugins/loadPluginHooks.js'
import { getPluginSkills } from '../../utils/plugins/loadPluginCommands.js'
import { clearPluginCacheExclusions } from '../../utils/plugins/orphanedPluginFilter.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import type {
  PluginInstallationEntry,
  PluginScope,
} from '../../utils/plugins/schemas.js'
import { ApiError } from '../middleware/errorHandler.js'
import { walkPluginMarkdown } from '../../utils/plugins/walkPluginMarkdown.js'

export type ApiPluginCapabilityKind =
  | 'commands'
  | 'agents'
  | 'skills'
  | 'hooks'
  | 'mcpServers'
  | 'lspServers'

export type ApiPluginStatus = 'attention' | 'enabled' | 'disabled'

/** A product-owned description category; plugin-authored text is never exposed. */
export type ApiPluginDescriptionKind = 'workspace_extension'

export type ApiPluginComponentCounts = Record<ApiPluginCapabilityKind, number>

export type ApiPluginSummary = {
  /** Opaque identifier required for enable, disable, update, and uninstall. */
  id: string
  /** Product-facing plugin name. */
  name: string
  /** Scope is retained only so real plugin operations can target the installation. */
  scope: PluginScope | 'builtin'
  enabled: boolean
  /** A stable, actionable status category. No runtime error text is exposed. */
  status: ApiPluginStatus
  /** Whether this installation can be changed from the desktop app. */
  canManage: boolean
  /** Selects a product-owned, localized description instead of manifest text. */
  descriptionKind: ApiPluginDescriptionKind
  /** Capability categories and counts only; individual configuration is private. */
  componentCounts: ApiPluginComponentCounts
}

/** Detail deliberately has the same safe shape as a list item. */
export type ApiPluginDetail = ApiPluginSummary

type PluginStateDetail = {
  id: string
  name: string
  scope: PluginScope | 'builtin'
  enabled: boolean
  hasErrors: boolean
  componentCounts: ApiPluginComponentCounts
}

export type ApiPluginListResponse = {
  plugins: ApiPluginSummary[]
  summary: {
    total: number
    enabled: number
    attention: number
  }
}

export type ApiPluginAction = 'enabled' | 'disabled' | 'updated' | 'uninstalled'

export type ApiPluginActionResponse = {
  ok: true
  action: ApiPluginAction
}

export type ApiPluginReloadResponse = {
  ok: true
  summary: {
    enabled: number
    disabled: number
    skills: number
    agents: number
    hooks: number
    mcpServers: number
    lspServers: number
    errors: number
  }
}

type HydratedPluginState = {
  enabled: LoadedPlugin[]
  disabled: LoadedPlugin[]
  errors: PluginError[]
}

export class PluginService {
  async listPlugins(cwd?: string): Promise<ApiPluginListResponse> {
    const { plugins } = await this.collectPluginState(cwd)
    return {
      plugins,
      summary: {
        total: plugins.length,
        enabled: plugins.filter((plugin) => plugin.enabled).length,
        attention: plugins.filter((plugin) => plugin.status === 'attention').length,
      },
    }
  }

  async getPluginDetail(
    pluginId: string,
    cwd?: string,
  ): Promise<ApiPluginDetail> {
    const { detailById } = await this.collectPluginState(cwd)
    const detail = detailById.get(pluginId)

    if (!detail) {
      throw ApiError.notFound(`Plugin not found: ${pluginId}`)
    }

    return this.toPublicSummary(detail)
  }

  async enablePlugin(
    pluginId: string,
    scope?: InstallableScope,
  ): Promise<ApiPluginActionResponse> {
    const result = await enablePluginOp(pluginId, scope)
    if (!result.success) {
      throw new ApiError(400, 'Plugin action could not be completed', 'PLUGIN_ACTION_FAILED')
    }
    return { ok: true, action: 'enabled' }
  }

  async disablePlugin(
    pluginId: string,
    scope?: InstallableScope,
  ): Promise<ApiPluginActionResponse> {
    const result = await disablePluginOp(pluginId, scope)
    if (!result.success) {
      throw new ApiError(400, 'Plugin action could not be completed', 'PLUGIN_ACTION_FAILED')
    }
    return { ok: true, action: 'disabled' }
  }

  async uninstallPlugin(
    pluginId: string,
    scope?: InstallableScope,
    keepData = false,
  ): Promise<ApiPluginActionResponse> {
    if (!scope) {
      throw new ApiError(400, 'Plugin action requires a scope', 'PLUGIN_ACTION_INVALID')
    }

    const result = await uninstallPluginOp(pluginId, scope, keepData)
    if (!result.success) {
      throw new ApiError(400, 'Plugin action could not be completed', 'PLUGIN_ACTION_FAILED')
    }
    return { ok: true, action: 'uninstalled' }
  }

  async updatePlugin(
    pluginId: string,
    scope?: PluginScope,
  ): Promise<ApiPluginActionResponse> {
    if (!scope) {
      throw new ApiError(400, 'Plugin action requires a scope', 'PLUGIN_ACTION_INVALID')
    }

    const result = await updatePluginOp(pluginId, scope)
    if (!result.success) {
      throw new ApiError(400, 'Plugin action could not be completed', 'PLUGIN_ACTION_FAILED')
    }
    return { ok: true, action: 'updated' }
  }

  async reloadPlugins(cwd?: string): Promise<ApiPluginReloadResponse> {
    resetSettingsCache()
    clearAllCaches()
    clearPluginCacheExclusions()

    const pluginState = await this.loadPluginState()
    const { enabled, disabled, errors } = pluginState

    const [skills, agentDefinitions] = await Promise.all([
      getPluginSkills(),
      getAgentDefinitionsWithOverrides(cwd),
    ])

    const hookCount = await this.getHookCount(enabled)
    const mcpCounts = await Promise.all(
      enabled.map(async (plugin) => {
        const servers = plugin.mcpServers || await loadPluginMcpServers(plugin, errors)
        return servers ? Object.keys(servers).length : 0
      }),
    )
    const lspCounts = await Promise.all(
      enabled.map(async (plugin) => {
        const servers = plugin.lspServers || await loadPluginLspServers(plugin, errors)
        return servers ? Object.keys(servers).length : 0
      }),
    )

    return {
      ok: true,
      summary: {
        enabled: enabled.length,
        disabled: disabled.length,
        skills: skills.length,
        agents: agentDefinitions.allAgents.length,
        hooks: hookCount,
        mcpServers: mcpCounts.reduce((sum, count) => sum + count, 0),
        lspServers: lspCounts.reduce((sum, count) => sum + count, 0),
        errors: errors.length,
      },
    }
  }

  private async collectPluginState(cwd?: string): Promise<{
    plugins: ApiPluginSummary[]
    detailById: Map<string, PluginStateDetail>
  }> {
    const [pluginState, installedData] = await Promise.all([
      this.loadPluginState(),
      Promise.resolve(loadInstalledPluginsV2()),
    ])

    const allLoaded = [...pluginState.enabled, ...pluginState.disabled]
    const loadedById = new Map(
      allLoaded
        .filter((plugin) => !plugin.source.endsWith('@inline'))
        .map((plugin) => [plugin.source, plugin]),
    )

    const pluginIds = new Set<string>([
      ...Object.keys(installedData.plugins),
      ...allLoaded
        .filter((plugin) => !plugin.source.endsWith('@inline'))
        .map((plugin) => plugin.source),
    ])

    const detailById = new Map<string, PluginStateDetail>()

    for (const pluginId of [...pluginIds].sort()) {
      const installation = this.pickInstallation(
        installedData.plugins[pluginId] ?? [],
        cwd,
      )
      const loaded = loadedById.get(pluginId)
      const detail = await this.serializePluginDetail(
        pluginId,
        installation,
        loaded,
        pluginState.errors,
      )
      detailById.set(pluginId, detail)
    }

    const plugins = [...detailById.values()].map((detail) =>
      this.toPublicSummary(detail),
    )

    return {
      plugins,
      detailById,
    }
  }

  private async loadPluginState(): Promise<HydratedPluginState> {
    const result = await loadAllPlugins()
    await Promise.all(
      result.enabled.map(async (plugin) => {
        plugin.mcpServers = plugin.mcpServers || await loadPluginMcpServers(plugin, result.errors)
        plugin.lspServers = plugin.lspServers || await loadPluginLspServers(plugin, result.errors)
      }),
    )
    return result
  }

  private async serializePluginDetail(
    pluginId: string,
    installation: PluginInstallationEntry | null,
    loaded: LoadedPlugin | undefined,
    errors: PluginError[],
  ): Promise<PluginStateDetail> {
    const { name } = parsePluginIdentifier(pluginId)
    const hasErrors = this.hasErrorsForPlugin(pluginId, name, errors)

    if (!loaded) {
      return {
        id: pluginId,
        name,
        scope: installation?.scope ?? 'user',
        enabled: false,
        hasErrors,
        componentCounts: this.emptyComponentCounts(),
      }
    }

    return {
      id: pluginId,
      name: loaded.name,
      scope: installation?.scope ?? 'user',
      enabled: loaded.enabled !== false,
      hasErrors,
      componentCounts: await this.collectComponentCounts(loaded),
    }
  }

  private async collectComponentCounts(
    plugin: LoadedPlugin,
  ): Promise<ApiPluginComponentCounts> {
    if (plugin.isBuiltin) {
      const definition = getBuiltinPluginDefinition(plugin.name)
      return {
        commands: 0,
        agents: 0,
        skills: definition?.skills?.length ?? 0,
        hooks: Object.keys(definition?.hooks ?? {}).length,
        mcpServers: Object.keys(definition?.mcpServers ?? {}).length,
        lspServers: 0,
      }
    }

    const [commands, agents, skills] = await Promise.all([
      this.countMarkdownFiles(
        [plugin.commandsPath, ...(plugin.commandsPaths ?? [])],
        true,
      ),
      this.countMarkdownFiles(
        [plugin.agentsPath, ...(plugin.agentsPaths ?? [])],
        false,
      ),
      this.countSkillDirectories([
        plugin.skillsPath,
        ...(plugin.skillsPaths ?? []),
      ]),
    ])

    return {
      commands,
      agents,
      skills,
      hooks: Object.keys(plugin.hooksConfig ?? {}).length,
      mcpServers: Object.keys(plugin.mcpServers ?? {}).length,
      lspServers: Object.keys(plugin.lspServers ?? {}).length,
    }
  }

  private async countMarkdownFiles(
    paths: Array<string | undefined>,
    stopAtSkillDir: boolean,
  ): Promise<number> {
    const files = new Set<string>()
    await Promise.all(
      paths
        .filter((path): path is string => Boolean(path))
        .map((rootPath) => walkPluginMarkdown(
          rootPath,
          async (fullPath) => {
            files.add(fullPath)
          },
          { stopAtSkillDir, logLabel: 'plugin-capability-count' },
        )),
    )
    return files.size
  }

  private async countSkillDirectories(
    paths: Array<string | undefined>,
  ): Promise<number> {
    const directories = new Set<string>()
    await Promise.all(
      paths
        .filter((path): path is string => Boolean(path))
        .map((rootPath) => walkPluginMarkdown(
          rootPath,
          async (fullPath) => {
            if (basename(fullPath).toLowerCase() === 'skill.md') {
              directories.add(dirname(fullPath))
            }
          },
          { stopAtSkillDir: true, logLabel: 'plugin-skill-count' },
        )),
    )
    return directories.size
  }

  private hasErrorsForPlugin(
    pluginId: string,
    pluginName: string,
    errors: PluginError[],
  ): boolean {
    return errors.some((error) => {
      if (error.source === pluginId) return true
      if ('plugin' in error && error.plugin === pluginName) return true
      return error.source.startsWith(`${pluginName}@`)
    })
  }

  private pickInstallation(
    installations: PluginInstallationEntry[],
    cwd?: string,
  ): PluginInstallationEntry | null {
    if (!installations.length) return null

    const relevantForCwd = cwd
      ? installations.filter((entry) =>
          entry.projectPath ? this.isPathWithinProject(cwd, entry.projectPath) : false,
        )
      : []

    const localMatch = relevantForCwd.find((entry) => entry.scope === 'local')
    if (localMatch) return localMatch

    const projectMatch = relevantForCwd.find((entry) => entry.scope === 'project')
    if (projectMatch) return projectMatch

    const userMatch = installations.find((entry) => entry.scope === 'user')
    if (userMatch) return userMatch

    return installations[0] ?? null
  }

  private isPathWithinProject(cwd: string, projectPath: string): boolean {
    return cwd === projectPath || cwd.startsWith(`${projectPath}${sep}`)
  }

  private emptyComponentCounts(): ApiPluginComponentCounts {
    return {
      commands: 0,
      agents: 0,
      skills: 0,
      hooks: 0,
      mcpServers: 0,
      lspServers: 0,
    }
  }

  private toPublicSummary(detail: PluginStateDetail): ApiPluginSummary {
    return {
      id: detail.id,
      name: detail.name,
      scope: detail.scope,
      enabled: detail.enabled,
      status: detail.hasErrors
        ? 'attention'
        : detail.enabled
          ? 'enabled'
          : 'disabled',
      canManage: detail.scope !== 'managed' && detail.scope !== 'builtin',
      descriptionKind: 'workspace_extension',
      componentCounts: detail.componentCounts,
    }
  }

  private async getHookCount(plugins: LoadedPlugin[]): Promise<number> {
    try {
      await loadPluginHooks()
    } catch {
      // Hook loading failures are already represented in the shared plugin errors.
    }

    return plugins.reduce((sum, plugin) => {
      if (!plugin.hooksConfig) return sum
      return sum + Object.values(plugin.hooksConfig).reduce((hookSum, matchers) => (
        hookSum + (matchers?.reduce((matcherSum, matcher) => matcherSum + matcher.hooks.length, 0) ?? 0)
      ), 0)
    }, 0)
  }
}
