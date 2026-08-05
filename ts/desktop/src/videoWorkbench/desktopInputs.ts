import type {
  AnalyzeVideoProjectInput,
  CreateRemoteAnalysisConsentInput,
} from '../../../shared/contracts/media.js'
import type {
  VideoWorkbenchActionInput,
  VideoWorkbenchActionInputProvider,
  VideoWorkbenchActionInputRequest,
} from './product.js'

type PromptWindow = Pick<Window, 'confirm' | 'prompt'>

const remotePurposes = new Set<CreateRemoteAnalysisConsentInput['purposes'][number]>([
  'visual_evidence',
  'planning',
  'caption_translation',
  'asr',
  'semantic_search',
])
const remoteDataKinds = new Set<CreateRemoteAnalysisConsentInput['data_kinds'][number]>([
  'audio_extract',
  'keyframes',
  'proxy_video',
  'transcript',
])

function answer(window_: PromptWindow, title: string, initial = ''): string | undefined {
  const value = window_.prompt(title, initial)
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function csv<Value extends string>(value: string | undefined, allowed: ReadonlySet<Value>): readonly Value[] | undefined {
  if (!value) return undefined
  const entries = [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))]
  return entries.length && entries.every((item): item is Value => allowed.has(item as Value)) ? entries : undefined
}

function json<Value>(window_: PromptWindow, title: string, initial: string): Value | undefined {
  const value = answer(window_, title, initial)
  if (!value) return undefined
  try {
    return JSON.parse(value) as Value
  } catch {
    return undefined
  }
}

function selectedSource(request: VideoWorkbenchActionInputRequest): string | undefined {
  return request.selection.source_id
    ?? (request.snapshot.project.sources.length === 1 ? request.snapshot.project.sources[0]?.id : undefined)
}

function selectedVariant(request: VideoWorkbenchActionInputRequest) {
  return request.snapshot.variants.find(item => item.variant.id === request.selection.variant_id)
    ?? (request.snapshot.variants.length === 1 ? request.snapshot.variants[0] : undefined)
}

/**
 * Browser-native input prompts keep the initial desktop integration functional
 * without introducing a second local state store. Every submitted object is
 * still validated again by Preload/Main/Sidecar; prompts never request paths,
 * endpoints, credentials, or provider secrets.
 */
export function createDesktopVideoWorkbenchInputs(window_: PromptWindow = window): VideoWorkbenchActionInputProvider {
  return {
    async requestProject() {
      const title = answer(window_, '项目名称')
      return title ? { title } : undefined
    },
    async requestAction(request): Promise<VideoWorkbenchActionInput | undefined> {
      const timelineId = request.snapshot.current_timeline?.id
      const variant = selectedVariant(request)
      const sourceId = selectedSource(request)
      switch (request.action) {
        case 'estimate_budget': {
          if (!sourceId) return undefined
          const source = request.snapshot.project.sources.find(candidate => candidate.id === sourceId)
          if (!source) return undefined
          const purposes = csv(answer(window_, '远程用途（visual_evidence, planning, caption_translation, asr, semantic_search）', 'asr'), remotePurposes)
          const dataKinds = csv(answer(window_, '发送数据（audio_extract, keyframes, proxy_video, transcript）', 'audio_extract'), remoteDataKinds)
          if (!purposes || !dataKinds || !window_.confirm(`确认对素材 ${source.name} 的完整时长申请远程分析预算？`)) return undefined
          return {
            action: 'estimate_budget',
            purposes,
            source_ids: [sourceId],
            data_kinds: dataKinds,
            coverage: [{
              source_id: sourceId,
              ranges: [{
                start: { ticks: '0', tick_rate: { num: 1_000, den: 1 } },
                duration: { ticks: String(source.duration_ms), tick_rate: { num: 1_000, den: 1 } },
              }],
            }],
          }
        }
        case 'create_quick_draft': {
          const user_goal = answer(window_, '剪辑目标')
          return user_goal ? { action: 'create_quick_draft', input: { base_revision: request.snapshot.project.revision, user_goal } satisfies AnalyzeVideoProjectInput } : undefined
        }
        case 'open_editor': {
          const commands = json<Extract<VideoWorkbenchActionInput, { action: 'open_editor' }>['commands']>(window_, '编辑 CommandSet JSON', '[]')
          return commands?.length ? { action: 'open_editor', commands } : undefined
        }
        case 'open_variant_editor': {
          const commands = json<Extract<VideoWorkbenchActionInput, { action: 'open_variant_editor' }>['commands']>(window_, '交付 CommandSet JSON', '[]')
          return commands?.length ? { action: 'open_variant_editor', commands } : undefined
        }
        case 'create_variant': {
          if (!timelineId) return undefined
          const name = answer(window_, '交付变体名称')
          return name ? { action: 'create_variant', input: { name, editorial_timeline_version_id: timelineId } } : undefined
        }
        case 'create_caption': {
          if (!timelineId) return undefined
          const language = answer(window_, '字幕语言', 'zh')
          return language ? { action: 'create_caption', input: { editorial_timeline_version_id: timelineId, language } } : undefined
        }
        case 'create_caption_revision': {
          if (!timelineId) return undefined
          return json<Extract<VideoWorkbenchActionInput, { action: 'create_caption_revision' }>>(window_, '字幕修订 JSON', '{"action":"create_caption_revision","caption_document_id":"","input":{"base_revision_id":"","editorial_timeline_version_id":"","cues":[]}}')
        }
        case 'create_caption_translation': {
          if (!timelineId) return undefined
          const document = request.snapshot.caption_documents[request.snapshot.caption_documents.length - 1]
          const revision = document && request.snapshot.caption_revisions.find(candidate => candidate.id === document.current_revision_id)
          const language = answer(window_, '目标字幕语言', 'en')
          if (!document || !revision || !language) return undefined
          return {
            action: 'create_caption_translation',
            caption_document_id: document.id,
            input: {
              base_revision_id: revision.id,
              editorial_timeline_version_id: timelineId,
              language,
            },
          }
        }
        case 'create_composition_plan':
          return variant ? {
            action: 'create_composition_plan',
            input: { variant_id: variant.variant.id, base_variant_version_id: variant.version.id },
          } : undefined
        case 'create_audio_finishing_plan':
          return variant ? {
            action: 'create_audio_finishing_plan',
            input: { variant_id: variant.variant.id, base_variant_version_id: variant.version.id },
          } : undefined
        case 'analyze_beat':
          return sourceId ? { action: 'analyze_beat', input: { source_id: sourceId } } : undefined
        case 'create_beat_sync_draft': {
          if (!sourceId || !timelineId) return undefined
          const beat_evidence_id = request.selection.fact_id ?? answer(window_, '节拍证据 ID')
          return beat_evidence_id ? {
            action: 'create_beat_sync_draft',
            input: { source_id: sourceId, beat_evidence_id, base_timeline_version_id: timelineId },
          } : undefined
        }
        case 'analyze_subject_track': {
          if (!sourceId) return undefined
          const subject_id = answer(window_, '主体 ID')
          return subject_id ? { action: 'analyze_subject_track', input: { source_id: sourceId, subject_id } } : undefined
        }
        case 'confirm_post_render_quality':
          return window_.confirm('确认接受当前报告中的全部待确认检查项并发布交付文件？')
            ? { action: 'confirm_post_render_quality', confirmed: true }
            : undefined
      }
    },
  }
}
