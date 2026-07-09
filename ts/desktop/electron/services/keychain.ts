// macOS 钥匙串弹窗拦截:让 Chromium 用 mock keychain,避免打包/未签名版在 mac 上反复弹"钥匙串授权"密码框。
// 移植自 cc-haha desktop/electron/services/keychain.ts。
// 本壳的认证/密钥不依赖 Chromium 的 cookie/密码存储(令牌走 sidecar 文件),所以禁掉它的 Safe Storage 钥匙串完全安全。
type ElectronAppWithCommandLine = {
  commandLine: {
    appendSwitch(name: string, value?: string): void
  }
}

export function installMacOsChromiumKeychainPromptGuard(
  app: ElectronAppWithCommandLine,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'darwin') return false
  app.commandLine.appendSwitch('use-mock-keychain')
  return true
}
