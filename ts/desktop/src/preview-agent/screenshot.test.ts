import { beforeEach, describe, expect, it } from 'vitest'
import { createAnnotationOverlay } from './screenshot'

beforeEach(() => {
  document.body.innerHTML = '<button id="target">保存</button>'
})

describe('createAnnotationOverlay', () => {
  it('marks the selected region without changing the selected element', () => {
    const target = document.getElementById('target')!
    target.getBoundingClientRect = () => ({
      x: 12,
      y: 24,
      width: 80,
      height: 32,
      top: 24,
      right: 92,
      bottom: 56,
      left: 12,
      toJSON: () => ({}),
    }) as DOMRect

    const overlay = createAnnotationOverlay(target, 1)

    expect(overlay.dataset.previewSelectionAnnotationRoot).toBe('true')
    expect(overlay.querySelector('[data-preview-selection-annotation]')).not.toBeNull()
    expect(overlay.querySelector('[data-preview-selection-badge]')?.textContent).toBe('1')
    expect(target.outerHTML).toBe('<button id="target">保存</button>')

    overlay.remove()
  })
})
