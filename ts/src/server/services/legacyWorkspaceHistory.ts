/**
 * Read-only workspace history retained while the pre-Codex ProductTask
 * backend is retired. This is deliberately not an Agent runtime: it never
 * materializes tasks, imports Core sessions, writes migrations, or launches
 * a worker. Its sole consumer is the common directory picker.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ProductRecentProject, ProductRecentProjectList } from '../../../shared/product/domain.js'
import { normalizeProductTaskStore } from '../product/legacyProductTaskReader.js'
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

/**
 * Project history is derived only from the old, public task index. The
 * original Core bindings never cross this boundary.
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
    const store = normalizeProductTaskStore(JSON.parse(raw) as unknown)
    const tasksByProject = new Map<string, Array<{ updatedAt: string }>>()
    for (const task of Object.values(store.tasks)) {
      if (!task.projectId || task.visibility === 'side_task') continue
      const tasks = tasksByProject.get(task.projectId) ?? []
      tasks.push(task)
      tasksByProject.set(task.projectId, tasks)
    }

    const projects = await Promise.all(
      Object.values(store.projects)
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
