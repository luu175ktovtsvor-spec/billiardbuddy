import { describe, expect, test } from 'bun:test'
import { productSubprocessEnvironment } from './productSubprocessEnvironment.js'

describe('productSubprocessEnvironment', () => {
  test('keeps process essentials and withholds Host credentials', () => {
    const result = productSubprocessEnvironment({}, {
      PATH: '/usr/bin',
      HOME: '/home/example',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'C',
      BB_GATEWAY_TOKEN: 'host-secret',
      BILLIARDBUDDY_SERVER_TOKEN: 'host-secret',
      ANTHROPIC_API_KEY: 'host-secret',
      OPENAI_API_KEY: 'host-secret',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      AWS_SECRET_ACCESS_KEY: 'host-secret',
    })
    expect(result).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/example',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'C',
    })
  })

  test('delegates only values explicitly configured by an extension', () => {
    const result = productSubprocessEnvironment(
      { SERVICE_TOKEN: 'extension-secret', FEATURE_FLAG: '1' },
      { PATH: '/usr/bin', BB_GATEWAY_TOKEN: 'host-secret' },
    )
    expect(result).toEqual({
      PATH: '/usr/bin',
      SERVICE_TOKEN: 'extension-secret',
      FEATURE_FLAG: '1',
    })
  })

  test('rejects invalid names and NUL values', () => {
    expect(() => productSubprocessEnvironment({ 'BAD-NAME': 'x' }, {})).toThrow('PRODUCT_SUBPROCESS_ENVIRONMENT_INVALID')
    expect(() => productSubprocessEnvironment({ VALID_NAME: 'x\0y' }, {})).toThrow('PRODUCT_SUBPROCESS_ENVIRONMENT_INVALID')
  })
})
