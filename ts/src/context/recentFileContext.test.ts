import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import type { ToolContext } from '../tools/Tool'
import { buildRecentFileContextMessage } from './recentFileContext'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recent-file-context-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function ctxWithReads(reads?: Array<[string, { path: string; mtimeMs: number; size: number }]>): ToolContext {
  return {
    workspace: new Workspace(root),
    fileReads: reads ? new Map(reads) : undefined,
  }
}

function textOf(message: Awaited<ReturnType<typeof buildRecentFileContextMessage>>): string {
  const block = message?.content[0]
  if (!block || block.type !== 'text') throw new Error('expected text block')
  return block.text
}

describe('buildRecentFileContextMessage', () => {
  test('没有读文件记录时返回 null', async () => {
    await expect(buildRecentFileContextMessage(ctxWithReads())).resolves.toBeNull()
  })

  test('恢复最近文件内容并转义 XML 元字符', async () => {
    const abs = join(root, 'src.ts')
    writeFileSync(abs, 'const value = "<tag>&";\n', 'utf8')
    const info = statSync(abs)

    const message = await buildRecentFileContextMessage(ctxWithReads([
      [abs, { path: 'src.ts', mtimeMs: info.mtimeMs, size: info.size }],
    ]))
    const text = textOf(message)

    expect(text).toContain('[压缩后恢复的最近文件上下文]')
    expect(text).toContain('<file path="src.ts"')
    expect(text).toContain('changed_since_read="false"')
    expect(text).toContain('const value = "&lt;tag&gt;&amp;";')
  })

  test('恢复最近文件时带回适用的目录级项目指令', async () => {
    mkdirSync(join(root, 'packages', 'app'), { recursive: true })
    writeFileSync(join(root, 'AGENTS.md'), 'Root instruction')
    writeFileSync(join(root, 'packages', 'AGENTS.md'), 'Package instruction')
    const abs = join(root, 'packages', 'app', 'src.ts')
    writeFileSync(abs, 'export const value = 1\n', 'utf8')
    const info = statSync(abs)

    const message = await buildRecentFileContextMessage(ctxWithReads([
      [abs, { path: 'packages/app/src.ts', mtimeMs: info.mtimeMs, size: info.size }],
    ]))
    const text = textOf(message)

    expect(text).toContain('<project_instruction file="packages/AGENTS.md" truncated="false">')
    expect(text).toContain('Package instruction')
    expect(text).not.toContain('Root instruction')
    expect(text.indexOf('# 项目指令')).toBeLessThan(text.indexOf('<recent_file_context'))
  })

  test('文件和读取快照不一致时标记 changed_since_read', async () => {
    const abs = join(root, 'changed.txt')
    writeFileSync(abs, 'new content', 'utf8')

    const message = await buildRecentFileContextMessage(ctxWithReads([
      [abs, { path: 'changed.txt', mtimeMs: 0, size: 0 }],
    ]))

    expect(textOf(message)).toContain('changed_since_read="true"')
  })

  test('只带回最近的文件并遵守总字节上限', async () => {
    const reads: Array<[string, { path: string; mtimeMs: number; size: number }]> = []
    for (let i = 0; i < 4; i++) {
      const rel = `file-${i}.txt`
      const abs = join(root, rel)
      writeFileSync(abs, `${i}`.repeat(20), 'utf8')
      const info = statSync(abs)
      reads.push([abs, { path: rel, mtimeMs: info.mtimeMs, size: info.size }])
    }

    const message = await buildRecentFileContextMessage(ctxWithReads(reads), {
      maxFiles: 2,
      maxBytesPerFile: 20,
      maxTotalBytes: 25,
    })
    const text = textOf(message)

    expect(text).not.toContain('path="file-0.txt"')
    expect(text).not.toContain('path="file-1.txt"')
    expect(text).toContain('path="file-2.txt"')
    expect(text).toContain('path="file-3.txt"')
    expect(text).toContain('truncated="true"')
  })
})
