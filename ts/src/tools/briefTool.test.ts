import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { briefCompatTool, sendUserMessageTool } from './briefTool'
import type { ToolContext } from './Tool'

function fixture(): { root: string; ctx: ToolContext } {
  const root = mkdtempSync(join(tmpdir(), 'brief-tool-'))
  return { root, ctx: { workspace: new Workspace(root) } }
}

test('SendUserMessage delivers markdown message with resolved attachments', async () => {
  const { root, ctx } = fixture()
  try {
    mkdirSync(join(root, 'out'), { recursive: true })
    writeFileSync(join(root, 'out', 'report.md'), '# Report\n')
    writeFileSync(join(root, 'out', 'shot.png'), 'not really png')

    const output = await sendUserMessageTool.execute({
      message: '**Done**: see attached report.',
      status: 'normal',
      attachments: ['out/report.md', 'out/shot.png'],
    }, ctx)

    expect(output).toContain('<user_message_delivered status="normal"')
    expect(output).toContain('attachments="2"')
    expect(output).toContain('<message>\n**Done**: see attached report.\n</message>')
    expect(output).toContain(`path="${join(root, 'out', 'report.md')}" size="9" is_image="false"`)
    expect(output).toContain(`path="${join(root, 'out', 'shot.png')}" size="14" is_image="true"`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Brief legacy alias uses the same SendUserMessage protocol', async () => {
  const { root, ctx } = fixture()
  try {
    const output = await briefCompatTool.execute({
      message: 'Background job finished.',
      status: 'proactive',
    }, ctx)

    expect(output).toContain('<user_message_delivered status="proactive"')
    expect(output).toContain('Background job finished.')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SendUserMessage rejects missing status and unsafe attachment paths', async () => {
  const { root, ctx } = fixture()
  try {
    await expect(sendUserMessageTool.execute({
      message: 'missing status',
    }, ctx)).rejects.toThrow('status must be "normal" or "proactive"')

    await expect(sendUserMessageTool.execute({
      message: 'see secret',
      status: 'normal',
      attachments: ['../secret.txt'],
    }, ctx)).rejects.toThrow('越界')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
