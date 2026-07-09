// 消息流(最小版,渲染 chatStore.blocks)。Block A 会用 cc MessageList + AssistantMessage/UserMessage 等替换。
import { useEffect, useRef } from 'react'
import { useChatStore, type ChatBlock } from '../../stores/chatStore'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { ToolCallCard } from './ToolCallCard'
import { ApprovalCard } from './ApprovalCard'
import { StreamingIndicator } from './StreamingIndicator'
import { t } from '../../i18n'

function Block({ block }: { block: ChatBlock }) {
  switch (block.kind) {
    case 'user':
      return (
        <div className="flex justify-end my-2" data-block="user">
          <div
            className="max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap"
            style={{ background: 'var(--color-bubble-user)', color: 'var(--color-text-primary)' }}
          >
            {block.text}
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div className="my-2 text-sm leading-relaxed" data-block="assistant" style={{ color: 'var(--color-text-primary)' }}>
          <MarkdownRenderer content={block.text} />
          {block.streaming && <span className="qf-cursor">▍</span>}
        </div>
      )
    case 'thinking':
      return (
        <details className="my-1.5 text-sm" data-block="thinking" style={{ color: 'var(--color-text-tertiary)' }} open>
          <summary className="cursor-pointer select-none">{t('chat.thinking')}</summary>
          <div className="mt-1 whitespace-pre-wrap pl-3" style={{ borderLeft: '2px solid var(--color-border)' }}>
            {block.text}
          </div>
        </details>
      )
    case 'tool':
      return <ToolCallCard block={block} />
    case 'approval':
      return <ApprovalCard block={block} />
    case 'note': {
      const color = block.variant === 'error' ? 'var(--color-error)' : 'var(--color-text-tertiary)'
      return (
        <div className="my-1.5 text-xs whitespace-pre-wrap" data-block="note" style={{ color }}>
          {block.text}
        </div>
      )
    }
  }
}

export function MessageList() {
  const blocks = useChatStore((s) => s.blocks)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [blocks])

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      <div className="mx-auto max-w-[760px]">
        {blocks.map((b) => (
          <Block key={b.id} block={b} />
        ))}
        <StreamingIndicator />
        <div ref={endRef} />
      </div>
    </div>
  )
}
