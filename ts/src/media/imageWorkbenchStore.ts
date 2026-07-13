import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { decode as decodeJpeg } from 'jpeg-js'
import { PNG } from 'pngjs'
import jsQR from 'jsqr'
import {
  imageWorkbenchAddVersionRequestSchema,
  imageWorkbenchAssetKindSchema,
  imageWorkbenchCreateProjectRequestSchema,
  imageWorkbenchPortraitConfirmRequestSchema,
  imageWorkbenchLibraryItemSchema,
  imageWorkbenchProjectSchema,
  imageWorkbenchRollbackRequestSchema,
  imageWorkbenchSaveToLibraryRequestSchema,
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
  private readonly locks = new Map<string, Promise<void>>()

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
      user_request: req.user_request ?? req.prompt,
      creative_brief: req.creative_brief,
      brief_understanding: req.brief_understanding,
      compiler_version: req.compiler_version,
      intent: req.intent,
      quality: req.quality,
      ratio: req.ratio,
      quantity: req.quantity,
      reference_asset_ids: req.reference_asset_ids,
      reference_assets: req.reference_assets,
      autosave_revision: 0,
      save_status: 'saved',
      canvas: {
        width: req.width,
        height: req.height,
        text_layers: req.text_layers,
        image_layers: req.image_layers,
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
    return this.withLock(`project:${projectId}`, async () => {
      const req = imageWorkbenchUpdateCanvasRequestSchema.parse(input)
      const project = await this.requireProject(projectId)
      if (req.revision !== undefined && req.revision !== project.autosave_revision) {
        throw new ImageWorkbenchError('project revision conflict', 409)
      }
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
          image_layers: req.image_layers,
          updated_at: now,
        },
        autosave_revision: project.autosave_revision + 1,
        save_status: 'saved',
        updated_at: now,
      }
      await this.writeProject(next)
      return next
    })
  }

  async addVersion(projectId: string, input: unknown): Promise<ImageWorkbenchProject> {
    return this.withLock(`project:${projectId}`, async () => {
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
        autosave_revision: project.autosave_revision + 1,
        save_status: 'saved',
        updated_at: now,
      }
      const parsed = imageWorkbenchProjectSchema.parse(next)
      await this.writeProject(parsed)
      return parsed
    })
  }

  async rollback(projectId: string, input: unknown): Promise<ImageWorkbenchProject> {
    return this.withLock(`project:${projectId}`, async () => {
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
        autosave_revision: project.autosave_revision + 1,
        save_status: 'saved',
        updated_at: now,
      }
      await this.writeProject(next)
      return next
    })
  }

  async confirmPortrait(projectId: string, input: unknown): Promise<ImageWorkbenchProject> {
    return this.withLock(`project:${projectId}`, async () => {
      const req = imageWorkbenchPortraitConfirmRequestSchema.parse(input)
      const project = await this.requireProject(projectId)
      if (project.intent !== 'portrait' || project.creative_brief?.portrait?.authorization_confirmed !== true) {
        throw new ImageWorkbenchError('portrait authorization must be confirmed before final person confirmation', 403)
      }
      const versionId = req.version_id ?? project.current_version_id
      const version = project.versions.find(item => item.id === versionId)
      if (!version) throw new ImageWorkbenchError('version not found', 404)
      if (version.review?.portrait_quality_state === 'blocked') {
        throw new ImageWorkbenchError('当前人像候选被硬性风险拦截，不能确认像本人', 403)
      }
      const review = {
        ...(version.review ?? {}),
        portrait_quality_state: 'user_confirmed' as const,
        portrait_user_confirmed: true,
        commercial_ready: false,
        quality_decision: {
          state: 'user_confirmed' as const,
          hard_gate_passed: false,
          auto_checked: version.review?.portrait_qc_auto_checked === true,
          warnings: version.review?.portrait_qc_warnings ?? [],
          message: '用户已确认像本人；这不是法律授权或自动商用保证。',
        },
      }
      const now = new Date().toISOString()
      const next = imageWorkbenchProjectSchema.parse({
        ...project,
        current_version_id: versionId,
        versions: project.versions.map(item => item.id === versionId ? { ...item, review } : item),
        autosave_revision: project.autosave_revision + 1,
        save_status: 'saved',
        updated_at: now,
      })
      await this.writeProject(next)
      return next
    })
  }

  async uploadAsset(input: unknown): Promise<ImageWorkbenchAsset> {
    const req = imageWorkbenchUploadAssetRequestSchema.parse(input)
    const parsed = parseImageDataUrl(req.data_url)
    if (!parsed) throw new ImageWorkbenchError('invalid image data url', 400)
    ensureAllowedImage(req, parsed.contentType)
    const dimensions = decodeImage(parsed.bytes, parsed.contentType)
    ensureAllowedImage(req, parsed.contentType, dimensions)
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
      width: dimensions.width,
      height: dimensions.height,
      created_at: now,
    }
  }

  async exportProject(projectId: string, input: unknown): Promise<{ asset: ImageWorkbenchAsset; project: ImageWorkbenchProject }> {
    const req = imageWorkbenchUploadAssetRequestSchema.parse({ ...(input as Record<string, unknown>), kind: 'export' })
    const exportInput = input as Record<string, unknown>
    const canvasReq = imageWorkbenchUpdateCanvasRequestSchema.parse({
      ...exportInput,
      current_version_id: exportInput.version_id ?? exportInput.current_version_id,
    })
    const project = await this.requireProject(projectId)
    const versionId = canvasReq.current_version_id ?? project.current_version_id
    const version = project.versions.find(item => item.id === versionId)
    if (!version) throw new ImageWorkbenchError('version not found', 404)
    if (project.intent === 'portrait' && version.review?.portrait_quality_state !== 'user_confirmed') {
      throw new ImageWorkbenchError('请先由用户确认像本人，才能导出人像成品', 403)
    }
    await this.validateExportLayers(canvasReq)
    this.validatePosterControlledCopy(project, canvasReq)
    this.validateRenderedExport(req, canvasReq)
    const asset = await this.uploadAsset(req)
    const saved = await this.saveCanvas(projectId, canvasReq)
    const exportReview = project.intent === 'poster_text' ? {
      ...(version.review ?? {}),
      poster_quality_state: 'recommended' as const,
      poster_hard_gate_passed: true,
      poster_hard_gate_warnings: [],
      quality_decision: {
        state: 'recommended' as const,
        hard_gate_passed: true,
        auto_checked: true,
        warnings: [],
        message: '最终 PNG 已通过尺寸、受控文字、Logo 比例和二维码可解码检查；画面审美仍由用户判断。',
      },
    } : version.review
    const next = await this.addVersion(saved.project_id, {
      kind: 'text_export',
      parent_version_id: saved.current_version_id,
      image_url: asset.url,
      width: asset.width,
      height: asset.height,
      review: exportReview,
      set_current: true,
    } satisfies ImageWorkbenchAddVersionRequest)
    return { asset, project: next }
  }

  private async validateExportLayers(input: ImageWorkbenchUpdateCanvasRequest): Promise<void> {
    for (const layer of input.text_layers ?? []) {
      if ((layer.font_size ?? 64) < 12) throw new ImageWorkbenchError(`text layer ${layer.id} font size is too small`, 400)
      const width = (layer.width ?? Math.max(1, input.width - layer.x)) * (layer.scale_x ?? 1)
      const height = (layer.height ?? Math.min((layer.font_size ?? 64) * 2, Math.max(1, input.height - layer.y))) * (layer.scale_y ?? 1)
      if (layer.x < 0 || layer.y < 0 || layer.x + width > input.width || layer.y + height > input.height) {
        throw new ImageWorkbenchError(`text layer ${layer.id} is outside canvas`, 400)
      }
      if (!layer.text.trim()) throw new ImageWorkbenchError(`text layer ${layer.id} is empty`, 400)
    }
    for (const layer of input.image_layers ?? []) {
      const width = layer.width * (layer.scale_x ?? 1)
      const height = layer.height * (layer.scale_y ?? 1)
      if (layer.x < 0 || layer.y < 0 || layer.x + width > input.width || layer.y + height > input.height) {
        throw new ImageWorkbenchError(`image layer ${layer.id} is outside canvas`, 400)
      }
      if (!layer.url) continue
      const path = this.uploadPathForUrl(layer.url)
      if (!path || !existsSync(path)) throw new ImageWorkbenchError(`image layer ${layer.id} asset not found`, 400)
      const bytes = await readFile(path)
      const dimensions = decodeImage(bytes, contentTypeForPath(path))
      const sourceRatio = dimensions.width / dimensions.height
      const layerRatio = width / height
      if (!Number.isFinite(layerRatio) || Math.abs(sourceRatio - layerRatio) > 0.015) {
        throw new ImageWorkbenchError(`image layer ${layer.id} aspect ratio changed`, 400)
      }
      if (layer.type === 'qrcode') {
        if (Math.min(dimensions.width, dimensions.height) < 64 || Math.abs(dimensions.width - dimensions.height) > 4) {
          throw new ImageWorkbenchError('二维码素材尺寸不足或不是方图', 400)
        }
        if (!decodeQr(bytes, contentTypeForPath(path), dimensions)) throw new ImageWorkbenchError('二维码素材无法解码', 400)
      }
    }
  }

  private validatePosterControlledCopy(project: ImageWorkbenchProject, canvas: ImageWorkbenchUpdateCanvasRequest): void {
    if (project.intent !== 'poster_text') return
    const expected = project.creative_brief?.poster?.exact_copy.filter(Boolean) ?? []
    if (!expected.length) return
    const text = (canvas.text_layers ?? []).map(layer => layer.text).join('\n')
    const missing = expected.filter(copy => !text.includes(copy))
    if (missing.length) {
      throw new ImageWorkbenchError(`受控文字层缺少业务信息:${missing.join('、')}`, 400)
    }
  }

  private validateRenderedExport(req: ImageWorkbenchUploadAssetRequest, canvas: ImageWorkbenchUpdateCanvasRequest): void {
    const parsed = parseImageDataUrl(req.data_url)
    if (!parsed) throw new ImageWorkbenchError('invalid export image data', 400)
    const dimensions = decodeImage(parsed.bytes, parsed.contentType)
    if (dimensions.width !== canvas.width || dimensions.height !== canvas.height) {
      throw new ImageWorkbenchError('export image dimensions do not match canvas', 400)
    }
    const hasQrCode = (canvas.image_layers ?? []).some(layer => layer.type === 'qrcode' && layer.visible)
    if (hasQrCode && !decodeQr(parsed.bytes, parsed.contentType, dimensions)) {
      throw new ImageWorkbenchError('导出 PNG 中的二维码无法解码，请调整尺寸、遮挡或静区后重试', 400)
    }
  }

  async saveToLibrary(projectId: string, input: { version_id?: string; export_asset_id?: string; title?: string }): Promise<ImageWorkbenchLibraryItem> {
    return this.withLock(`project:${projectId}`, async () => {
      const request = imageWorkbenchSaveToLibraryRequestSchema.parse(input)
      const project = await this.requireProject(projectId)
      const version = request.version_id
        ? project.versions.find(item => item.id === request.version_id)
        : project.versions.find(item => item.id === project.current_version_id)
      if (!version) throw new ImageWorkbenchError('version not found', 404)
      const sourceUrl = request.export_asset_id
        ? this.assetUrlFromId(request.export_asset_id)
        : version.image_url
      const sourcePath = this.uploadPathForUrl(sourceUrl)
      if (!sourcePath || !existsSync(sourcePath)) throw new ImageWorkbenchError('source image not found', 404)
      const dimensions = decodeImage(await readFile(sourcePath), contentTypeForPath(sourcePath))
      await mkdir(this.libraryRoot, { recursive: true })
      const id = newId('lib')
      const ext = safeImageExt(extname(sourcePath))
      const filename = `${id}${ext}`
      await copyFile(sourcePath, join(this.libraryRoot, filename))
      const item: ImageWorkbenchLibraryItem = {
        id,
        project_id: project.project_id,
        version_id: version.id,
        title: request.title?.trim() || project.title,
        url: `/uploads/library/images/${filename}`,
        width: dimensions.width,
        height: dimensions.height,
        created_at: new Date().toISOString(),
      }
      await this.appendLibraryIndex(item)
      return item
    })
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
    await this.withLock('library-index', async () => {
      const path = join(this.uploadsRoot, 'library', 'index.json')
      await mkdir(join(this.uploadsRoot, 'library'), { recursive: true })
      let items: ImageWorkbenchLibraryItem[] = []
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
        if (Array.isArray(parsed)) {
          items = parsed.flatMap(entry => {
            const checked = imageWorkbenchLibraryItemSchema.safeParse(entry)
            return checked.success ? [checked.data] : []
          })
        }
      } catch {
        items = []
      }
      await atomicWriteJson(path, [item, ...items].slice(0, 1000))
    })
  }

  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    this.locks.set(key, current)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (this.locks.get(key) === current) this.locks.delete(key)
    }
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

function ensureAllowedImage(req: ImageWorkbenchUploadAssetRequest, contentType: string, dimensions?: { width: number; height: number }): void {
  const allowed = new Set(['image/png', 'image/jpeg', 'image/webp'])
  if (!allowed.has(contentType)) throw new ImageWorkbenchError('unsupported image type', 400)
  if ((req.kind === 'mask' || req.kind === 'export' || req.kind === 'library') && contentType !== 'image/png') {
    throw new ImageWorkbenchError(`${req.kind} must be PNG`, 400)
  }
  if (!dimensions) return
  if (dimensions.width !== req.width || dimensions.height !== req.height) {
    throw new ImageWorkbenchError(`image dimensions mismatch: actual ${dimensions.width}x${dimensions.height}`, 400)
  }
  if (dimensions.width * dimensions.height > 40_000_000) throw new ImageWorkbenchError('image pixel count too large', 413)
}

function contentTypeForPath(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return 'image/png'
}

function decodeImage(bytes: Buffer, contentType: string): { width: number; height: number } {
  try {
    if (contentType === 'image/png') {
      if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error('PNG signature mismatch')
      const image = PNG.sync.read(bytes)
      return { width: image.width, height: image.height }
    }
    if (contentType === 'image/jpeg') {
      const image = decodeJpeg(bytes, { useTArray: true })
      return { width: image.width, height: image.height }
    }
    if (contentType === 'image/webp') {
      if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw new Error('WEBP signature mismatch')
      const chunk = bytes.toString('ascii', 12, 16)
      if (chunk === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) }
      if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26), height: bytes.readUInt16LE(28) }
      if (chunk === 'VP8L') return { width: 1 + (bytes[21]! | ((bytes[22]! & 0x3f) << 8)), height: 1 + ((bytes[22]! >> 6) | (bytes[23]! << 2) | ((bytes[24]! & 0x0f) << 10)) }
    }
  } catch {
    throw new ImageWorkbenchError('image bytes cannot be decoded', 400)
  }
  throw new ImageWorkbenchError('image format is not supported', 400)
}

function decodeQr(bytes: Buffer, contentType: string, dimensions: { width: number; height: number }): boolean {
  try {
    let data: Uint8ClampedArray
    if (contentType === 'image/png') data = new Uint8ClampedArray(PNG.sync.read(bytes).data)
    else if (contentType === 'image/jpeg') data = new Uint8ClampedArray(decodeJpeg(bytes, { useTArray: true }).data)
    else return false
    return Boolean(jsQR(data, dimensions.width, dimensions.height))
  } catch {
    return false
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
