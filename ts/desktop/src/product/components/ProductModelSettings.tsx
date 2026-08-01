import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type {
  PersonalModelConfigurationSummary,
  PersonalModelProfileInput,
  PersonalModelProfileSummary,
  PersonalModelProtocol,
} from '../../../../shared/product/personalModels'
import { getDesktopHost } from '../../lib/desktopHost'
import { Button } from '../../components/shared/Button'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import { Input } from '../../components/shared/Input'

type ModelForm = {
  id?: string
  label: string
  base_url: string
  model: string
  api_key: string
  protocol: PersonalModelProtocol
  supports_tool_calls: boolean
}

const EMPTY_FORM: ModelForm = {
  label: '',
  base_url: 'https://api.openai.com/v1',
  model: '',
  api_key: '',
  protocol: 'openai-compatible',
  supports_tool_calls: true,
}

function formFromProfile(profile: PersonalModelProfileSummary): ModelForm {
  return {
    id: profile.id,
    label: profile.label,
    base_url: profile.base_url,
    model: profile.model,
    api_key: '',
    protocol: profile.protocol,
    supports_tool_calls: profile.supports_tool_calls,
  }
}

function errorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  if (code.includes('PERSONAL_MODEL_BASE_URL')) return '接口地址必须是 HTTPS 地址，且不能在地址中携带密钥。'
  if (code.includes('PERSONAL_MODEL_PROFILE') || code.includes('Invalid Electron IPC')) return '请检查名称、模型、接口地址和密钥。新模型的密钥至少需要 8 个字符。'
  if (code.includes('PERSONAL_MODEL_TOOL_CALLS_REQUIRED')) return '任务助手默认模型必须支持工具调用。'
  return '模型设置暂时无法保存，请稍后重试。'
}

/**
 * Agent routing belongs to the desktop trust boundary. This screen deliberately
 * exposes profile summaries only: stored keys can be replaced, never read back.
 */
export function ProductModelSettings() {
  const host = getDesktopHost()
  const [configuration, setConfiguration] = useState<PersonalModelConfigurationSummary | null>(null)
  const [form, setForm] = useState<ModelForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<PersonalModelProfileSummary | null>(null)

  const refresh = useCallback(async () => {
    if (!host.capabilities.modelConfiguration) return
    setLoading(true)
    try {
      setConfiguration(await host.models.summary())
      setError(null)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [host])

  useEffect(() => { void refresh() }, [refresh])

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!host.capabilities.modelConfiguration || saving) return
    setSaving(true)
    setError(null)
    const input: PersonalModelProfileInput = {
      ...(form.id ? { id: form.id } : {}),
      label: form.label,
      base_url: form.base_url,
      model: form.model,
      api_key: form.api_key,
      protocol: form.protocol,
      capabilities: ['TextReasoning'],
      supports_tool_calls: form.supports_tool_calls,
    }
    try {
      setConfiguration(await host.models.save(input))
      setForm(EMPTY_FORM)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSaving(false)
    }
  }

  const setAgentRoute = async (profileId: string | null) => {
    if (!host.capabilities.modelConfiguration) return
    setSaving(true)
    setError(null)
    try {
      setConfiguration(await host.models.setRoute('TextReasoning', profileId))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    const profile = removing
    if (!profile || !host.capabilities.modelConfiguration) return
    setSaving(true)
    setError(null)
    try {
      setConfiguration(await host.models.remove(profile.id))
      if (form.id === profile.id) setForm(EMPTY_FORM)
      setRemoving(null)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSaving(false)
    }
  }

  if (!host.capabilities.modelConfiguration) {
    return <p className="text-sm leading-6 text-[var(--color-text-secondary)]">模型密钥只能在 BilliardBuddy 桌面应用中配置。</p>
  }

  const agentRoute = configuration?.routes.TextReasoning ?? null
  return (
    <section className="max-w-2xl" data-testid="product-model-settings">
      <p className="mb-5 text-sm leading-6 text-[var(--color-text-tertiary)]">
        默认使用 BilliardBuddy 托管模型：模型选择和额度由服务器控制。只有你主动把下方个人模型设为任务助手后，请求才会使用你的 API Key 直连供应商，不经过 BilliardBuddy 服务器，也不计入托管额度。密钥只存放在桌面主进程的受保护存储中，不会显示给页面、任务记录或 Agent Worker。
      </p>
      {error ? <p role="alert" className="mb-4 rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 px-4 py-3 text-sm text-[var(--color-error)]">{error}</p> : null}
      {loading ? <p role="status" className="text-sm text-[var(--color-text-secondary)]">正在读取模型配置…</p> : null}
      {configuration ? (
        <div className="mb-6 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">已配置模型</h2>
            {agentRoute ? <Button size="sm" variant="secondary" disabled={saving} onClick={() => { void setAgentRoute(null) }}>使用 BilliardBuddy 托管模型</Button> : <span className="text-xs text-[var(--color-text-tertiary)]">当前由服务器管理模型与额度</span>}
          </div>
          {configuration.profiles.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-4 text-sm text-[var(--color-text-secondary)]">尚未配置个人模型。当前任务助手使用 BilliardBuddy 托管模型；如需自行承担供应商费用，可在下方添加自己的兼容模型服务。</p>
          ) : configuration.profiles.map(profile => {
            const isAgentRoute = agentRoute === profile.id
            return (
              <article key={profile.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{profile.label}</h3>
                    <p className="mt-1 break-all text-xs text-[var(--color-text-tertiary)]">{profile.model} · {profile.protocol}</p>
                    <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">{profile.supports_tool_calls ? '支持 Agent 工具调用' : '不支持 Agent 工具调用'}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" disabled={saving} onClick={() => setForm(formFromProfile(profile))}>编辑</Button>
                    {!isAgentRoute ? <Button size="sm" disabled={saving || !profile.supports_tool_calls} onClick={() => { void setAgentRoute(profile.id) }}>使用个人 Key 直连</Button> : <span className="rounded-md bg-[var(--color-primary)]/10 px-2 py-1 text-xs font-medium text-[var(--color-primary)]">个人 Key 直连中</span>}
                    <Button size="sm" variant="danger" disabled={saving} onClick={() => setRemoving(profile)}>移除</Button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      ) : null}
      <form className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4" onSubmit={save}>
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">{form.id ? '编辑模型' : '添加模型'}</h2>
        <p className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">{form.id ? '留空密钥即可保留当前密钥；保存后只更新后续任务，不会中断正在运行的任务。' : '保存不会发起模型请求或产生调用费用。'}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Input label="名称" required value={form.label} maxLength={80} onChange={event => setForm(current => ({ ...current, label: event.target.value }))} placeholder="我的 Agent 模型" />
          <Input label="模型 ID" required value={form.model} maxLength={200} onChange={event => setForm(current => ({ ...current, model: event.target.value }))} placeholder="gpt-5" />
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-[var(--color-text-primary)]" htmlFor="personal-model-protocol">接口协议</label>
            <select id="personal-model-protocol" value={form.protocol} onChange={event => setForm(current => ({ ...current, protocol: event.target.value as PersonalModelProtocol }))} className="h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)] outline-none">
              <option value="openai-compatible">OpenAI 兼容（Chat Completions）</option>
              <option value="openai-responses">OpenAI Responses</option>
              <option value="anthropic-messages">Anthropic Messages</option>
            </select>
          </div>
          <Input label={form.id ? '替换密钥（可选）' : 'API 密钥'} required={!form.id} type="password" autoComplete="off" value={form.api_key} maxLength={4096} onChange={event => setForm(current => ({ ...current, api_key: event.target.value }))} placeholder={form.id ? '留空则保留当前密钥' : '仅保存到本机受保护存储'} />
        </div>
        <div className="mt-3"><Input label="服务地址" required type="url" value={form.base_url} maxLength={2048} onChange={event => setForm(current => ({ ...current, base_url: event.target.value }))} placeholder="https://api.example.com/v1" /></div>
        <label className="mt-4 flex items-center gap-2 text-sm text-[var(--color-text-secondary)]"><input type="checkbox" checked={form.supports_tool_calls} onChange={event => setForm(current => ({ ...current, supports_tool_calls: event.target.checked }))} /> 此模型支持工具调用（任务助手需要）</label>
        <div className="mt-4 flex gap-2"><Button type="submit" loading={saving}>{form.id ? '保存模型' : '添加模型'}</Button>{form.id ? <Button type="button" variant="secondary" disabled={saving} onClick={() => setForm(EMPTY_FORM)}>取消编辑</Button> : null}</div>
      </form>
      <ConfirmDialog open={removing !== null} title="移除模型配置" body={removing ? `移除“${removing.label}”后，本机保存的密钥也会被删除。` : ''} confirmLabel="移除" cancelLabel="取消" confirmVariant="danger" loading={saving} onConfirm={() => { void remove() }} onClose={() => setRemoving(null)} />
    </section>
  )
}
