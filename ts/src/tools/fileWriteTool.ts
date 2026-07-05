import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Tool } from './Tool'

export const fileWriteTool: Tool<{ path: string; content: string }> = {
  name: 'write_file',
  description:
    'Create or overwrite a UTF-8 text file inside the workspace (an existing file is backed up first). Input: { path, content }.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  isReadOnly: false,
  async execute(input, ctx) {
    if (!input || typeof input.path !== 'string' || typeof input.content !== 'string') {
      throw new Error('write_file 需要 string 参数 path 和 content')
    }
    const abs = ctx.workspace.resolve(input.path, 'write')
    await ctx.workspace.backup(abs) // 红线:改文件前自动备份
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, input.content, 'utf8')
    return `已写入 ${input.path}（${input.content.length} 字符）`
  },
}
