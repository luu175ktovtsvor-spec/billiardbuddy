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
function makeScriptedFetch(initialSteps: ModelStep[]) {
  const captured = { systems: [] as string[], outUrls: [] as string[] }
  let steps = initialSteps
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
  // setScript:多会话共享一个 server 时,每次"用户说话"前切当前会话的脚本模型(UserSession.say 用)。
  return Object.assign(fn, { captured, setScript(s: ModelStep[]) { steps = s; i = 0 } })
}

// —— UserSession:模拟一个前端窗口的用户(不起壳子)。把前端操作等价成后端请求参数 + 后续消息。——
// 选目录/挂件/权限/大白话输入/点审批卡,全归结为"一组请求参数 + approve 消息",不需要 DOM/Electron。
// 多个 UserSession(不同 convId)= 多会话隔离(各带各的目录/挂件/权限,天然不串台)。
class UserSession {
  workingDir: string | undefined
  packs: string[] = []
  permission = 'default'
  lastEvents: Array<{ type: string; data: unknown }> = []
  constructor(private base: string, readonly convId: string, private scripted: ReturnType<typeof makeScriptedFetch>) {}
  selectFolder(dir: string) { this.workingDir = dir; return this }              // ← 前端"选目录"
  enablePack(id: string) { if (!this.packs.includes(id)) this.packs.push(id); return this } // ← 挂挂件(/台球)
  disablePack(id: string) { this.packs = this.packs.filter((p) => p !== id); return this }  // ← 关挂件(/台球关闭)
  setPermission(mode: string) { this.permission = mode; return this }           // ← 切权限档(default/acceptEdits/bypassPermissions)
  async say(message: string, model: ModelStep[]) {                             // ← 用户大白话输入一句
    this.scripted.setScript(model)
    const { events } = await runTurn(this.base, { message, conversationId: this.convId, working_dir: this.workingDir, permissionMode: this.permission, enabled_packs: this.packs })
    this.lastEvents = events
    return events
  }
  pendingApproval() { return this.lastEvents.find((e) => e.type === 'approval_request')?.data as { tool: string; args: unknown; token: string } | undefined }
  async approve() {                                                            // ← 点审批卡"允许"
    const ap = this.pendingApproval()
    if (!ap) throw new Error('没有待审批的动作')
    const res = await fetch(`${this.base}/api/v1/agent/execute`, { method: 'POST', body: JSON.stringify({ tool: ap.tool, args: ap.args, token: ap.token, conversationId: this.convId, working_dir: this.workingDir, permission_mode: this.permission, enabled_packs: this.packs }) })
    return res.json() as Promise<{ ok?: boolean }>
  }
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
  session: (convId: string) => UserSession   // 模拟一个前端窗口的用户(选目录/挂件/权限/说话/审批)
}
interface Checkpoint {
  name: string
  expectation: string
  model?: ModelStep[]             // 单轮场景用;综合场景(UserSession)每次 say 自带 model,可不填
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
  {
    // 前端等价 e2e(不起壳子):把"多窗口/选目录/挂件/权限档/大白话输入/点审批卡"全等价成后端请求参数+approve消息。
    // 用桌面真实"测试台球运营管家"文件夹当项目目录(= 模拟前端的项目文件夹)。缺文件夹则跳过并说明。
    name: 'frontend-like-multi-session',
    expectation: '两窗口各选不同真实文件夹/各自权限/挂不挂台球 → 文件各落各夹不串台、default档弹审批bypass档不弹、挂台球窗口注入域上下文',
    async run(ctx) {
      const HOME = process.env.HOME ?? ''
      const folder1 = join(HOME, 'Desktop', '测试台球运营管家')
      const folder2 = join(HOME, 'Desktop', '测试管家台球运营管家2')
      if (!existsSync(folder1) || !existsSync(folder2)) {
        return { ok: false, note: `跳过:桌面缺真实测试文件夹(${folder1} / ${folder2})——建好那几个"测试台球运营管家"文件夹再跑` }
      }
      const report1 = join(folder1, 'be2e-经营报表.md')
      try {
        // —— 窗口A:选文件夹1 + 挂台球 + default档 → 说"建个报表"(模型调 write_file) → default 应弹审批 → 点"允许" → 落盘文件夹1 ——
        const A = ctx.session('be2e-winA').selectFolder(folder1).enablePack('billiards').setPermission('default')
        const aEvents = await A.say('帮我在当前文件夹建个经营报表.md,写一句:今天试营业', [
          { toolCalls: [{ id: 'wa', name: 'write_file', input: { path: 'be2e-经营报表.md', content: '# 经营报表\n今天试营业\n' } }] },
          { text: '建好了经营报表' },
        ])
        const aAsked = aEvents.some((e) => e.type === 'approval_request')     // default 档弹审批
        const notLandedBeforeApprove = !existsSync(report1)                   // 审批前不落盘
        if (aAsked) await A.approve()                                        // 点"允许"
        const aLanded = existsSync(report1)                                  // 允许后落盘文件夹1
        const aDomain = ctx.captured.systems.some((s) => s.includes('<domain_context id="billiards"')) // 挂台球→注入域上下文

        // —— 窗口B:选文件夹2 + 不挂台球 + 完全访问档 → 说"列目录"(模型调 list_dir) → bypass 不弹审批、工具直执行 ——
        const B = ctx.session('be2e-winB').selectFolder(folder2).setPermission('bypassPermissions')
        const bEvents = await B.say('列一下当前目录都有啥文件', [
          { toolCalls: [{ id: 'lb', name: 'list_dir', input: {} }] },
          { text: '列好了' },
        ])
        const bNoAsk = !bEvents.some((e) => e.type === 'approval_request')    // bypass 不弹审批
        const bRanTool = bEvents.some((e) => e.type === 'tool_result')        // 工具真执行

        // —— 隔离:A 的文件落文件夹1、没串到文件夹2;两会话 transcript 各自分区 ——
        const notLeaked = !existsSync(join(folder2, 'be2e-经营报表.md'))
        const aTr = await ctx.transcript('be2e-winA'); const bTr = await ctx.transcript('be2e-winB')
        const bothPersisted = JSON.stringify(aTr).includes('write_file') && JSON.stringify(bTr).includes('list_dir')

        const ok = aAsked && notLandedBeforeApprove && aLanded && aDomain && bNoAsk && bRanTool && notLeaked && bothPersisted
        return { ok, note: `A[default弹审批=${aAsked} 审批前未落盘=${notLandedBeforeApprove} 允许后落盘=${aLanded} 域注入=${aDomain}] B[bypass不弹=${bNoAsk} 工具执行=${bRanTool}] 隔离[不串文件夹2=${notLeaked} 双会话分区=${bothPersisted}]` }
      } finally {
        rmSync(report1, { force: true })  // 清理写进真实文件夹的测试文件
      }
    },
  },
  // TODO 补: live 冒烟(真模型真调工具 + 真实出网URL) / 第三权限档 acceptEdits / 会话内多轮工具链
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
    // scripted 总创建(供 UserSession.setScript 用);仅非 LIVE 时作为 fetchImpl 注入。LIVE 交默认出网(需真 env)。
    const scripted = makeScriptedFetch(cp.model ?? [{ text: 'ok' }])
    // ⚠️ 必须给 env 配模型出口,否则后端不知道调哪个模型、根本不会调 fetchImpl。mcpConfigPath 指到不存在文件避免读真实 MCP。
    // provider env 用 DEEPSEEK_*(对齐 index.test.ts 已验证的 tool_calls 路径;OPENAI provider 对同样 tool_calls SSE 会走续写解析不出工具——踩过坑)。
    const server = startServer({
      port: 0,
      transcriptRoot,
      mcpConfigPath: join(transcriptRoot, 'missing.mcp.json'),
      ...(LIVE ? {} : { fetchImpl: scripted, env: { DEEPSEEK_BASE_URL: 'https://model.example/v1', DEEPSEEK_API_KEY: 'e2e-fake', TEXT_MODEL_NAME: 'mimo-v2.5' } }),
    })
    const base = `http://127.0.0.1:${server.port}`
    const svc = new SessionService(transcriptRoot)
    const ctx: Ctx = {
      base, transcriptRoot, workspace,
      captured: scripted.captured,
      runTurn: (body) => runTurn(base, body),
      transcript: (id) => svc.loadTranscript(id).catch(() => []),
      session: (convId) => new UserSession(base, convId, scripted),
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
