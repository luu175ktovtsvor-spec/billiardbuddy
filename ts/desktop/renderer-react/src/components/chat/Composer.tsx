// 输入框(核心 · 照 Codex:大圆角 + 底部工具条)。
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
import { extensionApi, type ExtensionInvocationKind, type ExtensionLayer, type ExtensionSource } from '../../api/extensions'
import type { PermissionMode } from '../../types/chat'
import {
  IconPlus, IconShield, IconAlertCircle, IconChevronDown, IconArrowUp, IconSpinner, IconSlash, IconAt,
  IconFolder, IconTarget, IconChecklist, IconPuzzle, IconClock, IconEdit, IconX, IconFileText,
} from '../shared/icons'
import { MenuList } from '../shared/Menu'
import { Modal } from '../shared/Modal'
import { Button } from '../shared/Button'
import { toast } from '../../stores/toastStore'
import { getDesktopHost } from '../../lib/desktopHost'
import { t } from '../../i18n'
import { VoiceInputControl } from './VoiceInputControl'

/** 把选中的文件/文件夹绝对路径追加进输入框(不覆盖用户已输入的文字);含空格的路径加引号,本机 agent 据此去读。 */
function appendPathsToInput(current: string, paths: string[]): string {
  const formatted = paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ')
  if (!current || /\s$/.test(current)) return current + formatted + ' '
  return current + ' ' + formatted + ' '
}

// 普通用户只需要三个执行档。plan/dontAsk 仍是 Agent 内部能力，不能混进日常权限菜单。
const USER_PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions']
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

interface SlashCommand {
  name: string
  desc: string
  /** 能力来源；调用类型由 kind 独立决定。 */
  source?: ExtensionSource
  /** 可调用项类型:Command 是显式入口,Skill 是可复用工作流;Plugin 只表示来源。 */
  kind?: ExtensionInvocationKind
  /** 技能落点层→右侧「系统/个人/项目/插件」灰字。 */
  layer?: ExtensionLayer
}

/** 轻量下拉:相对容器 + 绝对菜单 + 透明遮罩兜底关闭。 */
function Popover({ open, onClose, children, align = 'left' }: { open: boolean; onClose: () => void; children: ReactNode; align?: 'left' | 'right' }) {
  if (!open) return null
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="absolute bottom-full z-50 mb-2 min-w-[220px] overflow-hidden rounded-[10px] py-1"
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
      className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ color: warning ? 'var(--color-warning)' : 'var(--color-text-secondary)' }}
    >
      {children}
    </button>
  )
}

function PermissionMenu() {
  const mode = useSettingsStore((s) => s.defaultPermissionMode)
  const setMode = useSettingsStore((s) => s.setPermissionMode)
  const hiddenModes = useSettingsStore((s) => s.hiddenPermissionModes)
  const [open, setOpen] = useState(false)
  const [confirmFullOpen, setConfirmFullOpen] = useState(false)
  const [fullRiskAccepted, setFullRiskAccepted] = useState(false)
  const current = USER_PERMISSION_MODES.includes(mode) ? mode : 'default'
  const full = current === 'bypassPermissions'
  // 设置页「在权限菜单中显示 XX」关掉的档位不进菜单；默认档始终保留。
  const visibleModes = USER_PERMISSION_MODES.filter((m) => !hiddenModes.includes(m))
  const selectMode = (next: PermissionMode) => {
    setOpen(false)
    if (next === 'bypassPermissions' && current !== 'bypassPermissions') {
      setFullRiskAccepted(false)
      setConfirmFullOpen(true)
      return
    }
    setMode(next)
  }
  return (
    <>
      <div className="relative">
        <div data-testid="permission-menu-trigger">
          <ToolbarChip onClick={() => setOpen((v) => !v)} tone={full ? 'warning' : 'default'}>
            {full ? <IconAlertCircle size={15} /> : <IconShield size={15} />}
            <span>{PERM_LABEL[current]}</span>
            <IconChevronDown size={13} style={{ color: 'var(--color-text-tertiary)' }} />
          </ToolbarChip>
        </div>
        <Popover open={open} onClose={() => setOpen(false)}>
          {visibleModes.map((m) => {
            const on = m === current
            const warn = m === 'bypassPermissions'
            return (
              <button
                key={m}
                type="button"
                onClick={() => selectMode(m)}
                data-testid={`permission-mode-${m}`}
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
      <Modal
        open={confirmFullOpen}
        onClose={() => setConfirmFullOpen(false)}
        title="开启完全访问？"
        maxWidth={460}
        testId="full-access-confirm"
        footer={
          <>
            <Button onClick={() => setConfirmFullOpen(false)}>取消</Button>
            <Button
              variant="primary"
              disabled={!fullRiskAccepted}
              onClick={() => {
                if (!fullRiskAccepted) return
                setMode('bypassPermissions')
                setConfirmFullOpen(false)
              }}
              style={{ background: 'var(--color-error)' }}
            >
              开启完全访问
            </Button>
          </>
        }
      >
        <div className="space-y-4 px-5 py-4">
          <div className="flex gap-3 rounded-lg p-3" style={{ background: 'var(--color-error-subtle, color-mix(in srgb, var(--color-error) 10%, transparent))', color: 'var(--color-text-primary)' }}>
            <span className="mt-0.5 shrink-0" style={{ color: 'var(--color-error)' }}><IconAlertCircle size={18} /></span>
            <p className="text-[13px] leading-5">此会话可以不经逐次确认运行命令、访问网络以及修改或删除工作区外的文件。错误指令可能造成数据丢失或隐私泄露。</p>
          </div>
          <label className="flex cursor-pointer items-start gap-2.5 text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
            <input
              type="checkbox"
              checked={fullRiskAccepted}
              onChange={(event) => setFullRiskAccepted(event.target.checked)}
              className="mt-0.5 h-4 w-4"
            />
            <span>我了解风险，并确认只在可信任务中使用完全访问。</span>
          </label>
        </div>
      </Modal>
    </>
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
      const paths = await host.pickPaths({ defaultPath: useSettingsStore.getState().workspaceRoot ?? undefined })
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
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--color-surface-hover)]"
        style={{ color: 'var(--color-text-secondary)' }}
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

// —— 斜杠浮层分组、作用域和匹配高亮 ——

/** 技能进「技能」组(对标 Codex slashCommands.skillsGroup),命令(pack/builtin)无组排最前。 */
function slashGroup(cmd: SlashCommand): string | null {
  return cmd.kind === 'skill' ? '技能' : null
}

const LAYER_LABEL: Record<NonNullable<SlashCommand['layer']>, string> = { bundled: '系统', user: '个人', workspace: '项目', plugin: '插件' }

/** 右侧灰字作用域(对标 Codex skills.scope.personal/builtIn):技能按落点层标「系统/个人/项目」,领域包命令标「专家」。 */
function slashBadge(cmd: SlashCommand): string | null {
  if (cmd.source === 'pack') return '专家'
  if (cmd.kind === 'skill') return cmd.layer ? LAYER_LABEL[cmd.layer] : null
  if (cmd.source === 'plugin') return '插件'
  return null
}

function SlashIcon({ source, kind }: { source?: SlashCommand['source']; kind?: SlashCommand['kind'] }) {
  const Icon = source === 'pack' ? IconTarget : kind === 'skill' ? IconPuzzle : IconSlash
  return <Icon size={14} className="shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />
}

/** 命令名匹配高亮(对标 Codex:整段命中亮那一段,否则按子序列逐字亮;有命中时未命中字符变灰)。 */
function HighlightedName({ name, query }: { name: string; query: string }) {
  const chars = [...name]
  const q = query.toLowerCase()
  let matches: boolean[] | null = null
  if (q) {
    const idx = name.toLowerCase().indexOf(q)
    if (idx >= 0) matches = chars.map((_, i) => i >= idx && i < idx + q.length)
    else {
      let j = 0
      matches = chars.map((c) => (j < q.length && c.toLowerCase() === q[j] ? (j++, true) : false))
    }
    if (!matches.some(Boolean)) matches = null
  }
  return (
    <>
      {chars.map((c, i) => (
        <span key={i} style={matches && !matches[i] ? { color: 'var(--color-text-tertiary)' } : undefined}>{c}</span>
      ))}
    </>
  )
}

/**
 * 排队消息条(对标 Codex queuedMessage):运行中发的消息排在输入框上方,回合结束自动逐条发出。
 * 每行 = 截断文本 + hover 动作(引导=立即插话不中断 / 编辑=拿回输入框 / 删除);中断/出错 → 暂停条 + 「继续」。
 */
function QueuedMessages() {
  const queued = useChatStore((s) => s.queuedMessages)
  const paused = useChatStore((s) => s.queuePaused)
  const dequeue = useChatStore((s) => s.dequeueMessage)
  const steerNow = useChatStore((s) => s.steerQueuedMessage)
  const resume = useChatStore((s) => s.resumeQueue)
  const setDraft = useComposerStore((s) => s.setDraft)
  if (queued.length === 0) return null
  return (
    <div className="mb-1.5 px-1" data-testid="queued-messages">
      {paused && (
        <div className="flex items-center justify-between gap-2 px-2 py-1 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
          <span>由于你中断了当前响应,队列已暂停</span>
          <button
            type="button"
            onClick={resume}
            className="shrink-0 rounded-md px-2 py-0.5 transition-colors hover:bg-[var(--color-surface-hover)]"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            继续
          </button>
        </div>
      )}
      {queued.map((m) => (
        <div
          key={m.id}
          className="group flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 transition-colors hover:bg-[var(--color-surface-hover)]"
          data-testid="queued-item"
        >
          <IconClock size={12} className="shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />
          <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>{m.text}</span>
          <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
            <button
              type="button"
              title="引导:提交,但不中断模型运行"
              onClick={() => steerNow(m.id)}
              className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-hover)]"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              <IconArrowUp size={13} />
            </button>
            <button
              type="button"
              title="编辑消息"
              onClick={() => { dequeue(m.id); setDraft(m.text) }}
              className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-hover)]"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              <IconEdit size={13} />
            </button>
            <button
              type="button"
              title="删除排队的消息"
              onClick={() => dequeue(m.id)}
              className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-hover)]"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              <IconX size={13} />
            </button>
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * 斜杠命令 / @ 引用浮层(对标 Codex 逆向规格):与输入框同宽、rounded-2xl + p-1 内衬 + 半透明毛玻璃、
 * 上下渐隐遮罩、行 rounded-lg(非选中整行 75% 透明度、选中中性灰底)、技能组 sticky 标题 + 右侧作用域灰字。
 */
function TokenPanel({ token, commands, files, skills = [], activeIdx, query, onPick }: {
  token: '/' | '@'; commands: SlashCommand[]; files: SlashCommand[]; skills?: SlashCommand[]; activeIdx: number; query: string; onPick: (text: string) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  // 键盘上下移动时选中行滚进可视区(对标 Codex scrollIntoView nearest)
  useEffect(() => {
    listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  // 相邻同组聚段(对标 Codex:无组主命令在前、技能聚「技能」组;组标题只在多段时显示)
  const sections: Array<{ label: string | null; items: Array<{ cmd: SlashCommand; idx: number }> }> = []
  commands.forEach((cmd, idx) => {
    const label = slashGroup(cmd)
    const last = sections[sections.length - 1]
    if (last && last.label === label) last.items.push({ cmd, idx })
    else sections.push({ label, items: [{ cmd, idx }] })
  })
  const showHeadings = sections.length > 1

  const fadeMask = 'linear-gradient(to bottom, transparent 0, black 8px, black calc(100% - 8px), transparent 100%)'
  const rowClass = 'flex w-full items-start gap-2 overflow-hidden rounded-[10px] px-2 py-1.5 text-left text-[13px] transition-colors'
  const rowStyle = (active: boolean): CSSProperties => ({
    background: active ? 'var(--color-surface-hover)' : 'transparent',
    color: 'var(--color-text-primary)',
  })

  return (
    <div
      data-testid="token-panel"
      className="absolute inset-x-0 bottom-full z-50 mb-1.5 overflow-hidden rounded-xl p-1"
      style={{
        background: 'color-mix(in srgb, var(--color-surface) 92%, transparent)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        border: '1px solid var(--color-border)',
        boxShadow: 'var(--shadow-popover)',
      }}
    >
      <div
        ref={listRef}
        className="flex max-h-[320px] w-full flex-col overflow-y-auto"
        style={{ maskImage: fadeMask, WebkitMaskImage: fadeMask }}
      >
        {token === '/' ? (
          commands.length === 0 ? (
            <div className="px-2 py-1.5 text-[13px]" style={{ color: 'var(--color-text-tertiary)' }}>没有匹配的命令</div>
          ) : (
            sections.map((sec, si) => (
              <div key={si}>
                {sec.label != null && showHeadings && (
                  <div
                    className="sticky top-0 z-10 px-2 py-1 text-xs"
                    style={{
                      color: 'var(--color-text-tertiary)',
                      background: 'color-mix(in srgb, var(--color-surface) 95%, transparent)',
                      backdropFilter: 'blur(8px)',
                      WebkitBackdropFilter: 'blur(8px)',
                    }}
                  >
                    {sec.label}
                  </div>
                )}
                {sec.items.map(({ cmd, idx }) => {
                  const badge = slashBadge(cmd)
                  const active = idx === activeIdx
                  return (
                    <button
                      key={cmd.name}
                      type="button"
                      data-testid="slash-item"
                      data-active={active || undefined}
                      onMouseDown={(e) => { e.preventDefault(); onPick(cmd.name + ' ') }}
                      className={rowClass}
                      style={rowStyle(active)}
                    >
                      <span className="mt-0.5"><SlashIcon source={cmd.source} kind={cmd.kind} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate"><HighlightedName name={cmd.name} query={query} /></span>
                        {cmd.desc && <span className="block truncate text-xs leading-4" style={{ color: 'var(--color-text-tertiary)' }}>{cmd.desc}</span>}
                      </span>
                      {badge && <span className="ml-auto shrink-0 pt-0.5 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{badge}</span>}
                    </button>
                  )
                })}
              </div>
            ))
          )
        ) : skills.length === 0 && files.length === 0 ? (
          <div className="flex items-center gap-2 px-2 py-1.5">
            <IconAt size={14} className="shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />
            <span className="text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>没有匹配的技能或文件</span>
          </div>
        ) : (
          <>
            {/* 技能段(对齐 Codex atMentionList 混排:技能在前,选中插入 /技能名) */}
            {skills.length > 0 && (
              <div
                className="sticky top-0 z-10 px-2 py-1 text-xs"
                style={{ color: 'var(--color-text-tertiary)', background: 'color-mix(in srgb, var(--color-surface) 95%, transparent)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
              >
                技能
              </div>
            )}
            {skills.map((it) => (
              <button
                key={it.name}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); onPick(it.name + ' ') }}
                className={`${rowClass} hover:bg-[var(--color-surface-hover)]`}
                style={rowStyle(false)}
              >
                <IconPuzzle size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{it.name}</span>
                  {it.desc && <span className="block truncate text-xs leading-4" style={{ color: 'var(--color-text-tertiary)' }}>{it.desc}</span>}
                </span>
              </button>
            ))}
            {files.length > 0 && (
              <div
                className="sticky top-0 z-10 px-2 py-1 text-xs"
                style={{ color: 'var(--color-text-tertiary)', background: 'color-mix(in srgb, var(--color-surface) 95%, transparent)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
              >
                文件
              </div>
            )}
            {files.map((it) => (
              <button
                key={it.name}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); onPick(it.name + ' ') }}
                className={`${rowClass} hover:bg-[var(--color-surface-hover)]`}
                style={rowStyle(false)}
              >
                <IconAt size={14} className="shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />
                <span className="shrink-0">{it.desc}</span>
                <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>{it.name.slice(1)}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

const FALLBACK_COMMANDS: SlashCommand[] = [
  { name: '/台球', desc: '在这个窗口挂载台球运营知识库(只影响当前窗口)', source: 'pack', kind: 'command' },
  { name: '/台球关闭', desc: '在这个窗口关闭台球运营知识库', source: 'pack', kind: 'command' },
  { name: '/帮助', desc: '看看能做什么', source: 'builtin', kind: 'command' },
  { name: '/清空', desc: '清空当前对话', source: 'builtin', kind: 'command' },
]

/** 注册序(对标 Codex sortBy(group, title) + 产品语义):无组命令在前(领域包 > 内置),「技能」组殿后,组内按名。 */
const SOURCE_ORDER: Record<NonNullable<SlashCommand['source']>, number> = { pack: 0, builtin: 1, plugin: 2, skill: 3 }
function sortSlashCommands(cmds: SlashCommand[]): SlashCommand[] {
  return [...cmds].sort((a, b) =>
    (slashGroup(a) ?? '').localeCompare(slashGroup(b) ?? '')
    || (SOURCE_ORDER[a.source ?? 'builtin'] - SOURCE_ORDER[b.source ?? 'builtin'])
    || a.name.localeCompare(b.name))
}

/** 命令打分(对标 Codex 模糊匹配:前缀 3 > 包含 2 > 子序列 1 > 不匹配 0),忽略大小写、名字去斜杠参与。 */
function scoreSlashCommand(cmd: SlashCommand, query: string): number {
  const name = cmd.name.slice(1).toLowerCase()
  const q = query.toLowerCase()
  if (!q) return 1
  if (name.startsWith(q)) return 3
  if (name.includes(q)) return 2
  let j = 0
  for (const ch of name) { if (j < q.length && ch === q[j]) j++ }
  return j >= q.length ? 1 : 0
}

// 粘贴长文变附件卡的阈值(对齐 Codex pastedTextAttachment 行为;阈值为我们自定的产品参数):
// 超过它的粘贴不灌进输入框,变成输入框上方的「粘贴的文本」卡,发送时再拼进消息。
const PASTE_ATTACH_THRESHOLD = 2000

interface PastedAttachment { id: string; text: string }

export function Composer() {
  const [value, setValue] = useState('')
  const [pasted, setPasted] = useState<PastedAttachment[]>([])
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
  // Esc 关闭浮层(保留已输入文本);输入变化时自动复位再弹(对标 Codex)。
  const [slashDismissed, setSlashDismissed] = useState(false)
  const workspaceRoot = useSettingsStore((s) => s.workspaceRoot)
  const enabledPacks = useSettingsStore((s) => s.enabledPacks)
  const enabledPacksKey = enabledPacks.join(',')

  // 拉真实斜杠命令(带会话上下文:工作目录 + 已挂领域包,变化即重拉——漏带会看不到包命令/工作区技能)。失败/空则保留内置兜底。
  useEffect(() => {
    let stale = false
    void extensionApi
      .commands({ workspaceRoot, enabledPacks })
      .then((raw) => {
        if (stale) return
        const cmds = raw
          .map((c) => ({
            name: c.name.startsWith('/') ? c.name : `/${c.name}`,
            desc: c.description,
            source: c.source,
            kind: c.kind,
            layer: c.layer,
          }))
          .filter((c) => c.name.length > 1)
        if (cmds.length) setAllCommands(sortSlashCommands(cmds))
      })
      .catch(() => { /* 保留兜底 */ })
    return () => { stale = true }
  }, [workspaceRoot, enabledPacksKey])

  // token 检测:/ 起头且后续无空白无第二个斜杠(路径如 /usr/bin 不误触发,对标 Codex);@ 起头且未含空格。
  const token: '/' | '@' | null =
    value.startsWith('/') && !/[\s/]/.test(value.slice(1)) ? '/'
    : value.startsWith('@') && !value.includes(' ') ? '@'
    : null
  const slashQuery = token === '/' ? value.slice(1) : ''
  // 过滤 + 排序(对标 Codex:打分剔除 0 分,按 [组序 → 分数 → 名字] 排,组不打散;不截断条数,靠浮层滚动)
  const filteredCommands = useMemo(() => {
    if (token !== '/') return []
    if (!slashQuery) return allCommands
    const groupRank = new Map<string, number>()
    allCommands.forEach((c) => { const g = slashGroup(c) ?? ''; if (!groupRank.has(g)) groupRank.set(g, groupRank.size) })
    return allCommands
      .map((c) => ({ c, score: scoreSlashCommand(c, slashQuery) }))
      .filter((x) => x.score > 0)
      .sort((a, b) =>
        (groupRank.get(slashGroup(a.c) ?? '') ?? 0) - (groupRank.get(slashGroup(b.c) ?? '') ?? 0)
        || b.score - a.score
        || a.c.name.localeCompare(b.c.name))
      .map((x) => x.c)
  }, [token, allCommands, slashQuery])
  const slashActive = token === '/' && !slashDismissed && filteredCommands.length > 0

  // @ 引用:技能 + 工作树文件混排(对齐 Codex atMentionList 的「技能」段;选技能插入 /技能名——
  // 后端「斜杠命令=技能」语义现成,模型见 /名字 即知道要调它);/ 的键盘逻辑不受影响。
  const atQuery = token === '@' ? value.slice(1).toLowerCase() : ''
  const atSkills = useMemo(() => {
    if (token !== '@') return [] as SlashCommand[]
    return allCommands
      .filter((c) => c.kind === 'skill' && c.name.slice(1).toLowerCase().includes(atQuery))
      .slice(0, 5)
  }, [token, allCommands, atQuery])
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

  useEffect(() => { setSlashIdx(0); setSlashDismissed(false) }, [value])

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

  /** 粘贴拦截(对齐 Codex pastedTextAttachment):大段文本不灌输入框,变附件卡,发送时拼进消息。 */
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const text = e.clipboardData?.getData('text/plain') ?? ''
    if (text.length <= PASTE_ATTACH_THRESHOLD) return
    e.preventDefault()
    setPasted((prev) => [...prev, { id: `paste-${Date.now()}-${prev.length}`, text }])
  }

  function submit() {
    const text = value.trim()
    if (!text && pasted.length === 0) return
    if ((text === '/生成图片' || text === '/生图工作台') && pasted.length === 0) {
      useUiStore.getState().setNav('creation')
      setValue('')
      setPasted([])
      if (taRef.current) taRef.current.style.height = 'auto'
      return
    }
    // 附件文本拼在正文后(围栏标记,模型读得懂、正文不被冲散);全空正文时给一句默认引导。
    const attachTail = pasted.map((p, i) => `\n\n[粘贴的文本${pasted.length > 1 ? ` ${i + 1}` : ''}]\n"""\n${p.text}\n"""`).join('')
    const imageSlash = text.match(/^\/生图\s+(.+)$/s)
    const baseText = imageSlash
      ? `请理解下面的用户原始生图需求并调用 generate_image，完成后把产物送入生图工作台。调用工具时忠实保留原始画面意图，不要引入用户未提供的领域知识、运营方案或营销内容；后端会统一编译 CreativeBrief、路由模型并优化 Prompt。用户原始生图需求:${imageSlash[1]?.trim() ?? ''}`
      : text
    const finalText = (baseText || (pasted.length ? '请看下面粘贴的内容:' : '')) + attachTail
    if (!finalText.trim()) return
    // 运行中也放行:sendMessage 内部会把消息排队(对标 Codex queuedMessage),不再吞掉回车。
    sendMessage(finalText)
    setValue('')
    setPasted([])
    if (taRef.current) taRef.current.style.height = 'auto'
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Esc 只收浮层、不动已输入文本(对标 Codex);空结果的「没有匹配的命令」浮层也能收。
    if (token === '/' && !slashDismissed && e.key === 'Escape') { e.preventDefault(); setSlashDismissed(true); return }
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

  const canSend = value.trim().length > 0 || pasted.length > 0
  const placeholder = hasBlocks ? t('chat.placeholder') : t('chat.placeholderNew')

  return (
    <div className="px-4 pb-2 pt-1">
      <div className="relative mx-auto w-full" style={{ maxWidth: 768 }}>
        {token && !(token === '/' && slashDismissed) && (
          <TokenPanel token={token} commands={filteredCommands} files={atFiles} skills={atSkills} activeIdx={slashIdx} query={slashQuery} onPick={(txt) => { setValue(txt); taRef.current?.focus() }} />
        )}
        <QueuedMessages />
        {/* 粘贴的文本附件卡(对齐 Codex:标题 + 字数 + 在文本框中显示 / 移除) */}
        {pasted.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5 px-1" data-testid="pasted-attachments">
            {pasted.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px]"
                style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
              >
                <IconFileText size={13} style={{ color: 'var(--color-text-tertiary)' }} />
                <span>粘贴的文本</span>
                <span style={{ color: 'var(--color-text-tertiary)' }}>{p.text.length} 字</span>
                <button
                  type="button"
                  title="在文本框中显示"
                  onClick={() => { setPasted((prev) => prev.filter((x) => x.id !== p.id)); setValue((v) => (v ? `${v}\n${p.text}` : p.text)); taRef.current?.focus() }}
                  className="rounded p-0.5 transition-colors hover:bg-[var(--color-surface-hover)]"
                  style={{ color: 'var(--color-text-tertiary)' }}
                >
                  <IconEdit size={12} />
                </button>
                <button
                  type="button"
                  title="移除粘贴的文本附件"
                  onClick={() => setPasted((prev) => prev.filter((x) => x.id !== p.id))}
                  className="rounded p-0.5 transition-colors hover:bg-[var(--color-surface-hover)]"
                  style={{ color: 'var(--color-text-tertiary)' }}
                >
                  <IconX size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          className="composer-surface-chrome flex flex-col overflow-hidden rounded-[20px] backdrop-blur-lg"
          style={{ background: 'color-mix(in srgb, var(--color-surface) 90%, transparent)', boxShadow: 'var(--shadow-input)' }}
        >
          <textarea
            ref={taRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            placeholder={placeholder}
            className="mb-1 resize-none bg-transparent px-3 pt-3 text-sm leading-relaxed outline-none"
            style={{ color: 'var(--color-text-primary)', maxHeight: 200 }}
            data-testid="chat-input"
          />
          <div className="mb-2 grid grid-cols-[minmax(0,auto)_auto_minmax(0,1fr)] items-center gap-x-[5px] px-2 select-none">
            <AddMenu
              onInsertPaths={(paths) => { setValue((v) => appendPathsToInput(v, paths)); taRef.current?.focus() }}
              onStartGoal={() => { setValue((v) => (v.startsWith('/goal') ? v : `/goal ${v}`)); taRef.current?.focus() }}
            />
            <PermissionMenu />
            <div className="flex min-w-0 items-center justify-end gap-1">
              {running && <IconSpinner size={16} style={{ color: 'var(--color-text-tertiary)' }} />}
              <VoiceInputControl onTranscript={(text) => { setValue((current) => current.trim() ? `${current.trimEnd()} ${text}` : text); taRef.current?.focus() }} />
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
    </div>
  )
}
