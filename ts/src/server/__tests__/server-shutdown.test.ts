import { expect, test } from 'bun:test'
import { stopServerRuntimeForShutdown } from '../index.js'
import { cronScheduler } from '../services/cronScheduler.js'

test('server shutdown stops background schedulers and product workers', async () => {
  const calls: string[] = []
  const originalCronStop = cronScheduler.stop.bind(cronScheduler)

  try {
    cronScheduler.stop = (() => {
      calls.push('cronScheduler.stop')
    }) as typeof cronScheduler.stop
    await stopServerRuntimeForShutdown({ waitForCli: true })

    expect(calls).toEqual(['cronScheduler.stop'])
  } finally {
    cronScheduler.stop = originalCronStop
  }
})
