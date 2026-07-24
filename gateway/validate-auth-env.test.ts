import { expect, test } from 'bun:test'
import { validateGatewayAuthEnvironment } from './validate-auth-env'

const valid = [
  'GW_APP_CREDENTIALS=bootstrap-credential-0001',
  'GW_AUTH_SIGNING_KEY=0123456789abcdef0123456789abcdef',
  'GW_AUTHORITY_FILE=/opt/qfgw/authority.json',
  'GW_LICENSE_PROVISIONING=[{"licenseKey":"license-0001","principalId":"release:default","deviceLimit":1000,"active":true,"revision":1}]',
].join('\n')

test('gateway auth preflight accepts one complete production authority', () => {
  expect(validateGatewayAuthEnvironment(valid)).toEqual({ bootstrapCredentialCount: 1, licenseCount: 1 })
})

test('gateway auth preflight rejects missing authority inputs before restart', () => {
  expect(() => validateGatewayAuthEnvironment('GW_APP_CREDENTIALS=bootstrap-credential-0001')).toThrow('GW_AUTH_SIGNING_KEY')
})

test('gateway auth preflight rejects malformed or duplicate provisioning', () => {
  expect(() => validateGatewayAuthEnvironment(valid.replace('revision":1', 'revision":0'))).toThrow('invalid or duplicate')
  const duplicated = valid.replace(/\]$/, ',{"licenseKey":"license-0001","principalId":"release:other","deviceLimit":1,"active":true,"revision":1}]')
  expect(() => validateGatewayAuthEnvironment(duplicated)).toThrow('invalid or duplicate')
})

test('gateway auth preflight requires the current bootstrap credential contract', () => {
  expect(() => validateGatewayAuthEnvironment(
    valid.replace('GW_APP_CREDENTIALS=bootstrap-credential-0001', 'GW_APP_TOKENS={"legacy":"owner"}'),
  )).toThrow('GW_APP_TOKENS is retired')
  expect(() => validateGatewayAuthEnvironment(valid.replace('bootstrap-credential-0001', 'short'))).toThrow('GW_APP_CREDENTIALS')
})
