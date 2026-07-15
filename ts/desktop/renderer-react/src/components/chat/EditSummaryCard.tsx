// 「已编辑 N 个文件」汇总卡(照 Codex 对话里的编辑汇总模块):
//   头:图标 + 「已编辑 N 个文件」+ 总 +A -D + 撤销/审核 + 折叠;
//   体:每文件一行 = 类型色点 + 文件名 + 该文件 +A -D,点行 → 右面板审阅(openFile)。
// 增删行数用 diff(jsdiff)从 old/new(或 write 的 content)算,纯前端。
// 撤销 = 后端 rewind(会话+文件原子回退到本轮之前);只在最新一组编辑卡显示(canUndo)。
import { useState } from 'react'
import { diffLines } from 'diff'
import { useChatStore, type ChatBlock } from '../../stores/chatStore'
import { useFilePreviewStore } from '../../stores/filePreviewStore'
import { IconChevronDown, IconFilePen, IconUndo } from '../shared/icons'
import { Modal } from '../shared/Modal'
import { toast } from '../../stores/toastStore'
import { api } from '../../api/client'

/** 后端 /sessions/:id/turn-checkpoints 单项(节选前端要的字段)。 */
interface TurnCheckpoint {
  target: { targetUserMessageId: string }
  conversation: { messagesRemoved: number }
  code: { filesChanged: string[] }
}

interface UndoInfo {
  checkpoint: TurnCheckpoint
  fileCount: number
  removedMessages: number
}

async function loadUndoInfo(): Promise<UndoInfo | null> {
  const chat = useChatStore.getState()
  const id = chat.conversationId
  if (!id) { toast('当前没有会话'); return null }
  const { checkpoints } = await api.get<{ checkpoints: TurnCheckpoint[] }>(`/sessions/${encodeURIComponent(id)}/turn-checkpoints`)
  const last = checkpoints?.[checkpoints.length - 1]
  if (!last) { toast('没有可撤销的文件改动'); return null }
  return {
    checkpoint: last,
    fileCount: last.code?.filesChanged?.length ?? 0,
    removedMessages: last.conversation?.messagesRemoved ?? 0,
  }
}

async function applyUndo(info: UndoInfo): Promise<void> {
  const chat = useChatStore.getState()
  const id = chat.conversationId
  if (!id) { toast('当前没有会话'); return }
  await api.post(`/sessions/${encodeURIComponent(id)}/rewind`, { targetUserMessageId: info.checkpoint.target.targetUserMessageId })
  toast(info.fileCount > 0 ? `已撤销,恢复了 ${info.fileCount} 个文件` : '已撤销这轮改动')
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
function directoryName(p: string): string {
  const parts = p.split('/')
  parts.pop()
  return parts.join('/')
}

export function EditSummaryCard({ blocks, canUndo }: { blocks: ToolBlock[]; canUndo?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [undoBusy, setUndoBusy] = useState(false)
  const [undoInfo, setUndoInfo] = useState<UndoInfo | null>(null)
  const openFile = useFilePreviewStore((s) => s.openFile)
  const files = [...blocks.reduce((byPath, block) => {
    const path = fileOf(block)
    if (!path) return byPath
    const stats = statsOf(block)
    const current = byPath.get(path) ?? { path, adds: 0, dels: 0 }
    byPath.set(path, { path, adds: current.adds + stats.adds, dels: current.dels + stats.dels })
    return byPath
  }, new Map<string, { path: string; adds: number; dels: number }>()).values()]
  if (files.length === 0) return null
  const totalAdds = files.reduce((a, f) => a + f.adds, 0)
  const totalDels = files.reduce((a, f) => a + f.dels, 0)
  const visibleFiles = expanded ? files : files.slice(0, 3)
  const hiddenCount = files.length - visibleFiles.length
  const requestUndo = async () => {
    if (undoBusy) return
    setUndoBusy(true)
    try { setUndoInfo(await loadUndoInfo()) }
    catch (e) { toast(e instanceof Error ? e.message : '撤销失败') }
    finally { setUndoBusy(false) }
  }
  const confirmUndo = async () => {
    if (!undoInfo || undoBusy) return
    setUndoBusy(true)
    try { await applyUndo(undoInfo); setUndoInfo(null) }
    catch (e) { toast(e instanceof Error ? e.message : '撤销失败') }
    finally { setUndoBusy(false) }
  }
  const title = files.length === 1 ? `已编辑 ${baseName(files[0]!.path)}` : `已编辑 ${files.length} 个文件`

  return (
    <>
      <div className="mb-2 overflow-hidden rounded-lg text-[13px]" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface-container-lowest)' }} data-block="edit-summary">
        <div className="group relative flex items-center gap-3 p-2">
          <button type="button" aria-label="审核已修改文件" onClick={() => files[0] && openFile(files[0].path)} className="absolute inset-0 bg-transparent transition-colors group-hover:bg-[color-mix(in_oklab,var(--color-text-primary)_3%,transparent)]" />
          <span className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-secondary)' }}>
            <IconFilePen size={22} />
          </span>
          <div className="relative z-10 min-w-0 flex-1 pointer-events-none">
            <div className="truncate font-medium" style={{ color: 'var(--color-text-primary)' }}>{title}</div>
            <div className="mt-0.5 flex items-center gap-1 text-[12px] tabular-nums">
              <span style={{ color: 'var(--color-success)' }}>+{totalAdds}</span>
              <span style={{ color: 'var(--color-error)' }}>−{totalDels}</span>
            </div>
          </div>
          <div className="relative z-10 flex shrink-0 items-center gap-2">
            {canUndo && (
              <button type="button" disabled={undoBusy} onClick={() => void requestUndo()} className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-40" style={{ color: 'var(--color-text-secondary)' }}>
                <span>{undoBusy ? '读取中…' : '撤销'}</span>
                <IconUndo size={12} />
              </button>
            )}
            <button type="button" onClick={() => files[0] && openFile(files[0].path)} className="h-7 shrink-0 rounded-md px-2 text-[12px] transition-colors hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}>
              审核
            </button>
          </div>
        </div>

        {files.length > 1 && (
          <div className="flex flex-col" style={{ borderTop: '1px solid var(--color-border)' }}>
            {visibleFiles.map((file) => {
              const dir = directoryName(file.path)
              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => openFile(file.path)}
                  className="flex h-9 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
                >
                  <span className="sr-only">{file.path}</span>
                  <span className="flex min-w-0 flex-1 items-center truncate text-[13px]">
                    {dir && <span className="min-w-0 truncate" style={{ color: 'var(--color-text-tertiary)' }}>{dir}/</span>}
                    <span className="max-w-full shrink-0 truncate" style={{ color: 'var(--color-text-primary)' }}>{baseName(file.path)}</span>
                  </span>
                  <span className="shrink-0 text-[11.5px] tabular-nums" style={{ color: 'var(--color-success)' }}>+{file.adds}</span>
                  <span className="shrink-0 text-[11.5px] tabular-nums" style={{ color: 'var(--color-error)' }}>−{file.dels}</span>
                </button>
              )
            })}
            {(hiddenCount > 0 || expanded) && files.length > 3 && (
              <button type="button" onClick={() => setExpanded((value) => !value)} className="flex h-9 items-center gap-2 px-3 text-left text-[13px] hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-primary)' }}>
                <span>{expanded ? '收起文件' : `再显示 ${hiddenCount} 个文件`}</span>
                <IconChevronDown size={12} className={expanded ? 'rotate-180' : ''} />
              </button>
            )}
          </div>
        )}
      </div>

      <Modal
        open={undoInfo !== null}
        onClose={() => { if (!undoBusy) setUndoInfo(null) }}
        title="撤销这轮修改？"
        maxWidth={440}
        footer={(
          <>
            <button type="button" disabled={undoBusy} onClick={() => setUndoInfo(null)} className="h-8 rounded-md px-3 text-[13px] hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-secondary)' }}>取消</button>
            <button type="button" disabled={undoBusy} onClick={() => void confirmUndo()} className="h-8 rounded-md px-3 text-[13px] font-medium disabled:opacity-40" style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)' }}>{undoBusy ? '撤销中…' : '撤销'}</button>
          </>
        )}
      >
        <div className="px-5 py-4 text-[13px] leading-6" style={{ color: 'var(--color-text-secondary)' }}>
          将 {undoInfo?.fileCount ?? 0} 个文件恢复到这轮修改之前，并从当前会话移除 {undoInfo?.removedMessages ?? 0} 条消息。
        </div>
      </Modal>
    </>
  )
}
