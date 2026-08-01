import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { CodexAppServerClient, type JsonObject } from './codexAppServerClient.js'
import { CodexEngineThreadStore, type CodexEngineThreadBinding, type CodexEngineThreadState } from './codexEngineThreadStore.js'

export type CodexEngineSessionOptions = {
  client: CodexAppServerClient
  thread_store: CodexEngineThreadStore
  binding: CodexEngineThreadBinding
  source_revision: string
  work_dir: string
  model: string
}

export type CodexEngineThread = {
  thread_id: string
  restored: boolean
}

function text(value: unknown, limit = 512): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function threadId(response: JsonObject): string {
  const thread = record(response.thread)
  const id = text(thread?.id)
  if (!id) throw new Error('CODEX_ENGINE_THREAD_RESPONSE_INVALID')
  return id
}

async function verifiedWorkDir(value: string): Promise<string> {
  const workDir = await fs.realpath(path.resolve(value))
  const stat = await fs.lstat(workDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('CODEX_ENGINE_WORK_DIR_INVALID')
  return workDir
}

/**
 * Owns exactly the task-session -> engine Thread relationship. It intentionally
 * does not start a Turn: a Turn is only legal once the model, event and tool
 * bridges can give BilliardBuddy a durable receipt for every outcome.
 *
 * An upstream `thread/start` without a Turn has no rollout to resume after a
 * process restart. It remains in memory only; its id becomes durable only
 * after the future Run bridge receives a successful `turn/start` response.
 */
export class CodexEngineSession {
  private thread?: CodexEngineThread

  constructor(private readonly options: CodexEngineSessionOptions) {}

  async ensureThread(): Promise<CodexEngineThread> {
    if (this.thread) return this.thread
    if (!/^[a-f0-9]{40}$/.test(this.options.source_revision) || !text(this.options.model)) {
      throw new Error('CODEX_ENGINE_SESSION_INVALID')
    }
    const workDir = await verifiedWorkDir(this.options.work_dir)
    const restored = await this.options.thread_store.load(this.options.binding)
    const thread = restored
      ? await this.resume(restored, workDir)
      : await this.start(workDir)
    this.thread = thread
    return thread
  }

  /**
   * Called only after the product Run ledger has recorded intent and the
   * app-server has accepted `turn/start`. Persisting before that point would
   * falsely make a no-effect, non-resumable thread look recoverable.
   */
  async checkpointAcceptedTurn(runId: string, turnId: string, operationId: string): Promise<string> {
    const thread = await this.ensureThread()
    if (!text(runId) || !text(turnId) || !/^effect_[a-f0-9-]{36}$/.test(operationId)) throw new Error('CODEX_ENGINE_TURN_BINDING_INVALID')
    const checkpoint = await this.options.thread_store.save(this.options.binding, {
      thread_id: thread.thread_id,
      source_revision: this.options.source_revision,
      last_run_id: runId,
      last_turn_id: turnId,
      last_turn_operation_id: operationId,
    })
    return checkpoint.checkpoint_digest
  }

  async checkpointModelResult(runId: string, operationId: string, resultDigest: string): Promise<string> {
    const thread = await this.ensureThread()
    if (!text(runId) || !/^effect_[a-f0-9-]{36}$/.test(operationId) || !/^[a-f0-9]{64}$/.test(resultDigest)) {
      throw new Error('CODEX_ENGINE_MODEL_RECEIPT_INVALID')
    }
    const restored = await this.options.thread_store.load(this.options.binding)
    if (!restored || restored.thread_id !== thread.thread_id || restored.last_run_id !== runId || !restored.last_turn_id) {
      throw new Error('CODEX_ENGINE_MODEL_RECEIPT_TURN_MISSING')
    }
    const checkpoint = await this.options.thread_store.save(this.options.binding, {
      thread_id: thread.thread_id,
      source_revision: this.options.source_revision,
      last_run_id: restored.last_run_id,
      last_turn_id: restored.last_turn_id,
      ...(restored.last_turn_operation_id ? { last_turn_operation_id: restored.last_turn_operation_id } : {}),
      last_model_run_id: runId,
      last_model_operation_id: operationId,
      last_model_result_digest: resultDigest,
    })
    return checkpoint.checkpoint_digest
  }

  private async start(workDir: string): Promise<CodexEngineThread> {
    const response = await this.options.client.request<JsonObject>('thread/start', {
      cwd: workDir,
      model: this.options.model,
      personality: 'none',
      serviceName: 'billiardbuddy',
      // Thread-scoped config is required because App Server takes a snapshot
      // at `thread/start`; the process-level override alone is not a durable
      // Thread capability declaration.
      config: { host_managed_tools_only: true },
      // Defense in depth: an embedded engine gets no upstream environment.
      // The host-managed source patch separately removes all built-in tools.
      environments: [],
    })
    const id = threadId(response)
    return { thread_id: id, restored: false }
  }

  private async resume(state: CodexEngineThreadState, workDir: string): Promise<CodexEngineThread> {
    if (state.source_revision !== this.options.source_revision) throw new Error('CODEX_ENGINE_THREAD_SOURCE_MISMATCH')
    const response = await this.options.client.request<JsonObject>('thread/resume', {
      threadId: state.thread_id,
      cwd: workDir,
      model: this.options.model,
      excludeTurns: true,
    })
    const id = threadId(response)
    if (id !== state.thread_id) throw new Error('CODEX_ENGINE_THREAD_ID_MISMATCH')
    await this.options.thread_store.save(this.options.binding, {
      thread_id: id,
      source_revision: this.options.source_revision,
      ...(state.last_run_id ? { last_run_id: state.last_run_id } : {}),
      ...(state.last_turn_id ? { last_turn_id: state.last_turn_id } : {}),
      ...(state.last_turn_operation_id ? { last_turn_operation_id: state.last_turn_operation_id } : {}),
      ...(state.last_model_run_id ? { last_model_run_id: state.last_model_run_id } : {}),
      ...(state.last_model_operation_id ? { last_model_operation_id: state.last_model_operation_id } : {}),
      ...(state.last_model_result_digest ? { last_model_result_digest: state.last_model_result_digest } : {}),
    })
    return { thread_id: id, restored: true }
  }
}
