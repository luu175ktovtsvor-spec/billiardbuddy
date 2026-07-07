import type { AssistantStep, Model, ModelStepInput } from '../types/model'

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
      try {
        const step = await candidate.model.step(input)
        try { candidate.onSuccess?.() } catch { /* health callbacks must not break model output */ }
        if (failures.length === 0) return step
        this.preferredIndex = index
        const target = index === 0 ? '模型出口' : '备用模型出口'
        return withNotices(step, [
          ...failures,
          `已切换到${target}「${candidate.label}」继续。`,
        ])
      } catch (err) {
        if (input.signal?.aborted) throw err
        try { candidate.onFailure?.(err) } catch { /* health callbacks must not mask provider errors */ }
        failures.push(`模型出口「${candidate.label}」请求失败:${sanitizeError(err)}`)
      }
    }
    throw new Error(`所有模型出口都失败:${failures.join('；')}`)
  }
}
