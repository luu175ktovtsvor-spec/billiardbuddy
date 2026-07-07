import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopDataStore } from './desktopDataStore'

test('DesktopDataStore assigns monotonic notification ids for cursor polling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-data-'))
  try {
    const store = new DesktopDataStore(root)
    const first = await store.addNotification({ title: '第一条', body: 'A' })
    const second = await store.addNotification({ title: '第二条', body: 'B' })
    expect(typeof first.id).toBe('number')
    expect(typeof second.id).toBe('number')
    expect(second.id as number).toBeGreaterThan(first.id as number)

    const afterFirst = await store.notificationsAfter(first.id as number)
    expect(afterFirst).toMatchObject({
      items: [expect.objectContaining({ title: '第二条' })],
      cursor: second.id,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
