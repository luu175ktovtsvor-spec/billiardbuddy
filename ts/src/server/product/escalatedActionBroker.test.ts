import { expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { EscalatedActionBroker } from './escalatedActionBroker.js'

test('broker is single-use and fences changed parameters, target, expiry, and old owner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'broker-')); const target = path.join(root, 'out.txt'); let now = new Date('2026-01-01T00:00:00.000Z'); const broker = new EscalatedActionBroker(() => now)
  const receipt = broker.issue({ action: 'filesystem.write.external', target, parameters: { content: 'ok' }, fencing_token: 7, expires_at: '2026-01-02T00:00:00.000Z' })
  await expect(broker.writeExternal(receipt, { content: 'changed' }, 7)).rejects.toThrow('ESCALATION_DENIED')
  await expect(broker.writeExternal(receipt, { content: 'ok' }, 8)).rejects.toThrow('ESCALATION_DENIED')
  await broker.writeExternal(receipt, { content: 'ok' }, 7); expect(await fs.readFile(target, 'utf8')).toBe('ok')
  await expect(broker.writeExternal(receipt, { content: 'ok' }, 7)).rejects.toThrow('ESCALATION_DENIED')
  const outside = path.join(root, 'outside.txt'); await fs.writeFile(outside, 'outside'); const symlinkReceipt = broker.issue({ action: 'filesystem.write.external', target: path.join(root, 'link.txt'), parameters: { content: 'nope' }, fencing_token: 7, expires_at: '2026-01-02T00:00:00.000Z' }); await fs.symlink(outside, symlinkReceipt.target)
  await expect(broker.writeExternal(symlinkReceipt, { content: 'nope' }, 7)).rejects.toThrow(); expect(await fs.readFile(outside, 'utf8')).toBe('outside')
  const expired = broker.issue({ action: 'filesystem.write.external', target: path.join(root, 'expired.txt'), parameters: { content: 'nope' }, fencing_token: 7, expires_at: '2026-01-01T00:00:00.000Z' }); now = new Date('2026-01-03T00:00:00.000Z'); await expect(broker.writeExternal(expired, { content: 'nope' }, 7)).rejects.toThrow('ESCALATION_DENIED'); expect(await fs.access(expired.target).then(() => true).catch(() => false)).toBeFalse()
})
