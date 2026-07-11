// 输入框草稿桥(用户消息「编辑」→ 把文本回填输入框重编;其他地方也能往输入框塞文本)。
import { create } from 'zustand'

interface ComposerState {
  draft: string | null
  setDraft: (text: string) => void
  clearDraft: () => void
}

export const useComposerStore = create<ComposerState>((set) => ({
  draft: null,
  setDraft: (text) => set({ draft: text }),
  clearDraft: () => set({ draft: null }),
}))
