import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import type { ToolContext } from './Tool'
import { classifyUrl, clearWebFetchCache, htmlToText, isBlockedHost, isPermittedRedirect, webFetchTool } from './webFetchTool'
import { isPreapprovedHost } from './webFetchPreapproved'

let root: string
let ctx: ToolContext
const realFetch = globalThis.fetch

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wf-'))
  ctx = { workspace: new Workspace(root) }
  clearWebFetchCache()
})
afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(root, { recursive: true, force: true })
})

function fakeResponse(opts: { status?: number; contentType?: string; body?: string; location?: string }): Response {
  const headers = new Map<string, string>([['content-type', opts.contentType ?? 'text/html']])
  if (opts.location) headers.set('location', opts.location)
  const status = opts.status ?? 200
  return {
    status,
    statusText: 'OK',
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null } as unknown as Headers,
    body: null,
    arrayBuffer: async () => new TextEncoder().encode(opts.body ?? '').buffer,
  } as unknown as Response
}

test('isBlockedHost blocks localhost / private / link-local / single-label hosts', () => {
  for (const host of ['localhost', 'app.localhost', '127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '169.254.169.254', '::1', 'internal', 'db.local', '0.0.0.0', '100.64.0.1']) {
    expect(isBlockedHost(host)).toBe(true)
  }
  for (const host of ['example.com', 'docs.python.org', 'sub.domain.co.uk', '8.8.8.8', '172.32.0.1']) {
    expect(isBlockedHost(host)).toBe(false)
  }
})

test('classifyUrl enforces SSRF + scheme + credential rules and upgrades http to https', () => {
  expect(classifyUrl('http://example.com/x')).toEqual({ ok: true, url: 'https://example.com/x' })
  expect(classifyUrl('example.com')).toEqual({ ok: true, url: 'https://example.com/' })
  expect(classifyUrl('ftp://example.com').ok).toBe(false)
  expect(classifyUrl('https://user:pass@example.com').ok).toBe(false)
  expect(classifyUrl('http://localhost:3000').ok).toBe(false)
  expect(classifyUrl('https://169.254.169.254/latest/meta-data').ok).toBe(false)
  expect(classifyUrl(`https://example.com/${'a'.repeat(3000)}`).ok).toBe(false)
})

test('isPermittedRedirect only allows same-host (± www) redirects', () => {
  expect(isPermittedRedirect('https://a.com/x', 'https://a.com/y')).toBe(true)
  expect(isPermittedRedirect('https://a.com/x', 'https://www.a.com/y')).toBe(true)
  expect(isPermittedRedirect('https://a.com/x', 'https://evil.com/y')).toBe(false)
  expect(isPermittedRedirect('https://a.com/x', 'http://a.com/y')).toBe(false)
})

test('preapproved documentation hosts skip approval; other hosts require it', () => {
  expect(isPreapprovedHost('docs.python.org', '/3/')).toBe(true)
  expect(isPreapprovedHost('github.com', '/anthropics/skills')).toBe(true)
  expect(isPreapprovedHost('github.com', '/anthropics-evil/malware')).toBe(false)
  expect(webFetchTool.requiresApprovalFor?.({ url: 'https://docs.python.org/3/' }, ctx)).toBe(false)
  expect(webFetchTool.requiresApprovalFor?.({ url: 'https://random-blog.example/post' }, ctx)).toBe(true)
})

test('fatalReasonFor rejects SSRF/invalid urls, allows public ones', () => {
  expect(webFetchTool.fatalReasonFor?.({ url: 'http://localhost' }, ctx)).toBeTruthy()
  expect(webFetchTool.fatalReasonFor?.({ url: 'file:///etc/passwd' }, ctx)).toBeTruthy()
  expect(webFetchTool.fatalReasonFor?.({ url: 'https://example.com' }, ctx)).toBeNull()
})

test('htmlToText strips scripts/styles, keeps links, decodes entities', () => {
  const md = htmlToText('<html><head><style>x{}</style></head><body><script>bad()</script><h1>Title</h1><p>Hello&nbsp;<a href="https://x.com">link</a> &amp; more</p></body></html>')
  expect(md).toContain('# Title')
  expect(md).toContain('[link](https://x.com)')
  expect(md).toContain('& more')
  expect(md).not.toContain('bad()')
  expect(md).not.toContain('x{}')
})

test('execute fetches, converts html, and serves the second call from cache', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return fakeResponse({ body: '<h1>Docs</h1><p>content body</p>' })
  }) as unknown as typeof fetch

  const first = await webFetchTool.execute({ url: 'https://docs.python.org/3/' }, ctx)
  expect(first).toContain('# Docs')
  expect(first).toContain('content body')
  expect(first).not.toContain('cached="true"')

  const second = await webFetchTool.execute({ url: 'https://docs.python.org/3/' }, ctx)
  expect(second).toContain('cached="true"')
  expect(calls).toBe(1)
})

test('execute reports a cross-host redirect instead of following it', async () => {
  globalThis.fetch = (async () => fakeResponse({ status: 301, location: 'https://elsewhere.example/moved' })) as unknown as typeof fetch
  const out = await webFetchTool.execute({ url: 'https://docs.python.org/3/' }, ctx)
  expect(out).toContain('status="redirect"')
  expect(out).toContain('https://elsewhere.example/moved')
})

test('execute refuses SSRF targets before any fetch', async () => {
  let called = false
  globalThis.fetch = (async () => { called = true; return fakeResponse({ body: 'x' }) }) as unknown as typeof fetch
  await expect(webFetchTool.execute({ url: 'http://127.0.0.1:8080/admin' }, ctx)).rejects.toThrow(/SSRF|拦截|拒绝/)
  expect(called).toBe(false)
})
