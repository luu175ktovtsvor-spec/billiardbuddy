import { expect, test } from 'bun:test'
import { installProcessCrashGuards, installAppCrashGuards } from './crashGuard'

/** 极简假 emitter:记录 on() 注册的 handler,可手动触发。 */
function makeEmitter() {
  const handlers = new Map<string, (...a: unknown[]) => void>()
  return {
    on(event: string, listener: (...a: unknown[]) => void) {
      handlers.set(event, listener)
    },
    emit(event: string, ...args: unknown[]) {
      handlers.get(event)?.(...args)
    },
    registered: () => [...handlers.keys()],
  }
}

function makeLogger() {
  const errors: unknown[][] = []
  const warns: unknown[][] = []
  return {
    error: (...a: unknown[]) => { errors.push(a) },
    warn: (...a: unknown[]) => { warns.push(a) },
    errors,
    warns,
  }
}

test('process 兜底:两类 handler 都挂上', () => {
  const proc = makeEmitter()
  installProcessCrashGuards({ proc, logger: makeLogger() })
  expect(proc.registered()).toContain('uncaughtException')
  expect(proc.registered()).toContain('unhandledRejection')
})

test('uncaughtException 触发时记录、不退出、首次弹一次提示', () => {
  const proc = makeEmitter()
  const logger = makeLogger()
  let fatalCount = 0
  installProcessCrashGuards({ proc, logger, onFirstFatal: () => { fatalCount++ } })

  proc.emit('uncaughtException', new Error('kaboom'))
  proc.emit('unhandledRejection', 'later')

  expect(logger.errors.length).toBe(2) // 两次都记录
  expect(fatalCount).toBe(1)           // 提示只弹一次(防弹窗风暴)
})

test('onFirstFatal 自身抛错不会拖垮兜底', () => {
  const proc = makeEmitter()
  const logger = makeLogger()
  installProcessCrashGuards({ proc, logger, onFirstFatal: () => { throw new Error('dialog fail') } })
  expect(() => proc.emit('uncaughtException', new Error('x'))).not.toThrow()
  expect(logger.errors.length).toBeGreaterThanOrEqual(2) // 原错误 + 回调错误各记一次
})

test('render-process-gone(崩溃)自动重载窗口;clean-exit 不处理', () => {
  const app = makeEmitter()
  const logger = makeLogger()
  let reloads = 0
  installAppCrashGuards(app, { logger, reloadWindow: () => { reloads++; return true } })

  app.emit('render-process-gone', {}, {}, { reason: 'clean-exit' })
  expect(reloads).toBe(0) // 正常退出不重载

  app.emit('render-process-gone', {}, {}, { reason: 'crashed', exitCode: 133 })
  expect(reloads).toBe(1) // 崩溃 → 重载一次
})

test('render-process-gone 重载触顶后停手并回调 onReloadGaveUp', () => {
  const app = makeEmitter()
  const logger = makeLogger()
  let gaveUp = 0
  installAppCrashGuards(app, {
    logger,
    reloadWindow: () => true,
    maxReloads: 2,
    onReloadGaveUp: () => { gaveUp++ },
    now: () => 1000, // 固定时钟:全部落在同一窗口内
  })

  app.emit('render-process-gone', {}, {}, { reason: 'crashed' })
  app.emit('render-process-gone', {}, {}, { reason: 'crashed' })
  app.emit('render-process-gone', {}, {}, { reason: 'crashed' }) // 第 3 次:触顶
  expect(gaveUp).toBe(1)
})

test('app 兜底:render/child 两类事件都挂上', () => {
  const app = makeEmitter()
  installAppCrashGuards(app, { logger: makeLogger() })
  expect(app.registered()).toContain('render-process-gone')
  expect(app.registered()).toContain('child-process-gone')
})
