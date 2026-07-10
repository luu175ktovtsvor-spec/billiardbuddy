import type { AssistantStep, Model, ModelStepDelta, ModelStepInput } from '../types/model'

export interface FallbackModelCandidate {
  label: string
  model: Model
  onFailure?: (err: unknown) => void
  onSuccess?: () => void
}

function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .slice(0, 220)
}

function withNotices(step: AssistantStep, notices: string[]): AssistantStep {
  if (notices.length === 0) return step
  return { ...step, notices: [...notices, ...(step.notices ?? [])] }
}

export class FallbackModel implements Model {
  private preferredIndex = 0

  constructor(private readonly candidates: FallbackModelCandidate[]) {
    if (candidates.length === 0) throw new Error('FallbackModel requires at least one provider')
  }

  async step(input: ModelStepInput): Promise<AssistantStep> {
    const failures: string[] = []
    const start = Math.min(this.preferredIndex, this.candidates.length - 1)
    const order = [
      ...this.candidates.slice(start).map((_, offset) => start + offset),
      ...this.candidates.slice(0, start).map((_, index) => index),
    ]
    for (const index of order) {
      if (input.signal?.aborted) throw new Error('模型请求已中断')
      const candidate = this.candidates[index]!
      // 每个候选独立的流式增量缓冲:候选流式产出先攒进 buffered,只有最终【中选】(成功)的候选
      // 才把这些增量按序放行给上游 onDelta;失败候选的 buffered 一律丢弃、绝不转发。
      // 否则失败候选的半截正文会滞留前端气泡,叠加中选候选重发的正文 = 跨供应商 fallback 的
      // 孤儿/打字机重影(tool_calls 分支无 final 覆盖,孤儿会永久残留)。语义对齐 cc query.ts:906-926:
      // 切换出口前先丢弃失败尝试的部分产出、再以干净状态跑中选出口。
      const buffered: ModelStepDelta[] = []
      const capture = input.onDelta ? (d: ModelStepDelta): void => { buffered.push(d) } : undefined
      try {
        const step = await candidate.model.step({ ...input, onDelta: capture })
        // 中选:先把本候选缓冲的流式增量按序放行(前端只见中选出口的输出,渲染路径与非 fallback 一致),再返回。
        if (input.onDelta) for (const d of buffered) input.onDelta(d)
        try { candidate.onSuccess?.() } catch { /* health callbacks must not break model output */ }
        if (failures.length === 0) return step
        this.preferredIndex = index
        const target = index === 0 ? '模型出口' : '备用模型出口'
        return withNotices(step, [
          ...failures,
          `已切换到${target}「${candidate.label}」继续。`,
        ])
      } catch (err) {
        // 失败候选:buffered 直接丢弃(不放行),前端不会残留任何孤儿部分输出。
        if (input.signal?.aborted) throw err
        try { candidate.onFailure?.(err) } catch { /* health callbacks must not mask provider errors */ }
        failures.push(`模型出口「${candidate.label}」请求失败:${sanitizeError(err)}`)
      }
    }
    throw new Error(`所有模型出口都失败:${failures.join('；')}`)
  }
}
