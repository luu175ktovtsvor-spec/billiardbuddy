import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ApiError } from '../middleware/errorHandler.js'
import {
  listProductPlugins,
  hasProductPluginUpdateSource,
  installProductPluginFromDirectory,
  productPluginSkillRoots,
  productPluginAgentRoots,
  productPluginCommandRoots,
  productPluginHookFiles,
  setProductPluginEnabled,
  uninstallProductPlugin,
  updateProductPluginFromSource,
  type ProductPlugin,
  type ProductPluginScope,
} from './productPluginRegistry.js'
import { loadProductPluginCommands } from '../agent-worker/productPluginCommandLoader.js'
import { loadProductPluginAgentTools } from '../agent-worker/productPluginAgentLoader.js'
import { loadProductSkillCommandsFromDirectory } from '../agent-worker/productSkillLoader.js'
import { inspectProductPluginHookFile } from '../agent-worker/productHookSnapshot.js'

export type ApiPluginCapabilityKind = 'commands' | 'agents' | 'skills' | 'hooks' | 'mcpServers' | 'lspServers'
export type ApiPluginStatus = 'attention' | 'enabled' | 'disabled'
export type ApiPluginDescriptionKind = 'workspace_extension'
export type ApiPluginComponentCounts = Record<ApiPluginCapabilityKind, number>
export type ApiPluginSummary = {
  id: string
  name: string
  scope: ProductPluginScope
  enabled: boolean
  status: ApiPluginStatus
  canManage: true
  canUpdate: boolean
  descriptionKind: ApiPluginDescriptionKind
  componentCounts: ApiPluginComponentCounts
}
export type ApiPluginDetail = ApiPluginSummary
export type ApiPluginListResponse = { plugins: ApiPluginSummary[]; summary: { total: number; enabled: number; attention: number } }
export type ApiPluginAction = 'enabled' | 'disabled' | 'installed' | 'updated' | 'uninstalled'
export type ApiPluginActionResponse = { ok: true; action: ApiPluginAction }
export type ApiPluginReloadResponse = { ok: true; summary: { enabled: number; disabled: number; skills: number; agents: number; hooks: number; mcpServers: number; lspServers: number; errors: number } }

async function rawMarkdown(directory: string): Promise<number> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  return entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.md')).length
}

async function counts(plugin: ProductPlugin): Promise<{ components: ApiPluginComponentCounts; errors: number }> {
  const skillRoots = productPluginSkillRoots(plugin)
  const commandRoots = productPluginCommandRoots(plugin)
  const agentRoots = productPluginAgentRoots(plugin)
  const hookFiles = productPluginHookFiles(plugin)
  const [skills, rawSkills, commands, rawCommands, agents, rawAgents, hooks] = await Promise.all([
    Promise.all(skillRoots.map(root => loadProductSkillCommandsFromDirectory(root, plugin.root, plugin.name))),
    Promise.all(skillRoots.map(async root => {
      const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
      return entries.filter(entry => entry.isDirectory()).length
    })),
    Promise.all(commandRoots.map(root => loadProductPluginCommands(root, plugin.root, plugin.name))),
    Promise.all(commandRoots.map(rawMarkdown)),
    Promise.all(agentRoots.map(root => loadProductPluginAgentTools(root, plugin.root, plugin.name))),
    Promise.all(agentRoots.map(rawMarkdown)),
    Promise.all(hookFiles.map(file => inspectProductPluginHookFile(file, plugin.root))),
  ])
  const components = {
    skills: skills.flat().length,
    commands: commands.flat().length,
    agents: agents.flat().length,
    hooks: hooks.filter(Boolean).length,
    mcpServers: Object.keys(plugin.manifest.mcpServers ?? {}).length,
    lspServers: Object.keys(plugin.manifest.lspServers ?? {}).length,
  }
  const errors = Math.max(0, rawSkills.reduce((sum, value) => sum + value, 0) - components.skills)
    + Math.max(0, rawCommands.reduce((sum, value) => sum + value, 0) - components.commands)
    + Math.max(0, rawAgents.reduce((sum, value) => sum + value, 0) - components.agents)
    + Math.max(0, hookFiles.length - components.hooks)
  return { components, errors }
}

async function summary(plugin: ProductPlugin, cwd: string): Promise<ApiPluginSummary> {
  const inspected = await counts(plugin)
  return {
    id: plugin.id,
    name: plugin.name,
    scope: plugin.scope,
    enabled: plugin.enabled,
    status: plugin.enabled ? inspected.errors ? 'attention' : 'enabled' : 'disabled',
    canManage: true,
    canUpdate: await hasProductPluginUpdateSource(plugin.id, plugin.scope, cwd).catch(() => false),
    descriptionKind: 'workspace_extension',
    componentCounts: inspected.components,
  }
}

export class PluginService {
  async listPlugins(cwd = process.cwd()): Promise<ApiPluginListResponse> {
    const plugins = await Promise.all((await listProductPlugins(cwd)).map(plugin => summary(plugin, cwd)))
    return { plugins, summary: { total: plugins.length, enabled: plugins.filter(value => value.enabled).length, attention: plugins.filter(value => value.status === 'attention').length } }
  }

  async getPluginDetail(pluginId: string, cwd = process.cwd()): Promise<ApiPluginDetail> {
    const plugin = (await listProductPlugins(cwd)).find(value => value.id === pluginId)
    if (!plugin) throw ApiError.notFound('Plugin not found')
    return summary(plugin, cwd)
  }

  async enablePlugin(pluginId: string, _scope?: ProductPluginScope, cwd = process.cwd()): Promise<ApiPluginActionResponse> {
    await setProductPluginEnabled(pluginId, true, cwd).catch(() => { throw new ApiError(404, 'Plugin not found', 'PLUGIN_NOT_FOUND') })
    return { ok: true, action: 'enabled' }
  }

  async disablePlugin(pluginId: string, _scope?: ProductPluginScope, cwd = process.cwd()): Promise<ApiPluginActionResponse> {
    await setProductPluginEnabled(pluginId, false, cwd).catch(() => { throw new ApiError(404, 'Plugin not found', 'PLUGIN_NOT_FOUND') })
    return { ok: true, action: 'disabled' }
  }

  async uninstallPlugin(pluginId: string, _scope?: ProductPluginScope, _keepData = false, cwd = process.cwd()): Promise<ApiPluginActionResponse> {
    await uninstallProductPlugin(pluginId, cwd).catch(() => { throw new ApiError(404, 'Plugin not found', 'PLUGIN_NOT_FOUND') })
    return { ok: true, action: 'uninstalled' }
  }

  async updatePlugin(pluginId: string, _scope?: ProductPluginScope, cwd = process.cwd()): Promise<ApiPluginActionResponse> {
    await updateProductPluginFromSource(pluginId, cwd).catch(error => {
      const code = error instanceof Error ? error.message : ''
      if (code === 'PLUGIN_NOT_FOUND') throw new ApiError(404, 'Plugin not found', 'PLUGIN_NOT_FOUND')
      if (code === 'PLUGIN_UPDATE_UNAVAILABLE') throw new ApiError(409, 'Plugin update source is unavailable', 'PLUGIN_ACTION_INVALID')
      throw new ApiError(400, 'Plugin update failed', 'PLUGIN_ACTION_FAILED')
    })
    return { ok: true, action: 'updated' }
  }

  async installPlugin(sourcePath: string, scope: ProductPluginScope, cwd = process.cwd()): Promise<ApiPluginActionResponse> {
    await installProductPluginFromDirectory(sourcePath, scope, cwd).catch(error => {
      const code = error instanceof Error ? error.message : ''
      if (code === 'PLUGIN_NAME_CONFLICT') throw new ApiError(409, 'Plugin already exists', 'PLUGIN_ACTION_INVALID')
      throw new ApiError(400, 'Plugin install failed', 'PLUGIN_ACTION_FAILED')
    })
    return { ok: true, action: 'installed' }
  }

  async reloadPlugins(cwd = process.cwd()): Promise<ApiPluginReloadResponse> {
    const plugins = await listProductPlugins(cwd)
    const inspected = await Promise.all(plugins.filter(value => value.enabled).map(counts))
    const total = (key: ApiPluginCapabilityKind) => inspected.reduce((sum, value) => sum + value.components[key], 0)
    return { ok: true, summary: {
      enabled: plugins.filter(value => value.enabled).length,
      disabled: plugins.filter(value => !value.enabled).length,
      skills: total('skills'), agents: total('agents'), hooks: total('hooks'), mcpServers: total('mcpServers'), lspServers: total('lspServers'), errors: inspected.reduce((sum, value) => sum + value.errors, 0),
    } }
  }
}
