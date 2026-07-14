// 工作区文件 REST 边界：目录浏览、文本/二进制预览和 Git diff。

import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import { RAW_MIME_BY_EXT } from '../workspaceTree'

interface WorkspaceFileRouteDependencies {
  defaultWorkspaceRoot: () => string
}

const WORKSPACE_FILE_ROUTE_PATHS = new Set([
  '/api/v1/agent/fs/list',
  '/api/v1/agent/fs/read',
  '/api/v1/agent/fs/raw',
  '/api/v1/agent/fs/diff',
])

export function createWorkspaceFileRouteHandler(deps: WorkspaceFileRouteDependencies) {
  return async function handleWorkspaceFileRoute(url: URL, req: Request): Promise<Response | null> {
    if (!WORKSPACE_FILE_ROUTE_PATHS.has(url.pathname) || req.method !== 'GET') return null

    if (url.pathname === '/api/v1/agent/fs/list') {
      const dirPath = url.searchParams.get('path')
      if (!dirPath) return Response.json({ error: 'path required' }, { status: 400 })
      try {
        const resolved = resolve(url.searchParams.get('working_dir') || deps.defaultWorkspaceRoot(), dirPath)
        const dirents = await readdir(resolved, { withFileTypes: true })
        const entries = dirents
          .filter(entry => !entry.name.startsWith('.'))
          .map(entry => ({ name: entry.name, isDir: entry.isDirectory() }))
          .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
          .slice(0, 500)
        return Response.json({ path: resolved, entries })
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 })
      }
    }

    if (url.pathname === '/api/v1/agent/fs/read') {
      const filePath = url.searchParams.get('path')
      if (!filePath) return Response.json({ error: 'path required' }, { status: 400 })
      try {
        const resolved = resolve(url.searchParams.get('working_dir') || deps.defaultWorkspaceRoot(), filePath)
        const info = await import('node:fs/promises').then(module => module.stat(resolved))
        if (info.size > 256 * 1024) {
          return Response.json({ path: resolved, truncated: true, content: '(文件超过 256KB,预览已截断)' })
        }
        return Response.json({ path: resolved, content: await readFile(resolved, 'utf8') })
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 })
      }
    }

    if (url.pathname === '/api/v1/agent/fs/raw') {
      const filePath = url.searchParams.get('path')
      if (!filePath) return new Response('path required', { status: 400 })
      try {
        const workspaceRoot = url.searchParams.get('working_dir') || deps.defaultWorkspaceRoot()
        const resolved = resolve(workspaceRoot, filePath)
        if (relative(workspaceRoot, resolved).startsWith('..')) return new Response('forbidden', { status: 403 })
        const info = await import('node:fs/promises').then(module => module.stat(resolved))
        if (info.size > 20 * 1024 * 1024) return new Response('file too large', { status: 413 })
        const data = await readFile(resolved)
        const contentType = RAW_MIME_BY_EXT[extname(resolved).toLowerCase()] ?? 'application/octet-stream'
        return new Response(data, { headers: { 'Content-Type': contentType, 'Cache-Control': 'no-cache' } })
      } catch (err) {
        return new Response(err instanceof Error ? err.message : String(err), { status: 404 })
      }
    }

    const filePath = url.searchParams.get('path')
    if (!filePath) return Response.json({ error: 'path required' }, { status: 400 })
    try {
      const resolved = resolve(url.searchParams.get('working_dir') || deps.defaultWorkspaceRoot(), filePath)
      const newString = await readFile(resolved, 'utf8').catch(() => '')
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileP = promisify(execFile)
      let repoRoot = ''
      try {
        const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd: dirname(resolved), timeout: 2000 })
        repoRoot = stdout.trim()
      } catch {
        // A non-Git directory has no historical diff base.
      }
      let oldString = ''
      if (repoRoot) {
        const relativePath = relative(repoRoot, resolved)
        try {
          const { stdout } = await execFileP('git', ['--no-optional-locks', 'show', `HEAD:${relativePath}`], {
            cwd: repoRoot,
            timeout: 3000,
            maxBuffer: 1024 * 1024,
          })
          oldString = stdout
        } catch {
          // Untracked files are represented as entirely new content.
        }
      }
      const changed = repoRoot ? oldString !== newString : false
      return Response.json({ path: resolved, oldString, newString, changed })
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 })
    }
  }
}
