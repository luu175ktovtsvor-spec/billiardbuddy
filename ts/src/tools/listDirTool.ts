import { readdir } from 'node:fs/promises'
import type { Tool } from './Tool'

export const listDirTool: Tool<{ path?: string }> = {
  name: 'list_dir',
  description: 'List entries of a directory inside the workspace. Input: { path? } (default = workspace root).',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  isReadOnly: true,
  async execute(input, ctx) {
    const abs = ctx.workspace.resolve(input?.path ?? '.')
    const entries = await readdir(abs, { withFileTypes: true })
    return entries
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join('\n')
  },
}
