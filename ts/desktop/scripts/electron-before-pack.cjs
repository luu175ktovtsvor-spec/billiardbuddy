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

function validateProductPackageFiles(desktopDir = path.join(__dirname, '..')) {
  const buildDir = path.join(desktopDir, 'build')
  const publicConfig = readJsonObject(path.join(buildDir, 'product-config.json'), 'product-config.json')
  const secrets = readJsonObject(path.join(buildDir, 'product-secrets.json'), 'product-secrets.json')

  if (typeof publicConfig.gatewayToken === 'string' && publicConfig.gatewayToken.trim()) {
    throw new Error('Cannot package BilliardBuddy: gatewayToken must not be stored in public product-config.json')
  }
  if (typeof publicConfig.gatewayUrl !== 'string' || !publicConfig.gatewayUrl.trim()) {
    throw new Error('Cannot package BilliardBuddy: product-config.json is missing gatewayUrl')
  }
  let gatewayUrl
  try {
    gatewayUrl = new URL(publicConfig.gatewayUrl)
  } catch {
    throw new Error('Cannot package BilliardBuddy: product-config.json contains an invalid gatewayUrl')
  }
  if (gatewayUrl.protocol !== 'https:' && gatewayUrl.protocol !== 'http:') {
    throw new Error('Cannot package BilliardBuddy: gatewayUrl must use HTTP or HTTPS')
  }
  if (typeof secrets.gatewayToken !== 'string' || !secrets.gatewayToken.trim()) {
    throw new Error('Cannot package BilliardBuddy: product-secrets.json is missing gatewayToken')
  }
}

async function beforePack() {
  validateProductPackageFiles()
  execFileSync('bun', [path.join(__dirname, 'stage-media-toolchain.ts'), '--verify'], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    stdio: 'inherit',
  })
}

module.exports = beforePack
module.exports.validateProductPackageFiles = validateProductPackageFiles
