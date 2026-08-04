const { execFileSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')

function readJsonObject(file, label) {
  if (!existsSync(file)) {
    throw new Error(`Cannot package BilliardBuddy: missing ${label} at ${file}`)
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object')
    return parsed
  } catch (error) {
    throw new Error(`Cannot package BilliardBuddy: invalid ${label} (${error.message})`)
  }
}

function isAllowedProductRoute(url, pathname) {
  return url.protocol === 'https:'
    && url.hostname.length > 0
    && !url.username
    && !url.password
    && !url.search
    && !url.hash
    && url.pathname.replace(/\/+$/, '') === pathname
}

function requireProductRoute(publicConfig, key, pathname, label) {
  if (typeof publicConfig[key] !== 'string' || !publicConfig[key].trim()) {
    throw new Error(`Cannot package BilliardBuddy: product-config.json is missing ${key}`)
  }
  let url
  try {
    url = new URL(publicConfig[key])
  } catch {
    throw new Error(`Cannot package BilliardBuddy: product-config.json contains an invalid ${key}`)
  }
  if (!isAllowedProductRoute(url, pathname)) {
    throw new Error(`Cannot package BilliardBuddy: ${label} must use HTTPS at the ${pathname} endpoint`)
  }
}

function validateProductPackageFiles(desktopDir = path.join(__dirname, '..')) {
  const buildDir = path.join(desktopDir, 'build')
  const publicConfig = readJsonObject(path.join(buildDir, 'product-config.json'), 'product-config.json')
  const secretsPath = path.join(buildDir, 'product-secrets.json')

  const unexpectedPublicKeys = Object.keys(publicConfig).filter(key => !['$comment', 'gatewayUrl', 'imageRelayUrl', 'videoMediaRelayUrl'].includes(key))
  if (unexpectedPublicKeys.length > 0) {
    throw new Error(`Cannot package BilliardBuddy: product-config.json contains unsupported fields: ${unexpectedPublicKeys.join(', ')}`)
  }
  if (['gatewayToken', 'gatewayBootstrapCredential', 'licenseKey'].some(key => typeof publicConfig[key] === 'string' && publicConfig[key].trim())) {
    throw new Error('Cannot package BilliardBuddy: credentials must not be stored in public product-config.json')
  }
  if (existsSync(secretsPath)) {
    throw new Error('Cannot package BilliardBuddy: product-secrets.json must not be included')
  }
  requireProductRoute(publicConfig, 'gatewayUrl', '/gw', 'gatewayUrl')
  requireProductRoute(publicConfig, 'imageRelayUrl', '/image-generation', 'imageRelayUrl')
  requireProductRoute(publicConfig, 'videoMediaRelayUrl', '/video-media', 'videoMediaRelayUrl')
}

async function beforePack() {
  validateProductPackageFiles()
  execFileSync('bun', [path.join(__dirname, 'stage-media-toolchain.ts'), '--verify'], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    stdio: 'inherit',
  })
  execFileSync('bun', [path.join(__dirname, 'stage-codex-engine.ts'), '--verify'], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    stdio: 'inherit',
  })
}

module.exports = beforePack
module.exports.validateProductPackageFiles = validateProductPackageFiles
