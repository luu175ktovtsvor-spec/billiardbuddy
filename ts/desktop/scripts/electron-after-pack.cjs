const { execFileSync } = require('node:child_process')
const path = require('node:path')
const { Arch } = require('builder-util')

function packagePlatform(context) {
  const platform = context.electronPlatformName ?? context.packager?.platform?.nodeName
  if (platform === 'darwin' || platform === 'win32') return platform
  throw new Error(`Cannot package BilliardBuddy: unsupported media toolchain platform ${platform ?? 'unknown'}`)
}

function packagedTarget(context) {
  const platform = packagePlatform(context)
  if (platform === 'darwin') return 'aarch64-apple-darwin'
  const configured = process.env.BILLIARDBUDDY_WINDOWS_TARGET
  const contextTarget = context.arch === Arch.x64 || context.arch === 'x64'
    ? 'x86_64-pc-windows-msvc'
    : context.arch === Arch.arm64 || context.arch === 'arm64'
      ? 'aarch64-pc-windows-msvc'
      : undefined
  if (!contextTarget) {
    throw new Error(`Cannot package BilliardBuddy: unsupported Windows package architecture ${context.arch ?? 'unknown'}`)
  }
  if (configured !== undefined
    && configured !== 'x86_64-pc-windows-msvc'
    && configured !== 'aarch64-pc-windows-msvc') {
    throw new Error(`Cannot package BilliardBuddy: invalid configured Windows target ${configured}`)
  }
  if (configured && configured !== contextTarget) {
    throw new Error(`Cannot package BilliardBuddy: configured Windows target ${configured} does not match Electron package ${contextTarget}`)
  }
  return configured ?? contextTarget
}

function packagedResourcesDir(context) {
  if (!context?.appOutDir) throw new Error('Cannot package BilliardBuddy: Electron afterPack context is missing appOutDir')
  const platform = packagePlatform(context)
  const productFilename = context.packager?.appInfo?.productFilename
  if (platform === 'darwin' && (!productFilename || typeof productFilename !== 'string')) {
    throw new Error('Cannot package BilliardBuddy: Electron afterPack context is missing productFilename')
  }

  const resourcesDir = platform === 'darwin'
    ? path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  return resourcesDir
}

function packagedMediaToolchainDir(context) {
  return path.join(packagedResourcesDir(context), 'app.asar.unpacked', 'runtime-assets', 'binaries')
}

function validatePackagedMediaToolchain(context) {
  const platform = packagePlatform(context)
  const toolchainDir = packagedMediaToolchainDir(context)
  try {
    execFileSync('bun', [
      path.join(__dirname, 'stage-media-toolchain.ts'),
      '--verify',
      '--platform',
      platform,
      '--destination',
      toolchainDir,
    ], {
      cwd: path.join(__dirname, '..'),
      env: process.env,
      encoding: 'utf8',
      stdio: 'pipe',
    })
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || 'unknown verifier error').trim()
    throw new Error(`Cannot package BilliardBuddy: packaged FFmpeg/ffprobe verification failed at ${toolchainDir}: ${detail}`)
  }
  console.log(`[media-toolchain] verified packaged FFmpeg/ffprobe for ${platform}`)
}

function validatePackagedCodexEngine(context) {
  const target = packagedTarget(context)
  const toolchainDir = packagedMediaToolchainDir(context)
  try {
    execFileSync('bun', [
      path.join(__dirname, 'stage-codex-engine.ts'),
      '--verify',
      '--target', target,
      '--destination', toolchainDir,
    ], {
      cwd: path.join(__dirname, '..'),
      env: process.env,
      encoding: 'utf8',
      stdio: 'pipe',
    })
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || 'unknown verifier error').trim()
    throw new Error(`Cannot package BilliardBuddy: packaged Codex engine verification failed at ${toolchainDir}: ${detail}`)
  }
  console.log(`[codex-engine] verified packaged App Server for ${target}`)
}

function validatePackagedAgentPlugins(context) {
  const target = packagedTarget(context)
  const destination = path.join(path.dirname(packagedMediaToolchainDir(context)), 'agent-marketplace', 'plugins')
  for (const script of ['stage-agent-plugins.ts', 'stage-chrome-plugin.ts', 'stage-browser-plugin.ts', 'stage-record-replay-plugin.ts']) {
    try {
      execFileSync('bun', [
        path.join(__dirname, script),
        '--verify',
        '--target', target,
        '--destination', destination,
      ], {
        cwd: path.join(__dirname, '..'),
        env: process.env,
        encoding: 'utf8',
        stdio: 'pipe',
      })
    } catch (error) {
      const detail = String(error?.stderr || error?.stdout || error?.message || 'unknown verifier error').trim()
      throw new Error(`Cannot package BilliardBuddy: packaged local plugin verification failed (${script}) at ${destination}: ${detail}`)
    }
  }
  console.log(`[agent-plugins] verified packaged local plugins for ${target}`)
}

function validatePackagedRuntimeAssets(context) {
  if (process.env.BB_AGENT_ONLY_BUILD !== '1') {
    validatePackagedMediaToolchain(context)
  } else {
    console.log('[package] Agent-only build: skipped packaged media toolchain verification')
  }
  validatePackagedCodexEngine(context)
  validatePackagedAgentPlugins(context)
  const platform = packagePlatform(context)
  const resources = packagedResourcesDir(context)
  try {
    execFileSync('bun', [
      path.join(__dirname, 'audit-packaged-resources.ts'),
      '--platform', platform,
      '--target', packagedTarget(context),
      '--resources', resources,
    ], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || 'unknown verifier error').trim()
    throw new Error(`Cannot package BilliardBuddy: packaged resource audit failed: ${detail}`)
  }
}

module.exports = validatePackagedRuntimeAssets
module.exports.afterPack = validatePackagedRuntimeAssets
module.exports.packagePlatform = packagePlatform
module.exports.packagedTarget = packagedTarget
module.exports.packagedResourcesDir = packagedResourcesDir
module.exports.packagedMediaToolchainDir = packagedMediaToolchainDir
module.exports.validatePackagedCodexEngine = validatePackagedCodexEngine
module.exports.validatePackagedAgentPlugins = validatePackagedAgentPlugins
