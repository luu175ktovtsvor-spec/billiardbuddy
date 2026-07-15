import { resolve } from 'node:path'
import {
  imageWorkbenchAddVersionRequestSchema,
  imageWorkbenchAssetResponseSchema,
  imageWorkbenchCreateProjectRequestSchema,
  imageWorkbenchExportRequestSchema,
  imageWorkbenchExportResponseSchema,
  imageWorkbenchLibraryResponseSchema,
  imageWorkbenchProjectListResponseSchema,
  imageWorkbenchProjectResponseSchema,
  imageWorkbenchPortraitConfirmRequestSchema,
  imageWorkbenchRollbackRequestSchema,
  imageWorkbenchSaveToLibraryRequestSchema,
  imageWorkbenchUpdateCanvasRequestSchema,
  imageWorkbenchUploadAssetRequestSchema,
} from '../../shared/contracts/image-workbench'
import { ImageWorkbenchError, type ImageWorkbenchStore } from './imageWorkbenchStore'

interface ImageWorkbenchRouteOptions {
  defaultWorkspaceRoot?: string
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function sameWorkingDir(left: string | undefined, right: string | undefined): boolean {
  if (!left?.trim() || !right?.trim()) return false
  return resolve(left) === resolve(right)
}

export function createImageWorkbenchRouteHandler(imageWorkbench: ImageWorkbenchStore, options: ImageWorkbenchRouteOptions = {}) {
  return async function handleImageWorkbenchRoute(url: URL, req: Request): Promise<Response | null> {
    if (!url.pathname.startsWith('/api/v1/studio/workbench/')) return null
    const action = url.pathname.slice('/api/v1/studio/'.length)
    if (action === 'workbench/projects' && req.method === 'GET') {
      try {
        const workingDir = url.searchParams.get('working_dir')?.trim() || options.defaultWorkspaceRoot
        return Response.json(imageWorkbenchProjectListResponseSchema.parse({
          projects: await imageWorkbench.listProjects({
            workingDir,
            includeUnscoped: sameWorkingDir(workingDir, options.defaultWorkspaceRoot),
          }),
        }))
      } catch (err) {
        return imageWorkbenchError(err)
      }
    }
    if (action === 'workbench/projects' && req.method === 'POST') {
      try {
        const raw = record(await req.json().catch(() => ({})))
        const body = imageWorkbenchCreateProjectRequestSchema.parse({
          ...raw,
          working_dir: raw.working_dir ?? options.defaultWorkspaceRoot,
        })
        const project = await imageWorkbench.createProject(body)
        return Response.json(imageWorkbenchProjectResponseSchema.parse({ project }))
      } catch (err) {
        return imageWorkbenchError(err)
      }
    }
    if (action === 'workbench/assets' && req.method === 'POST') {
      try {
        const body = imageWorkbenchUploadAssetRequestSchema.parse(await req.json().catch(() => ({})))
        const asset = await imageWorkbench.uploadAsset(body)
        return Response.json(imageWorkbenchAssetResponseSchema.parse({ asset }))
      } catch (err) {
        return imageWorkbenchError(err)
      }
    }
    const projectMatch = action.match(/^workbench\/projects\/([A-Za-z0-9_-]{1,128})(?:\/(canvas|versions|rollback|export|library|portrait-confirm))?$/)
    if (!projectMatch) return null
    const projectId = decodeURIComponent(projectMatch[1]!)
    const sub = projectMatch[2]
    try {
      if (!sub && req.method === 'GET') {
        const project = await imageWorkbench.getProject(projectId)
        if (!project) return jsonDetailError('project not found', 404)
        return Response.json(imageWorkbenchProjectResponseSchema.parse({ project }))
      }
      if (sub === 'canvas' && (req.method === 'PUT' || req.method === 'PATCH')) {
        const body = imageWorkbenchUpdateCanvasRequestSchema.parse(await req.json().catch(() => ({})))
        const project = await imageWorkbench.saveCanvas(projectId, body)
        return Response.json(imageWorkbenchProjectResponseSchema.parse({ project }))
      }
      if (sub === 'versions' && req.method === 'POST') {
        const body = imageWorkbenchAddVersionRequestSchema.parse(await req.json().catch(() => ({})))
        const project = await imageWorkbench.addVersion(projectId, body)
        return Response.json(imageWorkbenchProjectResponseSchema.parse({ project }))
      }
      if (sub === 'rollback' && req.method === 'POST') {
        const body = imageWorkbenchRollbackRequestSchema.parse(await req.json().catch(() => ({})))
        const project = await imageWorkbench.rollback(projectId, body)
        return Response.json(imageWorkbenchProjectResponseSchema.parse({ project }))
      }
      if (sub === 'export' && req.method === 'POST') {
        const body = imageWorkbenchExportRequestSchema.parse(await req.json().catch(() => ({})))
        const result = await imageWorkbench.exportProject(projectId, body)
        return Response.json(imageWorkbenchExportResponseSchema.parse(result))
      }
      if (sub === 'library' && req.method === 'POST') {
        const body = imageWorkbenchSaveToLibraryRequestSchema.parse(await req.json().catch(() => ({})))
        const item = await imageWorkbench.saveToLibrary(projectId, body)
        return Response.json(imageWorkbenchLibraryResponseSchema.parse({ item }))
      }
      if (sub === 'portrait-confirm' && req.method === 'POST') {
        const body = imageWorkbenchPortraitConfirmRequestSchema.parse(await req.json().catch(() => ({})))
        const project = await imageWorkbench.confirmPortrait(projectId, body)
        return Response.json(imageWorkbenchProjectResponseSchema.parse({ project }))
      }
      return new Response('Method not allowed', { status: 405 })
    } catch (err) {
      return imageWorkbenchError(err)
    }
  }
}

function imageWorkbenchError(error: unknown): Response {
  const status = error instanceof ImageWorkbenchError ? error.status : 400
  const message = error instanceof Error ? error.message : String(error)
  return jsonDetailError(message, status)
}

function jsonDetailError(detail: string, status: number): Response {
  return Response.json({ detail }, { status })
}
