import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, 'nginx')
const snippet = readFileSync(join(root, 'billiardbuddy-relay-routes.conf'), 'utf8')
const vhost = readFileSync(join(root, 'root-domain-vhost.fixture.conf'), 'utf8')

function locationKeys(source: string): string[] {
  return [...source.matchAll(/^\s*location\s+(?:=|\^~|~\*?|)?\s*([^\s{]+)\s*\{/gm)].map(match => match[1]!)
}

test('root-domain Relay snippet does not duplicate the existing Gateway prefix', () => {
  expect(vhost).toContain('include /etc/nginx/snippets/billiardbuddy-video-media.conf;')
  expect(vhost).toContain('proxy_read_timeout 300s;')
  expect(snippet).toContain('location ^~ /gw/internal/')
  expect(snippet).not.toMatch(/^\s*location\s+\^~\s+\/gw\/\s*\{/m)
  expect(snippet).toContain('location = /image-generation/healthz')
  expect(snippet).toContain('location ^~ /image-generation/')
  expect(snippet.indexOf('location = /image-generation/healthz')).toBeLessThan(snippet.indexOf('location ^~ /image-generation/'))
  expect(snippet).toContain('location ^~ /video-media/')

  const keys = [...locationKeys(vhost), ...locationKeys(snippet)]
  expect(new Set(keys).size).toBe(keys.length)
})
