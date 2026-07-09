// 运行态 pill(对齐 cc StreamingIndicator / app.js runIndicator:亮「处理中…/思考中…/运行中…」)。
// Block A 会补计时/token 计数。
import { useChatStore } from '../../stores/chatStore'
import { t } from '../../i18n'

export function StreamingIndicator() {
  const status = useChatStore((s) => s.status)
  const runVerb = useChatStore((s) => s.runVerb)
  if (status !== 'running') return null
  const label = runVerb === 'thinking' ? t('chat.thinking') : runVerb === 'running' ? t('chat.running') : t('chat.working')
  return (
    <div className="flex items-center gap-2 px-4 py-2 text-sm" style={{ color: 'var(--color-text-tertiary)' }}>
      <span className="qf-spark" style={{ color: 'var(--color-brand)' }}>✦</span>
      <span>{label}</span>
    </div>
  )
}
