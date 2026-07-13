// 工作区 REST 边界：当前路径恢复、已有目录选择、默认基目录和新工作区创建。

import { mkdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { WorkspaceNameError, createNamedWorkspace } from '../../workspace/workspaceProvision'
import { jsonError } from '../middleware/http'
import type { UserSettingsStore } from '../services/userSettings'

interface WorkspaceRouteDependencies {
  settings: Pick<UserSettingsStore, 'get' | 'update'>
  defaultWorkspaceRoot: () => string
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function methodNotAllowed(): Response {
  return new Response('Method not allowed', { status: 405 })
}

export function createWorkspaceRouteHandler(deps: WorkspaceRouteDependencies) {
  const effectiveBase = async (): Promise<string> => (await deps.settings.get()).workspaceBaseDir || deps.defaultWorkspaceRoot()
  const buildState = async (): Promise<Record<string, unknown>> => {
    const settings = await deps.settings.get()
    const defaultDir = deps.defaultWorkspaceRoot()
    const base = settings.workspaceBaseDir || defaultDir
    const persisted = settings.lastWorkspaceRoot ?? null
    const current = persisted && await isDirectory(persisted) ? persisted : defaultDir
    return { default: defaultDir, base, persisted, current, exists: await isDirectory(current) }
  }

  return async function handleWorkspaceRoute(url: URL, req: Request): Promise<Response | null> {
    if (
      url.pathname !== '/api/v1/workspace' &&
      url.pathname !== '/api/v1/workspace/create' &&
      url.pathname !== '/api/v1/workspace/base'
    ) return null

    if (url.pathname === '/api/v1/workspace/create') {
      if (req.method !== 'POST') return methodNotAllowed()
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      try {
        const created = await createNamedWorkspace(await effectiveBase(), typeof body.name === 'string' ? body.name : '')
        await deps.settings.update({ lastWorkspaceRoot: created.path })
        return Response.json({ ...created, ...(await buildState()) })
      } catch (err) {
        if (err instanceof WorkspaceNameError) return jsonError(err.message, 400)
        return jsonError(err instanceof Error ? err.message : String(err), 500)
      }
    }

    if (url.pathname === '/api/v1/workspace/base') {
      if (req.method !== 'POST') return methodNotAllowed()
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      const raw = typeof body.path === 'string' ? body.path.trim() : ''
      if (!raw) return jsonError('path required', 400)
      const absolutePath = resolve(raw)
      try {
        await mkdir(absolutePath, { recursive: true })
      } catch {
        // Existing or uncreatable paths are distinguished by the directory check below.
      }
      if (!await isDirectory(absolutePath)) return jsonError(`不是可用目录:${raw}`, 400)
      await deps.settings.update({ workspaceBaseDir: absolutePath })
      return Response.json(await buildState())
    }

    if (req.method === 'GET') return Response.json(await buildState())
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      const raw = typeof body.path === 'string' ? body.path.trim() : ''
      if (!raw) return jsonError('path required', 400)
      const absolutePath = resolve(raw)
      try {
        await mkdir(absolutePath, { recursive: true })
      } catch {
        // Existing or uncreatable paths are distinguished by the directory check below.
      }
      if (!await isDirectory(absolutePath)) return jsonError(`不是可用目录:${raw}`, 400)
      await deps.settings.update({ lastWorkspaceRoot: absolutePath })
      return Response.json(await buildState())
    }
    return methodNotAllowed()
  }
}
