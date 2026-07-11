// 终端内容(底部终端抽屉的体)。owner 2026-07-11:
//   - 浅色(照 Codex:终端跟随 app 主题,浅色即白/近白,不是深色终端);
//   - 文字轻高亮:命令名加粗、参数(-x/--x)淡色;输出里分支行/未跟踪/报错分色。
// 数据源现取本会话已执行的 run_command 工具块;后端加"实时 stdout chunk"事件后,output 变流式即成实时终端。
import { useEffect, useRef } from 'react'
import { useChatStore, type ChatBlock } from '../../stores/chatStore'

type ToolBlock = Extract<ChatBlock, { kind: 'tool' }>

function cmdOf(b: ToolBlock): string {
  const o = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {}
  return typeof o.command === 'string' ? o.command : ''
}

/** 命令行轻高亮:程序名加粗、参数(-x/--x)淡色、其余常规。 */
function CommandLine({ cmd }: { cmd: string }) {
  const tokens = cmd.split(/(\s+)/)
  return (
    <span className="min-w-0 break-all">
      {tokens.map((tk, i) => {
        if (/^\s+$/.test(tk)) return <span key={i}>{tk}</span>
        const isFlag = tk.startsWith('-')
        const isProgram = i === 0
        return (
          <span
            key={i}
            style={{
              color: isFlag ? 'var(--color-text-tertiary)' : isProgram ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              fontWeight: isProgram ? 600 : 400,
            }}
          >
            {tk}
          </span>
        )
      })}
    </span>
  )
}

/** 输出行分色:报错/fatal 红、分支行(##)蓝、未跟踪(??)淡、其余常规。 */
function outputColor(line: string, error: boolean): string {
  if (error) return 'var(--color-error)'
  const t = line.trimStart()
  if (/^(fatal|error)\b/i.test(t)) return 'var(--color-error)'
  if (t.startsWith('## ')) return 'var(--color-link)'
  if (t.startsWith('??')) return 'var(--color-text-tertiary)'
  return 'var(--color-text-secondary)'
}

function Output({ output, error }: { output: string; error: boolean }) {
  const lines = output.replace(/\r\n?/g, '\n').split('\n')
  return (
    <div className="mt-0.5">
      {lines.map((line, i) => (
        <div key={i} className="whitespace-pre-wrap break-words" style={{ color: outputColor(line, error) }}>
          {line || ' '}
        </div>
      ))}
    </div>
  )
}

export function TerminalView() {
  const blocks = useChatStore((s) => s.blocks)
  const cmds = blocks.filter(
    (b): b is ToolBlock => b.kind === 'tool' && (b.tool === 'run_command' || b.tool === 'run_command_background'),
  )
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [cmds.length, blocks])

  return (
    <div
      className="min-h-full px-3 py-2.5"
      style={{ background: 'var(--color-app-main)', color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.6 }}
      data-codex-terminal
      data-testid="terminal-view"
    >
      {cmds.length === 0 ? (
        <div className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>
          还没有执行命令。AI 跑命令时,这里会显示命令与实时输出。
        </div>
      ) : (
        <>
          {cmds.map((b) => (
            <div key={b.id} className="mb-2.5">
              <div className="flex items-start gap-2">
                <span className="shrink-0 select-none" style={{ color: 'var(--color-success)' }}>$</span>
                <CommandLine cmd={cmdOf(b)} />
              </div>
              {b.output && <Output output={b.output} error={b.status === 'error'} />}
              {b.status === 'running' && <span style={{ color: 'var(--color-text-tertiary)' }}>运行中…</span>}
              {b.status === 'error' && !b.output && <span style={{ color: 'var(--color-error)' }}>(命令出错)</span>}
            </div>
          ))}
          <div ref={endRef} />
        </>
      )}
    </div>
  )
}
