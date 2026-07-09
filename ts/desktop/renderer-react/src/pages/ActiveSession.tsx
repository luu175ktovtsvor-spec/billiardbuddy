// 主聊天屏:消息流 / 空态 hero + 输入框 + 页脚。
import { MessageList } from '../components/chat/MessageList'
import { Composer } from '../components/chat/Composer'
import { useChatStore } from '../stores/chatStore'
import { EmptyHero } from './EmptySession'
import { t } from '../i18n'

export function ActiveSession() {
  const hasBlocks = useChatStore((s) => s.blocks.length > 0)
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="active-session">
      {hasBlocks ? <MessageList /> : <div className="flex-1 overflow-y-auto"><EmptyHero /></div>}
      <Composer />
      <div className="pb-2 text-center text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
        {t('chat.footer')}
      </div>
    </div>
  )
}
