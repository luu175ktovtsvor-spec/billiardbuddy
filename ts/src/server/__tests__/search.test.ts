import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { handleSearchApi } from '../api/search.js'

const tempDirs: string[] = []

async function createWorkspace(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'billiardbuddy-search-'))
  tempDirs.push(cwd)
  await fs.writeFile(path.join(cwd, 'fixture.txt'), 'workspace-only-needle\n')
  return cwd
}

function post(url: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('Search API', () => {
  it('keeps workspace file search available', async () => {
    const cwd = await createWorkspace()
    const req = post('http://localhost/api/search', {
      query: 'workspace-only-needle',
      cwd,
    })

    const response = await handleSearchApi(req, new URL(req.url), ['api', 'search'])

    expect(response.status).toBe(200)
    const body = await response.json() as { results: Array<{ text: string }>; total: number }
    expect(body.total).toBeGreaterThan(0)
    expect(body.results[0]?.text).toContain('workspace-only-needle')
  })

  it('does not expose the retired session-transcript endpoint', async () => {
    const req = post('http://localhost/api/search/sessions', { query: 'anything' })

    const response = await handleSearchApi(req, new URL(req.url), ['api', 'search', 'sessions'])

    expect(response.status).toBe(404)
  })
})
