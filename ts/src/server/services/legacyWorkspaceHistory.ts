/**
 * Read-only workspace history retained while the pre-Codex ProductTask
 * backend is retired. This is deliberately not an Agent runtime: it never
 * materializes tasks, imports Core sessions, writes migrations, or launches
 * a worker. Its sole consumer is the common directory picker.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ProductRecentProject, ProductRecentProjectList } from '../../../shared/product/domain.js'
import { findProductGitRoot } from '../product/productGit.js'
import { getProductConfigDir } from '../product/productPaths.js'

const MAX_RECENT_PROJECTS = 500

function boundedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 10
  return Math.min(Math.max(Math.floor(limit), 1), MAX_RECENT_PROJECTS)
}

function legacyTaskStorePath(): string {
  return path.join(getProductConfigDir(), 'billiardbuddy', 'product-tasks.json')
}

function latestTimestamp(...values: Array<string | undefined>): string {
  let latest = new Date(0).toISOString()
  let latestValue = Number.NEGATIVE_INFINITY

  for (const value of values) {
    if (!value) continue
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed) || parsed <= latestValue) continue
    latestValue = parsed
    latest = value
  }

  return latest
}

type LegacyProject = { id: string; rootDir: string; title: string; updatedAt?: string }
type LegacyTask = { projectId: string; updatedAt?: string }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Read only the public directory fields needed by the picker. Core-session
 * identifiers, permission snapshots, side tasks and every task lifecycle
 * field deliberately stay outside this projection.
 */
export function readLegacyRecentProjectMetadata(value: unknown): {
  projects: LegacyProject[]
  tasks: LegacyTask[]
} {
  const root = record(value)
  const rawProjects = record(root?.projects)
  const rawTasks = record(root?.tasks)
  if (!root || !rawProjects || !rawTasks) return { projects: [], tasks: [] }

  const projects = Object.entries(rawProjects).flatMap(([id, raw]) => {
    const project = record(raw)
    const rootDir = text(project?.rootDir)
    if (!id || !rootDir) return []
    return [{ id, rootDir, title: text(project?.title) ?? (path.basename(rootDir) || rootDir), updatedAt: text(project?.updatedAt) }]
  })
  const tasks = Object.values(rawTasks).flatMap(raw => {
    const task = record(raw)
    const projectId = text(task?.projectId)
    if (!projectId || task?.visibility === 'side_task') return []
    return [{ projectId, updatedAt: text(task?.updatedAt) }]
  })
  return { projects, tasks }
}

/**
 * Project history is derived only from the old public project/directory index.
 * Core bindings never cross this boundary.
 */
export async function listLegacyRecentProjects(limit = 10): Promise<ProductRecentProjectList> {
  let raw: string
  try {
    raw = await fs.readFile(legacyTaskStorePath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { projects: [] }
    return { projects: [] }
  }

  try {
    const store = readLegacyRecentProjectMetadata(JSON.parse(raw) as unknown)
    const tasksByProject = new Map<string, Array<{ updatedAt: string }>>()
    for (const task of store.tasks) {
      const tasks = tasksByProject.get(task.projectId) ?? []
      tasks.push({ updatedAt: task.updatedAt ?? new Date(0).toISOString() })
      tasksByProject.set(task.projectId, tasks)
    }

    const projects = await Promise.all(
      store.projects
        .filter(project => tasksByProject.has(project.id))
        .map(async (project): Promise<ProductRecentProject> => {
          const realPath = await fs.realpath(project.rootDir).catch(() => project.rootDir)
          const projectTasks = tasksByProject.get(project.id) ?? []
          return {
            projectPath: project.rootDir,
            realPath,
            projectName: project.title,
            isGit: findProductGitRoot(realPath) !== null,
            repoName: null,
            branch: null,
            modifiedAt: latestTimestamp(project.updatedAt, ...projectTasks.map(task => task.updatedAt)),
            sessionCount: projectTasks.length,
          }
        }),
    )

    return {
      projects: projects
        .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
        .slice(0, boundedLimit(limit)),
    }
  } catch {
    // A corrupt historical file must not prevent the independent media and
    // native Codex services from starting. The legacy data remains untouched.
    return { projects: [] }
  }
}
