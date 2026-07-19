import { parseAgentCommandArgs } from '../../commands/agent.js'
import { parseSlashCommand } from '../../utils/slashCommandParsing.js'
import {
  listProductTaskAgentRuntimeNames,
  listProductTaskSkillNames,
} from './taskCommandDiscovery.js'

/**
 * Product task pages accept task intent, not the Coding Agent's management
 * console. This policy deliberately permits only the small command subset a
 * product task can explain without exposing runtime configuration or command
 * catalogs.
 */

const BLOCKED_PRODUCT_COMMAND_NAMES = new Set([
  'config',
  'settings',
  'setting',
  'permission',
  'permissions',
  'model',
  'models',
  'provider',
  'providers',
  'mcp',
  'plugin',
  'plugins',
  'doctor',
  'bug',
  'bughunter',
  'status',
  'cost',
  'context',
  'ctx',
  'ctx_viz',
  'usage',
  'login',
  'logout',
  'auth',
  'hooks',
  'memory',
  'session',
  'sessions',
  'resume',
  'rewind',
  'branch',
  'worktree',
  'tasks',
  'task',
  'agents',
])

export type ProductTaskCommandPolicyDependencies = {
  listSkillNames: (cwd: string) => Promise<readonly string[]>
  listAgentRuntimeNames: (cwd: string) => Promise<readonly string[]>
}

export type ProductTaskCommandPolicyOptions = {
  cwd?: string | null
  dependencies?: ProductTaskCommandPolicyDependencies
}

export type ProductTaskCommandResolution =
  | { allowed: true; content: string }
  | { allowed: false }

export type ProductTaskCommandCandidate =
  | { kind: 'plain_text' }
  | { kind: 'local_command' }
  | { kind: 'agent'; runtimeName: string | null }
  | { kind: 'skill'; skillName: string | null }
  | { kind: 'rejected' }

const defaultDependencies: ProductTaskCommandPolicyDependencies = {
  async listSkillNames(cwd) {
    return listProductTaskSkillNames(cwd)
  },

  async listAgentRuntimeNames(cwd) {
    return listProductTaskAgentRuntimeNames(cwd)
  },
}

function parseExplicitSkillInvocation(
  value: string,
): { skillName: string; args: string } | null {
  const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(value.trim())
  const skillName = match?.[1]?.trim()
  if (!skillName) return null
  return {
    skillName,
    args: match?.[2]?.trim() ?? '',
  }
}

/**
 * Classify the product-visible form without performing discovery or I/O. The
 * caller can use this pure result in tests and then decide whether a known
 * Skill or Agent is available in the task's own workspace.
 */
export function classifyProductTaskCommand(content: string): ProductTaskCommandCandidate {
  const trimmed = content.trim()
  if (!trimmed) return { kind: 'rejected' }

  const command = parseSlashCommand(trimmed)
  if (!command) {
    return trimmed.startsWith('/')
      ? { kind: 'rejected' }
      : { kind: 'plain_text' }
  }

  if (command.isMcp) return { kind: 'rejected' }

  const commandName = command.commandName.trim()
  const reservedCommandName = commandName.toLowerCase()
  if (!commandName || BLOCKED_PRODUCT_COMMAND_NAMES.has(reservedCommandName)) {
    return { kind: 'rejected' }
  }

  if (reservedCommandName === 'goal') return { kind: 'local_command' }
  if (reservedCommandName === 'clear') {
    return command.args.trim()
      ? { kind: 'rejected' }
      : { kind: 'local_command' }
  }

  if (reservedCommandName === 'agent') {
    return {
      kind: 'agent',
      runtimeName: parseAgentCommandArgs(command.args)?.agentType ?? null,
    }
  }

  if (reservedCommandName === 'skill') {
    return {
      kind: 'skill',
      skillName: parseExplicitSkillInvocation(command.args)?.skillName ?? null,
    }
  }

  // User-invocable Skills use their name directly (`/weekly-review`).
  // Unknown slash commands are treated as untrusted Skill candidates and are
  // rejected unless discovery confirms the exact name below.
  return { kind: 'skill', skillName: commandName }
}

function includesKnownName(names: readonly string[], requestedName: string): boolean {
  return names.some((name) => name.trim() === requestedName)
}

function normalizedProductTaskCommandContent(
  content: string,
  candidate: ProductTaskCommandCandidate,
): string {
  const trimmed = content.trim()
  if (candidate.kind === 'plain_text') return trimmed

  const command = parseSlashCommand(trimmed)
  if (!command) return trimmed

  const normalizedName = command.commandName.trim().toLowerCase()
  const args = command.args.trim()
  if (normalizedName === 'skill') {
    const invocation = parseExplicitSkillInvocation(command.args)
    if (!invocation) return trimmed
    return invocation.args
      ? `/${invocation.skillName} ${invocation.args}`
      : `/${invocation.skillName}`
  }

  if (normalizedName === 'goal' || normalizedName === 'clear' || normalizedName === 'agent') {
    return args ? `/${normalizedName} ${args}` : `/${normalizedName}`
  }

  return trimmed
}

/**
 * Resolve a product command to the exact Core text that can execute it. The
 * only product shorthand is `/skill <known-skill> [args]`, which becomes the
 * native `/<known-skill> [args]` form after discovery succeeds.
 */
export async function resolveProductTaskText(
  content: string,
  options: ProductTaskCommandPolicyOptions = {},
): Promise<ProductTaskCommandResolution> {
  const candidate = classifyProductTaskCommand(content)
  if (candidate.kind === 'plain_text' || candidate.kind === 'local_command') {
    return { allowed: true, content: normalizedProductTaskCommandContent(content, candidate) }
  }
  if (candidate.kind === 'rejected') return { allowed: false }

  const cwd = options.cwd?.trim()
  if (!cwd) return { allowed: false }

  const dependencies = options.dependencies ?? defaultDependencies
  try {
    if (candidate.kind === 'agent') {
      const allowed = candidate.runtimeName !== null && includesKnownName(
        await dependencies.listAgentRuntimeNames(cwd),
        candidate.runtimeName,
      )
      return allowed
        ? { allowed: true, content: normalizedProductTaskCommandContent(content, candidate) }
        : { allowed: false }
    }

    const allowed = candidate.skillName !== null && includesKnownName(
      await dependencies.listSkillNames(cwd),
      candidate.skillName,
    )
    return allowed
      ? { allowed: true, content: normalizedProductTaskCommandContent(content, candidate) }
      : { allowed: false }
  } catch {
    // Discovery touches local Skill/plugin/Agent configuration. A failure is
    // indistinguishable to a product user from an unavailable command.
    return { allowed: false }
  }
}

/**
 * Boolean convenience for callers that only need an allow/deny decision.
 * The product websocket uses resolveProductTaskText so a validated Skill
 * shorthand is forwarded as a real native Core command.
 */
export async function allowsProductTaskText(
  content: string,
  options: ProductTaskCommandPolicyOptions = {},
): Promise<boolean> {
  return (await resolveProductTaskText(content, options)).allowed
}
