import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createImageWorkbenchRouteHandler } from './imageWorkbenchRoutes'
import { ImageWorkbenchStore } from './imageWorkbenchStore'

function request(path: string, method = 'GET', body?: unknown): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

test('image workbench routes default new projects to one workspace and filter other workspaces', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-workbench-routes-'))
  const workspaceA = join(root, 'workspace-a')
  const workspaceB = join(root, 'workspace-b')
  try {
    const handler = createImageWorkbenchRouteHandler(new ImageWorkbenchStore(root), { defaultWorkspaceRoot: workspaceA })
    const base = { image_url: '/uploads/posters/source.png', width: 320, height: 240, intent: 'creative', quality: 'standard' }
    const createdA = await handler(new URL('http://127.0.0.1/api/v1/studio/workbench/projects'), request('/api/v1/studio/workbench/projects', 'POST', { ...base, title: 'A' }))
    const createdB = await handler(new URL('http://127.0.0.1/api/v1/studio/workbench/projects'), request('/api/v1/studio/workbench/projects', 'POST', { ...base, title: 'B', working_dir: workspaceB }))
    expect((await createdA!.json() as any).project.working_dir).toBe(workspaceA)
    expect((await createdB!.json() as any).project.working_dir).toBe(workspaceB)

    const listedA = await handler(new URL('http://127.0.0.1/api/v1/studio/workbench/projects'), request('/api/v1/studio/workbench/projects'))
    const listedB = await handler(new URL(`http://127.0.0.1/api/v1/studio/workbench/projects?working_dir=${encodeURIComponent(workspaceB)}`), request(`/api/v1/studio/workbench/projects?working_dir=${encodeURIComponent(workspaceB)}`))
    expect((await listedA!.json() as any).projects.map((item: any) => item.title)).toEqual(['A'])
    expect((await listedB!.json() as any).projects.map((item: any) => item.title)).toEqual(['B'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
