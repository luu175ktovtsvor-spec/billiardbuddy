import { getLogger } from '../utils/logger'

/**
 * Windows Job Object launcher 的接口占位(W3)。
 * W3 首发:Windows 靠应用层护栏(路径沙箱 + 改前备份 + 审批闸)保护,Job Object 从这里接入。
 * W3b:CI 交叉编译 Rust helper.exe(照 Codex windows-sandbox 思路,见主文档 §5),wrap() 起子进程装进
 *      Job Object(免管理员、进程/资源围栏)。届时 available() 返 true、wrap() 返回 {argv,env}。
 */

// 集中式日志(P0,审计 16-trace-errors.md #1.1):落 <stateRoot>/logs/debug.log,
// 默认只记 warn/error,env QF_DEBUG_LOG(或兼容 BILLIARDBUDDY_DEBUG/DEBUG)开 verbose。
const log = getLogger('sandbox')

export class WindowsJobObjectLauncher {
  available(): boolean {
    return false // W3b 起变 true
  }

  wrap(command: string, _opts: { signal?: AbortSignal }): null {
    // W3:helper 未接入,回退明文 spawn(应用层护栏仍生效)。留痕便于 W3b / 真机排查。
    if (process.env.DESKTOP_DEBUG) {
      log.warn(`Windows Job Object 未接入，命令按应用层护栏直跑：${command}`)
    }
    return null
  }
}
