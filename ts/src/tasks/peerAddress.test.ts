import { expect, test } from 'bun:test'
import { parsePeerAddress } from './peerAddress'

test('parsePeerAddress recognizes UDS, bridge and local teammate targets', () => {
  expect(parsePeerAddress('uds:/tmp/peer.sock')).toEqual({ scheme: 'uds', target: '/tmp/peer.sock' })
  expect(parsePeerAddress('/tmp/legacy-peer.sock')).toEqual({ scheme: 'uds', target: '/tmp/legacy-peer.sock' })
  expect(parsePeerAddress('bridge:session_123')).toEqual({ scheme: 'bridge', target: 'session_123' })
  expect(parsePeerAddress('researcher')).toEqual({ scheme: 'other', target: 'researcher' })
})
