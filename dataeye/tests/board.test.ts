import { expect, test } from 'bun:test'
import { createBoardFetch, type BoardDb } from '../board/app'

class FakeBoardDb implements BoardDb {
  values: unknown[]
  rows: Array<Array<Record<string, any>>>

  constructor(opts: { values?: unknown[]; rows?: Array<Array<Record<string, any>>> } = {}) {
    this.values = [...(opts.values ?? [])]
    this.rows = [...(opts.rows ?? [])]
  }

  async fetchValue(_sql: string): Promise<unknown> {
    if (this.values.length === 0) return 0
    const value = this.values.shift()
    if (value instanceof Error) throw value
    return value
  }

  async fetchRows<T extends Record<string, any> = Record<string, any>>(_sql: string): Promise<T[]> {
    if (this.rows.length === 0) return []
    const rows = this.rows.shift()
    if (rows instanceof Error) throw rows
    return rows as T[]
  }
}

const fixedNow = () => new Date('2026-07-09T04:05:00Z')

test('board overview renders metrics and trend charts without a real database', async () => {
  const db = new FakeBoardDb({
    values: [3, 1, 7, 10, 120, 80, 1000, 2, 1, 4, 5, 2, 1, 3, 0, 1],
    rows: [
      [{ d: '2026-07-08', v: 2 }, { d: '2026-07-09', v: 3 }],
      [{ d: '2026-07-08', v: 80 }, { d: '2026-07-09', v: 120 }],
    ],
  })
  const fetch = createBoardFetch({ db, now: fixedNow })
  const res = await fetch(new Request('http://local/board/'))
  const html = await res.text()

  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')
  expect(html).toContain('dataeye 数据看板')
  expect(html).toContain('今日生成')
  expect(html).toContain('近 30 天 · 每日生成条数')
  expect(html).toContain('刷新于 07-09 12:05')
  expect(html).toContain('3')
})

test('board generation rows escape user content and keep rating pills', async () => {
  const db = new FakeBoardDb({
    rows: [[{
      created_at: new Date('2026-07-09T00:00:00Z'),
      machine_id: 'machine-abcdef',
      type: '<image>',
      model_used: 'seedream',
      tokens_used: 42,
      effect_rating: 'good',
      prompt: '<script>alert(1)</script>',
    }]],
  })
  const fetch = createBoardFetch({ db, now: fixedNow })
  const res = await fetch(new Request('http://local/board/generations'))
  const html = await res.text()

  expect(res.status).toBe(200)
  expect(html).toContain('&lt;image&gt;')
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).not.toContain('<script>alert(1)</script>')
  expect(html).toContain('<span class="pill good">好</span>')
  expect(html).toContain('2026-07-09 08:00')
})

test('board healthz reports database status', async () => {
  const ok = createBoardFetch({ db: new FakeBoardDb({ values: [1] }), now: fixedNow })
  const okRes = await ok(new Request('http://local/board/healthz'))
  expect(okRes.status).toBe(200)
  expect(await okRes.json()).toEqual({ ok: true })

  const bad = createBoardFetch({ db: new FakeBoardDb({ values: [new Error('db down')] }), now: fixedNow })
  const badRes = await bad(new Request('http://local/board/healthz'))
  expect(badRes.status).toBe(200)
  expect(await badRes.json()).toEqual({ ok: false, err: 'db down' })
})

test('board unknown route returns 404', async () => {
  const fetch = createBoardFetch({ db: new FakeBoardDb(), now: fixedNow })
  const res = await fetch(new Request('http://local/nope'))
  expect(res.status).toBe(404)
  expect(await res.json()).toEqual({ detail: 'not found' })
})
