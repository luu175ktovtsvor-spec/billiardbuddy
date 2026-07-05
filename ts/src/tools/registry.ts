import type { Tool, ToolSpec } from './Tool'

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  constructor(tools: Tool[] = []) {
    for (const t of tools) this.register(t)
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  list(): Tool[] {
    return [...this.tools.values()]
  }

  specs(): ToolSpec[] {
    return this.list().map(t => ({ name: t.name, description: t.description, parameters: t.inputSchema }))
  }
}
