// 轻量 toast(全局操作反馈:复制成功 / 即将上线 等)。自动 2.2s 消失。
import { create } from 'zustand'

export interface Toast { id: number; text: string }

interface ToastState {
  toasts: Toast[]
  show: (text: string) => void
  dismiss: (id: number) => void
}

let seq = 0

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show: (text) => {
    const id = ++seq
    set({ toasts: [{ id, text }] })
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 2200)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

/** 组件外快捷调用(菜单项等)。 */
export const toast = (text: string) => useToastStore.getState().show(text)
