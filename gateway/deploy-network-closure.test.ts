import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (path: string) => readFileSync(resolve(import.meta.dir, path), 'utf8')

test('production gateway is public only through the US TLS entry and encrypted tunnel', () => {
  const proxy = read('deploy/billiardbuddy-gateway-us-https-proxy.conf')
  const tunnel = read('deploy/billiardbuddy-gateway-tunnel.service')
  const mainland = read('deploy/billiardbuddy-gateway-mainland.nginx.conf')
  const us = read('../relay/deploy/billiardbuddy-relay-us.nginx.conf')

  expect(proxy).toContain('proxy_pass http://127.0.0.1:8800/;')
  expect(proxy).not.toContain('39.106.214.21/gw')
  expect(tunnel).toContain('-L 127.0.0.1:8800:127.0.0.1:8799')
  expect(mainland).not.toContain('location /gw/')
  expect(us).toContain('include /etc/nginx/snippets/billiardbuddy-gateway-us-https-proxy.conf;')
  expect(us).toContain('location /relay/imgtasks/')
  expect(us).toContain('client_max_body_size 32m;')
  expect(us).not.toContain('/relay/openai/')
})
