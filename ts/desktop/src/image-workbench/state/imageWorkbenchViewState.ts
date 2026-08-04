import type { PublicMediaJobEventPage } from '../../../../shared/contracts/media.js'
import type { ImageCanvasLayer } from '../../../../shared/contracts/imageGeneration.js'
import type { ImageWorkbenchProjectProjection } from '../api/imageWorkbenchClient.js'

export const IMAGE_WORKBENCH_VIEW_STATE_SCHEMA_VERSION = 1

export const IMAGE_WORKBENCH_PANELS = [
  'quick-create',
  'creative-intake',
  'inspiration-board',
  'reference-tray',
  'candidate-review',
  'canvas-editor',
  'delivery-panel',
  'project-library',
  'campaign',
  'operation-center',
] as const

export type ImageWorkbenchPanel = typeof IMAGE_WORKBENCH_PANELS[number]

export type ImageWorkbenchDragDraft = {
  kind: 'canvas-layer'
  project_id: string
  canvas_id: string
  layer_id: string
  origin: { x: number; y: number }
  current: { x: number; y: number }
}

/**
 * This is the complete persistent renderer state.  It intentionally contains
 * no Project, Candidate, Canvas, Operation, Asset, or Provider fact.
 */
export type ImageWorkbenchViewState = {
  schema_version: typeof IMAGE_WORKBENCH_VIEW_STATE_SCHEMA_VERSION
  active_panel: ImageWorkbenchPanel
  expanded_panels: readonly ImageWorkbenchPanel[]
  selected_project_id?: string
  selected_candidate_id?: string
  selected_canvas_id?: string
  selected_artboard_id?: string
  drag_draft?: ImageWorkbenchDragDraft
  event_cursors: Readonly<Record<string, number>>
}

export type ImageWorkbenchViewAction =
  | { kind: 'select-project'; project_id?: string }
  | { kind: 'select-candidate'; candidate_id?: string }
  | { kind: 'select-canvas'; canvas_id?: string }
  | { kind: 'select-artboard'; artboard_id?: string }
  | { kind: 'open-panel'; panel: ImageWorkbenchPanel }
  | { kind: 'set-panel-expanded'; panel: ImageWorkbenchPanel; expanded: boolean }
  | { kind: 'begin-drag'; draft: ImageWorkbenchDragDraft }
  | { kind: 'update-drag'; current: { x: number; y: number } }
  | { kind: 'discard-drag' }
  | { kind: 'advance-event-cursor'; project_id: string; cursor: number }

export type ImageWorkbenchSelectionIndex = {
  project_id: string
  candidate_ids: readonly string[]
  canvas_ids: readonly string[]
  artboard_ids: readonly string[]
  canvas_layer_ids: Readonly<Record<string, readonly string[]>>
}

export type ImageWorkbenchRestorePlan = {
  view_state: ImageWorkbenchViewState
  event_cursor: number
  reload_projection: boolean
}

export interface ImageWorkbenchViewStateStorage {
  read(): string | null
  write(serialized: string): void
  remove(): void
}

const mediaIdPattern = /^[a-z0-9][a-z0-9_-]{7,79}$/

function isMediaId(value: unknown): value is string {
  return typeof value === 'string' && mediaIdPattern.test(value)
}

function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -12_000 && value <= 24_000
}

function isPanel(value: unknown): value is ImageWorkbenchPanel {
  return typeof value === 'string' && (IMAGE_WORKBENCH_PANELS as readonly string[]).includes(value)
}

function distinctPanels(panels: readonly ImageWorkbenchPanel[]): readonly ImageWorkbenchPanel[] {
  return [...new Set(panels)]
}

function copyState(state: ImageWorkbenchViewState): ImageWorkbenchViewState {
  return {
    ...state,
    expanded_panels: [...state.expanded_panels],
    drag_draft: state.drag_draft
      ? {
          ...state.drag_draft,
          origin: { ...state.drag_draft.origin },
          current: { ...state.drag_draft.current },
        }
      : undefined,
    event_cursors: { ...state.event_cursors },
  }
}

export function createImageWorkbenchViewState(): ImageWorkbenchViewState {
  return {
    schema_version: IMAGE_WORKBENCH_VIEW_STATE_SCHEMA_VERSION,
    active_panel: 'quick-create',
    expanded_panels: ['quick-create'],
    event_cursors: {},
  }
}

function parseDragDraft(value: unknown): ImageWorkbenchDragDraft | undefined {
  if (!value || typeof value !== 'object') return undefined
  const draft = value as Record<string, unknown>
  if (draft.kind !== 'canvas-layer') return undefined
  if (!isMediaId(draft.project_id) || !isMediaId(draft.canvas_id) || !isMediaId(draft.layer_id)) return undefined
  if (!draft.origin || typeof draft.origin !== 'object' || !draft.current || typeof draft.current !== 'object') return undefined
  const origin = draft.origin as Record<string, unknown>
  const current = draft.current as Record<string, unknown>
  if (!isFiniteCoordinate(origin.x) || !isFiniteCoordinate(origin.y)) return undefined
  if (!isFiniteCoordinate(current.x) || !isFiniteCoordinate(current.y)) return undefined
  return {
    kind: 'canvas-layer',
    project_id: draft.project_id,
    canvas_id: draft.canvas_id,
    layer_id: draft.layer_id,
    origin: { x: origin.x, y: origin.y },
    current: { x: current.x, y: current.y },
  }
}

function parseEventCursors(value: unknown): Readonly<Record<string, number>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const parsed: Record<string, number> = {}
  for (const [projectId, cursor] of Object.entries(value)) {
    if (isMediaId(projectId) && typeof cursor === 'number' && Number.isInteger(cursor) && cursor >= 0) {
      parsed[projectId] = cursor
    }
  }
  return parsed
}

/** Parse only the finite view-state allowlist. Unknown persisted keys are discarded. */
export function parseImageWorkbenchViewState(serialized: string | null | undefined): ImageWorkbenchViewState {
  if (!serialized) return createImageWorkbenchViewState()
  let raw: unknown
  try {
    raw = JSON.parse(serialized) as unknown
  } catch {
    return createImageWorkbenchViewState()
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return createImageWorkbenchViewState()
  const value = raw as Record<string, unknown>
  if (value.schema_version !== IMAGE_WORKBENCH_VIEW_STATE_SCHEMA_VERSION) return createImageWorkbenchViewState()
  const expandedPanels = Array.isArray(value.expanded_panels)
    ? distinctPanels(value.expanded_panels.filter(isPanel))
    : []
  const activePanel = isPanel(value.active_panel) ? value.active_panel : 'quick-create'
  const expanded = expandedPanels.includes(activePanel)
    ? expandedPanels
    : distinctPanels([...expandedPanels, activePanel])
  return {
    schema_version: IMAGE_WORKBENCH_VIEW_STATE_SCHEMA_VERSION,
    active_panel: activePanel,
    expanded_panels: expanded,
    ...(isMediaId(value.selected_project_id) ? { selected_project_id: value.selected_project_id } : {}),
    ...(isMediaId(value.selected_candidate_id) ? { selected_candidate_id: value.selected_candidate_id } : {}),
    ...(isMediaId(value.selected_canvas_id) ? { selected_canvas_id: value.selected_canvas_id } : {}),
    ...(isMediaId(value.selected_artboard_id) ? { selected_artboard_id: value.selected_artboard_id } : {}),
    ...(parseDragDraft(value.drag_draft) ? { drag_draft: parseDragDraft(value.drag_draft) } : {}),
    event_cursors: parseEventCursors(value.event_cursors),
  }
}

export function serializeImageWorkbenchViewState(state: ImageWorkbenchViewState): string {
  const parsed = parseImageWorkbenchViewState(JSON.stringify(state))
  return JSON.stringify(parsed)
}

export function readImageWorkbenchViewState(storage: ImageWorkbenchViewStateStorage): ImageWorkbenchViewState {
  return parseImageWorkbenchViewState(storage.read())
}

export function writeImageWorkbenchViewState(
  storage: ImageWorkbenchViewStateStorage,
  state: ImageWorkbenchViewState,
): void {
  storage.write(serializeImageWorkbenchViewState(state))
}

export function reduceImageWorkbenchViewState(
  state: ImageWorkbenchViewState,
  action: ImageWorkbenchViewAction,
): ImageWorkbenchViewState {
  const next = copyState(state)
  switch (action.kind) {
    case 'select-project':
      return {
        ...next,
        ...(action.project_id ? { selected_project_id: action.project_id } : {}),
        ...(action.project_id ? {} : { selected_project_id: undefined }),
        selected_candidate_id: undefined,
        selected_canvas_id: undefined,
        selected_artboard_id: undefined,
        drag_draft: undefined,
      }
    case 'select-candidate':
      return { ...next, selected_candidate_id: action.candidate_id }
    case 'select-canvas':
      return { ...next, selected_canvas_id: action.canvas_id, drag_draft: undefined }
    case 'select-artboard':
      return { ...next, selected_artboard_id: action.artboard_id }
    case 'open-panel':
      return {
        ...next,
        active_panel: action.panel,
        expanded_panels: distinctPanels([...next.expanded_panels, action.panel]),
      }
    case 'set-panel-expanded': {
      const expandedPanels = action.expanded
        ? distinctPanels([...next.expanded_panels, action.panel])
        : next.expanded_panels.filter(panel => panel !== action.panel)
      return {
        ...next,
        active_panel: !action.expanded && next.active_panel === action.panel ? 'quick-create' : next.active_panel,
        expanded_panels: distinctPanels(
          (!action.expanded && next.active_panel === action.panel)
            ? [...expandedPanels, 'quick-create']
            : expandedPanels,
        ),
      }
    }
    case 'begin-drag':
      return { ...next, drag_draft: { ...action.draft, origin: { ...action.draft.origin }, current: { ...action.draft.current } } }
    case 'update-drag':
      return next.drag_draft
        ? { ...next, drag_draft: { ...next.drag_draft, current: { ...action.current } } }
        : next
    case 'discard-drag':
      return { ...next, drag_draft: undefined }
    case 'advance-event-cursor':
      return action.cursor >= 0 && Number.isInteger(action.cursor)
        ? {
            ...next,
            event_cursors: {
              ...next.event_cursors,
              [action.project_id]: Math.max(next.event_cursors[action.project_id] ?? 0, action.cursor),
            },
          }
        : next
  }
}

function flattenLayerIds(layers: readonly ImageCanvasLayer[]): readonly string[] {
  const ids: string[] = []
  const visit = (items: readonly ImageCanvasLayer[]): void => {
    for (const layer of items) {
      ids.push(layer.id)
      if (layer.kind === 'group') visit(layer.children)
    }
  }
  visit(layers)
  return ids
}

export function imageWorkbenchSelectionIndex(
  projection: ImageWorkbenchProjectProjection,
): ImageWorkbenchSelectionIndex {
  const canvasLayerIds: Record<string, readonly string[]> = {}
  for (const canvas of projection.canvases) {
    canvasLayerIds[canvas.canvas_id] = flattenLayerIds(canvas.document.layers)
  }
  return {
    project_id: projection.project.id,
    candidate_ids: projection.candidate_groups.flatMap(group => group.candidates.map(candidate => candidate.id)),
    canvas_ids: projection.canvases.map(canvas => canvas.canvas_id),
    artboard_ids: projection.delivery_spec?.artboards.map(artboard => artboard.id) ?? [],
    canvas_layer_ids: canvasLayerIds,
  }
}

/** Drop selections that no longer exist in a freshly-read server projection. */
export function reconcileImageWorkbenchViewState(
  state: ImageWorkbenchViewState,
  index: ImageWorkbenchSelectionIndex,
): ImageWorkbenchViewState {
  const selectedProject = state.selected_project_id === index.project_id ? index.project_id : undefined
  const selectedCandidate = selectedProject && state.selected_candidate_id && index.candidate_ids.includes(state.selected_candidate_id)
    ? state.selected_candidate_id
    : undefined
  const selectedCanvas = selectedProject && state.selected_canvas_id && index.canvas_ids.includes(state.selected_canvas_id)
    ? state.selected_canvas_id
    : undefined
  const selectedArtboard = selectedProject && state.selected_artboard_id && index.artboard_ids.includes(state.selected_artboard_id)
    ? state.selected_artboard_id
    : undefined
  const draft = state.drag_draft
  const retainedDraft = selectedProject && draft && draft.project_id === index.project_id && index.canvas_layer_ids[draft.canvas_id]?.includes(draft.layer_id)
    ? draft
    : undefined
  return {
    ...copyState(state),
    selected_project_id: selectedProject,
    selected_candidate_id: selectedCandidate,
    selected_canvas_id: selectedCanvas,
    selected_artboard_id: selectedArtboard,
    drag_draft: retainedDraft,
  }
}

/**
 * Event payloads advance only the durable cursor.  The caller must fetch a
 * new public projection whenever an event is seen (or the server demands a
 * reset); it must never try to apply a business mutation from an event.
 */
export function planImageWorkbenchRestore(
  state: ImageWorkbenchViewState,
  projectId: string,
  eventPage: PublicMediaJobEventPage,
): ImageWorkbenchRestorePlan {
  const cursor = Math.max(state.event_cursors[projectId] ?? 0, eventPage.cursor)
  return {
    view_state: reduceImageWorkbenchViewState(state, {
      kind: 'advance-event-cursor',
      project_id: projectId,
      cursor,
    }),
    event_cursor: cursor,
    reload_projection: eventPage.reset_required || eventPage.events.length > 0,
  }
}
