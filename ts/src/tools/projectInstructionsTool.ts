import type { Tool, ToolContext } from './Tool'
import {
  loadProjectInstructionsForTargets,
  loadWorkspaceProjectInstructions,
  projectInstructionScopeKey,
  xmlAttr,
} from '../harness/projectInstructions'

const MAX_TARGETS = 20

interface ProjectInstructionsInput {
  path?: string
  paths?: string[]
  include_workspace_root?: boolean
}

export const projectInstructionsTool: Tool<ProjectInstructionsInput> = {
  name: 'list_project_instructions',
  description:
    'List applicable AGENTS.md/CLAUDE.md project instructions for target paths before editing or creating files. Input: { path? , paths?, include_workspace_root? }. Defaults to directory-level instructions; set include_workspace_root:true to include root rules too.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'One target file path to inspect. The file may be new/not yet created.' },
      paths: { type: 'array', items: { type: 'string' }, description: `Several target file paths to inspect; only the first ${MAX_TARGETS} are used.` },
      include_workspace_root: { type: 'boolean', description: 'Include root-level AGENTS.md/CLAUDE.md in addition to nearer directory instructions.' },
    },
  },
  isReadOnly: true,
  async execute(input, ctx) {
    const requested = requestedPaths(input)
    if (requested.length === 0) {
      return await loadWorkspaceProjectInstructions(ctx.workspace) ?? '<project_instructions status="empty" scope="workspace" />'
    }

    const targets = requested.slice(0, MAX_TARGETS).map(path => ({
      absPath: ctx.workspace.resolve(path, 'create'),
      label: path,
    }))
    const omitted = requested.length - targets.length
    const instructions = await loadProjectInstructionsForTargets(ctx.workspace, targets, {
      includeWorkspaceRoot: input?.include_workspace_root === true,
      targetLabel: targets.map(target => target.label).join(', '),
    })
    if (instructions) {
      for (const target of targets) markProjectInstructionsSeen(ctx, target.absPath)
      return omitted > 0
        ? `${instructions}\n\n<project_instructions_omitted count="${omitted}" />`
        : instructions
    }
    return `<project_instructions status="empty" targets="${xmlAttr(targets.map(target => target.label).join(','))}"${omitted > 0 ? ` omitted="${omitted}"` : ''} />`
  },
}

function requestedPaths(input: ProjectInstructionsInput | undefined): string[] {
  const out: string[] = []
  if (typeof input?.path === 'string' && input.path.trim()) out.push(input.path.trim())
  for (const path of input?.paths ?? []) {
    if (typeof path === 'string' && path.trim()) out.push(path.trim())
  }
  return [...new Set(out)]
}

function markProjectInstructionsSeen(ctx: ToolContext, abs: string): void {
  const scope = projectInstructionScopeKey(ctx.workspace, abs)
  if (!scope) return
  ctx.projectInstructionScopes ??= new Set()
  ctx.projectInstructionScopes.add(scope)
}
