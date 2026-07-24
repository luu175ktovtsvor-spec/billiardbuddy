import type { Command } from '../../commands.js'
import type { Tool } from '../../Tool.js'
import {
  getMcpToolsCommandsAndResources,
} from '../../services/mcp/client.js'
import { getAllMcpConfigs } from '../../services/mcp/config.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
  ServerResource,
} from '../../services/mcp/types.js'
import { runWithCwdOverride } from '../../utils/cwd.js'

export type ProductTaskMcpRuntime = {
  clients: MCPServerConnection[]
  tools: Tool[]
  commands: Command[]
  resources: Record<string, ServerResource[]>
}

export type ProductTaskMcpHost = {
  connect(workDir: string): Promise<ProductTaskMcpRuntime>
}

type ProductTaskMcpHostDependencies = {
  loadConfigs: () => Promise<{ servers: Record<string, ScopedMcpServerConfig> }>
  connect: typeof getMcpToolsCommandsAndResources
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
    loadConfigs: getAllMcpConfigs,
    connect: getMcpToolsCommandsAndResources,
  }) {}

  connect(workDir: string): Promise<ProductTaskMcpRuntime> {
    return runWithCwdOverride(workDir, async () => {
      const { servers } = await this.dependencies.loadConfigs()
      const clients: MCPServerConnection[] = []
      const tools: Tool[] = []
      const commands: Command[] = []
      const resources: Record<string, ServerResource[]> = {}

      await this.dependencies.connect((result) => {
        clients.push(result.client)
        tools.push(...result.tools)
        commands.push(...result.commands)
        if (result.resources) resources[result.client.name] = result.resources
      }, servers)

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
