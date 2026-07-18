import { afterEach, describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageMediaToolchain } from './stage-media-toolchain'

const roots: string[] = []

function temp(): string {
  const path = mkdtempSync(join(tmpdir(), 'bb-media-toolchain-'))
  roots.push(path)
  return path
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fixture(
  buildConfiguration = '--enable-shared --disable-static',
  options: {
    ffprobeBuildConfiguration?: string
    licenseText?: string
    manifestLicense?: 'LGPL-2.1-or-later' | 'LGPL-3.0-or-later'
  } = {},
): string {
  const source = temp()
  for (const name of ['ffmpeg', 'ffprobe']) {
    const path = join(source, name)
    const configuration = name === 'ffprobe'
      ? options.ffprobeBuildConfiguration ?? buildConfiguration
      : buildConfiguration
    writeFileSync(path, `#!/bin/sh
case "$*" in
  *-buildconf*) echo '${name} version 7.1-test'; echo 'configuration: ${configuration}' ;;
  *-version*) echo '${name} version 7.1-test'; echo 'configuration: ${configuration}' ;;
  *-L*) echo 'This version of ${name} is licensed under the GNU Lesser General Public License.' ;;
  *) exit 2 ;;
esac
`)
    chmodSync(path, 0o755)
  }
  const licenseText = options.licenseText ?? 'GNU LESSER GENERAL PUBLIC LICENSE\n'
  writeFileSync(join(source, 'LICENSE.txt'), licenseText)
  writeFileSync(join(source, 'media-toolchain-source.json'), JSON.stringify({
    schemaVersion: 1,
    version: '7.1-test',
    license: options.manifestLicense ?? 'LGPL-2.1-or-later',
    sourceUrl: 'https://ffmpeg.org/releases/ffmpeg-7.1.tar.xz',
    licenseSha256: hash(join(source, 'LICENSE.txt')),
    files: {
      ffmpeg: hash(join(source, 'ffmpeg')),
      ffprobe: hash(join(source, 'ffprobe')),
    },
  }))
  return source
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('media toolchain staging', () => {
  test('stages and verifies an audited LGPL toolchain', () => {
    const source = fixture()
    const destination = temp()
    stageMediaToolchain({ sourceDir: source, destinationDir: destination, platform: 'darwin' })
    expect(() => stageMediaToolchain({ destinationDir: destination, platform: 'darwin', verifyOnly: true })).not.toThrow()
    expect(readFileSync(join(destination, 'media-toolchain-manifest.json'), 'utf8')).toContain('--enable-shared')
  })

  test('rejects GPL/nonfree builds and changed binaries', () => {
    expect(() => stageMediaToolchain({
      sourceDir: fixture('--enable-gpl'),
      destinationDir: temp(),
      platform: 'darwin',
    })).toThrow('GPL')

    const source = fixture()
    writeFileSync(join(source, 'ffmpeg'), 'changed')
    expect(() => stageMediaToolchain({ sourceDir: source, destinationDir: temp(), platform: 'darwin' })).toThrow('SHA-256')
  })

  test('rejects an invalid license file and mismatched ffprobe build', () => {
    expect(() => stageMediaToolchain({
      sourceDir: fixture('--enable-shared', { licenseText: 'not a license\n' }),
      destinationDir: temp(),
      platform: 'darwin',
    })).toThrow('不是 GNU Lesser')

    expect(() => stageMediaToolchain({
      sourceDir: fixture('--enable-shared', { ffprobeBuildConfiguration: '--enable-gpl' }),
      destinationDir: temp(),
      platform: 'darwin',
    })).toThrow('GPL')
  })
})
