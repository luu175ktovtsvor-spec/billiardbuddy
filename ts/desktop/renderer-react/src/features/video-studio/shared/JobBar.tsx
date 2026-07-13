import type { VideoJob } from '../../../api/video'
import { friendlyVideoText } from '../videoStudioModel'
import { subtleButtonStyle } from '../videoStudioStyles'

export function JobBar({ job, onCancel, onRetry }: { job: VideoJob; onCancel: () => void; onRetry: () => void }) {
  const running = !['done', 'done_with_warnings', 'cancelled', 'interrupted', 'error'].includes(job.status)
  const statusLabel: Record<VideoJob['status'], string> = {
    queued: '等待处理', preparing: '正在准备组件', analyzing: '正在分析素材', planning: '正在生成草稿', rendering: '正在导出',
    blocked: '组件尚未就绪', cancelled: '已取消，可继续', interrupted: '应用退出导致中断', error: '处理失败', done: '已完成', done_with_warnings: '已完成，存在提醒',
  }
  return (
    <div className="rounded-lg px-3 py-2.5" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface-container-low)' }} data-testid="video-job-status">
      <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
        <span className="min-w-0 flex-1 truncate">{friendlyVideoText(job.stage || statusLabel[job.status])}</span>
        <span>{Math.round(job.progress)}%</span>
        {running ? <button type="button" onClick={onCancel} className="rounded-md px-2 py-1" style={subtleButtonStyle} data-testid="video-cancel-job">取消</button>
          : job.retryable && <button type="button" onClick={onRetry} className="rounded-md px-2 py-1" style={subtleButtonStyle} data-testid="video-retry-job">重试</button>}
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full" style={{ background: 'var(--color-surface-container)' }}>
        <div className="h-full transition-all" style={{ width: `${Math.max(3, job.progress)}%`, background: job.status === 'error' ? 'var(--color-error)' : 'var(--color-brand)' }} />
      </div>
      {job.error && <div className="mt-2 text-[11px]" style={{ color: 'var(--color-error)' }}>{friendlyVideoText(job.error.message)}</div>}
      {!job.error && job.warnings.slice(0, 2).map(warning => <div key={warning} className="mt-2 text-[11px]" style={{ color: 'var(--color-warning)' }}>{friendlyVideoText(warning)}</div>)}
    </div>
  )
}
