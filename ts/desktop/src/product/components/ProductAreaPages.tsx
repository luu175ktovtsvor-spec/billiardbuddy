import { ArrowRight, Image, Store, Video } from 'lucide-react'
import type { ReactNode } from 'react'
import { getDesktopHost } from '../../lib/desktopHost'
import {
  IMAGE_WORKBENCH_TAB_ID,
  VIDEO_STUDIO_TAB_ID,
  useTabStore,
} from '../../stores/tabStore'
import { useProductTaskStore } from '../stores/productTaskStore'

function CapabilityCard({
  title,
  description,
  available,
  unavailableLabel,
  icon,
  onOpen,
}: {
  title: string
  description: string
  available: boolean
  unavailableLabel: string
  icon: ReactNode
  onOpen: () => void
}) {
  return (
    <article className="flex min-w-0 flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container)] p-4">
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-selected)] text-[var(--color-brand)]">
          {icon}
        </span>
        <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-tertiary)]">
          {available ? '可用' : unavailableLabel}
        </span>
      </div>
      <h2 className="mt-4 font-medium text-[var(--color-text-primary)]">{title}</h2>
      <p className="mt-1 flex-1 text-sm leading-6 text-[var(--color-text-secondary)]">{description}</p>
      <button
        type="button"
        disabled={!available}
        onClick={onOpen}
        className="mt-4 flex items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-primary)] transition-colors enabled:hover:bg-[var(--color-surface-hover)] disabled:cursor-default disabled:opacity-50"
      >
        打开
        <ArrowRight size={15} aria-hidden="true" />
      </button>
    </article>
  )
}

export function ProductCreationPage() {
  const openTab = useTabStore((state) => state.openTab)
  const nativeMediaAvailable = getDesktopHost().capabilities.mediaActions

  return (
    <main className="h-full overflow-y-auto bg-[var(--color-app-main)] px-5 py-5" data-testid="product-creation-page">
      <div className="mx-auto w-full max-w-4xl">
        <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">创作</h1>
        <p className="mt-1 text-sm leading-6 text-[var(--color-text-secondary)]">从一个创作目标开始，图片和视频项目会分别保留进度与结果。</p>
        <section className="mt-5 grid gap-4 sm:grid-cols-2" aria-label="创作能力">
          <CapabilityCard
            title="图片创作"
            description="生成新图片，或使用参考图继续编辑。"
            available={nativeMediaAvailable}
            unavailableLabel="需要桌面版"
            icon={<Image size={19} aria-hidden="true" />}
            onOpen={() => openTab(IMAGE_WORKBENCH_TAB_ID, '图片创作', 'image-workbench')}
          />
          <CapabilityCard
            title="视频创作"
            description="导入本机素材，整理剪辑并导出成片。"
            available={nativeMediaAvailable}
            unavailableLabel="需要桌面版"
            icon={<Video size={19} aria-hidden="true" />}
            onOpen={() => openTab(VIDEO_STUDIO_TAB_ID, '视频创作', 'video-studio')}
          />
        </section>
      </div>
    </main>
  )
}

export function ProductOperationsPage() {
  const canCreateTask = useProductTaskStore((state) => state.index.capabilities.createTask)
  const openNewProductTask = useTabStore((state) => state.openNewProductTask)

  return (
    <main className="h-full overflow-y-auto bg-[var(--color-app-main)] px-5 py-5" data-testid="product-operations-page">
      <div className="mx-auto w-full max-w-4xl">
        <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">经营</h1>
        <p className="mt-1 text-sm leading-6 text-[var(--color-text-secondary)]">把门店目标交给 BilliardBuddy；专用经营能力会在可用后出现在这里。</p>
        <section className="mt-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container)] px-5 py-10 text-center">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--color-surface-selected)] text-[var(--color-brand)]">
            <Store size={21} aria-hidden="true" />
          </span>
          <h2 className="mt-4 font-medium text-[var(--color-text-primary)]">
            {canCreateTask ? '从一个经营任务开始' : '经营任务暂不可用'}
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-[var(--color-text-secondary)]">
            {canCreateTask
              ? '可以先描述排班、活动、复盘或招聘目标。专用工具尚未接入时，产品不会把建议冒充成已执行结果。'
              : '当前安装尚未提供任务创建能力。能力恢复后，这里会显示可执行入口。'}
          </p>
          {canCreateTask ? (
            <button
              type="button"
              onClick={() => openNewProductTask()}
              className="mt-5 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white"
            >
              新建经营任务
            </button>
          ) : null}
        </section>
      </div>
    </main>
  )
}
