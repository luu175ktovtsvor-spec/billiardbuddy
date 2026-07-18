import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Clock, FileText, Folder, Globe2, Sparkles, Target } from 'lucide-react'
import {
  SCHEDULED_TAB_ID,
  SETTINGS_TAB_ID,
  TERMINAL_TAB_PREFIX,
  TRACE_TAB_PREFIX,
  WORKBENCH_TAB_PREFIX,
  useTabStore,
  type TabType,
} from '../stores/tabStore'
import { useSessionStore } from '../stores/sessionStore'
import { useChatStore } from '../stores/chatStore'
import { useCLITaskStore } from '../stores/cliTaskStore'
import { useTeamStore } from '../stores/teamStore'
import { useWorkspacePanelStore } from '../stores/workspacePanelStore'
import {
  TERMINAL_PANEL_DEFAULT_HEIGHT,
  TERMINAL_PANEL_MAX_HEIGHT,
  TERMINAL_PANEL_MIN_HEIGHT,
  useTerminalPanelStore,
} from '../stores/terminalPanelStore'
import { useTranslation } from '../i18n'
import { MessageList } from '../components/chat/MessageList'
import { ChatInput } from '../components/chat/ChatInput'
import { ComputerUsePermissionModal } from '../components/chat/ComputerUsePermissionModal'
import { SessionTaskBar } from '../components/chat/SessionTaskBar'
import { BackgroundTasksBar } from '../components/chat/BackgroundTasksBar'
import { WorkbenchPanel } from '../components/workbench/WorkbenchPanel'
import { TeamStatusBar } from '../components/teams/TeamStatusBar'
import { TerminalSettings } from './TerminalSettings'
import type { SessionListItem } from '../types/session'
import type { ActiveGoalState } from '../types/chat'
import { useMobileViewport } from '../hooks/useMobileViewport'
import { isDesktopRuntime } from '../lib/desktopRuntime'
import { Smiley } from '../components/shared/Smiley'
import { useSettingsStore } from '../stores/settingsStore'
import {
  createBackgroundTaskDismissKey,
  hasRunningBackgroundTasks as hasAnyRunningBackgroundTasks,
} from '../lib/backgroundTasks'

const TASK_POLL_INTERVAL_MS = 1000
const WORKSPACE_RESIZE_STEP = 32
const TERMINAL_RESIZE_STEP = 24
const CHAT_COLUMN_WITH_WORKSPACE_CLASS =
  'min-w-[320px] flex-1 border-r border-[var(--color-border)] bg-[var(--color-surface)]'
const EMPTY_DISMISSED_BACKGROUND_TASK_KEYS = new Set<string>()

const MAIN_EMPTY_SUGGESTIONS = {
  zh: [
    { icon: Folder, label: '整理一个文件夹', prompt: '帮我整理一个文件夹。先问我要整理哪个文件夹，看完里面有什么后给我归类方案，我确认了再动手。' },
    { icon: FileText, label: '写一份文档', prompt: '帮我写一份文档。先问清楚主题、给谁看和大概多长，然后列个提纲给我确认。' },
    { icon: Globe2, label: '上网查个东西', prompt: '帮我上网查一个问题，把结论用大白话讲给我，并附上来源链接。先问我要查什么。' },
    { icon: Clock, label: '安排定时任务', prompt: '帮我安排一个定时自动执行的任务。先问我要做什么、多久一次和什么时间执行。' },
    { icon: Sparkles, label: '做一张图', prompt: '帮我生成一张图片。先问我想要的内容、风格和用途。' },
  ],
  en: [
    { icon: Folder, label: 'Organize a folder', prompt: 'Help me organize a folder. Ask which folder, review it, and propose a plan before changing anything.' },
    { icon: FileText, label: 'Write a document', prompt: 'Help me write a document. Ask about the topic, audience, and length, then propose an outline first.' },
    { icon: Globe2, label: 'Research something', prompt: 'Research a question for me, explain the conclusion plainly, and include source links. Ask what I need researched.' },
    { icon: Clock, label: 'Schedule a task', prompt: 'Help me schedule an automatic task. Ask what it should do, how often, and when it should run.' },
    { icon: Sparkles, label: 'Create an image', prompt: 'Help me create an image. Ask about the content, style, and intended use first.' },
  ],
} as const

function isSessionTabState(activeTabId: string | null, activeTabType: TabType | null | undefined) {
  if (!activeTabId) return false
  if (activeTabType === 'session') return true
  if (activeTabType) return false
  return activeTabId !== SETTINGS_TAB_ID &&
    activeTabId !== SCHEDULED_TAB_ID &&
    !activeTabId.startsWith(TERMINAL_TAB_PREFIX) &&
    !activeTabId.startsWith(TRACE_TAB_PREFIX) &&
    !activeTabId.startsWith(WORKBENCH_TAB_PREFIX)
}

function getSessionTerminalCwd(session: SessionListItem | undefined) {
  if (!session) return undefined
  if (session.workDir && session.workDirExists !== false) return session.workDir
  return session.projectPath || undefined
}

function ActiveGoalStrip({
  goal,
  isRunning,
  compact,
}: {
  goal: ActiveGoalState | null | undefined
  isRunning: boolean
  compact: boolean
}) {
  const t = useTranslation()
  if (!goal || goal.action === 'completed') return null

  const objective = goal.objective ?? goal.message
  if (!objective) return null

  const statusLabel = isRunning
    ? t('chat.activeGoal.running')
    : goal.status === 'paused'
      ? t('chat.activeGoal.paused')
      : t('chat.activeGoal.active')
  const meta = [
    goal.budget ? t('chat.activeGoal.budget', { value: goal.budget }) : null,
    goal.elapsed ? t('chat.activeGoal.elapsed', { value: goal.elapsed }) : null,
    goal.continuations ? t('chat.activeGoal.continuations', { value: goal.continuations }) : null,
  ].filter((value): value is string => value !== null)

  return (
    <div
      data-testid="active-goal-strip"
      className={[
        'mt-2 flex max-w-full items-center gap-2 rounded-[8px] border border-[var(--color-memory-border)] bg-[var(--color-memory-surface)] px-2.5 py-1.5',
        compact ? 'text-[11px]' : 'text-[12px]',
      ].join(' ')}
    >
      <Target size={compact ? 13 : 14} className="shrink-0 text-[var(--color-memory-accent)]" strokeWidth={2.25} aria-hidden="true" />
      <span className="shrink-0 font-semibold text-[var(--color-text-primary)]">
        {t('chat.activeGoal.title')}
      </span>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-memory-accent)]" aria-hidden="true" />
      <span className="shrink-0 text-[var(--color-text-tertiary)]">{statusLabel}</span>
      <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text-primary)]" title={objective}>
        {objective}
      </span>
      {meta.length > 0 ? (
        <span className="hidden shrink-0 items-center gap-1.5 text-[11px] text-[var(--color-text-tertiary)] lg:flex">
          {meta.map((item) => (
            <span key={item} className="max-w-[140px] truncate">{item}</span>
          ))}
        </span>
      ) : null}
    </div>
  )
}

function getRenderedWorkspacePanelWidth(panelRef: RefObject<HTMLElement>, fallbackWidth: number) {
  const renderedWidth = panelRef.current?.getBoundingClientRect().width ?? 0
  return Number.isFinite(renderedWidth) && renderedWidth > 0
    ? renderedWidth
    : fallbackWidth
}

function WorkspaceResizeHandle({ panelRef }: { panelRef: RefObject<HTMLElement> }) {
  const t = useTranslation()
  const width = useWorkspacePanelStore((state) => state.width)
  const setWidth = useWorkspacePanelStore((state) => state.setWidth)
  const [dragState, setDragState] = useState<{ startX: number; startWidth: number } | null>(null)
  const dragStateRef = useRef(dragState)

  useEffect(() => {
    dragStateRef.current = dragState
  }, [dragState])

  useEffect(() => {
    if (!dragState) return

    const handlePointerMove = (event: PointerEvent) => {
      const current = dragStateRef.current
      if (!current) return
      setWidth(current.startWidth + current.startX - event.clientX)
    }

    const handlePointerUp = () => {
      setDragState(null)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)

    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [dragState, setWidth])

  return (
    <div
      role="separator"
      aria-label={t('workspace.resizePanel')}
      aria-orientation="vertical"
      aria-valuenow={width}
      tabIndex={0}
      data-testid="workspace-resize-handle"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        setDragState({ startX: event.clientX, startWidth: getRenderedWorkspacePanelWidth(panelRef, width) })
      }}
      onKeyDown={(event) => {
        const renderedWidth = getRenderedWorkspacePanelWidth(panelRef, width)
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          setWidth(renderedWidth + WORKSPACE_RESIZE_STEP)
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          setWidth(renderedWidth - WORKSPACE_RESIZE_STEP)
        }
      }}
      className="group relative z-10 flex w-2 shrink-0 cursor-col-resize items-stretch justify-center bg-[var(--color-surface)] outline-none focus-visible:bg-[var(--color-surface-container)]"
    >
      <div className="my-3 w-px rounded-full bg-[var(--color-border)] transition-colors group-hover:bg-[var(--color-border-focus)] group-focus-visible:bg-[var(--color-border-focus)]" />
    </div>
  )
}

function TerminalResizeHandle() {
  const t = useTranslation()
  const height = useTerminalPanelStore((state) => state.height)
  const setHeight = useTerminalPanelStore((state) => state.setHeight)
  const [dragState, setDragState] = useState<{ startY: number; startHeight: number } | null>(null)
  const dragStateRef = useRef(dragState)

  useEffect(() => {
    dragStateRef.current = dragState
  }, [dragState])

  useEffect(() => {
    if (!dragState) return

    const handlePointerMove = (event: PointerEvent) => {
      const current = dragStateRef.current
      if (!current) return
      setHeight(current.startHeight + current.startY - event.clientY)
    }

    const handlePointerUp = () => {
      setDragState(null)
    }

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)

    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [dragState, setHeight])

  return (
    <div
      role="separator"
      aria-label={t('terminal.resizePanel')}
      aria-orientation="horizontal"
      aria-valuemin={TERMINAL_PANEL_MIN_HEIGHT}
      aria-valuemax={TERMINAL_PANEL_MAX_HEIGHT}
      aria-valuenow={height}
      tabIndex={0}
      data-testid="terminal-resize-handle"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        setDragState({ startY: event.clientY, startHeight: height })
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setHeight(height + TERMINAL_RESIZE_STEP)
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setHeight(height - TERMINAL_RESIZE_STEP)
        }
        if (event.key === 'Home') {
          event.preventDefault()
          setHeight(TERMINAL_PANEL_MIN_HEIGHT)
        }
        if (event.key === 'End') {
          event.preventDefault()
          setHeight(TERMINAL_PANEL_MAX_HEIGHT)
        }
      }}
      onDoubleClick={() => setHeight(TERMINAL_PANEL_DEFAULT_HEIGHT)}
      className="group flex h-2.5 shrink-0 cursor-row-resize items-center bg-[var(--color-surface)] outline-none focus-visible:bg-[var(--color-surface-container)]"
    >
      <div className="mx-3 h-px flex-1 rounded-full bg-[var(--color-border)] transition-colors group-hover:bg-[var(--color-border-focus)] group-focus-visible:bg-[var(--color-border-focus)]" />
    </div>
  )
}

export function ActiveSession() {
  const isMobileLayout = useMobileViewport() && !isDesktopRuntime()
  const locale = useSettingsStore((state) => state.locale)
  const workbenchPanelRef = useRef<HTMLElement>(null)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const [dismissedBackgroundTaskKeysBySession, setDismissedBackgroundTaskKeysBySession] = useState<Record<string, Set<string>>>({})
  const activeTabType = useTabStore((s) => s.tabs.find((tab) => tab.sessionId === s.activeTabId)?.type ?? null)
  const sessions = useSessionStore((s) => s.sessions)
  const connectToSession = useChatStore((s) => s.connectToSession)
  const sessionState = useChatStore((s) => activeTabId ? s.sessions[activeTabId] : undefined)
  const pendingComputerUsePermission = sessionState?.pendingComputerUsePermission ?? null
  const fetchSessionTasks = useCLITaskStore((s) => s.fetchSessionTasks)
  const trackedTaskSessionId = useCLITaskStore((s) => s.sessionId)
  const hasIncompleteTasks = useCLITaskStore((s) => s.tasks.some((task) => task.status !== 'completed'))
  const hasRunningTasks = useCLITaskStore((s) => s.tasks.some((task) => task.status === 'in_progress'))
  const chatState = sessionState?.chatState ?? 'idle'
  const hasRunningBackgroundTasks = hasAnyRunningBackgroundTasks(sessionState?.backgroundAgentTasks)

  const session = sessions.find((s) => s.id === activeTabId)
  const memberInfo = useTeamStore((s) => activeTabId ? s.getMemberBySessionId(activeTabId) : null)
  const activeTeam = useTeamStore((s) => s.activeTeam)
  const isMemberSession = !!memberInfo
  const showWorkbench = useWorkspacePanelStore((state) =>
    activeTabId && isSessionTabState(activeTabId, activeTabType) && !isMemberSession && !isMobileLayout
      ? state.isPanelOpen(activeTabId)
      : false,
  )
  const showRightPanel = showWorkbench
  const rightPanelWidth = useWorkspacePanelStore((state) => state.width)
  const showTerminalPanel = useTerminalPanelStore((state) =>
    activeTabId && isSessionTabState(activeTabId, activeTabType) && !isMemberSession && !isMobileLayout
      ? state.isPanelOpen(activeTabId)
      : false,
  )
  const terminalPanelRuntimeId = useTerminalPanelStore((state) =>
    activeTabId && isSessionTabState(activeTabId, activeTabType) && !isMemberSession && !isMobileLayout
      ? state.panelBySession[activeTabId]?.runtimeId
      : undefined,
  )
  const terminalPanelHeight = useTerminalPanelStore((state) => state.height)

  useEffect(() => {
    if (activeTabId && !isMemberSession) {
      connectToSession(activeTabId)
    }
  }, [activeTabId, isMemberSession, connectToSession])

  useEffect(() => {
    if (!activeTabId || isMemberSession) return

    const shouldPollTasks =
      chatState !== 'idle' ||
      (trackedTaskSessionId === activeTabId && hasIncompleteTasks)

    if (!shouldPollTasks) return

    void fetchSessionTasks(activeTabId)

    const timer = setInterval(() => {
      void fetchSessionTasks(activeTabId)
    }, TASK_POLL_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [
    activeTabId,
    isMemberSession,
    chatState,
    trackedTaskSessionId,
    hasIncompleteTasks,
    fetchSessionTasks,
  ])

  const t = useTranslation()
  const messages = sessionState?.messages ?? []
  const streamingText = sessionState?.streamingText ?? ''
  const backgroundTasks = useMemo(
    () => Object.values(sessionState?.backgroundAgentTasks ?? {}),
    [sessionState?.backgroundAgentTasks],
  )
  const dismissedBackgroundTaskKeys = activeTabId
    ? dismissedBackgroundTaskKeysBySession[activeTabId] ?? EMPTY_DISMISSED_BACKGROUND_TASK_KEYS
    : EMPTY_DISMISSED_BACKGROUND_TASK_KEYS
  const activeGoal = sessionState?.activeGoal ?? null
  const isEmpty = messages.length === 0 && !streamingText && (session?.messageCount ?? 0) === 0
  const compactEmptyHero = isEmpty && showTerminalPanel
  const isHistoryLoading =
    !isMemberSession &&
    (session?.messageCount ?? 0) > 0 &&
    messages.length === 0 &&
    sessionState?.historyStatus === 'loading'
  const historyError =
    !isMemberSession &&
    (session?.messageCount ?? 0) > 0 &&
    messages.length === 0 &&
    sessionState?.historyStatus === 'error'
      ? sessionState.historyError || t('session.historyLoadFailed')
      : null
  const isActive = chatState !== 'idle' ||
    (trackedTaskSessionId === activeTabId && hasRunningTasks) ||
    hasRunningBackgroundTasks
  const showSessionStatus = isActive || session?.workDirExists === false || Boolean(activeGoal)

  useEffect(() => {
    if (!activeTabId || dismissedBackgroundTaskKeys.size === 0) return
    const currentTaskKeys = new Set(backgroundTasks.map(createBackgroundTaskDismissKey))
    const nextDismissed = new Set([...dismissedBackgroundTaskKeys].filter((taskKey) => currentTaskKeys.has(taskKey)))
    if (nextDismissed.size === dismissedBackgroundTaskKeys.size) return

    setDismissedBackgroundTaskKeysBySession((current) => {
      const next = { ...current }
      if (nextDismissed.size === 0) {
        delete next[activeTabId]
      } else {
        next[activeTabId] = nextDismissed
      }
      return next
    })
  }, [activeTabId, backgroundTasks, dismissedBackgroundTaskKeys])

  if (!activeTabId) return null

  return (
    <div className="flex-1 flex flex-col relative overflow-hidden bg-background text-on-surface">
      <div data-testid="active-session-content-row" className="flex min-h-0 min-w-0 flex-1">
        <div
          data-testid="active-session-chat-column"
          className={`flex min-h-0 flex-col ${showRightPanel ? CHAT_COLUMN_WITH_WORKSPACE_CLASS : isMobileLayout ? 'min-w-0 flex-1' : 'min-w-[360px] flex-1'}`}
        >
          {isMemberSession && (
            <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface-container)]">
              <div className="mx-auto max-w-[860px] flex items-center justify-between gap-4 px-8 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    {memberInfo?.status === 'running' && (
                      <span className="flex h-2 w-2 rounded-full bg-[var(--color-warning)] animate-pulse-dot" />
                    )}
                    {memberInfo?.status === 'completed' && (
                      <span className="material-symbols-outlined text-[14px] text-[var(--color-success)]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                    )}
                    <span className="material-symbols-outlined text-[14px] text-[var(--color-text-tertiary)]">smart_toy</span>
                    <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                      {memberInfo?.role}
                    </span>
                    {activeTeam && (
                      <span className="text-[10px] text-[var(--color-text-tertiary)]">
                        @ {activeTeam.name}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">
                    {t('teams.memberSessionHint')}
                  </p>
                </div>
                <button
                  onClick={() => {
                    if (activeTeam?.leadSessionId) {
                      useTabStore.getState().openTab(
                        activeTeam.leadSessionId,
                        t('teams.leader'),
                        'session',
                      )
                    }
                  }}
                  disabled={!activeTeam?.leadSessionId}
                  className="flex shrink-0 items-center gap-1 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-50 disabled:hover:text-[var(--color-text-secondary)]"
                >
                  <span className="material-symbols-outlined text-[14px]">arrow_back</span>
                  {t('teams.backToLeader')}
                </button>
              </div>
            </div>
          )}

          {isEmpty ? (
            <div
              data-testid="empty-session-hero"
              className={[
                'flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-8 pt-8',
                compactEmptyHero ? 'pb-6' : 'pb-32',
              ].join(' ')}
            >
              <div className={`flex w-full flex-col items-center text-center ${isMemberSession ? 'max-w-md' : 'max-w-3xl'}`}>
                {isMemberSession ? (
                  <>
                    <span className={`material-symbols-outlined mb-4 text-[var(--color-text-tertiary)] ${compactEmptyHero ? 'text-[36px]' : 'text-[48px]'}`}>smart_toy</span>
                    <p className="text-[var(--color-text-secondary)]">
                      {memberInfo?.status === 'running'
                        ? `${memberInfo.role} ${t('teams.working')}`
                        : t('teams.noMessages')}
                    </p>
                  </>
                ) : (
                  <>
                    <Smiley size={compactEmptyHero ? 32 : 40} className="mb-1" />
                    <h1 className={`${compactEmptyHero ? 'text-[22px]' : 'text-[28px]'} font-normal text-[var(--color-text-primary)]`}>
                      {t('empty.title')}
                    </h1>
                    {!compactEmptyHero && (
                      <div className="mt-6 flex w-full max-w-[560px] flex-col py-2 pl-6 text-left" data-testid="empty-suggestion-list">
                        {(locale === 'zh' ? MAIN_EMPTY_SUGGESTIONS.zh : MAIN_EMPTY_SUGGESTIONS.en).map((suggestion) => {
                          const SuggestionIcon = suggestion.icon
                          return (
                            <button
                              key={suggestion.label}
                              type="button"
                              onClick={() => useChatStore.getState().setComposerDraft(activeTabId, { input: suggestion.prompt, attachments: [] })}
                              className="flex min-h-10 w-full items-center rounded-lg pr-1 text-left text-[14px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] active:scale-[0.99]"
                            >
                              <span className="mr-2 flex size-4 shrink-0 items-center justify-center text-[var(--color-text-tertiary)]">
                                <SuggestionIcon size={14} />
                              </span>
                              <span className="min-w-0 flex-1 truncate">{suggestion.label}</span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ) : (
            <>
              {!isMemberSession && !isMobileLayout && showSessionStatus && (
                <div
                  className={
                    showRightPanel
                      ? 'flex w-full items-center border-b border-[var(--color-border)]/70 px-4 py-3'
                      : 'w-full border-b border-outline-variant/10 px-4 py-3'
                  }
                >
                  <div className={showRightPanel ? 'min-w-0 flex-1' : 'mx-auto w-full max-w-[768px] min-w-0'}>
                    <div
                      className={
                        showRightPanel
                          ? 'mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[10px] font-medium text-outline'
                          : 'flex items-center gap-2 text-[10px] text-outline font-medium mt-1'
                      }
                    >
                      {isActive && (
                        <span className="flex shrink-0 items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] animate-pulse-dot" />
                          {t('session.active')}
                        </span>
                      )}
                    </div>
                    {session?.workDirExists === false && (
                      <div className="mt-2 inline-flex max-w-full items-center gap-2 rounded-lg border border-[var(--color-error)]/20 bg-[var(--color-error)]/8 px-3 py-1.5 text-[11px] text-[var(--color-error)]">
                        <span className="material-symbols-outlined text-[14px]">warning</span>
                        <span className="truncate">
                          {t('session.workspaceUnavailable', { dir: session.workDir || 'directory no longer exists' })}
                        </span>
                      </div>
                    )}
                    <ActiveGoalStrip
                      goal={activeGoal}
                      isRunning={isActive}
                      compact={showRightPanel}
                    />
                  </div>
                </div>
              )}

              {isHistoryLoading ? (
                <div role="status" className="flex flex-1 items-center justify-center p-8 text-sm text-[var(--color-text-secondary)]">
                  <span className="material-symbols-outlined mr-2 animate-spin text-[18px]">progress_activity</span>
                  {t('common.loading')}
                </div>
              ) : historyError ? (
                <div role="alert" className="flex flex-1 items-center justify-center p-8 text-sm text-[var(--color-error)]">
                  {historyError}
                </div>
              ) : (
                <MessageList compact={showRightPanel} />
              )}
            </>
          )}

          {!isMemberSession && <SessionTaskBar />}

          <TeamStatusBar />

          {!isMemberSession && (
            <BackgroundTasksBar
              key={activeTabId}
              tasks={backgroundTasks}
              compact={showRightPanel}
              dismissedFinishedTaskKeys={dismissedBackgroundTaskKeys}
              onClearFinished={(taskKeys) => {
                if (!activeTabId || taskKeys.length === 0) return
                setDismissedBackgroundTaskKeysBySession((current) => ({
                  ...current,
                  [activeTabId]: new Set([
                    ...(current[activeTabId] ?? EMPTY_DISMISSED_BACKGROUND_TASK_KEYS),
                    ...taskKeys,
                  ]),
                }))
              }}
            />
          )}

          <ChatInput
            variant={isEmpty && !isMemberSession && !showRightPanel ? 'hero' : 'default'}
            compact={showRightPanel}
          />
        </div>

        {showWorkbench ? (
          <>
            <WorkspaceResizeHandle panelRef={workbenchPanelRef} />
            <aside
              ref={workbenchPanelRef}
              data-testid="workbench-panel"
              className="flex h-full shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)]"
              style={{ width: rightPanelWidth, maxWidth: '62%', minWidth: 'min(420px, 54%)' }}
            >
              <WorkbenchPanel sessionId={activeTabId} />
            </aside>
          </>
        ) : null}
      </div>

      {terminalPanelRuntimeId && activeTabId ? (
        <div
          data-testid="session-terminal-panel"
          className={[
            'flex min-h-0 shrink-0 flex-col border-t border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]',
            showTerminalPanel ? '' : 'hidden',
          ].join(' ')}
          style={{ height: showTerminalPanel ? terminalPanelHeight : 0 }}
        >
          {showTerminalPanel && <TerminalResizeHandle />}
          <TerminalSettings
            active={showTerminalPanel}
            docked
            cwd={getSessionTerminalCwd(session)}
            runtimeId={terminalPanelRuntimeId}
            preserveOnUnmount
            testId={`session-terminal-host-${activeTabId}`}
            onOpenInTab={() => {
              useTerminalPanelStore.getState().closePanel(activeTabId)
              useTabStore.getState().openTerminalTab(getSessionTerminalCwd(session), terminalPanelRuntimeId)
              useTerminalPanelStore.getState().detachRuntime(activeTabId)
            }}
            onClose={() => useTerminalPanelStore.getState().closePanel(activeTabId)}
          />
        </div>
      ) : null}

      {!isMemberSession && activeTabId ? (
        <ComputerUsePermissionModal
          sessionId={activeTabId}
          request={pendingComputerUsePermission?.request ?? null}
        />
      ) : null}
    </div>
  )
}
