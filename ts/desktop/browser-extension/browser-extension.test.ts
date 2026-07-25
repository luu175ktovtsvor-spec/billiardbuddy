import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BILLIARDBUDDY_BROWSER_EXTENSION_ID } from '../../shared/product/browserNativeHost'

const root = path.resolve(import.meta.dirname)

function extensionId(publicKey: string): string {
  const digest = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 32)
  return [...digest].map(value => String.fromCharCode(97 + Number.parseInt(value, 16))).join('')
}

describe('BilliardBuddy recruiting browser extension', () => {
  it('has a stable ID and only the narrow BOSS/native messaging permissions', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as {
      key: string
      permissions: string[]
      host_permissions: string[]
      content_scripts: Array<{ matches: string[] }>
    }
    expect(extensionId(manifest.key)).toBe(BILLIARDBUDDY_BROWSER_EXTENSION_ID)
    expect(manifest.permissions.sort()).toEqual(['activeTab', 'nativeMessaging', 'storage'])
    expect(manifest.host_permissions.sort()).toEqual(['https://*.zhipin.com/*', 'https://zhipin.com/*'])
    expect(manifest.content_scripts[0]?.matches.sort()).toEqual(manifest.host_permissions.sort())
    expect(JSON.stringify(manifest)).not.toMatch(/cookies|debugger|desktopCapture|tabCapture|<all_urls>/i)
  })

  it('uses structured DOM evidence and contains no cookie, screenshot, or coordinate-control path', () => {
    const content = fs.readFileSync(path.join(root, 'content-script.js'), 'utf8')
    const worker = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8')
    expect(`${content}\n${worker}`).not.toMatch(/chrome\.cookies|captureVisibleTab|desktopCapture|debugger|screenX|screenY|clientX|clientY/)
    expect(content).toContain('PROTECTED_TEXT')
    expect(content).toContain('candidate_ref')
    expect(content).toContain('SEND_ACK_NOT_OBSERVED')
    expect(content).toContain('ACTION_ACK_NOT_OBSERVED')
    expect(worker).toContain('connectNative')
    expect(worker).toContain('browser_action_results')
  })
})
