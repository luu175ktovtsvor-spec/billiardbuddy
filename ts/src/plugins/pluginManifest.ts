import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface PluginManifest {
  name: string
  version: string
  description?: string
  skills?: string
  agents?: string
  hooks?: string
  mcp?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function normalizePluginManifest(value: unknown): PluginManifest | null {
  if (!isRecord(value)) return null
  const name = asString(value.name)
  if (!name) return null
  return {
    name,
    version: asString(value.version) ?? '0.0.0',
    description: asString(value.description),
    skills: asString(value.skills) ?? 'skills',
    agents: asString(value.agents) ?? 'agents',
    hooks: asString(value.hooks) ?? 'hooks.json',
    mcp: asString(value.mcp) ?? '.mcp.json',
  }
}

export async function loadPluginManifest(pluginDir: string): Promise<PluginManifest | null> {
  try {
    const raw = await readFile(join(pluginDir, 'plugin.json'), 'utf8')
    return normalizePluginManifest(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

export function filterEnabledPlugins<T extends { manifest: PluginManifest }>(
  plugins: T[],
  enabledNames: readonly string[] | undefined,
): T[] {
  if (!enabledNames) return plugins
  const enabled = new Set(enabledNames)
  return plugins.filter(plugin => enabled.has(plugin.manifest.name))
}
