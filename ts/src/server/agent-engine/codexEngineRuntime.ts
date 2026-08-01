import { CodexAppServerClient, type CodexAppServerClientOptions, type CodexAppServerNotification, type CodexAppServerRequest, type JsonObject, type JsonValue } from './codexAppServerClient.js'
import { CodexEngineSession, type CodexEngineDynamicToolSurface, type CodexEngineThread, type CodexEngineSessionOptions } from './codexEngineSession.js'
import { CodexResponsesModelBridge, type CodexResponsesModelBridgeOptions } from './codexResponsesModelBridge.js'

export type CodexEngineRuntimeOptions = Omit<CodexEngineSessionOptions, 'client'> & {
  command: readonly string[]
  engine_home: string
  base_instructions: string
  developer_instructions?: string
  run_model: CodexResponsesModelBridgeOptions['run_model']
  checkpoint_model_result: CodexResponsesModelBridgeOptions['checkpoint_model_result']
  on_notification?(notification: CodexAppServerNotification): void
  on_server_request?(request: CodexAppServerRequest): Promise<JsonValue | undefined>
}

export type CodexEngineAcceptedTurn = {
  thread_id: string
  turn_id: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function nonEmptyText(value: unknown, limit = 512): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined
}

function turnId(response: JsonObject): string {
  const turn = record(response.turn)
  const id = nonEmptyText(turn?.id)
  if (!id) throw new Error('CODEX_ENGINE_TURN_RESPONSE_INVALID')
  return id
}

function quoted(value: string): string {
  return JSON.stringify(value)
}

function engineConfig(input: {
  base_url: string
  capability_token: string
  base_instructions: string
  developer_instructions?: string
}): string[] {
  if (!input.base_instructions.trim()) throw new Error('CODEX_ENGINE_BASE_INSTRUCTIONS_REQUIRED')
  return [
    `model_provider=${quoted('billiardbuddy')}`,
    `model_providers.billiardbuddy.name=${quoted('BilliardBuddy local model bridge')}`,
    `model_providers.billiardbuddy.base_url=${quoted(input.base_url)}`,
    'model_providers.billiardbuddy.wire_api="responses"',
    // `--config` parses one TOML assignment at a time. Assign the complete
    // header map, rather than a dotted map member, so the source config loader
    // preserves the opaque loopback capability token.
    `model_providers.billiardbuddy.http_headers={${quoted('X-BilliardBuddy-Engine-Token')}=${quoted(input.capability_token)}}`,
    'model_providers.billiardbuddy.request_max_retries=0',
    'model_providers.billiardbuddy.stream_max_retries=0',
    `base_instructions=${quoted(input.base_instructions)}`,
    ...(input.developer_instructions?.trim() ? [`developer_instructions=${quoted(input.developer_instructions)}`] : []),
    'include_permissions_instructions=false',
    'include_apps_instructions=false',
    'include_collaboration_mode_instructions=false',
    'include_skill_instructions=false',
    'include_environment_context=false',
    // The BilliardBuddy-owned source patch removes every upstream tool from
    // this embedded engine. Only explicit dynamic tools may re-enter through
    // the product permission host; until that bridge is supplied, there are no
    // model-visible tools at all.
    'host_managed_tools_only=true',
  ]
}

/**
 * One BilliardBuddy-owned runtime instance. Its bridge endpoint, engine home,
 * model instruction set and Thread identity are all private to the product;
 * the upstream app-server never receives a Gateway token or personal API key.
 */
export class CodexEngineRuntime {
  private readonly bridge: CodexResponsesModelBridge
  private client?: CodexAppServerClient
  private session?: CodexEngineSession

  constructor(private readonly options: CodexEngineRuntimeOptions) {
    this.bridge = new CodexResponsesModelBridge({
      run_model: options.run_model,
      checkpoint_model_result: options.checkpoint_model_result,
    })
  }

  async start(): Promise<void> {
    if (this.client) throw new Error('CODEX_ENGINE_RUNTIME_ALREADY_STARTED')
    const bridge = this.bridge.start()
    const clientOptions: CodexAppServerClientOptions = {
      command: this.options.command,
      engine_home: this.options.engine_home,
      client_info: { name: 'billiardbuddy-engine', title: 'BilliardBuddy Engine', version: '1.0.0' },
      config_overrides: engineConfig({
        base_url: bridge.base_url,
        capability_token: bridge.capability_token,
        base_instructions: this.options.base_instructions,
        ...(this.options.developer_instructions !== undefined ? { developer_instructions: this.options.developer_instructions } : {}),
      }),
      on_notification: this.options.on_notification,
      on_server_request: this.options.on_server_request,
    }
    const client = new CodexAppServerClient(clientOptions)
    try {
      await client.start()
      this.client = client
      this.session = new CodexEngineSession({
        client,
        thread_store: this.options.thread_store,
        binding: this.options.binding,
        source_revision: this.options.source_revision,
        work_dir: this.options.work_dir,
        model: this.options.model,
      })
    } catch (error) {
      await client.close().catch(() => undefined)
      this.bridge.stop()
      throw error
    }
  }

  async ensureThread(): Promise<CodexEngineThread> {
    if (!this.session) throw new Error('CODEX_ENGINE_RUNTIME_UNAVAILABLE')
    return await this.session.ensureThread()
  }

  async checkpointToolSurface(surface: CodexEngineDynamicToolSurface): Promise<string> {
    if (!this.session) throw new Error('CODEX_ENGINE_RUNTIME_UNAVAILABLE')
    return await this.session.checkpointToolSurface(surface)
  }

  /**
   * Starts a source Turn but deliberately does not make it durable. The
   * product Worker must record its Run intent, receive the response, write the
   * BilliardBuddy Thread binding, and then checkpoint its own ledger before it
   * can treat this as an acknowledged product action.
   */
  async startTurn(input: { run_id: string; text: string }): Promise<CodexEngineAcceptedTurn> {
    const client = this.client
    const session = this.session
    const runId = nonEmptyText(input.run_id)
    const text = nonEmptyText(input.text, 4 * 1024 * 1024)
    if (!client || !session || !runId || !text) throw new Error('CODEX_ENGINE_TURN_INVALID')
    const thread = await session.ensureThread()
    const response = await client.request<JsonObject>('turn/start', {
      threadId: thread.thread_id,
      clientUserMessageId: runId,
      input: [{ type: 'text', text }],
      cwd: this.options.work_dir,
      model: this.options.model,
      personality: 'none',
      environments: [],
    })
    return { thread_id: thread.thread_id, turn_id: turnId(response) }
  }

  async checkpointAcceptedTurn(runId: string, turnId: string, operationId: string): Promise<string> {
    if (!this.session) throw new Error('CODEX_ENGINE_RUNTIME_UNAVAILABLE')
    return await this.session.checkpointAcceptedTurn(runId, turnId, operationId)
  }

  async checkpointModelResult(runId: string, operationId: string, resultDigest: string): Promise<string> {
    if (!this.session) throw new Error('CODEX_ENGINE_RUNTIME_UNAVAILABLE')
    return await this.session.checkpointModelResult(runId, operationId, resultDigest)
  }

  async checkpointToolResult(runId: string, operationId: string, callId: string, resultDigest: string): Promise<string> {
    if (!this.session) throw new Error('CODEX_ENGINE_RUNTIME_UNAVAILABLE')
    return await this.session.checkpointToolResult(runId, operationId, callId, resultDigest)
  }

  async interruptTurn(turn: CodexEngineAcceptedTurn): Promise<void> {
    const client = this.client
    if (!client || !nonEmptyText(turn.thread_id) || !nonEmptyText(turn.turn_id)) throw new Error('CODEX_ENGINE_TURN_INVALID')
    await client.request<JsonObject>('turn/interrupt', { threadId: turn.thread_id, turnId: turn.turn_id })
  }

  async close(): Promise<void> {
    const client = this.client
    this.client = undefined
    this.session = undefined
    try {
      await client?.close()
    } finally {
      this.bridge.stop()
    }
  }
}
