import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lock } from '../../../../utils/lockfile.js'

/** A cross-process fence around one aggregate's SQLite/file publication. */
export class WriterFence {
  constructor(private readonly locksDirectory: string) {}

  async run<T>(aggregate: string, action: () => Promise<T>): Promise<T> {
    const safeAggregate = aggregate.replaceAll(/[^a-zA-Z0-9_.-]/g, '_')
    await mkdir(this.locksDirectory, { recursive: true, mode: 0o700 })
    const guard = join(this.locksDirectory, `${safeAggregate}.guard`)
    await writeFile(guard, '', { flag: 'a', mode: 0o600 })
    const release = await lock(guard, { stale: 30_000, retries: { retries: 100, minTimeout: 5, maxTimeout: 25 } })
    try {
      return await action()
    } finally {
      await release()
    }
  }
}
