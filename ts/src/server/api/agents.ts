/**
 * Product Agent command discovery API.
 *
 * GET /api/agents — list safe aliases for Agent commands available to a task.
 *
 * Agent definitions remain an Agent Core capability. This surface intentionally
 * exposes only the two fields the task composer needs to construct /agent.
 */

import {
  getAgentDefinitionsWithOverrides,
  type AgentDefinition as SharedAgentDefinition,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { getCwd } from '../../utils/cwd.js'

export async function handleAgentsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  if (req.method !== 'GET' || segments[2]) {
    return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  }

  try {
    const cwd = url.searchParams.get('cwd') || getCwd()
    const { activeAgents } = await getAgentDefinitionsWithOverrides(cwd)
    return Response.json({
      agents: serializeAgentCommands(activeAgents),
    })
  } catch {
    return Response.json({ error: 'AGENT_UNAVAILABLE' }, { status: 500 })
  }
}

export type ProductAgentCommand = {
  displayName: string
  runtimeName: string
}

const GUIDE_RUNTIME_NAME = 'claude-code-guide'
const GUIDE_DISPLAY_NAME = 'agent-guide'

/**
 * Keep the desktop's Agent discovery surface limited to the two values needed
 * to insert a working /agent command. Runtime definitions carry prompts,
 * permissions, hooks, MCP references, source precedence, and local paths;
 * none of those belong in an ordinary product-facing response.
 */
function serializeAgentCommands(
  agents: SharedAgentDefinition[],
): ProductAgentCommand[] {
  const runtimeNames = new Set<string>()
  const displayNames = new Set<string>()
  const commands: ProductAgentCommand[] = []
  let nextAssistantNumber = 1

  for (const agent of agents) {
    const runtimeName = agent.agentType.trim()
    if (!runtimeName || runtimeNames.has(runtimeName)) continue
    runtimeNames.add(runtimeName)

    const displayName = agent.source === 'built-in' && runtimeName === GUIDE_RUNTIME_NAME
      ? GUIDE_DISPLAY_NAME
      : nextGenericAssistantName(displayNames, () => nextAssistantNumber++)
    displayNames.add(displayName)

    commands.push({ displayName, runtimeName })
  }

  return commands
}

function nextGenericAssistantName(
  usedNames: ReadonlySet<string>,
  nextNumber: () => number,
): string {
  let candidate = ''
  do {
    candidate = `assistant-${nextNumber()}`
  } while (usedNames.has(candidate))
  return candidate
}
