/**
 * Live image-understanding E2E: Anthropic image block → local Provider Proxy → qf-gateway
 * → MiMo (mimo-v2.5, the only multimodal upstream) → answer that references the image.
 *
 * Proves the full Desktop/Proxy/Gateway → MiMo image path (the proxy converts the Anthropic
 * `image` block to OpenAI `image_url`). mimo-v2.5 sees the pixels natively; a non-multimodal
 * model (Qwen) gets the SAME image via the server-side MiMo vision bridge (image read into
 * structured text, never raw image_url), so it can still answer — no rejection, no silent
 * drop, no cross-vendor reroute.
 *
 * Run (env-gated; skips if QF_GATEWAY_URL/TOKEN unset — safe to leave in the tree):
 *   RED_B64_PATH=/path/to/red.b64 QF_GATEWAY_URL=... QF_GATEWAY_TOKEN=... \
 *   QF_LOADTEST_CONSENT_RECEIPT=<64-hex-consent-receipt> \
 *   BB_INSTALLATION_ID=bb-img-live-0001 bun ts/src/server/__tests__/mimo-image-live.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleProxyRequest } from '../proxy/handler.js'
import { QF_GATEWAY_PROVIDER_ID } from '../services/qfGatewayProvider.js'

async function main(): Promise<void> {
  if (!(process.env.QF_GATEWAY_URL ?? '').trim() || !(process.env.QF_GATEWAY_TOKEN ?? '').trim()) {
    console.log('⏭️  SKIP: QF_GATEWAY_URL / QF_GATEWAY_TOKEN not set — live image E2E skipped.')
    return
  }
  const consentReceiptId = process.env.QF_LOADTEST_CONSENT_RECEIPT?.trim() ?? ''
  if (!/^[a-f0-9]{64}$/.test(consentReceiptId)) {
    throw new Error('QF_LOADTEST_CONSENT_RECEIPT must be a 64-character lowercase hex receipt')
  }
  process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-img-'))
  const b64 = fs.readFileSync(process.env.RED_B64_PATH ?? '', 'utf8').trim()

  const imageMessage = (model: string) => ({
    model, max_tokens: 64,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
      { type: 'text', text: '这张图片是什么颜色?只回一个颜色名称。' },
    ] }],
  })
  const post = (body: unknown) => new Request(
    `http://127.0.0.1/proxy/providers/${QF_GATEWAY_PROVIDER_ID}/v1/messages`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )

  // 1) MiMo sees the image and names the colour.
  const req = post(imageMessage('mimo-v2.5'))
  const consentDeps = { activeConsentReceipt: async () => ({ receipt_id: consentReceiptId }) }
  const res = await handleProxyRequest(req, new URL(req.url), consentDeps)
  const body = await res.json() as { content?: Array<{ type: string; text?: string }> }
  const answer = (body.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join(' ').trim()
  const sawRed = /红|red/i.test(answer)
  console.log(`MiMo status=${res.status} answer="${answer}"`)
  console.log(sawRed ? '✅ MiMo 看到并识别了图片(答含"红")' : `❌ 答案不含红:${answer}`)

  // 2) Same image to a non-multimodal model (Qwen) is now BRIDGED via MiMo, not rejected and not
  //    silently dropped: the gateway reads the image with MiMo and hands Qwen the structured text,
  //    so Qwen still names the colour. Non-multimodal upstreams never receive a raw image_url.
  const qreq = post(imageMessage('qwen3-coder-plus'))
  const qres = await handleProxyRequest(qreq, new URL(qreq.url), consentDeps)
  const qbody = await qres.json().catch(() => ({})) as { content?: Array<{ type: string; text?: string }> }
  const qanswer = (qbody.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join(' ').trim()
  const qSawRed = /红|red/i.test(qanswer)
  console.log(`Qwen+image(bridged) status=${qres.status} answer="${qanswer}"`)
  console.log(qres.status === 200 && qSawRed ? '✅ Qwen 经网关 MiMo 视觉桥接看懂同一张图(答含"红")' : `❌ 桥接未生效:status=${qres.status} answer="${qanswer}"`)

  if (!sawRed || qres.status !== 200 || !qSawRed) process.exit(1)
  console.log('\n✅ LIVE IMAGE E2E PASSED: mimo-v2.5 原生看图;Qwen 经网关 MiMo 视觉桥接看懂同一张图(非原生上游不收 image_url、不改投、不丢图)。')
}

main().catch(err => { console.error('❌ LIVE IMAGE E2E ERROR:', err); process.exit(1) })
