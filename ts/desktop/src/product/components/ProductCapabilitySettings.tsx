import { useCallback, useEffect, useState } from 'react'
import { RotateCw } from 'lucide-react'
import type {
  ProductCapability,
  ProductCapabilityId,
  ProductCapabilityReasonCode,
  ProductCapabilityRepairAction,
  ProductCapabilityState,
  ProductCapabilitySnapshot,
} from '../../../../shared/product/capabilitySnapshot'
import type { Locale } from '../../i18n'
import { getDesktopHost } from '../../lib/desktopHost'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { getProductCapabilitySnapshot } from '../api/capabilities'

const CAPABILITY_NAMES: Record<Locale, Record<ProductCapabilityId, string>> = {
  en: { assistant: 'Assistant', image_understanding: 'Image understanding', image_creation: 'Image creation', voice_input: 'Voice input', video_editing: 'Video editing', scheduled_tasks: 'Scheduled tasks', recruiting_browser: 'Recruiting browser' },
  zh: { assistant: '任务助手', image_understanding: '图片理解', image_creation: '图片创作', voice_input: '语音输入', video_editing: '视频编辑', scheduled_tasks: '定时任务', recruiting_browser: '招聘浏览器' },
  'zh-TW': { assistant: '任務助手', image_understanding: '圖片理解', image_creation: '圖片創作', voice_input: '語音輸入', video_editing: '影片編輯', scheduled_tasks: '排程任務', recruiting_browser: '招募瀏覽器' },
  jp: { assistant: 'タスクアシスタント', image_understanding: '画像理解', image_creation: '画像作成', voice_input: '音声入力', video_editing: '動画編集', scheduled_tasks: 'スケジュールタスク', recruiting_browser: '採用ブラウザー' },
  kr: { assistant: '작업 도우미', image_understanding: '이미지 이해', image_creation: '이미지 생성', voice_input: '음성 입력', video_editing: '동영상 편집', scheduled_tasks: '예약 작업', recruiting_browser: '채용 브라우저' },
}

const STATE_LABELS: Record<Locale, Record<ProductCapabilityState, string>> = {
  en: { configured: 'Setup needed', available: 'Available', running: 'In use', degraded: 'Needs attention' },
  zh: { configured: '待完成设置', available: '可用', running: '正在使用', degraded: '需要处理' },
  'zh-TW': { configured: '待完成設定', available: '可用', running: '使用中', degraded: '需要處理' },
  jp: { configured: '設定が必要', available: '利用可能', running: '使用中', degraded: '要対応' },
  kr: { configured: '설정 필요', available: '사용 가능', running: '사용 중', degraded: '확인 필요' },
}

const REASON_LABELS: Record<Locale, Record<ProductCapabilityReasonCode, string>> = {
  en: { installation_session_unavailable: 'This installation is establishing its session. Try again shortly.', service_unreachable: 'The service could not be reached. Check the network and try again.', service_unavailable: 'This capability is not included in the current installation.', daily_quota_used: 'Today’s allowance has been used. It resets automatically.', media_tools_missing: 'The installed media tools are incomplete.', browser_extension_disconnected: 'Install the local connection and connect a supported Chrome page.', browser_bridge_failed: 'The recruiting browser connection needs to be repaired.' },
  zh: { installation_session_unavailable: '正在建立当前安装会话，请稍后重试。', service_unreachable: '暂时无法连接服务，请检查网络后重试。', service_unavailable: '当前安装版本未包含这项能力。', daily_quota_used: '今日额度已用完，将在重置时间自动恢复。', media_tools_missing: '当前安装包的媒体工具不完整。', browser_extension_disconnected: '请安装本机连接，并在 Chrome 中主动连接受支持页面。', browser_bridge_failed: '招聘浏览器连接需要修复。' },
  'zh-TW': { installation_session_unavailable: '正在建立目前安裝工作階段，請稍後重試。', service_unreachable: '暫時無法連線服務，請檢查網路後重試。', service_unavailable: '目前安裝版本未包含此能力。', daily_quota_used: '今日額度已用完，將在重設時間自動恢復。', media_tools_missing: '目前安裝包的媒體工具不完整。', browser_extension_disconnected: '請安裝本機連線，並在 Chrome 中主動連接受支援頁面。', browser_bridge_failed: '招募瀏覽器連線需要修復。' },
  jp: { installation_session_unavailable: 'このインストールのセッションを確立しています。少し待って再試行してください。', service_unreachable: 'サービスに接続できません。ネットワークを確認して再試行してください。', service_unavailable: '現在のインストールにはこの機能が含まれていません。', daily_quota_used: '本日の上限に達しました。リセット時刻に自動回復します。', media_tools_missing: 'インストール済みのメディアツールが不完全です。', browser_extension_disconnected: 'ローカル接続をインストールし、対応する Chrome ページを接続してください。', browser_bridge_failed: '採用ブラウザー接続の修復が必要です。' },
  kr: { installation_session_unavailable: '이 설치의 세션을 설정하고 있습니다. 잠시 후 다시 시도하세요.', service_unreachable: '서비스에 연결할 수 없습니다. 네트워크를 확인하고 다시 시도하세요.', service_unavailable: '현재 설치에 이 기능이 포함되어 있지 않습니다.', daily_quota_used: '오늘 사용량을 모두 사용했습니다. 재설정 시각에 자동 복구됩니다.', media_tools_missing: '설치된 미디어 도구가 완전하지 않습니다.', browser_extension_disconnected: '로컬 연결을 설치하고 지원되는 Chrome 페이지를 연결하세요.', browser_bridge_failed: '채용 브라우저 연결을 복구해야 합니다.' },
}

const SHELL_COPY: Record<Locale, { intro: string; loading: string; error: string; retry: string; remaining: string; reset: string; privacy: string; update: string; browser: string; restart: string; wait: string; updated: string }> = {
  en: { intro: 'Availability, current use, daily allowance and exact repair actions. Technical service settings stay private.', loading: 'Checking capabilities…', error: 'Capability status is temporarily unavailable.', retry: 'Try again', remaining: 'Remaining today', reset: 'Resets', privacy: 'Review privacy', update: 'Check update', browser: 'Set up browser', restart: 'Restart app', wait: 'Restores automatically', updated: 'Updated' },
  zh: { intro: '这里只显示可用性、当前使用状态、当日额度和准确修复入口；技术服务配置保持私密。', loading: '正在检查能力…', error: '能力状态暂时不可用。', retry: '重试', remaining: '今日剩余', reset: '重置时间', privacy: '查看隐私', update: '检查更新', browser: '设置浏览器', restart: '重启应用', wait: '到时自动恢复', updated: '更新时间' },
  'zh-TW': { intro: '這裡只顯示可用性、目前使用狀態、當日額度和準確修復入口；技術服務設定保持私密。', loading: '正在檢查能力…', error: '能力狀態暫時無法使用。', retry: '重試', remaining: '今日剩餘', reset: '重設時間', privacy: '查看隱私', update: '檢查更新', browser: '設定瀏覽器', restart: '重新啟動', wait: '屆時自動恢復', updated: '更新時間' },
  jp: { intro: '利用可否、使用状況、当日の上限、正確な修復操作のみを表示します。技術設定は非公開です。', loading: '機能を確認中…', error: '機能状態を取得できません。', retry: '再試行', remaining: '本日の残り', reset: 'リセット', privacy: 'プライバシーを確認', update: '更新を確認', browser: 'ブラウザーを設定', restart: '再起動', wait: '自動回復します', updated: '更新時刻' },
  kr: { intro: '사용 가능 여부, 현재 상태, 일일 사용량과 정확한 복구 작업만 표시합니다. 기술 설정은 공개하지 않습니다.', loading: '기능 확인 중…', error: '기능 상태를 확인할 수 없습니다.', retry: '다시 시도', remaining: '오늘 남음', reset: '재설정', privacy: '개인정보 확인', update: '업데이트 확인', browser: '브라우저 설정', restart: '앱 다시 시작', wait: '자동 복구', updated: '업데이트' },
}

function repairLabel(action: ProductCapabilityRepairAction, copy: typeof SHELL_COPY[Locale]): string {
  if (action === 'check_update') return copy.update
  if (action === 'install_recruiting_browser') return copy.browser
  if (action === 'restart_app') return copy.restart
  if (action === 'wait_for_reset') return copy.wait
  return copy.retry
}

export function ProductCapabilitySettings() {
  const locale = useSettingsStore(state => state.locale)
  const setActiveTab = useUIStore(state => state.setActiveSettingsTab)
  const [snapshot, setSnapshot] = useState<ProductCapabilitySnapshot | null>(null)
  const [error, setError] = useState(false)
  const [busyAction, setBusyAction] = useState<ProductCapabilityRepairAction | null>(null)
  const copy = SHELL_COPY[locale]

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await getProductCapabilitySnapshot())
      setError(false)
    } catch {
      setError(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 15_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const repair = async (action: ProductCapabilityRepairAction) => {
    if (action === 'check_update') return setActiveTab('about')
    if (action === 'install_recruiting_browser') return setActiveTab('recruitingBrowser')
    setBusyAction(action)
    try {
      if (action === 'restart_app') {
        const host = getDesktopHost()
        await host.appMode.prepareRestart()
        await host.appMode.restart()
        return
      }
      await refresh()
    } catch {
      setError(true)
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <section className="max-w-2xl" data-testid="product-capability-settings">
      <p className="mb-5 text-sm leading-6 text-[var(--color-text-tertiary)]">{copy.intro}</p>
      {!snapshot && !error ? <p role="status" className="text-sm text-[var(--color-text-secondary)]">{copy.loading}</p> : null}
      {error ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-error)]/40 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-text-secondary)]">
          <span>{copy.error}</span>
          <button type="button" className="rounded-lg border border-[var(--color-border)] px-3 py-1.5" onClick={() => { void refresh() }}>{copy.retry}</button>
        </div>
      ) : null}
      {snapshot ? (
        <>
          <div className="space-y-3">
            {snapshot.capabilities.map(capability => (
              <CapabilityRow
                key={capability.id}
                capability={capability}
                locale={locale}
                copy={copy}
                busy={busyAction === capability.repair_action}
                onRepair={repair}
              />
            ))}
          </div>
          <div className="mt-4 flex items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
            <button type="button" aria-label={copy.retry} onClick={() => { void refresh() }} className="rounded-md p-1 hover:bg-[var(--color-surface-hover)]"><RotateCw size={14} /></button>
            <span>{copy.updated} {new Date(snapshot.observed_at).toLocaleString(locale)}</span>
          </div>
        </>
      ) : null}
    </section>
  )
}

function CapabilityRow({ capability, locale, copy, busy, onRepair }: {
  capability: ProductCapability
  locale: Locale
  copy: typeof SHELL_COPY[Locale]
  busy: boolean
  onRepair: (action: ProductCapabilityRepairAction) => Promise<void>
}) {
  const stateColor = capability.state === 'degraded'
    ? 'text-[var(--color-error)]'
    : capability.state === 'configured'
      ? 'text-[var(--color-warning)]'
      : 'text-[var(--color-success)]'
  return (
    <article className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">{CAPABILITY_NAMES[locale][capability.id]}</h2>
          <p className={`mt-1 text-xs font-medium ${stateColor}`}>{STATE_LABELS[locale][capability.state]}</p>
        </div>
        {capability.repair_action === 'wait_for_reset' ? (
          <span className="shrink-0 text-xs text-[var(--color-text-tertiary)]">{repairLabel(capability.repair_action, copy)}</span>
        ) : capability.repair_action ? (
          <button
            type="button"
            disabled={busy}
            className="shrink-0 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] disabled:opacity-50"
            onClick={() => { void onRepair(capability.repair_action!) }}
          >
            {repairLabel(capability.repair_action, copy)}
          </button>
        ) : null}
      </div>
      {capability.reason_code ? <p className="mt-3 text-sm leading-5 text-[var(--color-text-secondary)]">{REASON_LABELS[locale][capability.reason_code]}</p> : null}
      {capability.quota ? (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-[var(--color-text-secondary)]">
            <span>{copy.remaining}</span>
            <span>{capability.quota.remaining_percent}%</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-border)]">
            <div className="h-full rounded-full bg-[var(--color-brand)]" style={{ width: `${capability.quota.remaining_percent}%` }} />
          </div>
          <p className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">{copy.reset}: {new Date(capability.quota.resets_at).toLocaleString(locale)}</p>
        </div>
      ) : null}
    </article>
  )
}
