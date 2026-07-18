type AgentDisplayMetadata = {
  agentType: string
  description?: string
  source: string
}

const PRODUCT_GUIDE_DESCRIPTION =
  'Answers questions about the Agent workbench, CLI, hooks, skills, MCP services, settings, and supported model APIs.'

function productizeBuiltInText(value: string): string {
  return value
    .replace(/Claude Agent SDK/g, 'Agent SDK')
    .replace(/Claude API/g, 'model API')
    .replace(/Anthropic API/g, 'model API')
    .replace(/Claude Code/g, 'BilliardBuddy')
    .replace(/Claude\.ai/g, 'the hosted service')
    .replace(/\bClaude\b/g, 'the Agent')
}

export function getProductAgentType(agent: AgentDisplayMetadata): string {
  if (agent.source === 'built-in' && agent.agentType === 'claude-code-guide') {
    return 'agent-guide'
  }
  return agent.agentType
}

export function getProductAgentDescription(
  agent: AgentDisplayMetadata,
  fallback: string,
): string {
  if (!agent.description) return fallback
  if (agent.source !== 'built-in') return agent.description
  if (agent.agentType === 'claude-code-guide') return PRODUCT_GUIDE_DESCRIPTION
  return productizeBuiltInText(agent.description)
}
