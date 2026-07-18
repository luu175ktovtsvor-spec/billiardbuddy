import { memo } from 'react'
import type { UIAttachment } from '../../types/chat'
import { AttachmentGallery } from './AttachmentGallery'
import { MessageActionBar, type MessageBranchAction } from './MessageActionBar'

type Props = {
  content: string
  attachments?: UIAttachment[]
  branchAction?: MessageBranchAction
  sideTaskAction?: MessageBranchAction
  timestamp?: number
}

export const UserMessage = memo(function UserMessage({ content, attachments, branchAction, sideTaskAction, timestamp }: Props) {
  const hasText = content.trim().length > 0

  return (
    <div className="mb-4 flex justify-end">
      <div
        data-message-shell="user"
        className="group flex min-w-0 max-w-[80%] flex-col items-end"
      >
        <div className="flex max-w-full flex-col items-end gap-2">
          {attachments && attachments.length > 0 && (
            <AttachmentGallery attachments={attachments} variant="message" />
          )}

          {hasText && (
            <div
              className="min-w-0 max-w-full rounded-2xl bg-[var(--color-surface-user-msg)] px-4 py-2 text-sm leading-relaxed text-[var(--color-text-primary)] whitespace-pre-wrap break-words"
              style={{
                overflowWrap: 'anywhere',
                wordBreak: 'break-word',
              }}
            >
              {content}
            </div>
          )}
        </div>

        {hasText && (
          <MessageActionBar
            copyText={content}
            copyLabel="Copy prompt"
            branchAction={branchAction}
            sideTaskAction={sideTaskAction}
            align="end"
            timestamp={timestamp}
          />
        )}
      </div>
    </div>
  )
})
