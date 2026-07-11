#!/usr/bin/env bun
/**
 * 球房管家 · 后端端到端测试驱动(不碰前端)
 * 框架已通:程序化起真 sidecar(startServer)→ 喂真实用户输入(POST /agent/run,收 SSE)→ 观察大模型 ReAct 走位
 * (事件流 + transcript 工具链 + 落盘副作用)→ 断言 + 归因。往下方 CHECKPOINTS 补真实用例。
 * 用法(cwd=ts/):  bun run ../.claude/skills/billiardbuddy-backend-e2e/run.ts
 *                QF_E2E_LIVE=1 bun run ...   # 真模型冒烟(需真 env/key)
 * ⚠️ 必须 bun run(startServer 用 Bun runtime),不能 node。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from '../../../ts/src/server/index'
import { SessionService } from '../../../ts/src/server/services/sessionService'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '../../../ts/test-results/backend-e2e')
const LIVE = process.env.QF_E2E_LIVE === '1'

// —— 脚本模型:按后端**主循环**第 N 次调模型返回第 N 个预定 SSE(tool_calls / final);捕获发给模型的 system 供断言。——
// ⚠️ 关键坑:后端在主 ReAct 循环之外还会调模型做**记忆召回/抽取**(loop.ts 的 computeRelevantMemoryInjection 等),
//    这些辅助调用的 system 不含业务白标提示(常为空)。若不区分,记忆召回会吃掉脚本模型的第一步、导致主循环错位。
//    判据:主循环 system 含白标标识「贴身助手/管家」;辅助调用返回空、**不消耗 step**。
type ModelStep = { toolCalls?: Array<{ id: string; name: string; input?: unknown }> } | { text: string }
function sseOnce(delta: unknown, finish: string): Response {
  const enc = new TextEncoder()
  const o = { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta, finish_reason: finish }] }
  return new Response(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`)); c.enqueue(enc.encode('data: [DONE]\n\n')); c.close() },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
function makeScriptedFetch(steps: ModelStep[]) {
  const captured = { systems: [] as string[], outUrls: [] as string[] }
  let i = 0
  const fn = async (url: string, init?: { body?: string }) => {
    captured.outUrls.push(String(url))
    let sys = ''
    try {
      const b = JSON.parse(init?.body ?? '{}') as { messages?: Array<{ role: string; content: string }> }
      sys = b.messages?.find((m) => m.role === 'system')?.content ?? ''
    } catch { /* 非 JSON body 忽略 */ }
    if (sys) captured.systems.push(sys)
    // 辅助调用(记忆召回/抽取,system 无业务标识)→ 空响应、不消耗 step。
    if (!(sys.includes('贴身助手') || sys.includes('管家'))) return sseOnce({ content: '' }, 'stop')
    const step = steps[Math.min(i++, steps.length - 1)]!
    return 'toolCalls' in step && step.toolCalls
      ? sseOnce({ tool_calls: step.toolCalls.map((t, idx) => ({ index: idx, id: t.id, function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } })) }, 'tool_calls')
      : sseOnce({ content: (step as { text: string }).text }, 'stop')
  }
  return Object.assign(fn, { captured })
}

// —— 发一条用户输入(POST /agent/run),收 SSE 事件流。——
async function runTurn(base: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/agent/run`, { method: 'POST', body: JSON.stringify(body) })
  const text = await res.text()
  const events: Array<{ type: string; data: unknown }> = []
  for (const block of text.split('\n\n')) {
    const evLine = block.split('\n').find((l) => l.startsWith('event:'))
    const dataLine = block.split('\n').find((l) => l.startsWith('data:'))
    if (!evLine || !dataLine) continue
    try { events.push({ type: evLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) }) } catch { /* 半截 SSE 忽略 */ }
  }
  return { status: res.status, events }
}

// ================= 检查点(测试用例)——以后往这里补 =================
interface Ctx {
  base: string
  transcriptRoot: string
  workspace: string
  captured: { systems: string[]; outUrls: string[] }
  runTurn: (body: Record<string, unknown>) => ReturnType<typeof runTurn>
  transcript: (convId: string) => Promise<unknown[]>
}
interface Checkpoint {
  name: string
  expectation: string
  model: ModelStep[]              // 脚本模型分步响应(live 模式忽略)
  run: (ctx: Ctx) => Promise<{ ok: boolean; note: string }>
}

const CHECKPOINTS: Checkpoint[] = [
  {
    name: 'general-file-write',
    expectation: '喂"建个文件",大模型调 write_file → 事件流有 tool_call(write_file)+final,文件真落盘,transcript 记录',
    model: [
      { toolCalls: [{ id: 'c1', name: 'write_file', input: { path: 'e2e-note.txt', content: 'backend-e2e ok\n' } }] },
      { text: '建好了 e2e-note.txt' },
    ],
    async run(ctx) {
      const convId = 'be2e-file'
      const { events } = await ctx.runTurn({ message: '在当前文件夹建个 e2e-note.txt', conversationId: convId, working_dir: ctx.workspace, permissionMode: 'bypassPermissions' })
      const calledWrite = events.some((e) => e.type === 'tool_call' && JSON.stringify(e.data).includes('write_file'))
      const gotFinal = events.some((e) => e.type === 'final')
      const landed = existsSync(join(ctx.workspace, 'e2e-note.txt'))
      const msgs = await ctx.transcript(convId)
      const inTranscript = JSON.stringify(msgs).includes('write_file')
      const ok = calledWrite && gotFinal && landed && inTranscript
      return { ok, note: `tool_call(write_file)=${calledWrite} final=${gotFinal} 落盘=${landed} transcript记录=${inTranscript}` }
    },
  },
  {
    name: 'billiards-pack-mount',
    expectation: '挂 billiards → 发给模型的系统提示含 <domain_context id="billiards">(领域知识注入),出口不泄漏模型名',
    model: [{ text: '好的,给你想个活动方案(占位)' }],
    async run(ctx) {
      const convId = 'be2e-pack'
      const { events } = await ctx.runTurn({ message: '帮我想个开业活动方案', conversationId: convId, working_dir: ctx.workspace, permissionMode: 'bypassPermissions', enabled_packs: ['billiards'] })
      const domainInjected = ctx.captured.systems.some((s) => s.includes('<domain_context id="billiards"'))
      const finalText = events.filter((e) => e.type === 'final').map((e) => JSON.stringify(e.data)).join('')
      const noModelName = !/mimo|豆包|doubao|ark\.cn/i.test(finalText) // 白标:出口不暴露真实模型名
      const ok = domainInjected && noModelName
      return { ok, note: `域上下文注入=${domainInjected} 出口无模型名=${noModelName}` }
    },
  },
  // TODO 补: 权限档(default 危险命令弹审批不执行) / 会话隔离(两 convId 各分区) / live 冒烟(真模型真调 list_dir + 真实出网URL)
]

// ================= driver 主体(框架,一般不用改) =================
function attribute(ok: boolean) { return ok ? 'ok' : 'backend-fail' }

async function main() {
  rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })
  if (LIVE) console.log('⚠️ LIVE 模式:真调 mimo(需真 env/key),慢且非确定;脚本 model 被忽略。\n')

  const results: Array<{ name: string; expectation: string; ok: boolean; note: string; attribution: string }> = []
  for (const cp of CHECKPOINTS) {
    const transcriptRoot = mkdtempSync(join(tmpdir(), 'be2e-tr-'))
    const workspace = mkdtempSync(join(tmpdir(), 'be2e-ws-'))
    const scripted = LIVE ? undefined : makeScriptedFetch(cp.model)
    // ⚠️ 必须给 env 配模型出口(OPENAI_BASE_URL/KEY/TEXT_MODEL_NAME),否则后端不知道调哪个模型、根本不会调 fetchImpl。
    //    mcpConfigPath 指到不存在的文件,避免读真实 MCP 配置。scripted:假模型 base 用占位域名;LIVE:交默认出网(需真 env)。
    // LIVE:不传 fetchImpl,交给 startServer 默认出网(需真 env);scripted:注入假模型。
    const server = startServer({
      port: 0,
      transcriptRoot,
      mcpConfigPath: join(transcriptRoot, 'missing.mcp.json'),
      // provider env 用 DEEPSEEK_*(对齐 index.test.ts 已验证的 tool_calls 路径;OPENAI provider 对同样的
      // tool_calls SSE 会走续写、解析不出工具调用——踩过坑,别改回 OPENAI_*)。
      ...(scripted
        ? { fetchImpl: scripted, env: { DEEPSEEK_BASE_URL: 'https://model.example/v1', DEEPSEEK_API_KEY: 'e2e-fake', TEXT_MODEL_NAME: 'mimo-v2.5' } }
        : {}),
    })
    const base = `http://127.0.0.1:${server.port}`
    const svc = new SessionService(transcriptRoot)
    const ctx: Ctx = {
      base, transcriptRoot, workspace,
      captured: scripted?.captured ?? { systems: [], outUrls: [] },
      runTurn: (body) => runTurn(base, body),
      transcript: (id) => svc.loadTranscript(id).catch(() => []),
    }
    let r: { ok: boolean; note: string }
    try { r = await cp.run(ctx) } catch (e) { r = { ok: false, note: `检查点抛错: ${e instanceof Error ? e.message : String(e)}` } }
    results.push({ name: cp.name, expectation: cp.expectation, ok: r.ok, note: r.note, attribution: attribute(r.ok) })
    server.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }

  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ mode: LIVE ? 'live' : 'scripted', checkpoints: results }, null, 2))
  console.log(`\n=== 后端 e2e 跑完 → ${OUT} ===`)
  for (const r of results) console.log(`  [${r.attribution}] ${r.name}: ${r.note}`)
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} 通过。${failed ? '红的看 note 定位(后端这层走位/工具/结果哪步错)。' : ''}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
