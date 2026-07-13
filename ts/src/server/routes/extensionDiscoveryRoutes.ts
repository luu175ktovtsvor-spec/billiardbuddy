// 扩展发现 REST 边界：技能、输出风格、领域包，以及斜杠命令列表和展开。

import { filterBridgeSafeCommands, mergeCommandLibraries, normalizeCommandName, publicCommand } from '../../commands/commandLoader'
import { collectDiscoveryEntries, toPublicCommandEntries } from '../../harness/skillListing'
import { createDomainPackActivationCommandLibrary, listPublicDomainPacks, resolveEnabledPacks } from '../../packs/domainPacks'
import { loadOutputStyles, publicOutputStyle } from '../../outputStyles/outputStyleLoader'
import { Workspace } from '../../workspace/workspace'
import { loadRuntimeExtensionLibraries } from '../extensionRoots'
import { workspaceFromBody } from '../turnInput'
import { extensionCommandsResponseSchema, extensionSkillsResponseSchema } from '../../../shared/contracts/extensions'

type OutputStyleDirs = Parameters<typeof loadOutputStyles>[0]

interface ExtensionDiscoveryRouteDependencies {
  skillsRoot: string
  commandsRoot: string
  defaultWorkspaceRoot: () => string
  env?: Record<string, string | undefined>
  userSkillsRoot?: string | null
  outputStyleDirs?: OutputStyleDirs
  pluginRoots?: string[]
}

function methodNotAllowed(): Response {
  return new Response('Method not allowed', { status: 405 })
}

function enabledPacksFromAgentQuery(url: URL) {
  const values = [
    ...url.searchParams.getAll('enabledPacks'),
    ...url.searchParams.getAll('enabled_packs'),
    ...url.searchParams.getAll('knowledge_packs'),
    ...url.searchParams.getAll('knowledgePacks'),
  ].flatMap(value => value.split(/[,，]/)).map(value => value.trim()).filter(Boolean)
  return resolveEnabledPacks({
    enabled_packs: values.length > 0 ? values : undefined,
    billiards_mode: url.searchParams.get('billiards_mode') === 'true' || url.searchParams.get('billiardsMode') === 'true',
  })
}

export function createExtensionDiscoveryRouteHandler(deps: ExtensionDiscoveryRouteDependencies) {
  const env = deps.env ?? process.env

  return async function handleExtensionDiscoveryRoute(url: URL, req: Request): Promise<Response | null> {
    if (url.pathname === '/api/v1/agent/skills') {
      if (req.method !== 'GET') return methodNotAllowed()
      const skills = (await loadRuntimeExtensionLibraries({
        workspaceRoot: deps.defaultWorkspaceRoot(),
        skillsRoot: deps.skillsRoot,
        commandsRoot: deps.commandsRoot,
        env,
        userSkillsRoot: deps.userSkillsRoot,
        pluginRoots: deps.pluginRoots,
      })).skills
      return Response.json(extensionSkillsResponseSchema.parse({
        skills: skills.skills.map(skill => ({
          name: skill.name,
          description: skill.description,
          source: skill.source,
          argument_hint: skill.whenToUse,
          user_invocable: true,
        })),
      }))
    }

    if (url.pathname === '/api/v1/agent/output-styles') {
      if (req.method !== 'GET') return methodNotAllowed()
      const styles = deps.outputStyleDirs === undefined
        ? await loadOutputStyles()
        : await loadOutputStyles(deps.outputStyleDirs)
      return Response.json({ output_styles: styles.styles.map(publicOutputStyle) })
    }

    if (url.pathname === '/api/v1/agent/packs') {
      if (req.method !== 'GET') return methodNotAllowed()
      return Response.json({ packs: listPublicDomainPacks() })
    }

    if (url.pathname === '/api/v1/agent/commands') {
      if (req.method !== 'GET') return methodNotAllowed()
      const workspaceRoot = url.searchParams.get('working_dir') || url.searchParams.get('workspaceRoot') || deps.defaultWorkspaceRoot()
      const workspace = new Workspace(workspaceRoot)
      const loaded = await loadRuntimeExtensionLibraries({
        workspaceRoot: workspace.root,
        skillsRoot: deps.skillsRoot,
        commandsRoot: deps.commandsRoot,
        packs: enabledPacksFromAgentQuery(url),
        env,
        userSkillsRoot: deps.userSkillsRoot,
        pluginRoots: deps.pluginRoots,
      })
      const commands = mergeCommandLibraries(createDomainPackActivationCommandLibrary(), loaded.commands)
      return Response.json(extensionCommandsResponseSchema.parse({
        commands: toPublicCommandEntries(collectDiscoveryEntries({ commands, skills: loaded.skills })),
      }))
    }

    const commandRoute = url.pathname.match(/^\/(?:api\/)?commands(?:\/(expand))?$/)
    if (!commandRoute) return null

    const queryPacks = [
      ...url.searchParams.getAll('knowledge_packs'),
      ...url.searchParams.getAll('knowledgePacks'),
      ...url.searchParams.getAll('enabled_packs'),
      ...url.searchParams.getAll('enabledPacks'),
    ].filter(Boolean)
    const queryBridgeOrigin = url.searchParams.get('bridge_origin') === 'true'
      || url.searchParams.get('bridgeOrigin') === 'true'
      || url.searchParams.get('remote_control') === 'true'
      || url.searchParams.get('remoteControl') === 'true'
    const body = req.method === 'GET'
      ? {
          working_dir: url.searchParams.get('working_dir') ?? undefined,
          workspaceRoot: url.searchParams.get('workspaceRoot') ?? undefined,
          knowledge_packs: queryPacks.length > 0 ? queryPacks : undefined,
          billiards_mode: url.searchParams.get('billiards_mode') === 'true' || url.searchParams.get('billiardsMode') === 'true',
          bridgeOrigin: queryBridgeOrigin || undefined,
        }
      : await req.clone().json().catch(() => ({})) as Record<string, unknown>
    const workspace = workspaceFromBody(body)
    const loaded = await loadRuntimeExtensionLibraries({
      workspaceRoot: workspace.root,
      skillsRoot: deps.skillsRoot,
      commandsRoot: deps.commandsRoot,
      packs: resolveEnabledPacks(body),
      env,
      userSkillsRoot: deps.userSkillsRoot,
      pluginRoots: deps.pluginRoots,
    })
    const commands = loaded.commands
    const visibleCommands = body.bridgeOrigin === true || body.bridge_origin === true || body.remoteControl === true || body.remote_control === true
      ? filterBridgeSafeCommands(commands.commands)
      : commands.commands

    if (!commandRoute[1] && req.method === 'GET') {
      return Response.json({ commands: visibleCommands.filter(command => command.userInvocable !== false).map(publicCommand) })
    }
    if (commandRoute[1] === 'expand' && req.method === 'POST') {
      if (typeof body.name !== 'string') return Response.json({ ok: false, error: 'name required' }, { status: 400 })
      const command = commands.byName.get(normalizeCommandName(body.name))
      if (!command) return Response.json({ ok: false, error: 'command not found' }, { status: 404 })
      return Response.json({
        command: publicCommand(command),
        prompt: await command.getPrompt(typeof body.args === 'string' ? body.args : '', { workspace }),
      })
    }
    return methodNotAllowed()
  }
}
