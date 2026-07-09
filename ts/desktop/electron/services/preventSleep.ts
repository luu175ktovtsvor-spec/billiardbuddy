// 防休眠:跑长任务(生图/渲染/长 agent 循环)时阻止系统睡眠,任务完解除。
// 对齐 cc-haha src/services/preventSleep.ts 的引用计数式 start/stop 设计(可并发多个长任务,计数归零才真正放开);
// 桌面壳里用 Electron 内置的 powerSaveBlocker 实现,跨平台(mac/win/linux 都生效),比 caffeinate 子进程更省事。
import { powerSaveBlocker } from 'electron'

let blockerId: number | null = null
let refCount = 0

// 开始防睡:引用计数 +1,第一个任务时真正开启阻断。
export function startPreventSleep(): void {
  refCount++
  if (refCount === 1 && blockerId === null) {
    try {
      // 'prevent-app-suspension':阻止系统进入睡眠,但仍允许屏幕熄灭(最省电,对齐 cc caffeinate -i 的意图)。
      blockerId = powerSaveBlocker.start('prevent-app-suspension')
    } catch (err) {
      console.error('[desktop] 启动防休眠失败(忽略):', err)
      blockerId = null
    }
  }
}

// 结束防睡:引用计数 -1,归零时放开,让系统能正常睡眠。
export function stopPreventSleep(): void {
  if (refCount > 0) refCount--
  if (refCount === 0) releaseBlocker()
}

// 无视计数强制放开(退出清理用)。
export function forceStopPreventSleep(): void {
  refCount = 0
  releaseBlocker()
}

// 当前是否正在阻止休眠。
export function isPreventingSleep(): boolean {
  return blockerId !== null && powerSaveBlocker.isStarted(blockerId)
}

function releaseBlocker(): void {
  if (blockerId !== null) {
    try {
      if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
    } catch (err) {
      console.error('[desktop] 解除防休眠失败(忽略):', err)
    }
    blockerId = null
  }
}
