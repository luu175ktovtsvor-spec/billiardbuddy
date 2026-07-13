// 生图工作台资产接线：本地文件上传校验、品牌素材解析和任务结果转版本。
// 依赖 workbenchApi 与 DOM 图片解码，纯业务规则放 imageWorkbenchModel。

import {
  assetUrl,
  pickImageUrl,
  workbenchApi,
  type ImageBrandPack,
  type ImageWorkbenchAsset,
  type ImageWorkbenchProject,
  type ImageWorkbenchVersion,
} from '../../api/studio'
import { reviewFromRecord } from './imageWorkbenchModel'
import type { StudioImage } from '../../api/studio'

export async function uploadWorkbenchImage(file: File): Promise<ImageWorkbenchAsset> {
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) throw new Error('请上传 PNG、JPEG 或 WebP 图片')
  if (file.size > 32 * 1024 * 1024) throw new Error('图片不能超过 32MB')
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
  const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image()
    image.onerror = () => reject(new Error('图片无法解码'))
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.src = dataUrl
  })
  return await workbenchApi.uploadAsset({
    kind: 'reference',
    data_url: dataUrl,
    filename: file.name,
    width: dimensions.width,
    height: dimensions.height,
  })
}

export async function brandAssetFromPack(pack: ImageBrandPack, kind: 'logo' | 'qrcode'): Promise<ImageWorkbenchAsset | null> {
  const url = kind === 'logo' ? pack.logo_url : pack.qrcode_url
  if (!url || !url.startsWith('/uploads/') || url.includes('\0') || url.split(/[\\/]/).some(segment => segment === '..')) return null
  const explicitId = kind === 'logo' ? pack.logo_asset_id : pack.qrcode_asset_id
  const filename = url.split('/').pop() ?? ''
  const inferredId = filename.replace(/\.[^.]+$/, '')
  const assetId = explicitId || inferredId
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(assetId)) return null

  let width = kind === 'logo' ? pack.logo_width : pack.qrcode_width
  let height = kind === 'logo' ? pack.logo_height : pack.qrcode_height
  if (!width || !height) {
    const dimensions = await imageDimensions(assetUrl(url))
    width = dimensions.width
    height = dimensions.height
  }
  return {
    asset_id: assetId,
    kind: 'reference',
    url,
    width,
    height,
    created_at: new Date().toISOString(),
  }
}

function imageDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onerror = () => reject(new Error('品牌素材无法解码'))
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.src = src
  })
}

export async function addImageVersionFromJob(
  project: ImageWorkbenchProject,
  parent: ImageWorkbenchVersion,
  job: { status: string; id: string; result?: Record<string, unknown>; error?: string | null },
  kind: Extract<ImageWorkbenchVersion['kind'], 'edit' | 'inpaint' | 'upscale'>,
  instruction: string,
  mask?: ImageWorkbenchAsset,
): Promise<ImageWorkbenchProject> {
  const result = job.result ?? {}
  if (job.status !== 'done') throw new Error(String(result.message ?? job.error ?? '图片任务失败'))
  if (result.blocked) throw new Error(String(result.message ?? '组件正在准备'))
  const img = Array.isArray(result.images) ? result.images[0] as StudioImage | undefined : undefined
  const url = img?.poster_url ?? pickImageUrl(result)
  if (!url) throw new Error('任务完成但没有返回图片')
  return await workbenchApi.addVersion(project.project_id, {
    parent_version_id: parent.id,
    kind,
    image_url: url,
    generation_id: img?.generation_id ?? (typeof result.generation_id === 'string' ? result.generation_id : undefined),
    width: img?.width ?? parent.width,
    height: img?.height ?? parent.height,
    ratio: img?.ratio ?? parent.ratio,
    instruction,
    job_id: job.id,
    mask: mask ? { asset_id: mask.asset_id, url: mask.url, width: mask.width, height: mask.height, mode: 'alpha_transparent_edit' } : undefined,
    review: reviewFromRecord({ ...result, ...(img ?? {}) }),
    set_current: true,
  })
}
