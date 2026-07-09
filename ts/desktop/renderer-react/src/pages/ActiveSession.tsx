// 主聊天屏(地基最小闭环:消息流 + 输入区)。
// Block A/B/C/E 会在此扩:右侧预览面板(task#17)、任务条、背景任务条等。
import { MessageList } from '../components/chat/MessageList'
import { ChatInput } from '../components/chat/ChatInput'
import { useChatStore } from '../stores/chatStore'
import { EmptyHero } from './EmptySession'

export function ActiveSession() {
  const hasBlocks = useChatStore((s) => s.blocks.length > 0)
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="active-session">
      {hasBlocks ? <MessageList /> : <div className="flex-1 overflow-y-auto"><EmptyHero /></div>}
      <ChatInput />
    </div>
  )
}
