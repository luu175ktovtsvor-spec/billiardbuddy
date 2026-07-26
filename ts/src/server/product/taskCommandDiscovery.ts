import { getCwd } from '../../utils/cwd.js'
import { PRODUCT_HARNESS_SKILL_NAMES } from '../../skills/bundled/productHarness.js'
import { loadProductAgentCommands, loadProductAgentExtensionTools } from '../agent-worker/productExtensionLoader.js'

export type ProductTaskAgentCommand = { displayName: string; runtimeName: string }
export type ProductTaskSkillCommand = { runtimeName: string; displayName: string; description: string }

const EXTERNAL_SKILL_DESCRIPTION = '当前环境提供的扩展命令。'

/** List only named Agents that the Product Harness can invoke deterministically. */
export async function listProductTaskAgentCommands(cwd = getCwd()): Promise<ProductTaskAgentCommand[]> {
  return (await loadProductAgentExtensionTools(cwd))
    .filter(tool => tool.name.startsWith('agent__'))
    .map(tool => ({ displayName: tool.userFacingName(), runtimeName: tool.name }))
    .sort((left, right) => left.runtimeName.localeCompare(right.runtimeName))
}

export async function listProductTaskAgentRuntimeNames(cwd: string): Promise<string[]> {
  return (await listProductTaskAgentCommands(cwd)).map(command => command.runtimeName)
}

export async function listProductTaskSkillCommands(cwd = getCwd()): Promise<ProductTaskSkillCommand[]> {
  const commands = await loadProductAgentCommands(cwd)
  return commands
    .filter(command => command.type === 'prompt' && command.userInvocable !== false && !command.isHidden)
    .map(command => ({
      runtimeName: command.name,
      displayName: command.userFacingName?.() || command.name,
      description: PRODUCT_HARNESS_SKILL_NAMES.has(command.name) ? command.description : EXTERNAL_SKILL_DESCRIPTION,
    }))
    .sort((left, right) => left.runtimeName.localeCompare(right.runtimeName))
}

export async function listProductTaskSkillNames(cwd: string): Promise<string[]> {
  return (await listProductTaskSkillCommands(cwd)).map(command => command.runtimeName)
}
