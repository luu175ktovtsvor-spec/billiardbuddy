import { VideoWorkbenchRepository } from '../../services/videoWorkbenchRepository.js'

type ProjectMutation = () => Promise<unknown>

/**
 * The sole in-process coordinator for a project's read-modify-write sequence.
 * SQLite remains the durable source of truth; this map only prevents two local
 * application requests from composing stale projections before the repository
 * writer fence can reject one of them.
 */
export class VideoProjectStore {
  readonly repository: VideoWorkbenchRepository
  private readonly mutations = new Map<string, Promise<unknown>>()

  constructor(options: Readonly<{ root?: string; now: () => Date }>) {
    this.repository = new VideoWorkbenchRepository({ root: options.root, now: options.now })
  }

  async mutate<Result>(projectId: string, action: () => Promise<Result>): Promise<Result> {
    const previous = this.mutations.get(projectId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const current = previous.catch(() => undefined).then(() => gate)
    this.mutations.set(projectId, current)
    await previous.catch(() => undefined)
    try {
      return await action()
    } finally {
      release()
      if (this.mutations.get(projectId) === current) this.mutations.delete(projectId)
    }
  }
}
