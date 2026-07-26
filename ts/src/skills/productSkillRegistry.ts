import type { ProductCommand, ProductContentBlock, ProductToolContext } from '../server/agent-worker/productTool.js'

export type ProductBundledSkillDefinition = {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string
  argumentHint?: string
  allowedTools?: string[]
  disableModelInvocation?: boolean
  userInvocable?: boolean
  desktopDiscovery?: { displayName?: string; content?: string }
  files?: Record<string, string>
  getPromptForCommand(args: string, context: ProductToolContext): Promise<ProductContentBlock[]>
}

export type ProductBundledSkillDescriptor = {
  name: string
  displayName?: string
  description: string
  userInvocable: boolean
  argumentHint?: string
  whenToUse?: string
  allowedTools: string[]
  content: string
  enabled: boolean
}

const commands: ProductCommand[] = []
const definitions = new Map<string, ProductBundledSkillDefinition>()

function referenceBlocks(files: Record<string, string>): ProductContentBlock[] {
  return Object.entries(files).sort(([left], [right]) => left.localeCompare(right)).map(([name, content]) => ({
    type: 'text' as const,
    text: `## Bundled reference: ${name}\n\n${content}`,
  }))
}

/** Product-only in-memory registry; no retired runtime cache, settings, or extraction path. */
export function registerProductBundledSkill(definition: ProductBundledSkillDefinition): void {
  if (definitions.has(definition.name)) return
  definitions.set(definition.name, definition)
  const references = definition.files ? referenceBlocks(definition.files) : []
  commands.push({
    type: 'prompt',
    name: definition.name,
    description: definition.description,
    aliases: definition.aliases,
    allowedTools: [...(definition.allowedTools ?? [])],
    argumentHint: definition.argumentHint,
    whenToUse: definition.whenToUse,
    disableModelInvocation: definition.disableModelInvocation ?? false,
    userInvocable: definition.userInvocable ?? true,
    contentLength: definition.desktopDiscovery?.content?.length ?? definition.description.length,
    source: 'bundled',
    loadedFrom: 'bundled',
    isHidden: !(definition.userInvocable ?? true),
    progressMessage: 'running',
    async getPromptForCommand(args, context) {
      return [...await definition.getPromptForCommand(args, context), ...references]
    },
  })
}

export function getProductBundledSkills(): ProductCommand[] {
  return [...commands]
}

export function getProductBundledSkillDescriptors(): ProductBundledSkillDescriptor[] {
  return commands.flatMap(command => {
    const definition = definitions.get(command.name)
    if (!definition?.desktopDiscovery) return []
    return [{
      name: definition.name,
      ...(definition.desktopDiscovery.displayName ? { displayName: definition.desktopDiscovery.displayName } : {}),
      description: definition.description,
      userInvocable: definition.userInvocable ?? true,
      ...(definition.argumentHint ? { argumentHint: definition.argumentHint } : {}),
      ...(definition.whenToUse ? { whenToUse: definition.whenToUse } : {}),
      allowedTools: [...(definition.allowedTools ?? [])],
      content: definition.desktopDiscovery.content ?? definition.description,
      enabled: true,
    }]
  })
}

export function clearProductBundledSkills(): void {
  commands.length = 0
  definitions.clear()
}
