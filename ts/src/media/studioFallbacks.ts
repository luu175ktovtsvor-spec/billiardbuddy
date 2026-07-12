export function localStoryboard(body: Record<string, unknown>): Record<string, unknown> {
  const theme = stringOr(body.theme, stringOr(body.prompt, '门店短片'))
  const subject = stringOr(body.subject, '')
  const n = Math.max(2, Math.min(6, numberFrom(body.shots, 3)))
  const subjectText = subject ? `，主体保持为${subject}` : ''
  const shots = Array.from({ length: n }, (_, i) => {
    const step = i + 1
    if (step === 1) return `${theme}开场：给出门店环境或核心物件的建立镜头${subjectText}，运镜稳定。`
    if (step === n) return `${theme}收尾：突出到店行动或活动信息${subjectText}，画面留出文案空间。`
    return `${theme}分镜${step}：切到桌台、灯光、服务或互动细节${subjectText}，节奏自然。`
  })
  return {
    shots,
    caption: `${theme}，今天就来店里体验一下。`,
    local_preview: true,
    message: '媒体后端未配置，当前分镜为 TS 本地结构化占位；配置媒体后端后会调用真实分镜模型。',
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function numberFrom(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : fallback
}
