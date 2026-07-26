import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyGatewayConfigToEnv,
  ProductGatewayConfigError,
  requireProductGatewayConfig,
  resolveProductGatewayConfig,
} from './productConfig'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-product-config-'))
  tempDirs.push(dir)
  return dir
}

function writeJson(dir: string, name: string, value: unknown): void {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value))
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveProductGatewayConfig', () => {
  it('reads the public URL and ignores packaged model selection', () => {
    const dir = tempDir()
    writeJson(dir, 'product-config.json', {
      gatewayUrl: 'https://gw.example/gw',
      gatewayModel: 'unregistered-model',
    })
    writeJson(dir, 'product-secrets.json', { gatewayBootstrapCredential: 'packaged-bootstrap', licenseKey: 'license-001' })

    const cfg = resolveProductGatewayConfig({ isPackaged: true, resourcesPath: dir, env: {} })
    expect(cfg).toEqual({
      url: 'https://gw.example/gw',
      token: 'packaged-bootstrap',
      licenseKey: 'license-001',
    })
  })

  it('resolves from the dev build dir when not packaged', () => {
    const dir = tempDir()
    writeJson(dir, 'product-config.json', { gatewayUrl: 'https://dev.example/gw' })

    const cfg = resolveProductGatewayConfig({ isPackaged: false, devBuildDir: dir, env: {} })
    expect(cfg.url).toBe('https://dev.example/gw')
    expect(cfg.token).toBeUndefined()
  })

  it('lets env override the packaged URL and activation fields but not the model', () => {
    const dir = tempDir()
    writeJson(dir, 'product-config.json', { gatewayUrl: 'https://packaged/gw', gatewayModel: 'packaged-model' })
    writeJson(dir, 'product-secrets.json', { gatewayBootstrapCredential: 'packaged-bootstrap', licenseKey: 'packaged-license' })

    const cfg = resolveProductGatewayConfig({
      isPackaged: true,
      resourcesPath: dir,
      env: { BB_GATEWAY_URL: 'https://override/gw', BB_GATEWAY_BOOTSTRAP_CREDENTIAL: 'env-bootstrap', BB_LICENSE_KEY: 'env-license', BB_GATEWAY_MODEL: 'env-model' },
    })
    expect(cfg).toEqual({ url: 'https://override/gw', token: 'env-bootstrap', licenseKey: 'env-license' })
  })

  it('does not treat legacy BB_GATEWAY_TOKEN as a bootstrap credential', () => {
    const cfg = resolveProductGatewayConfig({
      isPackaged: false,
      env: { BB_GATEWAY_URL: 'https://gw.example/gw', BB_GATEWAY_TOKEN: 'legacy-access' },
    })
    expect(cfg.token).toBeUndefined()
    expect(() => requireProductGatewayConfig(cfg)).toThrow('missing bootstrap credential')
  })

  it('never reads the token from public product-config.json', () => {
    const dir = tempDir()
    // A token accidentally placed in the PUBLIC file must be ignored.
    writeJson(dir, 'product-config.json', {
      gatewayUrl: 'https://gw.example/gw',
      gatewayToken: 'leaked-into-public-config',
    })

    const cfg = resolveProductGatewayConfig({ isPackaged: true, resourcesPath: dir, env: {} })
    expect(cfg.url).toBe('https://gw.example/gw')
    expect(cfg.token).toBeUndefined()
  })

  it('returns undefined fields when no config files and no env are present', () => {
    const dir = tempDir()
    const cfg = resolveProductGatewayConfig({ isPackaged: true, resourcesPath: dir, env: {} })
    expect(cfg).toEqual({ url: undefined, token: undefined, licenseKey: undefined })
  })

  it('tolerates malformed JSON without throwing', () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'product-config.json'), '{ not json')
    const cfg = resolveProductGatewayConfig({
      isPackaged: true,
      resourcesPath: dir,
      env: { BB_GATEWAY_URL: 'https://env-only/gw' },
    })
    expect(cfg.url).toBe('https://env-only/gw')
  })
})

describe('applyGatewayConfigToEnv', () => {
  it('injects gateway config into the server env when absent', () => {
    const out = applyGatewayConfigToEnv(
      { PATH: '/usr/bin' },
      { url: 'https://gw/gw', token: 'app-token' },
    )
    expect(out.BB_GATEWAY_URL).toBe('https://gw/gw')
    expect(out.BB_GATEWAY_TOKEN).toBeUndefined()
    expect(out.BB_GATEWAY_MODEL).toBe('deepseek-v4-flash')
    expect(out.PATH).toBe('/usr/bin')
  })

  it('overrides an inherited model with the registry default', () => {
    const out = applyGatewayConfigToEnv({ PATH: '/usr/bin', BB_GATEWAY_MODEL: 'unregistered-model' }, { url: 'https://gw/gw', token: 'app-token' })
    expect(out.BB_GATEWAY_MODEL).toBe('deepseek-v4-flash')
  })

  it('never overrides an existing shell/ops value', () => {
    const out = applyGatewayConfigToEnv(
      { BB_GATEWAY_URL: 'https://ops-override/gw', BB_GATEWAY_TOKEN: 'ops-token' },
      { url: 'https://packaged/gw', token: 'packaged-token' },
    )
    expect(out.BB_GATEWAY_URL).toBe('https://ops-override/gw')
    expect(out.BB_GATEWAY_TOKEN).toBe('ops-token')
  })

  it('leaves the env untouched for the adapter path (no gateway config)', () => {
    const base = { PATH: '/usr/bin' }
    // Adapter sidecars pass undefined → same object back, so the token never leaks to them.
    expect(applyGatewayConfigToEnv(base, undefined)).toBe(base)
  })
})

describe('requireProductGatewayConfig', () => {
  it('returns a complete managed gateway config', () => {
    expect(requireProductGatewayConfig({
      url: 'https://gw.example/gw',
      token: 'app-token',
      licenseKey: 'license-001',
    })).toEqual({
      url: 'https://gw.example/gw',
      token: 'app-token',
      licenseKey: 'license-001',
    })
  })

  it('fails closed instead of allowing desktop provider fallback', () => {
    expect(() => requireProductGatewayConfig({
      url: 'https://gw.example/gw',
    })).toThrow(new ProductGatewayConfigError(
      'Product gateway is not configured: missing bootstrap credential.',
    ))
    expect(() => requireProductGatewayConfig({
      url: 'file:///tmp/gateway',
      token: 'app-token',
    })).toThrow('gateway URL must use HTTPS at the /gw endpoint')
    expect(() => requireProductGatewayConfig({
      url: 'http://39.106.214.21/gw',
      token: 'app-token',
    })).toThrow('gateway URL must use HTTPS at the /gw endpoint')
    expect(() => requireProductGatewayConfig({
      url: 'https://gateway.example',
      token: 'app-token',
    })).toThrow('gateway URL must use HTTPS at the /gw endpoint')
    expect(() => requireProductGatewayConfig({
      url: 'https://app-token@gateway.example/gw',
      token: 'app-token',
    })).toThrow('gateway URL must use HTTPS at the /gw endpoint')
    expect(() => requireProductGatewayConfig({
      url: 'https://gateway.example/gw?override=true',
      token: 'app-token',
    })).toThrow('gateway URL must use HTTPS at the /gw endpoint')
  })
})
