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

export type CodexEngineDynamicToolSurface = {
  digest: string
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
}

export type CodexEngineRunInstructionSnapshot = {
  digest: string
  prompt: string | null
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

function inputReceipt(state: CodexEngineThreadState): Pick<CodexEngineThreadState, 'last_input_run_id' | 'last_input_operation_id' | 'last_input_result_digest'> {
  return state.last_input_run_id && state.last_input_operation_id && state.last_input_result_digest
    ? {
        last_input_run_id: state.last_input_run_id,
        last_input_operation_id: state.last_input_operation_id,
        last_input_result_digest: state.last_input_result_digest,
      }
    : {}
}

function steerReceipt(state: CodexEngineThreadState): Pick<CodexEngineThreadState, 'last_steer_run_id' | 'last_steer_operation_id' | 'last_steer_queue_item_id' | 'last_steer_input_digest'> {
  return state.last_steer_run_id && state.last_steer_operation_id && state.last_steer_queue_item_id && state.last_steer_input_digest
    ? {
        last_steer_run_id: state.last_steer_run_id,
        last_steer_operation_id: state.last_steer_operation_id,
        last_steer_queue_item_id: state.last_steer_queue_item_id,
        last_steer_input_digest: state.last_steer_input_digest,
      }
    : {}
}

function instructionSnapshot(state: CodexEngineThreadState): Pick<CodexEngineThreadState, 'last_instruction_run_id' | 'last_instruction_digest' | 'last_instruction_prompt'> {
  return state.last_instruction_run_id && state.last_instruction_digest && state.last_instruction_prompt !== undefined
    ? {
        last_instruction_run_id: state.last_instruction_run_id,
        last_instruction_digest: state.last_instruction_digest,
        last_instruction_prompt: state.last_instruction_prompt,
      }
    : {}
}

function validInstructionSnapshot(value: CodexEngineRunInstructionSnapshot): boolean {
  return /^[a-f0-9]{64}$/.test(value.digest)
    && (value.prompt === null || (typeof value.prompt === 'string' && value.prompt.length <= 100_000))
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
  private dynamicToolSurface?: CodexEngineDynamicToolSurface

  constructor(private readonly options: CodexEngineSessionOptions) {}

  async ensureThread(): Promise<CodexEngineThread> {
    if (this.thread) return this.thread
    if (!/^[a-f0-9]{40}$/.test(this.options.source_revision) || !text(this.options.model)) {
      throw new Error('CODEX_ENGINE_SESSION_INVALID')
    }
    const workDir = await verifiedWorkDir(this.options.work_dir)
    const restored = await this.options.thread_store.load(this.options.binding)
    const thread = restored?.thread_id
      ? await this.resume(restored, workDir)
      : await this.start(workDir)
    this.thread = thread
    return thread
  }

  /** Reuse the frozen instruction body only when recovering this exact Run. */
  async resolveRunInstructionSnapshot(
    runId: string,
    current: CodexEngineRunInstructionSnapshot,
  ): Promise<CodexEngineRunInstructionSnapshot> {
    if (!text(runId) || !validInstructionSnapshot(current)) throw new Error('CODEX_ENGINE_INSTRUCTION_SNAPSHOT_INVALID')
    const restored = await this.options.thread_store.load(this.options.binding)
    if (restored?.last_instruction_run_id !== runId) return current
    if (!restored.last_instruction_digest || restored.last_instruction_prompt === undefined) {
      throw new Error('CODEX_ENGINE_INSTRUCTION_SNAPSHOT_MISSING')
    }
    return { digest: restored.last_instruction_digest, prompt: restored.last_instruction_prompt }
  }

  /**
   * The source accepts dynamic tools only at thread/start. Persist this
   * opaque product snapshot before a Turn so mcp_prepare can be checkpointed
   * without claiming a resumable source Thread prematurely.
   */
  async checkpointToolSurface(surface: CodexEngineDynamicToolSurface): Promise<string> {
    if (this.thread || !isToolSurface(surface)) throw new Error('CODEX_ENGINE_TOOL_SURFACE_INVALID')
    const restored = await this.options.thread_store.load(this.options.binding)
    if (restored?.source_revision && restored.source_revision !== this.options.source_revision) throw new Error('CODEX_ENGINE_THREAD_SOURCE_MISMATCH')
    if (restored?.tool_surface_digest && (restored.tool_surface_digest !== surface.digest || restored.tool_surface_count !== surface.tools.length)) {
      throw new Error('CODEX_ENGINE_TOOL_SURFACE_MISMATCH')
    }
    this.dynamicToolSurface = surface
    const checkpoint = await this.options.thread_store.save(this.options.binding, {
      ...(restored?.thread_id ? { thread_id: restored.thread_id } : {}),
      source_revision: this.options.source_revision,
      tool_surface_digest: surface.digest,
      tool_surface_count: surface.tools.length,
      ...(restored?.last_run_id ? { last_run_id: restored.last_run_id } : {}),
      ...(restored?.last_turn_id ? { last_turn_id: restored.last_turn_id } : {}),
      ...(restored?.last_turn_operation_id ? { last_turn_operation_id: restored.last_turn_operation_id } : {}),
      ...(restored ? instructionSnapshot(restored) : {}),
      ...(restored ? inputReceipt(restored) : {}),
      ...(restored ? steerReceipt(restored) : {}),
      ...(restored?.last_model_run_id ? { last_model_run_id: restored.last_model_run_id } : {}),
      ...(restored?.last_model_operation_id ? { last_model_operation_id: restored.last_model_operation_id } : {}),
      ...(restored?.last_model_result_digest ? { last_model_result_digest: restored.last_model_result_digest } : {}),
      ...(restored?.last_tool_run_id ? { last_tool_run_id: restored.last_tool_run_id } : {}),
      ...(restored?.last_tool_operation_id ? { last_tool_operation_id: restored.last_tool_operation_id } : {}),
      ...(restored?.last_tool_call_id ? { last_tool_call_id: restored.last_tool_call_id } : {}),
      ...(restored?.last_tool_result_digest ? { last_tool_result_digest: restored.last_tool_result_digest } : {}),
      ...(restored?.last_hook_run_id ? { last_hook_run_id: restored.last_hook_run_id } : {}),
      ...(restored?.last_hook_operation_id ? { last_hook_operation_id: restored.last_hook_operation_id } : {}),
      ...(restored?.last_hook_result_digest ? { last_hook_result_digest: restored.last_hook_result_digest } : {}),
    })
    return checkpoint.checkpoint_digest
  }

  /**
   * Called only after the product Run ledger has recorded intent and the
   * app-server has accepted `turn/start`. Persisting before that point would
   * falsely make a no-effect, non-resumable thread look recoverable.
   */
  async checkpointAcceptedTurn(
    runId: string,
    turnId: string,
    operationId: string,
    attachmentInput?: { operation_id: string; result_digest: string },
    instructions?: CodexEngineRunInstructionSnapshot,
  ): Promise<string> {
    const thread = await this.ensureThread()
    if (!text(runId) || !text(turnId) || !/^effect_[a-f0-9-]{36}$/.test(operationId)) throw new Error('CODEX_ENGINE_TURN_BINDING_INVALID')
    if (attachmentInput && (!/^effect_[a-f0-9-]{36}$/.test(attachmentInput.operation_id) || !/^[a-f0-9]{64}$/.test(attachmentInput.result_digest))) {
      throw new Error('CODEX_ENGINE_ATTACHMENT_RECEIPT_INVALID')
    }
    if (!instructions || !validInstructionSnapshot(instructions)) throw new Error('CODEX_ENGINE_INSTRUCTION_SNAPSHOT_INVALID')
    const restored = await this.options.thread_store.load(this.options.binding)
    if (restored?.thread_id && restored.thread_id !== thread.thread_id) throw new Error('CODEX_ENGINE_THREAD_ID_MISMATCH')
    if (!restored?.tool_surface_digest || !this.dynamicToolSurface || restored.tool_surface_digest !== this.dynamicToolSurface.digest || restored.tool_surface_count !== this.dynamicToolSurface.tools.length) {
      throw new Error('CODEX_ENGINE_TOOL_SURFACE_MISSING')
    }
    const checkpoint = await this.options.thread_store.save(this.options.binding, {
      thread_id: thread.thread_id,
      source_revision: this.options.source_revision,
      tool_surface_digest: restored.tool_surface_digest,
      tool_surface_count: restored.tool_surface_count,
      last_run_id: runId,
      last_turn_id: turnId,
      last_turn_operation_id: operationId,
      last_instruction_run_id: runId,
      last_instruction_digest: instructions.digest,
      last_instruction_prompt: instructions.prompt,
      ...(attachmentInput ? {
        last_input_run_id: runId,
        last_input_operation_id: attachmentInput.operation_id,
        last_input_result_digest: attachmentInput.result_digest,
      } : {}),
    })
    return checkpoint.checkpoint_digest
  }

  /**
   * A user steer mutates an already-running source Turn. Its queue identity
   * and input digest must be written by BilliardBuddy before its operation
   * receipt may clear or the next source model request may proceed.
   */
  async checkpointSteerInput(
    runId: string,
    turnId: string,
    operationId: string,
    queueItemId: string,
    inputDigest: string,
  ): Promise<string> {
    const thread = await this.ensureThread()
    if (
      !text(runId)
      || !text(turnId)
      || !/^effect_[a-f0-9-]{36}$/.test(operationId)
      || !/^queue_[a-f0-9-]{36}$/.test(queueItemId)
      || !/^[a-f0-9]{64}$/.test(inputDigest)
    ) throw new Error('CODEX_ENGINE_STEER_RECEIPT_INVALID')
    const restored = await this.options.thread_store.load(this.options.binding)
    if (
      !restored?.thread_id
      || restored.thread_id !== thread.thread_id
      || restored.last_run_id !== runId
      || restored.last_turn_id !== turnId
      || !restored.tool_surface_digest
    ) throw new Error('CODEX_ENGINE_STEER_TURN_MISSING')
    const checkpoint = await this.options.thread_store.save(this.options.binding, {
      thread_id: thread.thread_id,
      source_revision: this.options.source_revision,
      tool_surface_digest: restored.tool_surface_digest,
      tool_surface_count: restored.tool_surface_count!,
      last_run_id: restored.last_run_id,
      last_turn_id: restored.last_turn_id,
      ...(restored.last_turn_operation_id ? { last_turn_operation_id: restored.last_turn_operation_id } : {}),
      ...instructionSnapshot(restored),
      ...inputReceipt(restored),
      last_steer_run_id: runId,
      last_steer_operation_id: operationId,
      last_steer_queue_item_id: queueItemId,
      last_steer_input_digest: inputDigest,
      ...(restored.last_model_run_id ? { last_model_run_id: restored.last_model_run_id } : {}),
      ...(restored.last_model_operation_id ? { last_model_operation_id: restored.last_model_operation_id } : {}),
      ...(restored.last_model_result_digest ? { last_model_result_digest: restored.last_model_result_digest } : {}),
      ...(restored.last_tool_run_id ? { last_tool_run_id: restored.last_tool_run_id } : {}),
      ...(restored.last_tool_operation_id ? { last_tool_operation_id: restored.last_tool_operation_id } : {}),
      ...(restored.last_tool_call_id ? { last_tool_call_id: restored.last_tool_call_id } : {}),
      ...(restored.last_tool_result_digest ? { last_tool_result_digest: restored.last_tool_result_digest } : {}),
      ...(restored.last_hook_run_id ? { last_hook_run_id: restored.last_hook_run_id } : {}),
      ...(restored.last_hook_operation_id ? { last_hook_operation_id: restored.last_hook_operation_id } : {}),
      ...(restored.last_hook_result_digest ? { last_hook_result_digest: restored.last_hook_result_digest } : {}),
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
      ...(restored.tool_surface_digest ? { tool_surface_digest: restored.tool_surface_digest, tool_surface_count: restored.tool_surface_count! } : {}),
      last_run_id: restored.last_run_id,
      last_turn_id: restored.last_turn_id,
      ...(restored.last_turn_operation_id ? { last_turn_operation_id: restored.last_turn_operation_id } : {}),
      ...instructionSnapshot(restored),
      ...inputReceipt(restored),
      ...steerReceipt(restored),
      last_model_run_id: runId,
      last_model_operation_id: operationId,
      last_model_result_digest: resultDigest,
      ...(restored.last_tool_run_id ? { last_tool_run_id: restored.last_tool_run_id } : {}),
      ...(restored.last_tool_operation_id ? { last_tool_operation_id: restored.last_tool_operation_id } : {}),
      ...(restored.last_tool_call_id ? { last_tool_call_id: restored.last_tool_call_id } : {}),
      ...(restored.last_tool_result_digest ? { last_tool_result_digest: restored.last_tool_result_digest } : {}),
      ...(restored.last_hook_run_id ? { last_hook_run_id: restored.last_hook_run_id } : {}),
      ...(restored.last_hook_operation_id ? { last_hook_operation_id: restored.last_hook_operation_id } : {}),
      ...(restored.last_hook_result_digest ? { last_hook_result_digest: restored.last_hook_result_digest } : {}),
    })
    return checkpoint.checkpoint_digest
  }

  async checkpointToolResult(runId: string, operationId: string, callId: string, resultDigest: string): Promise<string> {
    const thread = await this.ensureThread()
    if (!text(runId) || !/^effect_[a-f0-9-]{36}$/.test(operationId) || !text(callId) || !/^[a-f0-9]{64}$/.test(resultDigest)) {
      throw new Error('CODEX_ENGINE_TOOL_RECEIPT_INVALID')
    }
    const restored = await this.options.thread_store.load(this.options.binding)
    if (!restored?.thread_id || restored.thread_id !== thread.thread_id || restored.last_run_id !== runId || !restored.last_turn_id || !restored.tool_surface_digest) {
      throw new Error('CODEX_ENGINE_TOOL_RECEIPT_TURN_MISSING')
    }
    const checkpoint = await this.options.thread_store.save(this.options.binding, {
      thread_id: thread.thread_id,
      source_revision: this.options.source_revision,
      tool_surface_digest: restored.tool_surface_digest,
      tool_surface_count: restored.tool_surface_count!,
      last_run_id: restored.last_run_id,
      last_turn_id: restored.last_turn_id,
      ...(restored.last_turn_operation_id ? { last_turn_operation_id: restored.last_turn_operation_id } : {}),
      ...instructionSnapshot(restored),
      ...inputReceipt(restored),
      ...steerReceipt(restored),
      ...(restored.last_model_run_id ? { last_model_run_id: restored.last_model_run_id } : {}),
      ...(restored.last_model_operation_id ? { last_model_operation_id: restored.last_model_operation_id } : {}),
      ...(restored.last_model_result_digest ? { last_model_result_digest: restored.last_model_result_digest } : {}),
      last_tool_run_id: runId,
      last_tool_operation_id: operationId,
      last_tool_call_id: callId,
      last_tool_result_digest: resultDigest,
      ...(restored.last_hook_run_id ? { last_hook_run_id: restored.last_hook_run_id } : {}),
      ...(restored.last_hook_operation_id ? { last_hook_operation_id: restored.last_hook_operation_id } : {}),
      ...(restored.last_hook_result_digest ? { last_hook_result_digest: restored.last_hook_result_digest } : {}),
    })
    return checkpoint.checkpoint_digest
  }

  async checkpointHookResult(runId: string, operationId: string, resultDigest: string): Promise<string> {
    const thread = await this.ensureThread()
    if (!text(runId) || !/^effect_[a-f0-9-]{36}$/.test(operationId) || !/^[a-f0-9]{64}$/.test(resultDigest)) {
      throw new Error('CODEX_ENGINE_HOOK_RECEIPT_INVALID')
    }
    const restored = await this.options.thread_store.load(this.options.binding)
    if (!restored?.thread_id || restored.thread_id !== thread.thread_id || restored.last_run_id !== runId || !restored.last_turn_id || !restored.tool_surface_digest) {
      throw new Error('CODEX_ENGINE_HOOK_RECEIPT_TURN_MISSING')
    }
    const checkpoint = await this.options.thread_store.save(this.options.binding, {
      thread_id: thread.thread_id,
      source_revision: this.options.source_revision,
      tool_surface_digest: restored.tool_surface_digest,
      tool_surface_count: restored.tool_surface_count!,
      last_run_id: restored.last_run_id,
      last_turn_id: restored.last_turn_id,
      ...(restored.last_turn_operation_id ? { last_turn_operation_id: restored.last_turn_operation_id } : {}),
      ...instructionSnapshot(restored),
      ...inputReceipt(restored),
      ...steerReceipt(restored),
      ...(restored.last_model_run_id ? { last_model_run_id: restored.last_model_run_id } : {}),
      ...(restored.last_model_operation_id ? { last_model_operation_id: restored.last_model_operation_id } : {}),
      ...(restored.last_model_result_digest ? { last_model_result_digest: restored.last_model_result_digest } : {}),
      ...(restored.last_tool_run_id ? { last_tool_run_id: restored.last_tool_run_id } : {}),
      ...(restored.last_tool_operation_id ? { last_tool_operation_id: restored.last_tool_operation_id } : {}),
      ...(restored.last_tool_call_id ? { last_tool_call_id: restored.last_tool_call_id } : {}),
      ...(restored.last_tool_result_digest ? { last_tool_result_digest: restored.last_tool_result_digest } : {}),
      last_hook_run_id: runId,
      last_hook_operation_id: operationId,
      last_hook_result_digest: resultDigest,
    })
    return checkpoint.checkpoint_digest
  }

  private async start(workDir: string): Promise<CodexEngineThread> {
    if (!this.dynamicToolSurface) throw new Error('CODEX_ENGINE_TOOL_SURFACE_MISSING')
    const response = await this.options.client.request<JsonObject>('thread/start', {
      cwd: workDir,
      model: this.options.model,
      personality: 'none',
      serviceName: 'billiardbuddy',
      // Thread-scoped config is required because App Server takes a snapshot
      // at `thread/start`; the process-level override alone is not a durable
      // Thread capability declaration.
      config: { host_managed_tools_only: true, features: { token_budget: false } },
      // Defense in depth: an embedded engine gets no upstream environment.
      // The host-managed source patch separately removes all built-in tools.
      environments: [],
      dynamicTools: this.dynamicToolSurface.tools.map(tool => ({
        type: 'function' as const,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema as JsonObject,
      })),
    })
    const id = threadId(response)
    return { thread_id: id, restored: false }
  }

  private async resume(state: CodexEngineThreadState, workDir: string): Promise<CodexEngineThread> {
    if (!state.thread_id || state.source_revision !== this.options.source_revision) throw new Error('CODEX_ENGINE_THREAD_SOURCE_MISMATCH')
    if (!this.dynamicToolSurface || state.tool_surface_digest !== this.dynamicToolSurface.digest || state.tool_surface_count !== this.dynamicToolSurface.tools.length) {
      throw new Error('CODEX_ENGINE_TOOL_SURFACE_MISMATCH')
    }
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
      tool_surface_digest: state.tool_surface_digest,
      tool_surface_count: state.tool_surface_count!,
      ...(state.last_run_id ? { last_run_id: state.last_run_id } : {}),
      ...(state.last_turn_id ? { last_turn_id: state.last_turn_id } : {}),
      ...(state.last_turn_operation_id ? { last_turn_operation_id: state.last_turn_operation_id } : {}),
      ...instructionSnapshot(state),
      ...inputReceipt(state),
      ...steerReceipt(state),
      ...(state.last_model_run_id ? { last_model_run_id: state.last_model_run_id } : {}),
      ...(state.last_model_operation_id ? { last_model_operation_id: state.last_model_operation_id } : {}),
      ...(state.last_model_result_digest ? { last_model_result_digest: state.last_model_result_digest } : {}),
      ...(state.last_tool_run_id ? { last_tool_run_id: state.last_tool_run_id } : {}),
      ...(state.last_tool_operation_id ? { last_tool_operation_id: state.last_tool_operation_id } : {}),
      ...(state.last_tool_call_id ? { last_tool_call_id: state.last_tool_call_id } : {}),
      ...(state.last_tool_result_digest ? { last_tool_result_digest: state.last_tool_result_digest } : {}),
      ...(state.last_hook_run_id ? { last_hook_run_id: state.last_hook_run_id } : {}),
      ...(state.last_hook_operation_id ? { last_hook_operation_id: state.last_hook_operation_id } : {}),
      ...(state.last_hook_result_digest ? { last_hook_result_digest: state.last_hook_result_digest } : {}),
    })
    return { thread_id: id, restored: true }
  }
}

function isToolSurface(value: CodexEngineDynamicToolSurface): boolean {
  return /^[a-f0-9]{64}$/.test(value.digest)
    && value.tools.length <= 256
    && value.tools.every(tool => /^[A-Za-z0-9_-]{1,128}$/.test(tool.name)
      && typeof tool.description === 'string' && tool.description.length <= 4_000
      && tool.input_schema && typeof tool.input_schema === 'object' && !Array.isArray(tool.input_schema))
}
