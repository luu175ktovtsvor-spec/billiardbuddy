import { z } from 'zod/v4'
import { buildProductTool, type ProductCommand, type ProductToolDef } from './productTool.js'

const inputSchema = z.strictObject({
  skill: z.string().min(1).max(200).describe('Skill name from the current Turn extension snapshot'),
  args: z.string().max(20_000).optional().describe('Optional arguments for the Skill'),
})

function textFromBlocks(blocks: Awaited<ReturnType<ProductCommand['getPromptForCommand']>>): string {
  return blocks.map(block => block.type === 'text' ? block.text : '[non-text Skill content omitted]').join('\n')
}

export function createProductSkillTool(commands: readonly ProductCommand[]) {
  const available = commands.filter(command => command.type === 'prompt' && !command.disableModelInvocation)
  const names = available.map(command => command.name)
  return buildProductTool({
  name: 'Skill',
  maxResultSizeChars: 100_000,
  inputSchema,
  inputJSONSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      skill: { type: 'string', enum: names, description: 'Skill name from the current Turn extension snapshot' },
      args: { type: 'string', maxLength: 20_000, description: 'Optional arguments for the Skill' },
    },
    required: ['skill'],
  },
  async description() {
    const catalog = available.map(command => `- ${command.name}: ${command.description}`).join('\n')
    return `Load one Skill from the extensions frozen for this Turn.${catalog ? `\n\nAvailable Skills:\n${catalog}` : ''}`.slice(0, 24_000)
  },
  async prompt() { return 'Load a Skill only when its instructions are relevant. A Skill provides instructions; it does not prove that work succeeded.' },
  isReadOnly() { return true },
  isConcurrencySafe() { return true },
  userFacingName() { return 'Skill' },
  toAutoClassifierInput(input) { return input.skill },
  async validateInput({ skill }, context) {
    const command = context.options.commands.find(candidate => candidate.name === skill
      || candidate.userFacingName?.() === skill
      || candidate.aliases?.includes(skill))
    return command?.type === 'prompt' && !command.disableModelInvocation
      ? { result: true }
      : { result: false, message: 'Skill is not available in this Turn', errorCode: 1 }
  },
  async call({ skill, args }, context) {
    const command = context.options.commands.find(candidate => candidate.name === skill
      || candidate.userFacingName?.() === skill
      || candidate.aliases?.includes(skill))
    if (command?.type !== 'prompt' || command.disableModelInvocation) throw new Error('SKILL_UNAVAILABLE')
    return { data: textFromBlocks(await command.getPromptForCommand(args ?? '', context)) }
  },
  mapToolResultToToolResultBlockParam(result, toolUseID) {
    return { type: 'tool_result', tool_use_id: toolUseID, content: result }
  },
  renderToolUseMessage() { return null },
  renderToolUseProgressMessage() { return null },
  renderToolUseQueuedMessage() { return null },
  renderToolUseRejectedMessage() { return null },
  renderToolResultMessage() { return null },
  renderToolUseErrorMessage() { return null },
  } satisfies ProductToolDef<typeof inputSchema, string>)
}

export const ProductSkillTool = createProductSkillTool([])
