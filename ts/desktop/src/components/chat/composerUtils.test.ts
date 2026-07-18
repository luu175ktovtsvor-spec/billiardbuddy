import { describe, expect, it } from 'vitest'
import {
  appendAgentSlashCommands,
  buildAgentSlashCommands,
  filterSlashCommands,
  findSlashToken,
  getLocalizedFallbackCommands,
  isRetiredSessionInspectorCommandInput,
  insertSlashTrigger,
  mergeSlashCommands,
  replaceSlashCommand,
  resolveSlashCommandRuntimeValue,
  resolveSlashUiAction,
} from './composerUtils'

describe('composerUtils', () => {
  it('finds slash token without trailing space', () => {
    expect(findSlashToken('/rev', 4)).toEqual({ start: 0, filter: 'rev' })
    expect(findSlashToken('hello /rev', 10)).toEqual({ start: 6, filter: 'rev' })
  })

  it('does not treat slash followed by a space as an active token', () => {
    expect(findSlashToken('/ review', 8)).toBeNull()
  })

  it('closes slash completion once /goal arguments start', () => {
    expect(findSlashToken('/goal ', 6)).toBeNull()
    expect(findSlashToken('/goal sta', 9)).toBeNull()
    expect(findSlashToken('/goal build app', 15)).toBeNull()
  })

  it('inserts a slash trigger without appending a trailing space', () => {
    expect(insertSlashTrigger('', 0)).toEqual({ value: '/', cursorPos: 1 })
    expect(insertSlashTrigger('hello', 5)).toEqual({ value: 'hello /', cursorPos: 7 })
  })

  it('replaces the current slash token with a command and one trailing separator', () => {
    expect(replaceSlashCommand('/rev', 4, 'review')).toEqual({
      value: '/review ',
      cursorPos: 8,
    })
  })

  it('merges fallback commands so built-in entries like /clear remain visible', () => {
    expect(
      mergeSlashCommands([
        { name: 'help' },
      ]),
    ).toEqual(
      expect.arrayContaining([
        { name: 'help', description: 'Show available desktop and agent commands' },
        { name: 'clear', description: 'Clear conversation history' },
      ]),
    )
  })

  it('filters retired inspection and recovery commands returned by the runtime', () => {
    const names = mergeSlashCommands([
      { name: 'status' },
      { name: 'cost' },
      { name: 'context' },
      { name: 'doctor' },
      { name: 'help' },
    ]).map((command) => command.name)

    expect(names).not.toContain('status')
    expect(names).not.toContain('cost')
    expect(names).not.toContain('context')
    expect(names).not.toContain('doctor')
    expect(names).toContain('help')
  })

  it('drops descriptions and argument hints supplied by dynamic runtime commands', () => {
    const commands = mergeSlashCommands([
      {
        name: 'team:lark',
        description: 'Private plugin workflow description',
        argumentHint: '<private-argument>',
      },
    ])

    expect(commands).toEqual(expect.arrayContaining([
      { name: 'team:lark', description: '' },
    ]))
    expect(commands.find((command) => command.name === 'team:lark')).not.toHaveProperty('argumentHint')
  })

  it('uses product-owned fallback copy for built-in commands', () => {
    // For commands the desktop owns the copy for (e.g. /clear, /compact, /help),
    // the localized description must win over whatever the CLI broadcasts so the
    // i18n keys actually take effect at runtime.
    expect(
      mergeSlashCommands(
        [{ name: 'clear', description: 'Runtime-private description', argumentHint: '<private>' }],
        [{ name: 'clear', description: 'Localized description' }],
      ),
    ).toEqual(
      expect.arrayContaining([
        { name: 'clear', description: 'Localized description' },
      ]),
    )
  })

  it('does not inherit runtime argument hints for product-owned commands', () => {
    expect(
      mergeSlashCommands([
        {
          name: 'compact',
          description: 'Runtime-private description',
          argumentHint: '<private>',
        },
      ]),
    ).toEqual(
      expect.arrayContaining([
        {
          name: 'compact',
          description: 'Compact conversation context',
        },
      ]),
    )
    expect(mergeSlashCommands([
      { name: 'compact', argumentHint: '<private>' },
    ]).find((command) => command.name === 'compact')).not.toHaveProperty('argumentHint')
  })

  it('keeps /goal as a single command with argument hints instead of pseudo subcommands', () => {
    const commands = filterSlashCommands(mergeSlashCommands([]), 'goal')

    expect(commands.map((command) => command.name)).toEqual(['goal'])
    expect(commands[0]).toMatchObject({
      description: 'Set a completion goal',
      argumentHint: '[<condition> | clear]',
    })
    expect(mergeSlashCommands([]).map((command) => command.name)).not.toContain('goal status')
    expect(mergeSlashCommands([]).map((command) => command.name)).not.toContain('goal --tokens')
  })

  it('builds name-only agent slash entries under the /agent namespace', () => {
    expect(
      buildAgentSlashCommands([
        {
          displayName: 'assistant-1',
          runtimeName: 'debugger',
        },
      ]),
    ).toEqual([
      {
        name: 'agent assistant-1',
        runtimeName: 'agent debugger',
        description: '',
        argumentHint: '<prompt>',
      },
    ])
  })

  it('uses a product display name and restores the runtime id on submit', () => {
    const commands = buildAgentSlashCommands([
      {
        displayName: 'agent-guide',
        runtimeName: 'claude-code-guide',
      },
    ])

    expect(commands).toEqual([
      {
        name: 'agent agent-guide',
        runtimeName: 'agent claude-code-guide',
        description: '',
        argumentHint: '<prompt>',
      },
    ])
    expect(resolveSlashCommandRuntimeValue('/agent agent-guide explain hooks', commands)).toBe(
      '/agent claude-code-guide explain hooks',
    )
  })

  it('keeps two commands selectable when their safe display names collide', () => {
    const commands = buildAgentSlashCommands([
      {
        displayName: 'agent-guide',
        runtimeName: 'claude-code-guide',
      },
      {
        displayName: 'agent-guide',
        runtimeName: 'project-guide',
      },
    ])

    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'agent agent-guide',
        runtimeName: 'agent claude-code-guide',
      }),
      expect.objectContaining({
        name: 'agent agent-guide-assistant',
        runtimeName: 'agent project-guide',
        description: '',
      }),
    ]))
    expect(resolveSlashCommandRuntimeValue('/agent agent-guide explain hooks', commands)).toBe(
      '/agent claude-code-guide explain hooks',
    )
    expect(resolveSlashCommandRuntimeValue('/agent agent-guide-assistant explain this project', commands)).toBe(
      '/agent project-guide explain this project',
    )
  })

  it('does not render raw Agent runtime names or implementation metadata', () => {
    const commands = buildAgentSlashCommands([
      {
        displayName: 'assistant-1',
        runtimeName: 'claude-domain-expert',
      },
    ])
    const [command] = commands

    expect(command).toMatchObject({
      name: 'agent assistant-1',
      runtimeName: 'agent claude-domain-expert',
      description: '',
    })
    expect(command!.name).not.toContain('claude-domain-expert')
    expect(command!.description).not.toContain('projectSettings')
  })

  it('appends agent entries after normal slash commands without replacing them', () => {
    const base = mergeSlashCommands([{ name: 'agent' }])
    const withAgents = appendAgentSlashCommands(base, [
      { name: 'agent debugger', description: 'Debug failures', argumentHint: '<prompt>' },
    ])

    expect(withAgents.map((command) => command.name).slice(0, 2)).toEqual(['agent', 'mcp'])
    expect(withAgents.map((command) => command.name)).toContain('agent debugger')
  })

  it('does not replace /goal arguments as slash command fragments', () => {
    expect(replaceSlashCommand('/goal sta', 9, 'goal status')).toBeNull()
  })

  it('finds dynamic runtime commands by their command names', () => {
    expect(
      filterSlashCommands([
        { name: 'lark-calendar', description: '' },
        { name: 'agent-team-orchestrator', description: '' },
        { name: 'superpowers:brainstorming', description: '' },
        { name: 'superpowers:systematic-debugging', description: '' },
      ], 'su').map((command) => command.name),
    ).toEqual([
      'superpowers:brainstorming',
      'superpowers:systematic-debugging',
    ])
  })

  it('keeps the core memory command separate from retired Settings and recovery aliases', () => {
    expect(resolveSlashUiAction('plugins')).toEqual({ type: 'settings', tab: 'plugins' })
    expect(resolveSlashUiAction('memory')).toBeNull()
    expect(resolveSlashUiAction('doctor')).toBeNull()
    expect(resolveSlashUiAction('config')).toEqual({ type: 'settings', tab: 'general' })
    expect(resolveSlashUiAction('settings')).toEqual({ type: 'settings', tab: 'general' })
    expect(mergeSlashCommands([]).map((command) => command.name)).toContain('plugin')
    expect(mergeSlashCommands([])).toContainEqual({ name: 'memory', description: 'Manage task memory' })
    expect(mergeSlashCommands([]).map((command) => command.name)).toContain('config')
    expect(mergeSlashCommands([]).map((command) => command.name)).not.toContain('doctor')
    expect(mergeSlashCommands([]).map((command) => command.name)).not.toContain('plugins')
    expect(mergeSlashCommands([]).map((command) => command.name)).not.toContain('settings')
  })

  it('does not route retired session inspection commands to desktop panels', () => {
    expect(resolveSlashUiAction('cost')).toBeNull()
    expect(resolveSlashUiAction('context')).toBeNull()
    expect(resolveSlashUiAction('status')).toBeNull()
  })

  it('recognizes retired inspection commands by their first slash token', () => {
    expect(isRetiredSessionInspectorCommandInput('/status')).toBe(true)
    expect(isRetiredSessionInspectorCommandInput('/status anything')).toBe(true)
    expect(isRetiredSessionInspectorCommandInput('/cost last turn')).toBe(true)
    expect(isRetiredSessionInspectorCommandInput('/context\nnow')).toBe(true)
    expect(isRetiredSessionInspectorCommandInput('/status-report')).toBe(false)
  })

  it('routes retired login and model commands to the product-managed notice', () => {
    expect(resolveSlashUiAction('model')).toEqual({ type: 'product-managed' })
    expect(resolveSlashUiAction('login')).toEqual({ type: 'product-managed' })
    expect(resolveSlashUiAction('logout')).toEqual({ type: 'product-managed' })
  })

  it('does not advertise unavailable feedback or internal instruction filenames', () => {
    const commands = mergeSlashCommands([])

    expect(commands.map((command) => command.name)).not.toContain('bug')
    expect(commands.find((command) => command.name === 'init')?.description).toBe(
      'Initialize project instructions',
    )
  })

  it('falls back to the static English description when a translation key is missing', () => {
    // Simulate an i18n t() function that returns the raw key for missing entries
    // (this is what the real translate() does via zh[key] ?? en[key] ?? key).
    const mockT = (key: string) => key

    const commands = getLocalizedFallbackCommands(mockT)
    const clearCmd = commands.find((c) => c.name === 'clear')
    expect(clearCmd?.description).toBe('Clear conversation history')
    expect(clearCmd?.description).not.toBe('slashCmd.clear.description')

    // Verify every command renders a human-readable description, never a raw key
    for (const cmd of commands) {
      expect(cmd.description).not.toMatch(/^slashCmd\./)
    }
  })

  it('uses the localized description when the translation key resolves to a real string', () => {
    const mockT = (key: string) => {
      const map: Record<string, string> = {
        'slashCmd.clear.description': '清空会话历史',
      }
      return map[key] ?? key
    }

    const commands = getLocalizedFallbackCommands(mockT)
    const clearCmd = commands.find((c) => c.name === 'clear')
    expect(clearCmd?.description).toBe('清空会话历史')

    // A command without a translated key should still fall back to English
    const mcpCmd = commands.find((c) => c.name === 'mcp')
    expect(mcpCmd?.description).toBe('Open available MCP tools for the current chat context')
    expect(mcpCmd?.description).not.toBe('slashCmd.mcp.description')
  })
})
