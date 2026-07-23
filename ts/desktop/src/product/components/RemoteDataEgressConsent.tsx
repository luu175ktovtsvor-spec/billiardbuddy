import { useCallback, useEffect, useState } from 'react'
import type { RemoteDataEgressStatus } from '../../../../shared/product/dataEgress'
import { whenDesktopServerReady } from '../../lib/desktopRuntime'
import { Button } from '../../components/shared/Button'
import { Modal } from '../../components/shared/Modal'
import { productDataEgressConsentApi } from '../api/dataEgressConsent'

export function RemoteDataEgressConsentGate() {
  const [status, setStatus] = useState<RemoteDataEgressStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void whenDesktopServerReady()
      .then(() => productDataEgressConsentApi.status())
      .then((next) => { if (!cancelled) setStatus(next) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const grant = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      setStatus(await productDataEgressConsentApi.grant())
    } catch {
      setError('暂时无法保存，请稍后重试。')
    } finally {
      setSaving(false)
    }
  }, [])

  const open = Boolean(status?.available && !status.active && !dismissed)
  return (
    <Modal
      open={open}
      onClose={() => setDismissed(true)}
      title="使用远程智能能力前，请先确认"
      width={640}
      footer={(
        <>
          <Button variant="secondary" onClick={() => setDismissed(true)} disabled={saving}>暂不使用</Button>
          <Button onClick={() => void grant()} disabled={saving}>{saving ? '正在保存…' : '同意并继续'}</Button>
        </>
      )}
    >
      <div className="space-y-4 text-sm leading-6 text-[var(--color-text-secondary)]">
        <p>用途：{status?.disclosure.purpose}。只有在对应功能实际使用时，才会发送该类数据。</p>
        <p>会发送：{status?.disclosure.data.join('、')}。</p>
        <ul className="space-y-2 pl-5 list-disc">
          {status?.disclosure.receivers.map(receiver => (
            <li key={receiver.capability}>
              <span className="font-medium text-[var(--color-text-primary)]">{receiver.provider}</span>
              {' · '}{receiver.region}：{receiver.retention}
            </li>
          ))}
        </ul>
        <p>可能产生服务费用。你可以随时在“设置 → 常规 → 远程数据使用”撤销；撤销后，新的文字任务、图片理解和语音转写会停止提交。已经提交的付费操作不会因此自动取消。</p>
        {error && <p role="alert" className="text-[var(--color-error)]">{error}</p>}
      </div>
    </Modal>
  )
}

export function RemoteDataEgressSettings() {
  const [status, setStatus] = useState<RemoteDataEgressStatus | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setStatus(await productDataEgressConsentApi.status())
  }, [])

  useEffect(() => { void refresh().catch(() => {}) }, [refresh])

  const change = async () => {
    setWorking(true)
    setError(null)
    try {
      setStatus(status?.active
        ? await productDataEgressConsentApi.revoke()
        : await productDataEgressConsentApi.grant())
    } catch {
      setError('暂时无法保存，请稍后重试。')
    } finally {
      setWorking(false)
    }
  }

  return (
    <section className="mb-8" aria-labelledby="remote-data-egress-title">
      <h2 id="remote-data-egress-title" className="mb-1 text-base font-semibold text-[var(--color-text-primary)]">远程数据使用</h2>
      <p className="mb-3 text-sm text-[var(--color-text-tertiary)]">控制文字任务、图片理解和语音转写是否可以向受管远程服务提交必要内容。</p>
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-[var(--color-text-primary)]">
              {!status?.available ? '安装身份不可用' : status.active ? '已允许' : '未允许'}
            </div>
            <div className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">
              {status?.active ? `确认时间：${new Date(status.receipt!.granted_at).toLocaleString()}` : '未允许时，远程能力会在发送前停止。'}
            </div>
          </div>
          <Button
            variant={status?.active ? 'secondary' : 'primary'}
            onClick={() => void change()}
            disabled={working || !status?.available}
          >
            {working ? '正在保存…' : status?.active ? '撤销允许' : '同意并启用'}
          </Button>
        </div>
        {!status?.active && status?.available && (
          <div className="mt-3 text-xs leading-5 text-[var(--color-text-tertiary)]">
            <p>用途：{status.disclosure.purpose}</p>
            <p>会发送：{status.disclosure.data.join('、')}。可能产生服务费用，可随时撤销。</p>
            <ul className="mt-1 space-y-1 pl-4 list-disc">
              {status.disclosure.receivers.map(receiver => (
                <li key={receiver.capability}>{receiver.provider} · {receiver.region}：{receiver.retention}</li>
              ))}
            </ul>
          </div>
        )}
        {error && <p role="alert" className="mt-2 text-xs text-[var(--color-error)]">{error}</p>}
      </div>
    </section>
  )
}
