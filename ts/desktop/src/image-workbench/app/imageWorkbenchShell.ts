import type {
  AddImageWorkflowReferencesInput,
  ApplyImageBriefOverridesInput,
  CreateImageBrandKitInput,
  CreateImageCampaignInput,
  CreateImageTemplateInput,
  ImageAssetGrant,
  ImageBrandKit,
  ImageCampaign,
  ImageCampaignEstimate,
  ImageCampaignResponse,
  ImageProjectLibrary,
  ImageQuickCreateInput,
  ImageTemplate,
  ImageTemplateResponse,
  ImageWorkbenchProjectListResponse,
  PromoteImageInspirationItemInput,
  ReviseImageBrandKitInput,
  ReviseImageTemplateInput,
  UpsertImageInspirationItemsInput,
} from '../../../../shared/contracts/imageWorkflow.js'
import type {
  CreateCreativePlanInput,
  CreateGenerationRoundInput,
  DecideImageCandidateInput,
  DeriveImageCandidateInput,
  ImageCanvasCommandRequestInput,
  ImageCanvasLayer,
  ImageCanvasPreflightInput,
  ImageCanvasRenderInput,
  ImageDeliverySpecRevisionInput,
  ImageDerivationEstimateResponse,
  EstimateGenerationRoundInput,
  ImageGenerationRoundEstimateResponse,
  ImageExportInput,
  UpdateImageReferenceControlInput,
} from '../../../../shared/contracts/imageGeneration.js'
import {
  type ImageBrandKitRevisionCommand,
  type ImageBriefOverrideCommand,
  type ImageCampaignCancelCommand,
  type ImageCampaignConfirmCommand,
  type ImageCampaignEstimateCommand,
  type ImageCampaignRetryConfirmCommand,
  type ImageCampaignRetryItemCommand,
  type ImageCampaignStartCommand,
  type ImageCandidateAdoptionCommand,
  type ImageCandidateDecisionCommand,
  type ImageCandidateDerivationCommand,
  type ImageCanvasCommand,
  type ImageCanvasPreflightCommand,
  type ImageCanvasRenderCommand,
  type ImageDeliverySpecCommand,
  type ImageExportCommand,
  type ImageGenerationRoundEstimateCommand,
  type ImageInspirationPromoteCommand,
  type ImageInspirationUpsertCommand,
  type ImageReferenceControlCommand,
  type ImageReusableDeleteCommand,
  type ImageTemplateRevisionCommand,
  type ImageWorkbenchClient,
  type ImageWorkbenchClientResult,
  type ImageWorkbenchProjectProjection,
  unwrapImageWorkbenchClientResult,
} from '../api/imageWorkbenchClient.js'
import {
  createImageWorkbenchViewState,
  imageWorkbenchSelectionIndex,
  planImageWorkbenchRestore,
  readImageWorkbenchViewState,
  reconcileImageWorkbenchViewState,
  reduceImageWorkbenchViewState,
  type ImageWorkbenchPanel,
  type ImageWorkbenchViewAction,
  type ImageWorkbenchViewState,
  type ImageWorkbenchViewStateStorage,
  writeImageWorkbenchViewState,
} from '../state/imageWorkbenchViewState.js'

type IdempotencyKeyFactory = () => string

type ImagePaidQuote = Pick<ImageGenerationRoundEstimateResponse,
  'estimate_hash' | 'paid_operation_count' | 'candidate_count_per_operation' | 'concurrency' | 'price_upper_bound' | 'expires_at'>

type ImageGenerationQuote = ImagePaidQuote & {
  project_id: string
  creative_plan_id: string
  direction_ids: readonly string[]
  project_revision: number
}

type ImageDerivationQuote = Pick<ImageDerivationEstimateResponse,
  'estimate_hash' | 'paid_operation_count' | 'candidate_count_per_operation' | 'concurrency' | 'price_upper_bound' | 'expires_at'> & {
  project_id: string
  candidate_id: string
  project_revision: number
  instruction: string
  kind: 'edit' | 'inpaint'
  mask_data_url?: string
}

type ImageCampaignQuote = {
  campaign_id: string
  item_id?: string
  estimate: ImageCampaignEstimate
}

export type ImageWorkbenchShellOptions = {
  root: HTMLElement
  client: ImageWorkbenchClient
  view_state_storage?: ImageWorkbenchViewStateStorage
  idempotency_key_factory?: IdempotencyKeyFactory
}

export type ImageWorkbenchShellSnapshot = {
  view_state: ImageWorkbenchViewState
  projection?: ImageWorkbenchProjectProjection
  campaigns: readonly ImageCampaign[]
  projects?: readonly ImageWorkbenchProjectListResponse['projects'][number][]
  candidate_previews?: Readonly<Record<string, string>>
  campaign_details?: readonly ImageCampaignResponse[]
  campaign_next_cursor?: number
  campaign_quotes?: readonly ImageCampaignQuote[]
  campaign_retry_receipts?: readonly { campaign_id: string; item_id: string; confirmation_receipt_id: string; estimate_hash: string }[]
  generation_quote?: ImageGenerationQuote
  derivation_quote?: ImageDerivationQuote
  brand_kits?: readonly ImageBrandKit[]
  templates?: readonly ImageTemplate[]
  asset_grants?: readonly ImageAssetGrant[]
  notice?: string
}

function defaultIdempotencyKey(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`
  return `image_ui_${random}`
}

function escapeHtml(value: string | number | undefined): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

const MAX_CANDIDATE_PREVIEW_DATA_URL_CHARS = Math.ceil(8 * 1024 * 1024 * 4 / 3) + 128
const MAX_CANDIDATE_PREVIEWS_PER_REFRESH = 12
const MAX_CANDIDATE_PREVIEW_CONCURRENCY = 3
const MAX_CANDIDATE_PREVIEW_CACHE_CHARS = MAX_CANDIDATE_PREVIEW_DATA_URL_CHARS * 3
const IMAGE_WORKBENCH_EVENT_PAGE_LIMIT = 200
const IMAGE_WORKBENCH_EVENT_WAIT_MS = 25_000
const IMAGE_WORKBENCH_EVENT_RETRY_MS = 1_000

const QUICK_CREATE_REFERENCE_ROLES = [
  'subject',
  'product',
  'character',
  'style',
  'composition',
  'environment',
  'brand',
  'logo',
  'qrcode',
] as const

const QUICK_CREATE_REFERENCE_ROLE_LABELS: Record<(typeof QUICK_CREATE_REFERENCE_ROLES)[number], string> = {
  subject: '主体',
  product: '产品',
  character: '人物',
  style: '风格',
  composition: '构图',
  environment: '环境',
  brand: '品牌',
  logo: 'Logo',
  qrcode: '二维码',
}

const QUICK_CREATE_REFERENCE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

type QuickCreateReferenceRole = (typeof QUICK_CREATE_REFERENCE_ROLES)[number]

function isQuickCreateReferenceRole(value: string | undefined): value is QuickCreateReferenceRole {
  return value !== undefined && QUICK_CREATE_REFERENCE_ROLES.includes(value as QuickCreateReferenceRole)
}

function safeCandidatePreviewDataUrl(value: string | undefined): string | undefined {
  if (!value || value.length > MAX_CANDIDATE_PREVIEW_DATA_URL_CHARS) return undefined
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value) ? value : undefined
}

function quoteIsActive(quote: { expires_at: string }, projectId: string, revision: number, quoteProjectId: string, quoteRevision: number): boolean {
  const expiresAt = Date.parse(quote.expires_at)
  return quoteProjectId === projectId
    && quoteRevision === revision
    && Number.isFinite(expiresAt)
    && expiresAt > Date.now()
}

function renderPaidQuote(quote: ImagePaidQuote): string {
  const price = quote.price_upper_bound
  return `<dl class="image-workbench-quote" data-paid-operation-count="${quote.paid_operation_count}">
    <div><dt>付费操作</dt><dd>${quote.paid_operation_count}</dd></div>
    <div><dt>候选数量</dt><dd>${quote.candidate_count_per_operation} / 操作</dd></div>
    <div><dt>并发</dt><dd>${quote.concurrency}</dd></div>
    <div><dt>成本上界</dt><dd>${escapeHtml(price.currency)} ${price.amount_minor}</dd></div>
    <div><dt>有效至</dt><dd>${escapeHtml(quote.expires_at)}</dd></div>
  </dl>`
}

function campaignQuoteIsActive(quote: ImageCampaignQuote, campaign: ImageCampaign): boolean {
  const expiresAt = Date.parse(quote.estimate.expires_at)
  return quote.campaign_id === campaign.id
    && quote.estimate.campaign_revision === campaign.revision
    && Number.isFinite(expiresAt)
    && expiresAt > Date.now()
}

function renderCampaignQuote(quote: ImageCampaignQuote): string {
  const estimate = quote.estimate
  return `<dl class="image-workbench-quote" data-campaign-estimate-hash="${escapeHtml(estimate.estimate_hash)}">
    <div><dt>付费操作</dt><dd>${estimate.paid_operation_count}</dd></div>
    <div><dt>并发</dt><dd>${estimate.concurrency}</dd></div>
    <div><dt>成本上界</dt><dd>${escapeHtml(estimate.price_upper_bound.currency)} ${estimate.price_upper_bound.amount_minor}</dd></div>
    <div><dt>有效至</dt><dd>${escapeHtml(estimate.expires_at)}</dd></div>
  </dl>`
}

function panelLabel(panel: ImageWorkbenchPanel): string {
  const labels: Record<ImageWorkbenchPanel, string> = {
    'quick-create': '快速创建',
    'creative-intake': '创作输入',
    'inspiration-board': '灵感板',
    'reference-tray': '参考图',
    'candidate-review': '候选审核',
    'canvas-editor': '画布',
    'delivery-panel': '交付',
    'project-library': '项目素材库',
    campaign: '批量制作',
    'operation-center': '操作中心',
  }
  return labels[panel]
}

function operationLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: '排队中',
    running: '生成中',
    cancelling: '取消中',
    committing: '提交结果中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
    blocked_by_policy: '策略拒绝',
    outcome_unknown: '结果待确认',
  }
  return labels[status] ?? status
}

function canvasTextLayers(layers: readonly ImageCanvasLayer[]): Array<Extract<ImageCanvasLayer, { kind: 'text' }>> {
  return layers.flatMap(layer => layer.kind === 'group'
    ? canvasTextLayers(layer.children)
    : layer.kind === 'text' ? [layer] : [])
}

function renderCreativeIntake(
  projection: ImageWorkbenchProjectProjection | undefined,
  generationQuote: ImageGenerationQuote | undefined,
  brandKits: readonly ImageBrandKit[],
  templates: readonly ImageTemplate[],
  assetGrants: readonly ImageAssetGrant[],
): string {
  const project = projection?.project
  const plans = projection?.creative_plans ?? []
  const planOptions = plans.map(plan => `<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.directions.map(direction => direction.label).join(' / '))}</option>`).join('')
  const quoteForCurrentProject = project && generationQuote
    && quoteIsActive(generationQuote, project.id, project.revision, generationQuote.project_id, generationQuote.project_revision)
    ? generationQuote
    : undefined
  const brandRows = brandKits.length === 0
    ? '<p class="image-workbench-empty">尚未创建品牌包</p>'
    : `<ul>${brandKits.map(brand => `<li data-brand-kit-id="${escapeHtml(brand.id)}"><span>${escapeHtml(brand.name)}</span><small>r${brand.revision}</small><button type="button" data-action="trash-brand-kit" data-brand-kit-id="${escapeHtml(brand.id)}">移入回收站</button></li>`).join('')}</ul>`
  const templateRows = templates.length === 0
    ? '<p class="image-workbench-empty">尚未创建模板</p>'
    : `<ul>${templates.map(template => `<li data-template-id="${escapeHtml(template.id)}"><span>${escapeHtml(template.name)}</span><small>r${template.revision}</small><button type="button" data-action="trash-template" data-template-id="${escapeHtml(template.id)}">移入回收站</button></li>`).join('')}</ul>`
  const brandOptions = `<option value="">选择品牌包</option>${brandKits.map(brand => `<option value="${escapeHtml(brand.id)}">${escapeHtml(brand.name)} r${brand.revision}</option>`).join('')}`
  const templateOptions = `<option value="">选择模板</option>${templates.map(template => `<option value="${escapeHtml(template.id)}">${escapeHtml(template.name)} r${template.revision}</option>`).join('')}`
  const assetOptions = (projection?.library?.entries ?? []).map(entry => `<option value="${escapeHtml(entry.asset_id)}">${escapeHtml(entry.asset_id)} (${escapeHtml(entry.origin)})</option>`).join('')
  const assetTargets = [
    ...brandKits.map(brand => `<option value="brand_kit:${escapeHtml(brand.id)}">品牌包: ${escapeHtml(brand.name)}</option>`),
    ...templates.map(template => `<option value="template:${escapeHtml(template.id)}">模板: ${escapeHtml(template.name)}</option>`),
  ].join('')
  const activeGrants = assetGrants.filter(grant => !grant.revoked_at)
  const grantRows = activeGrants.length === 0
    ? '<p class="image-workbench-empty">没有可撤销的有效素材授权</p>'
    : `<ul>${activeGrants.map(grant => `<li data-asset-grant-id="${escapeHtml(grant.id)}"><span>${escapeHtml(grant.asset_id)}</span><small>${escapeHtml(grant.to_owner.kind)}:${escapeHtml(grant.to_owner.id)} / ${escapeHtml(grant.purpose)}</small><button type="button" data-action="revoke-asset-grant" data-grant-id="${escapeHtml(grant.id)}">撤销授权</button></li>`).join('')}</ul>`
  return `<section class="image-workbench-section" data-feature="creative-intake" data-panel-content="creative-intake">
    <header><h2>创作输入</h2><button type="button" data-action="compile-brief">刷新 Brief</button></header>
    <form data-brief-overrides-form>
      <textarea data-brief-confirmed-facts aria-label="已确认事实" placeholder="每行一条已确认事实"></textarea>
      <textarea data-brief-must-preserve aria-label="必须保留" placeholder="每行一条必须保留内容"></textarea>
      <textarea data-brief-may-change aria-label="允许改变" placeholder="每行一条允许改变内容"></textarea>
      <textarea data-brief-exact-text aria-label="精确文字" placeholder="每行一条精确文字"></textarea>
      <button type="submit">应用 Brief</button>
    </form>
    <form data-create-plan-form>
      <button type="submit">创建创作方向</button>
    </form>
    ${plans.length > 0 ? `<form data-generation-estimate-form>
      <select data-generation-plan-id aria-label="创作方向">${planOptions}</select>
      <button type="submit">估算生成费用</button>
    </form>` : '<p class="image-workbench-empty">创建创作方向后可估算生成费用</p>'}
    ${quoteForCurrentProject ? `${renderPaidQuote(quoteForCurrentProject)}<form data-generation-confirm-form>
      <input type="hidden" data-generation-confirm-plan-id value="${escapeHtml(quoteForCurrentProject.creative_plan_id)}" />
      <button type="submit">确认并生成</button>
    </form>` : ''}
    <section class="image-workbench-subsection" data-feature="brand-template-manager">
      <header><h3>品牌包</h3></header>
      ${brandRows}
      <form data-brand-create-form>
        <input data-brand-name required maxlength="160" aria-label="品牌包名称" placeholder="品牌包名称" />
        <button type="submit">创建品牌包</button>
      </form>
      <form data-brand-revise-form>
        <select data-brand-revise-id aria-label="要修订的品牌包">${brandOptions}</select>
        <input data-brand-color-token required pattern="[a-z][a-z0-9_]{0,63}" value="primary" aria-label="颜色令牌" />
        <input data-brand-color-value required pattern="#[0-9A-Fa-f]{6}" value="#174c80" aria-label="颜色值" />
        <input data-brand-logo-asset-id list="image-workbench-assets" aria-label="品牌 Logo 素材标识" placeholder="Logo 素材标识（先授权）" />
        <button type="submit">新增品牌颜色</button>
      </form>
    </section>
    <section class="image-workbench-subsection" data-feature="template-manager">
      <header><h3>模板</h3></header>
      ${templateRows}
      <form data-template-create-form>
        <input data-template-name required maxlength="160" aria-label="模板名称" placeholder="模板名称" />
        <input data-template-width required type="number" min="1" max="12000" value="1024" aria-label="模板宽度" />
        <input data-template-height required type="number" min="1" max="12000" value="1024" aria-label="模板高度" />
        <select data-template-brand-kit-id aria-label="模板关联品牌包">${brandOptions}</select>
        <button type="submit">创建模板</button>
      </form>
      <form data-template-revise-form>
        <select data-template-revise-id aria-label="要修订的模板">${templateOptions}</select>
        <select data-template-layer-kind aria-label="模板可变层类型"><option value="text">文字</option><option value="qrcode">二维码</option><option value="logo">Logo</option></select>
        <input data-template-text maxlength="2000" aria-label="模板文字或二维码占位值" placeholder="文字或二维码占位值" />
        <input data-template-slot-id maxlength="120" pattern="[A-Za-z0-9_-]+" aria-label="模板 Slot 标识" placeholder="Slot 标识（可选）" />
        <label><input data-template-slot-required type="checkbox" /> 此 Slot 必填</label>
        <input data-template-logo-asset-id list="image-workbench-assets" aria-label="模板 Logo 素材标识" placeholder="Logo 素材标识（可选）" />
        <button type="submit">追加模板层</button>
      </form>
    </section>
    ${assetTargets || activeGrants.length > 0 ? `<section class="image-workbench-subsection" data-feature="reusable-asset-grants">
      <header><h3>授权复用素材</h3></header>
      ${assetTargets ? `<form data-reusable-asset-grant-form>
        <input data-grant-asset-id list="image-workbench-assets" required aria-label="要授权的素材标识" placeholder="素材标识" />
        <select data-grant-target required aria-label="授权目标">${assetTargets}</select>
        <select data-grant-purpose aria-label="授权用途"><option value="template_use">品牌或模板使用</option></select>
        <button type="submit">授权素材</button>
      </form>` : ''}
      <div data-asset-grant-list>${grantRows}</div>
    </section>` : ''}
    ${assetOptions ? `<datalist id="image-workbench-assets">${assetOptions}</datalist>` : ''}
  </section>`
}

function renderInspirationBoard(projection: ImageWorkbenchProjectProjection | undefined): string {
  const board = projection?.inspiration_board
  const items = board?.items ?? []
  const rows = items.length === 0
    ? '<p class="image-workbench-empty">上传灵感图后可选择性提升为项目参考图</p>'
    : `<ul>${items.map(item => `<li data-inspiration-item-id="${escapeHtml(item.id)}"><span>${escapeHtml(item.note ?? item.asset_id)}</span>${item.promoted_reference_asset_id
      ? '<small>已提升为参考图</small>'
      : `<form data-inspiration-promote-form data-inspiration-id="${escapeHtml(item.id)}"><select data-inspiration-role aria-label="灵感图角色"><option value="style">风格</option><option value="product">产品</option><option value="composition">构图</option><option value="brand">品牌</option><option value="logo">标志</option></select><select data-inspiration-influence aria-label="灵感图影响强度"><option value="low">低影响</option><option value="medium" selected>中影响</option><option value="high">高影响</option></select><select data-inspiration-preservation aria-label="灵感图保留程度"><option value="may_change">允许改变</option><option value="prefer_preserve" selected>优先保留</option><option value="must_preserve">必须保留</option></select><input data-inspiration-priority type="number" min="0" max="1000" value="100" aria-label="灵感图优先级" /><button type="submit">提升为参考图</button></form>`}</li>`).join('')}</ul>`
  return `<section class="image-workbench-section" data-feature="inspiration-board" data-panel-content="inspiration-board">
    <header><h2>灵感板</h2><span>${items.length}</span></header>
    ${rows}
    <form data-inspiration-upsert-form>
      <input data-inspiration-file type="file" accept="image/png,image/jpeg,image/webp" required aria-label="灵感图文件" />
      <input data-inspiration-note maxlength="2000" aria-label="灵感图备注" placeholder="备注（可选）" />
      <button type="submit">加入灵感板</button>
    </form>
  </section>`
}

function renderReferenceTray(projection: ImageWorkbenchProjectProjection | undefined): string {
  const references = projection?.project.references ?? []
  const rows = references.length === 0
    ? '<p class="image-workbench-empty">尚未指定参考图</p>'
    : references.map(reference => `
      <li data-reference-id="${escapeHtml(reference.asset_id)}">
        <span>${escapeHtml(reference.label ?? reference.role)}</span>
        <small>${escapeHtml(reference.role)} / ${escapeHtml(reference.influence_strength)} / ${escapeHtml(reference.preservation)}</small>
      </li>
    `).join('')
  return `<section class="image-workbench-section" data-feature="reference-tray" data-panel-content="reference-tray">
    <header><h2>参考图</h2><span>${references.length}</span></header>
    <ul>${rows}</ul>
    <form data-reference-form>
      <input data-reference-files type="file" accept="image/png,image/jpeg,image/webp" multiple aria-label="添加参考图" />
      <select data-reference-role aria-label="参考图角色">
        <option value="product">产品</option>
        <option value="style">风格</option>
        <option value="composition">构图</option>
        <option value="brand">品牌</option>
        <option value="logo">标志</option>
      </select>
      <select data-reference-influence aria-label="参考图影响强度"><option value="low">低影响</option><option value="medium" selected>中影响</option><option value="high">高影响</option></select>
      <select data-reference-preservation aria-label="参考图保留程度"><option value="may_change">允许改变</option><option value="prefer_preserve" selected>优先保留</option><option value="must_preserve">必须保留</option></select>
      <input data-reference-priority type="number" min="0" max="1000" value="100" aria-label="参考图优先级" />
      <button type="submit">加入参考图</button>
    </form>
    ${references.length > 0 ? `<form data-reference-control-form>
      <select data-reference-control-id aria-label="要更新的参考图">${references.map(reference => `<option value="${escapeHtml(reference.asset_id)}">${escapeHtml(reference.label ?? reference.role)}</option>`).join('')}</select>
      <select data-reference-control-role aria-label="更新后的参考图角色"><option value="product">产品</option><option value="style">风格</option><option value="composition">构图</option><option value="brand">品牌</option><option value="logo">标志</option></select>
      <select data-reference-control-influence aria-label="更新后的影响强度"><option value="low">低影响</option><option value="medium" selected>中影响</option><option value="high">高影响</option></select>
      <select data-reference-control-preservation aria-label="更新后的保留程度"><option value="may_change">允许改变</option><option value="prefer_preserve" selected>优先保留</option><option value="must_preserve">必须保留</option></select>
      <input data-reference-control-priority type="number" min="0" max="1000" value="100" aria-label="更新后的优先级" />
      <button type="submit">更新控制</button>
    </form>` : ''}
  </section>`
}

function renderCandidateReview(
  projection: ImageWorkbenchProjectProjection | undefined,
  selectedCandidateId: string | undefined,
  candidatePreviews: Readonly<Record<string, string>>,
  derivationQuote: ImageDerivationQuote | undefined,
): string {
  const candidates = projection?.candidate_groups.flatMap(group => group.candidates) ?? []
  const selected = candidates.find(candidate => candidate.id === selectedCandidateId) ?? candidates[0]
  const activeDerivationQuote = selected && projection && derivationQuote
    && derivationQuote.candidate_id === selected.id
    && quoteIsActive(derivationQuote, projection.project.id, projection.project.revision, derivationQuote.project_id, derivationQuote.project_revision)
    ? derivationQuote
    : undefined
  const artboards = projection?.delivery_spec?.artboards ?? []
  const artboardOptions = artboards.map(artboard =>
    `<option value="${escapeHtml(artboard.id)}">${escapeHtml(artboard.label)} (${artboard.width} x ${artboard.height})</option>`).join('')
  const cards = candidates.length === 0
    ? '<p class="image-workbench-empty">候选图将在任务完成后出现</p>'
    : candidates.map(candidate => {
      const preview = safeCandidatePreviewDataUrl(candidatePreviews[candidate.id])
      return `
      <button class="image-workbench-candidate${candidate.id === selectedCandidateId ? ' is-selected' : ''}" type="button" data-action="select-candidate" data-candidate-id="${escapeHtml(candidate.id)}">
        ${preview
          ? `<img src="${escapeHtml(preview)}" alt="候选 ${candidate.candidate_index + 1}" />`
          : '<span class="image-workbench-candidate-preview-unavailable" aria-label="候选预览暂不可用"></span>'}
        <span>候选 ${candidate.candidate_index + 1}</span>
      </button>
    `
    }).join('')
  return `<section class="image-workbench-section" data-feature="candidate-review" data-panel-content="candidate-review">
    <header><h2>候选审核</h2><span>${candidates.length}</span></header>
    <div class="image-workbench-candidates">${cards}</div>
    ${selected ? `<div class="image-workbench-command-row" data-selected-candidate-id="${escapeHtml(selected.id)}">
      <button type="button" data-action="keep-candidate" data-candidate-id="${escapeHtml(selected.id)}">保留</button>
      <button type="button" data-action="reject-candidate" data-candidate-id="${escapeHtml(selected.id)}">拒绝</button>
    </div>
    ${artboards.length > 0 ? `<form data-adopt-candidate-form data-candidate-id="${escapeHtml(selected.id)}">
      <select data-adopt-artboards multiple required aria-label="采纳到的交付画板">${artboardOptions}</select>
      <button type="submit">采纳到所选画布</button>
    </form>` : '<p class="image-workbench-empty">先创建交付规格，再把候选采纳到画布。</p>'}
    <form data-derive-candidate-form data-candidate-id="${escapeHtml(selected.id)}">
      <input data-derive-instruction maxlength="4000" required aria-label="候选派生要求" placeholder="描述要修改的内容" />
      <select data-derive-kind aria-label="派生方式"><option value="edit">整体编辑</option><option value="inpaint">局部重绘</option></select>
      <input data-derive-mask type="file" accept="image/png" aria-label="局部重绘 PNG 蒙版" />
      <button type="submit">估算派生费用</button>
    </form>
    ${activeDerivationQuote ? `${renderPaidQuote(activeDerivationQuote)}<button type="button" data-action="confirm-derive-candidate" data-candidate-id="${escapeHtml(selected.id)}">确认并派生</button>` : ''}` : ''}
  </section>`
}

function renderCanvasEditor(
  projection: ImageWorkbenchProjectProjection | undefined,
  state: ImageWorkbenchViewState,
  brandKits: readonly ImageBrandKit[],
  templates: readonly ImageTemplate[],
): string {
  const canvases = projection?.canvases ?? []
  const selectedCanvas = canvases.find(canvas => canvas.canvas_id === state.selected_canvas_id) ?? canvases[0]
  const textLayers = selectedCanvas ? canvasTextLayers(selectedCanvas.document.layers) : []
  const brandOptions = `<option value="">选择品牌包</option>${brandKits.map(brand => `<option value="${escapeHtml(brand.id)}">${escapeHtml(brand.name)} r${brand.revision}</option>`).join('')}`
  const templateOptions = `<option value="">选择模板</option>${templates.map(template => `<option value="${escapeHtml(template.id)}">${escapeHtml(template.name)} r${template.revision}</option>`).join('')}`
  const canvasRows = canvases.length === 0
    ? '<p class="image-workbench-empty">采纳候选后可创建画布</p>'
    : canvases.map(canvas => `
      <button type="button" class="image-workbench-list-button${canvas.canvas_id === state.selected_canvas_id ? ' is-selected' : ''}" data-action="select-canvas" data-canvas-id="${escapeHtml(canvas.canvas_id)}">
        <span>${escapeHtml(canvas.document.artboard_id)}</span><small>版本 ${canvas.revision}</small>
      </button>
    `).join('')
  return `<section class="image-workbench-section" data-feature="canvas-editor" data-panel-content="canvas-editor">
    <header><h2>画布</h2><span>${canvases.length}</span></header>
    <div class="image-workbench-list">${canvasRows}</div>
      ${selectedCanvas ? `<div class="image-workbench-command-row" data-selected-canvas-id="${escapeHtml(selectedCanvas.canvas_id)}">
        <button type="button" data-action="preflight-canvas" data-canvas-id="${escapeHtml(selectedCanvas.canvas_id)}">预检</button>
        <button type="button" data-action="render-canvas" data-canvas-id="${escapeHtml(selectedCanvas.canvas_id)}">渲染</button>
        <button type="button" data-action="fit-canvas-safe-area" data-canvas-id="${escapeHtml(selectedCanvas.canvas_id)}">适配交付安全区</button>
        ${projection?.campaign_intent?.template_id || projection?.campaign_intent?.brand_kit_id
          ? `<button type="button" data-action="apply-campaign-intent" data-canvas-id="${escapeHtml(selectedCanvas.canvas_id)}">应用 Campaign 模板</button>`
          : ''}
      </div>
      <form data-add-canvas-text-form data-canvas-id="${escapeHtml(selectedCanvas.canvas_id)}">
        <input data-canvas-text required maxlength="2000" aria-label="画布文字" placeholder="添加画布文字" />
        <input data-canvas-text-x required type="number" value="80" aria-label="文字横坐标" />
        <input data-canvas-text-y required type="number" value="80" aria-label="文字纵坐标" />
        <input data-canvas-text-size required type="number" min="1" max="1024" value="64" aria-label="文字字号" />
        <input data-canvas-text-fill required pattern="#[0-9A-Fa-f]{6}" value="#101820" aria-label="文字颜色" />
        <button type="submit">添加文字层</button>
      </form>
      ${brandKits.length > 0 ? `<form data-apply-brand-form data-canvas-id="${escapeHtml(selectedCanvas.canvas_id)}">
        <select data-apply-brand-id required aria-label="应用到画布的品牌包">${brandOptions}</select>
        <button type="submit">应用品牌包</button>
      </form>` : ''}
      ${templates.length > 0 ? `<form data-apply-template-form data-canvas-id="${escapeHtml(selectedCanvas.canvas_id)}">
        <select data-apply-template-id required aria-label="应用到画布的模板">${templateOptions}</select>
        <textarea data-apply-template-slots aria-label="模板 Slot 绑定" placeholder='Slot 绑定 JSON，例如 [{"slot_id":"title","text":"夏季联赛"}]'></textarea>
        <button type="submit">应用模板</button>
      </form>` : ''}
      ${textLayers.map(layer => `<form data-edit-canvas-text-form data-canvas-id="${escapeHtml(selectedCanvas.canvas_id)}" data-layer-id="${escapeHtml(layer.id)}">
        <input data-canvas-existing-text required maxlength="2000" value="${escapeHtml(layer.text)}" aria-label="编辑文字层" />
        <button type="submit">更新文字</button>
      </form>`).join('')}` : ''}
    </section>`
}

function renderDeliveryPanel(projection: ImageWorkbenchProjectProjection | undefined, state: ImageWorkbenchViewState): string {
  const artboards = projection?.delivery_spec?.artboards ?? []
  const artboardRows = artboards.length === 0
    ? '<p class="image-workbench-empty">尚未设置交付规格</p>'
    : artboards.map(artboard => `
      <button type="button" class="image-workbench-list-button${artboard.id === state.selected_artboard_id ? ' is-selected' : ''}" data-action="select-artboard" data-artboard-id="${escapeHtml(artboard.id)}">
        <span>${escapeHtml(artboard.label)}</span><small>${artboard.width} x ${artboard.height}</small>
      </button>
    `).join('')
  return `<section class="image-workbench-section" data-feature="delivery-panel" data-panel-content="delivery-panel">
    <header><h2>交付</h2><span>${artboards.length}</span></header>
    <div class="image-workbench-list">${artboardRows}</div>
    ${artboards.length > 0 ? '<div class="image-workbench-command-row"><button type="button" data-action="export-delivery">导出当前交付</button></div>' : ''}
    <form data-delivery-spec-form>
      <select data-delivery-purpose aria-label="交付用途"><option value="social_cover">社交封面</option><option value="product_marketing">产品营销</option><option value="poster">海报</option><option value="custom" selected>自定义</option></select>
      <input data-delivery-label required maxlength="120" value="正式交付" aria-label="画板名称" />
      <input data-delivery-width required type="number" min="1" max="12000" value="1024" aria-label="画板宽度" />
      <input data-delivery-height required type="number" min="1" max="12000" value="1024" aria-label="画板高度" />
      <select data-delivery-format aria-label="导出格式"><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select>
      <input data-delivery-safe-top type="number" min="0" placeholder="安全区上（可选）" aria-label="安全区上边距" />
      <input data-delivery-safe-right type="number" min="0" placeholder="安全区右（可选）" aria-label="安全区右边距" />
      <input data-delivery-safe-bottom type="number" min="0" placeholder="安全区下（可选）" aria-label="安全区下边距" />
      <input data-delivery-safe-left type="number" min="0" placeholder="安全区左（可选）" aria-label="安全区左边距" />
      <textarea data-delivery-artboards aria-label="额外画板" placeholder="额外画板 JSON 数组（可选）"></textarea>
      <button type="submit">新建交付规格</button>
    </form>
  </section>`
}

function renderOperationCenter(projection: ImageWorkbenchProjectProjection | undefined): string {
  const operations = projection?.operations ?? []
  const rows = operations.length === 0
    ? '<p class="image-workbench-empty">暂无操作</p>'
    : operations.map(operation => `
      <li>
        <span>${escapeHtml(operation.kind)}</span>
        <strong data-operation-status="${escapeHtml(operation.status)}">${escapeHtml(operationLabel(operation.status))}</strong>
        <small>${escapeHtml(operation.safe_error?.message)}</small>
        ${operation.status === 'queued'
          ? `<button type="button" data-action="cancel-operation" data-operation-id="${escapeHtml(operation.id)}">取消</button>`
          : ''}
      </li>
    `).join('')
  return `<section class="image-workbench-section" data-feature="operation-center" data-panel-content="operation-center">
    <header><h2>操作中心</h2><button type="button" data-action="refresh-project">刷新</button></header>
    <ul class="image-workbench-operations">${rows}</ul>
  </section>`
}

function renderLibrary(projection: ImageWorkbenchProjectProjection | undefined): string {
  const entries = projection?.library.entries ?? []
  const rows = entries.length === 0
    ? '<p class="image-workbench-empty">项目素材将显示在这里</p>'
    : entries.map(entry => `
      <li><span>${escapeHtml(entry.origin)}</span><small>${escapeHtml(entry.asset_id)}</small></li>
    `).join('')
  return `<section class="image-workbench-section" data-feature="project-library" data-panel-content="project-library">
    <header><h2>项目素材库</h2><span>${entries.length}</span></header>
    <ul>${rows}</ul>
    <form data-library-reuse-form>
      <input data-library-asset-id required aria-label="要复用的素材标识" placeholder="素材标识" />
      <button type="submit">加入当前画布</button>
    </form>
  </section>`
}

function campaignQuoteKey(campaignId: string, itemId?: string): string {
  return `${campaignId}:${itemId ?? 'start'}`
}

function renderCampaigns(
  campaigns: readonly ImageCampaign[],
  details: readonly ImageCampaignResponse[],
  nextCursor: number | undefined,
  quotes: readonly ImageCampaignQuote[],
  retryReceipts: readonly { campaign_id: string; item_id: string; confirmation_receipt_id: string; estimate_hash: string }[],
  brandKits: readonly ImageBrandKit[],
  templates: readonly ImageTemplate[],
): string {
  const detailById = new Map(details.map(detail => [detail.campaign.id, detail]))
  const quoteByKey = new Map(quotes.map(quote => [campaignQuoteKey(quote.campaign_id, quote.item_id), quote]))
  const receiptByKey = new Map(retryReceipts.map(receipt => [campaignQuoteKey(receipt.campaign_id, receipt.item_id), receipt]))
  const brandOptions = `<option value="">不使用独立品牌包</option>${brandKits.map(brand => `<option value="${escapeHtml(brand.id)}">${escapeHtml(brand.name)} r${brand.revision}</option>`).join('')}`
  const templateOptions = `<option value="">不使用模板</option>${templates.map(template => `<option value="${escapeHtml(template.id)}">${escapeHtml(template.name)} r${template.revision}</option>`).join('')}`
  const rows = campaigns.length === 0
    ? '<p class="image-workbench-empty">尚未创建批量制作</p>'
    : campaigns.map(campaign => {
      const detail = detailById.get(campaign.id)
      const startQuote = quoteByKey.get(campaignQuoteKey(campaign.id))
      const activeStartQuote = startQuote && campaignQuoteIsActive(startQuote, campaign) ? startQuote : undefined
      const startAction = campaign.state === 'draft'
        ? (activeStartQuote
            ? `<button type="button" data-action="confirm-campaign" data-campaign-id="${escapeHtml(campaign.id)}">确认报价</button>`
            : `<button type="button" data-action="estimate-campaign" data-campaign-id="${escapeHtml(campaign.id)}">报价</button>`)
        : campaign.state === 'confirmed'
          ? `<button type="button" data-action="start-campaign" data-campaign-id="${escapeHtml(campaign.id)}">开始</button>`
          : campaign.state === 'running'
            ? `<button type="button" data-action="cancel-campaign" data-campaign-id="${escapeHtml(campaign.id)}">取消未开始项目</button>`
            : ''
      const itemRows = detail?.items.map(item => {
        if (item.state !== 'failed' && item.state !== 'cancelled') return `<li><span>项目 ${item.ordinal + 1}</span><strong>${escapeHtml(item.state)}</strong></li>`
        const key = campaignQuoteKey(campaign.id, item.id)
        const quote = quoteByKey.get(key)
        const activeQuote = quote && campaignQuoteIsActive(quote, campaign) ? quote : undefined
        const receipt = receiptByKey.get(key)
        const retryAction = receipt
          ? `<button type="button" data-action="retry-campaign-item" data-campaign-id="${escapeHtml(campaign.id)}" data-item-id="${escapeHtml(item.id)}">创建新尝试</button>`
          : activeQuote
            ? `<button type="button" data-action="confirm-campaign-retry" data-campaign-id="${escapeHtml(campaign.id)}" data-item-id="${escapeHtml(item.id)}">确认重试报价</button>`
            : `<button type="button" data-action="estimate-campaign-retry" data-campaign-id="${escapeHtml(campaign.id)}" data-item-id="${escapeHtml(item.id)}">重试报价</button>`
        return `<li><span>项目 ${item.ordinal + 1}</span><strong>${escapeHtml(item.state)}</strong>${activeQuote ? renderCampaignQuote(activeQuote) : ''}${retryAction}</li>`
      }).join('') ?? ''
      return `<li class="image-workbench-campaign-row"><div><span>${escapeHtml(campaign.name)}</span><strong>${escapeHtml(campaign.state)}</strong><small>${campaign.planned_item_count} 项</small>${campaign.budget_limit ? `<small>预算 ${escapeHtml(campaign.budget_limit.currency)} ${campaign.budget_limit.amount_minor}</small>` : ''}${activeStartQuote ? renderCampaignQuote(activeStartQuote) : ''}${startAction}</div>${itemRows ? `<ul>${itemRows}</ul>` : ''}</li>`
    }).join('')
  return `<section class="image-workbench-section" data-feature="batch-production" data-panel-content="campaign">
    <header><h2>批量制作</h2><span>${campaigns.length}</span></header>
    <ul>${rows}</ul>
    ${nextCursor === undefined ? '' : '<button type="button" data-action="load-more-campaigns">加载更多 Campaign</button>'}
    <form data-campaign-create-form>
      <input data-campaign-name required maxlength="160" aria-label="Campaign 名称" placeholder="Campaign 名称" />
      <input data-campaign-request required maxlength="8000" aria-label="Campaign 共同创作需求" placeholder="共同创作需求" />
      <select data-campaign-preset aria-label="Campaign 输出规格"><option value="square">方形</option><option value="landscape">横版</option><option value="portrait">竖版</option></select>
      <select data-campaign-template-id aria-label="Campaign 模板">${templateOptions}</select>
      <select data-campaign-brand-kit-id aria-label="Campaign 品牌包">${brandOptions}</select>
      <input data-campaign-budget-currency maxlength="3" pattern="[A-Z]{3}" value="USD" aria-label="Campaign 预算币种" />
      <input data-campaign-budget-minor type="number" min="1" step="1" aria-label="Campaign 预算上限最小币种单位" placeholder="预算上限（最小币种单位，可选）" />
      <textarea data-campaign-items aria-label="Campaign 项目" placeholder='填写项目 JSON 数组，例如 [{"variable_values":[{"slot_id":"title","value":"夏季联赛"}]}]'></textarea>
      <button type="submit">创建 Campaign</button>
    </form>
  </section>`
}

function renderQuickCreatePanel(): string {
  const referenceRoles = QUICK_CREATE_REFERENCE_ROLES
    .map(role => `<option value="${role}">${QUICK_CREATE_REFERENCE_ROLE_LABELS[role]}</option>`)
    .join('')
  return `<section class="image-workbench-section" data-feature="quick-create" data-panel-content="quick-create">
    <header><h2>快速创建</h2></header>
    <form class="image-workbench-quick-form" data-quick-create-form>
      <input data-quick-prompt required maxlength="8000" placeholder="描述你要制作的图片" aria-label="图片描述" />
      <select data-quick-preset aria-label="输出规格"><option value="square">方形</option><option value="landscape">横版</option><option value="portrait">竖版</option><option value="auto">自动</option></select>
      <div class="image-workbench-quick-reference">
        <label>首轮参考图<input data-quick-reference-file type="file" accept="image/png,image/jpeg,image/webp" aria-label="首轮参考图" /></label>
        <label>参考角色<select data-quick-reference-role aria-label="首轮参考角色"><option value="">选择角色</option>${referenceRoles}</select></label>
      </div>
      <button type="submit">生成</button>
    </form>
  </section>`
}

function renderActivePanel(snapshot: ImageWorkbenchShellSnapshot): string {
  const { projection, view_state: state } = snapshot
  switch (state.active_panel) {
    case 'quick-create': return renderQuickCreatePanel()
    case 'creative-intake': return renderCreativeIntake(projection, snapshot.generation_quote, snapshot.brand_kits ?? [], snapshot.templates ?? [], snapshot.asset_grants ?? [])
    case 'inspiration-board': return renderInspirationBoard(projection)
    case 'reference-tray': return renderReferenceTray(projection)
    case 'candidate-review': return renderCandidateReview(projection, state.selected_candidate_id, snapshot.candidate_previews ?? {}, snapshot.derivation_quote)
    case 'canvas-editor': return renderCanvasEditor(projection, state, snapshot.brand_kits ?? [], snapshot.templates ?? [])
    case 'delivery-panel': return renderDeliveryPanel(projection, state)
    case 'project-library': return renderLibrary(projection)
    case 'campaign': return renderCampaigns(
      snapshot.campaigns,
      snapshot.campaign_details ?? [],
      snapshot.campaign_next_cursor,
      snapshot.campaign_quotes ?? [],
      snapshot.campaign_retry_receipts ?? [],
      snapshot.brand_kits ?? [],
      snapshot.templates ?? [],
    )
    case 'operation-center': return renderOperationCenter(projection)
  }
}

/** Pure render function, suitable for snapshot tests without an Electron runtime. */
export function renderImageWorkbenchShell(snapshot: ImageWorkbenchShellSnapshot): string {
  const { projection, view_state: state } = snapshot
  const activePanel = state.active_panel
  const projectTitle = projection?.project.title ?? projection?.project.id ?? '选择或创建项目'
  const panelButtons = (['quick-create', 'creative-intake', 'inspiration-board', 'reference-tray', 'candidate-review', 'canvas-editor', 'delivery-panel', 'project-library', 'campaign', 'operation-center'] as const)
    .map(panel => `<button type="button" class="${panel === activePanel ? 'is-active' : ''}" data-action="open-panel" data-panel="${panel}">${panelLabel(panel)}</button>`)
    .join('')
  const projectOptions = `<option value="">选择已有项目</option>${(snapshot.projects ?? []).map(project =>
    `<option value="${escapeHtml(project.id)}"${project.id === state.selected_project_id ? ' selected' : ''}>${escapeHtml(project.title ?? project.id)}</option>`).join('')}`
  return `<div class="image-workbench-shell">
    <style>
      .image-workbench-shell { color: #17202a; background: #f7f8fa; min-height: 100%; font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
      .image-workbench-shell * { box-sizing: border-box; }
      .image-workbench-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; background: #ffffff; border-bottom: 1px solid #dfe3e8; }
      .image-workbench-header h1 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: 0; }
      .image-workbench-layout { display: grid; grid-template-columns: 172px minmax(0, 1fr); min-height: calc(100vh - 58px); }
      .image-workbench-nav { padding: 12px; border-right: 1px solid #dfe3e8; background: #ffffff; display: grid; align-content: start; gap: 4px; }
      .image-workbench-nav button, .image-workbench-list-button, .image-workbench-candidate { appearance: none; border: 1px solid transparent; background: transparent; color: inherit; text-align: left; cursor: pointer; border-radius: 6px; }
      .image-workbench-nav button { padding: 8px 10px; white-space: nowrap; }
      .image-workbench-nav button:hover, .image-workbench-nav .is-active { background: #e7f0ff; border-color: #a9c7f3; }
      .image-workbench-main { padding: 18px; display: grid; gap: 14px; align-content: start; }
      .image-workbench-project { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
      .image-workbench-project h2 { font-size: 18px; margin: 0; overflow-wrap: anywhere; }
      .image-workbench-section { background: #ffffff; border: 1px solid #dfe3e8; border-radius: 6px; padding: 14px; }
      .image-workbench-section header { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 10px; }
      .image-workbench-section h2 { font-size: 14px; margin: 0; }
      .image-workbench-section ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 7px; }
      .image-workbench-section li { display: flex; align-items: baseline; gap: 9px; min-width: 0; }
      .image-workbench-section li small { overflow-wrap: anywhere; color: #59636e; }
      .image-workbench-empty { color: #68737d; margin: 0; }
      .image-workbench-section form.image-workbench-quick-form { display: grid; grid-template-columns: minmax(0, 1fr) 128px auto; gap: 8px; }
      .image-workbench-quick-reference { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 1fr) minmax(160px, 220px); gap: 8px; }
      .image-workbench-quick-reference label { display: grid; gap: 4px; min-width: 0; }
      .image-workbench-quick-form input, .image-workbench-quick-form select, .image-workbench-section form input, .image-workbench-section form select, .image-workbench-section form textarea { min-width: 0; border: 1px solid #b9c1c9; border-radius: 4px; padding: 8px; background: #fff; color: inherit; }
      .image-workbench-section button, .image-workbench-quick-form button { border: 1px solid #1966c2; border-radius: 4px; padding: 7px 10px; background: #1966c2; color: #fff; cursor: pointer; }
      .image-workbench-section form { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
      .image-workbench-section form textarea { min-height: 72px; flex: 1 1 200px; resize: vertical; }
      .image-workbench-subsection { margin-top: 14px; padding-top: 14px; border-top: 1px solid #dfe3e8; }
      .image-workbench-subsection h3 { margin: 0; font-size: 13px; }
      .image-workbench-candidates { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 9px; }
      .image-workbench-candidate { padding: 5px; background: #fff; border-color: #dfe3e8; display: grid; gap: 5px; }
      .image-workbench-candidate img { width: 100%; aspect-ratio: 1; object-fit: cover; background: #eef1f4; }
      .image-workbench-candidate-preview-unavailable { width: 100%; aspect-ratio: 1; background: #eef1f4; }
      .image-workbench-candidate.is-selected, .image-workbench-list-button.is-selected { border-color: #1966c2; box-shadow: 0 0 0 1px #1966c2; }
      .image-workbench-split { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
      .image-workbench-list { display: grid; gap: 6px; }
      .image-workbench-list-button { display: flex; justify-content: space-between; padding: 8px; background: #fff; border-color: #dfe3e8; }
      .image-workbench-notice { margin: 0; padding: 8px 10px; border-left: 3px solid #1966c2; background: #edf5ff; overflow-wrap: anywhere; }
      @media (max-width: 720px) { .image-workbench-layout { grid-template-columns: 1fr; } .image-workbench-nav { grid-template-columns: repeat(3, minmax(0, 1fr)); border-right: 0; border-bottom: 1px solid #dfe3e8; } .image-workbench-nav button { white-space: normal; } .image-workbench-section form.image-workbench-quick-form, .image-workbench-quick-reference, .image-workbench-split { grid-template-columns: 1fr; } }
    </style>
    <header class="image-workbench-header"><h1>图片工作台</h1><form data-project-select-form><select data-project-select aria-label="已有图片项目">${projectOptions}</select><button type="submit">打开项目</button></form><button type="button" data-action="refresh-project-list">刷新项目</button><span>${escapeHtml(projection?.project.state ?? '未选择项目')}</span></header>
    <div class="image-workbench-layout">
      <nav class="image-workbench-nav" aria-label="图片工作台导航">${panelButtons}</nav>
      <main class="image-workbench-main">
        ${snapshot.notice ? `<p class="image-workbench-notice" role="status">${escapeHtml(snapshot.notice)}</p>` : ''}
        <section class="image-workbench-project"><h2>${escapeHtml(projectTitle)}</h2><button type="button" data-action="resume-project">恢复</button></section>
        ${renderActivePanel(snapshot)}
      </main>
    </div>
  </div>`
}

async function fileAsDataUrl(file: File): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('IMAGE_FILE_READ_FAILED'))
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('IMAGE_FILE_READ_FAILED'))
    reader.readAsDataURL(file)
  })
}

/**
 * A framework-free renderer shell.  It retains only view choices locally and
 * delegates every business command to an injected public client contract.
 */
export class ImageWorkbenchShell {
  private readonly root: HTMLElement
  private readonly client: ImageWorkbenchClient
  private readonly storage?: ImageWorkbenchViewStateStorage
  private readonly idempotencyKey: IdempotencyKeyFactory
  private abortController?: AbortController
  private state: ImageWorkbenchViewState
  private projection?: ImageWorkbenchProjectProjection
  private projects: readonly ImageWorkbenchProjectListResponse['projects'][number][] = []
  private campaigns: readonly ImageCampaign[] = []
  private campaignDetails: readonly ImageCampaignResponse[] = []
  private campaignNextCursor?: number
  private readonly campaignQuotes = new Map<string, ImageCampaignQuote>()
  private readonly campaignRetryReceipts = new Map<string, { campaign_id: string; item_id: string; confirmation_receipt_id: string; estimate_hash: string }>()
  private readonly candidatePreviews = new Map<string, string>()
  private generationQuote?: ImageGenerationQuote
  private derivationQuote?: ImageDerivationQuote
  private brandKits: readonly ImageBrandKit[] = []
  private templates: readonly ImageTemplate[] = []
  private assetGrants: readonly ImageAssetGrant[] = []
  private notice?: string
  private eventPumpEpoch = 0
  private eventPumpProjectId?: string

  constructor(options: ImageWorkbenchShellOptions) {
    this.root = options.root
    this.client = options.client
    this.storage = options.view_state_storage
    this.idempotencyKey = options.idempotency_key_factory ?? defaultIdempotencyKey
    this.state = this.storage ? readImageWorkbenchViewState(this.storage) : createImageWorkbenchViewState()
  }

  mount(): void {
    this.unmount()
    this.abortController = new AbortController()
    this.root.addEventListener('click', this.handleClick, { signal: this.abortController.signal })
    this.root.addEventListener('submit', this.handleSubmit, { signal: this.abortController.signal })
    this.render()
    void this.runInteractive(() => this.refreshProjects())
    void this.runInteractive(() => this.refreshCampaigns())
    void this.runInteractive(() => this.refreshReusableDesigns())
    if (this.state.selected_project_id) void this.runInteractive(() => this.resumeSelectedProject())
  }

  unmount(): void {
    this.stopEventPump()
    this.abortController?.abort()
    this.abortController = undefined
  }

  snapshot(): ImageWorkbenchShellSnapshot {
    return {
      view_state: this.state,
      ...(this.projection ? { projection: this.projection } : {}),
      projects: this.projects,
      candidate_previews: Object.fromEntries(this.candidatePreviews),
      campaigns: this.campaigns,
      campaign_details: this.campaignDetails,
      ...(this.campaignNextCursor === undefined ? {} : { campaign_next_cursor: this.campaignNextCursor }),
      campaign_quotes: [...this.campaignQuotes.values()],
      campaign_retry_receipts: [...this.campaignRetryReceipts.values()],
      ...(this.generationQuote ? { generation_quote: this.generationQuote } : {}),
      ...(this.derivationQuote ? { derivation_quote: this.derivationQuote } : {}),
      brand_kits: this.brandKits,
      templates: this.templates,
      asset_grants: this.assetGrants,
      ...(this.notice ? { notice: this.notice } : {}),
    }
  }

  render(): void {
    this.root.innerHTML = renderImageWorkbenchShell(this.snapshot())
  }

  private persist(): void {
    if (!this.storage) return
    try {
      writeImageWorkbenchViewState(this.storage, this.state)
    } catch {
      this.notice = '当前视图状态无法保存；图片项目本身不受影响。'
    }
  }

  private dispatch(action: ImageWorkbenchViewAction): void {
    this.state = reduceImageWorkbenchViewState(this.state, action)
    this.persist()
    this.render()
  }

  private setNotice(notice: string | undefined): void {
    this.notice = notice
    this.render()
  }

  private projectId(): string {
    const projectId = this.state.selected_project_id
    if (!projectId) throw new Error('IMAGE_WORKBENCH_PROJECT_SELECTION_REQUIRED')
    return projectId
  }

  private async resolve<Value>(call: Promise<ImageWorkbenchClientResult<Value>>): Promise<Value> {
    return unwrapImageWorkbenchClientResult(await call)
  }

  private async refreshProject(projectId = this.projectId()): Promise<ImageWorkbenchProjectProjection> {
    const projection = await this.resolve(this.client.getProjectProjection({ project_id: projectId }))
    this.projection = projection
    if (this.generationQuote && !quoteIsActive(this.generationQuote, projection.project.id, projection.project.revision, this.generationQuote.project_id, this.generationQuote.project_revision)) {
      this.generationQuote = undefined
    }
    if (this.derivationQuote && !quoteIsActive(this.derivationQuote, projection.project.id, projection.project.revision, this.derivationQuote.project_id, this.derivationQuote.project_revision)) {
      this.derivationQuote = undefined
    }
    this.state = reconcileImageWorkbenchViewState(this.state, imageWorkbenchSelectionIndex(projection))
    this.persist()
    await this.refreshCandidatePreviews(projection)
    this.render()
    return projection
  }

  /** Resolves candidate bytes only through the injected typed bridge. */
  private async refreshCandidatePreviews(projection: ImageWorkbenchProjectProjection): Promise<void> {
    const previewClient = this.client.getCandidatePreview
    const candidates = projection.candidate_groups.flatMap(group => group.candidates)
    const ids = new Set(candidates.map(candidate => candidate.id))
    for (const candidateId of this.candidatePreviews.keys()) {
      if (!ids.has(candidateId)) this.candidatePreviews.delete(candidateId)
    }
    if (!previewClient || this.state.active_panel !== 'candidate-review') return

    const selected = this.state.selected_candidate_id
    const requested = [
      ...(selected ? candidates.filter(candidate => candidate.id === selected) : []),
      ...candidates.filter(candidate => candidate.id !== selected),
    ].filter((candidate, index, values) => values.findIndex(value => value.id === candidate.id) === index)
      .slice(0, MAX_CANDIDATE_PREVIEWS_PER_REFRESH)
      .filter(candidate => !this.candidatePreviews.has(candidate.id))
    let next = 0
    const load = async (): Promise<void> => {
      while (next < requested.length) {
        const candidate = requested[next]
        next += 1
        if (!candidate) return
        try {
          const response = await this.resolve(previewClient({
            project_id: projection.project.id,
            candidate_id: candidate.id,
          }))
          const dataUrl = response.candidate_id === candidate.id
            ? safeCandidatePreviewDataUrl(response.data_url)
            : undefined
          if (dataUrl) this.cacheCandidatePreview(candidate.id, dataUrl)
        } catch {
          // A protected preview is nonessential to the projection. Its next
          // selected refresh may retry through the same typed bridge.
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_CANDIDATE_PREVIEW_CONCURRENCY, requested.length) }, async () => await load()))
  }

  private cacheCandidatePreview(candidateId: string, dataUrl: string): void {
    this.candidatePreviews.delete(candidateId)
    this.candidatePreviews.set(candidateId, dataUrl)
    let total = [...this.candidatePreviews.values()].reduce((sum, value) => sum + value.length, 0)
    while (total > MAX_CANDIDATE_PREVIEW_CACHE_CHARS && this.candidatePreviews.size > 1) {
      const oldest = this.candidatePreviews.keys().next().value as string | undefined
      if (!oldest) break
      const removed = this.candidatePreviews.get(oldest)
      this.candidatePreviews.delete(oldest)
      total -= removed?.length ?? 0
    }
  }

  async refreshProjects(): Promise<readonly ImageWorkbenchProjectListResponse['projects'][number][]> {
    const response = await this.resolve(this.client.listProjects())
    this.projects = response.projects
    if (this.state.selected_project_id && !this.projects.some(project => project.id === this.state.selected_project_id)) {
      this.state = reduceImageWorkbenchViewState(this.state, { kind: 'select-project' })
      this.projection = undefined
      this.persist()
    }
    this.render()
    return this.projects
  }

  private async selectProject(projectId: string): Promise<void> {
    if (!this.projects.some(project => project.id === projectId)) throw new Error('IMAGE_WORKBENCH_PROJECT_NOT_FOUND')
    this.state = reduceImageWorkbenchViewState(this.state, { kind: 'select-project', project_id: projectId })
    this.projection = undefined
    this.generationQuote = undefined
    this.persist()
    await this.resumeSelectedProject()
  }

  async refreshSelectedProject(): Promise<ImageWorkbenchProjectProjection> {
    try {
      const projection = await this.refreshProject()
      this.setNotice(undefined)
      return projection
    } catch (error) {
      this.setNotice(error instanceof Error ? error.message : '无法刷新项目。')
      throw error
    }
  }

  private stopEventPump(): void {
    this.eventPumpEpoch += 1
    this.eventPumpProjectId = undefined
  }

  private eventPumpIsCurrent(projectId: string, epoch: number): boolean {
    return Boolean(this.abortController)
      && this.eventPumpEpoch === epoch
      && this.eventPumpProjectId === projectId
      && this.state.selected_project_id === projectId
  }

  private async waitBeforeEventRetry(projectId: string, epoch: number): Promise<void> {
    await new Promise<void>(resolve => setTimeout(resolve, IMAGE_WORKBENCH_EVENT_RETRY_MS))
    if (!this.eventPumpIsCurrent(projectId, epoch)) return
  }

  /**
   * Event pages contain only notification metadata. Always rebuild the
   * authoritative projection after a reset or any observed event; never apply
   * a task state directly in the Renderer.
   */
  private async replayOperationEvents(
    projectId: string,
    waitMs: number,
    epoch?: number,
  ): Promise<ImageWorkbenchProjectProjection> {
    let projection = this.projection?.project.id === projectId
      ? this.projection
      : await this.refreshProject(projectId)
    let keepPaging = true
    let reloadProjection = false
    while (keepPaging && (epoch === undefined || this.eventPumpIsCurrent(projectId, epoch))) {
      const cursor = this.state.event_cursors[projectId] ?? 0
      const page = await this.resolve(this.client.listOperationEvents({
        project_id: projectId,
        cursor,
        limit: IMAGE_WORKBENCH_EVENT_PAGE_LIMIT,
        wait_ms: waitMs,
      }))
      const plan = planImageWorkbenchRestore(this.state, projectId, page)
      this.state = plan.view_state
      this.persist()
      reloadProjection ||= plan.reload_projection
      // A full page can have more durable journal rows behind it. A reset is
      // already a complete resynchronization barrier, so continue long-polling
      // only after the replacement projection is read.
      keepPaging = !page.reset_required
        && page.events.length === IMAGE_WORKBENCH_EVENT_PAGE_LIMIT
        && page.cursor > cursor
      if (waitMs > 0) break
    }
    if (reloadProjection && (epoch === undefined || this.eventPumpIsCurrent(projectId, epoch))) {
      projection = await this.refreshProject(projectId)
    }
    return projection
  }

  private startEventPump(projectId: string): void {
    if (!this.abortController) return
    this.stopEventPump()
    const epoch = this.eventPumpEpoch
    this.eventPumpProjectId = projectId
    void (async () => {
      while (this.eventPumpIsCurrent(projectId, epoch)) {
        try {
          await this.replayOperationEvents(projectId, IMAGE_WORKBENCH_EVENT_WAIT_MS, epoch)
        } catch (error) {
          if (!this.eventPumpIsCurrent(projectId, epoch)) return
          this.notice = error instanceof Error ? '图片操作订阅暂时断开，正在恢复。' : '图片操作订阅暂时断开，正在恢复。'
          this.render()
          await this.waitBeforeEventRetry(projectId, epoch)
        }
      }
    })()
  }

  /** Rebuild business facts, exhaust any saved event pages, then subscribe. */
  async resumeSelectedProject(): Promise<ImageWorkbenchProjectProjection> {
    const projectId = this.projectId()
    try {
      await this.refreshProject(projectId)
      const projection = await this.replayOperationEvents(projectId, 0)
      this.startEventPump(projectId)
      this.setNotice(undefined)
      return projection
    } catch (error) {
      this.setNotice(error instanceof Error ? error.message : '无法恢复图片项目。')
      throw error
    }
  }

  async quickCreate(input: ImageQuickCreateInput): Promise<void> {
    const created = await this.resolve(this.client.quickCreate(input))
    this.state = reduceImageWorkbenchViewState(this.state, { kind: 'select-project', project_id: created.project.id })
    this.state = reduceImageWorkbenchViewState(this.state, { kind: 'open-panel', panel: 'candidate-review' })
    this.generationQuote = undefined
    this.persist()
    await this.refreshProjects()
    if (typeof this.client.listOperationEvents === 'function') await this.resumeSelectedProject()
    else await this.refreshProject(created.project.id)
  }

  private async quickCreateFromForm(form: HTMLFormElement): Promise<void> {
    const prompt = form.querySelector<HTMLInputElement>('[data-quick-prompt]')?.value.trim() ?? ''
    const outputPreset = form.querySelector<HTMLSelectElement>('[data-quick-preset]')?.value
    const referenceFile = form.querySelector<HTMLInputElement>('[data-quick-reference-file]')?.files?.[0]
    const referenceRole = form.querySelector<HTMLSelectElement>('[data-quick-reference-role]')?.value
    if (!prompt || (outputPreset !== 'square' && outputPreset !== 'landscape' && outputPreset !== 'portrait' && outputPreset !== 'auto')) {
      this.setNotice('请填写图片描述并选择输出规格。')
      return
    }
    if ((referenceFile === undefined) !== (referenceRole === undefined || referenceRole === '')) {
      this.setNotice('首轮参考图必须同时选择图片和角色。')
      return
    }
    if (referenceRole && !isQuickCreateReferenceRole(referenceRole)) {
      this.setNotice('请选择有效的首轮参考角色。')
      return
    }
    if (referenceFile && !QUICK_CREATE_REFERENCE_MIME_TYPES.has(referenceFile.type)) {
      this.setNotice('首轮参考图只支持 PNG、JPEG 或 WebP。')
      return
    }
    const reference_inputs = referenceFile && isQuickCreateReferenceRole(referenceRole)
      ? [{ data_url: await fileAsDataUrl(referenceFile), role: referenceRole }]
      : []
    await this.quickCreate({
      idempotency_key: this.idempotencyKey(),
      prompt,
      output_preset: outputPreset,
      reference_inputs,
    })
  }

  async addReferences(input: AddImageWorkflowReferencesInput): Promise<void> {
    await this.resolve(this.client.addReferences({ project_id: this.projectId(), input }))
    await this.refreshSelectedProject()
  }

  async compileBrief(): Promise<void> {
    await this.resolve(this.client.compileBrief({ project_id: this.projectId() }))
    await this.refreshSelectedProject()
  }

  async applyBriefOverrides(briefId: string, input: ApplyImageBriefOverridesInput): Promise<void> {
    const command: ImageBriefOverrideCommand = { project_id: this.projectId(), brief_id: briefId, input }
    await this.resolve(this.client.applyBriefOverrides(command))
    await this.refreshSelectedProject()
  }

  async upsertInspirationItems(input: UpsertImageInspirationItemsInput): Promise<void> {
    const command: ImageInspirationUpsertCommand = { project_id: this.projectId(), input }
    await this.resolve(this.client.upsertInspirationItems(command))
    await this.refreshSelectedProject()
  }

  async promoteInspirationItem(
    inspirationItemId: string,
    input: PromoteImageInspirationItemInput,
  ): Promise<void> {
    const command: ImageInspirationPromoteCommand = {
      project_id: this.projectId(),
      inspiration_item_id: inspirationItemId,
      input,
    }
    await this.resolve(this.client.promoteInspirationItem(command))
    await this.refreshSelectedProject()
  }

  async updateReferenceControl(referenceId: string, input: UpdateImageReferenceControlInput): Promise<void> {
    const command: ImageReferenceControlCommand = { project_id: this.projectId(), reference_id: referenceId, input }
    await this.resolve(this.client.updateReferenceControl(command))
    await this.refreshSelectedProject()
  }

  async createCreativePlan(input: CreateCreativePlanInput): Promise<void> {
    await this.resolve(this.client.createCreativePlan({ project_id: this.projectId(), input }))
    await this.refreshSelectedProject()
  }

  async createGenerationRound(input: CreateGenerationRoundInput): Promise<void> {
    await this.resolve(this.client.createGenerationRound({ project_id: this.projectId(), input }))
    await this.refreshSelectedProject()
  }

  async estimateGenerationRound(input: EstimateGenerationRoundInput): Promise<void> {
    const command: ImageGenerationRoundEstimateCommand = { project_id: this.projectId(), input }
    const response = await this.resolve(this.client.estimateGenerationRound(command))
    this.generationQuote = {
      project_id: command.project_id,
      creative_plan_id: input.creative_plan_id,
      direction_ids: input.direction_ids ?? [],
      estimate_hash: response.estimate_hash,
      project_revision: this.currentProjection().project.revision,
      paid_operation_count: response.paid_operation_count,
      candidate_count_per_operation: response.candidate_count_per_operation,
      concurrency: response.concurrency,
      price_upper_bound: response.price_upper_bound,
      expires_at: response.expires_at,
    }
    this.render()
  }

  async decideCandidate(candidateId: string, input: DecideImageCandidateInput): Promise<void> {
    const command: ImageCandidateDecisionCommand = { project_id: this.projectId(), candidate_id: candidateId, input }
    await this.resolve(this.client.decideCandidate(command))
    await this.refreshSelectedProject()
  }

  async deriveCandidate(candidateId: string, input: DeriveImageCandidateInput): Promise<void> {
    const command: ImageCandidateDerivationCommand = { project_id: this.projectId(), candidate_id: candidateId, input }
    await this.resolve(this.client.deriveCandidate(command))
    await this.refreshSelectedProject()
  }

  async adoptCandidate(candidateId: string, input: ImageCandidateAdoptionCommand['input']): Promise<void> {
    await this.resolve(this.client.adoptCandidate({ project_id: this.projectId(), candidate_id: candidateId, input }))
    await this.refreshSelectedProject()
  }

  async applyCanvasCommand(canvasId: string, input: ImageCanvasCommandRequestInput): Promise<void> {
    const command: ImageCanvasCommand = { project_id: this.projectId(), canvas_id: canvasId, input }
    await this.resolve(this.client.applyCanvasCommand(command))
    await this.refreshSelectedProject()
  }

  async preflightCanvas(canvasId: string, input: ImageCanvasPreflightInput): Promise<void> {
    const command: ImageCanvasPreflightCommand = { project_id: this.projectId(), canvas_id: canvasId, input }
    await this.resolve(this.client.preflightCanvas(command))
    await this.refreshSelectedProject()
  }

  async renderCanvas(canvasId: string, input: ImageCanvasRenderInput): Promise<void> {
    const command: ImageCanvasRenderCommand = { project_id: this.projectId(), canvas_id: canvasId, input }
    await this.resolve(this.client.renderCanvas(command))
    await this.refreshSelectedProject()
  }

  async exportDelivery(input: ImageExportInput): Promise<void> {
    const command: ImageExportCommand = { project_id: this.projectId(), input }
    await this.resolve(this.client.exportDelivery(command))
    await this.refreshSelectedProject()
  }

  async createDeliverySpec(input: ImageDeliverySpecRevisionInput): Promise<void> {
    const command: ImageDeliverySpecCommand = { project_id: this.projectId(), input }
    await this.resolve(this.client.createDeliverySpec(command))
    await this.refreshSelectedProject()
  }

  async refreshLibrary(): Promise<ImageProjectLibrary> {
    const library = await this.resolve(this.client.getProjectLibrary({ project_id: this.projectId() }))
    await this.refreshSelectedProject()
    return library
  }

  async refreshReusableDesigns(): Promise<void> {
    const [brandKits, templates, assetGrants] = await Promise.all([
      this.resolve(this.client.listBrandKits()),
      this.resolve(this.client.listTemplates()),
      this.resolve(this.client.listAssetGrants()),
    ])
    this.brandKits = brandKits.brand_kits
    this.templates = templates.templates
    this.assetGrants = assetGrants.grants
    this.render()
  }

  async createBrandKit(input: CreateImageBrandKitInput): Promise<void> {
    await this.resolve(this.client.createBrandKit(input))
    await this.refreshReusableDesigns()
  }

  async reviseBrandKit(brandKitId: string, input: ReviseImageBrandKitInput): Promise<void> {
    const command: ImageBrandKitRevisionCommand = { brand_kit_id: brandKitId, input }
    await this.resolve(this.client.reviseBrandKit(command))
    await this.refreshReusableDesigns()
  }

  async deleteBrandKit(brandKitId: string, input: ImageReusableDeleteCommand): Promise<void> {
    await this.resolve(this.client.deleteBrandKit({ brand_kit_id: brandKitId, input }))
    await this.refreshReusableDesigns()
  }

  async createTemplate(input: CreateImageTemplateInput): Promise<void> {
    await this.resolve(this.client.createTemplate(input))
    await this.refreshReusableDesigns()
  }

  async reviseTemplate(templateId: string, input: ReviseImageTemplateInput): Promise<void> {
    const command: ImageTemplateRevisionCommand = { template_id: templateId, input }
    await this.resolve(this.client.reviseTemplate(command))
    await this.refreshReusableDesigns()
  }

  async deleteTemplate(templateId: string, input: ImageReusableDeleteCommand): Promise<void> {
    await this.resolve(this.client.deleteTemplate({ template_id: templateId, input }))
    await this.refreshReusableDesigns()
  }

  async refreshCampaigns(loadMore = false): Promise<readonly ImageCampaign[]> {
    if (loadMore && this.campaignNextCursor === undefined) return this.campaigns
    const response = await this.resolve(this.client.listCampaigns({
      limit: 20,
      ...(loadMore ? { cursor: this.campaignNextCursor } : {}),
    }))
    const page = response.campaigns
    this.campaigns = loadMore ? [...this.campaigns, ...page] : page
    const pageDetails = await Promise.all(page.map(async campaign =>
      await this.resolve(this.client.getCampaign({ campaign_id: campaign.id }))))
    this.campaignDetails = loadMore ? [...this.campaignDetails, ...pageDetails] : pageDetails
    this.campaignNextCursor = response.next_cursor
    this.campaignRetryReceipts.clear()
    for (const detail of this.campaignDetails) {
      for (const pending of detail.pending_retry_confirmations) {
        this.campaignRetryReceipts.set(campaignQuoteKey(detail.campaign.id, pending.item_id), {
          campaign_id: detail.campaign.id,
          item_id: pending.item_id,
          confirmation_receipt_id: pending.confirmation_receipt_id,
          estimate_hash: pending.estimate_hash,
        })
      }
    }
    this.render()
    return response.campaigns
  }

  async createCampaign(input: CreateImageCampaignInput): Promise<ImageCampaign> {
    const response = await this.resolve(this.client.createCampaign(input))
    await this.refreshCampaigns()
    return response.campaign
  }

  async estimateCampaign(command: ImageCampaignEstimateCommand): Promise<void> {
    const response = await this.resolve(this.client.estimateCampaign(command))
    this.campaignQuotes.set(campaignQuoteKey(command.campaign_id, command.input.item_id), {
      campaign_id: command.campaign_id,
      ...(command.input.item_id ? { item_id: command.input.item_id } : {}),
      estimate: response.estimate,
    })
    await this.refreshCampaigns()
  }

  async confirmCampaign(command: ImageCampaignConfirmCommand): Promise<void> {
    await this.resolve(this.client.confirmCampaign(command))
    this.campaignQuotes.delete(campaignQuoteKey(command.campaign_id))
    await this.refreshCampaigns()
  }

  async confirmCampaignRetry(command: ImageCampaignRetryConfirmCommand): Promise<void> {
    const response = await this.resolve(this.client.confirmCampaignRetry(command))
    const key = campaignQuoteKey(command.campaign_id, command.item_id)
    this.campaignQuotes.delete(key)
    this.campaignRetryReceipts.set(key, {
      campaign_id: command.campaign_id,
      item_id: command.item_id,
      confirmation_receipt_id: response.confirmation.id,
      estimate_hash: response.confirmation.estimate_hash,
    })
    await this.refreshCampaigns()
  }

  async startCampaign(command: ImageCampaignStartCommand): Promise<void> {
    await this.resolve(this.client.startCampaign(command))
    await this.refreshCampaigns()
  }

  async cancelCampaign(command: ImageCampaignCancelCommand): Promise<void> {
    await this.resolve(this.client.cancelCampaign(command))
    await this.refreshCampaigns()
  }

  /** Queued is the only state where the cancellation contract promises success. */
  private async cancelQueuedOperation(operationId: string): Promise<void> {
    const projection = this.currentProjection()
    const operation = projection.operations.find(value => value.id === operationId)
    if (!operation) throw new Error('IMAGE_WORKBENCH_OPERATION_NOT_FOUND')
    if (operation.status !== 'queued') throw new Error('IMAGE_WORKBENCH_OPERATION_CANCEL_NOT_QUEUED')
    await this.resolve(this.client.cancelOperation({
      project_id: projection.project.id,
      operation_id: operation.id,
    }))
    await this.refreshSelectedProject()
  }

  async retryCampaignItem(command: ImageCampaignRetryItemCommand): Promise<void> {
    await this.resolve(this.client.retryCampaignItem(command))
    const key = campaignQuoteKey(command.campaign_id, command.item_id)
    this.campaignQuotes.delete(key)
    this.campaignRetryReceipts.delete(key)
    await this.refreshCampaigns()
  }

  private currentProjection(): ImageWorkbenchProjectProjection {
    if (!this.projection) throw new Error('IMAGE_WORKBENCH_PROJECT_SELECTION_REQUIRED')
    return this.projection
  }

  private candidate(candidateId: string) {
    const candidate = this.currentProjection().candidate_groups.flatMap(group => group.candidates)
      .find(value => value.id === candidateId)
    if (!candidate) throw new Error('IMAGE_WORKBENCH_CANDIDATE_SELECTION_REQUIRED')
    return candidate
  }

  private canvas(canvasId?: string) {
    const projection = this.currentProjection()
    const canvas = projection.canvases.find(value => value.canvas_id === canvasId)
      ?? projection.canvases.find(value => value.canvas_id === this.state.selected_canvas_id)
      ?? projection.canvases[0]
    if (!canvas) throw new Error('IMAGE_WORKBENCH_CANVAS_SELECTION_REQUIRED')
    return canvas
  }

  private artboardId(): string {
    const artboards = this.currentProjection().delivery_spec?.artboards ?? []
    const selected = artboards.find(value => value.id === this.state.selected_artboard_id) ?? artboards[0]
    if (!selected) throw new Error('IMAGE_WORKBENCH_ARTBOARD_SELECTION_REQUIRED')
    return selected.id
  }

  private localEntityId(prefix: string): string {
    const entropy = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
    return `${prefix}_${entropy.replaceAll(/[^a-z0-9_]/gi, '').toLowerCase()}`.slice(0, 80)
  }

  private async decideSelectedCandidate(candidateId: string, decision: 'kept' | 'rejected'): Promise<void> {
    const projection = this.currentProjection()
    this.candidate(candidateId)
    await this.decideCandidate(candidateId, {
      idempotency_key: this.idempotencyKey(),
      base_revision: projection.project.revision,
      decision,
    })
  }

  private async adoptSelectedCandidate(candidateId: string, artboardIds: readonly string[]): Promise<void> {
    const projection = this.currentProjection()
    this.candidate(candidateId)
    const supported = new Set((projection.delivery_spec?.artboards ?? []).map(artboard => artboard.id))
    const targets = [...new Set(artboardIds)]
    if (targets.length === 0 || targets.some(artboardId => !supported.has(artboardId))) {
      throw new Error('IMAGE_WORKBENCH_ARTBOARD_SELECTION_REQUIRED')
    }
    await this.adoptCandidate(candidateId, {
      idempotency_key: this.idempotencyKey(),
      base_revision: projection.project.revision,
      adoptions: targets.map(artboard_id => ({
        artboard_id,
        placement: { fit: 'contain', focus_x: 0.5, focus_y: 0.5 },
      })),
    })
  }

  private async deriveSelectedCandidate(
    candidateId: string,
    instruction: string,
    kind: 'edit' | 'inpaint',
    maskDataUrl?: string,
  ): Promise<void> {
    const projection = this.currentProjection()
    this.candidate(candidateId)
    if (kind === 'inpaint' && !maskDataUrl) throw new Error('IMAGE_WORKBENCH_INPAINT_MASK_REQUIRED')
    const estimate = await this.resolve(this.client.estimateCandidateDerivation({
      project_id: this.projectId(),
      candidate_id: candidateId,
      input: {
        base_revision: projection.project.revision,
        instruction,
        kind,
        ...(maskDataUrl ? { mask_data_url: maskDataUrl } : {}),
      },
    }))
    this.derivationQuote = {
      project_id: projection.project.id,
      candidate_id: candidateId,
      project_revision: projection.project.revision,
      instruction,
      kind,
      ...(maskDataUrl ? { mask_data_url: maskDataUrl } : {}),
      estimate_hash: estimate.estimate_hash,
      paid_operation_count: estimate.paid_operation_count,
      candidate_count_per_operation: estimate.candidate_count_per_operation,
      concurrency: estimate.concurrency,
      price_upper_bound: estimate.price_upper_bound,
      expires_at: estimate.expires_at,
    }
    this.render()
  }

  private async confirmDerivedCandidate(candidateId: string): Promise<void> {
    const projection = this.currentProjection()
    const quote = this.derivationQuote
    if (
      !quote
      || quote.candidate_id !== candidateId
      || !quoteIsActive(quote, projection.project.id, projection.project.revision, quote.project_id, quote.project_revision)
    ) {
      throw new Error('IMAGE_WORKBENCH_DERIVATION_ESTIMATE_REQUIRED')
    }
    await this.deriveCandidate(candidateId, {
      idempotency_key: this.idempotencyKey(),
      base_revision: quote.project_revision,
      instruction: quote.instruction,
      estimate_hash: quote.estimate_hash,
      confirm: true,
      kind: quote.kind,
      ...(quote.mask_data_url ? { mask_data_url: quote.mask_data_url } : {}),
    })
    this.derivationQuote = undefined
    this.render()
  }

  private async preflightSelectedCanvas(canvasId?: string): Promise<void> {
    const canvas = this.canvas(canvasId)
    const result = await this.resolve(this.client.preflightCanvas({
      project_id: this.projectId(),
      canvas_id: canvas.canvas_id,
      input: { revision: canvas.revision },
    }))
    await this.refreshSelectedProject()
    this.setNotice(result.preflight.passed ? '画布预检通过。' : '画布预检发现需要处理的问题。')
  }

  private async renderSelectedCanvas(canvasId?: string): Promise<void> {
    const projection = this.currentProjection()
    const canvas = this.canvas(canvasId)
    await this.renderCanvas(canvas.canvas_id, {
      idempotency_key: this.idempotencyKey(),
      base_revision: projection.project.revision,
      canvas_revision: canvas.revision,
      activate_on_success: true,
      ...(projection.project.current_versions_by_artboard[canvas.document.artboard_id]
        ? { expected_current_version_id: projection.project.current_versions_by_artboard[canvas.document.artboard_id] }
        : {}),
    })
  }

  private async fitCanvasToSafeArea(canvasId?: string): Promise<void> {
    const projection = this.currentProjection()
    const canvas = this.canvas(canvasId)
    const delivery = projection.delivery_spec
    if (!delivery || !delivery.artboards.some(artboard => artboard.id === canvas.document.artboard_id)) {
      throw new Error('IMAGE_WORKBENCH_DELIVERY_SPEC_REQUIRED')
    }
    await this.applyCanvasCommand(canvas.canvas_id, {
      base_project_revision: projection.project.revision,
      command: {
        idempotency_key: this.idempotencyKey(),
        base_revision: canvas.revision,
        kind: 'sync_delivery_spec',
        payload: {
          delivery_spec_id: delivery.id,
          delivery_spec_revision: delivery.revision,
          layout_policy: 'fit_safe_area',
        },
      },
    })
  }

  private canvasTextLayer(canvasId: string, layerId: string): Extract<ImageCanvasLayer, { kind: 'text' }> {
    const layer = canvasTextLayers(this.canvas(canvasId).document.layers).find(candidate => candidate.id === layerId)
    if (!layer) throw new Error('IMAGE_WORKBENCH_CANVAS_TEXT_LAYER_NOT_FOUND')
    return layer
  }

  private async addCanvasTextLayer(
    canvasId: string,
    input: { text: string; x: number; y: number; font_size: number; fill: string },
  ): Promise<void> {
    const projection = this.currentProjection()
    const canvas = this.canvas(canvasId)
    if (
      !input.text || input.text.length > 2_000
      || !Number.isFinite(input.x) || !Number.isFinite(input.y)
      || !Number.isFinite(input.font_size) || input.font_size <= 0 || input.font_size > 1_024
      || !/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/u.test(input.fill)
    ) throw new Error('IMAGE_WORKBENCH_CANVAS_TEXT_INVALID')
    await this.applyCanvasCommand(canvas.canvas_id, {
      base_project_revision: projection.project.revision,
      command: {
        idempotency_key: this.idempotencyKey(),
        base_revision: canvas.revision,
        kind: 'add_layer',
        payload: {
          layer: {
            id: this.localEntityId('layer'),
            kind: 'text',
            text: input.text,
            font_family: 'PingFang SC',
            font_asset_id: 'font_builtin_0001',
            font_size: input.font_size,
            min_font_size: Math.min(input.font_size, 12),
            font_weight: 700,
            font_style: 'normal',
            line_height: 1.2,
            letter_spacing: 0,
            fill: input.fill,
            position: { x: input.x, y: input.y },
            rotation_degrees: 0,
            max_width: Math.max(1, canvas.document.width - Math.max(0, input.x) - 32),
            max_height: Math.max(1, canvas.document.height - Math.max(0, input.y) - 32),
            overflow: 'shrink_to_fit',
            locale: 'zh-CN',
            align: 'left',
            scale_x: 1,
            scale_y: 1,
            opacity: 1,
          },
        },
      },
    })
  }

  private async updateCanvasTextLayer(canvasId: string, layerId: string, text: string): Promise<void> {
    const projection = this.currentProjection()
    const canvas = this.canvas(canvasId)
    const layer = this.canvasTextLayer(canvasId, layerId)
    if (!text || text.length > 2_000) throw new Error('IMAGE_WORKBENCH_CANVAS_TEXT_INVALID')
    await this.applyCanvasCommand(canvas.canvas_id, {
      base_project_revision: projection.project.revision,
      command: {
        idempotency_key: this.idempotencyKey(),
        base_revision: canvas.revision,
        kind: 'replace_layer',
        payload: { layer: { ...layer, text } },
      },
    })
  }

  private async exportCurrentDelivery(): Promise<void> {
    const projection = this.currentProjection()
    const artboards = projection.delivery_spec?.artboards ?? []
    const version_ids_by_artboard = Object.fromEntries(artboards.map(artboard => {
      const version = projection.project.current_versions_by_artboard[artboard.id]
      if (!version) throw new Error('IMAGE_WORKBENCH_RENDERED_VERSION_REQUIRED')
      return [artboard.id, version]
    }))
    await this.exportDelivery({
      idempotency_key: this.idempotencyKey(),
      base_revision: projection.project.revision,
      version_ids_by_artboard,
    })
  }

  /** Applies the persisted Campaign intent only after explicit Candidate adoption. */
  private async applyCampaignCanvasIntent(canvasId?: string): Promise<void> {
    const projection = this.currentProjection()
    const intent = projection.campaign_intent
    if (!intent) throw new Error('IMAGE_WORKBENCH_CAMPAIGN_INTENT_REQUIRED')
    const canvas = this.canvas(canvasId)
    if (intent.template_id && intent.template_revision_id) {
      await this.applyCanvasCommand(canvas.canvas_id, {
        base_project_revision: projection.project.revision,
        command: {
          idempotency_key: this.idempotencyKey(),
          base_revision: canvas.revision,
          kind: 'apply_template',
          payload: {
            template_id: intent.template_id,
            template_revision_id: intent.template_revision_id,
            slot_bindings: intent.slot_bindings,
          },
        },
      })
      return
    }
    if (intent.brand_kit_id && intent.brand_kit_revision_id) {
      await this.applyCanvasCommand(canvas.canvas_id, {
        base_project_revision: projection.project.revision,
        command: {
          idempotency_key: this.idempotencyKey(),
          base_revision: canvas.revision,
          kind: 'apply_brand_kit',
          payload: { brand_kit_id: intent.brand_kit_id, brand_kit_revision_id: intent.brand_kit_revision_id },
        },
      })
      return
    }
    throw new Error('IMAGE_WORKBENCH_CAMPAIGN_CANVAS_INTENT_EMPTY')
  }

  private async reuseAssetInSelectedCanvas(assetId: string): Promise<void> {
    let projection = this.currentProjection()
    const entry = projection.library.entries.find(value => value.asset_id === assetId)
    if (!entry || entry.project_id !== projection.project.id) {
      await this.resolve(this.client.createAssetGrant({
        input: {
          idempotency_key: this.idempotencyKey(),
          asset_id: assetId,
          to_owner: { kind: 'project', id: projection.project.id },
          purpose: 'project_reuse',
        },
      }))
      projection = await this.refreshSelectedProject()
    }
    const canvas = this.canvas()
    await this.applyCanvasCommand(canvas.canvas_id, {
      base_project_revision: projection.project.revision,
      command: {
        idempotency_key: this.idempotencyKey(),
        base_revision: canvas.revision,
        kind: 'add_layer',
        payload: {
          layer: {
            id: this.localEntityId('layer'),
            kind: 'raster',
            source_asset_id: assetId,
            transform: {
              x: Math.round(canvas.document.width * 0.1),
              y: Math.round(canvas.document.height * 0.1),
              width: Math.max(1, Math.round(canvas.document.width * 0.8)),
              height: Math.max(1, Math.round(canvas.document.height * 0.8)),
              rotation_degrees: 0,
              scale_x: 1,
              scale_y: 1,
            },
            opacity: 1,
            blend_mode: 'normal',
          },
        },
      },
    })
  }

  private campaign(campaignId: string): ImageCampaign {
    const campaign = this.campaigns.find(value => value.id === campaignId)
    if (!campaign) throw new Error('IMAGE_WORKBENCH_CAMPAIGN_NOT_FOUND')
    return campaign
  }

  private quote(campaignId: string, itemId?: string): ImageCampaignQuote {
    const quote = this.campaignQuotes.get(campaignQuoteKey(campaignId, itemId))
    if (!quote) throw new Error('IMAGE_WORKBENCH_CAMPAIGN_ESTIMATE_REQUIRED')
    const campaign = this.campaign(campaignId)
    if (!campaignQuoteIsActive(quote, campaign)) throw new Error('IMAGE_WORKBENCH_CAMPAIGN_ESTIMATE_REQUIRED')
    return quote
  }

  private async confirmCampaignFromQuote(campaignId: string): Promise<void> {
    const campaign = this.campaign(campaignId)
    const quote = this.quote(campaignId)
    await this.confirmCampaign({
      campaign_id: campaignId,
      input: {
        idempotency_key: this.idempotencyKey(),
        base_revision: campaign.revision,
        estimate_hash: quote.estimate.estimate_hash,
      },
    })
  }

  private async startCampaignFromReceipt(campaignId: string): Promise<void> {
    const campaign = this.campaign(campaignId)
    if (!campaign.estimate_hash || !campaign.confirmation_receipt_id) {
      throw new Error('IMAGE_WORKBENCH_CAMPAIGN_CONFIRMATION_REQUIRED')
    }
    await this.startCampaign({
      campaign_id: campaignId,
      input: {
        idempotency_key: this.idempotencyKey(),
        base_revision: campaign.revision,
        estimate_hash: campaign.estimate_hash,
        confirmation_receipt_id: campaign.confirmation_receipt_id,
      },
    })
  }

  private async confirmCampaignRetryFromQuote(campaignId: string, itemId: string): Promise<void> {
    const campaign = this.campaign(campaignId)
    const quote = this.quote(campaignId, itemId)
    await this.confirmCampaignRetry({
      campaign_id: campaignId,
      item_id: itemId,
      input: {
        idempotency_key: this.idempotencyKey(),
        base_revision: campaign.revision,
        estimate_hash: quote.estimate.estimate_hash,
      },
    })
  }

  private async retryCampaignItemFromReceipt(campaignId: string, itemId: string): Promise<void> {
    const campaign = this.campaign(campaignId)
    const receipt = this.campaignRetryReceipts.get(campaignQuoteKey(campaignId, itemId))
    if (!receipt) throw new Error('IMAGE_WORKBENCH_CAMPAIGN_RETRY_CONFIRMATION_REQUIRED')
    await this.retryCampaignItem({
      campaign_id: campaignId,
      item_id: itemId,
      input: {
        idempotency_key: this.idempotencyKey(),
        base_revision: campaign.revision,
        estimate_hash: receipt.estimate_hash,
        confirmation_receipt_id: receipt.confirmation_receipt_id,
      },
    })
  }

  private readonly handleClick = (event: Event): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest<HTMLButtonElement>('button[data-action]')
    if (!button) return
    const action = button.dataset.action
    if (action === 'open-panel') {
      const panel = button.dataset.panel
      if (panel && ['quick-create', 'creative-intake', 'inspiration-board', 'reference-tray', 'candidate-review', 'canvas-editor', 'delivery-panel', 'project-library', 'campaign', 'operation-center'].includes(panel)) {
        this.dispatch({ kind: 'open-panel', panel: panel as ImageWorkbenchPanel })
      }
      return
    }
    if (action === 'select-candidate' && button.dataset.candidateId) {
      if (this.derivationQuote?.candidate_id !== button.dataset.candidateId) this.derivationQuote = undefined
      this.dispatch({ kind: 'select-candidate', candidate_id: button.dataset.candidateId })
      const projection = this.projection
      if (projection) void this.refreshCandidatePreviews(projection).then(() => this.render()).catch(() => undefined)
      return
    }
    if (action === 'select-canvas' && button.dataset.canvasId) {
      this.dispatch({ kind: 'select-canvas', canvas_id: button.dataset.canvasId })
      return
    }
    if (action === 'select-artboard' && button.dataset.artboardId) {
      this.dispatch({ kind: 'select-artboard', artboard_id: button.dataset.artboardId })
      return
    }
    if (action === 'compile-brief') {
      void this.runInteractive(() => this.compileBrief())
      return
    }
    if (action === 'trash-brand-kit' && button.dataset.brandKitId) {
      void this.runInteractive(() => this.trashBrandKit(button.dataset.brandKitId!))
      return
    }
    if (action === 'trash-template' && button.dataset.templateId) {
      void this.runInteractive(() => this.trashTemplate(button.dataset.templateId!))
      return
    }
    if (action === 'revoke-asset-grant' && button.dataset.grantId) {
      void this.runInteractive(() => this.revokeAssetGrantFromButton(button.dataset.grantId!))
      return
    }
    if (action === 'keep-candidate' && button.dataset.candidateId) {
      void this.runInteractive(() => this.decideSelectedCandidate(button.dataset.candidateId!, 'kept'))
      return
    }
    if (action === 'reject-candidate' && button.dataset.candidateId) {
      void this.runInteractive(() => this.decideSelectedCandidate(button.dataset.candidateId!, 'rejected'))
      return
    }
    if (action === 'confirm-derive-candidate' && button.dataset.candidateId) {
      void this.runInteractive(() => this.confirmDerivedCandidate(button.dataset.candidateId!))
      return
    }
    if (action === 'adopt-candidate' && button.dataset.candidateId) {
      void this.runInteractive(() => this.adoptSelectedCandidate(button.dataset.candidateId!, [this.artboardId()]))
      return
    }
    if (action === 'preflight-canvas') {
      void this.runInteractive(() => this.preflightSelectedCanvas(button.dataset.canvasId))
      return
    }
    if (action === 'render-canvas') {
      void this.runInteractive(() => this.renderSelectedCanvas(button.dataset.canvasId))
      return
    }
    if (action === 'fit-canvas-safe-area') {
      void this.runInteractive(() => this.fitCanvasToSafeArea(button.dataset.canvasId))
      return
    }
    if (action === 'export-delivery') {
      void this.runInteractive(() => this.exportCurrentDelivery())
      return
    }
    if (action === 'apply-campaign-intent') {
      void this.runInteractive(() => this.applyCampaignCanvasIntent(button.dataset.canvasId))
      return
    }
    if (action === 'cancel-operation' && button.dataset.operationId) {
      void this.runInteractive(() => this.cancelQueuedOperation(button.dataset.operationId!))
      return
    }
    if (action === 'estimate-campaign' && button.dataset.campaignId) {
      void this.runInteractive(() => this.estimateCampaign({
        campaign_id: button.dataset.campaignId!,
        input: { base_revision: this.campaign(button.dataset.campaignId!).revision },
      }))
      return
    }
    if (action === 'confirm-campaign' && button.dataset.campaignId) {
      void this.runInteractive(() => this.confirmCampaignFromQuote(button.dataset.campaignId!))
      return
    }
    if (action === 'start-campaign' && button.dataset.campaignId) {
      void this.runInteractive(() => this.startCampaignFromReceipt(button.dataset.campaignId!))
      return
    }
    if (action === 'cancel-campaign' && button.dataset.campaignId) {
      void this.runInteractive(() => this.cancelCampaign({
        campaign_id: button.dataset.campaignId!,
        input: { idempotency_key: this.idempotencyKey(), base_revision: this.campaign(button.dataset.campaignId!).revision },
      }))
      return
    }
    if (action === 'estimate-campaign-retry' && button.dataset.campaignId && button.dataset.itemId) {
      void this.runInteractive(() => this.estimateCampaign({
        campaign_id: button.dataset.campaignId!,
        input: { base_revision: this.campaign(button.dataset.campaignId!).revision, item_id: button.dataset.itemId! },
      }))
      return
    }
    if (action === 'confirm-campaign-retry' && button.dataset.campaignId && button.dataset.itemId) {
      void this.runInteractive(() => this.confirmCampaignRetryFromQuote(button.dataset.campaignId!, button.dataset.itemId!))
      return
    }
    if (action === 'retry-campaign-item' && button.dataset.campaignId && button.dataset.itemId) {
      void this.runInteractive(() => this.retryCampaignItemFromReceipt(button.dataset.campaignId!, button.dataset.itemId!))
      return
    }
    if (action === 'refresh-project') {
      void this.runInteractive(() => this.refreshSelectedProject())
      return
    }
    if (action === 'refresh-project-list') {
      void this.runInteractive(() => this.refreshProjects())
      return
    }
    if (action === 'load-more-campaigns') {
      void this.runInteractive(() => this.refreshCampaigns(true))
      return
    }
    if (action === 'resume-project') void this.runInteractive(() => this.resumeSelectedProject())
  }

  private readonly handleSubmit = (event: Event): void => {
    const target = event.target
    if (!(target instanceof HTMLFormElement)) return
    event.preventDefault()
    if (target.matches('[data-quick-create-form]')) {
      void this.runInteractive(() => this.quickCreateFromForm(target))
      return
    }
    if (target.matches('[data-project-select-form]')) {
      const projectId = target.querySelector<HTMLSelectElement>('[data-project-select]')?.value
      if (!projectId) {
        this.setNotice('请选择要打开的图片项目。')
        return
      }
      void this.runInteractive(() => this.selectProject(projectId))
      return
    }
    if (target.matches('[data-reference-form]')) {
      void this.runInteractive(() => this.addFilesAsReferences(target))
      return
    }
    if (target.matches('[data-reference-control-form]')) {
      void this.runInteractive(() => this.updateReferenceControlFromForm(target))
      return
    }
    if (target.matches('[data-brief-overrides-form]')) {
      void this.runInteractive(() => this.applyBriefOverridesFromForm(target))
      return
    }
    if (target.matches('[data-create-plan-form]')) {
      void this.runInteractive(() => this.createDefaultCreativePlan())
      return
    }
    if (target.matches('[data-generation-estimate-form]')) {
      void this.runInteractive(() => this.estimateGenerationFromForm(target))
      return
    }
    if (target.matches('[data-generation-confirm-form]')) {
      void this.runInteractive(() => this.confirmGenerationFromQuote(target))
      return
    }
    if (target.matches('[data-inspiration-upsert-form]')) {
      void this.runInteractive(() => this.upsertInspirationFromForm(target))
      return
    }
    if (target.matches('[data-inspiration-promote-form]')) {
      void this.runInteractive(() => this.promoteInspirationFromForm(target))
      return
    }
    if (target.matches('[data-derive-candidate-form]')) {
      void this.runInteractive(() => this.deriveCandidateFromForm(target))
      return
    }
    if (target.matches('[data-adopt-candidate-form]')) {
      void this.runInteractive(() => this.adoptCandidateFromForm(target))
      return
    }
    if (target.matches('[data-library-reuse-form]')) {
      const assetId = target.querySelector<HTMLInputElement>('[data-library-asset-id]')?.value.trim() ?? ''
      if (!assetId) {
        this.setNotice('请选择要复用的素材。')
        return
      }
      void this.runInteractive(() => this.reuseAssetInSelectedCanvas(assetId))
      return
    }
    if (target.matches('[data-delivery-spec-form]')) {
      void this.runInteractive(() => this.createDeliverySpecFromForm(target))
      return
    }
    if (target.matches('[data-add-canvas-text-form]')) {
      void this.runInteractive(() => this.addCanvasTextFromForm(target))
      return
    }
    if (target.matches('[data-edit-canvas-text-form]')) {
      void this.runInteractive(() => this.updateCanvasTextFromForm(target))
      return
    }
    if (target.matches('[data-apply-brand-form]')) {
      void this.runInteractive(() => this.applyBrandKitFromForm(target))
      return
    }
    if (target.matches('[data-apply-template-form]')) {
      void this.runInteractive(() => this.applyTemplateFromForm(target))
      return
    }
    if (target.matches('[data-brand-create-form]')) {
      void this.runInteractive(() => this.createBrandKitFromForm(target))
      return
    }
    if (target.matches('[data-brand-revise-form]')) {
      void this.runInteractive(() => this.reviseBrandKitFromForm(target))
      return
    }
    if (target.matches('[data-template-create-form]')) {
      void this.runInteractive(() => this.createTemplateFromForm(target))
      return
    }
    if (target.matches('[data-template-revise-form]')) {
      void this.runInteractive(() => this.reviseTemplateFromForm(target))
      return
    }
    if (target.matches('[data-reusable-asset-grant-form]')) {
      void this.runInteractive(() => this.grantReusableAssetFromForm(target))
      return
    }
    if (target.matches('[data-campaign-create-form]')) void this.runInteractive(() => this.createCampaignFromForm(target))
  }

  private linesFromForm(form: HTMLFormElement, selector: string, limit: number): string[] {
    const value = form.querySelector<HTMLTextAreaElement>(selector)?.value ?? ''
    const lines = value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
    if (lines.length > limit || lines.some(line => line.length > 500)) throw new Error('IMAGE_WORKBENCH_TEXT_LIST_INVALID')
    return lines
  }

  private async adoptCandidateFromForm(form: HTMLFormElement): Promise<void> {
    const candidateId = form.dataset.candidateId
    const selector = form.querySelector<HTMLSelectElement>('[data-adopt-artboards]')
    const artboardIds = selector ? [...selector.selectedOptions].map(option => option.value) : []
    if (!candidateId || artboardIds.length === 0) throw new Error('IMAGE_WORKBENCH_ARTBOARD_SELECTION_REQUIRED')
    await this.adoptSelectedCandidate(candidateId, artboardIds)
  }

  private async deriveCandidateFromForm(form: HTMLFormElement): Promise<void> {
    const candidateId = form.dataset.candidateId
    const instruction = form.querySelector<HTMLInputElement>('[data-derive-instruction]')?.value.trim() ?? ''
    const kind = form.querySelector<HTMLSelectElement>('[data-derive-kind]')?.value
    if (!candidateId || !instruction || (kind !== 'edit' && kind !== 'inpaint')) {
      throw new Error('IMAGE_WORKBENCH_CANDIDATE_DERIVATION_INVALID')
    }
    const mask = form.querySelector<HTMLInputElement>('[data-derive-mask]')?.files?.[0]
    if (kind === 'inpaint') {
      if (!mask || mask.type !== 'image/png') throw new Error('IMAGE_WORKBENCH_INPAINT_MASK_PNG_REQUIRED')
      await this.deriveSelectedCandidate(candidateId, instruction, kind, await fileAsDataUrl(mask))
      return
    }
    await this.deriveSelectedCandidate(candidateId, instruction, kind)
  }

  private async addCanvasTextFromForm(form: HTMLFormElement): Promise<void> {
    const canvasId = form.dataset.canvasId
    const text = form.querySelector<HTMLInputElement>('[data-canvas-text]')?.value.trim() ?? ''
    const x = Number(form.querySelector<HTMLInputElement>('[data-canvas-text-x]')?.value)
    const y = Number(form.querySelector<HTMLInputElement>('[data-canvas-text-y]')?.value)
    const fontSize = Number(form.querySelector<HTMLInputElement>('[data-canvas-text-size]')?.value)
    const fill = form.querySelector<HTMLInputElement>('[data-canvas-text-fill]')?.value.trim() ?? ''
    if (!canvasId) throw new Error('IMAGE_WORKBENCH_CANVAS_SELECTION_REQUIRED')
    await this.addCanvasTextLayer(canvasId, { text, x, y, font_size: fontSize, fill })
  }

  private async updateCanvasTextFromForm(form: HTMLFormElement): Promise<void> {
    const canvasId = form.dataset.canvasId
    const layerId = form.dataset.layerId
    const text = form.querySelector<HTMLInputElement>('[data-canvas-existing-text]')?.value.trim() ?? ''
    if (!canvasId || !layerId) throw new Error('IMAGE_WORKBENCH_CANVAS_TEXT_LAYER_NOT_FOUND')
    await this.updateCanvasTextLayer(canvasId, layerId, text)
  }

  private async applyBrandKitFromForm(form: HTMLFormElement): Promise<void> {
    const canvasId = form.dataset.canvasId
    const brandKitId = form.querySelector<HTMLSelectElement>('[data-apply-brand-id]')?.value
    if (!canvasId || !brandKitId) throw new Error('IMAGE_WORKBENCH_BRAND_KIT_SELECTION_REQUIRED')
    const projection = this.currentProjection()
    const canvas = this.canvas(canvasId)
    const brand = await this.resolve(this.client.getBrandKit({ brand_kit_id: brandKitId }))
    await this.applyCanvasCommand(canvas.canvas_id, {
      base_project_revision: projection.project.revision,
      command: {
        idempotency_key: this.idempotencyKey(),
        base_revision: canvas.revision,
        kind: 'apply_brand_kit',
        payload: {
          brand_kit_id: brand.brand_kit.id,
          brand_kit_revision_id: brand.revision.id,
        },
      },
    })
  }

  private templateSlotBindings(raw: string, template: ImageTemplateResponse): Array<{
    slot_id: string
    text?: string
    qr_payload?: string
    asset_id?: string
  }> {
    if (!raw.trim()) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('IMAGE_WORKBENCH_TEMPLATE_SLOT_BINDINGS_JSON_INVALID')
    }
    if (!Array.isArray(parsed) || parsed.length > 80) throw new Error('IMAGE_WORKBENCH_TEMPLATE_SLOT_BINDINGS_JSON_INVALID')
    const slots = new Map(template.revision.slots.map(slot => [slot.id, slot]))
    const seen = new Set<string>()
    const bindings = parsed.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('IMAGE_WORKBENCH_TEMPLATE_SLOT_BINDINGS_JSON_INVALID')
      const binding = value as Record<string, unknown>
      const slotId = typeof binding.slot_id === 'string' ? binding.slot_id.trim() : ''
      const text = typeof binding.text === 'string' ? binding.text.trim() : undefined
      const qrPayload = typeof binding.qr_payload === 'string' ? binding.qr_payload.trim() : undefined
      const assetId = typeof binding.asset_id === 'string' ? binding.asset_id.trim() : undefined
      const defined = [text, qrPayload, assetId].filter(item => item !== undefined && item !== '').length
      const slot = slots.get(slotId)
      if (!slot || seen.has(slotId) || defined !== 1) throw new Error('IMAGE_WORKBENCH_TEMPLATE_SLOT_BINDING_INVALID')
      if (
        (slot.kind === 'text' && !text)
        || (slot.kind === 'qrcode' && !qrPayload)
        || ((slot.kind === 'raster' || slot.kind === 'logo') && !assetId)
      ) throw new Error('IMAGE_WORKBENCH_TEMPLATE_SLOT_BINDING_INVALID')
      seen.add(slotId)
      return {
        slot_id: slotId,
        ...(text ? { text } : {}),
        ...(qrPayload ? { qr_payload: qrPayload } : {}),
        ...(assetId ? { asset_id: assetId } : {}),
      }
    })
    if (template.revision.slots.some(slot => slot.required && !seen.has(slot.id))) {
      throw new Error('IMAGE_WORKBENCH_TEMPLATE_REQUIRED_SLOT_MISSING')
    }
    return bindings
  }

  private async applyTemplateFromForm(form: HTMLFormElement): Promise<void> {
    const canvasId = form.dataset.canvasId
    const templateId = form.querySelector<HTMLSelectElement>('[data-apply-template-id]')?.value
    const rawBindings = form.querySelector<HTMLTextAreaElement>('[data-apply-template-slots]')?.value ?? ''
    if (!canvasId || !templateId) throw new Error('IMAGE_WORKBENCH_TEMPLATE_SELECTION_REQUIRED')
    const projection = this.currentProjection()
    const canvas = this.canvas(canvasId)
    const template = await this.resolve(this.client.getTemplate({ template_id: templateId }))
    const slotBindings = this.templateSlotBindings(rawBindings, template)
    await this.applyCanvasCommand(canvas.canvas_id, {
      base_project_revision: projection.project.revision,
      command: {
        idempotency_key: this.idempotencyKey(),
        base_revision: canvas.revision,
        kind: 'apply_template',
        payload: {
          template_id: template.template.id,
          template_revision_id: template.revision.id,
          slot_bindings: slotBindings,
        },
      },
    })
  }

  private async grantReusableAssetFromForm(form: HTMLFormElement): Promise<void> {
    const assetId = form.querySelector<HTMLInputElement>('[data-grant-asset-id]')?.value.trim() ?? ''
    const target = form.querySelector<HTMLSelectElement>('[data-grant-target]')?.value ?? ''
    const purpose = form.querySelector<HTMLSelectElement>('[data-grant-purpose]')?.value
    const separator = target.indexOf(':')
    const kind = separator > 0 ? target.slice(0, separator) : ''
    const id = separator > 0 ? target.slice(separator + 1) : ''
    const targetOwner: { kind: 'brand_kit' | 'template'; id: string } | undefined = kind === 'brand_kit' || kind === 'template'
      ? { kind, id }
      : undefined
    const grantPurpose: 'render' | 'template_use' | 'project_reuse' | undefined = purpose === 'render' || purpose === 'template_use' || purpose === 'project_reuse'
      ? purpose
      : undefined
    const validPurpose = targetOwner?.kind === 'brand_kit'
      ? grantPurpose === 'render' || grantPurpose === 'template_use'
      : targetOwner?.kind === 'template'
        ? grantPurpose === 'template_use'
        : false
    if (!assetId || !targetOwner || !targetOwner.id || !grantPurpose || !validPurpose) throw new Error('IMAGE_WORKBENCH_ASSET_GRANT_INVALID')
    await this.resolve(this.client.createAssetGrant({
      input: {
        idempotency_key: this.idempotencyKey(),
        asset_id: assetId,
        to_owner: targetOwner,
        purpose: grantPurpose,
      },
    }))
    await this.refreshReusableDesigns()
  }

  private async revokeAssetGrantFromButton(grantId: string): Promise<void> {
    await this.resolve(this.client.revokeAssetGrant({
      grant_id: grantId,
      input: { idempotency_key: this.idempotencyKey() },
    }))
    await this.refreshReusableDesigns()
  }

  private async applyBriefOverridesFromForm(form: HTMLFormElement): Promise<void> {
    const projection = this.currentProjection()
    const briefId = projection.project.current_brief_id
    if (!briefId) throw new Error('IMAGE_WORKBENCH_BRIEF_REQUIRED')
    const confirmedFacts = this.linesFromForm(form, '[data-brief-confirmed-facts]', 40)
    const mustPreserve = this.linesFromForm(form, '[data-brief-must-preserve]', 40)
    const mayChange = this.linesFromForm(form, '[data-brief-may-change]', 40)
    const exactText = this.linesFromForm(form, '[data-brief-exact-text]', 40)
    if (confirmedFacts.length + mustPreserve.length + mayChange.length + exactText.length === 0) {
      throw new Error('IMAGE_WORKBENCH_BRIEF_OVERRIDES_REQUIRED')
    }
    await this.applyBriefOverrides(briefId, {
      idempotency_key: this.idempotencyKey(),
      base_revision: projection.project.revision,
      overrides: {
        ...(confirmedFacts.length > 0 ? { confirmed_facts: confirmedFacts } : {}),
        ...(mustPreserve.length > 0 ? { must_preserve: mustPreserve } : {}),
        ...(mayChange.length > 0 ? { may_change: mayChange } : {}),
        ...(exactText.length > 0 ? { exact_text: exactText } : {}),
      },
    })
  }

  private async createDefaultCreativePlan(): Promise<void> {
    const projection = this.currentProjection()
    await this.createCreativePlan({
      idempotency_key: this.idempotencyKey(),
      base_revision: projection.project.revision,
    })
  }

  private async estimateGenerationFromForm(form: HTMLFormElement): Promise<void> {
    const projection = this.currentProjection()
    const creativePlanId = form.querySelector<HTMLSelectElement>('[data-generation-plan-id]')?.value
    const plan = projection.creative_plans.find(value => value.id === creativePlanId)
    if (!plan) throw new Error('IMAGE_WORKBENCH_CREATIVE_PLAN_REQUIRED')
    await this.estimateGenerationRound({
      base_revision: projection.project.revision,
      creative_plan_id: plan.id,
      direction_ids: plan.directions.map(direction => direction.id),
    })
  }

  private async confirmGenerationFromQuote(form: HTMLFormElement): Promise<void> {
    const projection = this.currentProjection()
    const creativePlanId = form.querySelector<HTMLInputElement>('[data-generation-confirm-plan-id]')?.value
    const quote = this.generationQuote
    if (
      !quote
      || !creativePlanId
      || quote.creative_plan_id !== creativePlanId
      || !quoteIsActive(quote, projection.project.id, projection.project.revision, quote.project_id, quote.project_revision)
    ) {
      throw new Error('IMAGE_WORKBENCH_GENERATION_ESTIMATE_REQUIRED')
    }
    if (quote.direction_ids.length === 0) throw new Error('IMAGE_WORKBENCH_GENERATION_DIRECTION_REQUIRED')
    await this.createGenerationRound({
      idempotency_key: this.idempotencyKey(),
      base_revision: projection.project.revision,
      creative_plan_id: quote.creative_plan_id,
      direction_ids: [...quote.direction_ids],
      estimate_hash: quote.estimate_hash,
      confirm: true,
    })
    this.generationQuote = undefined
    this.render()
  }

  private async upsertInspirationFromForm(form: HTMLFormElement): Promise<void> {
    const file = form.querySelector<HTMLInputElement>('[data-inspiration-file]')?.files?.[0]
    const note = form.querySelector<HTMLInputElement>('[data-inspiration-note]')?.value.trim() || undefined
    if (!file) throw new Error('IMAGE_WORKBENCH_INSPIRATION_FILE_REQUIRED')
    const projection = this.currentProjection()
    await this.upsertInspirationItems({
      idempotency_key: this.idempotencyKey(),
      base_revision: projection.project.revision,
      items: [{ data_url: await fileAsDataUrl(file), ...(note ? { note } : {}) }],
    })
  }

  private async promoteInspirationFromForm(form: HTMLFormElement): Promise<void> {
    const inspirationItemId = form.dataset.inspirationId
    const role = form.querySelector<HTMLSelectElement>('[data-inspiration-role]')?.value
    const influence = form.querySelector<HTMLSelectElement>('[data-inspiration-influence]')?.value
    const preservation = form.querySelector<HTMLSelectElement>('[data-inspiration-preservation]')?.value
    const priority = Number(form.querySelector<HTMLInputElement>('[data-inspiration-priority]')?.value)
    if (
      !inspirationItemId
      || (role !== 'product' && role !== 'style' && role !== 'composition' && role !== 'brand' && role !== 'logo')
      || (influence !== 'low' && influence !== 'medium' && influence !== 'high')
      || (preservation !== 'may_change' && preservation !== 'prefer_preserve' && preservation !== 'must_preserve')
      || !Number.isInteger(priority) || priority < 0 || priority > 1_000
    ) throw new Error('IMAGE_WORKBENCH_INSPIRATION_PROMOTION_INVALID')
    await this.promoteInspirationItem(inspirationItemId, {
      idempotency_key: this.idempotencyKey(),
      base_revision: this.currentProjection().project.revision,
      role,
      influence_strength: influence,
      preservation,
      priority,
    })
  }

  private deliveryOutput(format: string): ImageDeliverySpecRevisionInput['artboards'][number]['output'] {
    if (format === 'png') return { format: 'png', transparent: false }
    if (format === 'jpeg') return { format: 'jpeg', quality: 92, background_color: '#ffffff' }
    if (format === 'webp') return { format: 'webp', quality: 92, transparent: false }
    throw new Error('IMAGE_WORKBENCH_DELIVERY_OUTPUT_INVALID')
  }

  private deliverySafeArea(raw: unknown, width: number, height: number): { top: number; right: number; bottom: number; left: number } | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('IMAGE_WORKBENCH_DELIVERY_SAFE_AREA_INVALID')
    const values = (['top', 'right', 'bottom', 'left'] as const).map(key => {
      const value = (raw as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.trim() === '') return undefined
      const number = typeof value === 'number' ? value : Number(value)
      return Number.isInteger(number) && number >= 0 ? number : undefined
    })
    if (values.every(value => value === undefined)) return undefined
    if (values.some(value => value === undefined)) throw new Error('IMAGE_WORKBENCH_DELIVERY_SAFE_AREA_INVALID')
    const [top, right, bottom, left] = values as [number, number, number, number]
    if (left + right > width || top + bottom > height) throw new Error('IMAGE_WORKBENCH_DELIVERY_SAFE_AREA_INVALID')
    return { top, right, bottom, left }
  }

  private extraDeliveryArtboardsFromForm(
    form: HTMLFormElement,
    defaultFormat: string,
  ): ImageDeliverySpecRevisionInput['artboards'] {
    const raw = form.querySelector<HTMLTextAreaElement>('[data-delivery-artboards]')?.value.trim() ?? ''
    if (!raw) return []
    let drafts: unknown
    try {
      drafts = JSON.parse(raw)
    } catch {
      throw new Error('IMAGE_WORKBENCH_DELIVERY_ARTBOARDS_JSON_INVALID')
    }
    if (!Array.isArray(drafts) || drafts.length > 31) throw new Error('IMAGE_WORKBENCH_DELIVERY_ARTBOARDS_JSON_INVALID')
    return drafts.map((draft, index) => {
      if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('IMAGE_WORKBENCH_DELIVERY_ARTBOARDS_JSON_INVALID')
      const value = draft as Record<string, unknown>
      const label = typeof value.label === 'string' ? value.label.trim() : ''
      const width = Number(value.width)
      const height = Number(value.height)
      const format = value.format === undefined ? defaultFormat : value.format
      if (
        !label || label.length > 120
        || !Number.isInteger(width) || width < 1 || width > 12_000
        || !Number.isInteger(height) || height < 1 || height > 12_000
        || typeof format !== 'string'
      ) throw new Error('IMAGE_WORKBENCH_DELIVERY_ARTBOARDS_JSON_INVALID')
      const safeArea = value.safe_area === undefined ? undefined : this.deliverySafeArea(value.safe_area, width, height)
      return {
        id: this.localEntityId(`artboard_${index + 2}`),
        label,
        width,
        height,
        required: false,
        ...(safeArea ? { safe_area: safeArea } : {}),
        output: this.deliveryOutput(format),
      }
    })
  }

  private async createDeliverySpecFromForm(form: HTMLFormElement): Promise<void> {
    const purpose = form.querySelector<HTMLSelectElement>('[data-delivery-purpose]')?.value
    const label = form.querySelector<HTMLInputElement>('[data-delivery-label]')?.value.trim() ?? ''
    const width = Number(form.querySelector<HTMLInputElement>('[data-delivery-width]')?.value)
    const height = Number(form.querySelector<HTMLInputElement>('[data-delivery-height]')?.value)
    const format = form.querySelector<HTMLSelectElement>('[data-delivery-format]')?.value
    if (
      (purpose !== 'social_cover' && purpose !== 'product_marketing' && purpose !== 'poster' && purpose !== 'custom')
      || !label || label.length > 120
      || !Number.isInteger(width) || width < 1 || width > 12_000
      || !Number.isInteger(height) || height < 1 || height > 12_000
      || (format !== 'png' && format !== 'jpeg' && format !== 'webp')
    ) throw new Error('IMAGE_WORKBENCH_DELIVERY_SPEC_INVALID')
    const safeArea = this.deliverySafeArea({
      top: form.querySelector<HTMLInputElement>('[data-delivery-safe-top]')?.value ?? '',
      right: form.querySelector<HTMLInputElement>('[data-delivery-safe-right]')?.value ?? '',
      bottom: form.querySelector<HTMLInputElement>('[data-delivery-safe-bottom]')?.value ?? '',
      left: form.querySelector<HTMLInputElement>('[data-delivery-safe-left]')?.value ?? '',
    }, width, height)
    const artboards = [{
      id: this.localEntityId('artboard'),
      label,
      width,
      height,
      required: true,
      ...(safeArea ? { safe_area: safeArea } : {}),
      output: this.deliveryOutput(format),
    }, ...this.extraDeliveryArtboardsFromForm(form, format)]
    await this.createDeliverySpec({
      idempotency_key: this.idempotencyKey(),
      base_revision: this.currentProjection().project.revision,
      purpose,
      artboards,
    })
  }

  private async createBrandKitFromForm(form: HTMLFormElement): Promise<void> {
    const name = form.querySelector<HTMLInputElement>('[data-brand-name]')?.value.trim() ?? ''
    if (!name || name.length > 160) throw new Error('IMAGE_WORKBENCH_BRAND_KIT_NAME_REQUIRED')
    await this.createBrandKit({
      idempotency_key: this.idempotencyKey(),
      name,
      revision: { logo_asset_ids: [], font_asset_ids: [], color_tokens: {}, required_text: [] },
    })
  }

  private async reviseBrandKitFromForm(form: HTMLFormElement): Promise<void> {
    const brandKitId = form.querySelector<HTMLSelectElement>('[data-brand-revise-id]')?.value
    const colorToken = form.querySelector<HTMLInputElement>('[data-brand-color-token]')?.value.trim()
    const colorValue = form.querySelector<HTMLInputElement>('[data-brand-color-value]')?.value.trim()
    const logoAssetId = form.querySelector<HTMLInputElement>('[data-brand-logo-asset-id]')?.value.trim()
    if (!brandKitId || !colorToken || !colorValue || !/^[a-z][a-z0-9_]{0,63}$/u.test(colorToken) || !/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/u.test(colorValue)) {
      throw new Error('IMAGE_WORKBENCH_BRAND_KIT_REVISION_INVALID')
    }
    const current = await this.resolve(this.client.getBrandKit({ brand_kit_id: brandKitId }))
    if (logoAssetId) {
      await this.resolve(this.client.createAssetGrant({
        input: {
          idempotency_key: this.idempotencyKey(),
          asset_id: logoAssetId,
          to_owner: { kind: 'brand_kit', id: brandKitId },
          purpose: 'render',
        },
      }))
    }
    await this.reviseBrandKit(brandKitId, {
      idempotency_key: this.idempotencyKey(),
      base_revision: current.brand_kit.revision,
      revision: {
        logo_asset_ids: [...new Set([...current.revision.logo_asset_ids, ...(logoAssetId ? [logoAssetId] : [])])],
        font_asset_ids: current.revision.font_asset_ids,
        color_tokens: { ...current.revision.color_tokens, [colorToken]: colorValue },
        required_text: current.revision.required_text,
      },
    })
  }

  private async trashBrandKit(brandKitId: string): Promise<void> {
    const brandKit = this.brandKits.find(value => value.id === brandKitId)
    if (!brandKit) throw new Error('IMAGE_WORKBENCH_BRAND_KIT_NOT_FOUND')
    await this.deleteBrandKit(brandKitId, {
      idempotency_key: this.idempotencyKey(),
      base_revision: brandKit.revision,
    })
  }

  private async createTemplateFromForm(form: HTMLFormElement): Promise<void> {
    const name = form.querySelector<HTMLInputElement>('[data-template-name]')?.value.trim() ?? ''
    const width = Number(form.querySelector<HTMLInputElement>('[data-template-width]')?.value)
    const height = Number(form.querySelector<HTMLInputElement>('[data-template-height]')?.value)
    const brandKitId = form.querySelector<HTMLSelectElement>('[data-template-brand-kit-id]')?.value
    if (!name || name.length > 160 || !Number.isInteger(width) || width < 1 || width > 12_000 || !Number.isInteger(height) || height < 1 || height > 12_000) {
      throw new Error('IMAGE_WORKBENCH_TEMPLATE_INPUT_INVALID')
    }
    const brand = brandKitId ? await this.resolve(this.client.getBrandKit({ brand_kit_id: brandKitId })) : undefined
    await this.createTemplate({
      idempotency_key: this.idempotencyKey(),
      name,
      revision: {
        ...(brand ? {
          brand_kit_id: brand.brand_kit.id,
          brand_kit_revision_id: brand.revision.id,
        } : {}),
        blueprint: {
          schema_version: 1,
          artboard: { width, height },
          background: { kind: 'solid', color: '#ffffff' },
          layers: [],
        },
        slots: [],
        schema_version: 1,
      },
    })
  }

  private async reviseTemplateFromForm(form: HTMLFormElement): Promise<void> {
    const templateId = form.querySelector<HTMLSelectElement>('[data-template-revise-id]')?.value
    const text = form.querySelector<HTMLInputElement>('[data-template-text]')?.value.trim() ?? ''
    const layerKind = form.querySelector<HTMLSelectElement>('[data-template-layer-kind]')?.value
    const slotId = form.querySelector<HTMLInputElement>('[data-template-slot-id]')?.value.trim() ?? ''
    const slotRequired = form.querySelector<HTMLInputElement>('[data-template-slot-required]')?.checked ?? false
    const logoAssetId = form.querySelector<HTMLInputElement>('[data-template-logo-asset-id]')?.value.trim() ?? ''
    if (
      !templateId || (layerKind !== 'text' && layerKind !== 'qrcode' && layerKind !== 'logo')
      || (layerKind !== 'logo' && (!text || text.length > 2_000))
      || (layerKind === 'logo' && !logoAssetId)
      || (layerKind !== 'logo' && logoAssetId)
      || (slotId !== '' && !/^[A-Za-z0-9_-]{1,120}$/u.test(slotId))
    ) throw new Error('IMAGE_WORKBENCH_TEMPLATE_REVISION_INVALID')
    const current = await this.resolve(this.client.getTemplate({ template_id: templateId }))
    if (current.revision.blueprint.layers.length >= 80) throw new Error('IMAGE_WORKBENCH_TEMPLATE_LAYER_LIMIT')
    if (slotId && current.revision.slots.some(slot => slot.id === slotId)) throw new Error('IMAGE_WORKBENCH_TEMPLATE_SLOT_EXISTS')
    const artboard = current.revision.blueprint.artboard
    if (layerKind === 'logo') {
      await this.resolve(this.client.createAssetGrant({
        input: {
          idempotency_key: this.idempotencyKey(),
          asset_id: logoAssetId,
          to_owner: { kind: 'template', id: templateId },
          purpose: 'template_use',
        },
      }))
    }
    const layer: ImageCanvasLayer = layerKind === 'logo'
      ? {
          id: this.localEntityId('layer'),
          kind: 'logo',
          source_asset_id: logoAssetId,
          transform: {
            x: Math.max(0, artboard.width - 240),
            y: 80,
            width: 160,
            height: 160,
            rotation_degrees: 0,
            scale_x: 1,
            scale_y: 1,
          },
          preserve_exact_source: true,
          render_mode: 'raster_exact',
        }
      : layerKind === 'qrcode'
        ? {
            id: this.localEntityId('layer'),
            kind: 'qrcode',
            source: { kind: 'payload', value: text },
            transform: { x: 80, y: 80, width: 160, height: 160, rotation_degrees: 0, scale_x: 1, scale_y: 1 },
            error_correction: 'Q',
            quiet_zone_modules: 4,
            verify_after_render: true,
          }
        : {
            id: this.localEntityId('layer'),
            kind: 'text',
            text,
            font_family: 'PingFang SC',
            font_asset_id: 'font_builtin_0001',
            font_size: 64,
            min_font_size: 24,
            font_weight: 700,
            font_style: 'normal',
            line_height: 1.2,
            letter_spacing: 0,
            fill: '#101820',
            position: { x: 80, y: 80 },
            rotation_degrees: 0,
            max_width: Math.max(1, artboard.width - 160),
            max_height: Math.max(1, artboard.height - 160),
            overflow: 'shrink_to_fit',
            locale: 'zh-CN',
            align: 'left',
            scale_x: 1,
            scale_y: 1,
            opacity: 1,
          }
    const slots = slotId ? [...current.revision.slots, {
      id: slotId,
      layer_id: layer.id,
      kind: layer.kind,
      required: slotRequired,
    }] : current.revision.slots
    await this.reviseTemplate(templateId, {
      idempotency_key: this.idempotencyKey(),
      base_revision: current.template.revision,
      revision: {
        ...(current.revision.brand_kit_id && current.revision.brand_kit_revision_id
          ? { brand_kit_id: current.revision.brand_kit_id, brand_kit_revision_id: current.revision.brand_kit_revision_id }
          : {}),
        blueprint: {
          ...current.revision.blueprint,
          layers: [...current.revision.blueprint.layers, layer],
        },
        slots,
        schema_version: 1,
      },
    })
  }

  private async trashTemplate(templateId: string): Promise<void> {
    const template = this.templates.find(value => value.id === templateId)
    if (!template) throw new Error('IMAGE_WORKBENCH_TEMPLATE_NOT_FOUND')
    await this.deleteTemplate(templateId, {
      idempotency_key: this.idempotencyKey(),
      base_revision: template.revision,
    })
  }

  private async addFilesAsReferences(form: HTMLFormElement): Promise<void> {
    const fileInput = form.querySelector<HTMLInputElement>('[data-reference-files]')
    const role = form.querySelector<HTMLSelectElement>('[data-reference-role]')?.value
    const influence = form.querySelector<HTMLSelectElement>('[data-reference-influence]')?.value
    const preservation = form.querySelector<HTMLSelectElement>('[data-reference-preservation]')?.value
    const priority = Number(form.querySelector<HTMLInputElement>('[data-reference-priority]')?.value)
    if (
      !fileInput?.files?.length
      || (role !== 'product' && role !== 'style' && role !== 'composition' && role !== 'brand' && role !== 'logo')
      || (influence !== 'low' && influence !== 'medium' && influence !== 'high')
      || (preservation !== 'may_change' && preservation !== 'prefer_preserve' && preservation !== 'must_preserve')
      || !Number.isInteger(priority) || priority < 0 || priority > 1_000
    ) {
      this.setNotice('请选择带有明确角色的参考图。')
      return
    }
    const dataUrls = await Promise.all([...fileInput.files].map(fileAsDataUrl))
    const project = this.projection?.project
    if (!project) throw new Error('IMAGE_WORKBENCH_PROJECT_SELECTION_REQUIRED')
    await this.addReferences({
      idempotency_key: this.idempotencyKey(),
      base_revision: project.revision,
      references: dataUrls.map(dataUrl => ({
        data_url: dataUrl,
        role,
        influence_strength: influence,
        preservation,
        priority,
      })),
    })
  }

  private async updateReferenceControlFromForm(form: HTMLFormElement): Promise<void> {
    const referenceId = form.querySelector<HTMLSelectElement>('[data-reference-control-id]')?.value
    const role = form.querySelector<HTMLSelectElement>('[data-reference-control-role]')?.value
    const influence = form.querySelector<HTMLSelectElement>('[data-reference-control-influence]')?.value
    const preservation = form.querySelector<HTMLSelectElement>('[data-reference-control-preservation]')?.value
    const priority = Number(form.querySelector<HTMLInputElement>('[data-reference-control-priority]')?.value)
    if (
      !referenceId
      || (role !== 'product' && role !== 'style' && role !== 'composition' && role !== 'brand' && role !== 'logo')
      || (influence !== 'low' && influence !== 'medium' && influence !== 'high')
      || (preservation !== 'may_change' && preservation !== 'prefer_preserve' && preservation !== 'must_preserve')
      || !Number.isInteger(priority) || priority < 0 || priority > 1_000
    ) {
      throw new Error('IMAGE_WORKBENCH_REFERENCE_CONTROL_INVALID')
    }
    await this.updateReferenceControl(referenceId, {
      idempotency_key: this.idempotencyKey(),
      base_revision: this.currentProjection().project.revision,
      role,
      influence_strength: influence,
      preservation,
      priority,
    })
  }

  private campaignItemsFromForm(value: string): CreateImageCampaignInput['items'] {
    const raw = value.trim()
    if (!raw) throw new Error('IMAGE_WORKBENCH_CAMPAIGN_ITEMS_REQUIRED')
    if (!raw.startsWith('[')) throw new Error('IMAGE_WORKBENCH_CAMPAIGN_ITEMS_JSON_REQUIRED')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('IMAGE_WORKBENCH_CAMPAIGN_ITEMS_INVALID')
    }
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('IMAGE_WORKBENCH_CAMPAIGN_ITEMS_INVALID')
    return parsed.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('IMAGE_WORKBENCH_CAMPAIGN_ITEMS_INVALID')
        const values = (item as Record<string, unknown>).variable_values
        if (!Array.isArray(values) || values.length > 80) throw new Error('IMAGE_WORKBENCH_CAMPAIGN_ITEMS_INVALID')
        const seen = new Set<string>()
        return {
          variable_values: values.map(variable => {
            if (!variable || typeof variable !== 'object' || Array.isArray(variable)) throw new Error('IMAGE_WORKBENCH_CAMPAIGN_ITEMS_INVALID')
            const variableRecord = variable as Record<string, unknown>
            const rawSlotId = variableRecord.slot_id
            const rawValue = variableRecord.value
            const slotId = typeof rawSlotId === 'string'
              ? rawSlotId.trim()
              : ''
            const itemValue = typeof rawValue === 'string'
              ? rawValue.trim()
              : ''
            if (!slotId || !itemValue || seen.has(slotId) || slotId.length > 120 || itemValue.length > 2_000) {
              throw new Error('IMAGE_WORKBENCH_CAMPAIGN_ITEMS_INVALID')
            }
            seen.add(slotId)
            return { slot_id: slotId, value: itemValue }
          }),
        }
    })
  }

  private async createCampaignFromForm(form: HTMLFormElement): Promise<void> {
    const name = form.querySelector<HTMLInputElement>('[data-campaign-name]')?.value.trim() ?? ''
    const userRequest = form.querySelector<HTMLInputElement>('[data-campaign-request]')?.value.trim() ?? ''
    const outputPreset = form.querySelector<HTMLSelectElement>('[data-campaign-preset]')?.value
    const templateId = form.querySelector<HTMLSelectElement>('[data-campaign-template-id]')?.value || undefined
    const selectedBrandKitId = form.querySelector<HTMLSelectElement>('[data-campaign-brand-kit-id]')?.value || undefined
    const itemsValue = form.querySelector<HTMLTextAreaElement>('[data-campaign-items]')?.value ?? ''
    const budgetCurrency = form.querySelector<HTMLInputElement>('[data-campaign-budget-currency]')?.value.trim().toUpperCase() ?? ''
    const budgetMinorRaw = form.querySelector<HTMLInputElement>('[data-campaign-budget-minor]')?.value.trim() ?? ''
    const budgetMinor = budgetMinorRaw === '' ? undefined : Number(budgetMinorRaw)
    if (
      !name || !userRequest
      || (outputPreset !== 'square' && outputPreset !== 'landscape' && outputPreset !== 'portrait')
      || (budgetMinor !== undefined && (!/^[A-Z]{3}$/u.test(budgetCurrency) || !Number.isSafeInteger(budgetMinor) || budgetMinor < 1))
    ) {
      throw new Error('IMAGE_WORKBENCH_CAMPAIGN_INPUT_INVALID')
    }
    const template = templateId ? await this.resolve(this.client.getTemplate({ template_id: templateId })) : undefined
    const selectedBrand = selectedBrandKitId
      ? await this.resolve(this.client.getBrandKit({ brand_kit_id: selectedBrandKitId }))
      : undefined
    const templateBrand = template?.revision.brand_kit_id && template.revision.brand_kit_revision_id
      ? { id: template.revision.brand_kit_id, revision_id: template.revision.brand_kit_revision_id }
      : undefined
    if (selectedBrand && templateBrand && (
      selectedBrand.brand_kit.id !== templateBrand.id || selectedBrand.revision.id !== templateBrand.revision_id
    )) throw new Error('IMAGE_WORKBENCH_CAMPAIGN_TEMPLATE_BRAND_MISMATCH')
    const brand = templateBrand ?? (selectedBrand
      ? { id: selectedBrand.brand_kit.id, revision_id: selectedBrand.revision.id }
      : undefined)
    await this.createCampaign({
      idempotency_key: this.idempotencyKey(),
      name,
      ...(template ? { template_id: template.template.id, template_revision_id: template.revision.id } : {}),
      ...(brand ? { brand_kit_id: brand.id, brand_kit_revision_id: brand.revision_id } : {}),
      shared_brief: { user_request: userRequest, confirmed_facts: [], must_preserve: [] },
      output_preset: outputPreset,
      ...(budgetMinor === undefined ? {} : { budget_limit: { currency: budgetCurrency, amount_minor: budgetMinor } }),
      items: this.campaignItemsFromForm(itemsValue),
    })
  }

  private async runInteractive<Value>(operation: () => Promise<Value>): Promise<void> {
    try {
      await operation()
      this.setNotice(undefined)
    } catch (error) {
      this.setNotice(error instanceof Error ? error.message : '图片操作未完成。')
    }
  }
}

export function createImageWorkbenchShell(options: ImageWorkbenchShellOptions): ImageWorkbenchShell {
  return new ImageWorkbenchShell(options)
}
