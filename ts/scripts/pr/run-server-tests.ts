#!/usr/bin/env bun

import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const root = process.cwd()
const roots = [
  'shared/contracts',
  'shared/product',
  'src/media',
  'src/server',
  'src/skills',
]

function normalize(path: string) {
  return relative(root, path).split(sep).join('/')
}

function walk(path: string, files: string[]) {
  const stat = statSync(path)

  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      walk(join(path, entry), files)
    }
    return
  }

  if (!stat.isFile()) {
    return
  }

  const normalized = normalize(path)
  if (normalized.endsWith('.test.ts')) {
    files.push(normalized)
  }
}

const testFiles: string[] = []
for (const testRoot of roots) {
  walk(join(root, testRoot), testFiles)
}

testFiles.sort()

if (testFiles.length === 0) {
  console.log('No server-side test files found.')
  process.exit(0)
}

const proc = Bun.spawn(['bun', 'test', ...testFiles], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
})

process.exit(await proc.exited)
