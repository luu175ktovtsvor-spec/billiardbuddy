// 忙碌胶囊(对齐 cc-haha-ref desktop/src/components/chat/StreamingIndicator.tsx:118-147 的默认分支:
// ✦ + 动词 + 秒表 + 估算已流出 token)。api_retry/streaming_fallback 两条横幅走 MessageList 的
// note 块(variant='api_retry'|'streaming_fallback'),不在这里画——理由见 stores/chatStore.ts
// context_note 分支的注释:后端目前只把它们塞进 context_note 文本,不是独立 WS 消息类型。
//
// 视觉皮改造(owner 2026-07-11)吸收 Codex 真机的一个小点:居中的"第 N/M 步"进度胶囊——
// 复用已有 todos(SessionTaskBar 同一份数据),不新起协议字段。
import { useChatStore } from '../../stores/chatStore'
import { IconSpinner } from '../shared/icons'
import { t } from '../../i18n'

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m${s}s`
}

function StepProgressPill() {
  const todos = useChatStore((s) => s.todos)
  const total = todos.length
  if (total < 2) return null
  const done = todos.filter((td) => td.status === 'done').length
  const current = Math.min(done + 1, total)
  return (
    <div className="mb-2 flex justify-center">
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px]"
        style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface-container-low)', color: 'var(--color-text-tertiary)' }}
      >
        <IconSpinner size={11} />
        {t('chat.stepPrefix')} {current}/{total} {t('chat.stepSuffix')}
      </span>
    </div>
  )
}

export function StreamingIndicator() {
  const status = useChatStore((s) => s.status)
  const runVerb = useChatStore((s) => s.runVerb)
  const elapsedSeconds = useChatStore((s) => s.elapsedSeconds)
  if (status !== 'running') return null

  const label = runVerb === 'thinking' ? t('chat.thinking') : runVerb === 'running' ? t('chat.running') : t('chat.working')

  return (
    <>
      <StepProgressPill />
      <div
        className="mb-2 inline-flex w-fit items-center gap-2 rounded-full px-3 py-1"
        style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface-container-low)' }}
        data-testid="streaming-indicator"
      >
        <span className="qf-spark text-xs" style={{ color: 'var(--color-brand)' }}>✦</span>
        <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>{label}</span>
        {elapsedSeconds > 0 && (
          <span className="text-[10px] tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>{formatElapsed(elapsedSeconds)}</span>
        )}
      </div>
    </>
  )
}
