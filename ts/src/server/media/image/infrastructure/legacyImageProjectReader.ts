import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  imageWorkbenchProjectSchema,
  mediaJobEventJournalSchema,
  mediaProjectSchema,
  mediaTaskSchema,
  type ImageWorkbenchProject,
  type MediaJobEventJournal,
  type MediaTask,
} from '../../../../../shared/contracts/media.js'

export type LegacyImageOperation = MediaTask & {
  kind: 'image.generate'
  image_operation: NonNullable<MediaTask['image_operation']>
}

export type LegacyImageStoreSnapshot = {
  projects: ImageWorkbenchProject[]
  operations: Map<string, LegacyImageOperation>
  journals: Map<string, MediaJobEventJournal>
  source_hash: string
}

/**
 * The first generic-media image writer persisted the Project intent but did
 * not yet copy the private `image_operation` request into each Task/Event.
 * Those records are still useful historical Operations: the Project is the
 * only authoritative source for the old mode/model/prompt/count, and filling
 * that private request locally cannot submit or bill anything remotely.
 */
function normalizeLegacyImageOperation(
  operation: MediaTask,
  project: ImageWorkbenchProject | undefined,
): LegacyImageOperation | null {
  if (operation.kind !== 'image.generate') return null
  if (operation.image_operation) return operation as LegacyImageOperation
  if (!project) return null

  const operationKind = project.mode === 'edit' ? 'edit' : 'generate'
  const outputCount = Math.min(3, Math.max(1, project.count ?? project.candidate_count ?? 1))
  return {
    ...operation,
    image_operation: {
      kind: operationKind,
      instruction: project.prompt,
      model: project.model,
      output_count: outputCount,
    },
  } as LegacyImageOperation
}

/** Include journal-only operations: old stores were allowed to lose task files. */
export function legacyProjectOperations(snapshot: LegacyImageStoreSnapshot, projectId: string): LegacyImageOperation[] {
  const operations = new Map([...snapshot.operations.values()]
    .filter(operation => operation.project_id === projectId)
    .map(operation => [operation.id, operation]))
  const project = snapshot.projects.find(candidate => candidate.id === projectId)
  for (const event of snapshot.journals.get(projectId)?.events ?? []) {
    const operation = normalizeLegacyImageOperation(event.task, project)
    if (operation?.project_id === projectId) operations.set(operation.id, operation)
  }
  return [...operations.values()].sort((left, right) => left.id.localeCompare(right.id))
}

/** Semantic per-project source identity used by resumable migration receipts. */
export function legacyProjectSourceHash(snapshot: LegacyImageStoreSnapshot, project: ImageWorkbenchProject): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    project,
    operations: legacyProjectOperations(snapshot, project.id),
    journal: snapshot.journals.get(project.id) ?? null,
  })).digest('hex')}`
}

/**
 * The former images/ JSON layout is a strict, read-only migration source.
 * New code must never obtain a writer from this class.
 */
export class LegacyImageProjectReader {
  constructor(private readonly root: string) {}

  async read(): Promise<LegacyImageStoreSnapshot> {
    const [projectFiles, genericOperationFiles, imageOperationFiles, journalFiles] = await Promise.all([
      this.jsonFiles(join(this.root, 'projects')),
      this.jsonFiles(join(this.root, 'tasks')),
      this.jsonFiles(join(this.root, 'operations')),
      this.jsonFiles(join(this.root, 'events')),
    ])
    const operationFiles = this.uniqueFiles([...genericOperationFiles, ...imageOperationFiles])
    const sources: Array<{ path: string; text: string }> = []
    const projects: ImageWorkbenchProject[] = []
    for (const [name, path] of projectFiles) {
      const text = await this.readText(path)
      const record = mediaProjectSchema.parse(JSON.parse(text))
      if (record.kind !== 'image') continue
      const project = imageWorkbenchProjectSchema.parse(record)
      if (name !== `${project.id}.json`) throw new Error('IMAGE_LEGACY_PROJECT_FILENAME_MISMATCH')
      sources.push({ path, text })
      projects.push(project)
    }
    const projectsById = new Map(projects.map(project => [project.id, project]))
    const operations = new Map<string, LegacyImageOperation>()
    for (const [name, path] of operationFiles) {
      const text = await this.readText(path)
      const operation = mediaTaskSchema.parse(JSON.parse(text))
      if (operation.kind !== 'image.generate') continue
      if (name !== `${operation.id}.json`) {
        throw new Error('IMAGE_LEGACY_OPERATION_INVALID')
      }
      // Include even a legacy record that cannot be imported in the global
      // source hash. This keeps a later source edit visible without making an
      // orphaned, non-image operation a boot-time blocker.
      sources.push({ path, text })
      const normalized = normalizeLegacyImageOperation(operation, projectsById.get(operation.project_id))
      if (normalized) operations.set(operation.id, normalized)
    }
    const journals = new Map<string, MediaJobEventJournal>()
    const imageProjectIds = new Set(projects.map(project => project.id))
    for (const [name, path] of journalFiles) {
      const projectId = name.slice(0, -'.json'.length)
      const text = await this.readText(path)
      if (!imageProjectIds.has(projectId)) continue
      const journal = mediaJobEventJournalSchema.parse(JSON.parse(text))
      if (journal.events.some(event => event.project_id !== projectId || event.task.kind !== 'image.generate')) {
        throw new Error('IMAGE_LEGACY_EVENT_INVALID')
      }
      const normalizedEvents: MediaJobEventJournal['events'] = []
      for (const event of journal.events) {
        const normalized = normalizeLegacyImageOperation(event.task, projectsById.get(projectId))
        // A journal for an image Project should remain importable even when an
        // old Task file was missing its private request. If the event cannot
        // be reconstructed, leave it out of the Operation projection while
        // retaining the raw journal in the source hash for operator review.
        if (normalized) normalizedEvents.push({ ...event, task: normalized })
      }
      sources.push({ path, text })
      journals.set(projectId, { ...journal, events: normalizedEvents })
    }
    const digest = createHash('sha256')
    for (const source of sources.sort((left, right) => left.path.localeCompare(right.path))) {
      digest.update(source.path)
      digest.update('\0')
      digest.update(source.text)
      digest.update('\0')
    }
    return {
      projects: projects.sort((left, right) => left.id.localeCompare(right.id)),
      operations,
      journals,
      source_hash: `sha256:${digest.digest('hex')}`,
    }
  }

  private async jsonFiles(directory: string): Promise<Array<[string, string]>> {
    const names = await readdir(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    return names.filter(name => name.endsWith('.json')).sort().map(name => [name, join(directory, name)])
  }

  private uniqueFiles(files: Array<[string, string]>): Array<[string, string]> {
    const unique = new Map<string, string>()
    for (const [name, path] of files) {
      const previous = unique.get(name)
      if (previous && previous !== path) throw new Error('IMAGE_LEGACY_OPERATION_DUPLICATED')
      unique.set(name, path)
    }
    return [...unique.entries()].sort(([left], [right]) => left.localeCompare(right))
  }

  private async readText(path: string): Promise<string> {
    return await readFile(path, 'utf8')
  }
}
