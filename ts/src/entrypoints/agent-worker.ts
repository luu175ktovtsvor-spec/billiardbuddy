/** Internal framed worker entrypoint.  BB-03E supplies the supervisor wiring. */
import { createInterface } from 'node:readline'
import { AgentWorkerProtocol } from '../server/agent-worker/framedProtocol.js'
import { AgentWorkerService } from '../server/product/agentWorkerService.js'

const unavailable = new AgentWorkerService(
  { readTaskRunDispatchIdentity: async () => { throw new Error('WORKER_SUPERVISOR_REQUIRED') }, claimTaskRunDispatch: async () => ({ outcome: 'recovery_required' as const, task_id: '' }) },
  { start: async () => { throw new Error('WORKER_SUPERVISOR_REQUIRED') } },
)
const protocol = new AgentWorkerProtocol(unavailable, message => process.stdout.write(`${JSON.stringify(message)}\n`))
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => protocol.receive(line))
