import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  canExecuteCodexEngineTarget,
} from '../desktop/scripts/stage-codex-engine'
import { parseMediaToolchainCliOptions } from '../desktop/scripts/stage-media-toolchain'
import {
  readWindowsPeMachine,
  verifyWindowsExecutableTree,
  windowsPeMachineForTarget,
  windowsTargetForArch,
} from '../desktop/scripts/native-build-tools'

const require = createRequire(import.meta.url)
const repositoryRoot = resolve(import.meta.dir, '..', '..')
const { packagedTarget } = require('../desktop/scripts/electron-after-pack.cjs') as {
  packagedTarget(context: { electronPlatformName: string, arch: string }): string
}

function pe(machine: number): Buffer {
  const bytes = Buffer.alloc(0x100)
  bytes.writeUInt16LE(0x5a4d, 0)
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.writeUInt32LE(0x00004550, 0x80)
  bytes.writeUInt16LE(machine, 0x84)
  return bytes
}

describe('Windows 安装包原生资源审计', () => {
  test('x64 与 ARM64 target 映射到各自 PE machine', () => {
    expect(windowsTargetForArch('x64')).toBe('x86_64-pc-windows-msvc')
    expect(windowsTargetForArch('arm64')).toBe('aarch64-pc-windows-msvc')
    expect(windowsPeMachineForTarget('x86_64-pc-windows-msvc')).toBe(0x8664)
    expect(windowsPeMachineForTarget('aarch64-pc-windows-msvc')).toBe(0xaa64)
    expect(readWindowsPeMachine(pe(0xaa64))).toBe(0xaa64)
  })

  test('Windows 媒体工具链显式携带 Electron 打包 target', () => {
    expect(parseMediaToolchainCliOptions([
      '--platform', 'win32',
      '--target', 'aarch64-pc-windows-msvc',
      '--verify',
    ])).toEqual({
      destinationDir: undefined,
      platform: 'win32',
      target: 'aarch64-pc-windows-msvc',
      verifyOnly: true,
    })
  })

  test('拒绝将 x64 EXE、DLL 或 Node addon 混入 ARM64 安装包', () => {
    for (const extension of ['exe', 'dll', 'node']) {
      const root = mkdtempSync(join(tmpdir(), 'billiardbuddy-pe-audit-'))
      try {
        writeFileSync(join(root, `helper.${extension}`), pe(0x8664))
        expect(() => verifyWindowsExecutableTree(root, 'aarch64-pc-windows-msvc'))
          .toThrow('PE 架构为 x64，预期 ARM64')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })

  test('递归审计整个 Windows 应用根目录，而非仅 runtime-assets', () => {
    const root = mkdtempSync(join(tmpdir(), 'billiardbuddy-pe-app-root-'))
    try {
      const addon = join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'example', 'addon.node')
      const executable = join(root, 'BilliardBuddy.exe')
      const framework = join(root, 'Electron Framework.dll')
      mkdirSync(join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'example'), { recursive: true })
      writeFileSync(executable, pe(0xaa64))
      writeFileSync(framework, pe(0xaa64))
      writeFileSync(addon, pe(0xaa64))
      expect(() => verifyWindowsExecutableTree(root, 'aarch64-pc-windows-msvc')).not.toThrow()
      writeFileSync(framework, pe(0x8664))
      expect(() => verifyWindowsExecutableTree(root, 'aarch64-pc-windows-msvc'))
        .toThrow('PE 架构为 x64，预期 ARM64')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('交叉目标只跳过可执行 smoke，仍需接受同架构运行验证', () => {
    expect(canExecuteCodexEngineTarget('aarch64-pc-windows-msvc', 'win32', 'x64')).toBeFalse()
    expect(canExecuteCodexEngineTarget('x86_64-pc-windows-msvc', 'win32', 'x64')).toBeTrue()
    expect(canExecuteCodexEngineTarget('aarch64-apple-darwin', 'darwin', 'x64')).toBeFalse()
  })

  test('拒绝截断或伪造的 PE 头', () => {
    expect(() => readWindowsPeMachine(Buffer.from('MZ'))).toThrow('不是有效的 Windows PE 文件')
    const invalidOffset = Buffer.alloc(0x40)
    invalidOffset.writeUInt16LE(0x5a4d, 0)
    invalidOffset.writeUInt32LE(0x400, 0x3c)
    expect(() => readWindowsPeMachine(invalidOffset)).toThrow('PE 头无效')
  })

  test('Electron 实际架构决定 Windows 打包 target', () => {
    const previous = process.env.BILLIARDBUDDY_WINDOWS_TARGET
    try {
      delete process.env.BILLIARDBUDDY_WINDOWS_TARGET
      expect(packagedTarget({ electronPlatformName: 'win32', arch: 'x64' }))
        .toBe('x86_64-pc-windows-msvc')
      expect(packagedTarget({ electronPlatformName: 'win32', arch: 'arm64' }))
        .toBe('aarch64-pc-windows-msvc')
    } finally {
      if (previous === undefined) delete process.env.BILLIARDBUDDY_WINDOWS_TARGET
      else process.env.BILLIARDBUDDY_WINDOWS_TARGET = previous
    }
  })

  test('拒绝环境配置与 Electron 实际架构不一致', () => {
    const previous = process.env.BILLIARDBUDDY_WINDOWS_TARGET
    try {
      process.env.BILLIARDBUDDY_WINDOWS_TARGET = 'x86_64-pc-windows-msvc'
      expect(() => packagedTarget({ electronPlatformName: 'win32', arch: 'arm64' }))
        .toThrow('does not match Electron package aarch64-pc-windows-msvc')
    } finally {
      if (previous === undefined) delete process.env.BILLIARDBUDDY_WINDOWS_TARGET
      else process.env.BILLIARDBUDDY_WINDOWS_TARGET = previous
    }
  })

  test('Windows 原生服务、MSVC 工具链和包审计保持同一架构与输入边界', () => {
    const computerUse = readFileSync(join(repositoryRoot, 'native', 'billiardbuddy-computer-use', 'windows', 'BilliardBuddyComputerUseService.cpp'), 'utf8')
    const recordReplay = readFileSync(join(repositoryRoot, 'native', 'billiardbuddy-record-replay', 'windows', 'BilliardBuddyRecordReplayService.cpp'), 'utf8')
    const agentStage = readFileSync(join(repositoryRoot, 'ts', 'desktop', 'scripts', 'stage-agent-plugins.ts'), 'utf8')
    const recordStage = readFileSync(join(repositoryRoot, 'ts', 'desktop', 'scripts', 'stage-record-replay-plugin.ts'), 'utf8')
    const browserStage = readFileSync(join(repositoryRoot, 'ts', 'desktop', 'scripts', 'stage-browser-plugin.ts'), 'utf8')
    const chromeStage = readFileSync(join(repositoryRoot, 'ts', 'desktop', 'scripts', 'stage-chrome-plugin.ts'), 'utf8')
    const mediaStage = readFileSync(join(repositoryRoot, 'ts', 'desktop', 'scripts', 'stage-media-toolchain.ts'), 'utf8')
    const build = readFileSync(join(repositoryRoot, 'ts', 'desktop', 'scripts', 'build-windows-x64.ps1'), 'utf8')
    const packageAudit = readFileSync(join(repositoryRoot, 'ts', 'desktop', 'scripts', 'audit-packaged-resources.ts'), 'utf8')
    const workflow = readFileSync(join(repositoryRoot, '.github', 'workflows', 'desktop-build-win.yml'), 'utf8')
    const macBuild = readFileSync(join(repositoryRoot, 'ts', 'desktop', 'scripts', 'build-macos-arm64.sh'), 'utf8')
    const macWorkflow = readFileSync(join(repositoryRoot, '.github', 'workflows', 'desktop-build-mac.yml'), 'utf8')

    expect(computerUse).toContain('#include <uiautomation.h>')
    expect(computerUse).toContain('UIAutomationCore.lib')
    expect(recordReplay).toContain('#include <uiautomation.h>')
    expect(recordReplay).toContain('bool elementBelongsToRecordedWindow(IUIAutomation* automation, IUIAutomationElement* element, HWND eventWindow)')
    expect(recordReplay).toContain('get_CurrentNativeWindowHandle')
    expect(recordReplay).toContain('elementBelongsToRecordedWindow(automation, element, window)')
    for (const library of ['Crypt32.lib', 'Gdi32.lib', 'Ole32.lib', 'OleAut32.lib', 'Shell32.lib', 'UIAutomationCore.lib', 'User32.lib', 'Windowscodecs.lib']) {
      expect(computerUse).toContain(library)
    }
    expect(computerUse).toContain('void movePointerIntoWindow')
    expect(computerUse).toContain('void invokeElement(IUIAutomationElement* element, const WindowInfo& window, const std::wstring& appId)')
    expect(computerUse).toContain('sendMouseClick(window, appId, x, y)')
    expect(computerUse).not.toContain('sendMouseClick(x, y)')
    expect(computerUse).toContain('void sendText(const WindowInfo& window, const std::wstring& appId')
    expect(computerUse).toContain('void sendKey(const WindowInfo& window, const std::wstring& appId')
    expect(computerUse).toContain('requireStillForeground(window, appId);\n  if (SendInput')
    expect(computerUse).toContain('sendScroll(window, appId')
    expect(agentStage).toContain("'Microsoft.VisualStudio.Component.VC.Tools.ARM64'")
    expect(agentStage).toContain("'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'")
    expect(recordStage).toContain("'Microsoft.VisualStudio.Component.VC.Tools.ARM64'")
    expect(recordStage).toContain("'Uiautomationcore.lib'")
    expect(browserStage).toContain('verifyWindowsPeMachine(staged, options.target as WindowsNativeTarget)')
    expect(chromeStage).toContain('verifyWindowsPeMachine(file, options.target as WindowsNativeTarget)')
    expect(mediaStage).toContain('target?: WindowsNativeTarget')
    expect(mediaStage).toContain('verifyWindowsPeMachine(join(directory, name), target)')
    expect(build).toContain("[ValidateSet('x64', 'arm64')]")
    expect(build).toContain('[switch]$AgentOnly')
    expect(build).toContain("'Microsoft.VisualStudio.Component.VC.Tools.ARM64'")
    expect(build).toContain('$env:BB_MEDIA_TOOLCHAIN_TARGET = $targetTriple')
    expect(build).toContain("$env:BB_AGENT_ONLY_BUILD = if ($AgentOnly) { '1' } else { '0' }")
    expect(build).toContain("'stage:record-replay-plugin'")
    expect(packageAudit).toContain('verifyWindowsExecutableTree(dirname(resources), options.target)')
    expect(packageAudit).toContain("target: options.platform === 'win32' ? options.target as WindowsNativeTarget : undefined")
    expect(packageAudit).toContain("process.env.BB_AGENT_ONLY_BUILD !== '1'")
    expect(workflow).toContain('architecture: arm64')
    expect(workflow).toContain("BB_AGENT_ONLY_BUILD: '1'")
    expect(workflow).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'")
    expect(workflow).toContain('-AgentOnly')
    expect(workflow).not.toContain('BB_WINDOWS_MEDIA_TOOLCHAIN_ARM64_URL')
    expect(workflow).not.toContain('stage:media-toolchain')
    expect(workflow).not.toContain('image-canvas-golden')
    expect(workflow).toContain("app-*.7z")
    expect(workflow).toContain('windows-${{ matrix.architecture }}')
    expect(workflow).toContain('验证产品运行路径中的 Rust fmt、check 与 test')
    expect(workflow).toContain('--package codex-windows-sandbox')
    expect(workflow).toContain('verify:codex-hook-environment')
    expect(workflow).toContain('verify-browser-use-e2e.ts')
    expect(macBuild).toContain('BB_AGENT_ONLY_BUILD')
    expect(macBuild).toContain('Agent-only build: skipping media toolchain staging.')
    expect(macWorkflow).toContain("BB_AGENT_ONLY_BUILD: '1'")
    expect(macWorkflow).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'")
    expect(macWorkflow).not.toContain('BB_MACOS_CERTIFICATE_P12_B64')
    expect(macWorkflow).not.toContain('APPLE_APP_SPECIFIC_PASSWORD')
    expect(macWorkflow).not.toContain('BB_MACOS_MEDIA_TOOLCHAIN_URL')
    expect(macWorkflow).not.toContain('stage:media-toolchain')
  })
})
