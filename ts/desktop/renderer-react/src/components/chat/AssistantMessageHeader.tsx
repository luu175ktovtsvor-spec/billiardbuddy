// 助手回合头(照 Codex:助手回复**不挂头像、不挂名字**,只在上方一行灰色「已处理 Ns ⌄」)。
// owner 2026-07-11 拍板:去掉「球房管家 + 笑脸」头像行(那是旧 WorkBuddy 风)。
// chevron = 折叠/展开这一回合的过程(深度思考 + 工具行 + 回复正文),默认展开。
// owner 2026-07-11:前端不露 token 角标(Codex 也不显示),流式态只写「生成回复中」。
import { IconChevronDown } from '../shared/icons'
import { t } from '../../i18n'

export function AssistantMessageHeader({
  streaming,
  durationSec,
  collapsed,
  onToggle,
}: {
  streaming: boolean
  durationSec?: number
  collapsed: boolean
  onToggle: () => void
}) {
  const statusText = streaming
    ? t('chat.generating')
    : `${t('chat.processed')}${typeof durationSec === 'number' && durationSec > 0 ? ` ${durationSec}s` : ''}`

  return (
    <button
      type="button"
      onClick={onToggle}
      className="mb-0.5 mt-3 flex items-center gap-1 rounded-md py-0.5 pr-1.5 text-[11.5px] transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ color: 'var(--color-text-tertiary)' }}
      data-block="assistant-header"
    >
      <span>{statusText}</span>
      <IconChevronDown size={12} style={{ transform: collapsed ? 'rotate(-90deg)' : undefined, transition: 'transform .15s ease' }} />
    </button>
  )
}
