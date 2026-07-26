import { request } from 'node:https'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  PACKAGE_ACCEPTANCE_BOOTSTRAP,
  PACKAGE_ACCEPTANCE_LICENSE,
  startPackageAuthGateway,
} from './package-auth-gateway'

function post(url: string, caPath: string, path: string, input: unknown, authorization?: string): Promise<{ status: number, body: unknown }> {
  const target = new URL(path, `${url}/`)
  const encoded = JSON.stringify(input)
  return new Promise((resolveResponse, rejectResponse) => {
    const outgoing = request(target, {
      method: 'POST',
      ca: readFileSync(caPath),
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(encoded),
        ...(authorization ? { authorization } : {}),
      },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolveResponse({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : null })
      })
    })
    outgoing.once('error', rejectResponse)
    outgoing.end(encoded)
  })
}

describe('packaged desktop auth gateway', () => {
  it('issues only a bounded local acceptance session for the exact activation contract', async () => {
    const gateway = await startPackageAuthGateway()
    try {
      await expect(post(gateway.url, gateway.caPath, 'v1/auth/activate', {
        license_key: PACKAGE_ACCEPTANCE_LICENSE,
        installation_id: 'package-installation',
      }, `Bearer ${PACKAGE_ACCEPTANCE_BOOTSTRAP}`)).resolves.toMatchObject({
        status: 200,
        body: {
          access_token: 'package-acceptance-access',
          refresh_token: 'package-acceptance-refresh',
        },
      })
      await expect(post(gateway.url, gateway.caPath, 'v1/auth/activate', {
        license_key: 'wrong-license',
        installation_id: 'package-installation',
      }, `Bearer ${PACKAGE_ACCEPTANCE_BOOTSTRAP}`)).resolves.toMatchObject({ status: 401 })
    } finally {
      await gateway.close()
    }
  })
})
