import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { validateProductPackageFiles } = require('./electron-before-pack.cjs') as {
  validateProductPackageFiles: (desktopDir: string) => void
}

const tempDirs: string[] = []

function createDesktopBuild(
  publicConfig: Record<string, unknown>,
  secrets?: Record<string, unknown>,
): string {
  const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-before-pack-'))
  tempDirs.push(desktopDir)
  const buildDir = path.join(desktopDir, 'build')
  fs.mkdirSync(buildDir)
  fs.writeFileSync(path.join(buildDir, 'product-config.json'), JSON.stringify(publicConfig))
  if (secrets) {
    fs.writeFileSync(path.join(buildDir, 'product-secrets.json'), JSON.stringify(secrets))
  }
  return desktopDir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('desktop product package config', () => {
  it('accepts a public gateway URL and a separately staged app token', () => {
    const desktopDir = createDesktopBuild(
      { gatewayUrl: 'https://gw.example/gw', gatewayModel: 'deepseek-v4-flash' },
      { gatewayToken: 'revocable-app-token' },
    )
    expect(() => validateProductPackageFiles(desktopDir)).not.toThrow()
  })

  it('blocks an installer that would have no usable product gateway token', () => {
    const desktopDir = createDesktopBuild({ gatewayUrl: 'https://gw.example/gw' })
    expect(() => validateProductPackageFiles(desktopDir)).toThrow('missing product-secrets.json')
  })

  it('blocks accidental placement of the token in the public config', () => {
    const desktopDir = createDesktopBuild(
      { gatewayUrl: 'https://gw.example/gw', gatewayToken: 'public-leak' },
      { gatewayToken: 'revocable-app-token' },
    )
    expect(() => validateProductPackageFiles(desktopDir)).toThrow(
      'gatewayToken must not be stored in public product-config.json',
    )
  })

  it('blocks a package that would send the managed app token over HTTP', () => {
    const desktopDir = createDesktopBuild(
      { gatewayUrl: 'http://39.106.214.21/gw' },
      { gatewayToken: 'revocable-app-token' },
    )
    expect(() => validateProductPackageFiles(desktopDir)).toThrow('gatewayUrl must use HTTPS at the /gw endpoint')
  })

  it('blocks a secure URL that is not the product gateway base path', () => {
    const desktopDir = createDesktopBuild(
      { gatewayUrl: 'https://gateway.example', gatewayModel: 'deepseek-v4-flash' },
      { gatewayToken: 'revocable-app-token' },
    )
    expect(() => validateProductPackageFiles(desktopDir)).toThrow('gatewayUrl must use HTTPS at the /gw endpoint')
  })
})
