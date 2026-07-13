import { executeApproved, handleReject, runAgentLoop } from '../harness/loop'
import { getWorkspaceGitStatus } from '../harness/env'
import { buildSystemPrompt } from '../harness/systemPrompt'
import { summarizeWorkspaceProjectInstructions } from '../harness/projectInstructions'
import { scriptedModel } from '../harness/fakeModel'
import { compactPipeline } from '../context/compaction'
import { getConfiguredOrBuiltInModelContextWindow } from '../model/modelContextWindows'
import { publicProviderSummary, scrubProviderIdentifiers, toPublicProviderView } from '../model/publicModelNames'
import { createChatOutputScrubber } from '../harness/outputScrub'
import { SessionService, TurnRegistry, type SessionEventRecord, type SessionStatus, type SessionStreamEvent } from './services/sessionService'
import { SessionArchiveError, SessionArchiveService } from './services/sessionArchiveService'
import { SessionRewindService } from './services/sessionRewindService'
import { ProviderService, type RuntimeProviderResolution } from './services/providerService'
import { ProviderHealthStore, type ProviderHealthEntry } from './services/providerHealthStore'
import { LegacyAgentStore, type LegacyArtifact } from './services/legacyAgentStore'
import { DesktopDataStore } from './services/desktopDataStore'
import { ScheduledTaskRunner } from './services/scheduledTaskRunner'
import { createTelemetryService } from './services/telemetry'
import { EMBEDDED_FRONTEND } from './embeddedFrontend'
import { UserSettingsStore } from './services/userSettings'
import { StoreDocsService, createStoreDocsTool } from './services/storeDocsService'
import { getLogger } from '../utils/logger'
import { jsonDetailError, jsonError, localCorsPreflight, TurnSetupError, withLocalCors } from './middleware/http'
import { VoiceTranscriptionError, transcribeVoiceFile } from './services/voiceTranscription'
import { buildGeneralRegistry } from '../tools/generalTools'
import { workspaceForActiveWorktree } from '../tools/worktreeTools'
import { activateConditionalSkillsForPaths, allowSkillTools, FILE_TOUCH_TOOL_NAMES, formatUseSkillResult, recordInvokedSkill, registerSkillHooks, toolInputFilePaths, userSkillsRoot } from '../skills/skillLoader'
import { createInvokedSkillsMessage, restoreInvokedSkillsFromMessages } from '../skills/invokedSkills'
import { isBuiltinForkCommand } from '../commands/builtinCommands'
import { allowedToolsForAgent } from '../commands/allowedTools'
import { bridgeUnsafeCommandMessage, isBridgeSafeCommand, normalizeCommandName, parseCommandInvocation } from '../commands/commandLoader'
import type { PromptCommand } from '../commands/types'
import { loadPluginHookRegistry, loadWorkspaceHookRegistry } from '../hooks/hookConfig'
import { applyElicitationHooks, applyElicitationResultHooks, applyUserPromptExpansionHooks, configureHookTrust, type HookRegistry as ElicitationHookRegistry } from '../hooks/hooks'
import { createDomainPackTools, mergeEnabledPacks, mergeHookRegistries, packIdForCommandName, resolveEnabledPacks, suggestedSkillNamesForPacks } from '../packs/domainPacks'
import { createGoalHookRegistry } from '../goals/goalState'
import { loadAgentsDir, type AgentDefinition } from '../agents/agentLoader'
import { createAgentTaskSidechainTools, createAgentTaskTool } from '../agents/agentTool'
import { buildForkRunContext } from '../agents/forkSubagent'
import { closeMcpConnections, defaultElicitationHandler, loadMcpToolsFromFile, loadMcpToolsFromFiles, type McpElicitationHandler, type McpElicitationHandlerInput } from '../mcp/client'
import { loadMcpConfigFile } from '../mcp/config'
import { addMcpServer, defaultWritableMcpConfigPath, MCP_PRESETS, removeMcpServer, setMcpServerDisabled } from '../mcp/configStore'
import { TaskService, type TaskMeta } from '../tasks/taskService'
import { TaskListService } from '../tasks/taskListService'
import { createBackgroundAgentTaskTool, createTaskTools, resumeBackgroundAgentTask, startBackgroundAgentRun, type BackgroundAgentTaskOptions } from '../tasks/taskTools'
import { createStructuredTaskTools } from '../tasks/taskListTools'
import { TeamService } from '../tasks/teamService'
import { createTeamTools } from '../tasks/teamTools'
import { startUdsInbox, type UdsInboxServer } from '../tasks/udsInbox'
import { UdsPeerRegistry, type UdsPeerRecord } from '../tasks/udsPeerRegistry'
import { BridgePeerRegistry } from '../tasks/bridgePeerRegistry'
import { BridgeRemoteState } from '../tasks/bridgeRemoteState'
import { createBridgeRemoteTransport } from '../tasks/bridgeRemoteTransport'
import type { BridgeRemoteWebSocketConstructor } from '../tasks/bridgeRemoteSubscriber'
import { projectBridgeSdkEvent } from '../tasks/bridgeSdkEventProjection'
import type { BridgeResolvedInboundMessage } from '../tasks/bridgeInboundMessages'
import { MediaJobService, resolveMediaBackendUrl } from '../media/mediaJobs'
import { ImageWorkbenchStore } from '../media/imageWorkbenchStore'
import { createImageWorkbenchRouteHandler } from '../media/imageWorkbenchRoutes'
import { saveLocalImageAttachment } from '../media/imageUploadRoutes'
import { AssetManager, ASSET_WS_TOPIC, getActiveAssetManager, setActiveAssetManager } from '../assets/assetManager'
import { createMediaTools } from '../media/mediaTools'
import { VideoEditProjectStore } from '../media/video-edit/legacyTimeline'
import { VideoEditingService } from '../media/video-edit/service'
import { createVideoEditRouteHandler } from '../media/video-edit/routes'
import { loadOutputStyles, resolveOutputStyleConfig } from '../outputStyles/outputStyleLoader'
import { defaultPluginInstallDir, defaultPluginRoots, installPluginFromGithub, listPlugins, setPluginEnabled } from '../plugins/pluginLoader'
import { getDefaultWorkspaceDir } from '../harness/desktopEnvNames'
import { TurnConsumerTracker } from './turnConsumerTracker'
import { Workspace } from '../workspace/workspace'
import { Sandbox } from '../sandbox/sandbox'
import { McpTrustStore, resolveTrustedMcpConfig } from '../mcp/mcpTrust'
import { runMigrations } from '../migrations'
import type { AssistantStep, Model } from '../types/model'
import { textBlock, type ContentBlock, type Message } from '../types/message'
import { voiceTranscriptionResponseSchema } from '../../shared/contracts/voice'
import { imageBrandPackPatchSchema, imageBrandPackSchema } from '../../shared/contracts/image-workbench'
import type { ToolContext } from '../tools/Tool'
import type { PermissionUpdate } from '../permissions/types'
import { applyPermissionUpdates } from '../permissions/permissionUpdate'
import { configurePermissionTrust, loadPermissionRules, permissionUpdatesFromRules, persistPermissionRule } from '../permissions/permissionsSettings'
import type { FetchLike } from '../proxy/ProxyModel'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { getUserConfigHomeDir } from '../harness/memoryNames'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'

import { fallbackEventRecord, legacySseLine, sseLine, wsError, wsSend } from './sse'
import { delay, isRecord, numberFrom, permissionModeFrom, stringArray, stringOr } from './requestParams'
import { isSensitiveFilePath, readTextIfExists, summarizeWorkspaceTree } from './workspaceTree'
import { LEGACY_BYOK_TEXT_PROVIDER_ID, createModelFromRuntimeProviders, providerStatusFor, runtimeProviderKey, runtimeProviderLabel, sanitizeProviderError, validateImageModelPayload } from './providerRuntime'
import { bridgeRemoteConfigFromBody, inboundContentBlocks, inboundContentPreview } from './bridgeParams'
import { defaultAgentsRoot, defaultCommandsRoot, defaultMcpConfigPath, defaultSkillsRoot, loadRuntimeExtensionLibraries } from './extensionRoots'
import { fireSessionEndHooks, handleGoalCommand, messageText, messagingSocketPathFrom, supportContext, workspaceFromBody } from './turnInput'
import { isDeclineAnswer, mcpSchemaFieldLines, mcpSchemaFields, parseMcpFormAnswer, runMcpSampling, waitForInboxAnswer } from './mcpInteraction'
import { createCanvasRouteHandler, escapeXml } from './routes/canvasRoutes'
import { createBridgeSessionRouteController } from './routes/bridgeSessionRoutes'
import { createBridgeWorkerRouteController } from './routes/bridgeWorkerRoutes'
import { createExtensionDiscoveryRouteHandler } from './routes/extensionDiscoveryRoutes'
import { createLegacyVideoEditRouteHandler, createStudioRouteHandler } from './routes/legacyMediaRoutes'
import { createMcpRouteHandler } from './routes/mcpRoutes'
import { createPluginRouteHandler } from './routes/pluginRoutes'
import { createProviderRouteHandler } from './routes/providerRoutes'
import { createScheduledTaskRouteHandler } from './routes/scheduledTaskRoutes'
import { createSessionActivityRouteHandler } from './routes/sessionActivityRoutes'
import { createSessionArchiveRouteHandler } from './routes/sessionArchiveRoutes'
import { createSessionMetadataRouteHandler } from './routes/sessionMetadataRoutes'
import { createSessionRewindRouteHandler } from './routes/sessionRewindRoutes'
import { createStoreDocsRouteHandler } from './routes/storeDocsRoutes'
import { createTaskRouteHandler, resolveTaskEndpointTarget } from './routes/taskRoutes'
import { createWorkspaceFileRouteHandler } from './routes/workspaceFileRoutes'
import { createWorkspaceRouteHandler } from './routes/workspaceRoutes'
import { createAgentWebSocketHandler, type AgentWsData } from './websocketHandler'

export interface StartServerOptions {
  host?: string
  port?: number
  env?: Record<string, string | undefined>
  fetchImpl?: FetchLike
  transcriptRoot?: string
  providerRoot?: string
  /** OS 沙箱(seatbelt/bwrap)写围栏:默认开(owner 2026-07-09),env QF_OS_SANDBOX=0 或此项 false 关。
   * 缺依赖/环境不支持时 Sandbox.wrapCommand 自动优雅降级为明文执行,绝不阻断命令。 */
  sandboxEnabled?: boolean
  /** WS 断连宽限期(ms):最后消费者断连后无人重连则中止运行中回合。默认 5 分钟,QF_TURN_ABANDON_GRACE_MS 可覆盖。 */
  turnAbandonGraceMs?: number
  /** ts-desktop 前端静态资源根目录;设置后 GET 未命中 API 路由时从此服务(Electron/浏览器加载前端)。默认 ts/desktop/renderer。 */
  frontendRoot?: string
  skillsRoot?: string
  commandsRoot?: string
  hooksPath?: string
  agentsRoot?: string
  mcpConfigPath?: string
  mediaBackendUrl?: string
  /** 资产管理器注入(测试用);缺省按 stateRoot/env/fetchImpl 自建。 */
  assetManager?: AssetManager
  /** 是否启动后台资产下载调度。默认:测试环境(NODE_ENV=test)不启,其余启;
   * env QF_ASSETS_AUTOSTART=0 可显式关(开发机不想联网下资产时)。 */
  assetAutoStart?: boolean
  /** 是否启动定时任务调度引擎(到点起真 agent 会话)。默认:测试环境不启,其余启;env QF_SCHEDULER=0 显式关。 */
  scheduledTasksAutoStart?: boolean
  bridgeWebSocketCtor?: BridgeRemoteWebSocketConstructor
  /** 启动即预先受信的工作区根(桌面壳打开已批准的库/工作区时注入,或测试用):等价对每个根调 mcpTrust.trust(root)。
   * 受信后该工作区来源的 local hook(.claude/hooks.json 等)才被信任门放行执行。 */
  trustedWorkspaceRoots?: string[]
}

type TurnStreamInput = Record<string, unknown> & {
  message?: unknown
  userMessage?: unknown
  conversationId?: unknown
  userContent?: ContentBlock[]
  messagePreview?: string
  skipCommandParsing?: boolean
  skipSlashCommands?: boolean
  bridgeOrigin?: boolean
}

function backgroundTaskNotification(task: TaskMeta): Record<string, unknown> | null {
  if (task.kind !== 'background_agent') return null
  const title = task.status === 'completed'
    ? '后台子代理已完成'
    : task.status === 'failed'
      ? '后台子代理失败'
      : task.status === 'cancelled'
        ? '后台子代理已取消'
        : null
  if (!title) return null
  return {
    title,
    body: task.error ? `${task.title}: ${task.error}` : task.title,
    kind: 'background_task',
    meta: {
      taskId: task.id,
      status: task.status,
      title: task.title,
      conversationId: task.conversationId,
      workspaceRoot: task.workspaceRoot,
      agent: typeof task.params?.agent === 'string' ? task.params.agent : undefined,
    },
  }
}

/**
 * 状态/会话根目录锚定(P0 · 打包后会话不丢)。
 * ⚠️ 绝不再默认用 process.cwd():开发时 cwd=项目目录能写,但打包后从 Finder/开始菜单启动 cwd=`/` 或
 * `/Applications`,写不下 → 会话/配置/transcript/tasks 全丢 = 分发即废。故默认锚到稳定的白标用户配置目录
 * `~/.billiardbuddy/state`(与 memoryNames.getUserConfigHomeDir() 对齐,env `BILLIARDBUDDY_CONFIG_DIR` 改配置根)。
 * 覆盖优先级:opts.transcriptRoot(测试/显式注入) > env `BILLIARDBUDDY_STATE_DIR`(白标显式覆盖整个 state 根)
 * > `~/.billiardbuddy/state`(默认,永远可写、与 cwd 无关)。
 */
/** 从会话历史里刨出被文件工具"碰过"的路径(供条件技能激活:碰到命中 paths 的文件才现身)。原语与 loop 侧共用(skillLoader)。 */
export function collectTouchedFilePaths(messages: Message[]): string[] {
  const paths: string[] = []
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type !== 'tool_use' || !FILE_TOUCH_TOOL_NAMES.has(b.name)) continue
      paths.push(...toolInputFilePaths(b.input))
    }
  }
  return [...new Set(paths)]
}

export function resolveStateRoot(
  opts: { transcriptRoot?: string; env?: Record<string, string | undefined> } = {},
): string {
  if (opts.transcriptRoot && opts.transcriptRoot.length > 0) return opts.transcriptRoot
  const stateDirOverride = (opts.env ?? process.env).BILLIARDBUDDY_STATE_DIR
  if (stateDirOverride && stateDirOverride.length > 0) return stateDirOverride
  return join(getUserConfigHomeDir(), 'state')
}

/** W2/W6 后端。/health + /agent/hello(demo) + /agent/run(真实模型 Agent SSE)。 */
export function startServer(opts: StartServerOptions = {}) {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 8850
  // OS 沙箱写围栏默认开(owner 2026-07-09);env QF_OS_SANDBOX=0 或 opts.sandboxEnabled=false 关。
  const sandboxEnabled = opts.sandboxEnabled ?? ((opts.env ?? process.env).QF_OS_SANDBOX !== '0')
  const buildSandbox = (ws: Workspace): Sandbox => new Sandbox({ workspace: ws, enabled: sandboxEnabled })
  const stateRoot = resolveStateRoot({ transcriptRoot: opts.transcriptRoot, env: opts.env })
  const pluginRoots = defaultPluginRoots(opts.env ?? process.env)
  // MCP OAuth 令牌落盘目录(锚 stateRoot,跨会话/重启复用):所有 MCP 加载点共享;
  // 仅主对话(用户在场的 SSE 流)允许 interactive 授权,探测/列表/legacy 执行 interactive:false——
  // 复用已落盘令牌即可,绝不让"点开设置页/查列表"触发浏览器授权弹窗。
  const mcpOAuthDir = join(stateRoot, 'mcp-oauth')
  // 版本化 schema 迁移(#36 地基,对齐 cc main.tsx runMigrations):在任何 store 读 stateRoot 里的
  // settings/数据前,同步、按序、幂等地把待迁移的 schema 变更跑一遍,已应用版本记进 <stateRoot>/migrations.json。
  // 现注册表为空(cc 的具体迁移器都是给它上游模型改名、对我们不适用),故当前是空跑;地基就位,以后加一条即生效。
  // runMigrations 对运行期失败不抛(失败只记录、下次幂等重跑),再包一层 try/catch 兜住极端情况,绝不拖垮启动。
  try {
    runMigrations(stateRoot)
  } catch (err) {
    getLogger('migrations', { logDir: join(stateRoot, 'logs') }).warn(
      '启动迁移异常(不影响服务启动)',
      { error: err instanceof Error ? err.message : String(err) },
    )
  }
  // 工作区级 .mcp.json 信任闸(防恶意仓库 .mcp.json 自动 spawn 任意命令)。
  const mcpTrust = new McpTrustStore(join(stateRoot, 'mcp-trust.json'))
  for (const root of opts.trustedWorkspaceRoots ?? []) mcpTrust.trust(root)
  // SECURITY(P0 · 激活 hooks 信任门):本 server = 交互式桌面产品,默认即"信任必需"。
  // 把 hooks 执行前的信任门接到 McpTrustStore:交互(interactive:true)下、未受信工作区里、工作区来源(local)的
  // command/http/prompt/agent hook 一律不 spawn / 不执行(shouldRunHookRule 的 ②③ 闸);app 内置(managed)hook
  // 不受此门约束——理由见 hooks.ts shouldRunHookRule 注释的"与 cc 有意分叉"说明。受信授予入口:
  // POST /api/v1/agent/mcp/trust 或 startServer opts.trustedWorkspaceRoots。此调用是进程级、覆盖本 server 所有请求。
  configureHookTrust({ interactive: true, isWorkspaceTrusted: root => mcpTrust.isTrusted(root) })
  // 权限 allow 规则同款信任门:未受信工作区的 .billiardbuddy allow 不生效(防恶意仓库绕审批闸),deny/ask 与用户级不受限。同一 McpTrustStore 信任源。
  configurePermissionTrust({ interactive: true, isWorkspaceTrusted: root => mcpTrust.isTrusted(root) })
  /** 解析并过信任闸的 mcpConfigPath。显式(请求或 startServer opts 指定)与 app 库/全局配置放行;
   * 未信任的工作区级 <root>/.mcp.json 拦下不连,返回 warning。 */
  const resolveMcpConfig = (rawBody: Record<string, unknown>, workspaceRoot: string): { path: string | undefined; warning?: string } => {
    const explicit = typeof rawBody.mcpConfigPath === 'string' && rawBody.mcpConfigPath.trim().length > 0
    const configPath = explicit ? String(rawBody.mcpConfigPath).trim() : opts.mcpConfigPath ?? defaultMcpConfigPath(workspaceRoot, opts.env ?? process.env)
    return resolveTrustedMcpConfig({ configPath, workspaceRoot, explicit: explicit || !!opts.mcpConfigPath, store: mcpTrust })
  }
  const sessions = new SessionService(stateRoot)
  const providers = new ProviderService(opts.providerRoot ?? stateRoot)
  const desktopData = new DesktopDataStore(stateRoot)
  const userSettings = new UserSettingsStore(stateRoot)
  const tasks = new TaskService(stateRoot, {
    onSettled: async task => {
      const notification = backgroundTaskNotification(task)
      if (notification) await desktopData.addNotification(notification)
    },
  })
  const taskLists = new TaskListService(join(stateRoot, 'task-lists'))
  const teams = new TeamService(stateRoot)
  const udsPeers = new UdsPeerRegistry(stateRoot)
  const bridgePeers = new BridgePeerRegistry(stateRoot)
  const bridgeRemote = new BridgeRemoteState(stateRoot)
  const imageWorkbench = new ImageWorkbenchStore(stateRoot)
  const media = new MediaJobService({
    tasks,
    stateRoot,
    backendUrl: opts.mediaBackendUrl ?? resolveMediaBackendUrl(opts.env ?? process.env),
    env: opts.env ?? process.env,
    fetchImpl: opts.fetchImpl,
    pollIntervalMs: 100,
    prepareImageBody: (body, mode) => prepareStudioImageBody(body, mode),
    workbenchStore: imageWorkbench,
  })
  const handleImageWorkbenchRoute = createImageWorkbenchRouteHandler(imageWorkbench)
  // 资产管理器(瘦安装包):大块头资产(ffmpeg/转写权重/中文字体)首启后从静态源后台
  // 静默下载;媒体调用点经进程级注册表拿 ready 路径。测试环境默认不启动(不碰网络)。
  const assets = opts.assetManager ?? new AssetManager({
    stateRoot,
    env: opts.env ?? process.env,
    fetchImpl: opts.fetchImpl,
  })
  setActiveAssetManager(assets)
  const assetAutoStart = opts.assetAutoStart ?? (process.env.NODE_ENV !== 'test' && (opts.env ?? process.env).QF_ASSETS_AUTOSTART !== '0')
  if (assetAutoStart) assets.start()
  const videoEdits = new VideoEditProjectStore(stateRoot)
  const videoEditing = new VideoEditingService({ stateRoot, tasks, env: opts.env ?? process.env })
  const handleVideoEditV2Route = createVideoEditRouteHandler(videoEditing, { defaultWorkspaceRoot: getDefaultWorkspaceDir() })
  const legacyStore = new LegacyAgentStore(stateRoot)
  const storeDocs = new StoreDocsService(desktopData, stateRoot)
  // 定时任务调度引擎(触发器)。到点 → 起一个真 agent 会话让模型在 cc 循环里用工具把任务干完(#66 衔接铁律,
  // 不是执行写死的 SOP 脚本)。fireTask 直接调进程内的 createTurnStream(= runAgentLoop),带任务配置的工作目录 +
  // 领域包(billiards_mode);无人值守故走 bypassPermissions(仍不越 forceConfirm/硬拒红线)。产出/状态写回运行历史。
  const scheduledTasks = new ScheduledTaskRunner({
    store: desktopData,
    stateRoot,
    fireTask: async (task, ctx) => {
      const instruction = typeof task.instruction === 'string' ? task.instruction.trim() : ''
      if (!instruction) return { status: 'failed', error: '定时任务没有指令内容,已跳过。' }
      const conversationId = crypto.randomUUID()
      const workingDir = stringOr(task.working_dir, getDefaultWorkspaceDir())
      let finalText = ''
      try {
        const { stream } = await createTurnStream({
          message: instruction,
          conversationId,
          working_dir: workingDir,
          billiards_mode: task.billiards_mode === true,
          permissionMode: 'bypassPermissions',
        })
        for await (const record of stream) {
          if (ctx.signal?.aborted) break
          if (record.event.type === 'final') finalText = record.event.text
        }
        return { status: 'completed', summary: finalText, conversationId }
      } catch (err) {
        return { status: 'failed', error: err instanceof Error ? err.message : String(err), conversationId }
      }
    },
  })
  const turns = new TurnRegistry()
  // rewind/checkpoint 上层服务(对标 cc-haha sessionRewindService,存储走 Transcript.rewindTo 的 append-only 分支模型)。
  const sessionRewind = new SessionRewindService(sessions, turns, stateRoot)
  // WS 断连宽限清理:最后一个消费者断连后,宽限期内无人重连则中止仍在跑的回合(防被遗弃的回合永远跑)。
  const turnGraceEnv = Number((opts.env ?? process.env).QF_TURN_ABANDON_GRACE_MS ?? '')
  const turnAbandonGraceMs = opts.turnAbandonGraceMs ?? (Number.isFinite(turnGraceEnv) && turnGraceEnv > 0 ? turnGraceEnv : 5 * 60 * 1000)
  const turnConsumers = new TurnConsumerTracker({
    graceMs: turnAbandonGraceMs,
    isRunning: id => turns.isRunning(id),
    abort: id => {
      if (turns.interrupt(id)) void sessions.touch(id, { status: 'interrupted' }).catch(() => undefined)
    },
  })
  const frontendRoot = opts.frontendRoot ?? join(import.meta.dir, '../../desktop/renderer')
  const FRONTEND_CT: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
  async function serveFrontendAsset(pathname: string): Promise<Response | null> {
    const rel = pathname === '/' || pathname === '' ? 'index.html' : pathname.replace(/^\/+/, '')
    const resolved = resolve(frontendRoot, rel)
    // 防路径穿越:必须落在 frontendRoot 内(越界仍可走嵌入兜底命中已知文件)
    if (resolved === frontendRoot || resolved.startsWith(frontendRoot + sep)) {
      try {
        const data = await readFile(resolved)
        return new Response(data, { headers: { 'Content-Type': FRONTEND_CT[extname(resolved).toLowerCase()] ?? 'application/octet-stream' } })
      } catch {
        // 文件系统没有:编译态 frontendRoot 是虚拟 bunfs 路径,落到下面嵌入兜底。
      }
    }
    // 嵌入兜底:打包后 sidecar 二进制读不到真实 renderer 目录,从编进二进制的前端文件服务。
    const embedded = EMBEDDED_FRONTEND['/' + rel]
    if (embedded) return new Response(embedded.body, { headers: { 'Content-Type': embedded.contentType } })
    return null
  }
  const steerInboxes = new Map<string, string[]>()
  // 运行中"提交插话"时触发 submit-interrupt(对齐 cc handlePromptSubmit:hasInterruptibleToolInProgress → abort('interrupt'))。
  // 循环内 registerInterrupt 注册进来,自带闸(仅在可中断工具在飞时才真切断);普通工具在飞/无工具时为 no-op = 入队。
  const interruptRequesters = new Map<string, () => void>()
  const sessionSkillHooks = new Map<string, NonNullable<ReturnType<typeof mergeHookRegistries>>>()
  const sessionPermissionUpdates = new Map<string, PermissionUpdate[]>()
  const providerHealth = new ProviderHealthStore(opts.providerRoot ?? stateRoot)

  async function projectBridgeEventToConversation(rawBody: Record<string, unknown>, payload: Record<string, unknown>): Promise<void> {
    const conversationId = stringOr(rawBody.conversationId ?? rawBody.conversation_id, '')
    if (!conversationId || payload.type === 'user') return
    const events = projectBridgeSdkEvent(payload)
    if (events.length === 0) return
    await sessions.touch(conversationId, {
      title: stringOr(rawBody.title, 'Remote Control Session'),
      workspaceRoot: stringOr(rawBody.working_dir ?? rawBody.workspaceRoot, getDefaultWorkspaceDir()),
      status: turns.isRunning(conversationId) ? 'running' : 'idle',
    }).catch(() => undefined)
    for (const event of events) {
      await sessions.appendEvent(conversationId, event).catch(() => undefined)
    }
  }

  function registerProviderFailure(runtime: RuntimeProviderResolution, err: unknown): void {
    const key = runtimeProviderKey(runtime)
    providerHealth.recordFailure(key, runtimeProviderLabel(runtime), sanitizeProviderError(err))
  }

  function registerProviderSuccess(runtime: RuntimeProviderResolution): void {
    providerHealth.recordSuccess(runtimeProviderKey(runtime))
  }

  function orderRuntimeProvidersForAttempt(runtimes: RuntimeProviderResolution[]): { runtimes: RuntimeProviderResolution[]; notices: string[] } {
    const now = Date.now()
    const healthy: RuntimeProviderResolution[] = []
    const cooling: Array<{ runtime: RuntimeProviderResolution; health: ProviderHealthEntry }> = []
    for (const runtime of runtimes) {
      const key = runtimeProviderKey(runtime)
      const health = providerHealth.get(key, now)
      if (health) {
        cooling.push({ runtime, health })
      } else {
        healthy.push(runtime)
      }
    }
    if (healthy.length === 0 || cooling.length === 0) return { runtimes, notices: [] }
    // 白标：只在首选出口进冷却时给一句中性提示，去掉真实模型名（label）与原始报错（lastError）。
    const notices = cooling.some(item => item.runtime === runtimes[0])
      ? ['上个 AI 通道最近失败已进入冷却，本轮已自动优先使用可用通道继续。']
      : []
    return { runtimes: [...healthy, ...cooling.map(item => item.runtime)], notices }
  }

  const providerHealthCallbacks = {
    onFailure: registerProviderFailure,
    onSuccess: registerProviderSuccess,
  }

  function runtimeProviderHealthStatus(runtime: RuntimeProviderResolution, now = Date.now()) {
    const key = runtimeProviderKey(runtime)
    const health = providerHealth.get(key, now)
    if (!health) {
      return {
        source: runtime.source,
        providerId: runtime.providerId,
        providerName: runtime.providerName,
        label: runtimeProviderLabel(runtime),
        // 白标：不外露真实 model（原 runtime.config.model 会泄内置模型名）。
        state: 'ready',
        failureCount: 0,
        cooldownMsRemaining: 0,
      }
    }
    return {
      source: runtime.source,
      providerId: runtime.providerId,
      providerName: runtime.providerName,
      label: health.label,
      // 白标：不外露真实 model。
      state: 'cooling',
      failureCount: health.failureCount,
      cooldownMsRemaining: Math.max(0, health.cooldownUntil - now),
      lastError: health.lastError,
      failureCategory: health.failureCategory,
    }
  }

  async function syncLegacyByokTextProvider(input: Record<string, unknown>, saved: Record<string, unknown>): Promise<void> {
    const existing = await providers.get(LEGACY_BYOK_TEXT_PROVIDER_ID).catch(() => null)
    if (input.enabled !== true) {
      const list = await providers.list()
      if (existing && list.activeId === LEGACY_BYOK_TEXT_PROVIDER_ID) await providers.clearActive()
      return
    }

    const baseUrl = stringOr(saved.base_url, '').trim()
    const model = stringOr(saved.model, '').trim()
    const apiKey = stringOr(input.api_key, '').trim()
    if (!baseUrl || !model) return

    const payload = {
      id: LEGACY_BYOK_TEXT_PROVIDER_ID,
      name: '自带文字模型',
      apiFormat: 'openai_chat',
      baseUrl,
      model,
      ...(apiKey ? { apiKey } : {}),
    }
    if (existing) await providers.update(LEGACY_BYOK_TEXT_PROVIDER_ID, payload)
    else {
      if (!apiKey) return
      await providers.create(payload)
    }
    await providers.activate(LEGACY_BYOK_TEXT_PROVIDER_ID)
  }

  async function currentModelStatus() {
    const [list, runtimes] = await Promise.all([
      providers.list(),
      providers.resolveRuntimeConfigs(opts.env ?? process.env),
    ])
    const ordered = orderRuntimeProvidersForAttempt(runtimes)
    const runtime = ordered.runtimes[0]
    const now = Date.now()
    const health = runtimes.map(item => runtimeProviderHealthStatus(item, now))
    return {
      ok: !!runtime,
      activeId: list.activeId,
      // 白标：providers 列表脱敏——去 baseUrl + 真实 model，只留身份 + 能力档代称。
      providers: list.providers.map(toPublicProviderView),
      fallbackCount: Math.max(0, runtimes.length - 1),
      coolingCount: health.filter(item => item.state === 'cooling').length,
      health,
      healthHistory: providerHealth.listHistory(8),
      runtime: runtime
        ? {
            source: runtime.source,
            providerId: runtime.providerId,
            providerName: runtime.providerName,
            // 白标:出口摘要走 publicProviderSummary(删 baseUrl/model/apiFormat,只给能力档)。
            summary: publicProviderSummary(runtime.config),
          }
        : null,
    }
  }

  async function clearModelHealth(body: Record<string, unknown>) {
    const all = body.all === true
    const providerId = stringOr(body.providerId, '')
    const source = stringOr(body.source, '')

    if (!all && !providerId && !source) {
      throw new Error('providerId/source required')
    }

    const runtimes = await providers.resolveRuntimeConfigs(opts.env ?? process.env)
    const matched = all
      ? runtimes
      : runtimes.filter(runtime => (
          providerId ? runtime.providerId === providerId : runtime.source === source
        ))
    if (!all && matched.length === 0) throw new Error('provider runtime not found')

    const cleared = all
      ? providerHealth.clearAll()
      : providerHealth.clearAll(matched.map(runtimeProviderKey))
    return { ok: true, cleared, status: await currentModelStatus() }
  }

  async function handleMcpElicitation(
    input: McpElicitationHandlerInput,
    elicitOpts: { conversationId: string; taskId?: string; signal?: AbortSignal; hooks?: ElicitationHookRegistry; workspaceRoot?: string },
  ) {
    // Elicitation/ElicitationResult hooks(对齐 cc executeElicitationHooks/executeElicitationResultHooks,
    // utils/hooks.ts:4489-4594):问用户之前给 hook 代答(accept/decline/cancel+content)或阻断的机会;
    // 拿到回答之后再过一遍结果钩(可改写/阻断回给服务器的结果)。无 hooks 时零行为变化。
    type ElicitationOutcome = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }
    const hookCtx = elicitOpts.hooks && elicitOpts.workspaceRoot
      ? { workspace: new Workspace(elicitOpts.workspaceRoot), conversationId: elicitOpts.conversationId, signal: elicitOpts.signal } as Parameters<typeof applyElicitationHooks>[2]
      : null
    // params 是按 mode 判别的联合类型(url 变体才有 url、form 变体才有 requestedSchema),宽松收窄读字段。
    const rawParams = input.params as { message?: unknown; mode?: unknown; url?: unknown; requestedSchema?: unknown }
    const elicitationMode = rawParams.mode === 'url' ? 'url' as const : 'form' as const
    const finishElicitation = async (result: ElicitationOutcome): Promise<ElicitationOutcome> => {
      if (!hookCtx) return result
      const post = await applyElicitationResultHooks(elicitOpts.hooks, {
        serverName: input.serverName,
        action: result.action,
        content: result.content,
        mode: elicitationMode,
      }, hookCtx)
      if (post.response) return post.response
      if (post.deniedMessage) return { action: 'decline' as const }
      return result
    }
    if (hookCtx) {
      const pre = await applyElicitationHooks(elicitOpts.hooks, {
        serverName: input.serverName,
        message: typeof rawParams.message === 'string' ? rawParams.message : '',
        mode: elicitationMode,
        url: typeof rawParams.url === 'string' ? rawParams.url : undefined,
        requestedSchema: rawParams.requestedSchema as Record<string, unknown> | undefined,
      }, hookCtx)
      if (pre.response) return await finishElicitation(pre.response) as Awaited<ReturnType<McpElicitationHandler>>
      if (pre.deniedMessage) return await finishElicitation({ action: 'decline' as const }) as Awaited<ReturnType<McpElicitationHandler>>
    }
    return await finishElicitation(await resolveElicitationViaUi()) as Awaited<ReturnType<McpElicitationHandler>>

    async function resolveElicitationViaUi(): Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }> {
    const fallback = await defaultElicitationHandler(input)
    if (fallback.action === 'accept') return fallback
    if (!elicitOpts.taskId) return fallback

    const task = await tasks.get(elicitOpts.taskId).catch(() => null)
    if (!task) return fallback

    const inbox = steerInboxes.get(elicitOpts.conversationId) ?? []
    steerInboxes.set(elicitOpts.conversationId, inbox)
    const requestId = `mcp_elicit_${crypto.randomUUID()}`
    const question = input.params.mode === 'url'
      ? [
          `MCP「${input.serverName}」需要你打开或确认一个链接。`,
          input.params.message,
          input.params.url,
        ].filter(Boolean).join('\n')
      : [
          `MCP「${input.serverName}」需要补充一组非敏感信息。`,
          input.params.message,
          '请直接在输入框回复 JSON，例如 {"字段":"值"}；只有一个必填字段时也可以直接回复值。',
          ...mcpSchemaFieldLines(input.params),
        ].filter(Boolean).join('\n')
    const options = input.params.mode === 'url'
      ? [
          { label: '允许', description: '允许 MCP 继续这个链接流程。' },
          { label: '取消', description: '拒绝这次 MCP 请求。' },
        ]
      : [{ label: '取消', description: '不向 MCP 提交信息。' }]
    await tasks.appendEvent(elicitOpts.taskId, {
      type: 'ask_question',
      id: requestId,
      question,
      options,
      allowFreeform: input.params.mode !== 'url',
      placeholder: input.params.mode !== 'url' ? '{"字段":"值"}' : undefined,
      fields: mcpSchemaFields(input.params),
      url: input.params.mode === 'url' ? input.params.url : undefined,
    }).catch(() => undefined)

    const answer = await waitForInboxAnswer(inbox, inbox.length, elicitOpts.signal)
    if (!answer) return { action: 'cancel' as const }
    if (isDeclineAnswer(answer)) return { action: 'decline' as const }
    if (input.params.mode === 'url') return { action: 'accept' as const }

    const content = parseMcpFormAnswer(answer, input.params)
    if (!content) {
      await tasks.appendEvent(elicitOpts.taskId, {
        type: 'context_note',
        text: 'MCP 表单回复没有匹配必填字段，已拒绝这次请求。',
      }).catch(() => undefined)
      return { action: 'decline' as const }
    }
    return { action: 'accept' as const, content }
    }
  }

  async function createTurnStream(rawBody: TurnStreamInput): Promise<{ conversationId: string; stream: AsyncGenerator<SessionEventRecord> }> {
    const rawUserMessage = stringOr(rawBody.message ?? rawBody.userMessage, '') || stringOr(rawBody.messagePreview, '')
    if (!rawUserMessage) throw new TurnSetupError('message required', 400)
    const explicitUserContent = rawBody.userContent?.length ? rawBody.userContent : undefined

    const resolvedProviderRuntimes = await providers.resolveRuntimeConfigs(opts.env ?? process.env)
    if (resolvedProviderRuntimes.length === 0) throw new TurnSetupError('model provider not configured', 503)
    const orderedProviderRuntimes = orderRuntimeProvidersForAttempt(resolvedProviderRuntimes)
    const providerRuntimes = orderedProviderRuntimes.runtimes
    const providerRuntime = providerRuntimes[0]!

    const conversationId = stringOr(rawBody.conversationId, crypto.randomUUID())
    const workspace = workspaceForActiveWorktree(workspaceFromBody(rawBody), conversationId)
    const steerInbox = steerInboxes.get(conversationId) ?? []
    steerInboxes.set(conversationId, steerInbox)
    const explicitMessagingSocketPath = messagingSocketPathFrom(rawBody, opts.env ?? process.env)
    const messagingSocketPath = explicitMessagingSocketPath || udsPeers.defaultSocketPath(conversationId)
    let udsInbox: UdsInboxServer | undefined
    let udsPeer: UdsPeerRecord | undefined
    let udsInboxWarning = ''
    if (messagingSocketPath) {
      try {
        udsInbox = await startUdsInbox({ socketPath: messagingSocketPath, inbox: steerInbox })
        udsPeer = await udsPeers.register({
          socketPath: udsInbox.socketPath,
          conversationId,
          workspaceRoot: workspace.root,
          explicit: !!explicitMessagingSocketPath,
        })
      } catch (err) {
        udsInboxWarning = `UDS messaging socket failed to start:${err instanceof Error ? err.message : String(err)}`
      }
    }
    const transcript = sessions.transcript(conversationId, workspace.root)
    const touchedMeta = await sessions.touch(conversationId, {
      title: rawUserMessage.slice(0, 40),
      workspaceRoot: workspace.root,
      status: 'running',
    })
    const model = createModelFromRuntimeProviders(providerRuntimes, opts.fetchImpl, providerHealthCallbacks)

    // /compact 手动压缩(对齐 cc commands/compact,支持 `/compact 自定义摘要指令`):短路本回合——
    // 真跑一次强制压缩(经 recordCompaction 落盘,压缩前历史留在活跃链可回看),回说明事件,不打模型主循环。
    const compactCommand = rawUserMessage.match(/^\/compact(?:\s+([\s\S]+))?$/)
    if (compactCommand) {
      const compactTranscript = sessions.transcript(conversationId, workspace.root)
      const preMessages = await compactTranscript.load()
      restoreInvokedSkillsFromMessages(preMessages, conversationId)
      const invokedSkillsMsg = createInvokedSkillsMessage(conversationId)
      const out = await compactPipeline({
        messages: preMessages,
        model,
        force: true,
        customInstructions: compactCommand[1]?.trim() || undefined,
        transcriptPath: compactTranscript.path,
        postSummaryMessages: invokedSkillsMsg ? [invokedSkillsMsg] : [],
        readOnlyToolNames: new Set(),
      })
      if (out.didCompact) {
        await compactTranscript.recordCompaction(preMessages, out.messages, {
          trigger: 'manual',
          messagesSummarized: preMessages.length - out.messages.length,
        })
      }
      const noteText = out.didCompact
        ? `已手动压缩上下文:${out.note ?? ''}`.trim()
        : '无需压缩:当前对话还没有可压缩的历史。'
      const stream = (async function* (): AsyncGenerator<SessionEventRecord> {
        yield await sessions.appendEvent(conversationId, { type: 'context_note', text: noteText })
          .catch(() => fallbackEventRecord({ type: 'context_note', text: noteText }))
        const finalEvent = { type: 'final' as const, text: noteText }
        yield await sessions.appendEvent(conversationId, finalEvent).catch(() => fallbackEventRecord(finalEvent))
      })()
      return { conversationId, stream }
    }

    const requestedContextWindowTokens = numberFrom(rawBody.contextWindowTokens ?? rawBody.context_window_tokens, 0)
    const contextWindowTokens = requestedContextWindowTokens > 0
      ? requestedContextWindowTokens
      : getConfiguredOrBuiltInModelContextWindow(providerRuntime.config.model, opts.env ?? process.env)
    // 三层落点(白标目录):bundled(app 内置,managed) + user(~/.billiardbuddy/skills) + workspace(.billiardbuddy/skills,local 信任)。
    const skillsRoot = opts.skillsRoot ?? defaultSkillsRoot()
    const createSkillsRoot = userSkillsRoot()
    // 领域包启用来源三合一(owner 设计:斜杠命令 /台球 → 主循环注入 pack → 自动找内容 + 跨回合保持):
    //   ① 请求体 enabled_packs(前端专家选择器);② 本回合斜杠入口命令(/台球、/球房、/billiards…→ packIdForCommandName);
    //   ③ 会话已持久化的 enabledPacks(上一回合敲过入口命令,即便这回合前端没回传也保持在模式里)。
    // 必须在 loadCommandsForWorkspace 之前合并——领域包命令(/台球、/billiards:daily-ops)只在 pack 已启用时才加载;
    // 这样斜杠命令本回合就能被识别为命令(注入 prompt)+ 拿到 pack 的 sessionStartContext 知识 + billiards_ops_checklist 工具。
    const entryCommandForPack = rawBody.skipCommandParsing ? null : parseCommandInvocation(rawUserMessage)
    const slashEnabledPackId = entryCommandForPack ? packIdForCommandName(entryCommandForPack.name) : undefined
    const persistedPackIds = Array.isArray(touchedMeta.enabledPacks) ? touchedMeta.enabledPacks : []
    // 挂件按会话:前端 run 消息**总带** enabled_packs 字段(前端 per-conv 真相源,含空=显式关某窗口的台球)。
    //   · 带字段 → 前端为准(不再反向叠加 persisted),支持"关";本回合斜杠 /台球 仍并进来(双保险)。
    //   · 缺字段(定时/后台等非前端路径)→ 沿用持久化 persisted + 斜杠,不掉包也不误清。
    const requestHasPacksField = rawBody.enabled_packs !== undefined || rawBody.enabledPacks !== undefined ||
      rawBody.knowledge_packs !== undefined || rawBody.knowledgePacks !== undefined
    const slashIds = slashEnabledPackId ? [slashEnabledPackId] : []
    const enabledPacks = requestHasPacksField
      ? mergeEnabledPacks(resolveEnabledPacks(rawBody), slashIds)
      : mergeEnabledPacks(resolveEnabledPacks(rawBody), [...persistedPackIds, ...slashIds])
    // 持久化本会话挂件集合(跨重启前端 adopt 兜底恢复):
    //   · 前端带字段 → 以当前集合为准写回(与 persisted 不同才写,支持"关"=写空);
    //   · 缺字段但斜杠新启用 → 补写(老行为)。缺字段且无斜杠 → 完全不动持久化(防误清)。
    const enabledPackIds = enabledPacks.map(pack => pack.id)
    const samePersisted = enabledPackIds.length === persistedPackIds.length && enabledPackIds.every(id => persistedPackIds.includes(id))
    const shouldPersist = requestHasPacksField
      ? !samePersisted
      : Boolean(slashEnabledPackId) && enabledPackIds.some(id => !persistedPackIds.includes(id))
    if (shouldPersist) {
      await sessions.touch(conversationId, { enabledPacks: enabledPackIds }).catch(() => undefined)
    }
    const runtimeExtensions = await loadRuntimeExtensionLibraries({
      workspaceRoot: workspace.root,
      skillsRoot,
      commandsRoot: opts.commandsRoot ?? defaultCommandsRoot(),
      packs: enabledPacks,
      env: opts.env ?? process.env,
      pluginRoots,
    })
    const { skills, commands } = runtimeExtensions
    // 技能/命令发现清单注入系统提示(对齐 cc SkillTool skill listing):汇总 builtin 命令 + 技能 + 已启用领域包命令,
    // 按约 1% 上下文预算截断,让模型「看清单 → 自动调」,/台球 等斜杠也映射到对应技能/命令。
    const outputStyleLibrary = await loadOutputStyles()
    const outputStyleConfig = resolveOutputStyleConfig(outputStyleLibrary, stringOr(rawBody.output_style ?? rawBody.outputStyle, ''))
    // 会话历史(本回合只 load 一次,给条件技能激活 + 下方 goal hook 共用,避免重复 I/O)。
    const priorMessages = await transcript.load().catch(() => [] as Message[])
    // 条件技能激活(对齐 cc "碰到命中 paths 的文件才现身"):扫会话历史触碰过的文件路径,命中的条件技能并回
    // 本回合发现清单(默认它们被 loadLayeredSkills 排除)。仅当存在条件技能时才算,无则跳过。
    // 回合起点激活:扫历史触碰过的文件,命中的条件技能进本回合发现清单(systemPrompt)。
    // 同轮实时激活由下方 activateConditionalSkillsFn 传进 loop 补上(碰到文件当轮 system-reminder 现身)。
    const hasConditionalSkills = [...skills.byName.values()].some(s => s.paths && s.paths.length > 0)
    let activatedConditionalSkills: PromptCommand[] | undefined
    if (hasConditionalSkills) {
      const touched = collectTouchedFilePaths(priorMessages)
      const activatedNames = activateConditionalSkillsForPaths(skills, workspace.root, touched)
      activatedConditionalSkills = [...activatedNames].map(n => skills.byName.get(n)).filter((s): s is PromptCommand => !!s)
    }
    // 同轮实时激活闭包(对齐 cc 文件工具内联激活):loop 每批工具后拿本批碰到的文件路径调它,命中的条件技能当轮现身。
    // 仅当存在条件技能时提供(否则 undefined,loop 跳过零开销)。
    const activateConditionalSkillsFn = hasConditionalSkills
      ? (paths: string[]): PromptCommand[] => {
          const names = activateConditionalSkillsForPaths(skills, workspace.root, paths)
          return [...names].map(n => skills.byName.get(n)).filter((s): s is PromptCommand => !!s)
        }
      : undefined
    let systemPrompt = await buildSystemPrompt(workspace, { commands, skills, contextWindowTokens, activatedConditionalSkills }, outputStyleConfig)
    // 输出风格已在 buildSystemPrompt 中部注入(对齐 cc systemPromptSection('output_style') + keepCodingInstructions
    // 门控),不再拼到尾部 extraContext。领域包上下文(billiards 等)每回合直接进系统提示——它是"我是谁"的域身份、
    // 每回合都得在,不再骑 SessionStart hook(那会让 SessionStart 每回合重触发,丁审计发现)。
    const domainPackContext = enabledPacks.map(pack => pack.sessionStartContext).filter(Boolean).join('\n\n')
    const extraContext = [
      supportContext(rawBody),
      domainPackContext,
    ].filter(Boolean).join('\n\n')
    if (extraContext) {
      systemPrompt = [systemPrompt, extraContext].filter(Boolean).join('\n\n')
    }
    const bridgeOrigin = rawBody.bridgeOrigin === true || rawBody.bridge_origin === true
    const skipSlashCommands = rawBody.skipSlashCommands === true || rawBody.skip_slash_commands === true
    const parsedCandidate = rawBody.skipCommandParsing ? null : parseCommandInvocation(rawUserMessage)
    const bridgeKnownLocalCommand = bridgeOrigin && parsedCandidate?.name === 'goal'
      ? { type: 'local' as const, name: 'goal' }
      : undefined
    const bridgeMatchedPromptCommand = bridgeOrigin && parsedCandidate && !bridgeKnownLocalCommand ? commands.byName.get(parsedCandidate.name) : undefined
    const bridgeSafeParsedCommand = bridgeOrigin && parsedCandidate
      ? bridgeKnownLocalCommand
          ? isBridgeSafeCommand(bridgeKnownLocalCommand)
          : bridgeMatchedPromptCommand
            ? isBridgeSafeCommand(bridgeMatchedPromptCommand)
            : false
      : false
    const bridgeBlockedCommand = bridgeOrigin && parsedCandidate && (bridgeMatchedPromptCommand || bridgeKnownLocalCommand) && !bridgeSafeParsedCommand
      ? { name: parsedCandidate.name, args: parsedCandidate.args, raw: parsedCandidate.raw }
      : undefined
    const parsedCommand = parsedCandidate && (!skipSlashCommands || bridgeSafeParsedCommand) && !bridgeBlockedCommand
      ? parsedCandidate
      : null
    const goalCommandResult = parsedCommand?.name === 'goal'
      ? await handleGoalCommand(conversationId, parsedCommand.args, transcript)
      : undefined
    const matchedCommand = parsedCommand && !goalCommandResult ? commands.byName.get(parsedCommand.name) : undefined
    const commandInvocation = parsedCommand && matchedCommand
      ? {
          name: matchedCommand.name,
          args: parsedCommand.args,
          raw: parsedCommand.raw,
          source: matchedCommand.source,
          contentLength: matchedCommand.contentLength,
          prompt: await matchedCommand.getPrompt(parsedCommand.args, { workspace }),
        }
      : parsedCommand && goalCommandResult
        ? {
            name: 'goal',
            args: parsedCommand.args,
            raw: parsedCommand.raw,
            source: 'commands' as const,
            contentLength: goalCommandResult.output.length,
            prompt: '',
          }
      : undefined
    // let:UserPromptExpansion hook 的 deny/halt 决策(下方 controller 后派发)可把命令展开体替换成拦截说明,
    // 阻止危险命令原文流入模型(对齐 cc 该事件的拦截语义)。
    let userMessage = goalCommandResult?.shouldQuery
      ? `Continue working until this goal is complete: ${parsedCommand?.args ?? ''}`
      : commandInvocation?.prompt ?? rawUserMessage
    const userContent = commandInvocation || goalCommandResult?.shouldQuery ? undefined : explicitUserContent
    const skillRecommendations = suggestedSkillNamesForPacks(enabledPacks)
    const domainPackTools = createDomainPackTools(enabledPacks)
    // hooks 配置三级加载(user ~/.billiardbuddy/settings.json + 工作区 .billiardbuddy/settings.json +
    // settings.local.json,对齐同仓库 permissions/permissionsSettings.ts 的三级路径;取代已删除的死路径
    // defaultHooksPath()/server/hooks.json)。opts.hooksPath 仍作显式覆盖路径叠加进来(source:'local')。
    const configuredHooks = await loadWorkspaceHookRegistry(workspace.root, opts.hooksPath)
    // 已启用插件贡献的 hooks(对齐 cc loadPluginHooks:标准位置 <plugin>/hooks/hooks.json + manifest.hooks 声明的附加文件),
    // 归一为 source:'plugin' 并入本次会话 hooks(app 级可信、不走工作区信任闸)。坏插件/读失败静默跳过、不拖垮会话。
    const pluginHooks = runtimeExtensions.pluginHookConfigPaths.length > 0
      ? await loadPluginHookRegistry(runtimeExtensions.pluginHookConfigPaths).catch(() => undefined)
      : undefined
    // 领域包上下文已改走 systemPrompt(extraContext)每回合注入,不再进 SessionStart hook 注册表——
    // 否则 SessionStart 每回合重触发(丁审计)。此处 hooks 只含用户配置/插件/目标 hook,SessionStart 由 loop 门控成首回合一次。
    // priorMessages 复用上方那次 load(同回合 transcript 不变),不再重复 I/O。
    const hooks = mergeHookRegistries(configuredHooks, pluginHooks, createGoalHookRegistry(conversationId, priorMessages))
    const initialSessionHooks = sessionSkillHooks.get(conversationId)
    const agents = await loadAgentsDir(opts.agentsRoot ?? defaultAgentsRoot())
    const controller = turns.start(conversationId)
    // UserPromptExpansion(官方事件):用户敲的斜杠命令已展开成 prompt → 派发(matcher=命令名);
    // context 决策注入系统提示。命令解析早于 hooks 构建,故派发放这里(hooks 已就绪),对齐 cc 的展开时机。
    // commandExpansionBlocked 提到外层:inline 路径替换 userMessage、fork 路径(下方调度)据它短路,两条路径都拦截。
    let commandExpansionBlocked: string | undefined
    if (commandInvocation && commandInvocation.name !== 'goal') {
      const expansion = await applyUserPromptExpansionHooks(hooks, commandInvocation.name, commandInvocation.prompt, {
        workspace, conversationId, signal: controller.signal,
      })
      if (expansion.additionalContext.length > 0) {
        systemPrompt = `${systemPrompt}\n\n<hook_context event="UserPromptExpansion">\n${expansion.additionalContext.join('\n\n')}\n</hook_context>`
      }
      // deny/halt:拦住命令展开——用拦截说明替换命令体,不让危险原文进模型(对齐 cc UserPromptExpansion 拦截语义)。
      if (expansion.blocked) {
        commandExpansionBlocked = expansion.blocked
        userMessage = `命令 /${commandInvocation.name} 的展开已被 hook 阻止:${expansion.blocked}(命令内容未执行、未注入模型)`
      }
    }
    const gatedMcp = resolveMcpConfig(rawBody, workspace.root)
    const mcpConfigPath = gatedMcp.path
    const mcpTools = await loadMcpToolsFromFiles([mcpConfigPath, ...runtimeExtensions.pluginMcpConfigPaths], {
      cwd: workspace.root,
      signal: controller.signal,
      timeoutMs: 10000,
      // toolTimeoutMs 不硬编码:走 mcp/client.ts 的 mcpToolTimeoutMs() 默认值(近乎无限,可用
      // QF_MCP_TOOL_TIMEOUT 覆盖),否则这里的常量会把 P0 修复在生产路径悄悄顶掉。
      fetchImpl: opts.fetchImpl,
      elicitationHandler: input => handleMcpElicitation(input, {
        conversationId,
        taskId: typeof rawBody.taskId === 'string' ? rawBody.taskId : undefined,
        signal: controller.signal,
        hooks,
        workspaceRoot: workspace.root,
      }),
      samplingHandler: ({ params, signal }) => runMcpSampling(model, providerRuntime.config.model, params, signal ?? controller.signal),
      // 主对话=用户在场:OAuth server 首次连接允许拉浏览器交互授权;令牌落 mcpOAuthDir 供各路径复用。
      oauth: { storageDir: mcpOAuthDir, interactive: true },
    })
    // 工作区级 .mcp.json 未信任被拦时,把警告并进 mcp 警告流(由下方 mcpTools.warnings 循环回灌)。
    if (gatedMcp.warning) mcpTools.warnings.unshift(gatedMcp.warning)
    // MCP Server Instructions 注入系统提示(对齐 cc:server 自报使用说明,已 2048 截断/Unicode 净化)。
    if (mcpTools.instructions.length > 0) {
      systemPrompt = [
        systemPrompt,
        '# MCP Server Instructions',
        ...mcpTools.instructions.map(entry => `## ${entry.server}\n${entry.text}`),
      ].join('\n\n')
    }
    const taskTools = [...createTaskTools(tasks), ...createStructuredTaskTools(taskLists)]
    let backgroundAgentOptions: BackgroundAgentTaskOptions | undefined
    const promptWorkerAgent = (prompt: PromptCommand, kind: 'command' | 'skill'): AgentDefinition => {
      const requested = prompt.agent?.trim()
      const found = requested ? agents.find(agent => agent.name === requested) : undefined
      const allowedTools = allowedToolsForAgent(prompt.allowedTools)
      const allowsAllTools = prompt.allowedTools?.includes('*') === true
      if (found) {
        const mergedHooks = mergeHookRegistries(found.hooks, prompt.hooks)
        return {
          ...found,
          ...(allowsAllTools ? { tools: undefined } : allowedTools ? { tools: allowedTools } : {}),
          allowedToolRules: prompt.allowedToolRules ?? prompt.allowedTools,
          ...(mergedHooks ? { hooks: mergedHooks } : {}),
        }
      }
      const suffix = normalizeCommandName(prompt.name).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || kind
      return {
        name: `${kind}-${suffix}`,
        description: `Forked ${kind} worker for ${kind === 'command' ? `/${prompt.name}` : prompt.name}.`,
        prompt: [
          `You are running a ${kind} in an isolated worker.`,
          `Execute the ${kind} instructions exactly, using tools when needed.`,
          'Return only the useful result for the parent conversation.',
        ].join('\n'),
        filePath: `built-in:${kind}-fork:${prompt.name}`,
        permissionMode: permissionModeFrom(rawBody.permissionMode),
        maxTurns: 80,
        ...(allowedTools ? { tools: allowedTools } : {}),
        allowedToolRules: prompt.allowedToolRules ?? prompt.allowedTools,
        ...(prompt.hooks ? { hooks: prompt.hooks } : {}),
      }
    }
    const executeSkill = async (skill: PromptCommand, args: string, toolCtx: ToolContext): Promise<string> => {
      const expandedPrompt = (await skill.getPrompt(args, toolCtx)).trim()
      recordInvokedSkill(skill, expandedPrompt, toolCtx)
      if (skill.context !== 'fork') {
        allowSkillTools(skill, toolCtx)
        registerSkillHooks(skill, toolCtx)
        return formatUseSkillResult(skill, expandedPrompt)
      }
      if (!backgroundAgentOptions) throw new Error('skill context:fork 需要后台任务运行器')
      if (!expandedPrompt) return `技能 ${skill.name} 没有可执行内容。`
      const agent = promptWorkerAgent(skill, 'skill')
      const { task } = await startBackgroundAgentRun(
        backgroundAgentOptions,
        {
          agent: agent.name,
          task: expandedPrompt,
          title: `skill:${skill.name}${args.trim() ? ` ${args.trim()}` : ''}`.slice(0, 120),
        },
        toolCtx,
        {
          skill: skill.name,
          skill_context: 'fork',
          ...(skill.agent ? { skill_agent: skill.agent } : {}),
        },
        [],
        [],
        { agentOverride: agent },
      )
      const agentId = typeof task.params?.agent_id === 'string' ? ` agent_id="${escapeXml(task.params.agent_id)}"` : ''
      return `<background_task_started id="${escapeXml(task.id)}" agent="${escapeXml(agent.name)}"${agentId} status="${escapeXml(task.status)}">\n${escapeXml(task.title)}\n</background_task_started>`
    }
    const teamTools = createTeamTools(teams, {
      tasks,
      udsPeers,
      bridgePeers,
      sendBridgeMessage: bridgeSendMessageFor(rawBody),
      resumeBackgroundAgent: (task, message, toolCtx) => {
        if (!backgroundAgentOptions) throw new Error('background agent runner is not available')
        return resumeBackgroundAgentTask(backgroundAgentOptions, task, message, toolCtx)
      },
    })
    const mediaTools = createMediaTools(media, { videoEditing })
    const storeDocTools = [createStoreDocsTool(storeDocs)]
    const backgroundBaseRegistry = buildGeneralRegistry({ skills, skillsRoot: createSkillsRoot, skillRecommendations, executeSkill, commands, extraTools: [...domainPackTools, ...taskTools, ...teamTools, ...mediaTools, ...storeDocTools] })
    const baseRegistry = buildGeneralRegistry({ skills, skillsRoot: createSkillsRoot, skillRecommendations, executeSkill, commands, extraTools: [...domainPackTools, ...mcpTools.tools, ...taskTools, ...teamTools, ...mediaTools, ...storeDocTools] })
    // 子代理 model 解析(对齐 cc getAgentModel):agent frontmatter 的 model 名匹配某个已配置 provider
    // runtime 的模型名时,用该 runtime 单独构造模型;不匹配 → null → agentTool 回退父模型。
    // 白标单模型下 runtimes 通常只有一档,匹配到同名即用、否则回退——机制真接通,owner 配多档即生效。
    const resolveAgentModel = (modelName: string): Model | null => {
      const matched = providerRuntimes.filter(runtime => runtime.config.model === modelName)
      if (matched.length === 0) return null
      return createModelFromRuntimeProviders(matched, opts.fetchImpl, providerHealthCallbacks)
    }
    backgroundAgentOptions = {
      tasks,
      agents,
      model,
      resolveModel: resolveAgentModel,
      baseTools: backgroundBaseRegistry.list(),
      baseSystemPrompt: systemPrompt,
      hooks,
      mcp: {
        mcpConfigPath,
        loadOptions: ({ workspaceRoot, signal, taskId }) => ({
          cwd: workspaceRoot,
          signal,
          timeoutMs: 10000,
          // toolTimeoutMs 不硬编码,同上:走 mcp/client.ts 的近乎无限默认值 + QF_MCP_TOOL_TIMEOUT 覆盖。
          fetchImpl: opts.fetchImpl,
          elicitationHandler: input => handleMcpElicitation(input, {
            conversationId,
            taskId,
            signal,
            hooks,
            workspaceRoot,
          }),
          samplingHandler: ({ params, signal: samplingSignal }) => runMcpSampling(model, providerRuntime.config.model, params, samplingSignal ?? signal ?? controller.signal),
        }),
      },
    }
    const agentSidechainRoot = join(stateRoot, 'agent-task-sidechains')
    const agentTools = agents.length > 0
      ? [createAgentTaskTool({
        agents,
        model,
        resolveModel: resolveAgentModel,
        baseTools: backgroundAgentOptions.baseTools,
        baseSystemPrompt: systemPrompt,
        sidechainRoot: agentSidechainRoot,
        hooks,
        mcp: backgroundAgentOptions.mcp,
        teams,
        startBackgroundAgent: (input, toolCtx, forkContext) => startBackgroundAgentRun(backgroundAgentOptions!, input, toolCtx, {}, [], [], forkContext ? { forkContext } : {}),
        registerForegroundAgent: (input, toolCtx, forkContext) => tasks.registerForegroundAgent({
          agentId: input.agentId,
          agent: input.agent,
          title: input.title,
          conversationId: toolCtx.conversationId,
          workspaceRoot: toolCtx.workspace.root,
          task: input.task,
          ...(input.context ? { context: input.context } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(forkContext ? { params: { fork_context: true } } : {}),
        }),
        handoffForegroundAgent: (registration, input, toolCtx, forkContext) => startBackgroundAgentRun(
          backgroundAgentOptions!,
          input,
          toolCtx,
          { foreground_handoff: true, agent_id: input.agentId },
          [],
          [],
          { ...(forkContext ? { forkContext } : {}), handoffTaskId: registration.task.id },
        ),
        unregisterForegroundAgent: taskId => tasks.unregisterForegroundAgent(taskId),
      })]
      : []
    const agentSidechainTools = agents.length > 0 ? createAgentTaskSidechainTools(agentSidechainRoot) : []
    const backgroundTools = agents.length > 0
      ? [createBackgroundAgentTaskTool(backgroundAgentOptions)]
      : []
    const registry = buildGeneralRegistry({ skills, skillsRoot: createSkillsRoot, skillRecommendations, executeSkill, commands, extraTools: [...domainPackTools, ...mcpTools.tools, ...taskTools, ...teamTools, ...mediaTools, ...storeDocTools, ...agentTools, ...agentSidechainTools, ...backgroundTools] })
    const launchContextForkCommand = async (command: PromptCommand): Promise<string> => {
      const expandedPrompt = commandInvocation?.prompt.trim() ?? ''
      if (!expandedPrompt) return `/${command.name} 没有可执行的命令内容。`
      const parentMessages = await transcript.load()
      const toolCtx = {
        workspace,
        model,
        registry,
        signal: controller.signal,
        permissionMode: permissionModeFrom(rawBody.permissionMode),
        conversationId,
        systemPrompt,
        renderedSystemPrompt: systemPrompt,
        toolResultStoreDir: join(stateRoot, 'tool-results', conversationId),
      }
      const agent = promptWorkerAgent(command, 'command')
      const args = commandInvocation?.args.trim() ?? ''
      const { task } = await startBackgroundAgentRun(
        backgroundAgentOptions!,
        {
          agent: agent.name,
          task: expandedPrompt,
          title: `/${command.name}${args ? ` ${args}` : ''}`.slice(0, 120),
        },
        toolCtx,
        {
          slash_command: command.name,
          command_context: 'fork',
          ...(command.agent ? { command_agent: command.agent } : {}),
        },
        [],
        [],
        { agentOverride: agent },
      )
      const agentId = typeof task.params?.agent_id === 'string' ? ` agent_id="${escapeXml(task.params.agent_id)}"` : ''
      const output = `<background_task_started id="${escapeXml(task.id)}" agent="${escapeXml(agent.name)}"${agentId} status="${escapeXml(task.status)}">\n${escapeXml(task.title)}\n</background_task_started>`
      await transcript.append([
        ...parentMessages,
        { role: 'user', content: [textBlock(commandInvocation?.raw ?? rawUserMessage)] },
        { role: 'assistant', content: [textBlock(output)] },
      ])
      return output
    }
    const launchBuiltinForkCommand = async (): Promise<string> => {
      const directive = commandInvocation?.args.trim() ?? ''
      if (!directive) return '用法: /fork <directive>'
      const parentMessages = await transcript.load()
      const toolCtx = {
        workspace,
        model,
        registry,
        signal: controller.signal,
        permissionMode: permissionModeFrom(rawBody.permissionMode),
        conversationId,
        messages: parentMessages,
        systemPrompt,
        renderedSystemPrompt: systemPrompt,
        toolResultStoreDir: join(stateRoot, 'tool-results', conversationId),
      }
      const forkContext = buildForkRunContext(toolCtx, directive)
      const { task, agent } = await startBackgroundAgentRun(
        backgroundAgentOptions!,
        {
          task: directive,
          title: `fork: ${directive.slice(0, 80)}`,
        },
        toolCtx,
        { slash_command: 'fork' },
        [],
        [],
        { forkContext },
      )
      const name = typeof task.params?.name === 'string' ? ` name="${escapeXml(task.params.name)}"` : ''
      const agentId = typeof task.params?.agent_id === 'string' ? ` agent_id="${escapeXml(task.params.agent_id)}"` : ''
      const output = `<background_task_started id="${escapeXml(task.id)}" agent="${escapeXml(agent.name)}"${name}${agentId} status="${escapeXml(task.status)}">\n${escapeXml(task.title)}\n</background_task_started>`
      await transcript.append([
        ...parentMessages,
        { role: 'user', content: [textBlock(commandInvocation?.raw ?? rawUserMessage)] },
        { role: 'assistant', content: [textBlock(output)] },
      ])
      return output
    }
    const stream = (async function* (): AsyncGenerator<SessionEventRecord> {
      let finalStatus: SessionStatus = 'idle'
      const record = async (event: SessionStreamEvent): Promise<SessionEventRecord> => {
        if (!turns.isCurrent(conversationId, controller)) return fallbackEventRecord(event)
        try {
          return await sessions.appendEvent(conversationId, event)
        } catch {
          return fallbackEventRecord(event)
        }
      }
      try {
        // 用户这句话先进事件日志(回放的唯一真相源):否则切会话/重启后重放只剩 agent 事件,用户气泡消失。
        yield await record({ type: 'user_prompt', text: commandInvocation?.raw ?? rawUserMessage })
        if (bridgeBlockedCommand) {
          const msg = bridgeUnsafeCommandMessage(bridgeBlockedCommand.name)
          yield await record({
            type: 'command_invocation',
            name: bridgeBlockedCommand.name,
            args: bridgeBlockedCommand.args,
            raw: bridgeBlockedCommand.raw,
            source: 'commands',
            contentLength: msg.length,
          })
          yield await record({ type: 'context_note', text: msg })
          yield await record({ type: 'final', text: msg })
          finalStatus = 'idle'
          return
        }
        if (commandInvocation && (commandInvocation.source === 'commands' || commandInvocation.source === 'builtin')) {
          yield await record({
            type: 'command_invocation',
            name: commandInvocation.name,
            args: commandInvocation.args,
            raw: commandInvocation.raw,
            source: 'commands',
            contentLength: commandInvocation.contentLength,
          })
        }
        // UserPromptExpansion deny/halt:fork 命令路径同样拦截——不派后台 fork agent(它会直接拿 commandInvocation.prompt
        // 原始展开体,绕过 inline 路径的 userMessage 替换)。命中即回说明、不执行(对齐 inline 路径的拦截语义)。
        if (commandExpansionBlocked && (isBuiltinForkCommand(commandInvocation) || (commandInvocation && matchedCommand?.context === 'fork'))) {
          yield await record({ type: 'final', text: `命令 /${commandInvocation?.name} 的展开已被 hook 阻止:${commandExpansionBlocked}(命令内容未执行、未派发后台工作代理)` })
          finalStatus = 'idle'
          return
        }
        if (isBuiltinForkCommand(commandInvocation)) {
          const output = await launchBuiltinForkCommand()
          yield await record({ type: 'final', text: output })
          finalStatus = 'idle'
          return
        }
        if (commandInvocation && matchedCommand?.context === 'fork') {
          const output = await launchContextForkCommand(matchedCommand)
          yield await record({ type: 'final', text: output })
          finalStatus = 'idle'
          return
        }
        if (goalCommandResult) {
          yield await record({ type: 'context_note', text: goalCommandResult.output })
          if (!goalCommandResult.shouldQuery) {
            yield await record({ type: 'final', text: goalCommandResult.output })
            finalStatus = 'idle'
            return
          }
        }
        for (const notice of orderedProviderRuntimes.notices) {
          yield await record({ type: 'context_note', text: notice })
        }
        for (const warning of mcpTools.warnings) {
          yield await record({ type: 'context_note', text: warning })
        }
        if (udsInboxWarning) {
          yield await record({ type: 'context_note', text: udsInboxWarning })
        }
        // 加载工作区 .claude/settings.json(+ local)持久化权限规则,置于会话临时规则之前(持久规则打底,会话规则覆盖)。
        const persistedRuleUpdates = permissionUpdatesFromRules(await loadPermissionRules(workspace.root))
        // 白标第二层:用户可见的助手文本(final 全文 + content_delta 流式 + thinking)出口兜底清洗;
        // content_delta 逐 token 流,真名可能跨两个 delta 被切断(如 "Clau"+"de"),故用有状态的
        // carry-over 缓冲(见 createChatOutputScrubber),清完把安全前缀放行、流末 flush 尾巴。
        const outputScrubber = createChatOutputScrubber()
        // max_turns/硬停时 loop 只 yield 事件、不产 final(对齐 cc 由调用方合成最终答复);循环外据此兜底给一条 final。
        let sawFinal = false
        let sawMaxTurns = false
        for await (const rawEvent of runAgentLoop({
          model,
          registry,
          workspace,
          sandbox: buildSandbox(workspace),
          systemPrompt,
          userMessage,
          userContent,
          modelName: providerRuntime.config.model,
          transcript,
          conversationId,
          activateConditionalSkills: activateConditionalSkillsFn,
          initialActivatedSkillNames: activatedConditionalSkills?.map(s => s.name),
          steerInbox,
          registerInterrupt: fn => { interruptRequesters.set(conversationId, fn) },
          signal: controller.signal,
          permissionMode: permissionModeFrom(rawBody.permissionMode),
          initialPermissionUpdates: [...persistedRuleUpdates, ...(sessionPermissionUpdates.get(conversationId) ?? [])],
          initialAllowedTools: commandInvocation && matchedCommand && matchedCommand.context !== 'fork' ? matchedCommand.allowedToolRules ?? matchedCommand.allowedTools : undefined,
          contextWindowChars: typeof rawBody.contextWindowChars === 'number' ? rawBody.contextWindowChars : undefined,
          contextWindowTokens,
          toolResultStoreDir: join(stateRoot, 'tool-results', conversationId),
          stateRoot,
          hooks,
          initialSessionHooks,
          onSessionHooksChanged: updatedHooks => {
            if (updatedHooks && updatedHooks.rules.length > 0) sessionSkillHooks.set(conversationId, updatedHooks)
            else sessionSkillHooks.delete(conversationId)
          },
          teamInbox: { service: teams },
        })) {
          if (rawEvent.type === 'final') sawFinal = true
          else if (rawEvent.type === 'max_turns_reached') sawMaxTurns = true
          // 出口兜底清洗:一个原始事件经清洗器可能变成 0..n 个(final 会先补 flush 打字机尾巴)。
          // content_delta 是瞬时 token 流:实时发给客户端(打字机),但不持久化进事件日志(否则日志膨胀、断线重放会重复整段增量)。
          // final/thinking/context_note 里若被模型自曝真名/供应商/原始报错,一律替成中性口径后再出。
          for (const event of outputScrubber.push(rawEvent)) {
            yield event.type === 'content_delta' ? fallbackEventRecord(event) : await record(event)
          }
        }
        // 流正常结束但没有 final(极少见)时,flush 掉各通道 hold 住的尾巴,别把已收到的正文吞掉。
        for (const event of outputScrubber.flush()) {
          if (event.type === 'final') sawFinal = true
          yield event.type === 'content_delta' ? fallbackEventRecord(event) : await record(event)
        }
        // 循环外兜底"总给最终答复"(对齐 cc:max_turns 命中/纯硬停时 loop 只 yield 事件不产 final,由调用方合成)。
        if (!sawFinal) {
          const aborted = controller.signal.aborted
          if (aborted) finalStatus = 'interrupted'
          const fallbackText = aborted ? '任务已中断' : sawMaxTurns ? '已达最大轮次,未能收敛。' : '任务已结束。'
          yield await record({ type: 'final', text: fallbackText })
        }
      } catch (err) {
        finalStatus = controller.signal.aborted ? 'interrupted' : 'failed'
        // 白标:总失败详情可能带模型层原始报错(真实模型名/供应商/endpoint),出口前统一脱敏。
        const detail = controller.signal.aborted
          ? '任务已中断'
          : scrubProviderIdentifiers(err instanceof Error ? err.message : String(err))
        yield await record({ type: 'context_note', text: `任务执行失败:${detail}` })
        yield await record({ type: 'final', text: `任务执行失败:${detail}` })
      } finally {
        if (udsPeer) await udsPeers.unregister(udsPeer.id).catch(() => undefined)
        await udsInbox?.close().catch(() => undefined)
        await closeMcpConnections(mcpTools.connections)
        const done = await record({ type: 'done' })
        const wasCurrent = turns.finish(conversationId, controller)
        interruptRequesters.delete(conversationId)
        if (wasCurrent) {
          steerInboxes.delete(conversationId)
          await sessions.touch(conversationId, { status: finalStatus })
        }
        yield done
      }
    })()
    return { conversationId, stream }
  }

  async function replayWsEvents(ws: { send(data: string): unknown }, conversationId: string, after: number): Promise<void> {
    const events = await sessions.loadEvents(conversationId, { after, limit: 1000 })
    for (const record of events) wsSend(ws, { type: 'event', seq: record.seq, ts: record.ts, event: record.event, replay: true })
  }

  async function handleWsRun(ws: { send(data: string): unknown; data: AgentWsData }, body: Record<string, unknown>): Promise<void> {
    try {
      const { conversationId, stream } = await createTurnStream({ ...body, conversationId: body.conversationId ?? ws.data.conversationId })
      ws.data.conversationId = conversationId
      for await (const record of stream) {
        wsSend(ws, { type: 'event', seq: record.seq, ts: record.ts, event: record.event })
      }
    } catch (err) {
      wsError(ws, err instanceof Error ? err.message : String(err))
    }
  }

  function legacyEventPayload(taskId: string, conversationId: string | undefined, record: { seq: number; event: SessionStreamEvent | import('../tasks/taskService').TaskStreamEvent }): Record<string, unknown> | null {
    const event = record.event
    const base = { offset: record.seq, task_id: taskId }
    if (event.type === 'started') return { ...base, type: 'context_note', content: event.text }
    if (event.type === 'thinking') return { ...base, type: 'reasoning', content: event.text }
    if (event.type === 'command_invocation') return { ...base, type: 'context_note', content: `已展开命令 /${event.name}${event.args ? ` ${event.args}` : ''}` }
    if (event.type === 'tool_call') return { ...base, type: 'tool_call', tool: event.tool, args: event.input }
    if (event.type === 'tool_progress') return { ...base, type: 'tool_progress', tool: event.tool, id: event.id, chunk: event.chunk, stream: event.stream }
    if (event.type === 'tool_result') return { ...base, type: 'tool_result', tool: event.tool, content: event.output }
    if (event.type === 'usage_update') return { ...base, ...event }
    if (event.type === 'ask_question') return { ...base, ...event }
    if (event.type === 'approval_request') return { ...base, ...event, args: event.args }
    if (event.type === 'steering') return { ...base, type: 'steering', content: event.content }
    if (event.type === 'todo_update') return { ...base, type: 'todo_update', content: event.content }
    if (event.type === 'context_note') return { ...base, type: 'context_note', content: event.text }
    if (event.type === 'max_turns_reached') return { ...base, type: 'context_note', content: `已达最大轮次(${event.turnCount}/${event.maxTurns}),已停止继续调用模型。` }
    if (event.type === 'final') return { ...base, type: 'final', content: event.text }
    if (event.type === 'done') return { ...base, type: 'done', stopped_reason: 'stop', conversation_id: conversationId, task_id: taskId, offset: record.seq }
    return null
  }

  async function* legacyTaskEventStream(requestedTaskId: string, after: number): AsyncGenerator<string> {
    let cursor = Math.max(0, after)
    for (let tick = 0; tick < 3000; tick++) {
      const resolved = await resolveTaskEndpointTarget(tasks, requestedTaskId)
      const requestedId = resolved.requestedTaskId
      const taskId = resolved.task?.id ?? requestedTaskId
      const task = resolved.task ?? await tasks.get(taskId)
      if (!task) {
        yield legacySseLine({ type: 'error', error: 'task not found', task_id: taskId, requested_task_id: requestedId, offset: cursor })
        yield legacySseLine({ type: 'done', stopped_reason: 'error', task_id: taskId, requested_task_id: requestedId, offset: cursor })
        return
      }
      const events = await tasks.loadEvents(taskId, { after: cursor, limit: 100 })
      for (const record of events) {
        cursor = Math.max(cursor, record.seq)
        const payload = legacyEventPayload(taskId, task.conversationId, record)
        if (payload) {
          yield legacySseLine({
            ...payload,
            ...(requestedId !== taskId ? { requested_task_id: requestedId, resolved_task_id: taskId } : {}),
            ...(typeof task.params?.agent_id === 'string' && task.params.agent_id.trim() ? { agent_id: task.params.agent_id.trim() } : {}),
          })
        }
        if (record.event.type === 'done') return
      }
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        yield legacySseLine({
          type: 'done',
          stopped_reason: task.status === 'failed' ? 'error' : task.status === 'cancelled' ? 'cancelled' : 'stop',
          conversation_id: task.conversationId,
          task_id: taskId,
          ...(requestedId !== taskId ? { requested_task_id: requestedId, resolved_task_id: taskId } : {}),
          ...(typeof task.params?.agent_id === 'string' && task.params.agent_id.trim() ? { agent_id: task.params.agent_id.trim() } : {}),
          offset: cursor,
        })
        return
      }
      await delay(100)
    }
    yield legacySseLine({ type: 'error', error: 'task event stream timeout', task_id: requestedTaskId, offset: cursor })
  }

  async function startLegacyAgentTask(rawBody: Record<string, unknown>): Promise<{ task_id: string; status: string }> {
    const message = stringOr(rawBody.message, '')
    if (!message) throw new TurnSetupError('message required', 400)
    const workspaceRoot = stringOr(rawBody.working_dir ?? rawBody.workspaceRoot, getDefaultWorkspaceDir())
    const conversationId = stringOr(rawBody.conversation_id ?? rawBody.conversationId, crypto.randomUUID())
    const task = await tasks.create({
      title: message.slice(0, 80),
      conversationId,
      workspaceRoot,
    })
    tasks.start(task.id, async taskCtx => {
      let finalText = ''
      const { stream } = await createTurnStream({
        ...rawBody,
        taskId: task.id,
        message,
        conversationId,
        workspaceRoot,
        permissionMode: rawBody.permission_mode ?? rawBody.permissionMode,
      })
      for await (const record of stream) {
        if (taskCtx.signal.aborted) break
        if (record.event.type === 'final') finalText = record.event.text
        if (record.event.type === 'user_prompt') continue // 任务通道不透传用户气泡事件(任务参数本就带 prompt)
        await taskCtx.emit(record.event)
      }
      return finalText
    })
    return { task_id: task.id, status: 'running' }
  }

  async function dispatchBridgeInboundToAgent(rawBody: Record<string, unknown>, resolved: BridgeResolvedInboundMessage): Promise<Record<string, unknown>> {
    const conversationId = stringOr(rawBody.conversationId ?? rawBody.conversation_id, '')
    const preview = inboundContentPreview(resolved.content) || 'Bridge inbound message'
    if (!conversationId) return { mode: 'stored' }

    if (turns.isRunning(conversationId)) {
      const inbox = steerInboxes.get(conversationId) ?? []
      inbox.push(preview)
      steerInboxes.set(conversationId, inbox)
      await sessions.appendEvent(conversationId, { type: 'steering', content: preview }).catch(() => undefined)
      return { mode: 'steering', conversationId, queued: inbox.length }
    }

    const autoRun = rawBody.autoRun === true || rawBody.auto_run === true
    if (!autoRun) return { mode: 'stored', conversationId }

    const workspaceRoot = stringOr(rawBody.working_dir ?? rawBody.workspaceRoot, getDefaultWorkspaceDir())
    const task = await tasks.create({
      title: preview.slice(0, 80),
      conversationId,
      workspaceRoot,
      kind: 'bridge_inbound',
      params: {
        bridge_session_id: stringOr(rawBody.bridgeSessionId ?? rawBody.bridge_session_id, ''),
        source: 'bridge_inbound',
        uuid: resolved.uuid,
      },
    })
    tasks.start(task.id, async taskCtx => {
      let finalText = ''
      const { stream } = await createTurnStream({
        ...rawBody,
        taskId: task.id,
        message: preview,
        messagePreview: preview,
        userContent: inboundContentBlocks(resolved.content),
        skipSlashCommands: resolved.skipSlashCommands,
        bridgeOrigin: resolved.bridgeOrigin,
        conversationId,
        workspaceRoot,
        permissionMode: rawBody.permission_mode ?? rawBody.permissionMode,
      })
      for await (const record of stream) {
        if (taskCtx.signal.aborted) break
        if (record.event.type === 'final') finalText = record.event.text
        if (record.event.type === 'user_prompt') continue // 任务通道不透传用户气泡事件(任务参数本就带 prompt)
        await taskCtx.emit(record.event)
      }
      return finalText
    })
    return { mode: 'task', conversationId, task_id: task.id, status: 'running' }
  }

  async function prewarm(rawBody: Record<string, unknown>) {
    const resolvedProviderRuntimes = await providers.resolveRuntimeConfigs(opts.env ?? process.env)
    if (resolvedProviderRuntimes.length === 0) throw new TurnSetupError('model provider not configured', 503)
    const orderedProviderRuntimes = orderRuntimeProvidersForAttempt(resolvedProviderRuntimes)
    const providerRuntimes = orderedProviderRuntimes.runtimes
    const providerRuntime = providerRuntimes[0]!
    createModelFromRuntimeProviders(providerRuntimes, opts.fetchImpl, providerHealthCallbacks)

    const workspace = workspaceFromBody(rawBody)
    const skillsRoot = opts.skillsRoot ?? defaultSkillsRoot()
    const commandsRoot = opts.commandsRoot ?? defaultCommandsRoot()
    const agentsRoot = opts.agentsRoot ?? defaultAgentsRoot()
    const enabledPacks = resolveEnabledPacks(rawBody)
    const [runtimeExtensions, configuredHooks, agents] = await Promise.all([
      loadRuntimeExtensionLibraries({ workspaceRoot: workspace.root, skillsRoot, commandsRoot, packs: enabledPacks, env: opts.env ?? process.env, pluginRoots }),
      // hooks 三级加载(见上方 §1621 同款注释);opts.hooksPath 仍作显式覆盖路径叠加。
      loadWorkspaceHookRegistry(workspace.root, opts.hooksPath),
      loadAgentsDir(agentsRoot),
    ])
    const pluginHooks = runtimeExtensions.pluginHookConfigPaths.length > 0
      ? await loadPluginHookRegistry(runtimeExtensions.pluginHookConfigPaths).catch(() => undefined)
      : undefined
    const hooks = mergeHookRegistries(configuredHooks, pluginHooks)

    const includeMcp = rawBody.includeMcp === true || rawBody.includeMcp === 'true'
    let mcp: { tools: number; warnings: string[] } | undefined
    if (includeMcp) {
      const mcpConfigPath = resolveMcpConfig(rawBody, workspace.root).path
      const loaded = await loadMcpToolsFromFiles([mcpConfigPath, ...runtimeExtensions.pluginMcpConfigPaths], {
        cwd: workspace.root,
        timeoutMs: 5000,
        fetchImpl: opts.fetchImpl,
        oauth: { storageDir: mcpOAuthDir, interactive: false }, // 探测只数工具数,不触发授权弹窗
      })
      mcp = { tools: loaded.tools.length, warnings: loaded.warnings }
      await closeMcpConnections(loaded.connections)
    }

    const conversationId = typeof rawBody.conversationId === 'string' && rawBody.conversationId.trim() ? rawBody.conversationId.trim() : undefined
    if (conversationId) {
      await sessions.touch(conversationId, {
        workspaceRoot: workspace.root,
        status: 'idle',
      })
    }

    return {
      ok: true,
      provider: {
        source: providerRuntime.source,
        providerId: providerRuntime.providerId,
        providerName: providerRuntime.providerName,
        // 白标:出口摘要走 publicProviderSummary(删 baseUrl/model/apiFormat)。
        summary: publicProviderSummary(providerRuntime.config),
      },
      fallbackCount: Math.max(0, resolvedProviderRuntimes.length - 1),
      ...(orderedProviderRuntimes.notices.length ? { notices: orderedProviderRuntimes.notices } : {}),
      workspaceRoot: workspace.root,
      skills: { root: skillsRoot, count: runtimeExtensions.skills.skills.length },
      commands: { root: commandsRoot, count: runtimeExtensions.commands.commands.length },
      domainTools: { count: createDomainPackTools(enabledPacks).length },
      hooks: { path: opts.hooksPath, count: hooks?.rules.length ?? 0 },
      agents: { root: agentsRoot, count: agents.length },
      ...(mcp ? { mcp } : {}),
    }
  }

  function bridgeSendMessageFor(rawBody: Record<string, unknown>) {
    const config = bridgeRemoteConfigFromBody(rawBody, opts.env ?? process.env)
    if (!config) return undefined
    const transport = createBridgeRemoteTransport({ ...config, fetchImpl: opts.fetchImpl })
    return async (sessionId: string, message: string) => {
      const result = await transport.sendUserMessage(sessionId, message)
      return {
        ok: result.ok,
        error: result.error ?? (result.status ? `Remote Control event POST failed ${result.status}` : undefined),
      }
    }
  }

  async function buildExecutionRegistry(rawBody: Record<string, unknown>) {
    const workspace = workspaceFromBody(rawBody)
    const skillsRoot = opts.skillsRoot ?? defaultSkillsRoot()
    const commandsRoot = opts.commandsRoot ?? defaultCommandsRoot()
    const enabledPacks = resolveEnabledPacks(rawBody)
    const domainPackTools = createDomainPackTools(enabledPacks)
    const runtimeExtensions = await loadRuntimeExtensionLibraries({
      workspaceRoot: workspace.root,
      skillsRoot,
      commandsRoot,
      packs: enabledPacks,
      env: opts.env ?? process.env,
      pluginRoots,
    })
    const mcpConfigPath = resolveMcpConfig(rawBody, workspace.root).path
    // toolTimeoutMs 不硬编码:走 mcp/client.ts 的近乎无限默认值 + QF_MCP_TOOL_TIMEOUT 覆盖。
    const mcpLoadOpts = { cwd: workspace.root, timeoutMs: 10000, fetchImpl: opts.fetchImpl, oauth: { storageDir: mcpOAuthDir, interactive: false } }
    const mcpTools = await loadMcpToolsFromFiles([mcpConfigPath, ...runtimeExtensions.pluginMcpConfigPaths], mcpLoadOpts)
    const registry = buildGeneralRegistry({
      skills: runtimeExtensions.skills,
      skillsRoot: userSkillsRoot(),
      skillRecommendations: suggestedSkillNamesForPacks(enabledPacks),
      commands: runtimeExtensions.commands,
      extraTools: [...domainPackTools, ...mcpTools.tools, ...createTaskTools(tasks), ...createStructuredTaskTools(taskLists), ...createTeamTools(teams, { tasks, udsPeers, bridgePeers, sendBridgeMessage: bridgeSendMessageFor(rawBody) }), ...createMediaTools(media, { videoEditing }), createStoreDocsTool(storeDocs)],
    })
    return { workspace, registry, connections: mcpTools.connections }
  }

  /** 审批放行执行的核心:POST /agent/execute 与 WS {type:'approve'} 共用。返回结果 payload 或 null(参数缺失)。 */
  async function runApprovedTool(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (typeof body.tool !== 'string' || !body.tool.trim()) return null
    const tool = body.tool.trim()
    const args = body.args ?? {}
    const approvalArgs = isRecord(body.approval_args) ? body.approval_args : isRecord(body.approvalArgs) ? body.approvalArgs : args
    const token = typeof body.token === 'string' ? body.token : undefined
    const conversationId = stringOr(body.conversation_id ?? body.conversationId, '')
    // 审批续跑必须回到原会话的上下文:请求没带 working_dir / enabled_packs 时从 session meta 补齐(自愈)。
    // 不补 working_dir → workspaceFromBody 兜底默认目录,文件写错文件夹、transcript 劈错分区(2026-07-12 真机逮到)。
    // 不补 enabled_packs → buildExecutionRegistry 只读 rawBody,审批放行的执行拿不到会话已挂的领域包工具/命令
    //(与主回合 §1565 三源合并口径不一致;当前领域包工具都未 requiresApproval 故暂不可触发,但结构上是同类分叉,一并收口)。
    if (conversationId) {
      const missingWd = !stringOr(body.working_dir ?? body.workspaceRoot, '')
      const missingPacks = !['enabled_packs', 'enabledPacks', 'knowledge_packs', 'knowledgePacks'].some(key => body[key] !== undefined)
      if (missingWd || missingPacks) {
        const meta = await sessions.get(conversationId).catch(() => undefined)
        if (meta) {
          if (missingWd && meta.workspaceRoot) body = { ...body, working_dir: meta.workspaceRoot }
          if (missingPacks && Array.isArray(meta.enabledPacks) && meta.enabledPacks.length) body = { ...body, enabled_packs: meta.enabledPacks }
        }
      }
    }
    const built = await buildExecutionRegistry(body)
    try {
      const baseCtx: ToolContext = {
        workspace: built.workspace,
        sandbox: buildSandbox(built.workspace),
        registry: built.registry,
        conversationId: conversationId || undefined,
        permissionMode: permissionModeFrom(body.permission_mode ?? body.permissionMode),
        toolResultStoreDir: conversationId ? join(stateRoot, 'tool-results', conversationId) : undefined,
        stateRoot,
      }
      // 持久化权限规则(工作区 .claude/settings.json)打底 + 会话临时规则覆盖,审批放行执行也认持久规则。
      const persistedRuleUpdates = permissionUpdatesFromRules(await loadPermissionRules(built.workspace.root))
      const ctx = applyPermissionUpdates(baseCtx, [...persistedRuleUpdates, ...(conversationId ? sessionPermissionUpdates.get(conversationId) ?? [] : [])])
      const result = await executeApproved(built.registry, tool, args, token, ctx, body.remember_approval === true || body.rememberApproval === true, approvalArgs)
      if (conversationId && result.ok && result.permissionUpdates?.length) {
        const existing = sessionPermissionUpdates.get(conversationId) ?? []
        sessionPermissionUpdates.set(conversationId, dedupePermissionUpdates([...existing, ...result.permissionUpdates]))
      }
      // cc 对齐:批准后把执行结果落进 transcript,让下一轮模型看得见"审批放行的工具结果",而不是永远停在 pending。
      // 审批在回合结束后发生(loop 在 approval_request 处已 return),无并发写,load+save 追加安全。
      if (conversationId && result.ok) {
        const transcriptStore = sessions.transcript(conversationId, built.workspace.root)
        const existing = await transcriptStore.load().catch(() => [] as Message[])
        const approvedMessage: Message = { role: 'user', content: [textBlock(`[已批准并执行工具 ${tool}]\n${result.output}`)] }
        await transcriptStore.append([...existing, approvedMessage]).catch(() => undefined)
      }
      return {
        tool,
        result: result.output,
        ok: result.ok,
        ...(result.permissionUpdates?.length ? { permission_updates: result.permissionUpdates } : {}),
        continuation: '',
        approval: null,
      }
    } finally {
      await closeMcpConnections(built.connections)
    }
  }

  async function executeLegacyAgentTool(body: Record<string, unknown>) {
    const payload = await runApprovedTool(body)
    if (!payload) return jsonDetailError('tool required', 400)
    return Response.json(payload)
  }

  async function rejectLegacyAgentTool(body: Record<string, unknown>) {
    if (typeof body.tool !== 'string' || !body.tool.trim()) return jsonDetailError('tool required', 400)
    const workspace = workspaceFromBody(body)
    handleReject(body.tool.trim(), body.args ?? {}, {
      workspace,
      conversationId: stringOr(body.conversation_id ?? body.conversationId, '') || undefined,
      permissionMode: permissionModeFrom(body.permission_mode ?? body.permissionMode),
    })
    return Response.json({ ok: true })
  }

  function dedupePermissionUpdates(updates: PermissionUpdate[]): PermissionUpdate[] {
    const seen = new Set<string>()
    const out: PermissionUpdate[] = []
    for (const update of updates) {
      const key = JSON.stringify(update)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(update)
    }
    return out
  }

  async function legacyConversations() {
    const deleted = await legacyStore.deletedConversationIds()
    const rows = await sessions.list()
    return {
      conversations: rows
        .filter(session => !deleted.has(session.id))
        .map(session => ({
          conversation_id: session.id,
          title: session.title || '新对话',
          last_at: session.updatedAt,
        })),
    }
  }

  async function legacyConversationMessages(id: string) {
    const session = await sessions.get(id).catch(() => null)
    if (!session) return { conversation_id: id, messages: [] }
    const messages = await sessions.loadTranscript(id)
    return {
      conversation_id: id,
      messages: messages
        .map(message => ({ role: message.role, content: messageText(message) }))
        .filter(message => message.content),
    }
  }

  async function deletedConversationArtifacts(limit: number): Promise<LegacyArtifact[]> {
    const deleted = await legacyStore.listDeletedConversations()
    const out: LegacyArtifact[] = []
    for (const record of deleted) {
      const session = await sessions.get(record.id).catch(() => null)
      out.push({
        id: record.id,
        kind: 'task',
        type: 'agent_conversation',
        title: session?.title || '已删除会话',
        subtitle: 'AI 对话',
        content: null,
        url: null,
        conversation_id: record.id,
        created_at: record.deleted_at,
      })
      if (out.length >= limit) break
    }
    return out
  }

  async function fileDiffFromQuery(url: URL): Promise<Response> {
    const requested = url.searchParams.get('path') || ''
    if (!requested.trim()) return Response.json({ ok: false, error: 'path required' }, { status: 400 })
    const target = resolve(requested)
    if (isSensitiveFilePath(target)) {
      return Response.json({ ok: false, error: '该文件可能含敏感信息，需要在对话中经确认后处理。' })
    }
    const backupParam = url.searchParams.get('backup_path') || url.searchParams.get('backupPath') || ''
    const backup = backupParam ? resolve(backupParam) : ''
    if (backup && isSensitiveFilePath(backup)) {
      return Response.json({ ok: false, error: '备份文件可能含敏感信息，需要在对话中经确认后处理。' })
    }
    const [oldText, newText] = await Promise.all([
      backup ? readTextIfExists(backup) : Promise.resolve(''),
      readTextIfExists(target),
    ])
    return Response.json({ ok: true, path: target, backup_path: backup || null, old: oldText, new: newText })
  }

  async function restoreFileFromBackup(body: Record<string, unknown>): Promise<Response> {
    const requested = typeof body.path === 'string' ? body.path : ''
    const backupRequested = typeof body.backup_path === 'string'
      ? body.backup_path
      : typeof body.backupPath === 'string'
        ? body.backupPath
        : ''
    if (!requested.trim()) return Response.json({ ok: false, error: 'path required' }, { status: 400 })
    if (!backupRequested.trim()) return Response.json({ ok: false, error: 'backup_path required' }, { status: 400 })
    const target = resolve(requested)
    const backup = resolve(backupRequested)
    if (isSensitiveFilePath(target) || isSensitiveFilePath(backup)) {
      return Response.json({ ok: false, error: '该文件可能含敏感信息，需要在对话中经确认后处理。' })
    }
    if (!existsSync(backup)) return Response.json({ ok: false, path: target, backup_path: backup, error: '备份文件不存在' })
    const currentBackupPath = join(dirname(target), '.restore-backups', `${basename(target)}.${Date.now()}.bak`)
    await mkdir(dirname(currentBackupPath), { recursive: true })
    if (existsSync(target)) await copyFile(target, currentBackupPath)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(backup, target)
    return Response.json({ ok: true, path: target, backup_path: backup, current_backup_path: existsSync(currentBackupPath) ? currentBackupPath : undefined })
  }

  async function legacyChatResponse(rawBody: Record<string, unknown>): Promise<Response> {
    const { conversationId, stream } = await createTurnStream({
      ...rawBody,
      conversationId: rawBody.conversation_id ?? rawBody.conversationId,
      permissionMode: rawBody.permission_mode ?? rawBody.permissionMode,
    })
    const bodyStream = (async function* () {
      for await (const record of stream) {
        const payload = legacyEventPayload(conversationId, conversationId, record)
        if (payload) yield legacySseLine(payload)
      }
    })()
    return new Response(bodyStream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    })
  }

  function dailyDraftPayload() {
    return {
      drafts: [
        {
          title: '今晚黄金档朋友圈',
          category: 'content',
          prompt_key: 'billiards_evening_peak',
          content: '今晚桌台状态在线，适合约一局放松一下。到店可问前台拿今日空桌安排，三五好友开台更划算。',
        },
        {
          title: '新客体验短文案',
          category: 'content',
          prompt_key: 'billiards_new_guest',
          content: '第一次来不用担心不会打，店里可以帮你安排合适桌型和基础指引。想练球、聚会、放松都可以直接来。',
        },
        {
          title: '助教课转化文案',
          category: 'content',
          prompt_key: 'billiards_coach',
          content: '想把准度和走位练稳定，可以约一节助教体验。先看动作问题，再给你一套能自己练的短计划。',
        },
      ],
      cached: false,
    }
  }

  async function saveUpload(req: Request, kind: 'logo' | 'qrcode') {
    const form = await req.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) return jsonDetailError('file required', 400)
    const ext = extname(file.name || '') || '.bin'
    const rel = `/uploads/local/${kind}-${Date.now()}${ext}`
    const abs = join(stateRoot, 'uploads', 'local', basename(rel))
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, Buffer.from(await file.arrayBuffer()))
    const qrcodeContent = kind === 'qrcode' ? optionalString(form?.get('content')) : null
    const extra = qrcodeContent ? { qrcode_text: qrcodeContent } : {}
    await desktopData.updateStore({ [`${kind}_url`]: rel, ...extra })
    return Response.json({ url: rel })
  }

  async function serveLocalUpload(pathname: string): Promise<Response | null> {
    if (!pathname.startsWith('/uploads/local/')) return null
    const abs = join(stateRoot, 'uploads', 'local', basename(pathname))
    if (!existsSync(abs)) return null
    return new Response(await readFile(abs))
  }

  interface StudioBrandAsset {
    role: 'logo' | 'qrcode' | 'brand'
    url: string
  }

  function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }

  function uniqueStrings(values: string[]): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const value of values) {
      const trimmed = value.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      out.push(trimmed)
    }
    return out
  }

  function existingUploadUrl(value: unknown): string | null {
    const raw = optionalString(value)
    if (!raw || !raw.startsWith('/uploads/')) return null
    if (raw.includes('\0')) return null
    const rel = raw.slice('/uploads/'.length)
    if (!rel || rel.split(/[\\/]/).some(segment => segment === '..')) return null
    const uploadsRoot = resolve(stateRoot, 'uploads')
    const abs = resolve(uploadsRoot, rel)
    if (abs !== uploadsRoot && !abs.startsWith(`${uploadsRoot}/`) && !abs.startsWith(`${uploadsRoot}\\`)) return null
    return existsSync(abs) ? raw : null
  }

  function brandStyleText(value: unknown): string | undefined {
    const raw = optionalString(value)
    if (!raw) return undefined
    const labels: Record<string, string> = {
      lively: '热闹活力',
      professional: '专业可信',
      youthful: '年轻潮流',
      premium: '高端质感',
      minimal: '简约干净',
      luxury: '高档大气',
      sporty: '活力运动',
    }
    return labels[raw] ? `${labels[raw]}(${raw})` : raw
  }

  function storeBrandAssets(store: Record<string, unknown>): StudioBrandAsset[] {
    const assets: StudioBrandAsset[] = []
    const logo = existingUploadUrl(store.logo_url)
    const qrcode = existingUploadUrl(store.qrcode_url)
    if (logo) assets.push({ role: 'logo', url: logo })
    if (qrcode) assets.push({ role: 'qrcode', url: qrcode })
    for (const url of stringArray(store.brand_reference_images).map(existingUploadUrl).filter((item): item is string => !!item).slice(0, 4)) {
      assets.push({ role: 'brand', url })
    }
    return assets
  }

  function storeBrandSuffix(store: Record<string, unknown>, assets: StudioBrandAsset[], body: Record<string, unknown>, mode: 'generate' | 'edit'): string {
    const lines: string[] = []
    const explicitStoreInfo = body.add_store_info === true
    const storeName = optionalString(store.name)
    const city = optionalString(store.city)
    const district = optionalString(store.district)
    const location = [city, district].filter(Boolean).join('')
    const brandStyle = brandStyleText(store.brand_style ?? store.style)
    const brandColor = optionalString(store.brand_color)
    const hasCustomName = !!storeName && storeName !== '我的台球房'
    const hasLogo = assets.some(asset => asset.role === 'logo')
    const hasQrAsset = assets.some(asset => asset.role === 'qrcode')
    const hasQrContent = !!optionalString(store.qrcode_text ?? store.qrcode_content ?? store.qr_content)
    const hasQr = hasQrAsset || hasQrContent
    const hasBrandRefs = assets.some(asset => asset.role === 'brand')
    const hasContext = explicitStoreInfo || hasCustomName || !!location || !!brandStyle || !!brandColor || assets.length > 0
    if (!hasContext) return ''

    if ((explicitStoreInfo || hasCustomName) && storeName) lines.push(`门店名称:${storeName}`)
    if (location) lines.push(`门店位置:${location}`)
    if (brandStyle) lines.push(`品牌风格:${brandStyle}`)
    if (brandColor) lines.push(`品牌主色调呼应 ${brandColor}，背景和点缀色协调即可，不要求整图都是这个颜色。`)
    if (hasLogo) lines.push('已提供门店 Logo 原文件，将由固定图层准确叠加；底图只需留出安全位置，不要重绘 Logo。')
    if (hasQr) {
      const printNote = body.print_mode === true
        ? '这张图用于印刷/线下投放，二维码必须保持方正、清晰、可扫描，并留出足够静区。'
        : '二维码可作为行动入口自然出现，但必须保持方正、清晰、可扫描，不要重绘成花纹。'
      lines.push(`已提供门店二维码原文件，将由固定图层准确叠加，${printNote}`)
    }
    if (hasBrandRefs) lines.push('已附带品牌参考图，只提取品牌质感和配色，不要照搬无关内容。')
    if (mode === 'edit' && hasBrandRefs) {
      lines.push('改图时第一张输入图是需要保留血缘的源图，门店素材只作为品牌融合参考。')
    } else if (hasBrandRefs) {
      lines.push('输入素材用于品牌约束和版式参考，不要让参考图里的无关背景抢占主画面。')
    }
    return lines.length ? `门店品牌约束:\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}` : ''
  }

  async function prepareStudioImageBody(rawBody: Record<string, unknown>, mode: 'generate' | 'edit'): Promise<Record<string, unknown>> {
    const store: Record<string, unknown> = await desktopData.getStore().catch(() => ({}))
    const assets = storeBrandAssets(store)
    const suppliedBrief = rawBody.creative_brief && typeof rawBody.creative_brief === 'object'
      ? rawBody.creative_brief as Record<string, unknown>
      : undefined
    const isPortrait = rawBody.scene === 'portrait'
      || rawBody.intent === 'portrait'
      || rawBody.portrait === true
      || suppliedBrief?.scene === 'portrait'
    const brandReferencePaths = isPortrait ? [] : assets.filter(asset => asset.role === 'brand').map(asset => asset.url)
    const logoAsset = assets.find(asset => asset.role === 'logo')
    const qrcodeAsset = assets.find(asset => asset.role === 'qrcode')
    const qrcodeText = optionalString(store.qrcode_text ?? store.qrcode_content ?? store.qr_content)
    const referenceImagePaths = uniqueStrings([...stringArray(rawBody.reference_image_paths), ...brandReferencePaths]).slice(0, 14)
    const suffix = isPortrait ? '' : storeBrandSuffix(store, assets, rawBody, mode)
    const body: Record<string, unknown> = {
      ...rawBody,
      _store_brand_pack_applied: true,
    }
    delete body._system_brand_context
    if (referenceImagePaths.length > 0) body.reference_image_paths = referenceImagePaths
    if (!isPortrait && logoAsset && !body._print_logo_path) body._print_logo_path = logoAsset.url
    if (!isPortrait && qrcodeAsset && !body._print_qr_path) body._print_qr_path = qrcodeAsset.url
    if (!isPortrait && qrcodeText && !body._print_qr_content) body._print_qr_content = qrcodeText
    if (suffix) body._system_brand_context = suffix
    return body
  }

  const handleCanvasRoute = createCanvasRouteHandler({ stateRoot })

  async function listMcpStatus(rawBody: Record<string, unknown> = {}) {
    const workspaceRoot = stringOr(rawBody.workspaceRoot ?? rawBody.working_dir, getDefaultWorkspaceDir())
    const gatedMcp = resolveMcpConfig(rawBody, workspaceRoot)
    const mcpConfigPath = gatedMcp.path
    if (!mcpConfigPath) return { servers: [], ...(gatedMcp.warning ? { untrusted_workspace_config: true, note: gatedMcp.warning } : {}) }
    const configs = await loadMcpConfigFile(mcpConfigPath).catch(() => [])
    const loaded = await loadMcpToolsFromFile(mcpConfigPath, {
      cwd: workspaceRoot,
      timeoutMs: 5000,
      fetchImpl: opts.fetchImpl,
      oauth: { storageDir: mcpOAuthDir, interactive: false }, // server 列表查询,不触发授权弹窗
    })
    try {
      const connected = new Map(loaded.connections.map(connection => [connection.serverName, connection]))
      const warningText = loaded.warnings.join('\n')
      return {
        servers: configs.map(config => {
          const connection = connected.get(config.name)
          return {
            name: config.name,
            command: config.command,
            url: config.url,
            status: config.disabled === true ? 'disabled' : connection ? 'connected' : warningText.includes(`"${config.name}"`) ? 'error' : 'configured',
            tools: connection?.tools.length ?? 0,
            disabled: config.disabled === true,
          }
        }),
      }
    } finally {
      await closeMcpConnections(loaded.connections)
    }
  }

  const handleMcpRoute = createMcpRouteHandler({
    presets: MCP_PRESETS,
    listStatus: workspaceRoot => listMcpStatus({ workspaceRoot }),
    trust: mcpTrust,
    add: body => addMcpServer(body, defaultWritableMcpConfigPath(opts.env ?? process.env)),
    remove: name => removeMcpServer(name, defaultWritableMcpConfigPath(opts.env ?? process.env)),
    setDisabled: (name, disabled) => setMcpServerDisabled(name, disabled, defaultWritableMcpConfigPath(opts.env ?? process.env)),
  })
  const handleStudioRoute = createStudioRouteHandler({ media, imageWorkbenchRoute: handleImageWorkbenchRoute })
  const handleVideoEditRoute = createLegacyVideoEditRouteHandler({ media, videoEdits, videoEditV2Route: handleVideoEditV2Route })
  const handlePluginRoute = createPluginRouteHandler({
    list: () => listPlugins(pluginRoots),
    setEnabled: (name, enabled) => setPluginEnabled(name, enabled, pluginRoots),
    installFromGithub: repo => installPluginFromGithub(repo, defaultPluginInstallDir(opts.env ?? process.env)),
  })
  const handleProviderRoute = createProviderRouteHandler({ providers, currentModelStatus, clearModelHealth, fetchImpl: opts.fetchImpl })
  const handleScheduledTaskRoute = createScheduledTaskRouteHandler({ store: desktopData, runner: scheduledTasks })
  const sessionArchive = new SessionArchiveService({
    sessions,
    archiveRoot: join(stateRoot, 'transcript-archives'),
    resolveModel: async () => {
      const resolvedProviderRuntimes = await providers.resolveRuntimeConfigs(opts.env ?? process.env)
      if (resolvedProviderRuntimes.length === 0) throw new SessionArchiveError('model provider not configured', 503)
      const providerRuntimes = orderRuntimeProvidersForAttempt(resolvedProviderRuntimes).runtimes
      return createModelFromRuntimeProviders(providerRuntimes, opts.fetchImpl, providerHealthCallbacks)
    },
  })
  const handleSessionActivityRoute = createSessionActivityRouteHandler({ sessions, turns })
  const handleSessionArchiveRoute = createSessionArchiveRouteHandler({ archive: sessionArchive })
  const handleSessionMetadataRoute = createSessionMetadataRouteHandler({ sessions, defaultWorkspaceRoot: getDefaultWorkspaceDir })
  const handleSessionRewindRoute = createSessionRewindRouteHandler({ sessions, rewind: sessionRewind })
  const handleStoreDocsRoute = createStoreDocsRouteHandler({ store: desktopData, service: storeDocs })
  const handleTaskRoute = createTaskRouteHandler({ tasks })
  const handleWorkspaceFileRoute = createWorkspaceFileRouteHandler({ defaultWorkspaceRoot: getDefaultWorkspaceDir })
  const handleWorkspaceRoute = createWorkspaceRouteHandler({ settings: userSettings, defaultWorkspaceRoot: getDefaultWorkspaceDir })
  const handleExtensionDiscoveryRoute = createExtensionDiscoveryRouteHandler({
    skillsRoot: opts.skillsRoot ?? defaultSkillsRoot(),
    commandsRoot: opts.commandsRoot ?? defaultCommandsRoot(),
    defaultWorkspaceRoot: getDefaultWorkspaceDir,
    env: opts.env ?? process.env,
    pluginRoots,
  })
  const bridgeSessionRoutes = createBridgeSessionRouteController({
    state: bridgeRemote,
    peers: bridgePeers,
    stateRoot,
    env: opts.env,
    fetchImpl: opts.fetchImpl,
    WebSocketCtor: opts.bridgeWebSocketCtor,
    dispatchInbound: dispatchBridgeInboundToAgent,
    projectEvent: projectBridgeEventToConversation,
  })
  const bridgeWorkerRoutes = createBridgeWorkerRouteController({
    state: bridgeRemote,
    peers: bridgePeers,
    stateRoot,
    env: opts.env,
    fetchImpl: opts.fetchImpl,
    dispatchInbound: dispatchBridgeInboundToAgent,
    projectEvent: projectBridgeEventToConversation,
  })
  const websocket = createAgentWebSocketHandler({
    assetTopic: ASSET_WS_TOPIC,
    turnConsumers,
    turns,
    sessions,
    steerInboxes,
    interruptRequesters,
    replayEvents: replayWsEvents,
    runTurn: handleWsRun,
    runApprovedTool,
    rejectTool: handleReject,
  })

  const app = Bun.serve<AgentWsData>({
    hostname: host,
    port,
    idleTimeout: 30,
    async fetch(req, server) {
      const preflight = localCorsPreflight(req)
      if (preflight) return preflight
      const response = await (async (): Promise<Response | undefined> => {
      const url = new URL(req.url)

      if (url.pathname === '/agent/ws') {
        const conversationId = stringOr(url.searchParams.get('conversationId'), crypto.randomUUID())
        const after = numberFrom(url.searchParams.get('after'), 0)
        if (server.upgrade(req, { data: { conversationId, after } satisfies AgentWsData })) {
          return undefined as unknown as Response
        }
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      if (url.pathname === '/health') {
        return Response.json({ ok: true, service: 'ts-harness', ts: Date.now() })
      }

      if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
        const localUpload = await serveLocalUpload(url.pathname)
        if (localUpload) return localUpload
        const upload = media.serveUpload(url.pathname)
        if (upload) return upload
      }

      if (url.pathname === '/api/v1/backup/export' && req.method === 'GET') {
        return new Response(JSON.stringify({
          exported_at: new Date().toISOString(),
          store: await desktopData.getStore(),
          byok: await desktopData.getByok(),
          // 自造店脑记忆已下线(改用 cc AutoMem memdir);保留空数组兼容旧备份格式。
          memories: [],
          scheduled_tasks: await desktopData.listScheduledTasks(),
          store_docs: await desktopData.getStoreDocs(),
        }, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': 'attachment; filename="billiardbuddy-backup.json"',
          },
        })
      }

      const studioResponse = await handleStudioRoute(url, req)
      if (studioResponse) return studioResponse

      const videoEditResponse = await handleVideoEditRoute(url, req)
      if (videoEditResponse) return videoEditResponse

      const canvasResponse = await handleCanvasRoute(url, req)
      if (canvasResponse) return canvasResponse

      if (url.pathname === '/api/v1/stores' && req.method === 'POST') {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(await desktopData.updateStore(body), { status: 201 })
      }

      if (url.pathname === '/api/v1/stores/me') {
        if (req.method === 'GET') return Response.json(imageBrandPackSchema.parse(await desktopData.getStore()))
        if (req.method === 'PUT' || req.method === 'PATCH') {
          const parsed = imageBrandPackPatchSchema.safeParse(await req.json().catch(() => ({})))
          if (!parsed.success) return jsonDetailError('invalid brand pack', 400)
          return Response.json(imageBrandPackSchema.parse(await desktopData.updateStore(parsed.data)))
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/stores/me/logo' || url.pathname === '/api/v1/stores/me/qrcode') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        return await saveUpload(req, url.pathname.endsWith('/logo') ? 'logo' : 'qrcode')
      }

      if (url.pathname === '/api/v1/uploads/image') {
        // 通用图片上传(区域截图/聊天附图)→ 返回 /uploads/local url。供"基于此调整"+ 贴图。
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        return await saveLocalImageAttachment(stateRoot, req)
      }

      if (url.pathname === '/api/v1/stores/me/byok') {
        if (req.method === 'GET') return Response.json(await desktopData.getByok())
        if (req.method === 'PUT' || req.method === 'PATCH') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const updated = await desktopData.updateByok(body)
          await syncLegacyByokTextProvider(body, updated)
          return Response.json(updated)
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/stores/me/byok/validate') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(await desktopData.validateByok(body))
      }

      if (url.pathname === '/api/v1/stores/me/byok/profiles') {
        if (req.method === 'GET') return Response.json(await desktopData.listByokProfiles())
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          return Response.json(await desktopData.addByokProfile(body))
        }
        return new Response('Method not allowed', { status: 405 })
      }

      const byokProfileMatch = url.pathname.match(/^\/api\/v1\/stores\/me\/byok\/profiles\/([^/]+)(?:\/(activate))?$/)
      if (byokProfileMatch) {
        const name = decodeURIComponent(byokProfileMatch[1]!)
        const action = byokProfileMatch[2]
        if (action === 'activate' && req.method === 'POST') return Response.json(await desktopData.activateByokProfile(name))
        if (!action && req.method === 'DELETE') return Response.json(await desktopData.deleteByokProfile(name))
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/assets/status') {
        // 资产管理器全量状态(前端"正在准备组件 x%"UI 的拉取口;增量走 WS asset_progress)。
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json(assets.status())
      }

      if (url.pathname === '/api/v1/voice/transcribe') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const form = await req.formData().catch(() => null)
        const file = form?.get('file')
        if (!(file instanceof File)) return jsonDetailError('file required', 400)
        try {
          return Response.json(voiceTranscriptionResponseSchema.parse(await transcribeVoiceFile(file, { stateRoot, env: opts.env ?? process.env })))
        } catch (err) {
          const status = err instanceof VoiceTranscriptionError ? err.status : 500
          return jsonDetailError(err instanceof Error ? err.message : String(err), status)
        }
      }

      if (url.pathname === '/api/v1/logs/client') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        return Response.json({ ok: true })
      }

      const scheduledTaskResponse = await handleScheduledTaskRoute(url, req)
      if (scheduledTaskResponse) return scheduledTaskResponse

      const storeDocsResponse = await handleStoreDocsRoute(url, req)
      if (storeDocsResponse) return storeDocsResponse

      if (url.pathname === '/api/v1/notifications') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json(await desktopData.notificationsAfter(numberFrom(url.searchParams.get('after'), 0)))
      }

      const providerResponse = await handleProviderRoute(url, req)
      if (providerResponse) return providerResponse

      const extensionDiscoveryResponse = await handleExtensionDiscoveryRoute(url, req)
      if (extensionDiscoveryResponse) return extensionDiscoveryResponse

      const mcpResponse = await handleMcpRoute(url, req)
      if (mcpResponse) return mcpResponse

      if (url.pathname === '/api/v1/agent/workspace-status') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const workspaceRoot = url.searchParams.get('working_dir') || url.searchParams.get('workspaceRoot') || getDefaultWorkspaceDir()
        const workspace = new Workspace(workspaceRoot)
        const [git, projectInstructions, tree] = await Promise.all([
          getWorkspaceGitStatus(workspaceRoot),
          summarizeWorkspaceProjectInstructions(workspace),
          summarizeWorkspaceTree(workspaceRoot),
        ])
        return Response.json({ root: workspaceRoot, git, projectInstructions, tree })
      }

      const bridgeWorkerResponse = await bridgeWorkerRoutes.handle(url, req)
      if (bridgeWorkerResponse) return bridgeWorkerResponse

      const bridgeSessionResponse = await bridgeSessionRoutes.handle(url, req)
      if (bridgeSessionResponse) return bridgeSessionResponse

      const pluginResponse = await handlePluginRoute(url, req)
      if (pluginResponse) return pluginResponse

      const workspaceFileResponse = await handleWorkspaceFileRoute(url, req)
      if (workspaceFileResponse) return workspaceFileResponse

      // 配置基座:App 级用户设置(默认权限档/主题),供设置抽屉读写。
      if (url.pathname === '/api/settings') {
        if (req.method === 'GET') return Response.json({ settings: await userSettings.get() })
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          return Response.json({ settings: await userSettings.update(body) })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      const workspaceResponse = await handleWorkspaceRoute(url, req)
      if (workspaceResponse) return workspaceResponse

      // 规则持久化:把一条权限规则写进工作区 .claude/settings.local.json(跨重启生效),供"始终允许"选择用。
      if (url.pathname === '/api/v1/agent/permissions/persist' && req.method === 'POST') {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const behavior = body.behavior === 'deny' ? 'deny' : body.behavior === 'ask' ? 'ask' : 'allow'
        const toolName = typeof body.toolName === 'string' ? body.toolName.trim() : ''
        if (!toolName) return Response.json({ ok: false, error: 'toolName required' }, { status: 400 })
        const ruleValue = { toolName, ...(typeof body.ruleContent === 'string' && body.ruleContent.trim() ? { ruleContent: body.ruleContent.trim() } : {}) }
        const workspace = workspaceFromBody(body)
        await persistPermissionRule(workspace.root, behavior, ruleValue)
        return Response.json({ ok: true, behavior, rule: ruleValue })
      }
      if (url.pathname === '/api/v1/agent/permissions/rules' && req.method === 'GET') {
        const workspace = workspaceFromBody(Object.fromEntries(url.searchParams))
        return Response.json({ rules: await loadPermissionRules(workspace.root) })
      }

      if (url.pathname === '/api/v1/agent/execute') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return await executeLegacyAgentTool(body)
      }

      if (url.pathname === '/api/v1/agent/reject') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return await rejectLegacyAgentTool(body)
      }

      if (url.pathname === '/api/v1/agent/chat') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        server.timeout(req, 0)
        try {
          return await legacyChatResponse(body)
        } catch (err) {
          const status = err instanceof TurnSetupError ? err.status : 500
          return jsonDetailError(err instanceof Error ? err.message : String(err), status)
        }
      }

      if (url.pathname === '/api/v1/agent/daily-drafts') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        return Response.json(dailyDraftPayload())
      }

      if (url.pathname === '/api/v1/agent/conversations') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json(await legacyConversations())
      }

      const legacyConversationMatch = url.pathname.match(/^\/api\/v1\/agent\/conversations\/([A-Za-z0-9_-]{1,128})$/)
      if (legacyConversationMatch) {
        const conversationId = legacyConversationMatch[1]!
        if (req.method === 'GET') return Response.json(await legacyConversationMessages(conversationId))
        if (req.method === 'DELETE') {
          await legacyStore.setConversationDeleted(conversationId, true)
          // 会话结束落点:用户删除会话 → 触发 SessionEnd 钩子(reason=clear),fire-and-forget 不阻塞响应。
          await fireSessionEndHooks(conversationId, 'clear')
          return Response.json({ ok: true, conversation_id: conversationId })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/agent/recent-artifacts') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json({ items: await legacyStore.listArtifacts(numberFrom(url.searchParams.get('limit'), 12), false) })
      }

      if (url.pathname === '/api/v1/agent/saved-artifacts') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        try {
          const item = await legacyStore.saveArtifact({
            title: typeof body.title === 'string' ? body.title : undefined,
            content: typeof body.content === 'string' ? body.content : '',
            conversationId: typeof body.conversation_id === 'string' ? body.conversation_id : typeof body.conversationId === 'string' ? body.conversationId : null,
            kind: typeof body.kind === 'string' ? body.kind : null,
          })
          return Response.json(item)
        } catch (err) {
          return jsonDetailError(err instanceof Error ? err.message : String(err), 400)
        }
      }

      const legacyRecentArtifactMatch = url.pathname.match(/^\/api\/v1\/agent\/recent-artifacts\/([A-Za-z0-9_-]{1,128})(?:\/(rating))?$/)
      if (legacyRecentArtifactMatch) {
        const artifactId = legacyRecentArtifactMatch[1]!
        const action = legacyRecentArtifactMatch[2]
        if (!action && req.method === 'DELETE') {
          await legacyStore.setArtifactDeleted(artifactId, true)
          return Response.json({ ok: true, id: artifactId })
        }
        if (action === 'rating' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const rating = body.rating === 'bad' ? 'bad' : body.rating === 'good' ? 'good' : null
          if (!rating) return jsonDetailError('评价只能是 good 或 bad', 400)
          const ok = await legacyStore.rateArtifact(artifactId, rating, typeof body.note === 'string' ? body.note : null)
          if (!ok) return jsonDetailError('没找到这条成品', 404)
          return Response.json({ ok: true, id: artifactId, rating })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/agent/deleted-items') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const limit = numberFrom(url.searchParams.get('limit'), 30)
        const [artifactItems, conversationItems] = await Promise.all([
          legacyStore.listArtifacts(limit, true),
          deletedConversationArtifacts(limit),
        ])
        const items = [...artifactItems, ...conversationItems]
          .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
          .slice(0, Math.max(1, Math.min(80, limit)))
        return Response.json({ items })
      }

      if (url.pathname === '/api/v1/agent/deleted-items/restore') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id : ''
        const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : typeof body.conversationId === 'string' ? body.conversationId : ''
        if (conversationId) await legacyStore.setConversationDeleted(conversationId, false)
        else if (id) await legacyStore.setArtifactDeleted(id, false)
        else return jsonDetailError('缺少要恢复的内容', 400)
        return Response.json({ ok: true })
      }

      if (url.pathname === '/api/v1/agent/deleted-items/purge') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id : ''
        const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : typeof body.conversationId === 'string' ? body.conversationId : ''
        if (conversationId) {
          await sessions.remove(conversationId)
          await legacyStore.setConversationDeleted(conversationId, false)
        } else if (id) {
          await legacyStore.purgeArtifact(id)
        } else {
          return jsonDetailError('缺少要彻底删除的内容', 400)
        }
        return Response.json({ ok: true })
      }

      if (url.pathname === '/api/v1/agent/deleted-items/clear') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const deletedConversationIds = await legacyStore.clearDeletedConversations()
        await Promise.all(deletedConversationIds.map(id => sessions.remove(id).catch(() => false)))
        await legacyStore.clearDeletedArtifacts()
        return Response.json({ ok: true, removed_file_backups: 0 })
      }

      if (url.pathname === '/api/v1/agent/file-diff') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return await fileDiffFromQuery(url)
      }

      if (url.pathname === '/api/v1/agent/file-restore') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return await restoreFileFromBackup(body)
      }

      if (url.pathname === '/api/v1/agent/image/validate') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(validateImageModelPayload(body))
      }

      if (url.pathname === '/api/v1/agent/tasks') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        try {
          return Response.json(await startLegacyAgentTask(body))
        } catch (err) {
          const status = err instanceof TurnSetupError ? err.status : 500
          return Response.json({ ok: false, detail: err instanceof Error ? err.message : String(err) }, { status })
        }
      }

      const legacyTaskMatch = url.pathname.match(/^\/api\/v1\/agent\/tasks\/([A-Za-z0-9_-]{1,128})(?:\/(events|cancel|message|background))$/)
      if (legacyTaskMatch) {
        const id = legacyTaskMatch[1]!
        const action = legacyTaskMatch[2]!
        if (action === 'events' && req.method === 'GET') {
          server.timeout(req, 0)
          const after = Number.parseInt(url.searchParams.get('after') ?? '-1', 10)
          return new Response(legacyTaskEventStream(id, after), {
            headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
          })
        }
        if (action === 'cancel' && req.method === 'POST') {
          const { task, requestedTaskId } = await resolveTaskEndpointTarget(tasks, id, ['queued', 'running'])
          const interrupted = task?.conversationId ? turns.interrupt(task.conversationId) : false
          const taskId = task?.id ?? id
          const cancelled = await tasks.cancel(taskId)
          return Response.json({
            ok: true,
            task_id: taskId,
            ...(task && task.id !== requestedTaskId ? { requested_task_id: requestedTaskId, resolved_task_id: task.id } : {}),
            ...(typeof task?.params?.agent_id === 'string' && task.params.agent_id.trim() ? { agent_id: task.params.agent_id.trim() } : {}),
            status: cancelled || interrupted ? 'cancelled' : task?.status ?? 'unknown',
          })
        }
        if (action === 'background' && req.method === 'POST') {
          try {
            const task = await tasks.requestForegroundAgentBackground(id)
            return Response.json({
              ok: true,
              task_id: task.id,
              status: task.status,
              ...(typeof task.params?.agent_id === 'string' && task.params.agent_id.trim() ? { agent_id: task.params.agent_id.trim() } : {}),
            })
          } catch (err) {
            return Response.json({ ok: false, detail: err instanceof Error ? err.message : String(err) }, { status: 404 })
          }
        }
        if (action === 'message' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const message = typeof body.message === 'string' ? body.message.trim() : ''
          if (!message) return Response.json({ ok: false, detail: 'message required' }, { status: 400 })
          const { task, requestedTaskId } = await resolveTaskEndpointTarget(tasks, id)
          if (!task?.conversationId) return Response.json({ ok: false, detail: 'task not found' }, { status: 404 })
          const inbox = steerInboxes.get(task.conversationId) ?? []
          inbox.push(message)
          steerInboxes.set(task.conversationId, inbox)
          await tasks.appendEvent(task.id, { type: 'steering', content: message }).catch(() => undefined)
          return Response.json({
            ok: true,
            task_id: task.id,
            ...(task.id !== requestedTaskId ? { requested_task_id: requestedTaskId, resolved_task_id: task.id } : {}),
            ...(typeof task.params?.agent_id === 'string' && task.params.agent_id.trim() ? { agent_id: task.params.agent_id.trim() } : {}),
            queued: inbox.length,
          })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      const legacyMediaJobMatch = url.pathname.match(/^\/api\/v1\/agent\/media-jobs\/([A-Za-z0-9_-]{1,128})$/)
      if (legacyMediaJobMatch) {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const status = await media.status(legacyMediaJobMatch[1]!)
        if (!status) return Response.json({ ok: false, detail: '任务不存在或已过期' }, { status: 404 })
        return Response.json(status)
      }

      const sessionMetadataResponse = await handleSessionMetadataRoute(url, req)
      if (sessionMetadataResponse) return sessionMetadataResponse

      const sessionActivityResponse = await handleSessionActivityRoute(url, req)
      if (sessionActivityResponse) return sessionActivityResponse

      const sessionRewindResponse = await handleSessionRewindRoute(url, req)
      if (sessionRewindResponse) return sessionRewindResponse

      const sessionArchiveResponse = await handleSessionArchiveRoute(url, req)
      if (sessionArchiveResponse) return sessionArchiveResponse

      const taskResponse = await handleTaskRoute(url, req)
      if (taskResponse) return taskResponse

      if (url.pathname === '/agent/hello') {
        server.timeout(req, 0) // 关掉 Bun 空闲掐断,否则安静的 SSE 流会被杀
        const workspace = new Workspace(getDefaultWorkspaceDir())
        const systemPrompt = await buildSystemPrompt(workspace)
        // demo model:请求列一次工作区,拿到结果后收敛。真模型出口留 W6。
        const demoSteps: AssistantStep[] = [
          { kind: 'tool_calls', text: '看看工作区里有什么', calls: [{ id: '1', name: 'list_dir', input: {} }] },
          { kind: 'final', text: '这是当前工作区的内容。' },
        ]
        const body = (async function* () {
          for await (const ev of runAgentLoop({
            model: scriptedModel(demoSteps),
            registry: buildGeneralRegistry(),
            workspace,
            systemPrompt,
            userMessage: '列一下工作区',
          })) {
            yield sseLine(ev)
          }
          yield sseLine({ type: 'done' })
        })()
        return new Response(body, {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        })
      }

      if (url.pathname === '/agent/prewarm') {
        if (req.method !== 'POST' && req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const body = req.method === 'POST'
          ? await req.json().catch(() => ({})) as Record<string, unknown>
          : Object.fromEntries(url.searchParams.entries())
        try {
          return Response.json(await prewarm(body))
        } catch (err) {
          const status = err instanceof TurnSetupError ? err.status : 500
          return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status })
        }
      }

      if (url.pathname === '/agent/run') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>

        server.timeout(req, 0)
        let turn: { stream: AsyncGenerator<SessionEventRecord> }
        try {
          turn = await createTurnStream(body)
        } catch (err) {
          const status = err instanceof TurnSetupError ? err.status : 500
          return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status })
        }
        const bodyStream = (async function* () {
          for await (const record of turn.stream) {
            yield sseLine(record.event)
          }
        })()
        return new Response(bodyStream, {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        })
      }

      // ts-desktop 前端静态资源:GET 未命中任何 API 路由 → 从 frontendRoot 服务(Electron/浏览器加载前端)。
      if (req.method === 'GET') {
        const asset = await serveFrontendAsset(url.pathname)
        if (asset) return asset
      }

      return new Response('Not found', { status: 404 })
      })()
      return response ? withLocalCors(response, req) : undefined as unknown as Response
    },
    websocket,
  })
  // 资产下载进度 → WS 广播(事件结构见 assets/types AssetProgressEvent)。
  const unsubscribeAssetEvents = assets.onEvent(event => {
    try {
      app.publish(ASSET_WS_TOPIC, JSON.stringify(event))
    } catch {
      // server 已停/无订阅者:忽略,状态照常落 state.json。
    }
  })
  // 定时任务调度:测试环境默认不启(避免无关测试里后台起真 agent 会话);QF_SCHEDULER=0 显式关。
  const scheduledTasksAutoStart = opts.scheduledTasksAutoStart ?? (process.env.NODE_ENV !== 'test' && (opts.env ?? process.env).QF_SCHEDULER !== '0')
  if (scheduledTasksAutoStart) scheduledTasks.start()
  // 诊断遥测(task#16):开机上传心跳+上次崩溃日志到自有 dataeye(静默、脱敏、幂等;env 缺配置=禁用)。
  // fire-and-forget:任何失败都不影响启动;测试环境同 scheduler 口径不自动跑(测试显式调用)。
  if (process.env.NODE_ENV !== 'test') {
    const telemetry = createTelemetryService({ stateRoot, env: opts.env ?? process.env })
    if (telemetry.enabled) void telemetry.uploadOnBoot((opts.env ?? process.env).QF_APP_VERSION ?? '0.0.0-dev')
  }
  const stop = app.stop.bind(app)
  app.stop = (closeActiveConnections?: boolean) => {
    unsubscribeAssetEvents()
    scheduledTasks.stop()
    assets.stop()
    if (getActiveAssetManager() === assets) setActiveAssetManager(null)
    bridgeSessionRoutes.close()
    bridgeWorkerRoutes.close()
    return stop(closeActiveConnections)
  }
  return app
}
