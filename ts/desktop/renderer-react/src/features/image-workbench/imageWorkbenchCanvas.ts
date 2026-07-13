// 生图工作台 Fabric 画布操作：水合、图层抽取、蒙版绘制与 PNG 导出。
// DOM 与 fabric 相关的实现都住这里，页面组件只做接线。

import { Canvas, FabricImage, Textbox } from 'fabric'
import {
  assetUrl,
  type ImageWorkbenchImageLayer,
  type ImageWorkbenchProject,
  type ImageWorkbenchTextLayer,
  type ImageWorkbenchVersion,
} from '../../api/studio'
import { textAlignFrom } from './imageWorkbenchModel'
import type { MaskItem, WorkbenchObject } from './imageWorkbenchTypes'

export async function waitForFonts(timeoutMs = 2_000): Promise<void> {
  const ready = document.fonts?.ready
  if (!ready) return
  await Promise.race([ready, new Promise<void>(resolve => window.setTimeout(resolve, timeoutMs))])
}

const canvasHydrations = new WeakMap<Canvas, { token: symbol; promise: Promise<void> }>()

export function fitCanvasPreview(canvas: Canvas, project: ImageWorkbenchProject, viewport: HTMLDivElement | null): void {
  if (!viewport) return
  const availableWidth = Math.max(240, viewport.clientWidth - 24)
  const availableHeight = Math.max(320, Math.floor(window.innerHeight * 0.68) - 24)
  const scale = Math.min(1, availableWidth / project.canvas.width, availableHeight / project.canvas.height)
  canvas.setDimensions({
    width: Math.max(1, Math.round(project.canvas.width * scale)),
    height: Math.max(1, Math.round(project.canvas.height * scale)),
  }, { cssOnly: true })
}

export async function hydrateCanvas(canvas: Canvas, project: ImageWorkbenchProject, version: ImageWorkbenchVersion): Promise<void> {
  const token = Symbol('canvas-hydration')
  const promise = hydrateCanvasAttempt(canvas, project, version, token)
  canvasHydrations.set(canvas, { token, promise })
  await promise
  for (;;) {
    const latest = canvasHydrations.get(canvas)
    if (!latest || latest.token === token) return
    await latest.promise
    if (canvasHydrations.get(canvas) === latest) return
  }
}

async function hydrateCanvasAttempt(canvas: Canvas, project: ImageWorkbenchProject, version: ImageWorkbenchVersion, token: symbol): Promise<void> {
  const isCurrent = () => canvasHydrations.get(canvas)?.token === token
  canvas.clear()
  canvas.setDimensions({ width: project.canvas.width, height: project.canvas.height })
  const img = await FabricImage.fromURL(assetUrl(version.image_url), { crossOrigin: 'anonymous' })
  if (!isCurrent()) return
  const imgWidth = Number(img.width || project.canvas.width)
  const imgHeight = Number(img.height || project.canvas.height)
  img.set({
    left: 0,
    top: 0,
    scaleX: project.canvas.width / imgWidth,
    scaleY: project.canvas.height / imgHeight,
    selectable: false,
    evented: false,
    objectCaching: false,
  })
  ;(img as WorkbenchObject).backgroundRole = true
  canvas.add(img)
  for (const layer of project.canvas.image_layers ?? []) {
    if (!layer.url) continue
    const layerImage = await FabricImage.fromURL(assetUrl(layer.url), { crossOrigin: 'anonymous' })
    if (!isCurrent()) return
    const sourceWidth = Number(layerImage.width || layer.width)
    const sourceHeight = Number(layerImage.height || layer.height)
    layerImage.set({
      left: layer.x,
      top: layer.y,
      scaleX: layer.width / sourceWidth * layer.scale_x,
      scaleY: layer.height / sourceHeight * layer.scale_y,
      angle: layer.angle,
      selectable: !layer.locked,
      evented: !layer.locked,
      objectCaching: false,
    })
    const custom = layerImage as WorkbenchObject
    custom.imageLayerId = layer.id
    custom.imageLayerType = layer.type
    custom.workbenchLayerUrl = layer.url
    canvas.add(layerImage)
  }
  if (!isCurrent()) return
  for (const layer of project.canvas.text_layers) canvas.add(textLayerToFabric(layer))
  canvas.requestRenderAll()
}

export function textLayerToFabric(layer: ImageWorkbenchTextLayer): Textbox {
  const box = new Textbox(layer.text, {
    left: layer.x,
    top: layer.y,
    width: layer.width,
    height: layer.height,
    scaleX: layer.scale_x,
    scaleY: layer.scale_y,
    angle: layer.angle,
    fill: layer.fill,
    fontFamily: layer.font_family,
    fontSize: layer.font_size,
    fontWeight: layer.font_weight,
    // Fabric's text metrics call toLowerCase() on fontStyle during export.
    // Old projects legitimately omit the optional persisted value.
    fontStyle: fabricFontStyle(layer.font_style) ?? 'normal',
    textAlign: layer.text_align,
    stroke: layer.stroke,
    strokeWidth: layer.stroke_width,
    opacity: layer.opacity,
    objectCaching: false,
  }) as Textbox & { workbenchLayerId?: string }
  box.workbenchLayerId = layer.id
  return box
}

export function extractTextLayers(canvas: Canvas): ImageWorkbenchTextLayer[] {
  return canvas.getObjects()
    .filter((obj): obj is Textbox & { workbenchLayerId?: string } => obj instanceof Textbox)
    .map((obj) => ({
      id: obj.workbenchLayerId ?? `text_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      type: 'text',
      text: obj.text ?? '',
      x: Number(obj.left ?? 0),
      y: Number(obj.top ?? 0),
      width: Number(obj.width ?? 0) || undefined,
      height: Number(obj.height ?? 0) || undefined,
      scale_x: Number(obj.scaleX ?? 1),
      scale_y: Number(obj.scaleY ?? 1),
      angle: Number(obj.angle ?? 0),
      fill: String(obj.fill ?? '#111111'),
      font_family: String(obj.fontFamily ?? 'PingFang SC'),
      font_size: Number(obj.fontSize ?? 64),
      font_weight: typeof obj.fontWeight === 'string' || typeof obj.fontWeight === 'number' ? String(obj.fontWeight) : undefined,
      font_style: typeof obj.fontStyle === 'string' ? obj.fontStyle : undefined,
      text_align: textAlignFrom(obj.textAlign),
      stroke: typeof obj.stroke === 'string' ? obj.stroke : undefined,
      stroke_width: Number(obj.strokeWidth ?? 0),
      opacity: Number(obj.opacity ?? 1),
    }))
}

export function extractImageLayers(canvas: Canvas): ImageWorkbenchImageLayer[] {
  return canvas.getObjects()
    .filter((obj): obj is FabricImage & WorkbenchObject => Boolean((obj as WorkbenchObject).imageLayerId && obj instanceof FabricImage))
    .map((obj) => ({
      id: obj.imageLayerId!,
      type: obj.imageLayerType ?? 'reference_image',
      asset_id: obj.imageLayerId!.replace(/^layer_/, ''),
      url: obj.workbenchLayerUrl,
      x: Number(obj.left ?? 0),
      y: Number(obj.top ?? 0),
      width: Number(obj.width ?? 0) * Number(obj.scaleX ?? 1),
      height: Number(obj.height ?? 0) * Number(obj.scaleY ?? 1),
      scale_x: 1,
      scale_y: 1,
      angle: Number(obj.angle ?? 0),
      locked: obj.selectable !== true,
      visible: obj.visible !== false,
    }))
}

function fabricFontStyle(value: string | undefined): 'normal' | 'italic' | 'oblique' | undefined {
  return value === 'normal' || value === 'italic' || value === 'oblique' ? value : undefined
}

export function maskObjectOptions<T extends Record<string, unknown>>(options: T): T & { selectable: false; evented: false; excludeFromExport: true; maskRole: true } {
  return { ...options, selectable: false, evented: false, excludeFromExport: true, maskRole: true }
}

export function pathFromPoints(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return ''
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
}

export function maskDataUrl(width: number, height: number, items: MaskItem[]): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法准备选中区域')
  ctx.fillStyle = 'rgba(0,0,0,1)'
  ctx.fillRect(0, 0, width, height)
  ctx.globalCompositeOperation = 'destination-out'
  for (const item of items) {
    if (item.type === 'rect') {
      ctx.fillRect(item.x, item.y, item.width, item.height)
    } else {
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = item.size
      ctx.strokeStyle = 'rgba(0,0,0,1)'
      ctx.beginPath()
      item.points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y)
        else ctx.lineTo(point.x, point.y)
      })
      ctx.stroke()
    }
  }
  return canvas.toDataURL('image/png')
}

export function exportCanvasPng(canvas: Canvas): string {
  const masked = canvas.getObjects().filter((obj) => (obj as WorkbenchObject).maskRole)
  masked.forEach((obj) => obj.set('visible', false))
  canvas.requestRenderAll()
  const dataUrl = canvas.toDataURL({ format: 'png', multiplier: 1, enableRetinaScaling: false })
  masked.forEach((obj) => obj.set('visible', true))
  canvas.requestRenderAll()
  return dataUrl
}

export function textLayerSnapshot(canvas: Canvas): string {
  return JSON.stringify(extractTextLayers(canvas))
}

export function parseTextLayerSnapshot(snapshot: string): ImageWorkbenchTextLayer[] {
  try {
    const parsed = JSON.parse(snapshot) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is ImageWorkbenchTextLayer => !!item && typeof item === 'object' && (item as { type?: unknown }).type === 'text')
  } catch {
    return []
  }
}

export function themedColor(token: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const probe = document.createElement('span')
  probe.style.color = `var(${token})`
  document.body.appendChild(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color || fallback
}

export function withAlpha(color: string, alpha: number): string {
  const parts = color.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? []
  const [r, g, b] = parts
  if (r === undefined || g === undefined || b === undefined) return color
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
