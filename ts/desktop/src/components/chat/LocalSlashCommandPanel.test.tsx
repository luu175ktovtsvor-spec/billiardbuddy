import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

const { sessionsApiMock, skillsApiMock } = vi.hoisted(() => ({
  sessionsApiMock: {
    getInspection: vi.fn(),
  },
  skillsApiMock: {
    list: vi.fn(),
  },
}))

vi.mock('../../api/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/sessions')>()
  return {
    ...actual,
    sessionsApi: {
      getInspection: sessionsApiMock.getInspection,
    },
  }
})

vi.mock('../../api/skills', () => ({
  skillsApi: skillsApiMock,
}))

import { LocalSlashCommandPanel } from './LocalSlashCommandPanel'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore, SETTINGS_TAB_ID } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import { useSkillStore } from '../../stores/skillStore'
import type { SessionContextSnapshot, SessionInspectionResponse } from '../../api/sessions'

const baseContext: SessionContextSnapshot = {
  categories: [
    {
      name: 'memory',
      tokens: 120,
      color: '#14b8a6',
    },
  ],
  totalTokens: 120,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 0.06,
  gridRows: [],
  model: 'Claude Test',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  messageBreakdown: {
    toolCallTokens: 0,
    toolResultTokens: 0,
    attachmentTokens: 0,
    assistantMessageTokens: 0,
    userMessageTokens: 0,
    toolCallsByType: [],
    attachmentsByType: [],
  },
}

function inspectionWithContext(context: SessionContextSnapshot): SessionInspectionResponse {
  return {
    active: true,
    status: {
      sessionId: 'session-1',
      workDir: '/workspace/demo',
      permissionMode: 'default',
      model: 'Claude Test',
      tools: [],
      mcpServers: [],
    },
    context,
  }
}

describe('LocalSlashCommandPanel memory context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState(useTabStore.getInitialState(), true)
    useUIStore.setState({
      pendingMemoryPath: null,
      pendingSettingsTab: null,
    })
    useSkillStore.setState(useSkillStore.getInitialState(), true)
  })

  it('shows loaded memory files and opens the selected project memory in settings', async () => {
    sessionsApiMock.getInspection.mockResolvedValue(inspectionWithContext({
      ...baseContext,
      memoryFiles: [
        {
          path: '/Users/test/.claude/projects/demo/memory/MEMORY.md',
          type: 'project',
          tokens: 4321,
        },
        {
          path: '/Users/test/.claude/projects/demo/memory/feedback/reuse.md',
          type: 'feedback',
          tokens: 98,
        },
      ],
    }))

    render(
      <LocalSlashCommandPanel
        command="context"
        sessionId="session-1"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText('Memory files')).toBeInTheDocument()
    expect(screen.getByText('MEMORY.md')).toBeInTheDocument()
    expect(screen.getByText('/Users/test/.claude/projects/demo/memory/MEMORY.md')).toBeInTheDocument()
    expect(screen.getByText('feedback')).toBeInTheDocument()
    expect(screen.getByText('4,321 tokens')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open Memory' }))

    await waitFor(() => {
      expect(useUIStore.getState().pendingSettingsTab).toBe('memory')
      expect(useUIStore.getState().pendingMemoryPath).toBe('/Users/test/.claude/projects/demo/memory/MEMORY.md')
      expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    })
  })

  it('keeps the memory settings entry available when no memory files are loaded', async () => {
    sessionsApiMock.getInspection.mockResolvedValue(inspectionWithContext({
      ...baseContext,
      memoryFiles: [],
    }))

    render(
      <LocalSlashCommandPanel
        command="context"
        sessionId="session-1"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText('No memory files are loaded in this session.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open Memory' }))

    await waitFor(() => {
      expect(useUIStore.getState().pendingSettingsTab).toBe('memory')
      expect(useUIStore.getState().pendingMemoryPath).toBeNull()
      expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    })
  })

  it('opens read-only detail for a bundled skill without surfacing an API error', async () => {
    skillsApiMock.list.mockResolvedValue({
      skills: [{
        name: 'image-workbench',
        displayName: '生成图片',
        description: '准备可复核的图片草稿',
        source: 'bundled',
        userInvocable: true,
        contentLength: 120,
        hasDirectory: true,
      }],
    })
    const fetchSkillDetail = vi.fn(async () => {
      useSkillStore.setState({ error: null })
    })
    useSkillStore.setState({ fetchSkillDetail, error: null })
    const onClose = vi.fn()

    render(
      <LocalSlashCommandPanel
        command="skills"
        cwd="/workspace/demo"
        onClose={onClose}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /image-workbench/i }))

    await waitFor(() => {
      expect(fetchSkillDetail).toHaveBeenCalledWith(
        'bundled',
        'image-workbench',
        '/workspace/demo',
        'skills',
      )
      expect(useSkillStore.getState().error).toBeNull()
      expect(useUIStore.getState().pendingSettingsTab).toBe('skills')
      expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
      expect(onClose).toHaveBeenCalled()
    })
  })
})
