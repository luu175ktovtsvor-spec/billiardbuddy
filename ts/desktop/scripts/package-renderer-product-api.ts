import {
  evaluateInPackagedRenderer,
  waitForPackagedRenderer,
  type PackagedRendererTarget,
} from './packaged-renderer-driver'
import type { ChildProcess } from 'node:child_process'

type ProductRuntimeSnapshot = {
  status?: unknown
  tasks?: Array<{ id?: unknown }>
}

export type PackageRendererProbeOptions = {
  port: number
  expectedTaskId?: string
  createTaskWorkDir?: string
  timeoutMs?: number
  child?: ChildProcess
}

async function inspectProductRuntime(target: PackagedRendererTarget, expectedTaskId?: string): Promise<void> {
  const snapshot = await evaluateInPackagedRenderer<ProductRuntimeSnapshot>(target, `(async () => {
    const serverUrl = await window.desktopHost.runtime.getServerUrl()
    const response = await fetch(serverUrl.replace(/\\/$/, '') + '/api/product/tasks')
    const body = await response.json()
    return { status: response.status, tasks: body.tasks }
  })()`)
  if (snapshot.status !== 200 || !Array.isArray(snapshot.tasks)) {
    throw new Error('安装包没有返回可用的权威任务列表')
  }
  if (expectedTaskId && !snapshot.tasks.some(task => task.id === expectedTaskId)) {
    throw new Error(`安装包没有读到迁移任务: ${expectedTaskId}`)
  }
}

async function createProductTask(target: PackagedRendererTarget, workDir: string): Promise<string> {
  const result = await evaluateInPackagedRenderer<{ status?: unknown, task?: { id?: unknown } }>(target, `(async () => {
    const serverUrl = await window.desktopHost.runtime.getServerUrl()
    const response = await fetch(serverUrl.replace(/\\/$/, '') + '/api/product/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workDir: ${JSON.stringify(workDir)},
        title: 'Oldest supported package task',
        permissionMode: 'ask',
      }),
    })
    return { status: response.status, ...(await response.json()) }
  })()`)
  if (result.status !== 201 || typeof result.task?.id !== 'string') {
    throw new Error('最老支持安装包没有创建真实产品任务')
  }
  return result.task.id
}

export async function probePackageRenderer(options: PackageRendererProbeOptions): Promise<{
  url: string
  createdTaskId?: string
}> {
  if (!Number.isSafeInteger(options.port) || options.port <= 0 || options.port > 65_535) {
    throw new Error('renderer 验收端口无效')
  }
  const target = await waitForPackagedRenderer(options.port, options.child ?? null, options.timeoutMs ?? 60_000)
  await inspectProductRuntime(target, options.expectedTaskId)
  const createdTaskId = options.createTaskWorkDir
    ? await createProductTask(target, options.createTaskWorkDir)
    : undefined
  if (createdTaskId) await inspectProductRuntime(target, createdTaskId)
  return {
    url: String(target.url),
    ...(createdTaskId ? { createdTaskId } : {}),
  }
}

function parseCli(argv: string[]): PackageRendererProbeOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name || !value || !['--port', '--expected-task-id', '--create-task-work-dir'].includes(name)) {
      throw new Error('用法: bun run package-renderer-product-api.ts --port <port> [--expected-task-id <id> | --create-task-work-dir <path>]')
    }
    values.set(name, value)
  }
  if (values.has('--expected-task-id') && values.has('--create-task-work-dir')) {
    throw new Error('renderer 验收不能同时创建任务和验证已有任务')
  }
  const port = Number(values.get('--port'))
  return {
    port,
    ...(values.get('--expected-task-id') ? { expectedTaskId: values.get('--expected-task-id') } : {}),
    ...(values.get('--create-task-work-dir') ? { createTaskWorkDir: values.get('--create-task-work-dir') } : {}),
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(await probePackageRenderer(parseCli(process.argv.slice(2)))))
}
