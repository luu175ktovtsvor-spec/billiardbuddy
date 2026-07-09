// 输入区(最小版)。Block C 会用 cc ChatInput 替换(斜杠面板 / 文件拖拽 / @提及 / 模型选择 / 发送快捷键)。
import { useRef, useState, type KeyboardEvent } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { t } from '../../i18n'

export function ChatInput() {
  const [value, setValue] = useState('')
  const status = useChatStore((s) => s.status)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const interrupt = useChatStore((s) => s.interrupt)
  const taRef = useRef<HTMLTextAreaElement>(null)

  function submit() {
    const text = value.trim()
    if (!text) return
    sendMessage(text)
    setValue('')
    if (taRef.current) taRef.current.style.height = 'auto'
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  function autoGrow() {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }

  return (
    <div className="px-4 pb-4 pt-2">
      <div
        className="mx-auto flex max-w-[760px] items-end gap-2 rounded-2xl p-2"
        style={{ border: '1px solid var(--color-border-strong)', background: 'var(--color-surface)' }}
      >
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            autoGrow()
          }}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={t('chat.placeholder')}
          className="flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
          style={{ color: 'var(--color-text-primary)', maxHeight: 200 }}
          data-testid="chat-input"
        />
        {status === 'running' ? (
          <button
            type="button"
            onClick={interrupt}
            className="shrink-0 rounded-xl px-4 py-2 text-sm font-medium"
            style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            {t('chat.stop')}
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!value.trim()}
            className="shrink-0 rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            style={{ background: 'var(--color-primary)' }}
            data-testid="chat-send"
          >
            {t('chat.send')}
          </button>
        )}
      </div>
    </div>
  )
}
