// 输入框(核心 · 照 Codex:大圆角 + 底部工具条)。owner 2026-07-11:
//  - 不显示模型名(白标),砍掉模型选择器;
//  - 权限胶囊照 Codex:完全访问态橙色警告 + 点开权限菜单;
//  - 斜杠命令:输入 / → 拉真实命令(/api/v1/agent/commands)浮层,上下键选、回车填入;
//  - 占位照 Codex:新任务态「随心输入」/ 跟进态「要求后续变更」。
import { useRef, useState, useEffect, useMemo, type KeyboardEvent, type ReactNode, type CSSProperties } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useFilePreviewStore, type TreeEntry } from '../../stores/filePreviewStore'
import { useComposerStore } from '../../stores/composerStore'
import { useUiStore } from '../../stores/uiStore'
import { api } from '../../api/client'
import type { PermissionMode } from '../../types/chat'
import {
  IconPlus, IconShield, IconAlertCircle, IconChevronDown, IconMic, IconArrowUp, IconSpinner, IconSlash, IconAt,
  IconFolder, IconTarget, IconChecklist, IconPuzzle,
} from '../shared/icons'
import { MenuList } from '../shared/Menu'
import { toast } from '../../stores/toastStore'
import { getDesktopHost } from '../../lib/desktopHost'
import { t } from '../../i18n'

/** 把选中的文件/文件夹绝对路径追加进输入框(不覆盖用户已输入的文字);含空格的路径加引号,本机 agent 据此去读。 */
function appendPathsToInput(current: string, paths: string[]): string {
  const formatted = paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ')
  if (!current || /\s$/.test(current)) return current + formatted + ' '
  return current + ' ' + formatted + ' '
}

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

interface SlashCommand { name: string; desc: string }
interface CommandsResp { commands?: Array<{ name?: string; description?: string; desc?: string }> }

/** 轻量下拉:相对容器 + 绝对菜单 + 透明遮罩兜底关闭。 */
function Popover({ open, onClose, children, align = 'left' }: { open: boolean; onClose: () => void; children: ReactNode; align?: 'left' | 'right' }) {
  if (!open) return null
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="absolute bottom-full z-50 mb-2 min-w-[220px] overflow-hidden rounded-xl py-1"
        style={{ [align]: 0, background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-popover)' } as CSSProperties}
      >
        {children}
      </div>
    </>
  )
}

function ToolbarChip({ onClick, tone = 'default', children }: { onClick?: () => void; tone?: 'default' | 'warning'; children: ReactNode }) {
  const warning = tone === 'warning'
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{
        color: warning ? 'var(--color-warning)' : 'var(--color-text-secondary)',
        border: `1px solid ${warning ? 'color-mix(in oklab, var(--color-warning) 40%, transparent)' : 'var(--color-border)'}`,
      }}
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
  const full = current === 'bypassPermissions'
  return (
    <div className="relative">
      <ToolbarChip onClick={() => setOpen((v) => !v)} tone={full ? 'warning' : 'default'}>
        {full ? <IconAlertCircle size={15} /> : <IconShield size={15} />}
        <span>{PERM_LABEL[current]}</span>
        <IconChevronDown size={13} style={{ color: 'var(--color-text-tertiary)' }} />
      </ToolbarChip>
      <Popover open={open} onClose={() => setOpen(false)}>
        {PERM_ORDER.map((m) => {
          const on = m === current
          const warn = m === 'bypassPermissions'
          return (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setOpen(false) }}
              className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
            >
              <span className="mt-0.5" style={{ color: warn ? 'var(--color-warning)' : on ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)' }}>
                {warn ? <IconAlertCircle size={15} /> : <IconShield size={15} />}
              </span>
              <span className="min-w-0">
                <span className="block text-[13px]" style={{ color: 'var(--color-text-primary)', fontWeight: on ? 600 : 400 }}>{PERM_LABEL[m]}</span>
                <span className="block text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{PERM_DESC[m]}</span>
              </span>
            </button>
          )
        })}
      </Popover>
    </div>
  )
}

/** + 添加菜单(照 Codex:文件和文件夹 / 目标 / 计划模式 / 插件)。 */
function AddMenu({ onInsertPaths, onStartGoal }: { onInsertPaths: (paths: string[]) => void; onStartGoal: () => void }) {
  const [open, setOpen] = useState(false)
  // 「文件和文件夹」:原生多选 → 把绝对路径插进输入框(本机 agent 用 read_file/ls 去读)。非桌面壳时提示。
  const pickFilesAndFolders = async () => {
    const host = getDesktopHost()
    if (!host.pickPaths) { toast('在桌面版里可选文件/文件夹;网页预览暂不支持'); return }
    try {
      const paths = await host.pickPaths()
      if (paths && paths.length) { onInsertPaths(paths); toast(`已添加 ${paths.length} 个文件/文件夹`) }
    } catch { toast('选择文件失败') }
  }
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t('chat.attach')}
        aria-label={t('chat.attach')}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--color-surface-hover)]"
        style={{ color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
      >
        <IconPlus size={17} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <MenuList
          onClose={() => setOpen(false)}
          items={[
            { label: '文件和文件夹', icon: <IconFolder size={15} />, onClick: () => void pickFilesAndFolders() },
            { label: '目标', icon: <IconTarget size={15} />, onClick: onStartGoal },
            { label: '计划模式', icon: <IconChecklist size={15} />, onClick: () => { useSettingsStore.getState().setPermissionMode('plan'); toast('已切换到计划模式') } },
            { label: '插件', icon: <IconPuzzle size={15} />, separatorBefore: true, onClick: () => useUiStore.getState().setNav('plugins') },
          ]}
        />
      </Popover>
    </div>
  )
}

/** 斜杠命令 / @ 引用浮层(/ 命令上下键选;@ 列工作区文件点击插入)。 */
function TokenPanel({ token, commands, files, activeIdx, onPick }: { token: '/' | '@'; commands: SlashCommand[]; files: SlashCommand[]; activeIdx: number; onPick: (text: string) => void }) {
  return (
    <div
      className="absolute bottom-full left-0 z-50 mb-2 max-h-[280px] w-[360px] overflow-auto rounded-xl py-1"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-popover)' }}
    >
      {token === '/' ? (
        commands.length === 0 ? (
          <div className="px-3 py-2 text-[13px]" style={{ color: 'var(--color-text-tertiary)' }}>没有匹配的命令</div>
        ) : (
          commands.map((it, i) => (
            <button
              key={it.name}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onPick(it.name + ' ') }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors"
              style={{ background: i === activeIdx ? 'var(--color-surface-selected)' : 'transparent' }}
            >
              <IconSlash size={14} style={{ color: 'var(--color-text-tertiary)' }} />
              <span className="shrink-0 text-[13px]" style={{ color: 'var(--color-text-primary)' }}>{it.name}</span>
              <span className="truncate text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{it.desc}</span>
            </button>
          ))
        )
      ) : files.length === 0 ? (
        <div className="flex items-center gap-2 px-3 py-2">
          <IconAt size={14} style={{ color: 'var(--color-text-tertiary)' }} />
          <span className="text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>没有匹配的文件</span>
        </div>
      ) : (
        files.map((it) => (
          <button
            key={it.name}
            type="button"
            onMouseDown={(e) => { e.preventDefault(); onPick(it.name + ' ') }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            <IconAt size={14} style={{ color: 'var(--color-text-tertiary)' }} />
            <span className="shrink-0 text-[13px]" style={{ color: 'var(--color-text-primary)' }}>{it.desc}</span>
            <span className="truncate text-xs" style={{ color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>{it.name.slice(1)}</span>
          </button>
        ))
      )}
    </div>
  )
}

const FALLBACK_COMMANDS: SlashCommand[] = [
  { name: '/台球', desc: '挂载台球运营专家领域包' },
  { name: '/帮助', desc: '看看能做什么' },
  { name: '/清空', desc: '清空当前对话' },
]

export function Composer() {
  const [value, setValue] = useState('')
  const status = useChatStore((s) => s.status)
  const hasBlocks = useChatStore((s) => s.blocks.length > 0)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const interrupt = useChatStore((s) => s.interrupt)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const running = status === 'running'

  const tree = useFilePreviewStore((s) => s.tree)
  const loadWorkspace = useFilePreviewStore((s) => s.loadWorkspace)
  const draft = useComposerStore((s) => s.draft)
  const clearDraft = useComposerStore((s) => s.clearDraft)

  const [allCommands, setAllCommands] = useState<SlashCommand[]>(FALLBACK_COMMANDS)
  const [slashIdx, setSlashIdx] = useState(0)

  // 拉真实斜杠命令(一次)。失败/空则保留内置兜底。
  useEffect(() => {
    void api
      .get<CommandsResp>('/api/v1/agent/commands')
      .then((res) => {
        const raw = res?.commands ?? []
        const cmds = raw
          .map((c) => ({ name: (c.name ?? '').startsWith('/') ? c.name! : `/${c.name ?? ''}`, desc: c.description ?? c.desc ?? '' }))
          .filter((c) => c.name.length > 1)
        if (cmds.length) setAllCommands(cmds)
      })
      .catch(() => { /* 保留兜底 */ })
  }, [])

  // token 检测:/ 或 @ 起头且未含空格。
  const token: '/' | '@' | null = value.length > 0 && (value[0] === '/' || value[0] === '@') && !value.includes(' ') ? (value[0] as '/' | '@') : null
  const slashQuery = token === '/' ? value.slice(1).toLowerCase() : ''
  const filteredCommands = token === '/' ? allCommands.filter((c) => c.name.toLowerCase().includes(slashQuery)).slice(0, 8) : []
  const slashActive = token === '/' && filteredCommands.length > 0

  // @ 引用:列工作树文件(点击插入 @路径);/ 的键盘逻辑不受影响
  const atQuery = token === '@' ? value.slice(1).toLowerCase() : ''
  const atFiles = useMemo(() => {
    if (token !== '@' || !tree) return [] as SlashCommand[]
    const out: SlashCommand[] = []
    const walk = (nodes: TreeEntry[]) => {
      for (const n of nodes) {
        if (n.type === 'file' && `@${n.path}`.toLowerCase().includes(atQuery)) out.push({ name: `@${n.path}`, desc: n.name })
        if (n.children) walk(n.children)
      }
    }
    walk(tree)
    return out.slice(0, 8)
  }, [token, tree, atQuery])
  useEffect(() => { if (token === '@' && tree === null) loadWorkspace() }, [token, tree, loadWorkspace])

  useEffect(() => { setSlashIdx(0) }, [value])

  function autoGrow() {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }
  useEffect(autoGrow, [value])

  // 用户消息「编辑」→ 回填输入框重编。
  useEffect(() => {
    if (draft !== null) { setValue(draft); clearDraft(); taRef.current?.focus() }
  }, [draft, clearDraft])

  function pickSlash(cmd: SlashCommand) {
    setValue(cmd.name + ' ')
    taRef.current?.focus()
  }

  function submit() {
    const text = value.trim()
    if (!text || running) return
    sendMessage(text)
    setValue('')
    if (taRef.current) taRef.current.style.height = 'auto'
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (slashActive) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => (i + 1) % filteredCommands.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((i) => (i - 1 + filteredCommands.length) % filteredCommands.length); return }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); pickSlash(filteredCommands[slashIdx]!); return }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const canSend = value.trim().length > 0
  const placeholder = hasBlocks ? t('chat.placeholder') : t('chat.placeholderNew')

  return (
    <div className="px-4 pb-2 pt-1">
      <div className="relative mx-auto w-full" style={{ maxWidth: 768 }}>
        {token && <TokenPanel token={token} commands={filteredCommands} files={atFiles} activeIdx={slashIdx} onPick={(txt) => { setValue(txt); taRef.current?.focus() }} />}
        <div
          className="flex flex-col rounded-[22px]"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border-strong)', boxShadow: 'var(--shadow-input)' }}
        >
          <textarea
            ref={taRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={placeholder}
            className="resize-none bg-transparent px-4 pt-3.5 text-sm leading-relaxed outline-none"
            style={{ color: 'var(--color-text-primary)', maxHeight: 200 }}
            data-testid="chat-input"
          />
          {/* 底部工具条 */}
          <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1.5">
            {/* 左:添加菜单 + 权限 */}
            <AddMenu
              onInsertPaths={(paths) => { setValue((v) => appendPathsToInput(v, paths)); taRef.current?.focus() }}
              onStartGoal={() => { setValue((v) => (v.startsWith('/goal') ? v : `/goal ${v}`)); taRef.current?.focus() }}
            />
            <PermissionMenu />
            <div className="flex-1" />
            {/* 右:忙时转圈 · 麦克 · 发送(不显示模型名) */}
            {running && <IconSpinner size={16} style={{ color: 'var(--color-text-tertiary)' }} />}
            <button
              type="button"
              title={t('chat.mic')}
              aria-label={t('chat.mic')}
              onClick={() => toast('语音输入即将上线')}
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
