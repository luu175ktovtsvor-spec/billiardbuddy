// 工作区文件 REST 边界：目录浏览、文本/二进制预览和 Git diff。

import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { RAW_MIME_BY_EXT } from '../workspaceTree'
import { OfficeDocumentError, readCsvSheet, readOfficeDocumentBlocks, readXlsxSheet } from '../../utils/officeDocuments'
import { workspaceFilePreviewSchema } from '../../../shared/contracts/workspace-files'

interface WorkspaceFileRouteDependencies {
  defaultWorkspaceRoot: () => string
}

const WORKSPACE_FILE_ROUTE_PATHS = new Set([
  '/api/v1/agent/fs/list',
  '/api/v1/agent/fs/read',
  '/api/v1/agent/fs/raw',
  '/api/v1/agent/fs/preview',
  '/api/v1/agent/fs/diff',
])

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function workspacePath(
  url: URL,
  filePath: string,
  defaultRoot: string,
  options: { allowMissing?: boolean } = {},
): Promise<{ root: string; resolved: string } | null> {
  const root = resolve(url.searchParams.get('working_dir') || defaultRoot)
  const resolved = resolve(root, filePath)
  if (!isWithin(root, resolved)) return null

  const realRoot = await realpath(root)
  let realTarget: string
  try {
    realTarget = await realpath(resolved)
  } catch (error) {
    if (!options.allowMissing) throw error
    realTarget = resolve(await realpath(dirname(resolved)), basename(resolved))
  }
  if (!isWithin(realRoot, realTarget)) return null
  return { root, resolved }
}

function rawRangeResponse(path: string, req: Request, contentType: string): Response {
  const file = Bun.file(path)
  const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' }
  const range = req.headers.get('range')
  if (!range) return new Response(file, { headers })
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
  const invalid = () => new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.size}` } })
  if (!match || file.size <= 0 || (!match[1] && !match[2])) return invalid()

  let start: number
  let end: number
  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return invalid()
    start = Math.max(0, file.size - suffixLength)
    end = file.size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= file.size) {
    return invalid()
  }
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${file.size}`,
      'Content-Length': String(end - start + 1),
    },
  })
}

export function createWorkspaceFileRouteHandler(deps: WorkspaceFileRouteDependencies) {
  return async function handleWorkspaceFileRoute(url: URL, req: Request): Promise<Response | null> {
    if (!WORKSPACE_FILE_ROUTE_PATHS.has(url.pathname) || req.method !== 'GET') return null

    if (url.pathname === '/api/v1/agent/fs/list') {
      const dirPath = url.searchParams.get('path')
      if (!dirPath) return Response.json({ error: 'path required' }, { status: 400 })
      try {
        const target = await workspacePath(url, dirPath, deps.defaultWorkspaceRoot())
        if (!target) return Response.json({ error: 'forbidden' }, { status: 403 })
        const resolved = target.resolved
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
        const target = await workspacePath(url, filePath, deps.defaultWorkspaceRoot())
        if (!target) return Response.json({ error: 'forbidden' }, { status: 403 })
        const resolved = target.resolved
        const info = await stat(resolved)
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
        const target = await workspacePath(url, filePath, deps.defaultWorkspaceRoot())
        if (!target) return new Response('forbidden', { status: 403 })
        const resolved = target.resolved
        const info = await stat(resolved)
        const contentType = RAW_MIME_BY_EXT[extname(resolved).toLowerCase()] ?? 'application/octet-stream'
        const limit = contentType.startsWith('video/')
          ? 2 * 1024 * 1024 * 1024
          : contentType === 'application/pdf'
            ? 256 * 1024 * 1024
            : 50 * 1024 * 1024
        if (info.size > limit) return new Response('file too large', { status: 413 })
        return rawRangeResponse(resolved, req, contentType)
      } catch (err) {
        return new Response(err instanceof Error ? err.message : String(err), { status: 404 })
      }
    }

    if (url.pathname === '/api/v1/agent/fs/preview') {
      const filePath = url.searchParams.get('path')
      if (!filePath) return Response.json({ error: 'path required' }, { status: 400 })
      let target: Awaited<ReturnType<typeof workspacePath>>
      let info: Awaited<ReturnType<typeof stat>>
      try {
        target = await workspacePath(url, filePath, deps.defaultWorkspaceRoot())
        if (!target) return Response.json({ error: 'forbidden' }, { status: 403 })
        info = await stat(target.resolved)
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 })
      }
      const extension = extname(target.resolved).toLowerCase()
      const compressedLimit = extension === '.csv' ? 25 * 1024 * 1024 : 256 * 1024 * 1024
      if (info.size > compressedLimit) return Response.json({ error: 'file too large' }, { status: 413 })
      try {
        if (extension === '.csv') {
          const sheet = await readCsvSheet(target.resolved)
          return Response.json(workspaceFilePreviewSchema.parse({ kind: 'spreadsheet', path: target.resolved, ...sheet }))
        }
        if (extension === '.xlsx') {
          const sheet = await readXlsxSheet(target.resolved, url.searchParams.get('sheet') || undefined, {
            maxEntries: 10_000,
            maxUncompressedBytes: 128 * 1024 * 1024,
          })
          return Response.json(workspaceFilePreviewSchema.parse({ kind: 'spreadsheet', path: target.resolved, ...sheet }))
        }
        if (extension === '.docx' || extension === '.pptx') {
          const document = await readOfficeDocumentBlocks(target.resolved, {
            maxEntries: 10_000,
            maxUncompressedBytes: 128 * 1024 * 1024,
          })
          const blocks = document.blocks.slice(0, 2000)
          return Response.json(workspaceFilePreviewSchema.parse({
            kind: 'document',
            path: target.resolved,
            name: document.name,
            document_kind: document.kind,
            blocks,
            truncated: document.blocks.length > blocks.length,
          }))
        }
        return Response.json({ error: `unsupported preview: ${basename(target.resolved)}` }, { status: 415 })
      } catch (err) {
        const status = err instanceof OfficeDocumentError ? err.status : 422
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status })
      }
    }

    const filePath = url.searchParams.get('path')
    if (!filePath) return Response.json({ error: 'path required' }, { status: 400 })
    try {
      const target = await workspacePath(url, filePath, deps.defaultWorkspaceRoot(), { allowMissing: true })
      if (!target) return Response.json({ error: 'forbidden' }, { status: 403 })
      const resolved = target.resolved
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
