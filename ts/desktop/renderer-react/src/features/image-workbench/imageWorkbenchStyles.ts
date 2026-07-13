// 生图工作台通用样式 token：面板、输入框、按钮和分段选中态。

export const panelStyle = {
  border: '1px solid var(--color-border)',
  background: 'var(--color-surface-container-low)',
} as const

export const inputStyle = {
  background: 'var(--color-app-main)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)',
} as const

export const buttonPrimaryStyle = {
  background: 'var(--color-brand)',
  color: 'var(--color-on-primary)',
} as const

export const buttonSubtleStyle = {
  background: 'var(--color-surface-container)',
  color: 'var(--color-text-secondary)',
  border: '1px solid var(--color-border)',
} as const

export function segStyle(active: boolean) {
  return {
    background: active ? 'var(--color-surface-selected)' : 'transparent',
    color: active ? 'var(--color-brand)' : 'var(--color-text-secondary)',
    border: '1px solid transparent',
  } as const
}
