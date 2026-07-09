import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectEncodingFromBuffer, detectFileEncoding, isBlockedDevicePath, stripLeadingBom } from './fileIoSafety'

// isBlockedDevicePath —— 对齐 cc-haha FileReadTool.ts:97-129

test('isBlockedDevicePath blocks the hang-prone device paths cc lists', () => {
  for (const path of ['/dev/zero', '/dev/random', '/dev/urandom', '/dev/full', '/dev/stdin', '/dev/tty', '/dev/console', '/dev/stdout', '/dev/stderr', '/dev/fd/0', '/dev/fd/1', '/dev/fd/2']) {
    expect(isBlockedDevicePath(path)).toBe(true)
  }
})

test('isBlockedDevicePath does not block /dev/null (cc explicitly allows it)', () => {
  expect(isBlockedDevicePath('/dev/null')).toBe(false)
})

test('isBlockedDevicePath does not block unrelated /dev paths', () => {
  expect(isBlockedDevicePath('/dev/disk1')).toBe(false)
  expect(isBlockedDevicePath('/dev/fd/3')).toBe(false)
})

test('isBlockedDevicePath blocks /proc/self and /proc/<pid> stdio fd aliases', () => {
  expect(isBlockedDevicePath('/proc/self/fd/0')).toBe(true)
  expect(isBlockedDevicePath('/proc/self/fd/1')).toBe(true)
  expect(isBlockedDevicePath('/proc/self/fd/2')).toBe(true)
  expect(isBlockedDevicePath('/proc/1234/fd/0')).toBe(true)
  expect(isBlockedDevicePath('/proc/1234/fd/3')).toBe(false)
  expect(isBlockedDevicePath('/proc/1234/status')).toBe(false)
})

// detectEncodingFromBuffer —— 对齐 cc fileRead.ts:20-49 detectEncodingForResolvedPath

test('detectEncodingFromBuffer identifies UTF-16LE by its FF FE BOM', () => {
  expect(detectEncodingFromBuffer(Buffer.from([0xff, 0xfe, 0x41, 0x00]))).toBe('utf16le')
})

test('detectEncodingFromBuffer defaults to utf8 for UTF-8 BOM, ASCII, and empty buffers', () => {
  expect(detectEncodingFromBuffer(Buffer.from([0xef, 0xbb, 0xbf, 0x41]))).toBe('utf8')
  expect(detectEncodingFromBuffer(Buffer.from('plain ascii', 'utf8'))).toBe('utf8')
  expect(detectEncodingFromBuffer(Buffer.alloc(0))).toBe('utf8')
})

// stripLeadingBom

test('stripLeadingBom removes only a leading U+FEFF character', () => {
  expect(stripLeadingBom('﻿hello')).toBe('hello')
  expect(stripLeadingBom('hello﻿')).toBe('hello﻿')
  expect(stripLeadingBom('hello')).toBe('hello')
  expect(stripLeadingBom('')).toBe('')
})

// detectFileEncoding —— 对齐 cc file.ts:100-118 的 try/catch -> utf8 兜底

test('detectFileEncoding reads a real UTF-16LE file header and falls back to utf8 when missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'io-safety-'))
  try {
    const utf16Path = join(dir, 'a.txt')
    writeFileSync(utf16Path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')]))
    expect(await detectFileEncoding(utf16Path)).toBe('utf16le')

    const utf8Path = join(dir, 'b.txt')
    writeFileSync(utf8Path, 'hi')
    expect(await detectFileEncoding(utf8Path)).toBe('utf8')

    expect(await detectFileEncoding(join(dir, 'missing.txt'))).toBe('utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
