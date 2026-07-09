// 输入框(核心 · 对标真机 WorkBuddy 布局 + 交互接 chatStore 对标 cc)。
// 结构:大圆角矩形(16px)+ 细边框 + 柔和阴影 + surface 底;上=自增高 textarea,下=工具条。
// 工具条 左:+ 附件(圆) · 权限档选择(盾+默认权限+⌄);右:忙时转圈 · 自动(白标模型代称+⌄) · 麦克 · 发送(实心深圆+上箭头)。
// 交互:回车发送/Shift+回车换行(对齐 cc);/ 调起技能面板、@ 调起引用入口(先接住,细节后续)。
import { useRef, useState, useEffect, type KeyboardEvent, type ReactNode, type CSSProperties } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { PermissionMode } from '../../types/chat'
import {
  IconPlus, IconShield, IconChevronDown, IconSparkles, IconMic, IconArrowUp, IconSpinner, IconSlash, IconAt,
} from '../shared/icons'
import { t } from '../../i18n'

const PERM_ORDER: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']
const PERM_LABEL: Record<PermissionMode, string> = {
  default: t('permission.default'),
  acceptEdits: t('permission.acceptEdits'),
  plan: t('permission.plan'),
  bypassPermissions: t('permission.bypass'),
  dontAsk: t('permission.bypass'),
}
const PERM_DESC: Record<PermissionMode, string> = {
  default: t('permission.defaultDesc'),
  acceptEdits: t('permission.acceptEditsDesc'),
  plan: t('permission.planDesc'),
  bypassPermissions: t('permission.bypassDesc'),
  dontAsk: t('permission.bypassDesc'),
}

/** 轻量下拉:相对容器 + 绝对菜单 + 透明遮罩兜底关闭。 */
function Popover({ open, onClose, children, align = 'left' }: { open: boolean; onClose: () => void; children: ReactNode; align?: 'left' | 'right' }) {
  if (!open) return null
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="absolute bottom-full z-50 mb-2 min-w-[220px] overflow-hidden rounded-xl py-1"
        style={{
          [align]: 0,
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          boxShadow: 'var(--shadow-popover)',
        } as CSSProperties}
      >
        {children}
      </div>
    </>
  )
}

function ToolbarChip({ onClick, children }: { onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
    >
      {children}
    </button>
  )
}

function PermissionMenu() {
  const mode = useSettingsStore((s) => s.defaultPermissionMode)
  const setMode = useSettingsStore((s) => s.setPermissionMode)
  const [open, setOpen] = useState(false)
  const current = PERM_ORDER.includes(mode) ? mode : 'default'
  return (
    <div className="relative">
      <ToolbarChip onClick={() => setOpen((v) => !v)}>
        <IconShield size={15} />
        <span>{PERM_LABEL[current]}</span>
        <IconChevronDown size={13} style={{ color: 'var(--color-text-tertiary)' }} />
      </ToolbarChip>
      <Popover open={open} onClose={() => setOpen(false)}>
        {PERM_ORDER.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); setOpen(false) }}
            className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            <span className="mt-0.5" style={{ color: m === current ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)' }}>
              <IconShield size={15} />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px]" style={{ color: 'var(--color-text-primary)', fontWeight: m === current ? 600 : 400 }}>{PERM_LABEL[m]}</span>
              <span className="block text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{PERM_DESC[m]}</span>
            </span>
          </button>
        ))}
      </Popover>
    </div>
  )
}

function ModelMenu() {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <ToolbarChip onClick={() => setOpen((v) => !v)}>
        <IconSparkles size={15} />
        <span>{t('model.auto')}</span>
        <IconChevronDown size={13} style={{ color: 'var(--color-text-tertiary)' }} />
      </ToolbarChip>
      <Popover open={open} onClose={() => setOpen(false)} align="right">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
        >
          <IconSparkles size={15} style={{ color: 'var(--color-text-primary)' }} />
          <span className="flex-1 text-[13px]" style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{t('model.auto')}</span>
          <span style={{ color: 'var(--color-text-primary)' }}>✓</span>
        </button>
      </Popover>
    </div>
  )
}

/** / 技能面板 与 @ 引用入口(先接住:调起即显,选项细节后续)。 */
function TokenPanel({ token, onPick }: { token: '/' | '@'; onPick: (text: string) => void }) {
  const slashItems = [
    { name: '/台球', desc: '挂载台球运营专家领域包' },
    { name: '/帮助', desc: '看看能做什么' },
    { name: '/清空', desc: '清空当前对话' },
  ]
  return (
    <div
      className="absolute bottom-full left-0 z-50 mb-2 w-[320px] overflow-hidden rounded-xl py-1"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-popover)' }}
    >
      {token === '/' ? (
        slashItems.map((it) => (
          <button
            key={it.name}
            type="button"
            onMouseDown={(e) => { e.preventDefault(); onPick(it.name + ' ') }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            <IconSlash size={14} style={{ color: 'var(--color-text-tertiary)' }} />
            <span className="text-[13px]" style={{ color: 'var(--color-text-primary)' }}>{it.name}</span>
            <span className="truncate text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{it.desc}</span>
          </button>
        ))
      ) : (
        <div className="flex items-center gap-2 px-3 py-2">
          <IconAt size={14} style={{ color: 'var(--color-text-tertiary)' }} />
          <span className="text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>引用对话 / 文件(即将支持)</span>
        </div>
      )}
    </div>
  )
}

export function Composer() {
  const [value, setValue] = useState('')
  const status = useChatStore((s) => s.status)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const interrupt = useChatStore((s) => s.interrupt)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const running = status === 'running'

  // / 或 @ 起头 → 调起对应面板(先接住入口)。
  const trimmedStart = value.trimStart()
  const tokenPanel: '/' | '@' | null =
    trimmedStart === value && value.length > 0 && (value[0] === '/' || value[0] === '@') && !value.includes(' ')
      ? (value[0] as '/' | '@')
      : null

  function autoGrow() {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }
  useEffect(autoGrow, [value])

  function submit() {
    const text = value.trim()
    if (!text || running) return
    sendMessage(text)
    setValue('')
    if (taRef.current) taRef.current.style.height = 'auto'
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const canSend = value.trim().length > 0

  return (
    <div className="px-4 pb-2 pt-1">
      <div className="relative mx-auto w-full" style={{ maxWidth: 832 }}>
        {tokenPanel && <TokenPanel token={tokenPanel} onPick={(txt) => { setValue(txt); taRef.current?.focus() }} />}
        <div
          className="flex flex-col rounded-2xl"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border-strong)', boxShadow: 'var(--shadow-input)' }}
        >
          <textarea
            ref={taRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={t('chat.placeholder')}
            className="resize-none bg-transparent px-4 pt-3.5 text-sm leading-relaxed outline-none"
            style={{ color: 'var(--color-text-primary)', maxHeight: 200 }}
            data-testid="chat-input"
          />
          {/* 底部工具条 */}
          <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1.5">
            {/* 左:附件 + 权限 */}
            <button
              type="button"
              title={t('chat.attach')}
              aria-label={t('chat.attach')}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--color-surface-hover)]"
              style={{ color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
            >
              <IconPlus size={17} />
            </button>
            <PermissionMenu />
            <div className="flex-1" />
            {/* 右:忙时转圈 · 自动 · 麦克 · 发送 */}
            {running && <IconSpinner size={16} style={{ color: 'var(--color-text-tertiary)' }} />}
            <ModelMenu />
            <button
              type="button"
              title={t('chat.mic')}
              aria-label={t('chat.mic')}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--color-surface-hover)]"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              <IconMic size={18} />
            </button>
            {running ? (
              <button
                type="button"
                onClick={interrupt}
                title={t('chat.stop')}
                aria-label={t('chat.stop')}
                data-testid="chat-stop"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)' }}
              >
                <span className="block h-2.5 w-2.5 rounded-[3px]" style={{ background: 'var(--color-on-primary)' }} />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                title={t('chat.send')}
                aria-label={t('chat.send')}
                data-testid="chat-send"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-30"
                style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)' }}
              >
                <IconArrowUp size={18} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
