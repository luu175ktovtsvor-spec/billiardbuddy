#!/usr/bin/env bun
/**
 * Release script for BilliardBuddy Desktop.
 *
 * Creates a version commit and annotated tag on a clean main branch. Pushing the
 * tag triggers the Windows artifact workflow; it does not publish a GitHub Release.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { assertReleaseInputsTracked } from './check-release-tracked-files'

const root = path.resolve(import.meta.dir, '..')

const VERSION_FILES = [
  {
    path: path.join(root, 'desktop/package.json'),
    update(content: string, version: string) {
      return content.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`)
    },
  },
]

export type ReleaseGit = {
  output(args: string[]): Promise<string>
  succeeds(args: string[]): Promise<boolean>
}

async function command(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

const git: ReleaseGit = {
  async output(args) {
    const result = await command(['git', ...args])
    if (result.code !== 0) {
      throw new Error(`Command failed: git ${args.join(' ')}\n${result.stderr || result.stdout}`)
    }
    return result.stdout
  },
  async succeeds(args) {
    return (await command(['git', ...args])).code === 0
  },
}

export function bumpVersion(current: string, bump: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(current)) {
    throw new Error(`Current desktop version is not semantic x.y.z: ${current}`)
  }

  if (/^\d+\.\d+\.\d+$/.test(bump)) {
    const currentParts = current.split('.').map(Number)
    const nextParts = bump.split('.').map(Number)
    const advances = nextParts.some((part, index) => (
      part > currentParts[index] && nextParts.slice(0, index).every((value, prior) => value === currentParts[prior])
    ))
    if (!advances) {
      throw new Error(`Explicit version must be greater than ${current}: ${bump}`)
    }
    return bump
  }

  const [major, minor, patch] = current.split('.').map(Number)
  switch (bump) {
    case 'patch': return `${major}.${minor}.${patch + 1}`
    case 'minor': return `${major}.${minor + 1}.0`
    case 'major': return `${major + 1}.0.0`
    default: throw new Error(`Invalid bump type: ${bump}`)
  }
}

export async function assertReleaseGitState(
  tag: string,
  releaseGit: ReleaseGit = git,
): Promise<void> {
  const branch = await releaseGit.output(['branch', '--show-current'])
  if (branch !== 'main') {
    throw new Error(`Release must run from main; current branch is ${branch || '(detached HEAD)'}.`)
  }

  const trackedStatus = await releaseGit.output([
    'status',
    '--porcelain=v1',
    '--untracked-files=no',
  ])
  if (trackedStatus) {
    throw new Error('Release requires a clean tracked worktree and index. Commit or restore tracked changes first.')
  }

  if (await releaseGit.succeeds(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`])) {
    throw new Error(`Release tag already exists: ${tag}`)
  }
}

async function runRelease(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry')
  const bumpArg = args.find(arg => arg !== '--dry')
  if (!bumpArg) {
    throw new Error('Usage: bun run scripts/release.ts <patch|minor|major|x.y.z> [--dry]')
  }

  const desktopPackage = JSON.parse(
    readFileSync(path.join(root, 'desktop/package.json'), 'utf-8'),
  ) as { version: string }
  const next = bumpVersion(desktopPackage.version, bumpArg)
  const tag = `v${next}`
  const releaseNotesPath = path.join(root, 'release-notes', `${tag}.md`)

  console.log(`\n  Version: ${desktopPackage.version} -> ${next}`)
  console.log(`  Tag:     ${tag}`)
  console.log(`  Notes:   ${path.relative(root, releaseNotesPath)}`)
  console.log(`  Dry run: ${dryRun}\n`)

  await assertReleaseGitState(tag)
  await assertReleaseInputsTracked()

  if (!existsSync(releaseNotesPath)) {
    throw new Error(
      `Missing release notes file: ${path.relative(root, releaseNotesPath)}. ` +
      'Create it before releasing so it can accompany the Windows Actions artifact.',
    )
  }

  if (dryRun) {
    console.log('Release preflight passed. No Git state or files were changed.')
    console.log('Files that would be included in the release commit:')
    console.log('  - desktop/package.json')
    console.log(`  - ${path.relative(root, releaseNotesPath)}`)
    return
  }

  for (const file of VERSION_FILES) {
    const content = readFileSync(file.path, 'utf-8')
    writeFileSync(file.path, file.update(content, next))
    console.log(`  Updated: ${path.relative(root, file.path)}`)
  }

  await git.output([
    'add',
    'desktop/package.json',
    path.relative(root, releaseNotesPath),
  ])
  await git.output(['commit', '-m', `release: ${tag}`])
  await git.output(['tag', '-a', tag, '-m', `Release ${tag}`])

  console.log(`\n  Created release commit and tag ${tag}.`)
  console.log('  After installers are verified, push the main branch and tag:')
  console.log(`    git push origin main ${tag}`)
  console.log('  The tag triggers the Windows workflow, which uploads an Actions artifact only.')
}

if (import.meta.main) {
  try {
    await runRelease()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
