#!/usr/bin/env bun

import path from 'node:path'

const root = path.resolve(import.meta.dir, '..')
const repositoryRoot = path.resolve(root, '..')

export const RELEASE_SOURCE_PATHS = [
  '.github/workflows/desktop-build-win.yml',
  'ts/bin',
  'ts/desktop',
  'ts/shared',
  'ts/src',
  'ts/scripts',
  'ts/bun.lock',
  'ts/package.json',
] as const

export type GitOutput = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

async function defaultGitOutput(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', ...args], {
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

export function parseNullSeparatedPaths(value: string): string[] {
  return value.split('\0').filter(Boolean)
}

export async function findUntrackedReleaseInputs(
  gitOutput: GitOutput = defaultGitOutput,
): Promise<string[]> {
  const result = await gitOutput([
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    ...RELEASE_SOURCE_PATHS,
  ])
  if (result.code !== 0) {
    throw new Error(`Unable to audit tracked release inputs: ${result.stderr.trim() || `git exit ${result.code}`}`)
  }
  return parseNullSeparatedPaths(result.stdout).sort()
}

export async function assertReleaseInputsTracked(
  gitOutput: GitOutput = defaultGitOutput,
): Promise<void> {
  const untracked = await findUntrackedReleaseInputs(gitOutput)
  if (untracked.length === 0) return

  const preview = untracked.slice(0, 20).map(file => `  - ${file}`).join('\n')
  const remaining = untracked.length > 20 ? `\n  ... and ${untracked.length - 20} more` : ''
  throw new Error(
    `Release source contains ${untracked.length} untracked file(s). Add the intended files in a reviewed commit before releasing:\n${preview}${remaining}`,
  )
}

if (import.meta.main) {
  try {
    await assertReleaseInputsTracked()
    console.log('Release source tracking check passed.')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
