import { describe, expect, it } from 'vitest'
import { requireReadyProductWindow } from './package-window-smoke'

describe('packaged window acceptance', () => {
  it('requires both renderer load and a visible final product window', () => {
    expect(requireReadyProductWindow([
      { reason: 'after-create', visible: false },
      { reason: 'did-finish-load', visible: true },
      { reason: 'backend-ready' },
      {
        reason: 'after-final-show',
        destroyed: false,
        visible: true,
        minimized: false,
        title: 'BilliardBuddy',
        url: 'file:///Applications/BilliardBuddy.app/Contents/Resources/app.asar/dist/index.html',
      },
    ])).toMatchObject({ reason: 'after-final-show', visible: true })
  })

  it('rejects a nominal process start without a usable product window', () => {
    expect(() => requireReadyProductWindow([
      { reason: 'did-finish-load', visible: true },
      { reason: 'backend-ready' },
      {
        reason: 'after-final-show',
        destroyed: false,
        visible: false,
        minimized: false,
        title: 'BilliardBuddy',
        url: 'file:///app.asar/dist/index.html',
      },
    ])).toThrow('未正常显示')
  })

  it('rejects a visible shell whose local product backend never became ready', () => {
    expect(() => requireReadyProductWindow([
      { reason: 'did-finish-load', visible: true },
      {
        reason: 'after-final-show',
        destroyed: false,
        visible: true,
        minimized: false,
        title: 'BilliardBuddy',
        url: 'file:///app.asar/dist/index.html',
      },
    ])).toThrow('backend-ready')
  })
})
