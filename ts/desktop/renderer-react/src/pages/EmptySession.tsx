// 新任务页使用当前 Codex 的居中标题和无边框建议列表；点击建议只填入输入框。
import type { ReactNode } from 'react'
import { t } from '../i18n'
import { Smiley } from '../components/shared/Smiley'
import { useComposerStore } from '../stores/composerStore'
import { useSettingsStore } from '../stores/settingsStore'
import {
  IconFolder, IconFileText, IconGlobe2, IconClock, IconSparkles, IconTarget, IconZap,
} from '../components/shared/icons'

interface Suggestion {
  icon: ReactNode
  label: string
  prompt: string
}

const GENERAL_SUGGESTIONS: Suggestion[] = [
  { icon: <IconFolder size={14} />, label: '整理一个文件夹', prompt: '帮我整理一个文件夹:先问我要整理哪个文件夹,看完里面有什么后给我归类方案,我确认了再动手。' },
  { icon: <IconFileText size={14} />, label: '写一份文档', prompt: '帮我写一份文档。先问清楚我:主题、给谁看、大概多长,然后列个提纲给我确认。' },
  { icon: <IconGlobe2 size={14} />, label: '上网查个东西', prompt: '帮我上网查一个问题,把结论用大白话讲给我,并附上来源链接。先问我要查什么。' },
  { icon: <IconClock size={14} />, label: '安排定时任务', prompt: '帮我安排一个定时自动执行的任务。先问我:要做什么、多久一次、什么时间点。' },
  { icon: <IconSparkles size={14} />, label: '做一张图', prompt: '帮我生成一张图片。先问我想要的内容、风格和用途(海报/朋友圈/头像)。' },
]

const BILLIARDS_SUGGESTIONS: Suggestion[] = [
  { icon: <IconTarget size={14} />, label: '今日经营复盘', prompt: '帮我做今天的球房经营复盘:先问我今天的营业数据和特别情况,再给我一份日报和明天的改进建议。' },
  { icon: <IconZap size={14} />, label: '写朋友圈文案', prompt: '帮我写 3 条球房朋友圈文案,风格接地气、能吸引人到店,写完让我挑。' },
]

function SuggestionList() {
  const setDraft = useComposerStore((s) => s.setDraft)
  const packs = useSettingsStore((s) => s.enabledPacks)
  const billiards = packs.includes('billiards')
  // 挂台球包的会话:台球场景前置;通用会话只给通用建议(领域不越界)。
  const suggestions = billiards ? [...BILLIARDS_SUGGESTIONS, ...GENERAL_SUGGESTIONS.slice(0, 3)] : GENERAL_SUGGESTIONS
  return (
    <div className="mt-6 flex w-full max-w-[560px] flex-col py-2 pl-6" data-testid="suggestion-list">
      {suggestions.map((s) => (
        <button
          key={s.label}
          type="button"
          onClick={() => setDraft(s.prompt)}
          className="flex min-h-10 w-full items-center rounded-lg pr-1 text-left text-[14px] transition-transform hover:bg-[var(--color-surface-hover)] active:scale-[0.99]"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          <span className="mr-2 flex size-4 shrink-0 items-center justify-center" style={{ color: 'var(--color-text-tertiary)' }}>{s.icon}</span>
          <span className="min-w-0 flex-1 truncate">{s.label}</span>
        </button>
      ))}
    </div>
  )
}

export function EmptyHero() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col items-center justify-center gap-3 px-6 py-6 text-center" data-testid="empty-hero">
      <Smiley size={40} />
      <h1 className="whitespace-pre-wrap text-[28px] font-normal" style={{ color: 'var(--color-text-primary)' }}>{t('chat.emptyHero')}</h1>
      <SuggestionList />
    </div>
  )
}

export function EmptySession() {
  return <EmptyHero />
}
