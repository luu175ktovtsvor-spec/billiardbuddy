import { runAgentLoop } from '../harness/loop'
import { buildSystemPrompt } from '../harness/systemPrompt'
import { scriptedModel } from '../harness/fakeModel'
import { buildGeneralRegistry } from '../tools/generalTools'
import { Workspace } from '../workspace/workspace'
import type { AssistantStep } from '../types/model'
import type { AgentEvent } from '../types/events'

function sseLine(ev: AgentEvent | { type: 'done' }): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
}

/** W2 后端。/health + /agent/hello(真主循环 demo:真列一次工作区再收敛;真模型出口 = W6)。 */
export function startServer(opts: { host?: string; port?: number } = {}) {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 8850
  return Bun.serve({
    hostname: host,
    port,
    idleTimeout: 30,
    async fetch(req, server) {
      const url = new URL(req.url)

      if (url.pathname === '/health') {
        return Response.json({ ok: true, service: 'ts-harness', ts: Date.now() })
      }

      if (url.pathname === '/agent/hello') {
        server.timeout(req, 0) // 关掉 Bun 空闲掐断,否则安静的 SSE 流会被杀
        const workspace = new Workspace(process.cwd())
        const systemPrompt = await buildSystemPrompt(workspace)
        // demo model:请求列一次工作区,拿到结果后收敛。真模型出口留 W6。
        const demoSteps: AssistantStep[] = [
          { kind: 'tool_calls', text: '看看工作区里有什么', calls: [{ id: '1', name: 'list_dir', input: {} }] },
          { kind: 'final', text: '这是当前工作区的内容(demo:真模型接入在 W6)。' },
        ]
        const body = (async function* () {
          for await (const ev of runAgentLoop({
            model: scriptedModel(demoSteps),
            registry: buildGeneralRegistry(),
            workspace,
            systemPrompt,
            userMessage: '列一下工作区',
          })) {
            yield sseLine(ev)
          }
          yield sseLine({ type: 'done' })
        })()
        return new Response(body, {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        })
      }

      return new Response('Not found', { status: 404 })
    },
  })
}
