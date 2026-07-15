// 招聘 REST 边界:候选人、草稿、岗位与漏斗。业务规则(去重、留痕、sent 证据闸)归 RecruitmentService。
// 未来招聘工作台(前端)与聊天工具共用同一服务——三条入口一份事实源。

import { z } from 'zod'
import {
  recruitmentDraftStatusSchema,
  recruitmentStageSchema,
} from '../../../shared/contracts/recruitment'
import type { RecruitmentService } from '../../recruitment/recruitmentService'
import { jsonDetailError } from '../middleware/http'

const addCandidatesBody = z.object({
  candidates: z.array(z.object({
    name: z.string().min(1).max(80),
    position: z.string().min(1).max(80),
    source: z.string().min(1).max(40).optional(),
    external_ref: z.string().max(400).optional(),
    stage: recruitmentStageSchema.optional(),
    notes: z.string().max(4_000).optional(),
    next_action: z.string().max(400).optional(),
    next_action_due: z.string().optional(),
  })).min(1).max(200),
})

const patchCandidateBody = z.object({
  stage: recruitmentStageSchema.optional(),
  note: z.string().max(2_000).optional(),
  next_action: z.string().max(400).optional(),
  next_action_due: z.string().optional(),
}).refine(body => body.stage !== undefined || body.next_action !== undefined, {
  message: 'stage 或 next_action 至少提供一个',
})

const saveDraftBody = z.object({
  candidate_id: z.string().min(1),
  content: z.string().min(1).max(4_000),
})

const patchDraftBody = z.object({
  status: recruitmentDraftStatusSchema,
  evidence: z.string().max(2_000).optional(),
})

const upsertPositionBody = z.object({
  title: z.string().min(1).max(80),
  openings: z.number().int().min(0).max(999),
  notes: z.string().max(2_000).optional(),
})

function methodNotAllowed(): Response {
  return new Response('Method not allowed', { status: 405 })
}

async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T | Response> {
  const raw = await req.json().catch(() => null)
  const result = schema.safeParse(raw)
  if (!result.success) return jsonDetailError(result.error.issues[0]?.message ?? 'invalid body', 400)
  return result.data
}

export function createRecruitmentRouteHandler(deps: { service: RecruitmentService }) {
  return async function handleRecruitmentRoute(url: URL, req: Request): Promise<Response | null> {
    if (!url.pathname.startsWith('/api/v1/recruitment')) return null
    const { service } = deps

    try {
      if (url.pathname === '/api/v1/recruitment/candidates') {
        if (req.method === 'GET') {
          const stageRaw = url.searchParams.get('stage')?.trim()
          const stage = stageRaw ? recruitmentStageSchema.safeParse(stageRaw) : null
          if (stage && !stage.success) return jsonDetailError(`未知阶段:${stageRaw}`, 400)
          return Response.json({
            candidates: await service.listCandidates({
              stage: stage?.success ? stage.data : undefined,
              dueOnly: url.searchParams.get('due') === 'today',
            }),
          })
        }
        if (req.method === 'POST') {
          const body = await parseBody(req, addCandidatesBody)
          if (body instanceof Response) return body
          const result = await service.addCandidates(body.candidates.map(candidate => ({
            name: candidate.name,
            position: candidate.position,
            source: candidate.source,
            externalRef: candidate.external_ref,
            stage: candidate.stage,
            notes: candidate.notes,
            nextAction: candidate.next_action,
            nextActionDue: candidate.next_action_due,
          })))
          return Response.json(result, { status: 201 })
        }
        return methodNotAllowed()
      }

      const candidateMatch = url.pathname.match(/^\/api\/v1\/recruitment\/candidates\/([^/]+)$/)
      if (candidateMatch) {
        const id = decodeURIComponent(candidateMatch[1]!)
        if (req.method === 'GET') {
          const candidate = await service.getCandidate(id)
          return candidate ? Response.json(candidate) : jsonDetailError('candidate not found', 404)
        }
        if (req.method === 'PATCH') {
          const body = await parseBody(req, patchCandidateBody)
          if (body instanceof Response) return body
          if (!(await service.getCandidate(id))) return jsonDetailError('candidate not found', 404)
          const candidate = body.stage !== undefined
            ? await service.updateStage(id, body.stage, { note: body.note, nextAction: body.next_action, nextActionDue: body.next_action_due })
            : await service.setFollowUp(id, body.next_action!, body.next_action_due)
          return Response.json(candidate)
        }
        return methodNotAllowed()
      }

      if (url.pathname === '/api/v1/recruitment/drafts') {
        if (req.method === 'GET') {
          return Response.json({ drafts: await service.listDrafts(url.searchParams.get('candidate_id')?.trim() || undefined) })
        }
        if (req.method === 'POST') {
          const body = await parseBody(req, saveDraftBody)
          if (body instanceof Response) return body
          return Response.json(await service.saveDraft(body.candidate_id, body.content), { status: 201 })
        }
        return methodNotAllowed()
      }

      const draftMatch = url.pathname.match(/^\/api\/v1\/recruitment\/drafts\/([^/]+)$/)
      if (draftMatch) {
        if (req.method !== 'PATCH') return methodNotAllowed()
        const body = await parseBody(req, patchDraftBody)
        if (body instanceof Response) return body
        return Response.json(await service.updateDraftStatus(decodeURIComponent(draftMatch[1]!), body.status, body.evidence))
      }

      if (url.pathname === '/api/v1/recruitment/positions') {
        if (req.method === 'GET') return Response.json({ positions: await service.listPositions() })
        if (req.method === 'POST') {
          const body = await parseBody(req, upsertPositionBody)
          if (body instanceof Response) return body
          return Response.json(await service.upsertPosition(body.title, body.openings, body.notes), { status: 201 })
        }
        return methodNotAllowed()
      }

      if (url.pathname === '/api/v1/recruitment/funnel') {
        if (req.method !== 'GET') return methodNotAllowed()
        return Response.json(await service.funnelReport())
      }

      return null
    } catch (err) {
      // 领域错误(不存在/证据闸/数据损坏)统一按 409/404 语义外露:让工作台能把原因展示给用户。
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('不存在')) return jsonDetailError(message, 404)
      return jsonDetailError(message, 409)
    }
  }
}
