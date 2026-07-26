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

export type TaskComposerSkill = {
  runtimeName: string
  displayName: string
  description: string
}

const BUILTIN_TASK_COMMANDS: readonly TaskComposerCommand[] = [
  { name: 'compact', description: '压缩当前任务上下文，同时保留完整历史。' },
]

/**
 * Keep the bundled Skill runtime name out of the Composer while retaining it
 * for the product-to-Agent boundary immediately before task creation.
 */
export function buildTaskComposerSkillCommands(
  skills: ReadonlyArray<TaskComposerSkill>,
): TaskComposerCommand[] {
  const seenRuntimeNames = new Set<string>()
  const displayNames = new Set<string>()
  const commands: TaskComposerCommand[] = []

  for (const skill of skills) {
    const runtimeName = skill.runtimeName.trim()
    const preferredDisplayName = skill.displayName.trim() || runtimeName
    if (!runtimeName || seenRuntimeNames.has(runtimeName)) continue
    seenRuntimeNames.add(runtimeName)

    const name = reserveSkillDisplayName(preferredDisplayName, displayNames)
    displayNames.add(name)
    commands.push({
      name,
      ...(runtimeName !== name ? { runtimeName } : {}),
      description: skill.description.trim(),
    })
  }

  return commands
}

/**
 * A task can expose bundled Skills and Agents in one slash picker. Reserve
 * their visible names together so the submitted alias always maps back to one
 * exact runtime command.
 */
export function buildTaskComposerCommands(
  skills: ReadonlyArray<TaskComposerSkill>,
  agents: ReadonlyArray<TaskComposerAgent>,
): TaskComposerCommand[] {
  const reservedNames = new Set<string>()
  return [
    ...BUILTIN_TASK_COMMANDS,
    ...buildTaskComposerSkillCommands(skills),
    ...buildTaskComposerAgentCommands(agents),
  ].map((command) => {
    const runtimeName = command.runtimeName ?? command.name
    const name = reserveCommandName(command.name, reservedNames)
    reservedNames.add(name)
    return {
      ...command,
      name,
      ...(runtimeName !== name ? { runtimeName } : {}),
    }
  })
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
    const runtimeName = `agent:${runtimeAgentType}`

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

function reserveSkillDisplayName(preferred: string, reserved: Set<string>): string {
  if (!reserved.has(preferred)) return preferred

  let suffix = 2
  let candidate = `${preferred}-${suffix}`
  while (reserved.has(candidate)) {
    suffix += 1
    candidate = `${preferred}-${suffix}`
  }
  return candidate
}

function reserveCommandName(preferred: string, reserved: Set<string>): string {
  if (!reserved.has(preferred)) return preferred

  let suffix = 2
  let candidate = `${preferred}-${suffix}`
  while (reserved.has(candidate)) {
    suffix += 1
    candidate = `${preferred}-${suffix}`
  }
  return candidate
}

export function resolveTaskComposerRuntimeCommand(
  value: string,
  commands: ReadonlyArray<TaskComposerCommand>,
): string {
  for (const command of [...commands].sort((left, right) => right.name.length - left.name.length)) {
    if (!command.runtimeName || command.runtimeName === command.name) continue
    const displayPrefix = `/${command.name}`
    if (value !== displayPrefix && !value.startsWith(`${displayPrefix} `)) continue
    return `/${command.runtimeName}${value.slice(displayPrefix.length)}`
  }
  return value
}
