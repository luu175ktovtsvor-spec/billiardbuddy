// 首启引导只保留通用 Agent 的主流程:欢迎 → 选项目工作目录 → 完成。
// 纯前端:完成标记落 localStorage(qf.onboarding.done),AppShell ready 后未标记才显示;「跳过」随时可点。
import { useState, type ReactNode } from 'react'
import { Smiley } from '../components/shared/Smiley'
import { pickWorkspaceFolder } from '../lib/workspace'
import { useSettingsStore } from '../stores/settingsStore'
import { IconFolder } from '../components/shared/icons'

const DONE_KEY = 'qf.onboarding.done'

export function isOnboardingDone(): boolean {
  try { return window.localStorage.getItem(DONE_KEY) === '1' } catch { return true }
}
function markDone() {
  try { window.localStorage.setItem(DONE_KEY, '1') } catch { /* 忽略 */ }
}

export async function finishWhenWorkspaceSelected(
  pick: () => Promise<string | null>,
  finish: () => void,
): Promise<boolean> {
  const selected = await pick()
  if (!selected) return false
  finish()
  return true
}

function PrimaryBtn({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg px-4 py-2 text-[13.5px] font-medium transition-opacity hover:opacity-90"
      style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)' }}
    >
      {children}
    </button>
  )
}

function GhostBtn({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg px-4 py-2 text-[13px] transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ color: 'var(--color-text-tertiary)' }}
    >
      {children}
    </button>
  )
}

export function OnboardingPage({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  const [picking, setPicking] = useState(false)
  const workspaceRoot = useSettingsStore((s) => s.workspaceRoot)
  const finish = () => { markDone(); onDone() }
  const next = () => setStep((s) => s + 1)
  const chooseWorkspace = async () => {
    if (picking) return
    setPicking(true)
    try {
      await finishWhenWorkspaceSelected(pickWorkspaceFolder, finish)
    } finally {
      setPicking(false)
    }
  }

  const steps: ReactNode[] = [
    // 1. 欢迎
    <div key="welcome" className="flex flex-col items-center text-center">
      <Smiley size={64} />
      <h1 className="mb-3 mt-6 text-[26px] font-semibold" style={{ color: 'var(--color-text-primary)' }}>欢迎使用球房管家</h1>
      <p className="max-w-[420px] text-sm leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
        它是装在你电脑上的 AI 助手:能读写文件、跑命令、上网查资料、生成图片,把活实打实干完。说句大白话,它就开工。
      </p>
      <div className="mt-8"><PrimaryBtn onClick={next}>继续</PrimaryBtn></div>
    </div>,

    // 2. 选工作目录:按钮直接打开系统原生文件夹选择器；取消就留在本步。
    <div key="workspace" className="flex flex-col items-center text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-lg" style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-secondary)' }}>
        <IconFolder size={28} />
      </span>
      <h1 className="mb-3 mt-6 text-[22px] font-semibold" style={{ color: 'var(--color-text-primary)' }}>选一个工作文件夹</h1>
      <p className="max-w-[420px] text-sm leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
        管家会在这个文件夹里读写文件、完成任务——就像给它划一块工位。之后每个对话也能单独换文件夹。
      </p>
      {workspaceRoot && (
        <p className="mt-3 max-w-[420px] truncate text-[12.5px]" style={{ color: 'var(--color-text-tertiary)' }}>已选:{workspaceRoot}</p>
      )}
      <div className="mt-8 flex items-center gap-2">
        <PrimaryBtn onClick={() => { void chooseWorkspace() }}>{picking ? '正在打开...' : '选择文件夹'}</PrimaryBtn>
        <GhostBtn onClick={finish}>先用默认位置</GhostBtn>
      </div>
    </div>,
  ]

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center px-6" style={{ background: 'var(--color-app-main)' }} data-testid="onboarding">
      <div className="flex w-full max-w-[560px] justify-center">{steps[step]}</div>
      {/* 步骤指示点 + 跳过 */}
      <div className="absolute bottom-8 left-1/2 flex -translate-x-1/2 items-center gap-4">
        <div className="flex items-center gap-1.5">
          {steps.map((_, i) => (
            <span key={i} className="block h-1.5 w-1.5 rounded-full transition-colors" style={{ background: i === step ? 'var(--color-text-secondary)' : 'color-mix(in srgb, var(--color-text-tertiary) 35%, transparent)' }} />
          ))}
        </div>
        {step < steps.length - 1 && <GhostBtn onClick={finish}>跳过引导</GhostBtn>}
      </div>
    </div>
  )
}
