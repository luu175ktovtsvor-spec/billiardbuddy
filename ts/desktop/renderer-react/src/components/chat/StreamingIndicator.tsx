// 轻量等待行:回合运行中、且当前没有正在进行的活动行(还没出现任何活动 / 上一个思考或工具已经收尾、
// 下一个事件还没到)时显示,把 runVerb 三态(thinking/running/working)变成用户看得到的阶段文字——
// 不然两张工具卡之间的空档用户只能自己猜管家是不是还在动。一旦有活动行正在进行，状态由那一行接管。
import { useChatStore } from '../../stores/chatStore'
import type { ChatBlock, RunVerb } from '../../stores/chatStore'
import { t } from '../../i18n'

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m${s}s`
}

function runVerbLabel(verb: RunVerb): string {
  if (verb === 'thinking') return t('chat.thinking')
  if (verb === 'running') return t('chat.running')
  return t('chat.working')
}

export function StreamingIndicator() {
  const status = useChatStore((s) => s.status)
  const blocks = useChatStore((s) => s.blocks)
  const elapsedSeconds = useChatStore((s) => s.elapsedSeconds)
  const runVerb = useChatStore((s) => s.runVerb)
  if (!shouldShowInitialWaiting(status, blocks)) return null

  return (
    <div className="mb-2 mt-3" data-testid="streaming-indicator">
      <span className="qf-shimmer-text text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
        {runVerbLabel(runVerb)}{elapsedSeconds > 0 ? ` ${formatElapsed(elapsedSeconds)}` : ''}
      </span>
      <div className="mt-1.5 w-full border-t" style={{ borderColor: 'var(--color-border)' }} />
    </div>
  )
}

/** 这一块之后紧跟的活动是否仍在进行中(正在思考 / 工具还在跑 / 正文还在流)。 */
function isLiveActivityBlock(block: ChatBlock): boolean {
  if (block.kind === 'thinking') return block.active
  if (block.kind === 'tool') return block.status === 'running'
  if (block.kind === 'assistant') return block.streaming
  if (block.kind === 'note') return false
  return true
}

export function shouldShowInitialWaiting(status: 'idle' | 'running', blocks: ChatBlock[]): boolean {
  if (status !== 'running') return false
  let lastUserIndex = -1
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i]?.kind === 'user') {
      lastUserIndex = i
      break
    }
  }
  return !blocks.slice(lastUserIndex + 1).some(isLiveActivityBlock)
}
