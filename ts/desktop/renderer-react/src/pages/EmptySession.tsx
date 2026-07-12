// 空态 hero(对标 Codex 空态:居中头像 + 标题[h1/500] + 描述[text-weak/body])+ 新任务建议卡
// (对标 Codex home.newChatPageSuggestions:场景短标题 pill,点击把完整 prompt 填进输入框让用户改完再发;
//  建议集贴我们真实能力:整理文件/写文档/查资料/定时任务/生图,挂台球包的会话前置两条台球场景)。
// 头像 = 我们的绿色笑脸吉祥物(glow 变体);白标文案走 i18n。
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

function SuggestionPills() {
  const setDraft = useComposerStore((s) => s.setDraft)
  const packs = useSettingsStore((s) => s.enabledPacks)
  const billiards = packs.includes('billiards')
  // 挂台球包的会话:台球场景前置;通用会话只给通用建议(领域不越界)。
  const suggestions = billiards ? [...BILLIARDS_SUGGESTIONS, ...GENERAL_SUGGESTIONS.slice(0, 3)] : GENERAL_SUGGESTIONS
  return (
    <div className="mt-6 flex max-w-[560px] flex-wrap items-center justify-center gap-2" data-testid="suggestion-pills">
      {suggestions.map((s) => (
        <button
          key={s.label}
          type="button"
          onClick={() => setDraft(s.prompt)}
          className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] transition-colors hover:bg-[var(--color-surface-hover)]"
          style={{ color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
        >
          <span style={{ color: 'var(--color-text-tertiary)' }}>{s.icon}</span>
          {s.label}
        </button>
      ))}
    </div>
  )
}

export function EmptyHero() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center" data-testid="empty-hero">
      <div className="mb-5">
        <Smiley size={56} variant="glow" />
      </div>
      <h1 className="mb-2 text-2xl font-medium" style={{ color: 'var(--color-text-primary)' }}>{t('chat.emptyHero')}</h1>
      <p className="max-w-[440px] text-sm leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{t('chat.emptyHint')}</p>
      <SuggestionPills />
    </div>
  )
}

export function EmptySession() {
  return <EmptyHero />
}
