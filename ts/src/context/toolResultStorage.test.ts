import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { textBlock, toolResultBlock, toolUseBlock, type Message } from '../types/message'
import {
  createContentReplacementState,
  enforceToolResultBudget,
  maybeStoreToolResult,
  reconstructContentReplacementState,
} from './toolResultStorage'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tool-result-storage-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('maybeStoreToolResult', () => {
  test('空工具结果会补完成标记,避免模型在空 tool_result 尾部停住', async () => {
    const empty = await maybeStoreToolResult('run_command', 'empty-1', '   \n\t', {
      dir: root,
      thresholdChars: 1,
    })

    expect(empty).toEqual({ content: '(run_command completed with no output)', stored: false })
    expect(readdirSync(root)).toEqual([])
  })

  test('白名单工具的大结果写入磁盘,回灌头尾预览', async () => {
    const output = `HEAD\n${'x'.repeat(200)}\nTAIL`
    const stored = await maybeStoreToolResult('run_command', 'call-1', output, {
      dir: root,
      thresholdChars: 100,
      previewChars: 40,
    })

    expect(stored.stored).toBe(true)
    expect(stored.content).toContain('<stored_tool_result')
    expect(stored.content).toContain('<preview_head')
    expect(stored.content).toContain('HEAD')
    expect(stored.content).toContain('TAIL')
    expect(stored.content).not.toContain('x'.repeat(120))
    const files = readdirSync(root)
    expect(files.length).toBe(1)
    expect(readFileSync(join(root, files[0]!), 'utf8')).toBe(output)
  })

  test('同一 tool_use_id 的大结果稳定复用同一个落盘文件', async () => {
    const output = `HEAD\n${'x'.repeat(200)}\nTAIL`
    const first = await maybeStoreToolResult('run_command', 'stable-call', output, {
      dir: root,
      thresholdChars: 100,
      previewChars: 40,
    })
    const second = await maybeStoreToolResult('run_command', 'stable-call', output, {
      dir: root,
      thresholdChars: 100,
      previewChars: 40,
    })

    expect(first.stored).toBe(true)
    expect(second.stored).toBe(true)
    expect(first.path).toBe(second.path)
    expect(readdirSync(root)).toEqual(['stable-call-run_command.txt'])
    expect(readFileSync(join(root, 'stable-call-run_command.txt'), 'utf8')).toBe(output)
  })

  test('审阅/回滚类大结果也写入磁盘,避免 diff/patch 撑爆上下文', async () => {
    for (const tool of ['git_status', 'git_history', 'file_history', 'restore_file']) {
      const output = `<${tool}>\nHEAD\n${'x'.repeat(180)}\nTAIL\n</${tool}>`
      const stored = await maybeStoreToolResult(tool, `${tool}-call`, output, {
        dir: root,
        thresholdChars: 100,
        previewChars: 100,
      })

      expect(stored.stored).toBe(true)
      expect(stored.content).toContain(`tool="${tool}"`)
      expect(stored.content).toContain('HEAD')
      expect(stored.content).toContain('TAIL')
    }
    expect(readdirSync(root).length).toBe(4)
  })

  test('MCP 工具/资源/Prompt 大结果写入磁盘,避免外部工具撑爆上下文', async () => {
    for (const tool of ['mcp__docs__search', 'read_mcp_resource', 'read_mcp_prompt', 'list_mcp_resources', 'list_mcp_prompts']) {
      const output = `<mcp_result server="docs" tool="search">\nHEAD\n${'x'.repeat(180)}\nTAIL\n</mcp_result>`
      const stored = await maybeStoreToolResult(tool, `${tool}-call`, output, {
        dir: root,
        thresholdChars: 100,
        previewChars: 100,
      })

      expect(stored.stored).toBe(true)
      expect(stored.content).toContain(`tool="${tool}"`)
      expect(stored.content).toContain('HEAD')
      expect(stored.content).toContain('TAIL')
    }
  })

  test('read_file 这类代码上下文工具不落盘,避免模型为了看源码反复读取', async () => {
    const output = 'source\n'.repeat(200)
    const stored = await maybeStoreToolResult('read_file', 'read-1', output, {
      dir: root,
      thresholdChars: 100,
    })

    expect(stored).toEqual({ content: output, stored: false })
    expect(readdirSync(root)).toEqual([])
  })
})

describe('enforceToolResultBudget', () => {
  const aggregateMessages = (): Message[] => [
    { role: 'user', content: [textBlock('run checks')] },
    {
      role: 'assistant',
      content: [
        toolUseBlock({ id: 'a1', name: 'log_a', input: {} }),
        toolUseBlock({ id: 'b1', name: 'log_b', input: {} }),
      ],
    },
    {
      role: 'user',
      content: [
        toolResultBlock('a1', `A-HEAD\n${'a'.repeat(140)}\nA-TAIL`),
        toolResultBlock('b1', `B-HEAD\n${'b'.repeat(80)}\nB-TAIL`),
      ],
    },
  ]

  test('一条消息里多个中等 tool_result 合计超预算时只替换最大的 fresh 结果', async () => {
    const state = createContentReplacementState()
    const result = await enforceToolResultBudget(aggregateMessages(), state, {
      dir: root,
      budgetChars: 180,
      previewChars: 60,
    })

    expect(result.newlyReplaced.map(record => record.toolUseId)).toEqual(['a1'])
    const toolResults = result.messages.flatMap(message => message.content).filter(block => block.type === 'tool_result')
    const replaced = toolResults.find(block => block.type === 'tool_result' && block.tool_use_id === 'a1')
    const untouched = toolResults.find(block => block.type === 'tool_result' && block.tool_use_id === 'b1')
    expect(replaced && replaced.type === 'tool_result' && replaced.content).toContain('<stored_tool_result')
    expect(untouched && untouched.type === 'tool_result' && untouched.content).toContain('B-HEAD')
    expect(readdirSync(root)).toEqual(['a1-log_a.txt'])
  })

  test('reconstructContentReplacementState 用 sidecar record 字节级重放旧替换', async () => {
    const firstState = createContentReplacementState()
    const first = await enforceToolResultBudget(aggregateMessages(), firstState, {
      dir: root,
      budgetChars: 180,
      previewChars: 60,
    })
    const resumedState = reconstructContentReplacementState(aggregateMessages(), first.newlyReplaced)
    const second = await enforceToolResultBudget(aggregateMessages(), resumedState, {
      dir: root,
      budgetChars: 180,
      previewChars: 60,
    })

    expect(second.newlyReplaced).toEqual([])
    const firstReplacement = first.messages.flatMap(message => message.content)
      .find(block => block.type === 'tool_result' && block.tool_use_id === 'a1')
    const secondReplacement = second.messages.flatMap(message => message.content)
      .find(block => block.type === 'tool_result' && block.tool_use_id === 'a1')
    expect(secondReplacement).toEqual(firstReplacement)
  })
})
