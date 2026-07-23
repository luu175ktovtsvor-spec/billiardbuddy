import { AGENT_WORKER_MAX_FRAME_BYTES, AGENT_WORKER_PROTOCOL_VERSION, intersectsAgentWorkerVersions, type AgentWorkerInbound, type AgentWorkerOutbound } from '../../../shared/product/agentWorker.js'
import { AgentWorkerService } from '../product/agentWorkerService.js'

export class AgentWorkerProtocol {
  private hello = false
  private ready = false
  constructor(private readonly service: AgentWorkerService, private readonly emit: (message: AgentWorkerOutbound) => void) {}
  receive(frame: string): void {
    if (Buffer.byteLength(frame) > AGENT_WORKER_MAX_FRAME_BYTES) return this.emit({ type: 'fatal', code: 'FRAME_TOO_LARGE' })
    let message: unknown
    try { message = JSON.parse(frame) } catch { return this.emit({ type: 'fatal', code: 'FRAME_INVALID' }) }
    if (!validInbound(message)) return this.emit({ type: 'fatal', code: 'PROTOCOL_INVALID' })
    void this.handle(message).catch(() => this.emit({ type: 'fatal', code: 'CORE_FAILED' }))
  }
  private async handle(message: AgentWorkerInbound): Promise<void> {
    if (!message || typeof message !== 'object' || !('type' in message)) return this.emit({ type: 'fatal', code: 'PROTOCOL_INVALID' })
    if (message.type === 'hello') { if (!intersectsAgentWorkerVersions(message.versions, { min: AGENT_WORKER_PROTOCOL_VERSION, max: AGENT_WORKER_PROTOCOL_VERSION })) return this.emit({ type: 'fatal', code: 'CAPABILITY_MISMATCH' }); this.hello = true; return this.emit({ type: 'hello', versions: { min: AGENT_WORKER_PROTOCOL_VERSION, max: AGENT_WORKER_PROTOCOL_VERSION }, capabilities: ['framed', 'permission-envelope'] }) }
    if (message.type === 'ready') { if (!this.hello) return this.emit({ type: 'fatal', code: 'NOT_READY' }); this.ready = true; return this.emit({ type: 'ready' }) }
    if (!this.ready) return this.emit({ type: 'fatal', code: 'NOT_READY' })
    if (message.type === 'start') return this.emit(await this.service.start(message))
    if (message.type === 'input') { const result = await this.service.input(message.text); if (result) this.emit(result); return }
    if (message.type === 'approval_response') { const result = await this.service.approval(message.request_id, message.approved); if (result) this.emit(result); return }
    if (message.type === 'stop') return this.emit(await this.service.stop())
    if (message.type === 'shutdown') { await this.service.shutdown(); return this.emit({ type: 'shutdown' }) }
    this.emit({ type: 'fatal', code: 'PROTOCOL_INVALID' })
  }
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => key in value) }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function validInbound(value: unknown): value is AgentWorkerInbound {
  if (!record(value) || typeof value.type !== 'string') return false
  if (value.type === 'hello') return exact(value, ['type', 'versions', 'capabilities']) && record(value.versions) && exact(value.versions, ['min', 'max']) && Number.isInteger(value.versions.min) && Number.isInteger(value.versions.max) && Array.isArray(value.capabilities) && value.capabilities.every(capability => typeof capability === 'string')
  if (value.type === 'ready' || value.type === 'stop' || value.type === 'shutdown') return exact(value, ['type'])
  if (value.type === 'input') return exact(value, ['type', 'text']) && typeof value.text === 'string'
  if (value.type === 'approval_response') return exact(value, ['type', 'request_id', 'approved']) && typeof value.request_id === 'string' && typeof value.approved === 'boolean'
  if (value.type === 'start') return exact(value, ['type', 'run_id', 'dispatch_generation', 'scheduler_receipt', 'envelope']) && typeof value.run_id === 'string' && Number.isInteger(value.dispatch_generation) && value.dispatch_generation > 0 && record(value.scheduler_receipt) && record(value.envelope)
  return false
}
