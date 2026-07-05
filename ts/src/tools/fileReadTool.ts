import { readFile } from 'node:fs/promises'
import type { Tool } from './Tool'

export const fileReadTool: Tool<{ path: string }> = {
  name: 'read_file',
  description: 'Read a UTF-8 text file inside the workspace. Input: { path }.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  isReadOnly: true,
  async execute(input, ctx) {
    if (!input || typeof input.path !== 'string') throw new Error('read_file 需要 string 参数 path')
    return await readFile(ctx.workspace.resolve(input.path, 'read'), 'utf8')
  },
}
