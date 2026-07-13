import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { VideoProject } from '../../../../shared/contracts/video-edit'

export interface VideoUsageEntry {
  project_id: string
  revision: number
  created_at: string
  music_fingerprint?: string
  music_license_id?: string
  brand_preset: VideoProject['brand']['preset']
  transition_signature: string
  animation_signature: string
}

export class VideoUsageHistory {
  private readonly path: string

  constructor(stateRoot: string) {
    this.path = join(stateRoot, 'uploads', 'edits', 'usage-history.jsonl')
  }

  async recent(limit = 200): Promise<VideoUsageEntry[]> {
    try {
      const lines = (await readFile(this.path, 'utf8')).trim().split('\n').filter(Boolean).slice(-limit)
      return lines.flatMap(line => {
        try {
          const value = JSON.parse(line) as VideoUsageEntry
          return value && typeof value.project_id === 'string' ? [value] : []
        } catch {
          return []
        }
      })
    } catch {
      return []
    }
  }

  async hasMusicFingerprint(fingerprint: string, exceptProjectId?: string): Promise<boolean> {
    if (!fingerprint) return false
    return (await this.recent()).some(entry => entry.music_fingerprint === fingerprint && entry.project_id !== exceptProjectId)
  }

  async record(project: VideoProject): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const entry: VideoUsageEntry = {
      project_id: project.project_id,
      revision: project.revision,
      created_at: new Date().toISOString(),
      music_fingerprint: project.music.fingerprint,
      music_license_id: project.music.license_id,
      brand_preset: project.brand.preset,
      transition_signature: project.scenes.filter(scene => !scene.deleted).map(scene => scene.transition_in.kind).join('>'),
      animation_signature: project.scenes.filter(scene => !scene.deleted).flatMap(scene => scene.graphics.map(graphic => `${graphic.role}:${graphic.style_token}`)).join('>'),
    }
    await appendFile(this.path, `${JSON.stringify(entry)}\n`)
  }
}
