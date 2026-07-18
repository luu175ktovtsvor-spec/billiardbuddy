import { describe, expect, it } from 'bun:test'
import { handleSkillsApi } from '../api/skills.js'

function makeRequest(
  path: string,
  method = 'GET',
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(path, 'http://localhost:3456')
  return {
    req: new Request(url.toString(), { method }),
    url,
    segments: url.pathname.split('/').filter(Boolean),
  }
}

describe('Skills API product boundary', () => {
  it('keeps ordinary catalog requests empty without scanning or exposing private inputs', async () => {
    const privateValue = 'PRIVATE_SKILL_DESCRIPTION_SENTINEL'
    const { req, url, segments } = makeRequest(
      `/api/skills?cwd=${encodeURIComponent(`/private/${privateValue}`)}`,
    )

    const response = await handleSkillsApi(req, url, segments)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ skills: [] })
    expect(JSON.stringify(body)).not.toContain(privateValue)
  })

  it('rejects Skill detail requests with a generic code and no request echo', async () => {
    const privateValue = 'PRIVATE_SKILL_DETAIL_SENTINEL'
    const { req, url, segments } = makeRequest(`/api/skills/detail?name=${privateValue}`)

    const response = await handleSkillsApi(req, url, segments)

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body).toEqual({ error: 'SKILL_NOT_AVAILABLE' })
    expect(JSON.stringify(body)).not.toContain(privateValue)
  })

  it('returns only an error code for invalid methods', async () => {
    const privateValue = 'PRIVATE_SKILL_METHOD_SENTINEL'
    const { req, url, segments } = makeRequest(`/api/skills?probe=${privateValue}`, 'POST')

    const response = await handleSkillsApi(req, url, segments)

    expect(response.status).toBe(405)
    const body = await response.json()
    expect(body).toEqual({ error: 'SKILL_REQUEST_INVALID' })
    expect(JSON.stringify(body)).not.toContain(privateValue)
  })
})
