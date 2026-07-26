const { execFileSync } = require('node:child_process')
const path = require('node:path')

function packagePlatform(context) {
  const platform = context.electronPlatformName ?? context.packager?.platform?.nodeName
  if (platform === 'darwin' || platform === 'win32') return platform
  throw new Error(`Cannot package BilliardBuddy: unsupported media toolchain platform ${platform ?? 'unknown'}`)
}

function packagedMediaToolchainDir(context) {
  if (!context?.appOutDir) throw new Error('Cannot package BilliardBuddy: Electron afterPack context is missing appOutDir')
  const platform = packagePlatform(context)
  const productFilename = context.packager?.appInfo?.productFilename
  if (platform === 'darwin' && (!productFilename || typeof productFilename !== 'string')) {
    throw new Error('Cannot package BilliardBuddy: Electron afterPack context is missing productFilename')
  }

  const resourcesDir = platform === 'darwin'
    ? path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  return path.join(resourcesDir, 'app.asar.unpacked', 'runtime-assets', 'binaries')
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

module.exports = validatePackagedMediaToolchain
module.exports.afterPack = validatePackagedMediaToolchain
module.exports.packagePlatform = packagePlatform
module.exports.packagedMediaToolchainDir = packagedMediaToolchainDir
