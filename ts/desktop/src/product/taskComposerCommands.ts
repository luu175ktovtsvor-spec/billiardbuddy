export type TaskComposerCommand = {
  name: string
  runtimeName?: string
  description: string
  argumentHint?: string
}

export type TaskComposerAgent = {
  displayName: string
  runtimeName: string
}

export function buildTaskComposerAgentCommands(
  agents: ReadonlyArray<TaskComposerAgent>,
): TaskComposerCommand[] {
  const seenRuntimeNames = new Set<string>()
  const displayNames = new Set<string>()
  const commands: TaskComposerCommand[] = []

  for (const agent of agents) {
    const runtimeAgentType = agent.runtimeName.trim()
    const preferredDisplayAgentType = agent.displayName.trim()
    if (!runtimeAgentType || !preferredDisplayAgentType || seenRuntimeNames.has(runtimeAgentType)) continue
    seenRuntimeNames.add(runtimeAgentType)

    const displayAgentType = reserveDisplayName(preferredDisplayAgentType, displayNames)
    displayNames.add(displayAgentType)
    const name = `agent ${displayAgentType}`
    const runtimeName = `agent ${runtimeAgentType}`

    commands.push({
      name,
      ...(runtimeName !== name ? { runtimeName } : {}),
      description: '',
      argumentHint: '<prompt>',
    })
  }

  return commands
}

function reserveDisplayName(preferred: string, reserved: Set<string>): string {
  if (!reserved.has(preferred)) return preferred

  const base = `${preferred}-assistant`
  let candidate = base
  let suffix = 2
  while (reserved.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

export function resolveTaskComposerRuntimeCommand(
  value: string,
  commands: ReadonlyArray<TaskComposerCommand>,
): string {
  for (const command of commands) {
    if (!command.runtimeName || command.runtimeName === command.name) continue
    const displayPrefix = `/${command.name}`
    if (value !== displayPrefix && !value.startsWith(`${displayPrefix} `)) continue
    return `/${command.runtimeName}${value.slice(displayPrefix.length)}`
  }
  return value
}
