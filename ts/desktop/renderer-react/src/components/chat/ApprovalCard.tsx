// 审批卡(最小版)。Block B 会用 cc PermissionDialog 替换(权限五档用词照搬 cc + 卡内 diff + 破坏性警告)。
// renderer 只展示后端权限决策,不在前端自行增加审批类别。
import type { ChatBlock } from '../../stores/chatStore'
import { useChatStore } from '../../stores/chatStore'
import { t } from '../../i18n'

type ApprovalBlock = Extract<ChatBlock, { kind: 'approval' }>

export function ApprovalCard({ block }: { block: ApprovalBlock }) {
  const approve = useChatStore((s) => s.approve)
  const reject = useChatStore((s) => s.reject)
  const reasonLines: string[] = []
  if (block.reason?.what) reasonLines.push(block.reason.what)
  if (block.reason?.why) reasonLines.push(t('approval.reasonWhy') + block.reason.why)
  if (block.reason?.impact) reasonLines.push(t('approval.reasonImpact') + block.reason.impact)
  const body = reasonLines.join('\n') || block.preview || ''

  return (
    <div
      className="my-2 rounded-xl p-3 text-sm"
      style={{ border: '1px solid var(--color-border-strong)', background: 'var(--color-brand-tint)' }}
    >
      <div className="font-semibold mb-1" style={{ color: 'var(--color-text-primary)' }}>
        {t('approval.title')}{block.tool}
      </div>
      {block.warning && (
        <div className="mb-1.5" style={{ color: 'var(--color-warning)' }}>⚠ {block.warning}</div>
      )}
      {body && (
        <div className="mb-2 whitespace-pre-wrap" style={{ color: 'var(--color-text-secondary)' }}>{body}</div>
      )}
      {block.resolved ? (
        <div style={{ color: 'var(--color-text-tertiary)' }}>
          {block.resolved === 'rejected'
            ? t('approval.rejected')
            : block.resolved === 'approved-session'
              ? t('approval.approvedSession')
              : t('approval.approved')}
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => approve(block.id, false)}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-white"
            style={{ background: 'var(--color-primary)' }}
          >
            {t('approval.allowOnce')}
          </button>
          {block.rememberable && (
            <button
              type="button"
              onClick={() => approve(block.id, true)}
              className="rounded-lg px-3 py-1.5 text-sm"
              style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
            >
              {t('approval.allowSession')}
            </button>
          )}
          <button
            type="button"
            onClick={() => reject(block.id)}
            className="rounded-lg px-3 py-1.5 text-sm"
            style={{ color: 'var(--color-error)' }}
          >
            {t('approval.reject')}
          </button>
        </div>
      )}
    </div>
  )
}
