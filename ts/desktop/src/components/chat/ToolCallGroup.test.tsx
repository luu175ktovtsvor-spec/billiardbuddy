import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ToolCallGroup } from './ToolCallGroup'
import { useSettingsStore } from '../../stores/settingsStore'
import type { UIMessage } from '../../types/chat'

type ToolResult = Extract<UIMessage, { type: 'tool_result' }>

describe('ToolCallGroup memory activity', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState({ locale: 'zh' })
  })

  it.each(['Write', 'Edit', 'MultiEdit'] as const)(
    'does not present a pending memory %s as saved',
    (toolName) => {
      const privatePath = `/Users/test/.claude/projects/example/memory/${toolName}.md`

      render(
        <ToolCallGroup
          toolCalls={[{
            id: `pending-memory-${toolName}`,
            type: 'tool_use',
            toolName,
            toolUseId: `pending-memory-${toolName}`,
            input: { file_path: privatePath, content: 'private task memory' },
            timestamp: 1,
            isPending: true,
          }]}
          resultMap={new Map()}
          childToolCallsByParent={new Map()}
          agentTaskNotifications={{}}
          isStreaming
        />,
      )

      expect(screen.getByText('Updating 1 memory item(s)')).toBeTruthy()
      expect(screen.queryByText('Saved 1 memory item(s)')).toBeNull()
      expect(document.body.textContent).not.toContain(privatePath)
    },
  )

  it.each(['Write', 'Edit', 'MultiEdit'] as const)(
    'does not present a failed memory %s as saved',
    (toolName) => {
      const toolUseId = `failed-memory-${toolName}`
      const privatePath = `/Users/test/.claude/projects/example/memory/${toolName}.md`
      const resultMap = new Map<string, ToolResult>([[toolUseId, {
        id: `result-${toolUseId}`,
        type: 'tool_result',
        toolUseId,
        content: 'permission denied',
        isError: true,
        timestamp: 2,
      }]])

      render(
        <ToolCallGroup
          toolCalls={[{
            id: toolUseId,
            type: 'tool_use',
            toolName,
            toolUseId,
            input: { file_path: privatePath, content: 'private task memory' },
            timestamp: 1,
          }]}
          resultMap={resultMap}
          childToolCallsByParent={new Map()}
          agentTaskNotifications={{}}
        />,
      )

      expect(screen.getByText('Could not update 1 memory item(s)')).toBeTruthy()
      expect(screen.queryByText(/Saved .*memory item/)).toBeNull()
      expect(document.body.textContent).not.toContain(privatePath)
    },
  )

  it('does not fold a failed write into a mixed save summary', () => {
    const privatePath = '/Users/test/.claude/projects/example/memory/private.md'
    const resultMap = new Map<string, ToolResult>([
      ['saved-memory', {
        id: 'saved-memory-result',
        type: 'tool_result',
        toolUseId: 'saved-memory',
        content: 'ok',
        isError: false,
        timestamp: 2,
      }],
      ['failed-memory', {
        id: 'failed-memory-result',
        type: 'tool_result',
        toolUseId: 'failed-memory',
        content: 'permission denied',
        isError: true,
        timestamp: 3,
      }],
    ])

    render(
      <ToolCallGroup
        toolCalls={[
          {
            id: 'saved-memory',
            type: 'tool_use',
            toolName: 'Write',
            toolUseId: 'saved-memory',
            input: { file_path: `${privatePath}/saved.md`, content: 'private task memory' },
            timestamp: 1,
          },
          {
            id: 'failed-memory',
            type: 'tool_use',
            toolName: 'Edit',
            toolUseId: 'failed-memory',
            input: { file_path: `${privatePath}/failed.md`, old_string: 'old', new_string: 'new' },
            timestamp: 2,
          },
        ]}
        resultMap={resultMap}
        childToolCallsByParent={new Map()}
        agentTaskNotifications={{}}
      />,
    )

    expect(screen.getByText('Could not update 1 memory item(s)')).toBeTruthy()
    expect(screen.queryByText(/Saved .*memory item/)).toBeNull()
    expect(document.body.textContent).not.toContain(privatePath)
  })
})
