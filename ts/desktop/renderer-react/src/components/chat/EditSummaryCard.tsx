// 「已编辑 N 个文件」汇总卡(照 Codex 对话里的编辑汇总模块):
//   头:图标 + 「已编辑 N 个文件」+ 总 +A -D + 撤销/审核 + 折叠;
//   体:每文件一行 = 类型色点 + 文件名 + 该文件 +A -D,点行 → 右面板审阅(openFile)。
// 增删行数用 diff(jsdiff)从 old/new(或 write 的 content)算,纯前端。撤销需后端,先 toast 占位。
import { useState } from 'react'
import { diffLines } from 'diff'
import type { ChatBlock } from '../../stores/chatStore'
import { useFilePreviewStore } from '../../stores/filePreviewStore'
import { fileColor } from '../workspace/FileTree'
import { IconChevronDown, IconFilePen } from '../shared/icons'
import { toast } from '../../stores/toastStore'

type ToolBlock = Extract<ChatBlock, { kind: 'tool' }>

function obj(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}
function fileOf(b: ToolBlock): string {
  const o = obj(b.input)
  return typeof o.file_path === 'string' ? o.file_path : typeof o.path === 'string' ? o.path : ''
}
function statsOf(b: ToolBlock): { adds: number; dels: number } {
  const o = obj(b.input)
  let oldStr = ''
  let newStr = ''
  if (b.tool === 'write_file' && typeof o.content === 'string') {
    newStr = o.content
  } else if (typeof o.old_string === 'string' && typeof o.new_string === 'string') {
    oldStr = o.old_string
    newStr = o.new_string
  } else {
    return { adds: 0, dels: 0 }
  }
  let adds = 0
  let dels = 0
  for (const p of diffLines(oldStr, newStr)) {
    if (p.added) adds += p.count ?? 0
    else if (p.removed) dels += p.count ?? 0
  }
  return { adds, dels }
}
function baseName(p: string): string {
  return p.split('/').pop() || p
}

export function EditSummaryCard({ blocks }: { blocks: ToolBlock[] }) {
  const [open, setOpen] = useState(true)
  const openFile = useFilePreviewStore((s) => s.openFile)
  const files = blocks.map((b) => ({ path: fileOf(b), ...statsOf(b) })).filter((f) => f.path)
  if (files.length === 0) return null
  const totalAdds = files.reduce((a, f) => a + f.adds, 0)
  const totalDels = files.reduce((a, f) => a + f.dels, 0)

  return (
    <div className="my-1.5 overflow-hidden rounded-xl" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface)' }} data-block="edit-summary">
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <IconFilePen size={14} style={{ color: 'var(--color-text-secondary)' }} />
          <span className="text-[13px] font-medium" style={{ color: 'var(--color-text-primary)' }}>已编辑 {files.length} 个文件</span>
          <span className="text-[12px] tabular-nums" style={{ color: 'var(--color-success)' }}>+{totalAdds}</span>
          <span className="text-[12px] tabular-nums" style={{ color: 'var(--color-error)' }}>−{totalDels}</span>
        </button>
        <button type="button" onClick={() => toast('撤销即将上线')} className="shrink-0 rounded-md px-2 py-1 text-[12px] transition-colors hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-secondary)' }}>
          撤销
        </button>
        <button type="button" onClick={() => files[0] && openFile(files[0].path)} className="shrink-0 rounded-md px-2 py-1 text-[12px] transition-colors hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}>
          审核
        </button>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-label="展开/收起" className="shrink-0">
          <IconChevronDown size={13} style={{ color: 'var(--color-text-tertiary)', transform: open ? undefined : 'rotate(-90deg)', transition: 'transform .15s ease' }} />
        </button>
      </div>
      {open && (
        <div style={{ borderTop: '1px solid var(--color-border)' }}>
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => openFile(f.path)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
            >
              <span className="shrink-0" style={{ width: 7, height: 7, borderRadius: 2, background: fileColor(baseName(f.path)) }} />
              <span className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: 'var(--color-text-secondary)' }}>{baseName(f.path)}</span>
              <span className="shrink-0 text-[11.5px] tabular-nums" style={{ color: 'var(--color-success)' }}>+{f.adds}</span>
              <span className="shrink-0 text-[11.5px] tabular-nums" style={{ color: 'var(--color-error)' }}>−{f.dels}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
