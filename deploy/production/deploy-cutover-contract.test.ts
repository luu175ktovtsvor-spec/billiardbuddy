import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const deployment = readFileSync(resolve(import.meta.dir, 'deploy.sh'), 'utf8')
const nginxInstaller = readFileSync(resolve(import.meta.dir, 'install-nginx-relay-routes.sh'), 'utf8')
const videoSmoke = readFileSync(resolve(import.meta.dir, 'video-media-smoke.ts'), 'utf8')
const videoUserJourney = readFileSync(resolve(import.meta.dir, 'video-media-user-journey.ts'), 'utf8')

function position(source: string, fragment: string): number {
  const value = source.indexOf(fragment)
  expect(value).toBeGreaterThanOrEqual(0)
  return value
}

test('release preflight builds and validates without Compose creating the image Relay target before cutover', () => {
  const config = position(deployment, 'docker compose -f "$bb_compose_file" config --quiet')
  const build = position(deployment, 'docker compose -f "$bb_compose_file" build --pull gateway image-relay video-media-relay')
  const gatewayValidator = position(deployment, 'billiardbuddy/gateway:$bb_release_id" bun /app/gateway/validate-deployment-env.ts --process-env')
  const imageValidator = position(deployment, 'billiardbuddy/image-relay:$bb_release_id" bun /app/relay/validate-deployment-env.ts --process-env')
  const videoValidator = position(deployment, 'billiardbuddy/video-media-relay:$bb_release_id" bun /app/video-media-relay/validate-deployment-env.ts --process-env')
  const oldRelayGate = position(deployment, 'legacy relay container still exists')
  const oldDataGate = position(deployment, 'image relay data migration/retirement required')
  const targetDirectory = position(deployment, 'ensure_service_data_directory "$bb_data_root/image-relay"')

  expect(config).toBeLessThan(build)
  expect(build).toBeLessThan(gatewayValidator)
  expect(gatewayValidator).toBeLessThan(imageValidator)
  expect(imageValidator).toBeLessThan(videoValidator)
  expect(videoValidator).toBeLessThan(oldRelayGate)
  expect(oldRelayGate).toBeLessThan(oldDataGate)
  expect(oldDataGate).toBeLessThan(targetDirectory)
  expect(deployment).not.toContain('docker compose -f "$bb_compose_file" run --rm --no-deps --entrypoint bun image-relay')
  expect(deployment).toContain('--env RELAY_DB=/tmp/relay.db --env RELAY_BLOB_DIR=/tmp/blobs')
  expect((deployment.match(/docker run --rm --network none --read-only/g) ?? [])).toHaveLength(3)
})

test('route rollback explicitly reloads restored Nginx configuration and fails as unknown if that reload fails', () => {
  const rollback = position(nginxInstaller, 'if ! rollback; then\n    echo \'Nginx reload failed and prior selected files could not be restored')
  const restoredReload = position(nginxInstaller, 'if ! systemctl reload nginx; then\n    echo \'Nginx reload failed; restored prior files')
  const unknown = nginxInstaller.lastIndexOf('running Nginx state is unknown')
  expect(unknown).toBeGreaterThanOrEqual(0)
  expect(rollback).toBeLessThan(restoredReload)
  expect(restoredReload).toBeLessThan(unknown)
})

test('video smoke requires the public Gateway-only introspection path to be a consumed 404', () => {
  const request = position(videoSmoke, "new URL('/gw/internal/v1/auth/introspect', base)")
  const cancel = position(videoSmoke, 'await publicIntrospection.body?.cancel().catch(() => {})')
  const exact404 = position(videoSmoke, 'if (publicIntrospectionStatus !== 404)')
  expect(request).toBeLessThan(cancel)
  expect(cancel).toBeLessThan(exact404)
  expect(videoSmoke).not.toContain('object lease quota returned')
  expect(videoSmoke).toContain('Quota ceilings are an external deployment policy')
})

test('video user journey is video-only, configurable by rounds, and always logs out its bootstrapped session', () => {
  expect(videoUserJourney).toContain('VIDEO_MEDIA_JOURNEY_ROUNDS')
  expect(videoUserJourney).toContain('VIDEO_MEDIA_JOURNEY_PARALLELISM')
  expect(videoUserJourney).toContain('REAL_VIDEO_USER_JOURNEY_${rounds}_ROUNDS')
  expect(videoUserJourney).toContain('await logoutSession(session.accessToken, session.refreshToken)')
  expect(videoUserJourney).toContain('VIDEO_MEDIA_SMOKE_MAX_PROVIDER_OPERATIONS: \'4\'')
  expect(videoUserJourney).not.toContain('image-relay-smoke')
  expect(videoUserJourney).not.toContain('gateway-smoke')
})
