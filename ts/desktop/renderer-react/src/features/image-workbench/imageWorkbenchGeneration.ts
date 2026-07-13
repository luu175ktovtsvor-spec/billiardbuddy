// Image generation orchestration without React state: brief compilation, polling and one bounded quality retry.

import {
  pollJob,
  studioApi,
  type GenerateInput,
  type ImageAssetReference,
  type ImageCreativeBrief,
  type ImageIntent,
  type ImageQuality,
  type StudioImage,
} from '../../api/studio'
import {
  chooseThreeCandidates,
  friendlyImageStage,
  imagePassesCandidateGate,
  portraitCandidateHasHardRisk,
} from './imageWorkbenchModel'

export interface PosterFields {
  [key: string]: unknown
  title: string
  offer: string
  price: string
  date: string
  address: string
  phone: string
  cta: string
}

export interface ImageGenerationCommandInput {
  request: string
  sceneId: string
  intent: ImageIntent
  quality: ImageQuality
  ratio: string
  count: number
  posterText: PosterFields
  referenceUrls: string[]
  referenceAssets: ImageAssetReference[]
  portraitAuthorized: boolean
  creativeBrief: ImageCreativeBrief | null
}

export interface ImageGenerationCommandCallbacks {
  signal: AbortSignal
  onJobStarted: (jobId: string) => void
  onProgress: (progress: number, stage: string) => void
  onStage: (stage: string) => void
}

export interface ImageGenerationCommandResult {
  images: StudioImage[]
  creativeBrief: ImageCreativeBrief
  compiledPoster: PosterFields | null
  recommendedId: string | null
  compareIds: string[]
}

interface ImageGenerationDependencies {
  compileBrief: typeof studioApi.compileBrief
  generate: typeof studioApi.generate
  pollJob: typeof pollJob
}

const defaultDependencies: ImageGenerationDependencies = {
  compileBrief: studioApi.compileBrief,
  generate: studioApi.generate,
  pollJob,
}

function posterFieldsFromBrief(brief: ImageCreativeBrief): PosterFields | null {
  const poster = brief.poster
  if (!poster) return null
  return {
    title: poster.title,
    offer: poster.offer,
    price: poster.price,
    date: [poster.date, poster.time].filter(Boolean).join(' '),
    address: poster.address,
    phone: poster.phone,
    cta: poster.cta,
  }
}

function usableImages(images: StudioImage[] | undefined): StudioImage[] {
  return (images ?? []).filter(image => image.local_preview !== true)
}

export async function executeImageGeneration(
  input: ImageGenerationCommandInput,
  callbacks: ImageGenerationCommandCallbacks,
  dependencies: ImageGenerationDependencies = defaultDependencies,
): Promise<ImageGenerationCommandResult> {
  let brief = input.creativeBrief
  let compiledPoster: PosterFields | null = null
  if (!brief) {
    const result = await dependencies.compileBrief({
      prompt: input.request,
      scene: input.intent === 'portrait' ? 'portrait' : 'poster',
      intent: input.intent,
      ratio: input.ratio,
      quality: input.quality,
      scene_template_id: input.sceneId,
      poster_text: input.posterText,
      reference_assets: input.referenceAssets,
      portrait_authorization_confirmed: input.portraitAuthorized,
    })
    brief = result.brief
    compiledPoster = posterFieldsFromBrief(brief)
    callbacks.onStage('正在生成图片…')
  }

  const generateInput: GenerateInput = {
    prompt: input.request,
    user_request: input.request,
    scene_template_id: input.sceneId,
    ratio: input.ratio,
    count: input.count,
    intent: input.intent,
    quality: input.quality,
    reference_image_paths: input.referenceUrls,
    reference_assets: input.referenceAssets,
    poster_text: input.posterText,
    portrait_consent: input.portraitAuthorized,
    portrait_authorization_confirmed: input.portraitAuthorized,
    input_fidelity: input.referenceAssets.length > 0 ? 'high' : undefined,
    creative_brief: brief,
  }
  const started = await dependencies.generate(generateInput)
  callbacks.onJobStarted(started.job_id)
  const job = await dependencies.pollJob(started.job_id, {
    signal: callbacks.signal,
    onProgress: (progress, stage) => callbacks.onProgress(progress, friendlyImageStage(stage, '正在生成图片…')),
    intervalMs: 600,
  })
  const result = job.result ?? {}
  if (job.status !== 'done') throw new Error(result.message || job.error || '生成失败')
  if (result.blocked) throw new Error(result.message || '所需组件正在后台准备,稍后再试。')
  let images = usableImages(result.images)
  if ((result.images ?? []).some(image => image.local_preview === true) && images.length === 0) {
    throw new Error('当前没有可用的图片生成服务，暂时无法生成图片。')
  }
  if (images.length === 0) throw new Error('没有生成图片,换个描述再试试')

  const hardGatePassed = images.filter(image => imagePassesCandidateGate(image, input.intent)).length
  const needsPosterSupplement = input.intent === 'poster_text' && images.length === 3 && hardGatePassed < 2
  const needsPortraitSupplement = input.intent === 'portrait' && images.length === 3 && images.every(portraitCandidateHasHardRisk)
  if (needsPosterSupplement || needsPortraitSupplement) {
    callbacks.onStage('部分结果需要确认，正在再试一次…')
    try {
      const retry = await dependencies.generate(generateInput)
      callbacks.onJobStarted(retry.job_id)
      const retryJob = await dependencies.pollJob(retry.job_id, {
        signal: callbacks.signal,
        onProgress: (progress, stage) => callbacks.onProgress(progress, friendlyImageStage(stage, '正在生成图片…')),
        intervalMs: 600,
      })
      const retryImages = retryJob.status === 'done' && !retryJob.result?.blocked
        ? usableImages(retryJob.result?.images)
        : []
      images = chooseThreeCandidates([...images, ...retryImages], input.intent)
    } catch {
      // The first batch stays usable. One supplemental generation is the cost ceiling.
    }
  }

  const finalBrief = result.creative_brief ?? brief
  const recommendedId = images.find(image => imagePassesCandidateGate(image, input.intent))?.generation_id
    ?? (typeof result.recommended_generation_id === 'string' ? result.recommended_generation_id : null)
  return {
    images,
    creativeBrief: finalBrief,
    compiledPoster,
    recommendedId: recommendedId ?? images[0]?.generation_id ?? null,
    compareIds: images.slice(0, 2).map(image => image.generation_id),
  }
}
