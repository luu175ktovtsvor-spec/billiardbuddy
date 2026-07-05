import { runHelloLoop, helloModel } from '../harness/helloLoop'
import { helloTool } from '../tools/helloTool'
import type { AgentEvent } from '../types/events'

function sseLine(ev: AgentEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
}

/** W1 起步后端。照 cc-haha src/server/index.ts 的形状,但只留 health + hello。
 *  真路由/WS/CORS/鉴权是 W2+。SSE 用 async-generator + server.timeout(req,0)。 */
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
        server.timeout(req, 0) // 关掉 Bun 10s 空闲掐断,否则安静的 SSE 流会被杀(研究 Q4)
        const body = (async function* () {
          for await (const ev of runHelloLoop({ tools: [helloTool], model: helloModel })) {
            yield sseLine(ev)
          }
          yield 'event: done\ndata: {}\n\n'
        })()
        return new Response(body, {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        })
      }

      return new Response('Not found', { status: 404 })
    },
  })
}
