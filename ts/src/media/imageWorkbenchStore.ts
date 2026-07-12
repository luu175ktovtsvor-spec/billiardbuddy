import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import {
  imageWorkbenchAddVersionRequestSchema,
  imageWorkbenchAssetKindSchema,
  imageWorkbenchCreateProjectRequestSchema,
  imageWorkbenchProjectSchema,
  imageWorkbenchRollbackRequestSchema,
  imageWorkbenchUpdateCanvasRequestSchema,
  imageWorkbenchUploadAssetRequestSchema,
  type ImageWorkbenchAddVersionRequest,
  type ImageWorkbenchAsset,
  type ImageWorkbenchCreateProjectRequest,
  type ImageWorkbenchLibraryItem,
  type ImageWorkbenchProject,
  type ImageWorkbenchTextLayer,
  type ImageWorkbenchUpdateCanvasRequest,
  type ImageWorkbenchUploadAssetRequest,
} from '../../shared/contracts/image-workbench'

const MAX_IMAGE_BYTES = 32 * 1024 * 1024

interface ParsedDataUrl {
  contentType: string
  bytes: Buffer
}

export class ImageWorkbenchStore {
  private readonly uploadsRoot: string
  private readonly projectsRoot: string
  private readonly assetsRoot: string
  private readonly libraryRoot: string

  constructor(private readonly stateRoot: string) {
    this.uploadsRoot = join(stateRoot, 'uploads')
    this.projectsRoot = join(this.uploadsRoot, 'workbench', 'projects')
    this.assetsRoot = join(this.uploadsRoot, 'workbench', 'assets')
    this.libraryRoot = join(this.uploadsRoot, 'library', 'images')
  }

  async listProjects(): Promise<ImageWorkbenchProject[]> {
    await mkdir(this.projectsRoot, { recursive: true })
    const names = await readdir(this.projectsRoot).catch(() => [])
    const projects: ImageWorkbenchProject[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      const project = await this.getProject(id).catch(() => null)
      if (project) projects.push(project)
    }
    return projects.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }

  async getProject(projectId: string): Promise<ImageWorkbenchProject | null> {
    const path = this.projectPath(projectId)
    if (!existsSync(path)) return null
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
    return imageWorkbenchProjectSchema.parse(raw)
  }

  async createProject(input: unknown): Promise<ImageWorkbenchProject> {
    const req = imageWorkbenchCreateProjectRequestSchema.parse(input)
    const now = new Date().toISOString()
    const projectId = newId('wb')
    const versionId = newId('v')
    const project: ImageWorkbenchProject = {
      schema_version: 1,
      project_id: projectId,
      title: req.title?.trim() || titleFromPrompt(req.prompt) || '未命名图片项目',
      source_generation_id: req.source_generation_id,
      current_version_id: versionId,
      prompt: req.prompt,
      intent: req.intent,
      quality: req.quality,
      ratio: req.ratio,
      quantity: req.quantity,
      reference_asset_ids: req.reference_asset_ids,
      canvas: {
        width: req.width,
        height: req.height,
        text_layers: [],
        updated_at: now,
      },
      versions: [{
        id: versionId,
        kind: req.source_generation_id ? 'generated' : 'imported',
        image_url: req.image_url,
        generation_id: req.source_generation_id,
        width: req.width,
        height: req.height,
        ratio: req.ratio,
        prompt: req.prompt,
        review: req.review,
        created_at: now,
      }],
      created_at: now,
      updated_at: now,
    }
    await this.writeProject(project)
    return project
  }

  async saveCanvas(projectId: string, input: unknown): Promise<ImageWorkbenchProject> {
    const req = imageWorkbenchUpdateCanvasRequestSchema.parse(input)
    const project = await this.requireProject(projectId)
    if (req.current_version_id && !project.versions.some(version => version.id === req.current_version_id)) {
      throw new ImageWorkbenchError('version not found', 404)
    }
    const now = new Date().toISOString()
    const next: ImageWorkbenchProject = {
      ...project,
      current_version_id: req.current_version_id ?? project.current_version_id,
      canvas: {
        width: req.width,
        height: req.height,
        text_layers: req.text_layers,
        updated_at: now,
      },
      updated_at: now,
    }
    await this.writeProject(next)
    return next
  }

  async addVersion(projectId: string, input: unknown): Promise<ImageWorkbenchProject> {
    const req = imageWorkbenchAddVersionRequestSchema.parse(input)
    const project = await this.requireProject(projectId)
    const parentId = req.parent_version_id ?? project.current_version_id
    if (parentId && !project.versions.some(version => version.id === parentId)) {
      throw new ImageWorkbenchError('parent version not found', 404)
    }
    const now = new Date().toISOString()
    const version = {
      id: newId('v'),
      parent_version_id: parentId ?? null,
      kind: req.kind,
      image_url: req.image_url,
      generation_id: req.generation_id,
      width: req.width,
      height: req.height,
      ratio: req.ratio,
      prompt: req.prompt,
      instruction: req.instruction,
      job_id: req.job_id,
      mask: req.mask,
      review: req.review,
      created_at: now,
    }
    const next: ImageWorkbenchProject = {
      ...project,
      current_version_id: req.set_current ? version.id : project.current_version_id,
      versions: [...project.versions, version],
      canvas: {
        ...project.canvas,
        width: req.width,
        height: req.height,
        updated_at: now,
      },
      updated_at: now,
    }
    const parsed = imageWorkbenchProjectSchema.parse(next)
    await this.writeProject(parsed)
    return parsed
  }

  async rollback(projectId: string, input: unknown): Promise<ImageWorkbenchProject> {
    const req = imageWorkbenchRollbackRequestSchema.parse(input)
    const project = await this.requireProject(projectId)
    const version = project.versions.find(item => item.id === req.version_id)
    if (!version) throw new ImageWorkbenchError('version not found', 404)
    const now = new Date().toISOString()
    const next: ImageWorkbenchProject = {
      ...project,
      current_version_id: version.id,
      canvas: {
        ...project.canvas,
        width: version.width,
        height: version.height,
        updated_at: now,
      },
      updated_at: now,
    }
    await this.writeProject(next)
    return next
  }

  async uploadAsset(input: unknown): Promise<ImageWorkbenchAsset> {
    const req = imageWorkbenchUploadAssetRequestSchema.parse(input)
    const parsed = parseImageDataUrl(req.data_url)
    if (!parsed) throw new ImageWorkbenchError('invalid image data url', 400)
    ensureAllowedImage(req, parsed.contentType)
    const now = new Date().toISOString()
    const assetId = newId(req.kind)
    const ext = extensionForContentType(parsed.contentType)
    const filename = `${assetId}${ext}`
    const dir = join(this.assetsRoot, req.kind)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, filename), parsed.bytes)
    return {
      asset_id: assetId,
      kind: req.kind,
      url: `/uploads/workbench/assets/${req.kind}/${filename}`,
      width: req.width,
      height: req.height,
      created_at: now,
    }
  }

  async exportProject(projectId: string, input: unknown): Promise<{ asset: ImageWorkbenchAsset; project: ImageWorkbenchProject }> {
    const req = imageWorkbenchUploadAssetRequestSchema.parse({ ...(input as Record<string, unknown>), kind: 'export' })
    const canvasReq = imageWorkbenchUpdateCanvasRequestSchema.parse(input)
    const asset = await this.uploadAsset(req)
    const project = await this.saveCanvas(projectId, canvasReq)
    const next = await this.addVersion(project.project_id, {
      kind: 'text_export',
      parent_version_id: project.current_version_id,
      image_url: asset.url,
      width: asset.width,
      height: asset.height,
      set_current: true,
    } satisfies ImageWorkbenchAddVersionRequest)
    return { asset, project: next }
  }

  async saveToLibrary(projectId: string, input: { version_id?: string; export_asset_id?: string; title?: string }): Promise<ImageWorkbenchLibraryItem> {
    const project = await this.requireProject(projectId)
    const version = input.version_id
      ? project.versions.find(item => item.id === input.version_id)
      : project.versions.find(item => item.id === project.current_version_id)
    if (!version) throw new ImageWorkbenchError('version not found', 404)
    const sourceUrl = input.export_asset_id
      ? this.assetUrlFromId(input.export_asset_id)
      : version.image_url
    const sourcePath = this.uploadPathForUrl(sourceUrl)
    if (!sourcePath || !existsSync(sourcePath)) throw new ImageWorkbenchError('source image not found', 404)
    await mkdir(this.libraryRoot, { recursive: true })
    const id = newId('lib')
    const ext = safeImageExt(extname(sourcePath))
    const filename = `${id}${ext}`
    await copyFile(sourcePath, join(this.libraryRoot, filename))
    const item: ImageWorkbenchLibraryItem = {
      id,
      project_id: project.project_id,
      version_id: version.id,
      title: input.title?.trim() || project.title,
      url: `/uploads/library/images/${filename}`,
      width: version.width,
      height: version.height,
      created_at: new Date().toISOString(),
    }
    await this.appendLibraryIndex(item)
    return item
  }

  uploadPathForUrl(url: string): string | null {
    if (!url.startsWith('/uploads/')) return null
    const rel = url.slice('/uploads/'.length)
    if (!rel || rel.includes('\0') || rel.includes('..')) return null
    const abs = resolve(this.uploadsRoot, rel)
    const root = resolve(this.uploadsRoot)
    if (abs !== root && !abs.startsWith(`${root}/`) && !abs.startsWith(`${root}\\`)) return null
    return abs
  }

  private assetUrlFromId(assetId: string): string {
    for (const kind of imageWorkbenchAssetKindSchema.options) {
      for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
        const path = join(this.assetsRoot, kind, `${assetId}${ext}`)
        if (existsSync(path)) return `/uploads/workbench/assets/${kind}/${assetId}${ext}`
      }
    }
    throw new ImageWorkbenchError('asset not found', 404)
  }

  private async requireProject(projectId: string): Promise<ImageWorkbenchProject> {
    const project = await this.getProject(projectId)
    if (!project) throw new ImageWorkbenchError('project not found', 404)
    return project
  }

  private projectPath(projectId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw new ImageWorkbenchError('invalid project id', 400)
    const path = resolve(this.projectsRoot, `${projectId}.json`)
    const root = resolve(this.projectsRoot)
    if (path !== root && !path.startsWith(`${root}/`) && !path.startsWith(`${root}\\`)) {
      throw new ImageWorkbenchError('invalid project id', 400)
    }
    return path
  }

  private async writeProject(project: ImageWorkbenchProject): Promise<void> {
    const parsed = imageWorkbenchProjectSchema.parse(project)
    await mkdir(this.projectsRoot, { recursive: true })
    await atomicWriteJson(this.projectPath(parsed.project_id), parsed)
  }

  private async appendLibraryIndex(item: ImageWorkbenchLibraryItem): Promise<void> {
    const path = join(this.uploadsRoot, 'library', 'index.json')
    await mkdir(join(this.uploadsRoot, 'library'), { recursive: true })
    let items: ImageWorkbenchLibraryItem[] = []
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
      if (Array.isArray(parsed)) items = parsed.filter((entry): entry is ImageWorkbenchLibraryItem => !!entry && typeof entry === 'object')
    } catch {
      items = []
    }
    await atomicWriteJson(path, [item, ...items].slice(0, 1000))
  }
}

export class ImageWorkbenchError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

function parseImageDataUrl(value: string): ParsedDataUrl | null {
  const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i)
  if (!match) return null
  const bytes = Buffer.from(match[2]!.replace(/\s/g, ''), 'base64')
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null
  return { contentType: match[1]!.toLowerCase(), bytes }
}

function ensureAllowedImage(req: ImageWorkbenchUploadAssetRequest, contentType: string): void {
  const allowed = new Set(['image/png', 'image/jpeg', 'image/webp'])
  if (!allowed.has(contentType)) throw new ImageWorkbenchError('unsupported image type', 400)
  if ((req.kind === 'mask' || req.kind === 'export' || req.kind === 'library') && contentType !== 'image/png') {
    throw new ImageWorkbenchError(`${req.kind} must be PNG`, 400)
  }
}

function extensionForContentType(contentType: string): string {
  if (contentType === 'image/jpeg') return '.jpg'
  if (contentType === 'image/webp') return '.webp'
  return '.png'
}

function safeImageExt(ext: string): string {
  const lower = ext.toLowerCase()
  return ['.png', '.jpg', '.jpeg', '.webp'].includes(lower) ? lower : '.png'
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
}

function titleFromPrompt(prompt: string | undefined): string | null {
  const value = prompt?.replace(/\s+/g, ' ').trim()
  if (!value) return null
  return value.length > 28 ? `${value.slice(0, 28)}...` : value
}
