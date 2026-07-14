// 首启引导(对齐 Codex electron.onboarding 主流程骨架:欢迎 welcomeV2 → 选项目 workspace → 完成;
// 登录/插件建议/青少年步不对标——免登录白标)。我们四步:欢迎 → 选工作目录 → 认识权限 → 专家模块。
// 纯前端:完成标记落 localStorage(qf.onboarding.done),AppShell ready 后未标记才显示;「跳过」随时可点。
import { useState, type ReactNode } from 'react'
import { Smiley } from '../components/shared/Smiley'
import { pickWorkspaceFolder } from '../lib/workspace'
import { useSettingsStore } from '../stores/settingsStore'
import { IconShield, IconEdit, IconAlertCircle, IconFolder, IconTarget } from '../components/shared/icons'

const DONE_KEY = 'qf.onboarding.done'

export function isOnboardingDone(): boolean {
  try { return window.localStorage.getItem(DONE_KEY) === '1' } catch { return true }
}
function markDone() {
  try { window.localStorage.setItem(DONE_KEY, '1') } catch { /* 忽略 */ }
}

function PrimaryBtn({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full px-6 py-2 text-[13.5px] font-medium transition-opacity hover:opacity-90"
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
      className="rounded-full px-4 py-2 text-[13px] transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ color: 'var(--color-text-tertiary)' }}
    >
      {children}
    </button>
  )
}

/** 权限档说明行(文案与设置页同源口径)。 */
function PermRow({ icon, title, desc }: { icon: ReactNode; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl px-4 py-3 text-left" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
      <span className="mt-0.5 shrink-0" style={{ color: 'var(--color-text-secondary)' }}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-[13.5px] font-medium" style={{ color: 'var(--color-text-primary)' }}>{title}</span>
        <span className="block text-[12.5px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{desc}</span>
      </span>
    </div>
  )
}

export function OnboardingPage({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  const workspaceRoot = useSettingsStore((s) => s.workspaceRoot)
  const finish = () => { markDone(); onDone() }
  const next = () => setStep((s) => s + 1)

  const steps: ReactNode[] = [
    // 1. 欢迎
    <div key="welcome" className="flex flex-col items-center text-center">
      <Smiley size={72} variant="glow" />
      <h1 className="mb-3 mt-6 text-[26px] font-semibold" style={{ color: 'var(--color-text-primary)' }}>欢迎使用球房管家</h1>
      <p className="max-w-[420px] text-sm leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
        它是装在你电脑上的 AI 助手:能读写文件、跑命令、上网查资料、生成图片,把活实打实干完。说句大白话,它就开工。
      </p>
      <div className="mt-8"><PrimaryBtn onClick={next}>继续</PrimaryBtn></div>
    </div>,

    // 2. 选工作目录(对齐 Codex workspace 步「添加项目以继续」,但允许跳过用默认)
    <div key="workspace" className="flex flex-col items-center text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-secondary)' }}>
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
        <PrimaryBtn onClick={() => { void pickWorkspaceFolder().then(() => next()) }}>选择文件夹</PrimaryBtn>
        <GhostBtn onClick={next}>先用默认位置</GhostBtn>
      </div>
    </div>,

    // 3. 认识权限(与设置页口径同源)
    <div key="perms" className="flex flex-col items-center text-center">
      <h1 className="mb-3 text-[22px] font-semibold" style={{ color: 'var(--color-text-primary)' }}>工作区内少打断,越界时再确认</h1>
      <p className="mb-6 max-w-[440px] text-sm leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
        输入框旁边有个权限开关,随时可切:
      </p>
      <div className="flex w-full max-w-[440px] flex-col gap-2">
        <PermRow icon={<IconShield size={17} />} title="默认权限" desc="改文件、跑命令前都先问你,点头才动手。日常用这个最稳。" />
        <PermRow icon={<IconEdit size={17} />} title="接受修改" desc="选择工作文件夹后默认使用;工作区内改文件不逐个确认,敏感动作仍会问。" />
        <PermRow icon={<IconAlertCircle size={17} />} title="完全访问" desc="全部放行不再询问。只在你完全清楚要做什么时用。" />
      </div>
      <div className="mt-8"><PrimaryBtn onClick={next}>明白了</PrimaryBtn></div>
    </div>,

    // 4. 台球知识库(挂载是会话级动作,这里只介绍入口不放开关)
    <div key="expert" className="flex flex-col items-center text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-secondary)' }}>
        <IconTarget size={28} />
      </span>
      <h1 className="mb-3 mt-6 text-[22px] font-semibold" style={{ color: 'var(--color-text-primary)' }}>开球房的老板,看这里</h1>
      <p className="max-w-[440px] text-sm leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
        内置「台球运营知识库」,为通用 Agent 提供球房经营资料。想用的时候,在输入框敲 <code className="rounded px-1" style={{ background: 'var(--color-surface-container)' }}>/台球</code> 就挂上;不开球房就当没看见,它默认不打扰。
      </p>
      <div className="mt-8"><PrimaryBtn onClick={finish}>开始使用</PrimaryBtn></div>
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
