import { existsSync, readFileSync } from 'node:fs'

export type WindowSmokeSnapshot = {
  reason?: unknown
  destroyed?: unknown
  title?: unknown
  visible?: unknown
  minimized?: unknown
  url?: unknown
}

const requiredReasons = ['did-finish-load', 'after-final-show', 'backend-ready'] as const
const terminalBackendFailures = new Set(['backend-failed', 'backend-initialization-failed'])

export function readWindowSmokeSnapshots(logPath: string): WindowSmokeSnapshot[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as WindowSmokeSnapshot
      } catch {
        throw new Error(`窗口验收日志第 ${index + 1} 行不是有效 JSON`)
      }
    })
}

export function requireReadyProductWindow(snapshots: WindowSmokeSnapshot[]): WindowSmokeSnapshot {
  for (const reason of requiredReasons) {
    if (!snapshots.some(snapshot => snapshot.reason === reason)) {
      throw new Error(`安装后的桌面窗口未到达 ${reason}`)
    }
  }

  const finalSnapshot = [...snapshots].reverse().find(snapshot => snapshot.reason === 'after-final-show')
  if (!finalSnapshot) throw new Error('安装后的桌面窗口缺少最终快照')
  if (finalSnapshot.destroyed !== false) throw new Error('安装后的桌面窗口已经销毁')
  if (finalSnapshot.visible !== true || finalSnapshot.minimized !== false) {
    throw new Error('安装后的桌面窗口未正常显示')
  }
  if (finalSnapshot.title !== 'BilliardBuddy') {
    throw new Error(`安装后的桌面窗口标题不正确: ${String(finalSnapshot.title)}`)
  }
  if (typeof finalSnapshot.url !== 'string' || !finalSnapshot.url.includes('/dist/index.html')) {
    throw new Error(`安装后的桌面窗口未加载正式 renderer: ${String(finalSnapshot.url)}`)
  }
  return finalSnapshot
}

export async function waitForReadyProductWindow(
  logPath: string,
  options: { timeoutMs?: number, pollMs?: number } = {},
): Promise<WindowSmokeSnapshot> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const pollMs = options.pollMs ?? 250
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = new Error('窗口验收日志尚未生成')

  while (Date.now() < deadline) {
    try {
      const snapshots = readWindowSmokeSnapshots(logPath)
      const backendFailure = snapshots.find(snapshot => terminalBackendFailures.has(String(snapshot.reason)))
      if (backendFailure) throw new Error(`安装包本地后端启动失败: ${String(backendFailure.reason)}`)
      return requireReadyProductWindow(snapshots)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('安装包本地后端启动失败')) throw error
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  throw new Error(`安装后的桌面窗口未在 ${timeoutMs}ms 内就绪: ${String(lastError)}`)
}
