import { expect, test } from 'bun:test'
import { AgentWorkerService, type AgentWorkerCoreFactory } from './agentWorkerService.js'
import { createAgentWorkerChildStartCapability, createLegacyDeferredEnvelope } from './permissionExecutionEnvelope.js'
import { createProductAgentHarness } from '../agent-worker/productAgentHarness.js'
import { runProductAgentLoop } from '../agent-worker/productAgentLoop.js'
import { emptyProductToolPermissionContext, type ProductToolContext, type ProductTools } from '../agent-worker/productTool.js'
import { z } from 'zod/v4'
import { classifyProductTaskRunFailure } from './taskRunFailure.js'

const receipt = { job_id: 'agent-worker:run:1', outcome: 'admitted' as const, profile_revision: 'p', resource_keys: ['agent.worker'] as const, fencing_token: 1, lease: { owner_id: 'owner', process_id: 'p', process_generation: 'g', fencing_token: 1, expires_at: '2027-01-01T00:00:00.000Z' } }

function bootstrap(cores: AgentWorkerCoreFactory, overrides: Partial<{ run_id: string; dispatch_generation: number; fencing_token: number; envelope_digest: string }> = {}) {
  const envelope = createLegacyDeferredEnvelope(); const key = Buffer.alloc(32, 7)
  const value = { run_id: 'run', dispatch_generation: 1, fencing_token: 1, envelope_digest: envelope.digest, ...overrides }
  return { capability: createAgentWorkerChildStartCapability(value, key), capability_key: key, cores, envelope }
}

function productToolContext(tools: ProductTools, messages: any[]): ProductToolContext {
  return {
    options: { commands: [], mainLoopModel: 'deepseek-v4-flash', tools, thinkingConfig: { type: 'adaptive' } },
    abortController: new AbortController(),
    permissionContext: emptyProductToolPermissionContext(),
    messages,
  }
}

test('run failure classifier exposes only stable product categories', () => {
  for (const [internal, expected] of [
    ['PRODUCT_GATEWAY_NOT_CONFIGURED', { code: 'task_model_configuration', retryable: false }],
    ['PRODUCT_GATEWAY_HTTP_401', { code: 'task_authentication', retryable: false }],
    ['PRODUCT_GATEWAY_HTTP_429', { code: 'task_capacity_limited', retryable: true }],
    ['PRODUCT_GATEWAY_HTTP_503', { code: 'task_model_unavailable', retryable: true }],
    ['PRODUCT_GATEWAY_UNREACHABLE', { code: 'task_network_unavailable', retryable: true }],
    ['CONTEXT_COMPACTION_FAILED', { code: 'task_context_limit', retryable: false }],
    ['PRODUCT_MODEL_INVALID_STREAM', { code: 'task_model_response_invalid', retryable: true }],
    ['PRODUCT_HOOK_PERMISSION_ENVELOPE_MISSING', { code: 'task_project_automation_failed', retryable: false }],
    ['CHAT_VIDEO_PROBE_FAILED', { code: 'task_attachment_processing_failed', retryable: false }],
    ['PRODUCT_SHELL_SANDBOX_UNAVAILABLE', { code: 'task_execution_environment_failed', retryable: false }],
    ['/private/workspace/secret YOUR_API_KEY', { code: 'task_failed', retryable: false }],
  ] as const) expect(classifyProductTaskRunFailure(new Error(internal))).toEqual(expected)
})

test('worker consumes one supervisor-issued capability and never claims or replays input', async () => {
  const calls: string[] = []; const prepared = bootstrap({ start: async () => ({ input: async text => { calls.push(`input:${text}`) }, approve: async () => {}, stop: async () => {}, shutdown: async () => {} }) })
  const service = new AgentWorkerService(prepared)
  expect(await service.start({ type: 'start', run_id: 'run', dispatch_generation: 1, scheduler_receipt: receipt, envelope: prepared.envelope })).toMatchObject({ type: 'claim_receipt', outcome: 'claimed' })
  expect(await service.input('user turn')).toBeUndefined(); expect(calls).toEqual(['input:user turn'])
  expect(await service.start({ type: 'start', run_id: 'run', dispatch_generation: 1, scheduler_receipt: receipt, envelope: prepared.envelope })).toMatchObject({ type: 'fatal', code: 'ENVELOPE_DENIED' })
  expect(service.relayCoreMessage({ type: 'terminal', state: 'recovery_required', run_id: 'run' } as never)).toBeUndefined()
  expect(service.relayCoreMessage({ type: 'terminal', state: 'recovery_required', run_id: 'run', failure: { code: 'task_network_unavailable', retryable: false } } as never)).toBeUndefined()
})

test('worker acknowledges a steer only after the private Core consumes it', async () => {
  const calls: unknown[] = []
  const waitingId = 'queue_123e4567-e89b-42d3-a456-426614174000'
  const consumedId = 'queue_123e4567-e89b-42d3-a456-426614174001'
  const prepared = bootstrap({ start: async () => ({
    input: async (text, _attachments, queueItemId) => {
      calls.push([text, queueItemId])
      return queueItemId === consumedId
    },
    approve: async () => {},
    stop: async () => {},
    shutdown: async () => {},
  }) })
  const service = new AgentWorkerService(prepared)
  await service.start({ type: 'start', run_id: 'run', dispatch_generation: 1, scheduler_receipt: receipt, envelope: prepared.envelope })
  await service.input('initial')
  expect(await service.steer(waitingId, 'not safe yet')).toBeUndefined()
  expect(await service.steer(consumedId, 'safe now')).toEqual({ type: 'steer_consumed', queue_item_id: consumedId })
  expect(calls).toEqual([['initial', undefined], ['not safe yet', waitingId], ['safe now', consumedId]])
})

test('parallel private Core ports never share their steer queues', async () => {
  const queryOptions: any[] = []
  const releases: Array<() => void> = []
  const query = ((options: any) => (async function* () {
    queryOptions.push(options)
    await new Promise<void>((resolve) => { releases.push(resolve) })
    yield { type: 'result', subtype: 'success', is_error: false, result: 'done' }
  })()) as any
  const makePort = (run_id: string) => createProductAgentHarness({
    run_id,
    session_id: `session-${run_id}`,
    work_dir: process.cwd(),
    permission_envelope: createLegacyDeferredEnvelope(),
    query,
    load_commands: async () => [],
    load_tools: () => [],
  })
  const [left, right] = await Promise.all([makePort('left'), makePort('right')])
  const leftRun = left.input('left initial')
  const rightRun = right.input('right initial')
  while (queryOptions.length < 2) await Bun.sleep(0)
  const leftId = 'queue_123e4567-e89b-42d3-a456-426614174010'
  const rightId = 'queue_123e4567-e89b-42d3-a456-426614174011'
  const leftSteer = left.input('left follow-up', [], leftId)
  const rightSteer = right.input('right follow-up', [], rightId)

  const leftOptions = queryOptions.find(options => options.prompt === 'left initial')
  const rightOptions = queryOptions.find(options => options.prompt === 'right initial')
  expect(leftOptions.commandQueue.snapshot()).toEqual([expect.objectContaining({ uuid: leftId, value: 'left follow-up' })])
  expect(rightOptions.commandQueue.snapshot()).toEqual([expect.objectContaining({ uuid: rightId, value: 'right follow-up' })])
  leftOptions.commandQueue.consume(leftOptions.commandQueue.snapshot())
  expect(await leftSteer).toBeTrue()
  let rightResolved = false
  void rightSteer.then(() => { rightResolved = true })
  await Bun.sleep(0)
  expect(rightResolved).toBeFalse()
  rightOptions.commandQueue.consume(rightOptions.commandQueue.snapshot())
  expect(await rightSteer).toBeTrue()
  for (const release of releases) release()
  await Promise.all([leftRun, rightRun])
})

test('product Harness drives the low-level model-tool loop without QueryEngine', async () => {
  const persisted: unknown[][] = []
  const runModel = (() => (async function* () {
    yield {
      type: 'assistant',
      uuid: 'assistant-1',
      timestamp: new Date(0).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '已完成。' }],
        model: 'deepseek-v4-flash',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }
  })()) as any
  const messages: any[] = []
  const toolUseContext = productToolContext([], messages)
  const events = []
  for await (const event of runProductAgentLoop({
    commands: [],
    prompt: '完成门店日报',
    tools: [],
    toolUseContext,
    canUseTool: async (_tool, toolInput) => ({ behavior: 'allow', updatedInput: toolInput, decisionReason: { type: 'mode', mode: 'default' } }),
    mutableMessages: messages,
    onMessageState: async messages => { persisted.push([...messages]) },
    promptContext: { workspace: '/workspace/example', date: '2026-07-26' },
    runModel,
  })) events.push(event)

  expect(events.at(-1)).toEqual({ type: 'result', subtype: 'success', is_error: false, result: '已完成。' })
  expect(persisted.at(-1)?.map(message => (message as { type: string }).type)).toEqual(['user', 'assistant'])
})

test('product Harness feeds a real tool result into the next model sample', async () => {
  const messages: any[] = []
  const samples: any[][] = []
  const tool = {
    name: 'ProductProbe',
    inputSchema: z.object({ value: z.string() }),
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    isReadOnly: () => true,
    checkPermissions: async () => ({ behavior: 'allow', updatedInput: { value: 'verified' }, decisionReason: { type: 'mode', mode: 'default' } }),
    call: async (input: { value: string }) => ({ data: `evidence:${input.value}` }),
    mapToolResultToToolResultBlockParam: (data: string, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: data }),
    toAutoClassifierInput: () => '',
  } as any
  const runModel = ((input: { messages: any[] }) => (async function* () {
    samples.push(input.messages)
    if (samples.length === 1) {
      yield {
        type: 'assistant',
        uuid: 'assistant-tool',
        timestamp: new Date(0).toISOString(),
        message: {
          id: 'response-tool',
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'tool-use-1', name: 'ProductProbe', arguments: { value: 'verified' } }],
          model: 'deepseek-v4-flash',
          stop_reason: 'tool_call',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }
      return
    }
    yield {
      type: 'assistant',
      uuid: 'assistant-final',
      timestamp: new Date(0).toISOString(),
      message: {
        id: 'response-final',
        role: 'assistant',
        content: [{ type: 'text', text: '证据已验证。' }],
        model: 'deepseek-v4-flash',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }
  })()) as any
  const toolUseContext = productToolContext([tool], messages)
  const events: any[] = []
  for await (const event of runProductAgentLoop({
    commands: [],
    prompt: '验证工具闭环',
    tools: [tool],
    toolUseContext,
    canUseTool: async (_tool, toolInput) => ({ behavior: 'allow', updatedInput: toolInput, decisionReason: { type: 'mode', mode: 'default' } }),
    mutableMessages: messages,
    promptContext: { workspace: '/workspace/example', date: '2026-07-26' },
    runModel,
  })) events.push(event)

  expect(samples).toHaveLength(2)
  expect(samples[1]).toContainEqual(expect.objectContaining({
    type: 'user',
    message: expect.objectContaining({
      content: expect.arrayContaining([expect.objectContaining({ type: 'tool_result', tool_call_id: 'tool-use-1', content: 'evidence:verified' })]),
    }),
  }))
  expect(events.at(-1)).toEqual({ type: 'result', subtype: 'success', is_error: false, result: '证据已验证。' })
})

test('an explicit named Agent command executes its exact tool before model synthesis', async () => {
  const messages: any[] = []
  const toolCalls: string[] = []
  const samples: any[][] = []
  const tool = {
    name: 'agent__project__reviewer',
    inputSchema: z.object({ prompt: z.string().min(1) }),
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    isReadOnly: () => false,
    checkPermissions: async (input: { prompt: string }) => ({ behavior: 'allow', updatedInput: input, reason: 'test' }),
    call: async (input: { prompt: string }) => { toolCalls.push(input.prompt); return { data: '子 Agent 已检查代码。' } },
    mapToolResultToToolResultBlockParam: (data: string, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: data }),
    toAutoClassifierInput: () => '',
  } as any
  const command = {
    type: 'prompt' as const,
    name: 'agent:agent__project__reviewer',
    description: 'Run reviewer',
    userInvocable: true,
    source: 'project' as const,
    contentLength: 0,
    progressMessage: 'Starting reviewer',
    directTool: { name: tool.name, argument: 'prompt' },
    getPromptForCommand: async (args: string) => [{ type: 'text' as const, text: `Assigned to reviewer:\n${args}` }],
  }
  const runModel = ((input: { messages: any[] }) => (async function* () {
    samples.push(input.messages)
    yield {
      type: 'assistant',
      uuid: 'assistant-final',
      timestamp: new Date(0).toISOString(),
      message: {
        id: 'response-final',
        role: 'assistant',
        content: [{ type: 'text', text: '审查结果已经汇总。' }],
        model: 'deepseek-v4-flash',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }
  })()) as any
  const toolUseContext = productToolContext([tool], messages)
  toolUseContext.options.commands = [command]
  const events: any[] = []
  for await (const event of runProductAgentLoop({
    commands: [command],
    prompt: '/agent:agent__project__reviewer inspect auth.ts',
    tools: [tool],
    toolUseContext,
    canUseTool: async (_tool, toolInput) => ({ behavior: 'allow', updatedInput: toolInput, reason: 'test' }),
    mutableMessages: messages,
    promptContext: { workspace: '/workspace/example', date: '2026-07-27' },
    runModel,
  })) events.push(event)

  expect(toolCalls).toEqual(['inspect auth.ts'])
  expect(samples).toHaveLength(1)
  expect(samples[0]).toContainEqual(expect.objectContaining({
    type: 'user',
    message: expect.objectContaining({
      content: expect.arrayContaining([expect.objectContaining({ content: '子 Agent 已检查代码。' })]),
    }),
  }))
  expect(events.at(-1)).toEqual({ type: 'result', subtype: 'success', is_error: false, result: '审查结果已经汇总。' })
})

test('product Harness never executes tool calls from a token-truncated model response', async () => {
  let toolCalls = 0
  const samples: any[][] = []
  const tool = {
    name: 'TruncatedProbe',
    inputSchema: z.object({ value: z.string() }),
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    isReadOnly: () => false,
    checkPermissions: async () => ({ behavior: 'allow', updatedInput: { value: 'looks-complete' }, decisionReason: { type: 'mode', mode: 'default' } }),
    call: async () => { toolCalls += 1; return { data: 'must-not-run' } },
    mapToolResultToToolResultBlockParam: (data: string, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: data }),
    toAutoClassifierInput: () => '',
  } as any
  const runModel = ((input: { messages: any[] }) => (async function* () {
    samples.push(input.messages)
    yield samples.length === 1
      ? {
          type: 'assistant', uuid: 'assistant-truncated', timestamp: new Date(0).toISOString(),
          message: { id: 'response-truncated', role: 'assistant', content: [{ type: 'tool_call', id: 'truncated-tool', name: 'TruncatedProbe', arguments: { value: 'looks-complete' } }], model: 'deepseek-v4-flash', stop_reason: 'length', usage: { input_tokens: 1, output_tokens: 16_384 } },
        }
      : {
          type: 'assistant', uuid: 'assistant-recovered', timestamp: new Date(0).toISOString(),
          message: { id: 'response-recovered', role: 'assistant', content: [{ type: 'text', text: '已用完整参数重新规划。' }], model: 'deepseek-v4-flash', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
        }
  })()) as any
  const messages: any[] = []
  const toolUseContext = productToolContext([tool], messages)

  for await (const _event of runProductAgentLoop({
    commands: [], prompt: '不要执行截断调用', tools: [tool], toolUseContext,
    canUseTool: async (_tool, toolInput) => ({ behavior: 'allow', updatedInput: toolInput, decisionReason: { type: 'mode', mode: 'default' } }),
    mutableMessages: messages,
    promptContext: { workspace: '/workspace/example', date: '2026-07-26' },
    runModel,
  })) { /* consume */ }

  expect(toolCalls).toBe(0)
  expect(samples).toHaveLength(2)
  expect(samples[1]).toContainEqual(expect.objectContaining({
    message: expect.objectContaining({ content: expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_result',
        tool_call_id: 'truncated-tool',
        is_error: true,
        content: expect.stringContaining('was not executed'),
      }),
    ]) }),
  }))
})

test('product Harness runs PreToolUse before Host execution and returns a structured denial to the model', async () => {
  let toolCalls = 0
  const samples: any[][] = []
  const tool = {
    name: 'DangerousProbe',
    inputSchema: z.object({ value: z.string() }),
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    isReadOnly: () => false,
    call: async () => { toolCalls += 1; return { data: 'must-not-run' } },
    mapToolResultToToolResultBlockParam: (data: string, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: data }),
    toAutoClassifierInput: () => '',
  } as any
  const runModel = ((input: { messages: any[] }) => (async function* () {
    samples.push(input.messages)
    yield samples.length === 1
      ? {
          type: 'assistant', uuid: 'assistant-tool', timestamp: new Date(0).toISOString(),
          message: { id: 'response-tool', role: 'assistant', content: [{ type: 'tool_call', id: 'blocked-tool', name: 'DangerousProbe', arguments: { value: 'x' } }], model: 'deepseek-v4-flash', stop_reason: 'tool_call', usage: { input_tokens: 1, output_tokens: 1 } },
        }
      : {
          type: 'assistant', uuid: 'assistant-final', timestamp: new Date(0).toISOString(),
          message: { id: 'response-final', role: 'assistant', content: [{ type: 'text', text: '已遵守项目规则。' }], model: 'deepseek-v4-flash', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
        }
  })()) as any
  const messages: any[] = []
  const toolUseContext = productToolContext([tool], messages)

  for await (const _event of runProductAgentLoop({
    commands: [], prompt: '运行受控工具', tools: [tool], toolUseContext,
    canUseTool: async (_tool, toolInput) => ({ behavior: 'allow', updatedInput: toolInput, decisionReason: { type: 'mode', mode: 'default' } }),
    mutableMessages: messages,
    promptContext: { workspace: '/workspace/example', date: '2026-07-26' },
    runModel,
    toolHooks: {
      before: async () => ({ blocked: true, reason: 'policy denied' }),
      after: async () => { throw new Error('PostToolUse must not run when execution was blocked') },
    },
  })) { /* consume */ }

  expect(toolCalls).toBe(0)
  expect(samples[1]).toContainEqual(expect.objectContaining({
    message: expect.objectContaining({ content: expect.arrayContaining([
      expect.objectContaining({ type: 'tool_result', tool_call_id: 'blocked-tool', is_error: true, content: expect.stringContaining('policy denied') }),
    ]) }),
  }))
})

test('worker rejects forged, cross-run, and expired receipt bootstrap before Core start', async () => {
  let starts = 0; const cores = { start: async () => { starts++; throw new Error('must not start') } }; const prepared = bootstrap(cores)
  const service = new AgentWorkerService(prepared, () => new Date('2026-01-01T00:00:00.000Z'))
  for (const bad of [
    { type: 'start' as const, run_id: 'other', dispatch_generation: 1, scheduler_receipt: { ...receipt, job_id: 'agent-worker:other:1' }, envelope: prepared.envelope },
    { type: 'start' as const, run_id: 'run', dispatch_generation: 2, scheduler_receipt: { ...receipt, job_id: 'agent-worker:run:2' }, envelope: prepared.envelope },
    { type: 'start' as const, run_id: 'run', dispatch_generation: 1, scheduler_receipt: { ...receipt, lease: { ...receipt.lease, expires_at: '2025-01-01T00:00:00.000Z' } }, envelope: prepared.envelope },
    { type: 'start' as const, run_id: 'run', dispatch_generation: 1, scheduler_receipt: receipt, envelope: { ...prepared.envelope, network_scope: 'unrestricted' as const } },
  ]) expect(await service.start(bad)).toMatchObject({ type: 'fatal' })
  expect(starts).toBe(0)
})

test('tampered capability cannot start a private Core', async () => {
  let starts = 0; const prepared = bootstrap({ start: async () => { starts++; throw new Error('must not start') } }); prepared.capability.signature = '0'.repeat(64)
  const service = new AgentWorkerService(prepared)
  expect(await service.start({ type: 'start', run_id: 'run', dispatch_generation: 1, scheduler_receipt: receipt, envelope: prepared.envelope })).toMatchObject({ type: 'fatal', code: 'ENVELOPE_DENIED' }); expect(starts).toBe(0)
})
