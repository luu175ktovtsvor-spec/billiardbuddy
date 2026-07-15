import { expect, test } from 'bun:test'
import type { ImageCreativeBrief, MediaJob, StudioImage } from '../../api/studio'
import { executeImageGeneration, type ImageGenerationCommandInput } from './imageWorkbenchGeneration'

function image(id: string, fields: Record<string, unknown> = {}): StudioImage {
  return { generation_id: id, poster_url: `/uploads/${id}.png`, ...fields } as StudioImage
}

function brief(): ImageCreativeBrief {
  return {
    compiler_version: 'test',
    user_request: '开业海报',
    understanding: '开业海报',
    intent: 'poster_text',
    quality: 'standard',
    ratio: '3:4',
    poster: { title: '开业', offer: '', price: '', date: '', time: '', address: '', phone: '', cta: '' },
    references: [],
    constraints: [],
  } as ImageCreativeBrief
}

function input(existingBrief: ImageCreativeBrief | null = null): ImageGenerationCommandInput {
  return {
    request: '开业海报',
    sceneId: 'opening_anniversary',
    intent: 'poster_text',
    quality: 'standard',
    ratio: '3:4',
    count: 3,
    posterText: { title: '', offer: '', price: '', date: '', address: '', phone: '', cta: '' },
    referenceUrls: [],
    referenceAssets: [],
    portraitAuthorized: false,
    creativeBrief: existingBrief,
  }
}

function callbacks() {
  const jobs: string[] = []
  const stages: string[] = []
  const progress: number[] = []
  return {
    jobs,
    stages,
    progress,
    value: {
      signal: new AbortController().signal,
      onJobStarted: (jobId: string) => jobs.push(jobId),
      onStage: (stage: string) => stages.push(stage),
      onProgress: (value: number) => progress.push(value),
    },
  }
}

test('编译 brief 后生成候选,返回推荐项和固定文字回填', async () => {
  const events = callbacks()
  let compileCalls = 0
  const result = await executeImageGeneration(input(), events.value, {
    async compileBrief() { compileCalls += 1; return { brief: brief() } },
    async generate() { return { job_id: 'job-1' } },
    async pollJob(_id, options) {
      options.onProgress?.(60, '排队中')
      return { status: 'done', result: { images: [
        image('pass-1', { poster_hard_gate_passed: true }),
        image('pass-2', { poster_hard_gate_passed: true }),
        image('risk'),
      ] } } as MediaJob
    },
  })
  expect(compileCalls).toBe(1)
  expect(events.jobs).toEqual(['job-1'])
  expect(events.progress).toEqual([60])
  expect(result.compiledPoster?.title).toBe('开业')
  expect(result.recommendedId).toBe('pass-1')
  expect(result.compareIds).toEqual(['pass-1', 'pass-2'])
})

test('质量补生成由后端任务统一处理,工作台不再发起第二个任务', async () => {
  const events = callbacks()
  let generateCalls = 0
  const reviewed = [image('pass-1', { poster_hard_gate_passed: true }), image('pass-2', { poster_hard_gate_passed: true }), image('risk-1')]
  const result = await executeImageGeneration(input(brief()), events.value, {
    async compileBrief() { throw new Error('已有 brief 时不应重编译') },
    async generate() { generateCalls += 1; return { job_id: `job-${generateCalls}` } },
    async pollJob() {
      return { status: 'done', result: { images: reviewed, quality_retry_performed: true } } as MediaJob
    },
  })
  expect(generateCalls).toBe(1)
  expect(events.jobs).toEqual(['job-1'])
  expect(result.images.map(item => item.generation_id)).toEqual(['pass-1', 'pass-2', 'risk-1'])
})

test('本地预览不能伪装成真实结果', async () => {
  await expect(executeImageGeneration(input(brief()), callbacks().value, {
    async compileBrief() { throw new Error('not used') },
    async generate() { return { job_id: 'preview' } },
    async pollJob() { return { status: 'done', result: { images: [image('local', { local_preview: true })] } } as MediaJob },
  })).rejects.toThrow('当前没有可用的图片生成服务')
})
