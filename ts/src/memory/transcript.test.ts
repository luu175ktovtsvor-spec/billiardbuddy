import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { userText } from '../types/message'
import { Transcript } from './transcript'

describe('Transcript', () => {
  test('原子保存/读回 Message JSONL,坏行跳过', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-'))
    try {
      const tr = new Transcript(root, 'conv_1')
      await tr.save([userText('a'), userText('b')])
      expect(await tr.load()).toEqual([userText('a'), userText('b')])
      await Bun.write(tr.path, `${readFileSync(tr.path, 'utf8')}not-json\n`)
      expect(await tr.load()).toEqual([userText('a'), userText('b')])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('拒绝危险 conversation id', () => {
    expect(() => new Transcript('/tmp', '../x')).toThrow('非法 conversation id')
    expect(() => new Transcript('/tmp', 'a'.repeat(129))).toThrow('非法 conversation id')
  })

  test('savePreservingExternalTail 保留 mid-turn 外部追加尾巴', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-'))
    try {
      const tr = new Transcript(root, 'conv_2')
      await tr.save([userText('old')])
      const baseline = await tr.captureBaselineLen()
      await Bun.write(tr.path, `${readFileSync(tr.path, 'utf8')}${JSON.stringify(userText('external'))}\n`)
      await tr.savePreservingExternalTail([userText('new')], baseline)
      expect(await tr.load()).toEqual([userText('new'), userText('external')])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('loadPage 流式分页读取,坏行跳过且 after 按有效消息 seq 计算', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-page-'))
    try {
      const tr = new Transcript(root, 'conv_page')
      await tr.save([userText('a'), userText('b'), userText('c')])
      await Bun.write(tr.path, `${readFileSync(tr.path, 'utf8')}not-json\n${JSON.stringify(userText('d'))}\n`)

      const first = await tr.loadPage({ limit: 2 })
      expect(first.messages.map(r => [r.seq, r.message])).toEqual([
        [1, userText('a')],
        [2, userText('b')],
      ])
      expect(first.nextSeq).toBe(2)
      expect(first.hasMore).toBe(true)

      const second = await tr.loadPage({ after: first.nextSeq, limit: 10 })
      expect(second.messages.map(r => [r.seq, r.message])).toEqual([
        [3, userText('c')],
        [4, userText('d')],
      ])
      expect(second.nextSeq).toBe(4)
      expect(second.hasMore).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
