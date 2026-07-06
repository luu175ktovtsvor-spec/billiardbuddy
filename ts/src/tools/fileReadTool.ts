import { readFile, stat } from 'node:fs/promises'
import type { Tool } from './Tool'

export const fileReadTool: Tool<{ path: string; pages?: string }> = {
  name: 'read_file',
  description: 'Read a UTF-8 text file inside the workspace. Input: { path }. The optional pages parameter is ignored for non-PDF files.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      pages: { type: 'string', description: 'PDF page range; ignored for non-PDF files in this TS harness stage.' },
    },
    required: ['path'],
  },
  isReadOnly: true,
  async execute(input, ctx) {
    if (!input || typeof input.path !== 'string') throw new Error('read_file 需要 string 参数 path')
    const abs = ctx.workspace.resolve(input.path, 'read')
    const [content, info] = await Promise.all([readFile(abs, 'utf8'), stat(abs)])
    ctx.fileReads ??= new Map()
    ctx.fileReads.set(abs, { path: input.path, mtimeMs: info.mtimeMs, size: info.size })
    return content
  },
}
