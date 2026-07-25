import { useEffect, useMemo, useState } from 'react'
import type { PublicRecruitingAction } from '../../../../shared/product/browserCapability'
import { getDesktopHost } from '../../lib/desktopHost'

const KIND_LABEL = {
  send_message: '发送消息',
  invite: '发出邀约',
  reject: '标记不合适',
} as const

export function RecruitingActionApproval({ taskId }: { taskId: string }) {
  const host = getDesktopHost()
  const [actions, setActions] = useState<PublicRecruitingAction[]>([])
  const [responding, setResponding] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    if (!host.capabilities.recruitingBrowser) return
    try {
      setActions(await host.recruitingBrowser.listActions(taskId))
      setError(null)
    } catch {
      setError('招聘操作状态暂时无法读取。')
    }
  }

  useEffect(() => {
    setActions([])
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 1500)
    return () => window.clearInterval(timer)
  }, [taskId])

  const pending = useMemo(() => actions.filter(action => action.state === 'awaiting_confirmation'), [actions])
  const latestOutcome = useMemo(() => [...actions].reverse().find(action => ['dispatching', 'approved_waiting', 'outcome_unknown'].includes(action.state)), [actions])

  const resolve = async (action: PublicRecruitingAction, approved: boolean) => {
    setResponding(action.id)
    try {
      await host.recruitingBrowser.resolveAction(taskId, action.id, action.revision, approved)
      await refresh()
    } catch {
      setError('页面或操作状态已经变化，请重新检查后确认。')
    } finally {
      setResponding(null)
    }
  }

  if (!host.capabilities.recruitingBrowser || (!pending.length && !latestOutcome && !error)) return null

  return (
    <div className="mx-auto mt-5 max-w-2xl space-y-3" data-testid="recruiting-action-approvals">
      {pending.map(action => (
        <section key={action.id} role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-[var(--color-text-secondary)]">
          <p className="font-medium text-[var(--color-text-primary)]">招聘操作需要你确认</p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 leading-6">
            <dt className="text-[var(--color-text-tertiary)]">将做什么</dt><dd>{KIND_LABEL[action.kind]}</dd>
            <dt className="text-[var(--color-text-tertiary)]">对象</dt><dd>{action.target_label}</dd>
            {action.message ? <><dt className="text-[var(--color-text-tertiary)]">消息原文</dt><dd className="whitespace-pre-wrap">{action.message}</dd></> : null}
            <dt className="text-[var(--color-text-tertiary)]">后果</dt><dd>确认后会在当前 BOSS 页面执行，不能由 Full access 或自动审批代替。</dd>
          </dl>
          <div className="mt-3 flex gap-2">
            <button type="button" disabled={responding === action.id} onClick={() => { void resolve(action, true) }} className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">确认执行</button>
            <button type="button" disabled={responding === action.id} onClick={() => { void resolve(action, false) }} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)] disabled:opacity-50">拒绝</button>
          </div>
        </section>
      ))}
      {latestOutcome ? (
        <p role="status" className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text-secondary)]">
          {latestOutcome.state === 'outcome_unknown' ? '浏览器操作结果无法确认，请在 BOSS 页面人工核对；系统不会自动重试。' : latestOutcome.state === 'dispatching' ? '已确认，正在等待当前招聘页面返回结果。' : '已确认，正在等待浏览器资源。'}
        </p>
      ) : null}
      {error ? <p role="alert" className="text-sm text-[var(--color-error)]">{error}</p> : null}
    </div>
  )
}
