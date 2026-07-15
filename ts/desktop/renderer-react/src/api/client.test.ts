import { afterEach, expect, test } from 'bun:test'
import { authenticatedResourceUrl, authHeaders, authHeadersForUrl, setAuthToken, setBaseUrl } from './client'
import { conversationWebSocketProtocols } from './websocket'

afterEach(() => {
  setAuthToken(null)
  setBaseUrl('http://127.0.0.1:8850')
})

test('renderer 把控制令牌用于 REST、WS 和本地资源，但不泄漏给远程资源', () => {
  setBaseUrl('http://127.0.0.1:9911')
  setAuthToken('ephemeral-control-token')

  expect(authHeaders()).toEqual({ Authorization: 'Bearer ephemeral-control-token' })
  expect(authHeadersForUrl('http://127.0.0.1:9911/uploads/a.png')).toEqual({ Authorization: 'Bearer ephemeral-control-token' })
  expect(authHeadersForUrl('https://cdn.example/a.png')).toEqual({})
  expect(conversationWebSocketProtocols()).toEqual(['qf-control.ephemeral-control-token'])
  expect(authenticatedResourceUrl('/uploads/local/a.png')).toBe(
    'http://127.0.0.1:9911/uploads/local/a.png?access_token=ephemeral-control-token',
  )
  expect(authenticatedResourceUrl('https://cdn.example/a.png')).toBe('https://cdn.example/a.png')
})

test('浏览器开发模式没有令牌时保持旧连接形状', () => {
  setAuthToken(null)
  expect(authHeaders()).toEqual({})
  expect(conversationWebSocketProtocols()).toBeUndefined()
  expect(authenticatedResourceUrl('/uploads/local/a.png')).toBe('/uploads/local/a.png')
})
