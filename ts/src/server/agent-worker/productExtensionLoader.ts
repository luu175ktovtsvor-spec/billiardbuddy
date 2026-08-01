import fs from 'node:fs'
import path from 'node:path'
import uniqBy from 'lodash-es/uniqBy.js'
import { initProductBundledSkills } from '../../skills/bundled/productIndex.js'
import { PRODUCT_HARNESS_SKILL_NAMES } from '../../skills/bundled/productHarness.js'
import { getProductBundledSkills } from '../../skills/productSkillRegistry.js'
import { listProductPlugins, productPluginCommandRoots, productPluginLspServers, productPluginSkillRoots } from '../services/productPluginRegistry.js'
import { findProductGitRoot } from '../product/productGit.js'
import { loadProductSkillCommandsFromDirectory } from './productSkillLoader.js'
import type { ProductCommand, ProductTool } from './productTool.js'
import { loadProductPluginCommands } from './productPluginCommandLoader.js'
import { createProductPluginLspTool } from './productPluginLspLoader.js'

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function productExtensionDirectories(cwd: string, kind: 'skills'): { root: string; directories: string[] } | null {
  const discoveredRoot = findProductGitRoot(cwd) ?? cwd
  let root: string
  let active: string
  try {
    root = fs.realpathSync(discoveredRoot)
    active = fs.realpathSync(cwd)
  } catch {
    return null
  }
  if (!isWithinRoot(root, active)) return null
  const relative = path.relative(root, active)
  const directories = [root]
  let current = root
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    directories.push(current)
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const directory of directories.reverse()) {
    const candidate = path.join(directory, '.BilliardBuddy', kind)
    let canonical: string
    try {
      if (!fs.statSync(candidate).isDirectory()) continue
      canonical = fs.realpathSync(candidate)
    } catch {
      continue
    }
    if (!isWithinRoot(root, canonical) || seen.has(canonical)) continue
    seen.add(canonical)
    result.push(canonical)
  }
  return { root, directories: result }
}

async function loadProductSkillCommands(cwd: string): Promise<ProductCommand[]> {
  const discovered = productExtensionDirectories(cwd, 'skills')
  if (!discovered) return []
  const loaded = await Promise.all(discovered.directories.map(directory => (
    loadProductSkillCommandsFromDirectory(directory, discovered.root)
  )))
  return loaded.flat()
}

async function loadProductPluginSkillCommands(cwd: string): Promise<ProductCommand[]> {
  const plugins = (await listProductPlugins(cwd)).filter(plugin => plugin.enabled)
  const loaded = await Promise.all(plugins.flatMap(plugin => productPluginSkillRoots(plugin).map(async directory => {
    return loadProductSkillCommandsFromDirectory(directory, plugin.root, plugin.name)
  })))
  return loaded.flat()
}

async function loadDirectProductPluginCommands(cwd: string): Promise<ProductCommand[]> {
  const plugins = (await listProductPlugins(cwd)).filter(plugin => plugin.enabled)
  const loaded = await Promise.all(plugins.flatMap(plugin => productPluginCommandRoots(plugin).map(directory => (
    loadProductPluginCommands(directory, plugin.root, plugin.name)
  ))))
  return loaded.flat()
}

/** Load only model-prompt extensions used by the GUI Harness. */
export async function loadProductAgentCommands(cwd: string): Promise<ProductCommand[]> {
  initProductBundledSkills()
  const [skills, pluginSkills, pluginCommands] = await Promise.all([
    loadProductSkillCommands(cwd),
    loadProductPluginSkillCommands(cwd),
    loadDirectProductPluginCommands(cwd),
  ])
  return uniqBy([
    ...getProductBundledSkills().filter(command => PRODUCT_HARNESS_SKILL_NAMES.has(command.name)),
    ...skills,
    ...pluginSkills,
    ...pluginCommands,
  ].filter(command => (command.isEnabled?.() ?? true)), 'name')
}

/**
 * Codex receives project skills, commands, MCP and LSP through the Host.
 * Historical Markdown "agents" used a second local model loop and therefore
 * intentionally have no executable surface until they are rebuilt as durable
 * Codex child Runs.
 */
export async function loadProductAgentExtensionTools(cwd: string): Promise<ProductTool[]> {
  const plugins = (await listProductPlugins(cwd)).filter(plugin => plugin.enabled)
  const lsp = plugins.flatMap(plugin => productPluginLspServers(plugin).map(server => createProductPluginLspTool(server)))
  return uniqBy(lsp, 'name')
}
