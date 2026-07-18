import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { skillsApi } from '../api/skills'
import { mcpApi } from '../api/mcp'
import { useUIStore } from '../stores/uiStore'

vi.mock('../api/skills', () => ({
  skillsApi: {
    list: vi.fn(async () => ({ skills: [] })),
  },
}))

vi.mock('../api/mcp', () => ({
  mcpApi: {
    list: vi.fn(async () => ({ servers: [] })),
    status: vi.fn(async (name: string) => ({
      server: {
        name,
        scope: 'user',
        transport: 'http',
        enabled: true,
        status: 'connected',
        statusLabel: 'Connected',
        configLocation: 'User',
        summary: 'https://mcp.example.com/mcp',
        canEdit: true,
        canRemove: true,
        canReconnect: true,
        canToggle: true,
        config: { type: 'http', url: 'https://mcp.example.com/mcp', headers: {} },
      },
    })),
  },
}))

import { ActiveSession } from '../pages/ActiveSession'
import { ScheduledTasks } from '../pages/ScheduledTasks'

import { UserMessage } from '../components/chat/UserMessage'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { useTabStore } from '../stores/tabStore'

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
})

afterEach(async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  cleanup()
})

function resetPageStores() {
  cleanup()
  useTabStore.setState({ tabs: [], activeTabId: null })
  useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
  useChatStore.setState({ sessions: {} })
}

/**
 * Core rendering tests: content-only pages must render without crashing
 * and contain key structural elements from the prototype.
 */
describe('Content-only pages render without errors', () => {
  it('ActiveSession renders with chat components', () => {
    const SESSION_ID = 'test-active-session'
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          streamingResponseChars: 0,
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })
    const { container } = render(<ActiveSession />)
    // With empty messages, the hero is shown
    expect(container.innerHTML).toContain('New session')
    // ChatInput has a textarea
    const textarea = container.querySelector('textarea')
    expect(textarea).toBeInTheDocument()
    expect(textarea).toHaveAttribute('placeholder', 'Ask anything...')
    expect(textarea).toHaveAttribute('rows', '1')
    expect(container.innerHTML).not.toContain('Preview')
    // Cleanup
    resetPageStores()
  })

  it('ActiveSession keeps the compact composer once messages exist', () => {
    const SESSION_ID = 'test-active-session-with-messages'
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [{
            id: 'msg-1',
            type: 'user_text',
            content: 'hello',
            timestamp: Date.now(),
          }],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          streamingResponseChars: 0,
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 1,
        projectPath: '',
        workDir: null,
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })

    render(<ActiveSession />)

    const textarea = screen.getByRole('textbox')
    expect(textarea).toHaveAttribute('placeholder', 'What would you like to do next?')
    expect(textarea).toHaveAttribute('rows', '1')

    resetPageStores()
  })

  it('ActiveSession shows a single primary action button while a turn is active', () => {
    useTabStore.setState({ activeTabId: 'active-tab', tabs: [{ sessionId: 'active-tab', title: 'Test', type: 'session' as const, status: 'idle' }] })
    useChatStore.setState({
      sessions: {
        'active-tab': {
          messages: [],
          chatState: 'thinking',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          streamingResponseChars: 0,
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })
    render(<ActiveSession />)

    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^run$/i })).not.toBeInTheDocument()
    resetPageStores()
  })

  it('ActiveSession opens a local /mcp panel and clicking an item routes to settings', async () => {
    const SESSION_ID = 'mcp-panel-session'
    const sendMessage = vi.fn()
    vi.mocked(mcpApi.list).mockResolvedValueOnce({
      servers: [
        {
          name: 'deepwiki',
          scope: 'user',
          transport: 'http',
          enabled: true,
          status: 'connected',
          statusLabel: 'Connected',
          configLocation: '/tmp/config',
          summary: 'https://mcp.deepwiki.com/mcp',
          canEdit: true,
          canRemove: true,
          canReconnect: true,
          canToggle: true,
          config: { type: 'http', url: 'https://mcp.deepwiki.com/mcp', headers: {} },
        },
      ],
    })
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          streamingResponseChars: 0,
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
      sendMessage,
    })

    render(<ActiveSession />)

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/mcp', selectionStart: 4 } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(await screen.findByText('Available MCP tools')).toBeInTheDocument()
    fireEvent.click(screen.getByText('deepwiki'))
    expect(useTabStore.getState().activeTabId).toBe('__settings__')
    expect(useUIStore.getState().pendingSettingsTab).toBe('mcp')

    resetPageStores()
  })

  it('ActiveSession opens a local /skills panel from the fallback slash commands', async () => {
    const SESSION_ID = 'skills-panel-session'
    const sendMessage = vi.fn()
    vi.mocked(skillsApi.list).mockResolvedValueOnce({
      skills: [
        {
          name: 'lark-mail',
          description: 'Draft, send, and search emails',
          source: 'user',
          userInvocable: true,
          contentLength: 120,
          hasDirectory: true,
        },
      ],
    })
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          streamingResponseChars: 0,
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
      sendMessage,
    })

    render(<ActiveSession />)

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/skills', selectionStart: 7 } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(await screen.findByText('Available skills')).toBeInTheDocument()
    expect(screen.getByText('/lark-mail')).toBeInTheDocument()

    resetPageStores()
  })

  it('ActiveSession routes /plugin to Settings > Plugins instead of sending a chat message', () => {
    const SESSION_ID = 'plugin-panel-session'
    const sendMessage = vi.fn()
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          streamingResponseChars: 0,
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
      sendMessage,
    })

    render(<ActiveSession />)

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/plugin', selectionStart: 7 } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(useTabStore.getState().activeTabId).toBe('__settings__')
    expect(useUIStore.getState().pendingSettingsTab).toBe('plugins')

    resetPageStores()
  })

  it('ActiveSession keeps runtime inspection commands out of the local help panel', () => {
    const SESSION_ID = 'help-panel-session'
    const sendMessage = vi.fn()
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          streamingResponseChars: 0,
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [
            { name: 'cost', description: 'Show token usage and costs' },
            ...Array.from({ length: 14 }, (_, index) => ({
              name: `extra-${index + 1}`,
              description: `Extra command ${index + 1}`,
            })),
          ],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
      sendMessage,
    })

    render(<ActiveSession />)

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/help', selectionStart: 5 } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(screen.getByText('Slash commands')).toBeInTheDocument()
    expect(screen.getByText('/clear')).toBeInTheDocument()
    expect(screen.queryByText('/cost')).not.toBeInTheDocument()
    expect(screen.getByText(/more commands available\. Type \/ to search the full command list\./)).toBeInTheDocument()

    resetPageStores()
  })

  it('ScheduledTasks renders (store-connected)', async () => {
    const { container } = render(<ScheduledTasks />)
    await screen.findByText('Scheduled tasks')
    expect(container.innerHTML).toContain('Scheduled tasks')
  })

})

describe('Chat attachments', () => {
  it('UserMessage opens image gallery when an attachment is clicked', () => {
    render(
      <UserMessage
        content=""
        attachments={[
          {
            type: 'image',
            name: 'diagram.png',
            data: 'data:image/png;base64,abc123',
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('diagram.png')).toBeInTheDocument()
  })
})
