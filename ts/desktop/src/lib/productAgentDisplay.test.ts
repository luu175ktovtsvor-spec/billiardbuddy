import { describe, expect, it } from 'vitest'
import { getProductAgentDescription, getProductAgentType } from './productAgentDisplay'

describe('product Agent metadata', () => {
  it('removes provider branding from built-in metadata without changing runtime ids', () => {
    const agent = {
      agentType: 'claude-code-guide',
      description: 'Use Claude Code, the Claude Agent SDK, and the Anthropic API.',
      source: 'built-in',
    }

    expect(getProductAgentType(agent)).toBe('agent-guide')
    expect(getProductAgentDescription(agent, 'missing')).toBe(
      'Answers questions about the Agent workbench, CLI, hooks, skills, MCP services, settings, and supported model APIs.',
    )
  })

  it('productizes other built-in descriptions', () => {
    expect(getProductAgentDescription({
      agentType: 'statusline-setup',
      description: "Configure Claude Code and Claude's status line.",
      source: 'built-in',
    }, 'missing')).toBe("Configure BilliardBuddy and the Agent's status line.")
  })

  it('preserves project and user Agent metadata verbatim', () => {
    const custom = {
      agentType: 'claude-domain-expert',
      description: 'Research Claude APIs for this project.',
      source: 'projectSettings',
    }

    expect(getProductAgentType(custom)).toBe(custom.agentType)
    expect(getProductAgentDescription(custom, 'missing')).toBe(custom.description)
  })
})
