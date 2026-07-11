// 剪视频看板 api(接后端 /api/v1/video-edit/*)。出方案(auto_plan→planEdit 真五步)→ 出片(render)。
// 媒体 job 轮询/成片 url 复用 studio.ts 的 pollJob/assetUrl(同一 media-jobs 端点)。
import { api } from './client'

export interface VideoPlanInput {
  /** 本机视频素材绝对路径(必填,可多段)。 */
  video_paths: string[]
  /** 'speech' 口播路 / 'ambient' 环境氛围路;不传自动判。 */
  mode?: 'speech' | 'ambient'
  /** 画面比例 9:16 / 1:1 / 16:9 / 原片(留空)。 */
  ratio?: string
  /** 目标时长(秒)。 */
  target_duration?: number
  /** 项目名(续剪带同一个;不传后端生成)。 */
  project?: string
}

/** planEdit 出方案结果(节选前端要展示的)。 */
export interface VideoPlanResult {
  project?: string
  route?: string
  route_reason?: string
  report?: string
  candidates?: Array<{ media?: string; name?: string; duration?: number; has_speech?: boolean }>
  broll?: boolean
  used_vlm?: boolean
  transcribed?: boolean
  footage_warnings?: string[]
  health_summary?: { total?: number; bad?: number; warning_count?: number; has_audio?: boolean }
  /** 资产未就绪:blocked + message("正在准备组件 x%")。 */
  blocked?: boolean
  message?: string
}

/** render 出片结果(节选)。 */
export interface VideoRenderResult {
  video_url?: string
  url?: string
  output_url?: string
  caveats?: string[]
  blocked?: boolean
  message?: string
}

export const videoApi = {
  /** 出方案:自动判口播/氛围(或 mode 指定),口播转写 / 氛围视觉五步。异步,返回 job_id + project。 */
  autoPlan: (input: VideoPlanInput) =>
    api.post<{ job_id: string; project?: string }>('/api/v1/video-edit/auto_plan', {
      video_paths: input.video_paths,
      mode: input.mode,
      ratio: input.ratio,
      target_duration: input.target_duration,
      project: input.project,
    }),
  /** 出片:把方案渲染成 MP4。preview=true 出快速低清预览。异步,返回 job_id。 */
  render: (project: string, preview?: boolean) =>
    api.post<{ job_id: string }>(`/api/v1/video-edit/projects/${encodeURIComponent(project)}/render`, { preview: preview === true }),
}

/** 从 render 结果里挑成片 url(后端字段名可能是 video_url/url/output_url 之一)。 */
export function pickVideoUrl(result: VideoRenderResult | undefined): string | undefined {
  return result?.video_url ?? result?.url ?? result?.output_url
}
