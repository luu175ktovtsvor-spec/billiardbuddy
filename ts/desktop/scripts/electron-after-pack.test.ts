import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stageMediaToolchain } from './stage-media-toolchain'

const require = createRequire(import.meta.url)
const afterPack = require('./electron-after-pack.cjs') as {
  (context: unknown): void
  packagePlatform: (context: unknown) => 'darwin' | 'win32'
  packagedMediaToolchainDir: (context: unknown) => string
}

const roots: string[] = []

function temp(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bb-after-pack-'))
  roots.push(directory)
  return directory
}

function hash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function fixtureToolchain(): string {
  const source = temp()
  for (const name of ['ffmpeg', 'ffprobe']) {
    const binary = join(source, name)
    writeFileSync(binary, `#!/bin/sh
case "$*" in
  *-buildconf*) echo '${name} version 7.1-test'; echo 'configuration: --enable-shared --disable-static' ;;
  *-version*) echo '${name} version 7.1-test'; echo 'configuration: --enable-shared --disable-static' ;;
  *-L*) echo 'This version of ${name} is licensed under the GNU Lesser General Public License.' ;;
  *) exit 2 ;;
esac
`)
    chmodSync(binary, 0o755)
  }
  writeFileSync(join(source, 'LICENSE.txt'), 'GNU LESSER GENERAL PUBLIC LICENSE\n')
  writeFileSync(join(source, 'media-toolchain-source.json'), JSON.stringify({
    schemaVersion: 1,
    version: '7.1-test',
    license: 'LGPL-2.1-or-later',
    sourceUrl: 'https://ffmpeg.org/releases/ffmpeg-7.1.tar.xz',
    licenseSha256: hash(join(source, 'LICENSE.txt')),
    files: {
      ffmpeg: hash(join(source, 'ffmpeg')),
      ffprobe: hash(join(source, 'ffprobe')),
    },
  }))
  return source
}

function packagedContext() {
  const appOutDir = temp()
  const toolchainDir = join(
    appOutDir,
    'BilliardBuddy.app',
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'src-tauri',
    'binaries',
  )
  mkdirSync(toolchainDir, { recursive: true })
  const source = fixtureToolchain()
  const staged = temp()
  stageMediaToolchain({ sourceDir: source, destinationDir: staged, platform: 'darwin' })
  for (const file of ['ffmpeg', 'ffprobe', 'media-toolchain-manifest.json', 'media-toolchain-LICENSE.txt']) {
    copyFileSync(join(staged, file), join(toolchainDir, file))
  }
  chmodSync(join(toolchainDir, 'ffmpeg'), 0o755)
  chmodSync(join(toolchainDir, 'ffprobe'), 0o755)
  return {
    appOutDir,
    electronPlatformName: 'darwin',
    packager: { appInfo: { productFilename: 'BilliardBuddy' } },
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('packaged media toolchain verification', () => {
  it('registers the post-pack verifier in Electron Builder configuration', () => {
    const packageJson = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
      build?: { afterPack?: string }
    }
    expect(packageJson.build?.afterPack).toBe('scripts/electron-after-pack.cjs')
  })

  it('uses the Electron app.asar.unpacked location for each supported package platform', () => {
    const mac = packagedContext()
    expect(afterPack.packagedMediaToolchainDir(mac)).toBe(join(
      mac.appOutDir,
      'BilliardBuddy.app',
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'src-tauri',
      'binaries',
    ))
    expect(afterPack.packagedMediaToolchainDir({
      appOutDir: '/tmp/win-unpacked',
      electronPlatformName: 'win32',
      packager: { appInfo: { productFilename: 'BilliardBuddy' } },
    })).toBe('/tmp/win-unpacked/resources/app.asar.unpacked/src-tauri/binaries')
  })

  it('fails packaging when the assembled app is missing or has changed FFmpeg/ffprobe', () => {
    const context = packagedContext()
    expect(() => afterPack(context)).not.toThrow()

    writeFileSync(join(afterPack.packagedMediaToolchainDir(context), 'ffprobe'), 'changed')
    expect(() => afterPack(context)).toThrow('packaged FFmpeg/ffprobe verification failed')
  })

  it('rejects an unsupported Electron target instead of skipping media verification', () => {
    expect(() => afterPack.packagePlatform({ electronPlatformName: 'linux' })).toThrow('unsupported media toolchain platform')
  })
})
