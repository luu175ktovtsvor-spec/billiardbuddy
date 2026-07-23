import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export type EscalatedActionReceipt = { nonce: string; action: 'filesystem.write.external'; target: string; parameters_digest: string; fencing_token: number; expires_at: string }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Single-use broker for module-08 receipts; legacy workers never receive one. */
export class EscalatedActionBroker {
  private readonly receipts = new Map<string, EscalatedActionReceipt>()
  constructor(private readonly now: () => Date = () => new Date()) {}
  issue(input: Omit<EscalatedActionReceipt, 'nonce' | 'parameters_digest'> & { parameters: unknown }): EscalatedActionReceipt {
    const receipt = { nonce: randomUUID(), action: input.action, target: path.resolve(input.target), parameters_digest: hash(input.parameters), fencing_token: input.fencing_token, expires_at: input.expires_at }
    this.receipts.set(receipt.nonce, receipt); return receipt
  }
  async writeExternal(receipt: EscalatedActionReceipt, parameters: { content: string }, fencingToken: number): Promise<void> {
    const stored = this.receipts.get(receipt.nonce)
    if (!stored || Date.parse(stored.expires_at) <= this.now().getTime() || stored.fencing_token !== fencingToken || stored.action !== receipt.action || !timingSafeEqual(Buffer.from(stored.parameters_digest), Buffer.from(hash(parameters))) || path.resolve(receipt.target) !== stored.target) throw new Error('ESCALATION_DENIED')
    // Resolve the parent at execution time so a symlink cannot redirect the
    // frozen basename after approval.
    const parent = await fs.realpath(path.dirname(stored.target)); const target = path.join(parent, path.basename(stored.target))
    this.receipts.delete(receipt.nonce)
    await fs.writeFile(target, parameters.content, { flag: 'wx' })
  }
}
