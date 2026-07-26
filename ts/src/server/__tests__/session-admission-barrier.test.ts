import { expect, test } from 'bun:test'
import { SessionAdmissionBarrier } from '../product/sessionAdmissionBarrier.js'

test('task mutation admission is FIFO, concurrent across tasks, and releases after errors', async () => {
  const gate = new SessionAdmissionBarrier()
  const order: string[] = []
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const first = gate.withRunStart('same', async () => { order.push('first'); await held; order.push('first-end') })
  const second = gate.withWorkspaceMutation('same', async () => { order.push('second') })
  await Bun.sleep(5)
  expect(gate.pendingSessionCount).toBe(1)
  await gate.withRunStart('other', async () => { order.push('other') })
  expect(gate.pendingSessionCount).toBe(1)
  expect(order).toEqual(['first', 'other'])
  release(); await Promise.all([first, second])
  expect(gate.pendingSessionCount).toBe(0)
  expect(order).toEqual(['first', 'other', 'first-end', 'second'])
  await expect(gate.withRunStart('error', async () => { throw new Error('expected') })).rejects.toThrow('expected')
  await gate.withRunStart('error', async () => { order.push('after-error') })
  expect(order).toContain('after-error')
})
