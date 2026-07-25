import { useEffect, useState } from 'react'
import type { RecruitingBrowserSetupStatus } from '../../../shared/product/browserCapability'
import { getDesktopHost } from '../lib/desktopHost'

function statusLabel(status: RecruitingBrowserSetupStatus | null): string {
  if (!status) return '正在检查…'
  if (!status.extension_available) return '当前安装包缺少招聘浏览器扩展'
  if (!status.native_host_installed) return '需要完成本机连接安装'
  if (status.state === 'connected') return `已连接 ${status.connected_sessions} 个招聘页面`
  if (status.state === 'waiting_for_extension') return '本机连接已就绪，等待 Chrome 扩展连接页面'
  return '招聘浏览器连接暂不可用'
}

export function RecruitingBrowserSettings() {
  const host = getDesktopHost()
  const [status, setStatus] = useState<RecruitingBrowserSetupStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    if (!host.capabilities.recruitingBrowser) return
    try {
      setStatus(await host.recruitingBrowser.status())
      setError(null)
    } catch {
      setError('暂时无法读取招聘浏览器状态。')
    }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 3000)
    return () => window.clearInterval(timer)
  }, [])

  const install = async () => {
    setBusy(true)
    try {
      setStatus(await host.recruitingBrowser.install())
      setError(null)
    } catch {
      setError('本机连接安装失败，请确认当前安装包完整后重试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-5" data-testid="recruiting-browser-settings">
      <div>
        <h2 className="text-base font-semibold text-[var(--color-text-primary)]">招聘浏览器</h2>
        <p className="mt-1 text-sm leading-6 text-[var(--color-text-secondary)]">
          只读取你主动连接的 BOSS 直聘页面中的岗位相关信息。扩展不申请 Cookie、截图或桌面控制权限；发送消息、邀约和拒绝仍需在 BilliardBuddy 中逐次确认。
        </p>
      </div>

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <p role="status" className="text-sm font-medium text-[var(--color-text-primary)]">{statusLabel(status)}</p>
        {error ? <p role="alert" className="mt-2 text-sm text-[var(--color-error)]">{error}</p> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" disabled={busy || !host.capabilities.recruitingBrowser} onClick={() => { void install() }} className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? '正在安装…' : status?.native_host_installed ? '重新安装本机连接' : '安装本机连接'}
          </button>
          {status?.extension_available ? (
            <button type="button" onClick={() => { void host.shell.openPath(status.extension_path) }} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)]">
              打开扩展目录
            </button>
          ) : null}
        </div>
      </div>

      <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-[var(--color-text-secondary)]">
        <li>安装本机连接，然后打开 Chrome 的扩展管理页并开启“开发者模式”。</li>
        <li>选择“加载已解压的扩展程序”，使用上方按钮打开的目录。</li>
        <li>进入 BOSS 直聘候选人页面，点击 BilliardBuddy 招聘助手图标；徽标显示 ON 后才会连接当前页面。</li>
      </ol>
    </section>
  )
}
