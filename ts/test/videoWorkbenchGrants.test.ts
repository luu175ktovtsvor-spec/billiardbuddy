import { expect, test } from 'bun:test'
import { VideoDestinationGrants } from '../desktop/electron/services/videoDestinationGrants.js'
import { VideoSourceGrants } from '../desktop/electron/services/videoSourceGrants.js'

const projectId = 'vid_00000001'
const otherProjectId = 'vid_00000002'
const variantId = 'variant_00000001'
const otherVariantId = 'variant_00000002'

test('视频素材选择只向 Renderer 交付不透明 token，并且批量消费一次且绑定项目', () => {
  const grants = new VideoSourceGrants()
  const first = grants.issue(projectId, '/private/source-one.mp4', 'video/mp4', 12_345, 1_000)
  const second = grants.issue(projectId, '/private/source-two.mp4', 'video/mp4', undefined, 1_000)
  expect(first).toMatchObject({ display_name: 'source-one.mp4', size_bytes: 12_345 })
  expect(JSON.stringify([first, second])).not.toContain('/private/')
  expect(grants.consume(otherProjectId, [first.selection_id], 1_001)).toBeNull()
  const foreign = grants.issue(otherProjectId, '/private/other-project.mp4', 'video/mp4', undefined, 1_000)
  expect(grants.consume(projectId, [first.selection_id, foreign.selection_id], 1_001)).toBeNull()
  expect(grants.consume(projectId, [first.selection_id, second.selection_id], 1_001)).toEqual([
    '/private/source-one.mp4',
    '/private/source-two.mp4',
  ])

  const validFirst = grants.issue(projectId, '/private/source-three.mp4', 'video/mp4', 1, 1_000)
  const validSecond = grants.issue(projectId, '/private/source-four.mp4', 'video/mp4', 2, 1_000)
  expect(grants.consume(projectId, [validFirst.selection_id, validSecond.selection_id], 1_001)).toEqual([
    '/private/source-three.mp4',
    '/private/source-four.mp4',
  ])
  expect(grants.consume(projectId, [validFirst.selection_id], 1_002)).toBeNull()
  expect(grants.consume(projectId, [validSecond.selection_id, validSecond.selection_id], 1_002)).toBeNull()
})

test('视频素材授权过期或项目撤销后不能导入', () => {
  const grants = new VideoSourceGrants()
  expect(() => grants.issue(projectId, '/private/not-video.txt', 'text/plain', undefined, 1_000)).toThrow('MIME')
  const expired = grants.issue(projectId, '/private/expired.mp4', 'video/mp4', undefined, 1_000)
  expect(grants.consume(projectId, [expired.selection_id], 1_000 + 5 * 60_000)).toBeNull()
  const revoked = grants.issue(projectId, '/private/revoked.mp4', 'video/mp4', undefined, 1_000)
  grants.revokeProject(projectId)
  expect(grants.consume(projectId, [revoked.selection_id], 1_001)).toBeNull()
})

test('视频导出授权不暴露路径，绑定项目和变体且只能使用一次', () => {
  const grants = new VideoDestinationGrants()
  const issued = grants.issue(projectId, variantId, '/private/output.mp4', 'video/mp4', 1_000)
  expect(issued.destination_grant_id).toMatch(/^vdg_/)
  expect(issued.display_name).toBe('output.mp4')
  expect(JSON.stringify(issued)).not.toContain('/private/output.mp4')
  expect(grants.consume(otherProjectId, variantId, 'video/mp4', issued.destination_grant_id, 1_001)).toBeNull()

  const crossVariant = grants.issue(projectId, variantId, '/private/cross-variant.mp4', 'video/mp4', 1_000)
  expect(grants.consume(projectId, otherVariantId, 'video/mp4', crossVariant.destination_grant_id, 1_001)).toBeNull()

  expect(() => grants.issue(projectId, variantId, '/private/not-video.txt', 'text/plain', 1_000)).toThrow('MIME')
  const wrongMime = grants.issue(projectId, variantId, '/private/wrong-mime.mp4', 'video/mp4', 1_000)
  expect(grants.consume(projectId, variantId, 'video/quicktime', wrongMime.destination_grant_id, 1_001)).toBeNull()
  const valid = grants.issue(projectId, variantId, '/private/confirmed.mp4', 'video/mp4', 1_000)
  expect(grants.consume(projectId, variantId, 'video/mp4', valid.destination_grant_id, 1_001)).toBe('/private/confirmed.mp4')
  expect(grants.consume(projectId, variantId, 'video/mp4', valid.destination_grant_id, 1_002)).toBeNull()
})

test('视频导出授权过期或项目撤销后不能渲染', () => {
  const grants = new VideoDestinationGrants()
  const expired = grants.issue(projectId, variantId, '/private/expired.mp4', 'video/mp4', 1_000)
  expect(grants.consume(projectId, variantId, 'video/mp4', expired.destination_grant_id, 1_000 + 5 * 60_000)).toBeNull()
  const revoked = grants.issue(projectId, variantId, '/private/revoked.mp4', 'video/mp4', 1_000)
  grants.revokeProject(projectId)
  expect(grants.consume(projectId, variantId, 'video/mp4', revoked.destination_grant_id, 1_001)).toBeNull()
})

test('视频授权显示名只能由受控路径基名导出，绝不回显调用者提供的绝对路径', () => {
  const sources = new VideoSourceGrants()
  const source = sources.issue(projectId, '/private/secret/clip.mp4', 'video/mp4', undefined, 1_000)
  expect(source.display_name).toBe('clip.mp4')
  expect(JSON.stringify(source)).not.toContain('/private/secret')

  const destinations = new VideoDestinationGrants()
  const destination = destinations.issue(projectId, variantId, '/private/secret/delivery.mov', 'video/quicktime', 1_000)
  expect(destination.display_name).toBe('delivery.mov')
  expect(JSON.stringify(destination)).not.toContain('/private/secret')
})
