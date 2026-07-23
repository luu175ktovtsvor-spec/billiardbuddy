/** Internal framed worker entrypoint. Bootstrap arrives only over Bun private IPC. */
import { createInterface } from 'node:readline'
import { AgentWorkerProtocol } from '../server/agent-worker/framedProtocol.js'
import { AgentWorkerService, type AgentWorkerBootstrap, type AgentWorkerCore } from '../server/product/agentWorkerService.js'
import type { AgentWorkerOutbound } from '../../shared/product/agentWorker.js'

type CoreRequest = { type: 'core_request'; id: string; operation: 'start' | 'input' | 'approval' | 'stop' | 'shutdown'; value?: unknown }
let sequence = 0; const pending = new Map<string, { resolve(): void; reject(): void }>()
function request(operation: CoreRequest['operation'], value?: unknown): Promise<void> {
  const id = `core_${++sequence}`
  process.send?.({ type: 'core_request', id, operation, value } satisfies CoreRequest)
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
const core: AgentWorkerCore = { input: text => request('input', text), approve: (requestId, approved) => request('approval', { requestId, approved }), stop: () => request('stop'), shutdown: () => request('shutdown') }
let protocol: AgentWorkerProtocol | undefined
function emit(message: unknown): void { process.stdout.write(`${JSON.stringify(message)}\n`); process.send?.({ type: 'worker_outbound', message }) }
process.on('message', (message: unknown) => {
  const record = message && typeof message === 'object' ? message as Record<string, unknown> : undefined
  if (record?.type === 'bootstrap' && record.bootstrap && !protocol) {
    const bootstrap = record.bootstrap as AgentWorkerBootstrap
    const service = new AgentWorkerService({ ...bootstrap, cores: { start: async input => { await request('start', input); return core } } })
    protocol = new AgentWorkerProtocol(service, emit); protocol.announce(); return
  }
  if (record?.type === 'core_result' && typeof record.id === 'string') {
    const pendingRequest = pending.get(record.id); if (!pendingRequest) return; pending.delete(record.id); record.ok === true ? pendingRequest.resolve() : pendingRequest.reject(new Error('CORE_PORT_DENIED'))
    return
  }
  if (record?.type === 'core_message' && protocol) {
    protocol.relayCoreMessage(record.message as AgentWorkerOutbound)
  }
})
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => protocol ? protocol.receive(line) : emit({ type: 'fatal', code: 'ENVELOPE_DENIED' }))
