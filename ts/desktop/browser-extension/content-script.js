let enabled = false
let scanTimer = null
const cardByRef = new Map()

const CARD_SELECTORS = [
  '[data-geekid]', '[data-geek-id]', '[data-candidate-id]',
  '.candidate-card-wrap', '.candidate-card', '.geek-item-card', '.candidate-item',
]
const NAME_SELECTORS = ['[class*="name"]', '[class*="geek-name"]', '[data-candidate-name]']
const HEADLINE_SELECTORS = ['[class*="position"]', '[class*="expect"]', '[class*="job"]']
const EXPERIENCE_SELECTORS = ['[class*="experience"]', '[class*="work"]', '[class*="advantage"]']
const SKILL_SELECTORS = ['[class*="tag"]', '[class*="skill"]']
const PROTECTED_TEXT = /(?:\d{1,2}\s*岁|年龄|性别|婚育|已婚|未婚|民族|籍贯|身高|体重|健康|残疾|怀孕|宗教|政治面貌|身份证)/u

function visible(element) {
  if (!(element instanceof HTMLElement)) return false
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
}

function cleanText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return PROTECTED_TEXT.test(text) ? '' : text.slice(0, max)
}

function firstText(card, selectors, max) {
  for (const selector of selectors) {
    const element = card.querySelector(selector)
    const text = cleanText(element?.textContent, max)
    if (text) return text
  }
  return ''
}

function stableHash(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash >>> 0).toString(36)
}

function candidateRef(card, index, name) {
  const raw = card.getAttribute('data-geekid') || card.getAttribute('data-geek-id') || card.getAttribute('data-candidate-id')
  const normalized = raw?.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96)
  return normalized && normalized.length >= 8 ? `candidate_${normalized}` : `candidate_${stableHash(`${location.pathname}:${index}:${name}`)}`
}

function candidateCards() {
  const found = new Set()
  for (const selector of CARD_SELECTORS) document.querySelectorAll(selector).forEach(element => { if (visible(element)) found.add(element) })
  return [...found].filter(element => ![...found].some(other => other !== element && other.contains(element))).slice(0, 100)
}

function snapshot() {
  cardByRef.clear()
  const candidates = candidateCards().map((card, index) => {
    const displayName = firstText(card, NAME_SELECTORS, 80) || `候选人 ${index + 1}`
    const ref = candidateRef(card, index, displayName)
    cardByRef.set(ref, card)
    const skills = [...card.querySelectorAll(SKILL_SELECTORS.join(','))]
      .map(element => cleanText(element.textContent, 80))
      .filter(Boolean)
      .filter((value, itemIndex, values) => values.indexOf(value) === itemIndex)
      .slice(0, 30)
    return {
      candidate_ref: ref,
      display_name: displayName,
      headline: firstText(card, HEADLINE_SELECTORS, 240),
      experience_summary: firstText(card, EXPERIENCE_SELECTORS, 1000),
      skills,
    }
  })
  const revisionSource = `${location.href}|${candidates.map(candidate => `${candidate.candidate_ref}:${candidate.headline}:${candidate.experience_summary}:${candidate.skills.join(',')}`).join('|')}`
  return {
    page_revision: `page_revision_${stableHash(revisionSource)}`,
    url: location.href,
    title: cleanText(document.title, 240),
    captured_at: new Date().toISOString(),
    candidates,
  }
}

function publishSnapshot() {
  if (!enabled) return
  chrome.runtime.sendMessage({ type: 'bb_browser_snapshot', page: snapshot() })
}

function uniqueButton(root, labels) {
  const matches = [...root.querySelectorAll('button, [role="button"], a')]
    .filter(visible)
    .filter(element => labels.includes(cleanText(element.textContent, 40)))
  return matches.length === 1 ? matches[0] : null
}

function setComposerText(element, text) {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
    setter?.call(element, text)
  } else if (element instanceof HTMLElement && element.isContentEditable) {
    element.textContent = text
  } else return false
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await wait(200)
  }
  return false
}

function editorText(element) {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value.trim()
  return element instanceof HTMLElement ? (element.textContent || '').trim() : ''
}

function hasVisibleText(labels) {
  return [...document.querySelectorAll('button, [role="button"], a, span, div')]
    .filter(visible)
    .some(element => labels.includes(cleanText(element.textContent, 80)))
}

async function execute(command) {
  const current = snapshot()
  if (current.page_revision !== command.page_revision) return { outcome: 'failed', failure_code: 'PAGE_REVISION_CHANGED' }
  const card = cardByRef.get(command.candidate_ref)
  if (!card) return { outcome: 'failed', failure_code: 'CANDIDATE_NOT_FOUND' }

  if (command.action === 'send_message') {
    const open = uniqueButton(card, ['打招呼', '立即沟通', '继续沟通', '沟通'])
    if (!open || typeof command.message !== 'string' || !command.message) return { outcome: 'failed', failure_code: 'ACTION_TARGET_AMBIGUOUS' }
    open.click()
    await wait(800)
    const composers = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter(visible)
    if (composers.length !== 1 || !setComposerText(composers[0], command.message)) return { outcome: 'failed', failure_code: 'MESSAGE_COMPOSER_NOT_FOUND' }
    const send = uniqueButton(document, ['发送'])
    if (!send) return { outcome: 'failed', failure_code: 'SEND_TARGET_AMBIGUOUS' }
    send.click()
    const acknowledged = await waitFor(() => editorText(composers[0]) === '' && document.body.innerText.includes(command.message))
    return acknowledged
      ? { outcome: 'succeeded' }
      : { outcome: 'outcome_unknown', failure_code: 'SEND_ACK_NOT_OBSERVED' }
  }

  const firstLabels = command.action === 'invite' ? ['邀约', '邀请面试'] : ['不合适', '淘汰']
  const confirmLabels = command.action === 'invite' ? ['确认邀请', '发送邀约'] : ['确认不合适', '确认淘汰']
  const first = uniqueButton(card, firstLabels)
  if (!first) return { outcome: 'failed', failure_code: 'ACTION_TARGET_AMBIGUOUS' }
  first.click()
  await wait(500)
  const confirm = uniqueButton(document, confirmLabels)
  if (!confirm) return { outcome: 'failed', failure_code: 'CONFIRM_TARGET_NOT_FOUND' }
  confirm.click()
  const outcomeLabels = command.action === 'invite' ? ['已邀约', '已邀请'] : ['已淘汰', '不合适']
  const acknowledged = await waitFor(() => hasVisibleText(outcomeLabels))
  return acknowledged
    ? { outcome: 'succeeded' }
    : { outcome: 'outcome_unknown', failure_code: 'ACTION_ACK_NOT_OBSERVED' }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'bb_browser_enabled') {
    enabled = Boolean(message.enabled)
    if (enabled) publishSnapshot()
    respond({ ok: true })
    return
  }
  if (message?.type === 'bb_browser_execute') {
    execute(message.command).then(respond).catch(() => respond({ outcome: 'outcome_unknown', failure_code: 'EXTENSION_EXECUTION_INTERRUPTED' }))
    return true
  }
})

new MutationObserver(() => {
  if (!enabled || scanTimer) return
  scanTimer = setTimeout(() => { scanTimer = null; publishSnapshot() }, 500)
}).observe(document.documentElement, { childList: true, subtree: true })
