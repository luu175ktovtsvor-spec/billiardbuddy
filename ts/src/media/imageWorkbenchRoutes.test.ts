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

test('D1: canvas/versions/rollback/export/library/portrait-confirm 和单项目 GET 都拒绝跨工作区操作', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-workbench-guard-'))
  const workspaceA = join(root, 'workspace-a')
  const workspaceB = join(root, 'workspace-b')
  try {
    const handler = createImageWorkbenchRouteHandler(new ImageWorkbenchStore(root), { defaultWorkspaceRoot: workspaceA })
    const base = { image_url: '/uploads/posters/source.png', width: 320, height: 240, intent: 'creative', quality: 'standard' }
    const createdB = await handler(new URL('http://127.0.0.1/api/v1/studio/workbench/projects'), request('/api/v1/studio/workbench/projects', 'POST', { ...base, title: 'B', working_dir: workspaceB }))
    const projectB = (await createdB!.json() as any).project
    const id = projectB.project_id
    const fakeDataUrl = `data:image/png;base64,${'A'.repeat(40)}`

    // 前端(真实调用点)会显式带上当前工作区 working_dir=workspaceA——项目却属于 workspaceB,应全部拒绝。
    const attempts: Array<() => Promise<Response | null>> = [
      () => handler(new URL(`http://127.0.0.1/api/v1/studio/workbench/projects/${id}?working_dir=${encodeURIComponent(workspaceA)}`), request(`/api/v1/studio/workbench/projects/${id}?working_dir=${encodeURIComponent(workspaceA)}`)),
      () => handler(new URL(`http://127.0.0.1/api/v1/studio/workbench/projects/${id}/canvas`), request(`/api/v1/studio/workbench/projects/${id}/canvas`, 'PUT', { width: 320, height: 240, working_dir: workspaceA })),
      () => handler(new URL(`http://127.0.0.1/api/v1/studio/workbench/projects/${id}/versions`), request(`/api/v1/studio/workbench/projects/${id}/versions`, 'POST', { kind: 'imported', image_url: '/uploads/posters/v2.png', width: 320, height: 240, working_dir: workspaceA })),
      () => handler(new URL(`http://127.0.0.1/api/v1/studio/workbench/projects/${id}/rollback`), request(`/api/v1/studio/workbench/projects/${id}/rollback`, 'POST', { version_id: 'v-missing', working_dir: workspaceA })),
      () => handler(new URL(`http://127.0.0.1/api/v1/studio/workbench/projects/${id}/export`), request(`/api/v1/studio/workbench/projects/${id}/export`, 'POST', { data_url: fakeDataUrl, width: 320, height: 240, working_dir: workspaceA })),
      () => handler(new URL(`http://127.0.0.1/api/v1/studio/workbench/projects/${id}/library`), request(`/api/v1/studio/workbench/projects/${id}/library`, 'POST', { working_dir: workspaceA })),
      () => handler(new URL(`http://127.0.0.1/api/v1/studio/workbench/projects/${id}/portrait-confirm`), request(`/api/v1/studio/workbench/projects/${id}/portrait-confirm`, 'POST', { confirmed: true, working_dir: workspaceA })),
    ]
    for (const attempt of attempts) {
      const response = await attempt()
      expect(response?.status).toBe(409)
      expect((await response!.json() as any).detail).toContain('另一个工作文件夹')
    }

    // 不传 working_dir 时不做校验(对齐 auto_plan 既有口径),canvas 保存应该正常成功而不是被误拦。
    const noWorkingDirCanvas = await handler(
      new URL(`http://127.0.0.1/api/v1/studio/workbench/projects/${id}/canvas`),
      request(`/api/v1/studio/workbench/projects/${id}/canvas`, 'PUT', { width: 320, height: 240 }),
    )
    expect(noWorkingDirCanvas?.status).toBe(200)

    const okGet = await handler(
      new URL(`http://127.0.0.1/api/v1/studio/workbench/projects/${id}?working_dir=${encodeURIComponent(workspaceB)}`),
      request(`/api/v1/studio/workbench/projects/${id}?working_dir=${encodeURIComponent(workspaceB)}`),
    )
    expect(okGet?.status).toBe(200)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
