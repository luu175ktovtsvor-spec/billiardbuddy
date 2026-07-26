import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const script = new URL('./deploy-us-https-proxy.sh', import.meta.url).pathname

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`)
  chmodSync(path, 0o755)
}

function run(options: { currentConnections: number; nginxSucceeds?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'billiardbuddy-us-proxy-'))
  const bin = join(root, 'bin')
  const snippets = join(root, 'snippets')
  const site = join(root, 'billiards')
  const main = join(root, 'nginx.conf')
  const source = join(root, 'billiardbuddy-gateway-us-https-proxy.conf')
  Bun.spawnSync(['mkdir', '-p', bin])
  writeFileSync(site, 'server {\n    listen 443 ssl;\n}\n')
  writeFileSync(main, `events {\n    worker_connections ${options.currentConnections};\n}\nhttp {}\n`)
  writeFileSync(source, 'location /gw/ {\n    proxy_pass http://127.0.0.1:8800/;\n}\n')
  executable(join(bin, 'nginx'), options.nginxSucceeds === false ? 'exit 1' : 'exit 0')
  executable(join(bin, 'systemctl'), 'printf "%s\\n" "$*" >> "$BB_TEST_SYSTEMCTL_LOG"')
  const log = join(root, 'systemctl.log')
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      BB_TEST_SYSTEMCTL_LOG: log,
      BB_US_NGINX_SITE: site,
      BB_US_NGINX_MAIN_CONFIG: main,
      BB_US_PROXY_SNIPPET_SOURCE: source,
      BB_US_PROXY_SNIPPET_DIR: snippets,
    },
  })
  const outcome = {
    result,
    site: readFileSync(site, 'utf8'),
    main: readFileSync(main, 'utf8'),
    snippet: Bun.file(join(snippets, 'billiardbuddy-gateway-us-https-proxy.conf')),
    log: Bun.file(log),
  }
  return { root, outcome }
}

describe('US HTTPS proxy deployment', () => {
  test('raises the Nginx event connection floor before enabling /gw/', async () => {
    const { root, outcome } = run({ currentConnections: 768 })
    try {
      expect(outcome.result.status).toBe(0)
      expect(outcome.main).toContain('worker_connections 8192;')
      expect(outcome.site).toContain('include ')
      expect(await outcome.snippet.text()).toContain('location /gw/')
      expect(await outcome.log.text()).toContain('reload nginx')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('preserves a higher existing worker connection setting', () => {
    const { root, outcome } = run({ currentConnections: 16_384 })
    try {
      expect(outcome.result.status).toBe(0)
      expect(outcome.main).toContain('worker_connections 16384;')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('restores the site and capacity setting when nginx validation fails', () => {
    const { root, outcome } = run({ currentConnections: 768, nginxSucceeds: false })
    try {
      expect(outcome.result.status).toBe(1)
      expect(outcome.main).toContain('worker_connections 768;')
      expect(outcome.site).not.toContain('billiardbuddy-gateway-us-https-proxy.conf')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
