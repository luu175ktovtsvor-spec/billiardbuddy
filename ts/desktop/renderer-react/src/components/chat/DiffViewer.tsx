// 对齐 cc-haha-ref desktop/src/components/chat/DiffViewer.tsx —— 抄的是「结构」(单栏 + 行号 + 词级高亮 +
// 头部路径/加减统计/复制),不抄依赖:cc 用 react-diff-viewer-continued + prism-react-renderer(两个都不在
// 我们 package.json 里,装新依赖要先问 owner);改用已在仓库里的 `diff`(ts/package.json 早有,jsdiff 系),
// 手写渲染,拿语义 token(--color-success/--color-error)配合 color-mix 出高亮底色,不新造色板。
import { useMemo, useState } from 'react'
import { diffLines, diffWords } from 'diff'
import { IconCopy } from '../shared/icons'

type Props = { filePath: string; oldString: string; newString: string }

interface Segment {
  text: string
  changed: boolean
}
interface RenderLine {
  type: 'add' | 'remove' | 'context'
  oldNo?: number
  newNo?: number
  segments: Segment[]
}

function splitHunk(value: string): string[] {
  const trimmed = value.endsWith('\n') ? value.slice(0, -1) : value
  return trimmed.split('\n')
}

function buildLines(oldString: string, newString: string): RenderLine[] {
  const hunks = diffLines(oldString, newString)
  const lines: RenderLine[] = []
  let oldNo = 1
  let newNo = 1
  for (let i = 0; i < hunks.length; i += 1) {
    const hunk = hunks[i]!
    if (!hunk.added && !hunk.removed) {
      for (const text of splitHunk(hunk.value)) {
        lines.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, segments: [{ text, changed: false }] })
      }
      continue
    }
    if (hunk.removed) {
      const removedLines = splitHunk(hunk.value)
      const next = hunks[i + 1]
      if (next?.added) {
        // 相邻的删除+新增当作同一处改动配对,逐行做词级 diff(近似 cc 的整行替换高亮)。
        const addedLines = splitHunk(next.value)
        const pairCount = Math.max(removedLines.length, addedLines.length)
        for (let j = 0; j < pairCount; j += 1) {
          const oldLine = removedLines[j]
          const newLine = addedLines[j]
          if (oldLine !== undefined && newLine !== undefined) {
            const wordDiff = diffWords(oldLine, newLine)
            lines.push({
              type: 'remove',
              oldNo: oldNo++,
              segments: wordDiff.filter((p) => !p.added).map((p) => ({ text: p.value, changed: Boolean(p.removed) })),
            })
            lines.push({
              type: 'add',
              newNo: newNo++,
              segments: wordDiff.filter((p) => !p.removed).map((p) => ({ text: p.value, changed: Boolean(p.added) })),
            })
          } else if (oldLine !== undefined) {
            lines.push({ type: 'remove', oldNo: oldNo++, segments: [{ text: oldLine, changed: true }] })
          } else if (newLine !== undefined) {
            lines.push({ type: 'add', newNo: newNo++, segments: [{ text: newLine, changed: true }] })
          }
        }
        i += 1 // 已经把下一个 added hunk 一并消费掉了
        continue
      }
      for (const text of removedLines) lines.push({ type: 'remove', oldNo: oldNo++, segments: [{ text, changed: true }] })
      continue
    }
    // hunk.added 且前面没有配对的 removed
    for (const text of splitHunk(hunk.value)) lines.push({ type: 'add', newNo: newNo++, segments: [{ text, changed: true }] })
  }
  return lines
}

export function DiffViewer({ filePath, oldString, newString }: Props) {
  const lines = useMemo(() => buildLines(oldString, newString), [oldString, newString])
  const [copied, setCopied] = useState(false)
  const additions = lines.filter((l) => l.type === 'add').length
  const deletions = lines.filter((l) => l.type === 'remove').length

  function copyDiff() {
    const text = lines
      .map((l) => `${l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' '}${l.segments.map((s) => s.text).join('')}`)
      .join('\n')
    void navigator.clipboard?.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="overflow-hidden rounded-lg border" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-container-low)' }}>
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5" style={{ borderColor: 'var(--color-border)' }}>
        <span className="min-w-0 flex-1 truncate text-[11px]" style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
          {filePath}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums" style={{ color: 'var(--color-success)' }}>+{additions}</span>
        <span className="shrink-0 text-[10px] tabular-nums" style={{ color: 'var(--color-error)' }}>-{deletions}</span>
        <button
          type="button"
          onClick={copyDiff}
          className="shrink-0 rounded-md p-1 transition-colors hover:bg-[var(--color-surface-hover)]"
          title={copied ? '已复制' : '复制'}
          style={{ color: 'var(--color-text-tertiary)' }}
        >
          <IconCopy size={12} />
        </button>
      </div>
      <div className="max-h-[400px] overflow-auto" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.55 }}>
        {lines.map((line, i) => {
          const rowBg =
            line.type === 'add'
              ? 'color-mix(in srgb, var(--color-success) 15%, transparent)'
              : line.type === 'remove'
                ? 'color-mix(in srgb, var(--color-error) 15%, transparent)'
                : 'transparent'
          const markColor = line.type === 'add' ? 'var(--color-success)' : line.type === 'remove' ? 'var(--color-error)' : 'var(--color-text-tertiary)'
          return (
            <div key={i} className="flex" style={{ background: rowBg }}>
              <span className="shrink-0 select-none text-right" style={{ width: 36, padding: '0 6px', color: 'var(--color-text-tertiary)', opacity: 0.65 }}>
                {line.oldNo ?? ''}
              </span>
              <span className="shrink-0 select-none text-right" style={{ width: 36, padding: '0 6px', color: 'var(--color-text-tertiary)', opacity: 0.65 }}>
                {line.newNo ?? ''}
              </span>
              <span className="shrink-0 select-none" style={{ width: 14, color: markColor, fontWeight: 600 }}>
                {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ''}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3" style={{ color: 'var(--color-text-primary)' }}>
                {line.segments.map((seg, si) => (
                  <span
                    key={si}
                    style={
                      seg.changed
                        ? {
                            background:
                              line.type === 'add'
                                ? 'color-mix(in srgb, var(--color-success) 32%, transparent)'
                                : 'color-mix(in srgb, var(--color-error) 32%, transparent)',
                            borderRadius: 2,
                          }
                        : undefined
                    }
                  >
                    {seg.text.length ? seg.text : ' '}
                  </span>
                ))}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
