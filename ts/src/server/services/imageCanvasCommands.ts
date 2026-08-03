import {
  imageCanvasDocumentSchema,
  type ImageCanvasCommandInput,
  type ImageCanvasDocument,
  type ImageCanvasLayer,
} from '../../../shared/contracts/imageGeneration.js'

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

/**
 * Applies the restricted command set, never a renderer-provided full-document
 * replacement. The caller owns the aggregate lock and writes the resulting
 * immutable revision in the same SQLite transaction.
 */
export function applyCanvasCommandDocument(
  document: ImageCanvasDocument,
  command: ImageCanvasCommandInput,
  deliveryArtboard?: { width: number; height: number },
): ImageCanvasDocument {
  const next = clone(document)
  switch (command.kind) {
    case 'add_layer': {
      const layer = command.payload.layer as ImageCanvasLayer
      const ids = allIds(next.layers)
      if (ids.has(layer.id)) throw new ImageCanvasCommandError('图层标识已存在')
      const layers = childrenFor(next, command.payload.parent_group_id)
      const index = command.payload.index ?? layers.length
      if (index > layers.length) throw new ImageCanvasCommandError('图层插入位置无效')
      layers.splice(index, 0, layer)
      break
    }
    case 'replace_layer': {
      const layer = command.payload.layer as ImageCanvasLayer
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
    case 'remove_layer':
      if (!removeLayer(next.layers, command.payload.layer_id)) throw new ImageCanvasCommandError('待移除图层不存在')
      break
    case 'reorder_layers': {
      const layers = childrenFor(next, command.payload.parent_group_id)
      if (layers.length !== command.payload.ordered_layer_ids.length
        || new Set(command.payload.ordered_layer_ids).size !== layers.length
        || command.payload.ordered_layer_ids.some(id => !layers.some(layer => layer.id === id))) {
        throw new ImageCanvasCommandError('图层顺序必须完整且不重复')
      }
      const index = new Map(layers.map(layer => [layer.id, layer]))
      layers.splice(0, layers.length, ...command.payload.ordered_layer_ids.map(id => index.get(id)!))
      break
    }
    case 'apply_template':
      next.template_revision_id = command.payload.template_revision_id
      break
    case 'apply_brand_kit':
      next.brand_kit_revision_id = command.payload.brand_kit_revision_id
      break
    case 'sync_delivery_spec':
      next.delivery_spec_id = command.payload.delivery_spec_id
      next.delivery_spec_revision = command.payload.delivery_spec_revision
      if (!deliveryArtboard) throw new ImageCanvasCommandError('交付规格同步缺少目标画板')
      if (command.payload.layout_policy === 'fit_safe_area') {
        const scaleX = deliveryArtboard.width / next.width
        const scaleY = deliveryArtboard.height / next.height
        next.layers = scaleLayers(next.layers, scaleX, scaleY)
      }
      next.width = deliveryArtboard.width
      next.height = deliveryArtboard.height
      break
  }
  return imageCanvasDocumentSchema.parse(next)
}

function scaleLayers(layers: ImageCanvasLayer[], scaleX: number, scaleY: number): ImageCanvasLayer[] {
  return layers.map(layer => {
    if (layer.kind === 'group') return { ...layer, children: scaleLayers(layer.children, scaleX, scaleY) }
    if (layer.kind === 'raster' || layer.kind === 'logo' || layer.kind === 'qrcode' || layer.kind === 'shape') {
      return {
        ...layer,
        transform: {
          ...layer.transform,
          x: layer.transform.x * scaleX,
          y: layer.transform.y * scaleY,
          width: layer.transform.width * scaleX,
          height: layer.transform.height * scaleY,
        },
      }
    }
    if (layer.kind === 'text') {
      return {
        ...layer,
        position: { x: layer.position.x * scaleX, y: layer.position.y * scaleY },
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
