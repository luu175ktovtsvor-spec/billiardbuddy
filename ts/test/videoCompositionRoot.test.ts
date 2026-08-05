import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVideoWorkbenchCompositionRoot } from '../src/server/video/runtime/createVideoWorkbenchRuntime.js'
import { VideoWorkbenchService } from '../src/server/services/videoWorkbenchService.js'

const roots: string[] = []

async function rootPath(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `billiardbuddy-video-root-${label}-`))
  roots.push(path)
  return path
}

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true })
})

test('视频组合根向四个领域应用注入同一个持久化写入与运行时状态', async () => {
  const root = createVideoWorkbenchCompositionRoot({ root: await rootPath('shared') })
  const runtime = root.runtime as unknown as {
    analysisState: unknown
    finishingState: unknown
    editorial: unknown
    finishing: unknown
  }
  expect(root.repository).toBe(root.runtime.repository)
  expect(root.projectAssets.projectStore).toBe(root.runtime.projectStore)
  expect(root.projectAssets.projectStore.repository).toBe(root.repository)
  expect(root.analysisIndex.projectStore).toBe(root.projectAssets.projectStore)
  expect(root.editorial.projectStore).toBe(root.projectAssets.projectStore)
  expect(root.finishingDelivery.projectStore).toBe(root.projectAssets.projectStore)
  expect(root.analysisIndex.operationState).toBe(runtime.analysisState)
  expect(root.finishingDelivery.operationState).toBe(runtime.finishingState)
  expect(root.editorial.rules).toBe(runtime.editorial)
  expect(root.finishingDelivery.rules).toBe(runtime.finishing)

  await expect(root.projectAssets.projectStore.mutate('video_00000001', async () => {
    throw new Error('first mutation fails')
  })).rejects.toThrow('first mutation fails')
  await expect(root.projectAssets.projectStore.mutate('video_00000001', async () => 'next mutation')).resolves.toBe('next mutation')
  await root.projectAssets.listProjects()
  root.repository.close()
})

test('应用层通过窄端口写入，并直接从共享 SQLite 投影读取、校验项目边界', async () => {
  const root = createVideoWorkbenchCompositionRoot({ root: await rootPath('direct-reads') })
  const project = await root.projectAssets.createProject({ title: '共享读取职责' })
  const runtime = root.runtime as unknown as {
    listProjects: (...args: unknown[]) => Promise<never>
    getProject: (...args: unknown[]) => Promise<never>
    assertProjectOwner: (...args: unknown[]) => Promise<never>
    listDeletions: (...args: unknown[]) => Promise<never>
    hasProjectHistory: (...args: unknown[]) => Promise<never>
    hasOperationHistory: (...args: unknown[]) => Promise<never>
    getWorkspaceSnapshotData: (...args: unknown[]) => Promise<never>
    pageMediaFacts: (...args: unknown[]) => Promise<never>
    reclaimDerivativeCache: (...args: unknown[]) => Promise<never>
    waitForOperationEvents: (...args: unknown[]) => Promise<never>
    getQualityReport: (...args: unknown[]) => Promise<never>
  }
  const failIfDelegated = async (): Promise<never> => {
    throw new Error('应用层错误地回退到完整运行时')
  }
  runtime.listProjects = failIfDelegated
  runtime.getProject = failIfDelegated
  runtime.assertProjectOwner = failIfDelegated
  runtime.listDeletions = failIfDelegated
  runtime.hasProjectHistory = failIfDelegated
  runtime.hasOperationHistory = failIfDelegated
  runtime.getWorkspaceSnapshotData = failIfDelegated
  runtime.pageMediaFacts = failIfDelegated
  runtime.reclaimDerivativeCache = failIfDelegated
  runtime.waitForOperationEvents = failIfDelegated
  runtime.getQualityReport = failIfDelegated

  expect((await root.projectAssets.listProjects())[0]?.id).toBe(project.id)
  expect((await root.projectAssets.getProject(project.id)).id).toBe(project.id)
  expect((await root.projectAssets.assertProjectOwner(project.id)).owner).toEqual({ kind: 'standalone', owner_id: 'local_workbench' })
  expect(await root.projectAssets.hasProjectHistory(project.id)).toBe(true)
  expect(await root.projectAssets.hasOperationHistory('task_missing')).toBe(false)
  expect(await root.projectAssets.listDeletions()).toEqual([])

  const snapshot = await root.analysisIndex.getWorkspaceSnapshotData(project.id, 0)
  expect(snapshot.project.id).toBe(project.id)
  expect((await root.analysisIndex.pageMediaFacts(project.id, 'evidence_window')).items).toEqual([])
  expect(await root.analysisIndex.reclaimDerivativeCache(project.id, 1)).toEqual([])
  expect((await root.analysisIndex.waitForOperationEvents(project.id, 0, 20, 0)).next_cursor).toBe(1)
  await expect(root.finishingDelivery.getQualityReport(project.id, 'quality_missing')).rejects.toMatchObject({
    code: 'VIDEO_QUALITY_REPORT_NOT_FOUND',
    status: 404,
  })
  root.repository.close()
})

test('应用模块不反向导入具体运行时，组合根是唯一适配位置', async () => {
  const sources = await Promise.all([
    'projectAssets.ts',
    'analysisIndex.ts',
    'editorial.ts',
    'finishingDelivery.ts',
  ].map(async file => await readFile(new URL(`../src/server/video/application/${file}`, import.meta.url), 'utf8')))
  for (const source of sources) {
    expect(source).not.toContain("services/videoWorkbenchRuntime.js")
  }
  expect(sources[0]).toContain('ProjectAssetsCommandPort')
  expect(sources[1]).toContain('AnalysisIndexCommandPort')
  expect(sources[2]).toContain('EditorialCommandPort')
  expect(sources[2]).toContain('projectStore.mutate')
  expect(sources[2]).not.toContain('this.commands.createReviewNote')
  expect(sources[2]).not.toContain('this.commands.resolveReviewNote')
  expect(sources[2]).not.toContain('this.commands.createApprovalDecision')
  expect(sources[3]).toContain('FinishingDeliveryCommandPort')
})

test('兼容门面只委托组合根，不重新持有 repository、Relay、FFmpeg 或恢复状态', async () => {
  const source = await readFile(new URL('../src/server/services/videoWorkbenchService.ts', import.meta.url), 'utf8')
  expect(source).toContain('createVideoWorkbenchCompositionRoot')
  expect(source).toContain('this.root.projectAssets')
  expect(source).toContain('this.root.analysisIndex')
  expect(source).toContain('this.root.editorial')
  expect(source).toContain('this.root.finishingDelivery')
  expect(source).not.toContain('new VideoWorkbenchRepository')
  expect(source).not.toContain('VideoMediaRelayClient')
  expect(source).not.toContain('defaultVideoProcessRunner')
  expect(source).not.toContain('recoverInterruptedOperation(')

  const service = new VideoWorkbenchService({ root: await rootPath('facade') })
  const project = await service.createProject({ title: '组合根兼容调用' })
  expect(await service.getProject(project.id)).toMatchObject({ id: project.id, title: '组合根兼容调用' })
  service.repository.close()
})
