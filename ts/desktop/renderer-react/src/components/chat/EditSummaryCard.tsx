// 「已编辑 N 个文件」汇总卡(照 Codex 对话里的编辑汇总模块):
//   头:图标 + 「已编辑 N 个文件」+ 总 +A -D + 撤销/审核 + 折叠;
//   体:每文件一行 = 类型色点 + 文件名 + 该文件 +A -D,点行 → 右面板审阅(openFile)。
// 增删行数用 diff(jsdiff)从 old/new(或 write 的 content)算,纯前端。
// 撤销 = 后端 rewind(会话+文件原子回退到本轮之前);只在最新一组编辑卡显示(canUndo)。
import { useState } from 'react'
import { diffLines } from 'diff'
import { useChatStore, type ChatBlock } from '../../stores/chatStore'
import { useFilePreviewStore } from '../../stores/filePreviewStore'
import { fileColor } from '../workspace/FileTree'
import { IconChevronDown, IconFilePen } from '../shared/icons'
import { toast } from '../../stores/toastStore'
import { api } from '../../api/client'

/** 后端 /sessions/:id/turn-checkpoints 单项(节选前端要的字段)。 */
interface TurnCheckpoint {
  target: { targetUserMessageId: string }
  conversation: { messagesRemoved: number }
  code: { filesChanged: string[] }
}

/** 撤销最新一轮编辑:取最新 checkpoint → 原生确认 → rewind(文件恢复+对话回退)→ 整段重载。 */
async function undoLatestEdits(): Promise<void> {
  const chat = useChatStore.getState()
  const id = chat.conversationId
  if (!id) { toast('当前没有会话'); return }
  const { checkpoints } = await api.get<{ checkpoints: TurnCheckpoint[] }>(`/sessions/${encodeURIComponent(id)}/turn-checkpoints`)
  const last = checkpoints?.[checkpoints.length - 1]
  if (!last) { toast('没有可撤销的文件改动'); return }
  const fileCount = last.code?.filesChanged?.length ?? 0
  const removed = last.conversation?.messagesRemoved ?? 0
  const ok = window.confirm(`撤销会把 ${fileCount} 个文件恢复到这轮修改之前,并回退这轮对话(移除 ${removed} 条消息)。确定撤销吗?`)
  if (!ok) return
  await api.post(`/sessions/${encodeURIComponent(id)}/rewind`, { targetUserMessageId: last.target.targetUserMessageId })
  toast(fileCount > 0 ? `已撤销,恢复了 ${fileCount} 个文件` : '已撤销这轮改动')
  useFilePreviewStore.setState({ tree: null }) // 文件树按需重载(下次打开面板时拉新)
  chat.startConversation(id, { replay: true }) // 对话整段重载(回退后的消息已被移除)
}

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

export function EditSummaryCard({ blocks, canUndo }: { blocks: ToolBlock[]; canUndo?: boolean }) {
  const [open, setOpen] = useState(true)
  const [undoBusy, setUndoBusy] = useState(false)
  const openFile = useFilePreviewStore((s) => s.openFile)
  const files = blocks.map((b) => ({ path: fileOf(b), ...statsOf(b) })).filter((f) => f.path)
  if (files.length === 0) return null
  const totalAdds = files.reduce((a, f) => a + f.adds, 0)
  const totalDels = files.reduce((a, f) => a + f.dels, 0)
  const undo = async () => {
    if (undoBusy) return
    setUndoBusy(true)
    try { await undoLatestEdits() }
    catch (e) { toast(e instanceof Error ? e.message : '撤销失败') }
    finally { setUndoBusy(false) }
  }

  return (
    <div className="my-1.5 overflow-hidden rounded-xl" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface)' }} data-block="edit-summary">
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <IconFilePen size={14} style={{ color: 'var(--color-text-secondary)' }} />
          <span className="text-[13px] font-medium" style={{ color: 'var(--color-text-primary)' }}>已编辑 {files.length} 个文件</span>
          <span className="text-[12px] tabular-nums" style={{ color: 'var(--color-success)' }}>+{totalAdds}</span>
          <span className="text-[12px] tabular-nums" style={{ color: 'var(--color-error)' }}>−{totalDels}</span>
        </button>
        {canUndo && (
          <button type="button" disabled={undoBusy} onClick={() => void undo()} className="shrink-0 rounded-md px-2 py-1 text-[12px] transition-colors hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-secondary)', opacity: undoBusy ? 0.5 : 1 }}>
            {undoBusy ? '撤销中…' : '撤销'}
          </button>
        )}
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
