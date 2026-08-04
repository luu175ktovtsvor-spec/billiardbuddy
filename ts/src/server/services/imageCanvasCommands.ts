import { createHash } from 'node:crypto'
import {
  imageCanvasDocumentSchema,
  type ImageCanvasCommandInput,
  type ImageCanvasDocument,
  type ImageCanvasLayer,
  type ImageTemplateRevision,
} from '../../../shared/contracts/imageGeneration.js'

const MAX_CANVAS_LAYERS = 80
const TEMPLATE_OVERLAY_ID_PREFIX = 'tplov_'
const TEMPLATE_LAYER_ID_PREFIX = 'tplay_'

/** A command failure is deliberately distinct from a stale aggregate revision. */
export class ImageCanvasCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageCanvasCommandError'
  }
}

function clone(document: ImageCanvasDocument): ImageCanvasDocument {
  return structuredClone(document)
}

function childrenFor(document: ImageCanvasDocument, parentGroupId?: string): ImageCanvasLayer[] {
  if (!parentGroupId) return document.layers
  const group = findLayer(document.layers, parentGroupId)
  if (!group || group.kind !== 'group') throw new ImageCanvasCommandError('目标分组不存在')
  return group.children
}

function findLayer(layers: ImageCanvasLayer[], id: string): ImageCanvasLayer | undefined {
  for (const layer of layers) {
    if (layer.id === id) return layer
    if (layer.kind === 'group') {
      const nested = findLayer(layer.children, id)
      if (nested) return nested
    }
  }
  return undefined
}

function removeLayer(layers: ImageCanvasLayer[], id: string): ImageCanvasLayer | undefined {
  const index = layers.findIndex(layer => layer.id === id)
  if (index >= 0) return layers.splice(index, 1)[0]
  for (const layer of layers) {
    if (layer.kind !== 'group') continue
    const removed = removeLayer(layer.children, id)
    if (removed) return removed
  }
  return undefined
}

function allIds(layers: ImageCanvasLayer[], seen = new Set<string>()): Set<string> {
  for (const layer of layers) {
    if (seen.has(layer.id)) throw new ImageCanvasCommandError('画布存在重复图层标识')
    seen.add(layer.id)
    if (layer.kind === 'group') allIds(layer.children, seen)
  }
  return seen
}

function templateScopedId(prefix: string, templateRevisionId: string, sourceLayerId = ''): string {
  const digest = createHash('sha256').update(templateRevisionId).update('\0').update(sourceLayerId).digest('hex').slice(0, 32)
  return `${prefix}${digest}`
}

function templateOverlayId(templateRevisionId: string): string {
  return templateScopedId(TEMPLATE_OVERLAY_ID_PREFIX, templateRevisionId)
}

function templateLayerId(templateRevisionId: string, sourceLayerId: string): string {
  return templateScopedId(TEMPLATE_LAYER_ID_PREFIX, templateRevisionId, sourceLayerId)
}

function isTemplateControlledId(id: string): boolean {
  return id.startsWith(TEMPLATE_OVERLAY_ID_PREFIX) || id.startsWith(TEMPLATE_LAYER_ID_PREFIX)
}

function containsTemplateControlledLayer(layer: ImageCanvasLayer): boolean {
  return isTemplateControlledId(layer.id) || (layer.kind === 'group' && layer.children.some(containsTemplateControlledLayer))
}

function targetsTemplateControlledLayer(layer: ImageCanvasLayer): boolean {
  if (layer.kind === 'mask') return isTemplateControlledId(layer.target_layer_id)
  return layer.kind === 'group' && layer.children.some(targetsTemplateControlledLayer)
}

function assertUserLayerIds(layer: ImageCanvasLayer): void {
  if (containsTemplateControlledLayer(layer) || targetsTemplateControlledLayer(layer)) {
    throw new ImageCanvasCommandError('模板受控图层标识不能用于普通画布编辑')
  }
}

function templateOverlayGroups(layers: ImageCanvasLayer[]): Array<Extract<ImageCanvasLayer, { kind: 'group' }>> {
  return layers.filter((layer): layer is Extract<ImageCanvasLayer, { kind: 'group' }> => (
    layer.kind === 'group' && layer.id.startsWith(TEMPLATE_OVERLAY_ID_PREFIX)
  ))
}

function canvasLayerCount(layers: ImageCanvasLayer[]): number {
  return allIds(layers).size
}

function assertCanvasLayerBudget(layers: ImageCanvasLayer[]): void {
  const count = canvasLayerCount(layers)
  if (count > MAX_CANVAS_LAYERS) {
    throw new ImageCanvasCommandError(`画布图层不能超过 ${MAX_CANVAS_LAYERS} 个`)
  }
}

function namespaceTemplateLayers(layers: ImageCanvasLayer[], templateRevisionId: string): ImageCanvasLayer[] {
  // Validate the source Blueprint before generating IDs, so a malformed Template
  // cannot collapse two controlled layers into one Canvas layer.
  const sourceIds = allIds(layers)
  const idMap = new Map([...sourceIds].map(id => [id, templateLayerId(templateRevisionId, id)]))
  const scoped = (layer: ImageCanvasLayer): ImageCanvasLayer => {
    const id = idMap.get(layer.id)
    if (!id) throw new ImageCanvasCommandError('模板图层标识无效')
    if (layer.kind === 'group') return { ...layer, id, children: layer.children.map(scoped) }
    if (layer.kind === 'mask') {
      const targetLayerId = idMap.get(layer.target_layer_id)
      if (!targetLayerId) throw new ImageCanvasCommandError('模板蒙版必须指向同一模板中的图层')
      return { ...layer, id, target_layer_id: targetLayerId }
    }
    return { ...layer, id }
  }
  return layers.map(scoped)
}

function removeCurrentTemplateOverlay(document: ImageCanvasDocument): void {
  const expectedId = document.template_revision_id ? templateOverlayId(document.template_revision_id) : undefined
  const overlays = templateOverlayGroups(document.layers)
  if (overlays.some(overlay => overlay.id !== expectedId)) {
    throw new ImageCanvasCommandError('画布含有不属于当前模板的受控叠加层')
  }
  if (!expectedId) return
  const index = document.layers.findIndex(layer => layer.kind === 'group' && layer.id === expectedId)
  if (index >= 0) document.layers.splice(index, 1)
  // A legacy Canvas may carry template metadata without the new overlay marker.
  // Preserve those old pixels rather than guessing which user layers to delete.
}

function insertionIndexBeforeTemplateOverlay(layers: ImageCanvasLayer[], requestedIndex?: number): number {
  const firstOverlay = layers.findIndex(layer => layer.kind === 'group' && layer.id.startsWith(TEMPLATE_OVERLAY_ID_PREFIX))
  const maximum = firstOverlay < 0 ? layers.length : firstOverlay
  const index = requestedIndex ?? maximum
  if (index > maximum) throw new ImageCanvasCommandError('普通图层不能置于模板受控叠加层之上')
  return index
}

function assertTemplateOverlayOrder(layers: ImageCanvasLayer[], orderedLayerIds: string[]): void {
  const overlays = templateOverlayGroups(layers)
  if (overlays.length === 0) return
  const expectedSuffix = overlays.map(layer => layer.id)
  const actualSuffix = orderedLayerIds.slice(-expectedSuffix.length)
  if (actualSuffix.length !== expectedSuffix.length || actualSuffix.some((id, index) => id !== expectedSuffix[index])) {
    throw new ImageCanvasCommandError('模板受控叠加层必须保持在普通图层之上')
  }
}

/**
 * Applies the restricted command set, never a renderer-provided full-document
 * replacement. The caller owns the aggregate lock and writes the resulting
 * immutable revision in the same SQLite transaction.
 */
export function applyCanvasCommandDocument(
  document: ImageCanvasDocument,
  command: ImageCanvasCommandInput,
  deliveryArtboard?: { width: number; height: number; safe_area?: { top: number; right: number; bottom: number; left: number } },
  template?: ImageTemplateRevision,
): ImageCanvasDocument {
  const next = clone(document)
  switch (command.kind) {
    case 'add_layer': {
      const layer = command.payload.layer as ImageCanvasLayer
      assertUserLayerIds(layer)
      const ids = allIds(next.layers)
      if (ids.has(layer.id)) throw new ImageCanvasCommandError('图层标识已存在')
      if (command.payload.parent_group_id && isTemplateControlledId(command.payload.parent_group_id)) {
        throw new ImageCanvasCommandError('模板受控图层不能由普通命令编辑')
      }
      const layers = childrenFor(next, command.payload.parent_group_id)
      const index = command.payload.parent_group_id
        ? command.payload.index ?? layers.length
        : insertionIndexBeforeTemplateOverlay(layers, command.payload.index)
      if (index > layers.length) throw new ImageCanvasCommandError('图层插入位置无效')
      layers.splice(index, 0, layer)
      break
    }
    case 'replace_layer': {
      const layer = command.payload.layer as ImageCanvasLayer
      assertUserLayerIds(layer)
      const existing = findLayer(next.layers, layer.id)
      if (existing && containsTemplateControlledLayer(existing)) {
        throw new ImageCanvasCommandError('模板受控图层不能由普通命令编辑')
      }
      const location = findParent(next.layers, layer.id)
      const old = removeLayer(next.layers, layer.id)
      if (!old) throw new ImageCanvasCommandError('待替换图层不存在')
      // Keep a replacement in the original drawing order rather than silently
      // moving it to the top. This is intentional for formal artwork changes.
      const layers = location?.layers ?? next.layers
      const index = location?.index ?? layers.length
      layers.splice(index, 0, layer)
      break
    }
    case 'remove_layer': {
      const existing = findLayer(next.layers, command.payload.layer_id)
      if (!existing) throw new ImageCanvasCommandError('待移除图层不存在')
      if (containsTemplateControlledLayer(existing)) throw new ImageCanvasCommandError('模板受控图层不能由普通命令编辑')
      removeLayer(next.layers, command.payload.layer_id)
      break
    }
    case 'reorder_layers': {
      if (command.payload.parent_group_id && isTemplateControlledId(command.payload.parent_group_id)) {
        throw new ImageCanvasCommandError('模板受控图层不能由普通命令编辑')
      }
      const layers = childrenFor(next, command.payload.parent_group_id)
      if (layers.length !== command.payload.ordered_layer_ids.length
        || new Set(command.payload.ordered_layer_ids).size !== layers.length
        || command.payload.ordered_layer_ids.some(id => !layers.some(layer => layer.id === id))) {
        throw new ImageCanvasCommandError('图层顺序必须完整且不重复')
      }
      if (!command.payload.parent_group_id) assertTemplateOverlayOrder(layers, command.payload.ordered_layer_ids)
      const index = new Map(layers.map(layer => [layer.id, layer]))
      layers.splice(0, layers.length, ...command.payload.ordered_layer_ids.map(id => index.get(id)!))
      break
    }
    case 'apply_template': {
      if (!template || template.template_id !== command.payload.template_id || template.id !== command.payload.template_revision_id) {
        throw new ImageCanvasCommandError('模板 revision 不存在或与模板标识不匹配')
      }
      if (template.blueprint.artboard.width !== next.width || template.blueprint.artboard.height !== next.height) {
        throw new ImageCanvasCommandError('模板画板尺寸必须与当前交付画板完全一致')
      }
      const bindingBySlot = new Map(command.payload.slot_bindings.map(binding => [binding.slot_id, binding]))
      if (bindingBySlot.size !== command.payload.slot_bindings.length || command.payload.slot_bindings.some(binding => !template.slots.some(slot => slot.id === binding.slot_id))) {
        throw new ImageCanvasCommandError('模板 Slot 绑定无效或重复')
      }
      for (const slot of template.slots) {
        const binding = bindingBySlot.get(slot.id)
        if (slot.required && !binding) throw new ImageCanvasCommandError(`模板必填 Slot ${slot.id} 未绑定`)
      }
      next.background = template.blueprint.background
      removeCurrentTemplateOverlay(next)
      const existingIds = allIds(next.layers)
      const overlay = {
        id: templateOverlayId(template.id),
        kind: 'group' as const,
        children: namespaceTemplateLayers(bindTemplateLayers(template.blueprint.layers, template, bindingBySlot), template.id),
      }
      const overlayIds = allIds([overlay])
      if ([...overlayIds].some(id => existingIds.has(id))) {
        throw new ImageCanvasCommandError('模板受控图层与现有画布图层标识冲突')
      }
      // The group is deliberately last: Canvas data below it remains user or
      // Candidate content, while the locked Template renders as its overlay.
      next.layers.push(overlay)
      next.template_id = command.payload.template_id
      next.template_revision_id = command.payload.template_revision_id
      if (template.brand_kit_revision_id && template.brand_kit_id) {
        next.brand_kit_id = template.brand_kit_id
        next.brand_kit_revision_id = template.brand_kit_revision_id
      } else {
        // A Template defines the complete locked Brand context for its
        // Blueprint. Retaining a previous template's Brand would make
        // brand.* colors render against an unrelated revision.
        delete next.brand_kit_id
        delete next.brand_kit_revision_id
      }
      break
    }
    case 'apply_brand_kit':
      next.brand_kit_id = command.payload.brand_kit_id
      next.brand_kit_revision_id = command.payload.brand_kit_revision_id
      break
    case 'sync_delivery_spec':
      next.delivery_spec_id = command.payload.delivery_spec_id
      next.delivery_spec_revision = command.payload.delivery_spec_revision
      if (!deliveryArtboard) throw new ImageCanvasCommandError('交付规格同步缺少目标画板')
      if (command.payload.layout_policy === 'fit_safe_area') {
        next.layers = fitLayersIntoSafeArea(next.layers, next.width, next.height, deliveryArtboard)
      }
      next.width = deliveryArtboard.width
      next.height = deliveryArtboard.height
      break
  }
  assertCanvasLayerBudget(next.layers)
  return imageCanvasDocumentSchema.parse(next)
}

function bindTemplateLayers(layers: ImageCanvasLayer[], template: ImageTemplateRevision, bindings: Map<string, { asset_id?: string; text?: string; qr_payload?: string }>): ImageCanvasLayer[] {
  const slotByLayer = new Map(template.slots.map(slot => [slot.layer_id, slot]))
  return layers.map(layer => {
    if (layer.kind === 'group') return { ...layer, children: bindTemplateLayers(layer.children, template, bindings) }
    const slot = slotByLayer.get(layer.id)
    if (!slot) return structuredClone(layer)
    const binding = bindings.get(slot.id)
    if (!binding) return structuredClone(layer)
    if (slot.kind === 'text' && layer.kind === 'text' && binding.text) return { ...layer, text: binding.text }
    if (slot.kind === 'qrcode' && layer.kind === 'qrcode' && binding.qr_payload) return { ...layer, source: { kind: 'payload', value: binding.qr_payload } }
    if ((slot.kind === 'raster' || slot.kind === 'logo') && (layer.kind === 'raster' || layer.kind === 'logo') && binding.asset_id) return { ...layer, source_asset_id: binding.asset_id }
    throw new ImageCanvasCommandError(`模板 Slot ${slot.id} 的绑定类型不匹配`)
  })
}

function fitLayersIntoSafeArea(
  layers: ImageCanvasLayer[],
  sourceWidth: number,
  sourceHeight: number,
  artboard: { width: number; height: number; safe_area?: { top: number; right: number; bottom: number; left: number } },
): ImageCanvasLayer[] {
  const safe = artboard.safe_area ?? { top: 0, right: 0, bottom: 0, left: 0 }
  const safeWidth = artboard.width - safe.left - safe.right
  const safeHeight = artboard.height - safe.top - safe.bottom
  if (safeWidth <= 0 || safeHeight <= 0) throw new ImageCanvasCommandError('交付规格安全区没有可用空间')
  const scale = Math.min(safeWidth / sourceWidth, safeHeight / sourceHeight)
  const offsetX = safe.left + (safeWidth - sourceWidth * scale) / 2
  const offsetY = safe.top + (safeHeight - sourceHeight * scale) / 2
  return scaleLayers(layers, scale, scale, offsetX, offsetY)
}

function scaleLayers(layers: ImageCanvasLayer[], scaleX: number, scaleY: number, offsetX = 0, offsetY = 0): ImageCanvasLayer[] {
  return layers.map(layer => {
    if (layer.kind === 'group') return { ...layer, children: scaleLayers(layer.children, scaleX, scaleY, offsetX, offsetY) }
    if (layer.kind === 'raster' || layer.kind === 'logo' || layer.kind === 'qrcode' || layer.kind === 'shape') {
      return {
        ...layer,
        transform: {
          ...layer.transform,
          x: layer.transform.x * scaleX + offsetX,
          y: layer.transform.y * scaleY + offsetY,
          width: layer.transform.width * scaleX,
          height: layer.transform.height * scaleY,
        },
        ...(layer.kind === 'shape' && layer.stroke_width !== undefined
          ? { stroke_width: layer.stroke_width * Math.min(scaleX, scaleY) }
          : {}),
      }
    }
    if (layer.kind === 'text') {
      return {
        ...layer,
        position: { x: layer.position.x * scaleX + offsetX, y: layer.position.y * scaleY + offsetY },
        font_size: layer.font_size * Math.min(scaleX, scaleY),
        ...(layer.min_font_size === undefined ? {} : { min_font_size: layer.min_font_size * Math.min(scaleX, scaleY) }),
        letter_spacing: layer.letter_spacing * Math.min(scaleX, scaleY),
        ...(layer.max_width === undefined ? {} : { max_width: layer.max_width * scaleX }),
        ...(layer.max_height === undefined ? {} : { max_height: layer.max_height * scaleY }),
      }
    }
    return layer
  })
}

function findParent(layers: ImageCanvasLayer[], id: string): { layers: ImageCanvasLayer[]; index: number } | undefined {
  const index = layers.findIndex(layer => layer.id === id)
  if (index >= 0) return { layers, index }
  for (const layer of layers) {
    if (layer.kind !== 'group') continue
    const nested = findParent(layer.children, id)
    if (nested) return nested
  }
  return undefined
}
