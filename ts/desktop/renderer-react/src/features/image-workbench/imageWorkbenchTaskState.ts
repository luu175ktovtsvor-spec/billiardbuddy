import type { WorkbenchAction } from './imageWorkbenchTypes'

export type WorkbenchPane = 'create' | 'canvas' | 'adjust'

export interface ImageWorkbenchTaskState {
  busy: boolean
  progress: number
  stage: string
  activeJobId: string | null
  lastError: string
  lastFailedAction: WorkbenchAction | null
  pane: WorkbenchPane
}

export const initialImageWorkbenchTaskState: ImageWorkbenchTaskState = {
  busy: false,
  progress: 0,
  stage: '',
  activeJobId: null,
  lastError: '',
  lastFailedAction: null,
  pane: 'create',
}

export type ImageWorkbenchTaskAction =
  | { type: 'begin'; stage: string }
  | { type: 'begin-local'; stage: string }
  | { type: 'job-started'; jobId: string }
  | { type: 'stage'; stage: string }
  | { type: 'progress'; progress: number; stage: string }
  | { type: 'failed'; message: string; action?: WorkbenchAction }
  | { type: 'cancel-requested' }
  | { type: 'finish' }
  | { type: 'select-pane'; pane: WorkbenchPane }

export function imageWorkbenchTaskReducer(
  state: ImageWorkbenchTaskState,
  action: ImageWorkbenchTaskAction,
): ImageWorkbenchTaskState {
  switch (action.type) {
    case 'begin':
      return {
        ...state,
        busy: true,
        progress: 0,
        stage: action.stage,
        activeJobId: null,
        lastError: '',
        lastFailedAction: null,
        pane: 'canvas',
      }
    case 'begin-local':
      return { ...state, busy: true, stage: action.stage }
    case 'job-started':
      return { ...state, activeJobId: action.jobId }
    case 'stage':
      return { ...state, stage: action.stage }
    case 'progress':
      return { ...state, progress: action.progress, stage: action.stage }
    case 'failed':
      return {
        ...state,
        lastError: action.message,
        ...(action.action ? { lastFailedAction: action.action } : {}),
      }
    case 'cancel-requested':
      return { ...state, busy: false, stage: '已请求取消', lastError: '已取消' }
    case 'finish':
      return { ...state, busy: false, activeJobId: null, stage: '' }
    case 'select-pane':
      return { ...state, pane: action.pane }
  }
}
