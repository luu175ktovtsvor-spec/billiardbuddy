import { create } from 'zustand'
import type { RuntimeSelection } from '../types/runtime'

const STORAGE_KEY = 'billiardbuddy-session-runtime'

export const DRAFT_RUNTIME_SELECTION_KEY = '__draft__'

type SessionRuntimeStore = {
  selections: Record<string, RuntimeSelection>
  setSelection: (key: string, selection: RuntimeSelection) => void
  clearSelection: (key: string) => void
  moveSelection: (fromKey: string, toKey: string) => void
}

function loadSelections(): Record<string, RuntimeSelection> {
  // Runtime selection is product-managed. Drop legacy persisted overrides so an
  // upgraded install cannot silently keep using a provider/model that the UI no
  // longer exposes. Current-process selections remain available for session
  // startup and reconnects, but never survive an app restart.
  try { localStorage?.removeItem(STORAGE_KEY) } catch { /* unavailable */ }
  return {}
}

export const useSessionRuntimeStore = create<SessionRuntimeStore>((set) => ({
  selections: loadSelections(),

  setSelection: (key, selection) =>
    set((state) => {
      const selections = {
        ...state.selections,
        [key]: selection,
      }
      return { selections }
    }),

  clearSelection: (key) =>
    set((state) => {
      if (!(key in state.selections)) return state
      const { [key]: _removed, ...rest } = state.selections
      return { selections: rest }
    }),

  moveSelection: (fromKey, toKey) =>
    set((state) => {
      const selection = state.selections[fromKey]
      if (!selection) return state
      const { [fromKey]: _removed, ...rest } = state.selections
      const selections = {
        ...rest,
        [toKey]: selection,
      }
      return { selections }
    }),
}))
