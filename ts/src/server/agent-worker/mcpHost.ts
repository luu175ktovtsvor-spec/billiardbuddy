import { runWithCwdOverride } from '../../utils/cwd.js'
import { getChromeSessionBridge } from '../services/chromeSessionBridge.js'
import { connectProductMcpServer, type ProductMcpConnection, type ProductMcpConnectionResult, type ProductMcpResource } from './productMcpClient.js'
import { loadProductMcpConfigs, type ScopedProductMcpServerConfig } from './productMcpConfig.js'
import { listProductPlugins, productPluginMcpServers } from '../services/productPluginRegistry.js'
import { createProductRecruitingBrowserTool } from './productRecruitingBrowserTool.js'
import type { ProductCommand, ProductTool } from './productTool.js'

export type ProductTaskMcpRuntime = {
  clients: ProductMcpConnection[]
  tools: ProductTool[]
  commands: ProductCommand[]
  resources: Record<string, ProductMcpResource[]>
}

export type ProductTaskMcpHost = {
  connect(workDir: string, context?: { taskId?: string; networkScope?: 'denied' | 'approved' | 'unrestricted' }): Promise<ProductTaskMcpRuntime>
}

type ProductTaskMcpHostDependencies = {
  loadConfigs: (workDir: string) => Promise<{ servers: Record<string, ScopedProductMcpServerConfig>; disabled?: Set<string> }>
  connect: (name: string, config: ScopedProductMcpServerConfig) => Promise<ProductMcpConnectionResult>
  loadPluginConfigs?: (workDir: string) => Promise<Record<string, ScopedProductMcpServerConfig>>
}

function uniqueByName<T extends { name: string }>(values: T[]): T[] {
  return [...new Map(values.map(value => [value.name, value])).values()]
}

/**
 * Server-private MCP Host for ProductTask Core runs.
 *
 * It reuses the generic MCP configuration, policy and transport layer inside
 * the task workspace. Configs and credentials remain in the Product Server;
 * only the resulting Core runtime objects are attached to the native Core.
 */
export class StandardProductTaskMcpHost implements ProductTaskMcpHost {
  constructor(private readonly dependencies: ProductTaskMcpHostDependencies = {
    loadConfigs: loadProductMcpConfigs,
    connect: connectProductMcpServer,
    loadPluginConfigs: async workDir => Object.assign({}, ...(await listProductPlugins(workDir)).map(productPluginMcpServers)),
  }) {}

  connect(workDir: string, context?: { taskId?: string; networkScope?: 'denied' | 'approved' | 'unrestricted' }): Promise<ProductTaskMcpRuntime> {
    return runWithCwdOverride(workDir, async () => {
      const { servers: configuredServers, disabled = new Set<string>() } = await this.dependencies.loadConfigs(workDir)
      const pluginServers = await this.dependencies.loadPluginConfigs?.(workDir) ?? {}
      const servers = { ...configuredServers, ...pluginServers }
      const clients: ProductMcpConnection[] = []
      const tools: ProductTool[] = []
      const commands: ProductCommand[] = []
      const resources: Record<string, ProductMcpResource[]> = {}

      const results = await Promise.all(Object.entries(servers).map(async ([name, config]) => (
        disabled.has(name)
          ? { client: { name, type: 'disabled' as const, config }, tools: [], commands: [], resources: [] }
          : (config.type === 'http' || config.type === 'sse') && context?.networkScope === 'denied'
            ? { client: { name, type: 'failed' as const, config }, tools: [], commands: [], resources: [] }
          : this.dependencies.connect(name, config)
      )))
      for (const result of results) {
        clients.push(result.client)
        tools.push(...result.tools)
        commands.push(...result.commands)
        if (result.resources?.length) resources[result.client.name] = result.resources
      }

      if (context?.taskId) {
        tools.push(createProductRecruitingBrowserTool(context.taskId, getChromeSessionBridge()))
      }

      return {
        clients: uniqueByName(clients),
        tools: uniqueByName(tools),
        commands: uniqueByName(commands),
        resources,
      }
    })
  }
}

export const productTaskMcpHost = new StandardProductTaskMcpHost()
