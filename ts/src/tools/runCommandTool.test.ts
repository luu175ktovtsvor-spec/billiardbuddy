import { test, expect, beforeEach, afterEach, describe } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { Workspace } from '../workspace/workspace'
import type { ToolContext } from './Tool'
import type { Sandbox } from '../sandbox/sandbox'
import { runCommandTool } from './runCommandTool'
import { StreamingOutputSanitizer, stripAnsiControlSequences } from './outputSanitize'
import { classifyCommandRisk, extractReadCommandPaths, gitDiffNoIndexSensitivePathNeedsApproval, hasShellExpansionRisk, hasShellParserRisk, isDangerousCommand, shellBareGitRepoCwdNeedsApproval, shellCdGitNeedsApproval, shellCdWriteNeedsApproval, shellDangerousRemovalNeedsApproval, shellGitInternalWriteNeedsApproval, shellMvCpFlagsNeedApproval, shellOutputRedirectionNeedsApproval, shellSandboxedGitCwdNeedsApproval, shellSensitiveReadNeedsApproval } from './dangerousCommand'
import { shellExternalReadNeedsApproval } from './readCommandBoundary'
import { resolvePermission } from '../permissions/resolve'
import { applyPermissionUpdates } from '../permissions/permissionUpdate'

let root: string
let ctx: ToolContext
beforeEach(() => {
  // realpath:macOS 的 /tmp 是 /private/tmp 的软链,pwd 会返回真实路径
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')))
  ctx = { workspace: new Workspace(root) }
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('run_command runs a command and captures stdout', async () => {
  const out = await runCommandTool.execute({ command: 'echo hello-w2' }, ctx)
  expect(out).toContain('hello-w2')
})

test('run_command runs with the workspace as cwd', async () => {
  const out = await runCommandTool.execute({ command: 'pwd' }, ctx)
  expect(out).toContain(root)
})

test('run_command can run from a workspace-relative cwd', async () => {
  mkdirSync(join(root, 'packages', 'app'), { recursive: true })
  const out = await runCommandTool.execute({ command: 'pwd', cwd: 'packages/app' }, ctx)
  expect(out).toContain(join(root, 'packages', 'app'))
})

test('run_command cwd honors AdditionalWorkingDirectory session grants', async () => {
  const externalRoot = realpathSync(mkdtempSync(join(tmpdir(), 'run-cwd-')))
  try {
    const deniedPreview = await runCommandTool.previewFor?.({ command: 'pwd', cwd: externalRoot }, ctx)
    expect(deniedPreview).toContain('cwd: 无效:')

    const granted = applyPermissionUpdates(ctx, [
      { type: 'addDirectories', destination: 'session', directories: [externalRoot] },
    ])
    const preview = await runCommandTool.previewFor?.({ command: 'pwd', cwd: externalRoot }, granted)
    expect(preview).toContain(`cwd: ${externalRoot}`)
    const out = await runCommandTool.execute({ command: 'pwd', cwd: externalRoot }, granted)
    expect(out).toContain(externalRoot)

    const revoked = applyPermissionUpdates(granted, [
      { type: 'removeDirectories', destination: 'session', directories: [externalRoot] },
    ])
    const revokedPreview = await runCommandTool.previewFor?.({ command: 'pwd', cwd: externalRoot }, revoked)
    expect(revokedPreview).toContain('cwd: 无效:')
  } finally {
    rmSync(externalRoot, { recursive: true, force: true })
  }
})

test('run_command rejects a cwd that is not a directory', async () => {
  writeFileSync(join(root, 'note.txt'), 'hello')
  await expect(runCommandTool.execute({ command: 'pwd', cwd: 'note.txt' }, ctx)).rejects.toThrow(/cwd 不是可用目录/)
})

test('run_command reports a non-zero exit', async () => {
  const out = await runCommandTool.execute({ command: 'exit 3' }, ctx)
  expect(out).toContain('3')
  expect(out).toContain('返回码：3')
})

test('run_command interprets common search and diff exit codes semantically', async () => {
  writeFileSync(join(root, 'a.txt'), 'same\n')
  writeFileSync(join(root, 'b.txt'), 'different\n')

  const grep = await runCommandTool.execute({ command: 'printf "abc\\n" | grep zzz' }, ctx)
  expect(grep).toContain('返回码：1')
  expect(grep).toContain('语义：No matches found')
  expect(grep).not.toContain('[退出码 1]')

  const diff = await runCommandTool.execute({ command: 'diff a.txt b.txt' }, ctx)
  expect(diff).toContain('返回码：1')
  expect(diff).toContain('语义：Files differ')
  expect(diff).not.toContain('[退出码 1]')
})

test('run_command separates stderr in the final terminal result', async () => {
  const out = await runCommandTool.execute({
    command: `node -e "process.stdout.write('stdout-line\\n'); process.stderr.write('stderr-line\\n'); process.exit(2)"`,
  }, ctx)
  expect(out).toContain('【标准输出】')
  expect(out).toContain('stdout-line')
  expect(out).toContain('【错误输出】')
  expect(out).toContain('stderr-line')
  expect(out).toContain('[退出码 2]\n【标准输出】')
  expect(out.slice(out.indexOf('【错误输出】'))).not.toContain('[退出码 2]')
})

test('run_command truncates large output and keeps the tail', async () => {
  const out = await runCommandTool.execute({
    command: `node -e "process.stdout.write('HEAD-' + 'x'.repeat(200) + '-TAIL')"`,
    max_output_bytes: 40,
  }, ctx)
  const outputSection = out.slice(out.indexOf('【标准输出】'))
  expect(out).toContain('输出截断：true')
  expect(outputSection).not.toContain('HEAD-')
  expect(outputSection).toContain('-TAIL')
})

test('run_command emits live progress chunks while running', async () => {
  const chunks: string[] = []
  const out = await runCommandTool.execute({ command: 'printf live-out' }, {
    ...ctx,
    progressEmit: ev => chunks.push(`${ev.stream}:${ev.chunk}`),
  })
  expect(chunks.join('')).toContain('stdout:live-out')
  expect(out).toContain('live-out')
})

test('output sanitizer strips ansi and split live escape sequences', () => {
  expect(stripAnsiControlSequences('\x1B[31mred\x1B[0m\rnext\x00')).toBe('red\nnext')

  const sanitizer = new StreamingOutputSanitizer()
  expect(sanitizer.push('\x1B[31')).toBe('')
  expect(sanitizer.push('mred\x1B[0m')).toBe('red')
  expect(sanitizer.flush()).toBe('')
})

test('run_command strips ansi control sequences from final and live output', async () => {
  const chunks: string[] = []
  const out = await runCommandTool.execute({
    command: `node -e "process.stdout.write('\\x1b[31mred-output\\x1b[0m\\n')"`,
  }, {
    ...ctx,
    progressEmit: ev => chunks.push(ev.chunk),
  })
  expect(out).toContain('red-output')
  expect(out).not.toContain('\x1B')
  expect(chunks.join('')).toContain('red-output')
  expect(chunks.join('')).not.toContain('\x1B')
})

test('run_command strips model and gateway secrets from child environment', async () => {
  const oldOpenAi = process.env.OPENAI_API_KEY
  const oldGateway = process.env.QF_GATEWAY_TOKEN
  process.env.OPENAI_API_KEY = 'should-not-leak'
  process.env.QF_GATEWAY_TOKEN = 'also-secret'
  try {
    const out = await runCommandTool.execute({
      command: `node -e "process.stdout.write(String(process.env.OPENAI_API_KEY || 'missing') + '/' + String(process.env.QF_GATEWAY_TOKEN || 'missing'))"`,
    }, ctx)
    expect(out).toContain('missing/missing')
    expect(out).not.toContain('should-not-leak')
    expect(out).not.toContain('also-secret')
  } finally {
    if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = oldOpenAi
    if (oldGateway === undefined) delete process.env.QF_GATEWAY_TOKEN
    else process.env.QF_GATEWAY_TOKEN = oldGateway
  }
})

test('run_command reports timeout explicitly', async () => {
  const out = await runCommandTool.execute({
    command: `node -e "setTimeout(() => {}, 1000)"`,
    timeout_ms: 80,
  }, ctx)
  expect(out).toContain('超时：true')
  expect(out).toContain('[退出码 -1]')
})

test('isDangerousCommand flags catastrophic commands', () => {
  expect(isDangerousCommand('rm -rf /')).toBe(true)
  expect(isDangerousCommand('rm -rf ~')).toBe(true)
  expect(isDangerousCommand('sudo reboot')).toBe(true)
  expect(isDangerousCommand('ls -la')).toBe(false)
})

test('isDangerousCommand 直接拒 Windows/cmd 原生灾难级命令(#45)', () => {
  // 格式化磁盘卷(盘符在后/开关在前、大小写不敏感、带引号)
  expect(isDangerousCommand('format c:')).toBe(true)
  expect(isDangerousCommand('format C:\\ /q')).toBe(true)
  expect(isDangerousCommand('FORMAT /FS:NTFS /Q D:')).toBe(true)
  expect(isDangerousCommand('format "e:" /y')).toBe(true)
  // 磁盘分区 / 擦除 / 删卷影 / 篡改引导
  expect(isDangerousCommand('diskpart')).toBe(true)
  expect(isDangerousCommand('DiskPart /s script.txt')).toBe(true)
  expect(isDangerousCommand('cipher /w:c:\\')).toBe(true)
  expect(isDangerousCommand('cipher.exe /W:C:\\')).toBe(true)
  expect(isDangerousCommand('vssadmin delete shadows /all /quiet')).toBe(true)
  expect(isDangerousCommand('wmic shadowcopy delete')).toBe(true)
  expect(isDangerousCommand('bcdedit /delete {current}')).toBe(true)
  expect(isDangerousCommand('fsutil usn deletejournal /d c:')).toBe(true)
  expect(isDangerousCommand('fsutil file setzerodata offset=0 length=99999 secret.txt')).toBe(true)
  // 删注册表系统蜂巢
  expect(isDangerousCommand('reg delete HKLM\\Software\\Foo /f')).toBe(true)
  expect(isDangerousCommand('reg delete "HKEY_LOCAL_MACHINE\\SYSTEM" /f')).toBe(true)
  // 删盘符根 / 用户根 env / 通配全删(rm C:\ | rm * 的 cmd 版)
  expect(isDangerousCommand('del C:\\')).toBe(true)
  expect(isDangerousCommand('del C:\\*')).toBe(true)
  expect(isDangerousCommand('rd /s /q C:\\')).toBe(true)
  expect(isDangerousCommand('rmdir /S /Q "C:\\Windows"')).toBe(true)
  expect(isDangerousCommand('del /q %USERPROFILE%')).toBe(true)
  expect(isDangerousCommand('rd /s %SystemRoot%')).toBe(true)
  expect(isDangerousCommand('del *')).toBe(true)
  expect(isDangerousCommand('del *.*')).toBe(true)
  expect(isDangerousCommand('del /f /q *')).toBe(true)
  // 递归(/s)打到盘符绝对路径 —— 审计点名的原样毁数据例子(开关顺序两种)
  expect(isDangerousCommand('del /f /s /q C:\\Users\\me\\Documents\\*')).toBe(true)
  expect(isDangerousCommand('del C:\\Users\\me\\Documents\\* /f /s /q')).toBe(true)
  // PowerShell 原生毁灭 cmdlet(即使经 cmd /c 转手)
  expect(isDangerousCommand('Remove-Item -Recurse -Force C:\\')).toBe(true)
  expect(isDangerousCommand('Remove-Item -Force -Recurse $HOME')).toBe(true)
  expect(isDangerousCommand('Format-Volume -DriveLetter D')).toBe(true)
  expect(isDangerousCommand('Clear-Disk -Number 0 -RemoveData')).toBe(true)
  expect(isDangerousCommand('Clear-RecycleBin -Force')).toBe(true)
  expect(isDangerousCommand('Stop-Computer -Force')).toBe(true)
  expect(isDangerousCommand('cmd /c format c:')).toBe(true)
  expect(isDangerousCommand('cmd /c powershell -c "Clear-Disk -Number 0"')).toBe(true)
  // cmd fork 炸弹 / 裸盘原始写入
  expect(isDangerousCommand('%0|%0')).toBe(true)
  expect(isDangerousCommand('echo x > \\\\.\\PhysicalDrive0')).toBe(true)
})

test('isDangerousCommand 堵住引号/-Command/前导空白转手绕过(对抗审查回归)', () => {
  // 洞 A —— 引号转手(cmd /c "..." / powershell -Command "..."):既往被降级成 file,现直拒
  expect(isDangerousCommand('cmd /c "del C:\\*"')).toBe(true)
  expect(isDangerousCommand('cmd /c "format c:"')).toBe(true)
  expect(isDangerousCommand('cmd /c "rd /s /q C:\\"')).toBe(true)
  expect(isDangerousCommand('cmd /c "diskpart"')).toBe(true)
  expect(isDangerousCommand('powershell -Command "Remove-Item -Recurse -Force C:\\"')).toBe(true)
  expect(isDangerousCommand('powershell -c "Remove-Item -Recurse -Force C:\\"')).toBe(true)
  expect(isDangerousCommand('cmd /c powershell -c "Remove-Item -Recurse -Force C:\\"')).toBe(true)
  expect(isDangerousCommand('powershell -Command "Clear-Disk -Number 0"')).toBe(true)
  // 洞 B —— 前导空格/制表符降级:现直拒
  expect(isDangerousCommand('  format c:')).toBe(true)
  expect(isDangerousCommand('\tformat c:')).toBe(true)
  expect(isDangerousCommand('  DEL /F /S /Q C:\\*')).toBe(true)
  expect(isDangerousCommand('  rd /s /q C:\\')).toBe(true)
  expect(isDangerousCommand('  Remove-Item -Recurse -Force C:\\')).toBe(true)
  expect(isDangerousCommand('   diskpart')).toBe(true)
  // 分级同步:转手/前导空白版也必须落到 destructive(不是 file)
  expect(classifyCommandRisk('cmd /c "del C:\\*"')).toBe('destructive')
  expect(classifyCommandRisk('powershell -Command "Remove-Item -Recurse -Force C:\\"')).toBe('destructive')
  expect(classifyCommandRisk('  format c:')).toBe('destructive')
  // 引号里只是提到危险词、并非 /c|-c 转手 → 不误杀(echo 一句话)
  expect(isDangerousCommand('echo "del C:\\ is dangerous"')).toBe(false)
  expect(isDangerousCommand('echo "run diskpart to wipe"')).toBe(false)
})

test('isDangerousCommand 放行正常 cmd 命令 + 不误杀相近命令', () => {
  expect(isDangerousCommand('dir')).toBe(false)
  expect(isDangerousCommand('dir /s')).toBe(false)
  expect(isDangerousCommand('type file.txt')).toBe(false)
  expect(isDangerousCommand('echo hello')).toBe(false)
  expect(isDangerousCommand('copy a.txt b.txt')).toBe(false)
  // 相近词/子命令不能误当红线
  expect(isDangerousCommand('dotnet format')).toBe(false)
  expect(isDangerousCommand('git format-patch -1 HEAD')).toBe(false)
  expect(isDangerousCommand('del report.txt')).toBe(false)
  expect(isDangerousCommand('del C:\\Users\\me\\report.txt')).toBe(false)
  expect(isDangerousCommand('rd /s /q build')).toBe(false)
  expect(isDangerousCommand('reg query HKLM\\Software\\Microsoft')).toBe(false)
  expect(isDangerousCommand('reg delete HKCU\\Software\\MyApp /f')).toBe(false)
  expect(isDangerousCommand('taskkill /f /im notepad.exe')).toBe(false)
  expect(isDangerousCommand('sc query Spooler')).toBe(false)
})

test('classifyCommandRisk gates Windows/cmd destructive verbs as approval-tier', () => {
  // 红线级 → destructive(会被 execute 直接拒,分级也算 destructive)
  expect(classifyCommandRisk('format c:')).toBe('destructive')
  expect(classifyCommandRisk('del /f /s /q C:\\Users\\me\\Documents\\*')).toBe('destructive')
  expect(classifyCommandRisk('diskpart /s x.txt')).toBe('destructive')
  // 有破坏面但可控 → destructive(审批闸拦,不直接拒)
  expect(classifyCommandRisk('rd /s /q build')).toBe('destructive')
  expect(classifyCommandRisk('del /s *.tmp')).toBe('destructive')
  expect(classifyCommandRisk('taskkill /f /im notepad.exe')).toBe('destructive')
  expect(classifyCommandRisk('taskkill /im notepad.exe')).toBe('destructive')
  // 审批档动词经 cmd /c / -Command 转手也不降级成 file(和 POSIX `sh -c "rm -rf"` 对齐)
  expect(classifyCommandRisk('cmd /c "rd /s /q build"')).toBe('destructive')
  expect(classifyCommandRisk('cmd /c "taskkill /im notepad.exe"')).toBe('destructive')
  expect(classifyCommandRisk('powershell -Command "reg delete HKCU\\Software\\X /f"')).toBe('destructive')
  expect(classifyCommandRisk('reg delete HKCU\\Software\\MyApp /f')).toBe('destructive')
  expect(classifyCommandRisk('sc delete MyService')).toBe('destructive')
  expect(classifyCommandRisk('sc stop Spooler')).toBe('destructive')
  expect(classifyCommandRisk('net stop Spooler')).toBe('destructive')
  expect(classifyCommandRisk('takeown /f C:\\foo /r')).toBe('destructive')
  expect(classifyCommandRisk('icacls C:\\foo /grant User:F /t')).toBe('destructive')
  // 只读 → read(放行)
  expect(classifyCommandRisk('dir')).toBe('read')
  expect(classifyCommandRisk('dir /s /b')).toBe('read')
  expect(classifyCommandRisk('type package.json')).toBe('read')
  expect(classifyCommandRisk('reg query HKLM\\Software\\Microsoft')).toBe('read')
  expect(classifyCommandRisk('sc query Spooler')).toBe('read')
  expect(classifyCommandRisk('tasklist')).toBe('read')
  expect(classifyCommandRisk('where node')).toBe('read')
  // 普通文件操作 → file
  expect(classifyCommandRisk('del report.txt')).toBe('file')
  expect(classifyCommandRisk('copy a.txt b.txt')).toBe('file')
  expect(classifyCommandRisk('move a.txt b.txt')).toBe('file')
})

test('classifyCommandRisk separates read/file/outreach/destructive commands', () => {
  expect(classifyCommandRisk('ls -la')).toBe('read')
  expect(classifyCommandRisk('git status --short')).toBe('read')
  expect(classifyCommandRisk('echo hi > note.txt')).toBe('file')
  expect(classifyCommandRisk('npm run build')).toBe('file')
  expect(classifyCommandRisk("jq '.name' package.json")).toBe('read')
  expect(classifyCommandRisk('curl https://example.com')).toBe('outreach')
  expect(classifyCommandRisk('env curl https://example.com')).toBe('outreach')
  expect(classifyCommandRisk('env -i FOO=bar curl https://example.com')).toBe('outreach')
  expect(classifyCommandRisk('env -S "curl https://example.com"')).toBe('outreach')
  expect(classifyCommandRisk('env --split-string="curl https://example.com"')).toBe('outreach')
  expect(classifyCommandRisk('env')).toBe('outreach')
  expect(classifyCommandRisk('env -0')).toBe('outreach')
  expect(classifyCommandRisk('FOO=bar env')).toBe('outreach')
  expect(classifyCommandRisk('printenv')).toBe('outreach')
  expect(classifyCommandRisk('printenv PATH')).toBe('outreach')
  expect(classifyCommandRisk('FOO=bar printenv')).toBe('outreach')
  expect(classifyCommandRisk('env printenv')).toBe('outreach')
  expect(classifyCommandRisk('env --chdir=/tmp git status --short')).toBe('outreach')
  expect(classifyCommandRisk('npm install left-pad')).toBe('outreach')
  expect(classifyCommandRisk('rm -rf build')).toBe('destructive')
  expect(classifyCommandRisk('env rm -rf build')).toBe('destructive')
  expect(classifyCommandRisk('rm -- /')).toBe('destructive')
  expect(classifyCommandRisk('rmdir /')).toBe('destructive')
  expect(classifyCommandRisk('rm -f /tmp')).toBe('destructive')
  expect(classifyCommandRisk('rm node_modules/*')).toBe('destructive')
  expect(classifyCommandRisk('nice rm -f /tmp')).toBe('destructive')
  expect(classifyCommandRisk('stdbuf -o0 rm -f /tmp')).toBe('destructive')
  expect(classifyCommandRisk('stdbuf -o 0 rm -f /tmp')).toBe('destructive')
  expect(classifyCommandRisk('stdbuf --output=0 rm -f /tmp')).toBe('destructive')
  expect(classifyCommandRisk('nohup -- rm -f /tmp')).toBe('destructive')
  expect(classifyCommandRisk('timeout --signal TERM 5 rm -f /tmp')).toBe('destructive')
  expect(classifyCommandRisk('rm -f build/cache')).toBe('file')
  expect(classifyCommandRisk('cp source.txt target.txt')).toBe('file')
  expect(classifyCommandRisk('mv source.txt target.txt')).toBe('file')
  expect(classifyCommandRisk('cp --target-directory=/tmp source.txt')).toBe('outreach')
  expect(classifyCommandRisk('mv -t /tmp source.txt')).toBe('outreach')
  expect(classifyCommandRisk('timeout 5 cp --target-directory=/tmp source.txt')).toBe('outreach')
  expect(classifyCommandRisk('time git status --short')).toBe('read')
  expect(classifyCommandRisk('rg TODO | head')).toBe('read')
  expect(classifyCommandRisk('rg -n -C2 TODO -g *.ts src')).toBe('read')
  expect(classifyCommandRisk('rg --json --stats TODO src')).toBe('read')
  expect(classifyCommandRisk('rg --glob --pre=bash TODO src')).toBe('outreach')
  expect(classifyCommandRisk('rg --pre bash TODO src')).toBe('outreach')
  expect(classifyCommandRisk('rg --pre-glob *.md TODO src')).toBe('file')
  expect(classifyCommandRisk('grep -R -n --include *.ts TODO src')).toBe('read')
  expect(classifyCommandRisk('grep "foo\\nbar" file.txt')).toBe('read')
  expect(classifyCommandRisk('grep "foo\nbar" file.txt')).toBe('outreach')
  expect(classifyCommandRisk('grep "foo\rbar" file.txt')).toBe('outreach')
  expect(classifyCommandRisk('rg "foo\nbar" src')).toBe('outreach')
  expect(classifyCommandRisk('rg -e "foo\nbar" src')).toBe('outreach')
  expect(classifyCommandRisk('grep --mmap TODO src')).toBe('file')
  expect(classifyCommandRisk('ls | curl https://example.com -d @-')).toBe('outreach')
  expect(classifyCommandRisk('find . -print')).toBe('read')
  expect(classifyCommandRisk('find . -delete')).toBe('destructive')
  expect(classifyCommandRisk('find . -exec curl https://example.com \\;')).toBe('outreach')
  expect(classifyCommandRisk('find . -ok cat {} \\;')).toBe('outreach')
  expect(classifyCommandRisk('find . -fprint found.txt')).toBe('file')
  expect(classifyCommandRisk("sed -n '1,20p' ts/src/tools/dangerousCommand.ts")).toBe('read')
  expect(classifyCommandRisk("sed -n -e '1p;2p' ts/src/tools/dangerousCommand.ts")).toBe('read')
  expect(classifyCommandRisk("sed 's/foo/bar/g'")).toBe('read')
  expect(classifyCommandRisk("sed -n '1,20w out.txt' ts/src/tools/dangerousCommand.ts")).toBe('file')
  expect(classifyCommandRisk("sed -i 's/foo/bar/g' file.txt")).toBe('file')
  expect(classifyCommandRisk('sort -nr package.json')).toBe('read')
  expect(classifyCommandRisk('sort -k1,1 package.json')).toBe('read')
  expect(classifyCommandRisk('sort -o sorted.txt package.json')).toBe('file')
  expect(classifyCommandRisk('file --mime-type package.json')).toBe('read')
  expect(classifyCommandRisk('file --output out.txt package.json')).toBe('file')
  expect(classifyCommandRisk('base64 --decode encoded.txt')).toBe('read')
  expect(classifyCommandRisk('base64 -o out.txt encoded.txt')).toBe('file')
  expect(classifyCommandRisk('ps aux')).toBe('read')
  expect(classifyCommandRisk('ps -ef')).toBe('read')
  expect(classifyCommandRisk('ps auxe')).toBe('outreach')
  expect(classifyCommandRisk('date')).toBe('read')
  expect(classifyCommandRisk('date +%F')).toBe('read')
  expect(classifyCommandRisk('date -u +%FT%TZ')).toBe('read')
  expect(classifyCommandRisk('date -d tomorrow +%F')).toBe('read')
  expect(classifyCommandRisk('date --date=tomorrow --rfc-3339=seconds')).toBe('read')
  expect(classifyCommandRisk('date -s tomorrow')).toBe('outreach')
  expect(classifyCommandRisk('date --set=tomorrow')).toBe('outreach')
  expect(classifyCommandRisk('date -f dates.txt')).toBe('outreach')
  expect(classifyCommandRisk('date --file=dates.txt')).toBe('outreach')
  expect(classifyCommandRisk('date 010112002030')).toBe('outreach')
  expect(classifyCommandRisk('node -v')).toBe('read')
  expect(classifyCommandRisk('node --version')).toBe('read')
  expect(classifyCommandRisk('node -v --run build')).toBe('outreach')
  expect(classifyCommandRisk('node --run=test -v')).toBe('outreach')
  expect(classifyCommandRisk('hostname')).toBe('read')
  expect(classifyCommandRisk('hostname -f')).toBe('read')
  expect(classifyCommandRisk('hostname --all-ip-addresses')).toBe('read')
  expect(classifyCommandRisk('hostname new-name')).toBe('outreach')
  expect(classifyCommandRisk('hostname -F hosts.txt')).toBe('outreach')
  expect(classifyCommandRisk('hostname --file hosts.txt')).toBe('outreach')
  expect(classifyCommandRisk('info --where bash')).toBe('read')
  expect(classifyCommandRisk('info -f coreutils date')).toBe('read')
  expect(classifyCommandRisk('info -o out.txt bash')).toBe('outreach')
  expect(classifyCommandRisk('info --output=out.txt bash')).toBe('outreach')
  expect(classifyCommandRisk('info --init-file init.info bash')).toBe('outreach')
  expect(classifyCommandRisk('lsof -nP -i')).toBe('read')
  expect(classifyCommandRisk('lsof -p 123')).toBe('read')
  expect(classifyCommandRisk('lsof -D cache')).toBe('outreach')
  expect(classifyCommandRisk('lsof +m/tmp/mounts')).toBe('outreach')
  expect(classifyCommandRisk('pgrep -fl node')).toBe('read')
  expect(classifyCommandRisk('pgrep --full node')).toBe('read')
  expect(classifyCommandRisk('pgrep --unknown node')).toBe('outreach')
  expect(classifyCommandRisk('pkill node')).toBe('destructive')
  expect(classifyCommandRisk('kill 123')).toBe('destructive')
  expect(classifyCommandRisk('killall node')).toBe('destructive')
  expect(classifyCommandRisk('tree . -L 2')).toBe('read')
  expect(classifyCommandRisk('tree -H . -L 2')).toBe('read')
  expect(classifyCommandRisk('tree -o out.html .')).toBe('outreach')
  expect(classifyCommandRisk('tree -R -H . -L 2')).toBe('outreach')
  expect(classifyCommandRisk('man ls')).toBe('read')
  expect(classifyCommandRisk('man -P sh ls')).toBe('outreach')
  expect(classifyCommandRisk('help -m cd')).toBe('read')
  expect(classifyCommandRisk('help -P ls')).toBe('outreach')
  expect(classifyCommandRisk('netstat -an')).toBe('read')
  expect(classifyCommandRisk('netstat --tcp')).toBe('outreach')
  expect(classifyCommandRisk('sha256sum package.tgz')).toBe('read')
  expect(classifyCommandRisk('sha256sum -c sums.txt')).toBe('read')
  expect(classifyCommandRisk('sha1sum --check sums.txt')).toBe('read')
  expect(classifyCommandRisk('md5sum --output sums.txt package.tgz')).toBe('outreach')
  expect(classifyCommandRisk('ss -tan')).toBe('read')
  expect(classifyCommandRisk('ss --tcp --listening')).toBe('read')
  expect(classifyCommandRisk('ss -K dst :80')).toBe('outreach')
  expect(classifyCommandRisk('ss --diag dump.bin')).toBe('outreach')
  expect(classifyCommandRisk('tput cols')).toBe('read')
  expect(classifyCommandRisk('tput -T xterm cols')).toBe('read')
  expect(classifyCommandRisk('tput clear')).toBe('outreach')
  expect(classifyCommandRisk('tput -S')).toBe('outreach')
  expect(classifyCommandRisk('tput -xS cols')).toBe('outreach')
  expect(classifyCommandRisk('fd -H -e ts dangerousCommand')).toBe('read')
  expect(classifyCommandRisk('fdfind --type f package')).toBe('read')
  expect(classifyCommandRisk('fd -x rm {}')).toBe('outreach')
  expect(classifyCommandRisk('fd --exec-batch rm')).toBe('outreach')
  expect(classifyCommandRisk('fd --type --exec-batch rm')).toBe('outreach')
  expect(classifyCommandRisk('fd -l package')).toBe('outreach')
  expect(classifyCommandRisk('xargs grep needle')).toBe('read')
  expect(classifyCommandRisk('xargs -0 -n 5 head')).toBe('read')
  expect(classifyCommandRisk('xargs -I {} grep needle {}')).toBe('read')
  expect(classifyCommandRisk('xargs curl https://example.com')).toBe('outreach')
  expect(classifyCommandRisk('xargs sh -c id')).toBe('outreach')
  expect(classifyCommandRisk('xargs -E= EOF echo foo')).toBe('outreach')
  expect(classifyCommandRisk('xargs -rI echo sh -c id')).toBe('outreach')
  expect(classifyCommandRisk('xargs -it tail a@evil.com')).toBe('outreach')
  expect(classifyCommandRisk('xargs -e EOF echo foo')).toBe('outreach')
  expect(classifyCommandRisk('xargs -i{} grep needle {}')).toBe('outreach')
  expect(classifyCommandRisk('xargs -r -I {} grep needle {}')).toBe('read')
  expect(classifyCommandRisk('xargs -E EOF echo foo')).toBe('read')
  expect(classifyCommandRisk('pyright --project .')).toBe('read')
  expect(classifyCommandRisk('pyright --outputjson --warnings')).toBe('read')
  expect(classifyCommandRisk('pyright --watch')).toBe('outreach')
  expect(classifyCommandRisk('pyright -- --watch')).toBe('outreach')
  expect(classifyCommandRisk('pyright -- --createstub os')).toBe('outreach')
  expect(classifyCommandRisk('docker ps')).toBe('read')
  expect(classifyCommandRisk('docker images')).toBe('read')
  expect(classifyCommandRisk('docker logs --tail 100 app')).toBe('read')
  expect(classifyCommandRisk('docker logs -ft --since 1h app')).toBe('read')
  expect(classifyCommandRisk("docker inspect --format '{{.State.Status}}' app")).toBe('read')
  expect(classifyCommandRisk('docker inspect --type container app')).toBe('read')
  expect(classifyCommandRisk('docker exec app sh')).toBe('outreach')
  expect(classifyCommandRisk('docker logs --output out.txt app')).toBe('outreach')
  expect(classifyCommandRisk('env DOCKER_HOST=tcp://example.com docker ps')).toBe('outreach')
  expect(classifyCommandRisk('DOCKER_CONFIG=/tmp/docker docker images')).toBe('outreach')
  expect(classifyCommandRisk('gh --version')).toBe('read')
  expect(classifyCommandRisk('gh help')).toBe('read')
  expect(classifyCommandRisk('gh run list --limit 5')).toBe('outreach')
  expect(classifyCommandRisk('gh workflow view build.yml --yaml')).toBe('outreach')
  expect(classifyCommandRisk('gh label list --repo owner/repo')).toBe('outreach')
  expect(classifyCommandRisk('gh search repos billiards')).toBe('outreach')
  expect(classifyCommandRisk('glab mr list')).toBe('outreach')
  expect(classifyCommandRisk('curl https://example.com > out.txt')).toBe('outreach')
  expect(classifyCommandRisk('kill 123 > out.txt')).toBe('destructive')
  expect(classifyCommandRisk('git push --force origin main')).toBe('destructive')
  expect(classifyCommandRisk('git push -f origin main')).toBe('destructive')
  expect(classifyCommandRisk('git reset --hard HEAD~1')).toBe('destructive')
  expect(classifyCommandRisk('git commit -m "safe message"')).toBe('file')
  expect(classifyCommandRisk('git commit -m "---"')).toBe('outreach')
  expect(classifyCommandRisk("git commit --message='---'")).toBe('outreach')
  expect(classifyCommandRisk("git commit -m '$(literal)'")).toBe('file')
  expect(classifyCommandRisk('git commit -m "$(whoami)"')).toBe('outreach')
  expect(classifyCommandRisk('git commit -m "`whoami`"')).toBe('outreach')
  expect(classifyCommandRisk('git commit -m "${HOME}"')).toBe('outreach')
  expect(classifyCommandRisk('git diff --stat --cached')).toBe('read')
  expect(classifyCommandRisk('git diff -S needle -- package.json')).toBe('read')
  expect(classifyCommandRisk('git diff --no-index before.txt after.txt')).toBe('read')
  expect(classifyCommandRisk('git diff --no-index .env package.json')).toBe('outreach')
  expect(classifyCommandRisk('git diff --no-index -- ~/.ssh/id_rsa package.json')).toBe('outreach')
  expect(classifyCommandRisk('git diff --output=/tmp/patch.diff')).toBe('file')
  expect(classifyCommandRisk('git diff -S -- --output=/tmp/pwned')).toBe('file')
  expect(classifyCommandRisk('git diff -G -- --output=/tmp/pwned')).toBe('file')
  expect(classifyCommandRisk('git diff -O -- --output=/tmp/pwned')).toBe('file')
  expect(classifyCommandRisk('git log --oneline --max-count 5')).toBe('read')
  expect(classifyCommandRisk('git log --format --output=/tmp/log.txt')).toBe('file')
  expect(classifyCommandRisk('git log --output=/tmp/log.txt')).toBe('file')
  expect(classifyCommandRisk('git show --format=short HEAD')).toBe('read')
  expect(classifyCommandRisk('git status --porcelain=v1 --branch')).toBe('read')
  expect(classifyCommandRisk('git -c core.fsmonitor=evil status --short')).toBe('outreach')
  expect(classifyCommandRisk('git -ccore.fsmonitor=evil status --short')).toBe('outreach')
  expect(classifyCommandRisk('git --exec-path=/tmp status --short')).toBe('outreach')
  expect(classifyCommandRisk('git --config-env=core.fsmonitor=EVIL status --short')).toBe('outreach')
  expect(classifyCommandRisk('git ls-files --others --exclude-standard')).toBe('read')
  expect(classifyCommandRisk('git config --get --show-origin user.name')).toBe('read')
  expect(classifyCommandRisk('git remote -v')).toBe('read')
  expect(classifyCommandRisk('git remote add origin https://example.com/repo.git')).toBe('file')
  expect(classifyCommandRisk('git remote show origin')).toBe('read')
  expect(classifyCommandRisk('git remote show https://example.com/repo.git')).toBe('file')
  expect(classifyCommandRisk('git grep -n TODO -- ts')).toBe('read')
  expect(classifyCommandRisk('git grep --open-files-in-pager TODO')).toBe('file')
  expect(classifyCommandRisk('git ls-remote --get-url')).toBe('read')
  expect(classifyCommandRisk('git ls-remote --server-option=secret origin')).toBe('outreach')
  expect(classifyCommandRisk('git ls-remote -o secret origin')).toBe('outreach')
  expect(classifyCommandRisk('git ls-remote -osecret origin')).toBe('outreach')
  expect(classifyCommandRisk('git ls-remote https://example.com/repo.git')).toBe('file')
  expect(classifyCommandRisk('git rev-parse --show-toplevel')).toBe('read')
  expect(classifyCommandRisk('git rev-parse --verify --short HEAD')).toBe('read')
  expect(classifyCommandRisk('git rev-parse --output=/tmp/rev.txt HEAD')).toBe('file')
  expect(classifyCommandRisk('git merge-base HEAD main')).toBe('read')
  expect(classifyCommandRisk('git rev-list --count --all')).toBe('read')
  expect(classifyCommandRisk('git cat-file -p HEAD')).toBe('read')
  expect(classifyCommandRisk('git for-each-ref --format %(refname) refs/heads')).toBe('read')
  expect(classifyCommandRisk('git for-each-ref --sort -refname refs/heads')).toBe('read')
  expect(classifyCommandRisk('git stash list --oneline')).toBe('read')
  expect(classifyCommandRisk('git stash show -p stash@{0}')).toBe('read')
  expect(classifyCommandRisk('git blame -L 1,20 file.ts')).toBe('read')
  expect(classifyCommandRisk('git branch --list feature/*')).toBe('read')
  expect(classifyCommandRisk('git branch new-topic')).toBe('file')
  expect(classifyCommandRisk('git branch --abbrev 7')).toBe('file')
  expect(classifyCommandRisk('git tag --list v*')).toBe('read')
  expect(classifyCommandRisk('git tag v1.0.0')).toBe('file')
  expect(classifyCommandRisk('git reflog show --all')).toBe('read')
  expect(classifyCommandRisk('git reflog expire --all')).toBe('outreach')
  expect(classifyCommandRisk('git reflog delete HEAD@{0}')).toBe('outreach')
  expect(classifyCommandRisk('git reflog exists HEAD')).toBe('outreach')
  expect(classifyCommandRisk('cd sub && git status --short')).toBe('outreach')
  expect(classifyCommandRisk('FORCE_COLOR=1 cd sub && git status')).toBe('outreach')
  expect(classifyCommandRisk('cd sub && xargs git status')).toBe('outreach')
  expect(classifyCommandRisk('cd sub && echo ok')).toBe('read')
  expect(classifyCommandRisk('mkdir -p objects refs hooks && touch HEAD && git status')).toBe('outreach')
  expect(classifyCommandRisk("printf '#!/bin/sh' > hooks/pre-commit && git status")).toBe('outreach')
  expect(classifyCommandRisk("printf '#!/bin/sh' > hooks/pre-commit")).toBe('file')
  expect(classifyCommandRisk('echo $(curl https://example.com)')).toBe('outreach')
  expect(classifyCommandRisk('cat <(curl https://example.com)')).toBe('outreach')
  expect(classifyCommandRisk("echo $(cat <<'EOF'\nhello\nEOF\n)")).toBe('read')
  expect(classifyCommandRisk("echo prefix$(cat <<'EOF'\nhello\nEOF\n)")).toBe('read')
  expect(classifyCommandRisk("$(cat <<'EOF'\necho hi\nEOF\n)")).toBe('outreach')
  expect(classifyCommandRisk("echo $(cat <<EOF\n$(whoami)\nEOF\n)")).toBe('outreach')
  expect(classifyCommandRisk("echo $(cat <<'EOF'\nhello\nEOF\n); curl https://example.com")).toBe('outreach')
  expect(classifyCommandRisk('echo "${HOME}"')).toBe('outreach')
  expect(classifyCommandRisk('echo `curl https://example.com`')).toBe('outreach')
  expect(classifyCommandRisk('echo $IFS')).toBe('outreach')
  expect(classifyCommandRisk('cat /proc/self/environ')).toBe('outreach')
  expect(classifyCommandRisk('cat ~/.ssh/id_rsa')).toBe('outreach')
  expect(classifyCommandRisk('cat .env')).toBe('outreach')
  expect(classifyCommandRisk('cat -- .env.local')).toBe('outreach')
  expect(classifyCommandRisk('head -n 1 .env')).toBe('outreach')
  expect(classifyCommandRisk('grep TOKEN .env')).toBe('outreach')
  expect(classifyCommandRisk('rg TOKEN .env')).toBe('outreach')
  expect(classifyCommandRisk('wc -c ~/.ssh/id_rsa')).toBe('outreach')
  expect(classifyCommandRisk('find ~/.ssh -type f')).toBe('outreach')
  expect(classifyCommandRisk('cat package.json')).toBe('read')
  expect(classifyCommandRisk('rg TODO src')).toBe('read')
  expect(classifyCommandRisk('echo ok\ncurl https://example.com')).toBe('outreach')
  expect(classifyCommandRisk('echo safe\\; cat ~/.ssh/id_rsa')).toBe('outreach')
  expect(classifyCommandRisk('zmodload zsh/system')).toBe('outreach')
  expect(classifyCommandRisk('env FOO=bar zmodload zsh/system')).toBe('outreach')
  expect(classifyCommandRisk('env git status --short')).toBe('read')
  expect(classifyCommandRisk("jq 'system(\"date\")' data.json")).toBe('outreach')
  expect(classifyCommandRisk('jq -f filter.jq data.json')).toBe('outreach')
  expect(classifyCommandRisk('jq -L lib \'.\' data.json')).toBe('outreach')
  expect(classifyCommandRisk("jq --rawfile secret /etc/passwd '.' data.json")).toBe('outreach')
  expect(classifyCommandRisk('jq --run-tests tests.jq')).toBe('outreach')
  expect(classifyCommandRisk("jq 'env.PATH' data.json")).toBe('outreach')
  expect(classifyCommandRisk("jq '$ENV.PATH' data.json")).toBe('outreach')
  expect(classifyCommandRisk("find . $'-exec' echo {} \\;")).toBe('outreach')
  expect(classifyCommandRisk('echo {"hi":"hi;evil"}')).toBe('outreach')
  expect(classifyCommandRisk("echo '$(curl https://example.com)'")).toBe('read')
  expect(classifyCommandRisk('echo \\$(date)')).toBe('read')
})

test('sensitive read path detection gates credential-like files without blocking normal code reads', () => {
  expect(shellSensitiveReadNeedsApproval('cat ~/.ssh/id_rsa')).toBe(true)
  expect(shellSensitiveReadNeedsApproval('cat .env')).toBe(true)
  expect(shellSensitiveReadNeedsApproval('grep TOKEN .env')).toBe(true)
  expect(shellSensitiveReadNeedsApproval('rg TOKEN .env')).toBe(true)
  expect(shellSensitiveReadNeedsApproval('grep --include .env TOKEN .')).toBe(true)
  expect(shellSensitiveReadNeedsApproval('grep --exclude .env TOKEN src')).toBe(false)
  expect(shellSensitiveReadNeedsApproval('wc -c ~/.ssh/id_rsa')).toBe(true)
  expect(shellSensitiveReadNeedsApproval('find ~/.ssh -type f')).toBe(true)
  expect(shellSensitiveReadNeedsApproval('cat package.json')).toBe(false)
  expect(shellSensitiveReadNeedsApproval('rg TODO src')).toBe(false)
  expect(shellSensitiveReadNeedsApproval('cat src/tokenizer.ts')).toBe(false)
})

test('dangerous removal path detection mirrors Bash path validation guard', () => {
  const cwd = join(root, 'sub')
  mkdirSync(cwd, { recursive: true })
  expect(shellDangerousRemovalNeedsApproval('rm -- /', { cwd })).toBe(true)
  expect(shellDangerousRemovalNeedsApproval('rmdir /', { cwd })).toBe(true)
  expect(shellDangerousRemovalNeedsApproval('rm -f /tmp', { cwd })).toBe(true)
  expect(shellDangerousRemovalNeedsApproval('rm -f ~', { cwd })).toBe(true)
  expect(shellDangerousRemovalNeedsApproval('rm -rf C:\\', { cwd })).toBe(true)
  expect(shellDangerousRemovalNeedsApproval('rm C:/Windows', { cwd })).toBe(true)
  expect(shellDangerousRemovalNeedsApproval('rm node_modules/*', { cwd })).toBe(true)
  expect(shellDangerousRemovalNeedsApproval('rm -f build/cache', { cwd })).toBe(false)
  expect(shellDangerousRemovalNeedsApproval('rm -- -not-a-flag.txt', { cwd })).toBe(false)
  expect(shellDangerousRemovalNeedsApproval('nice rm -f /tmp', { cwd })).toBe(true)
  expect(shellDangerousRemovalNeedsApproval('stdbuf -o0 rm -f /tmp', { cwd })).toBe(true)
  expect(shellDangerousRemovalNeedsApproval('nohup -- rm -f /tmp', { cwd })).toBe(true)
  expect(shellDangerousRemovalNeedsApproval('timeout --signal TERM 5 rm -f /tmp', { cwd })).toBe(true)
})

test('mv/cp flags mirror Bash command validator manual approval guard', () => {
  expect(shellMvCpFlagsNeedApproval('cp source.txt target.txt')).toBe(false)
  expect(shellMvCpFlagsNeedApproval('mv source.txt target.txt')).toBe(false)
  expect(shellMvCpFlagsNeedApproval('cp --target-directory=/tmp source.txt')).toBe(true)
  expect(shellMvCpFlagsNeedApproval('cp -t /tmp source.txt')).toBe(true)
  expect(shellMvCpFlagsNeedApproval('mv -f source.txt target.txt')).toBe(true)
  expect(shellMvCpFlagsNeedApproval('env FOO=bar mv -t /tmp source.txt')).toBe(true)
  expect(shellMvCpFlagsNeedApproval('nice mv -t /tmp source.txt')).toBe(true)
  expect(shellMvCpFlagsNeedApproval('timeout 5 cp --target-directory=/tmp source.txt')).toBe(true)
  expect(shellMvCpFlagsNeedApproval('rm -f source.txt')).toBe(false)
})

test('git diff --no-index sensitive paths mirror Bash path extraction guard', () => {
  expect(gitDiffNoIndexSensitivePathNeedsApproval('git diff --no-index before.txt after.txt')).toBe(false)
  expect(gitDiffNoIndexSensitivePathNeedsApproval('git diff --no-index .env package.json')).toBe(true)
  expect(gitDiffNoIndexSensitivePathNeedsApproval('git diff --no-index -- ~/.ssh/id_rsa package.json')).toBe(true)
  expect(gitDiffNoIndexSensitivePathNeedsApproval('git diff --no-index -S needle -- .env package.json')).toBe(true)
  expect(gitDiffNoIndexSensitivePathNeedsApproval('stdbuf -o0 git diff --no-index .env package.json')).toBe(true)
  expect(gitDiffNoIndexSensitivePathNeedsApproval('time git diff --no-index before.txt after.txt')).toBe(false)
  expect(gitDiffNoIndexSensitivePathNeedsApproval('git diff package.json src/index.ts')).toBe(false)
})

test('shell expansion risk detection mirrors Bash substitution safety gate', () => {
  expect(hasShellExpansionRisk('echo $(date)')).toBe(true)
  expect(hasShellExpansionRisk('cat <(printf ok)')).toBe(true)
  expect(hasShellExpansionRisk('echo ${HOME}')).toBe(true)
  expect(hasShellExpansionRisk('echo =curl')).toBe(true)
  expect(hasShellExpansionRisk("echo $(cat <<'EOF'\nhello\nEOF\n)")).toBe(false)
  expect(hasShellExpansionRisk("echo $(cat <<EOF\n$(whoami)\nEOF\n)")).toBe(true)
  expect(hasShellExpansionRisk("echo '$(date)'")).toBe(false)
  expect(hasShellExpansionRisk('echo \\$(date)')).toBe(false)
})

test('shell parser hardening mirrors Bash misparse safety gates', () => {
  expect(hasShellParserRisk('echo `date`')).toBe(true)
  expect(hasShellParserRisk('echo \\`date\\`')).toBe(false)
  expect(hasShellParserRisk('echo $IFS')).toBe(true)
  expect(hasShellParserRisk('cat /proc/self/environ')).toBe(true)
  expect(hasShellParserRisk('\t--danger-fragment')).toBe(true)
  expect(hasShellParserRisk('-rf /tmp')).toBe(true)
  expect(hasShellParserRisk('&& cat package.json')).toBe(true)
  expect(hasShellParserRisk('; echo hi')).toBe(true)
  expect(hasShellParserRisk('> out.txt')).toBe(true)
  expect(hasShellParserRisk('echo safe\\ word')).toBe(true)
  expect(hasShellParserRisk('echo "safe\\ word"')).toBe(false)
  expect(hasShellParserRisk("echo 'safe\\ word'")).toBe(false)
  expect(hasShellParserRisk('printf ok -- -rf')).toBe(false)
  expect(hasShellParserRisk('echo ok\ncurl https://example.com')).toBe(true)
  expect(hasShellParserRisk('echo ok \\\n--flag')).toBe(false)
  expect(hasShellParserRisk('echo ok\\\ntraceroute example.com')).toBe(true)
  expect(hasShellParserRisk('printf "line\nnext"')).toBe(false)
  expect(hasShellParserRisk('printf "line\n# hidden"')).toBe(true)
  expect(hasShellParserRisk('echo {a,b}')).toBe(true)
  expect(hasShellParserRisk('echo \\{a,b\\}')).toBe(false)
  expect(hasShellParserRisk("echo '{a,b}'")).toBe(false)
  expect(hasShellParserRisk('echo safe\\; cat ~/.ssh/id_rsa')).toBe(true)
  expect(hasShellParserRisk('echo "safe literal"')).toBe(false)
  expect(hasShellParserRisk('echo "safe\\; literal"')).toBe(true)
  expect(hasShellParserRisk('echo ok # "comment quote"')).toBe(true)
  expect(hasShellParserRisk("echo ok # 'comment quote'")).toBe(true)
  expect(hasShellParserRisk('echo ok # plain comment')).toBe(false)
  expect(hasShellParserRisk('echo "# not comment"')).toBe(false)
  expect(hasShellParserRisk('printf "%s" "# literal arg"')).toBe(false)
  expect(hasShellParserRisk('cat < ~/.ssh/id_rsa')).toBe(true)
  expect(hasShellParserRisk('cat < secrets.txt')).toBe(true)
  expect(hasShellParserRisk('echo "< literal"')).toBe(false)
  expect(hasShellParserRisk("printf '%s' '< literal'")).toBe(false)
  expect(hasShellParserRisk('git commit -m "---"')).toBe(true)
  expect(hasShellParserRisk("git commit --message='---'")).toBe(true)
  expect(hasShellParserRisk('git commit -m "safe message"')).toBe(false)
  expect(hasShellParserRisk("git commit -m '$(literal)'")).toBe(false)
  expect(hasShellParserRisk('echo "---"')).toBe(false)
  expect(hasShellParserRisk("echo $(cat <<'EOF'\nhello\nEOF\n)")).toBe(false)
  expect(hasShellParserRisk("$(cat <<'EOF'\necho hi\nEOF\n)")).toBe(true)
  expect(hasShellParserRisk("echo $(cat <<'EOF'\nhello\nEOF\n); curl https://example.com")).toBe(true)
  expect(hasShellParserRisk('zmodload zsh/system')).toBe(true)
  expect(hasShellParserRisk('command builtin zmodload zsh/system')).toBe(true)
  expect(hasShellParserRisk('env FOO=bar zmodload zsh/system')).toBe(true)
  expect(hasShellParserRisk('env -S "zmodload zsh/system"')).toBe(true)
  expect(hasShellParserRisk('fc -e vim')).toBe(true)
  expect(hasShellParserRisk("find . $'-exec' echo {} \\;")).toBe(true)
  expect(hasShellParserRisk('find . ""-exec echo {} \\;')).toBe(true)
  expect(hasShellParserRisk('find . "-"exec echo {} \\;')).toBe(true)
  expect(hasShellParserRisk('cut -d"," table.csv')).toBe(false)
  expect(hasShellParserRisk('echo {"hi":"hi;evil"}')).toBe(true)
  expect(hasShellParserRisk('echo ok; echo done')).toBe(false)
})

test('shell output redirection outside workspace requires explicit approval', () => {
  mkdirSync(join(root, 'sub'), { recursive: true })
  expect(shellOutputRedirectionNeedsApproval('printf ok > note.txt', { root })).toBe(false)
  expect(shellOutputRedirectionNeedsApproval('printf ok 2> logs.txt', { root })).toBe(false)
  expect(shellOutputRedirectionNeedsApproval('printf ok > /dev/null', { root })).toBe(false)
  expect(shellOutputRedirectionNeedsApproval('printf ok > /tmp/out.txt', { root })).toBe(true)
  expect(shellOutputRedirectionNeedsApproval('printf ok > ../out.txt', { root })).toBe(true)
  expect(shellOutputRedirectionNeedsApproval('printf ok > "$HOME/out.txt"', { root })).toBe(true)
  expect(shellOutputRedirectionNeedsApproval("printf ok > '$HOME/out.txt'", { root })).toBe(true)
  expect(shellOutputRedirectionNeedsApproval("printf ok > '${HOME}/out.txt'", { root })).toBe(true)
  expect(shellOutputRedirectionNeedsApproval('printf ok > %TEMP%/out.txt', { root })).toBe(true)
  expect(shellOutputRedirectionNeedsApproval('printf ok > out*.txt', { root })).toBe(true)
  expect(shellOutputRedirectionNeedsApproval('printf ok > "space name.txt"', { root })).toBe(false)
  expect(shellOutputRedirectionNeedsApproval('cd sub && printf ok > out.txt', { root })).toBe(true)
})

test('compound cd plus git mirrors bare repo safety gate', () => {
  expect(shellCdGitNeedsApproval('git status --short')).toBe(false)
  expect(shellCdGitNeedsApproval('cd sub && git status --short')).toBe(true)
  expect(shellCdGitNeedsApproval('FORCE_COLOR=1 cd sub && git status')).toBe(true)
  expect(shellCdGitNeedsApproval('pushd sub && git diff')).toBe(true)
  expect(shellCdGitNeedsApproval('cd sub && xargs git status')).toBe(true)
  expect(shellCdGitNeedsApproval("echo 'cd sub && git status'")).toBe(false)
})

test('compound cd plus write mirrors Bash path validation guard', () => {
  expect(shellCdWriteNeedsApproval('cd sub && ls -la')).toBe(false)
  expect(shellCdWriteNeedsApproval('cd sub && grep TODO file.txt')).toBe(false)
  expect(shellCdWriteNeedsApproval('cd sub && mv a b')).toBe(true)
  expect(shellCdWriteNeedsApproval('cd sub && cp a b')).toBe(true)
  expect(shellCdWriteNeedsApproval('cd sub && rm file.txt')).toBe(true)
  expect(shellCdWriteNeedsApproval('pushd sub && touch note.txt')).toBe(true)
  expect(shellCdWriteNeedsApproval('cd sub && sed -i s/a/b/ file.txt')).toBe(true)
  expect(shellCdWriteNeedsApproval('cd sub && git commit -m ok')).toBe(true)
  expect(shellCdWriteNeedsApproval("echo 'cd sub && rm file.txt'")).toBe(false)
})

test('compound git-internal writes plus git mirror bare repo safety gate', () => {
  expect(shellGitInternalWriteNeedsApproval('git status --short')).toBe(false)
  expect(shellGitInternalWriteNeedsApproval('mkdir -p objects refs hooks && touch HEAD && git status')).toBe(true)
  expect(shellGitInternalWriteNeedsApproval("printf '#!/bin/sh' > hooks/pre-commit && git status")).toBe(true)
  expect(shellGitInternalWriteNeedsApproval('cp hook.sh hooks/pre-commit && xargs git status')).toBe(true)
  expect(shellGitInternalWriteNeedsApproval("printf '#!/bin/sh' > hooks/pre-commit")).toBe(false)
  expect(shellGitInternalWriteNeedsApproval('rm -rf hooks && git status')).toBe(false)
})

test('git in bare-looking cwd mirrors bare repo safety gate', () => {
  expect(shellBareGitRepoCwdNeedsApproval('git status --short', root)).toBe(false)
  writeFileSync(join(root, 'HEAD'), 'ref: refs/heads/main\n')
  expect(shellBareGitRepoCwdNeedsApproval('git status --short', root)).toBe(true)
  expect(shellBareGitRepoCwdNeedsApproval('ls -la', root)).toBe(false)

  const normalRepo = join(root, 'normal')
  mkdirSync(join(normalRepo, '.git'), { recursive: true })
  writeFileSync(join(normalRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(normalRepo, 'HEAD'), 'ordinary file\n')
  expect(shellBareGitRepoCwdNeedsApproval('git status --short', normalRepo)).toBe(false)
})

test('git outside original cwd while sandboxed mirrors cwd safety gate', () => {
  const subdir = join(root, 'sub')
  mkdirSync(subdir, { recursive: true })
  expect(shellSandboxedGitCwdNeedsApproval('git status --short', { root, cwd: root, sandboxActive: true })).toBe(false)
  expect(shellSandboxedGitCwdNeedsApproval('git status --short', { root, cwd: subdir, sandboxActive: false })).toBe(false)
  expect(shellSandboxedGitCwdNeedsApproval('git status --short', { root, cwd: subdir, sandboxActive: true })).toBe(true)
  expect(shellSandboxedGitCwdNeedsApproval('xargs git status', { root, cwd: subdir, sandboxActive: true })).toBe(true)
  expect(shellSandboxedGitCwdNeedsApproval('ls -la', { root, cwd: subdir, sandboxActive: true })).toBe(false)
})

test('run_command dynamic permission allows reads and classifies approval', () => {
  const sandbox = { isOsSandboxActive: () => true } as unknown as Sandbox
  mkdirSync(join(root, 'sub'), { recursive: true })
  expect(resolvePermission(runCommandTool, { command: 'ls -la' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'ls -la' }, { ...ctx, permissionMode: 'plan' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: "jq '.name' package.json" }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'echo hi > note.txt' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'file',
  })
  expect(resolvePermission(runCommandTool, { command: 'echo hi > note.txt' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'find . -print' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: "sed -n '1,20p' ts/src/tools/dangerousCommand.ts" }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'sort -nr package.json' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'ps aux' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'find . -delete' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'destructive',
  })
  expect(resolvePermission(runCommandTool, { command: 'ps auxe' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'date +%F' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'date -s tomorrow' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'node -v' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'node -v --run build' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'hostname -f' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'hostname new-name' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'info --where bash' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'info -o out.txt bash' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'lsof -nP -i' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'lsof +m/tmp/mounts' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'pgrep -fl node' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'pkill node' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'destructive',
  })
  expect(resolvePermission(runCommandTool, { command: 'tree . -L 2' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'tree -o out.html .' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'tree -R -H . -L 2' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'man ls' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'man -P sh ls' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'help -m cd' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'netstat -an' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'netstat --tcp' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'sha256sum package.tgz' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'sha256sum --output sums.txt package.tgz' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'ss -tan' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'ss -K dst :80' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'tput cols' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'tput clear' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'fd -H -e ts dangerousCommand' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'fd -x rm {}' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'rg -n TODO src' }, { ...ctx, permissionMode: 'default' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'rg --pre bash TODO src' }, { ...ctx, permissionMode: 'plan' })).toMatchObject({
    behavior: 'deny',
  })
  expect(resolvePermission(runCommandTool, { command: 'xargs grep needle' }, { ...ctx, permissionMode: 'default' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'xargs sh -c id' }, { ...ctx, permissionMode: 'acceptEdits' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'pyright --project .' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'pyright --watch' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'docker logs --tail 100 app' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'docker inspect --type container app' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'docker exec app sh' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'docker logs --output out.txt app' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'env DOCKER_HOST=tcp://example.com docker ps' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'curl https://example.com > out.txt' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'curl https://example.com > out.txt' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'kill 123 > out.txt' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'destructive',
  })
  expect(resolvePermission(runCommandTool, { command: '-rf /tmp' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'echo ok # "comment quote"' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'cat < ~/.ssh/id_rsa' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'cat ~/.ssh/id_rsa' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
    approvalReason: expect.objectContaining({
      why: expect.stringContaining('敏感凭据文件'),
      impact: expect.stringContaining('敏感文件内容'),
    }),
  })
  expect(resolvePermission(runCommandTool, { command: 'cat package.json' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'git commit -m "---"' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'git commit -m "safe message"' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'allow',
  })
  expect(resolvePermission(runCommandTool, { command: 'git diff --output=/tmp/patch.diff' }, { ...ctx, permissionMode: 'plan' })).toMatchObject({
    behavior: 'deny',
  })
  expect(resolvePermission(runCommandTool, { command: 'git diff --no-index .env package.json' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'git status --porcelain=v1 --branch' }, { ...ctx, permissionMode: 'plan' })).toMatchObject({
    behavior: 'allow',
  })
  expect(resolvePermission(runCommandTool, { command: 'git branch --list' }, { ...ctx, permissionMode: 'default' })).toMatchObject({
    behavior: 'allow',
  })
  expect(resolvePermission(runCommandTool, { command: 'git branch new-topic' }, { ...ctx, permissionMode: 'plan' })).toMatchObject({
    behavior: 'deny',
  })
  expect(resolvePermission(runCommandTool, { command: 'git tag v1.0.0' }, { ...ctx, permissionMode: 'plan' })).toMatchObject({
    behavior: 'deny',
  })
  expect(resolvePermission(runCommandTool, { command: 'git reflog expire --all' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'cd sub && git status --short' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'git status --short', cwd: 'sub' }, { ...ctx, sandbox, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'git status --short', cwd: 'sub' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'allow',
  })
  expect(resolvePermission(runCommandTool, { command: 'env git status --short' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({
    behavior: 'allow',
  })
  writeFileSync(join(root, 'HEAD'), 'ref: refs/heads/main\n')
  expect(resolvePermission(runCommandTool, { command: 'git status --short' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: "printf '#!/bin/sh' > hooks/pre-commit && git status" }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'find . -exec curl https://example.com \\;' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'find . -fprint found.txt' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'echo hi > /tmp/out.txt' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'cd sub && echo hi > out.txt' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'cd sub && mv a b' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'cd sub && rm file.txt' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'cd sub && grep TODO file.txt' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({
    behavior: 'allow',
  })
  expect(resolvePermission(runCommandTool, { command: 'curl https://example.com' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'env curl https://example.com' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'env -S "curl https://example.com"' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'env' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'FOO=bar env' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'printenv PATH' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'echo $(curl https://example.com)' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'cat /proc/self/environ' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: "echo $(cat <<'EOF'\nhello\nEOF\n)" }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'allow',
  })
  expect(resolvePermission(runCommandTool, { command: "$(cat <<'EOF'\necho hi\nEOF\n)" }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'echo ok\ncurl https://example.com' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'echo `date`' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'jq -f filter.jq data.json' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: "jq '$ENV.PATH' data.json" }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: "find . $'-exec' echo {} \\;" }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'echo {"hi":"hi;evil"}' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'rm -rf build' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'destructive',
  })
  expect(resolvePermission(runCommandTool, { command: 'rm -- /' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'destructive',
  })
  expect(resolvePermission(runCommandTool, { command: 'rm node_modules/*' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'destructive',
  })
  expect(resolvePermission(runCommandTool, { command: 'cp source.txt target.txt' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'allow',
  })
  expect(resolvePermission(runCommandTool, { command: 'cp --target-directory=/tmp source.txt' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'mv -t /tmp source.txt' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
})

test('run_command approval preview shows command scope before execution', async () => {
  mkdirSync(join(root, 'packages', 'app'), { recursive: true })

  const preview = await runCommandTool.previewFor?.({
    command: 'npm run build',
    cwd: 'packages/app',
    timeout_ms: 1000,
    max_output_bytes: 2000,
  }, ctx)

  expect(preview).toContain('<run_command_preview>')
  expect(preview).toContain('command: npm run build')
  expect(preview).toContain('cwd: packages/app')
  expect(preview).toContain('risk: file')
  expect(preview).toContain('timeout_ms: 1000')
  expect(preview).toContain('max_output_bytes: 2000')
})

test('run_command refuses a dangerous command', async () => {
  await expect(runCommandTool.execute({ command: 'rm -rf /' }, ctx)).rejects.toThrow(/危险命令/)
})

describe('dangerousCommand W3 补强', () => {
  test('rm 通配/盘符根命中', () => {
    expect(isDangerousCommand('rm -rf *')).toBe(true)
    expect(isDangerousCommand('rm -rf /*')).toBe(true)
    expect(isDangerousCommand('rm -rf C:\\')).toBe(true)
  })
  test('命令内「双反斜杠」文本不是 UNC,不误杀(behavior-align fix:命令内 UNC 正则已删)', () => {
    // \\ 是 JSON / 双引号 shell / sed 里表示"一个字面反斜杠"的标准转义,和 UNC 的双反斜杠前缀肉眼无法区分;
    // 命令内 UNC 检测本身就难做到不误杀、非灾难级,已删除该正则,推迟到 W4 完整分类器(路径级 UNC 已由 Task1 的 isVulnerableUncPath 兜底,不受影响)
    expect(isDangerousCommand(`curl -d '{"path":"C:\\\\Users\\\\test"}' http://api/save`)).toBe(false)
    expect(isDangerousCommand(`echo "C:\\\\Users\\\\foo"`)).toBe(false)
    expect(isDangerousCommand(`sed -i 's#C:\\\\old\\\\path#C:\\\\new\\\\path#' file.txt`)).toBe(false)
  })
  test('rm 大写/混合大小写标志位命中(behavior-align fix:补 /i,catch -RF)', () => {
    expect(isDangerousCommand('rm -RF *')).toBe(true)
    expect(isDangerousCommand('rm -RF /')).toBe(true)
  })
  test('工作区内正常命令不误杀', () => {
    expect(isDangerousCommand('rm -rf build/cache')).toBe(false)
    expect(isDangerousCommand('npm run build')).toBe(false)
  })
  test('行为对齐补充:盘符/UNC/通配新模式不牵连真实命令', () => {
    // 盘符根(危险) vs 具体嵌套路径(真实删除目标,不该拦):新模式只认「盘符+冒号+可选斜杠+结尾」为根
    expect(isDangerousCommand('rm -rf C:\\Users\\foo\\Desktop\\myproject')).toBe(false)
    // 普通单反斜杠 Windows 路径不是 UNC(UNC 特征是双反斜杠开头的网络共享路径)
    expect(isDangerousCommand('copy C:\\temp\\file.txt D:\\backup\\')).toBe(false)
    // 通配裁剪只在「* 或 /* 紧跟标志位」时命中,精确扩展名/子目录通配这类常见清理命令不误杀
    expect(isDangerousCommand('rm -rf *.log')).toBe(false)
    expect(isDangerousCommand('rm -rf node_modules/*')).toBe(false)
  })
})

describe('run_command × Sandbox 接线(Task 6)', () => {
  test('run_command 用 sandbox 包裹后的 argv 跑(返回 {argv,env})', async () => {
    const ws = new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w3-rc-'))))
    const fakeSandbox = {
      async wrapCommand() {
        return { argv: ['printf', 'WRAPPED'], env: {} as NodeJS.ProcessEnv }
      },
    }
    const out = await runCommandTool.execute({ command: 'echo IGNORED' }, {
      workspace: ws,
      sandbox: fakeSandbox as unknown as import('../sandbox/sandbox').Sandbox,
    })
    expect(out).toContain('WRAPPED')
  })

  test('run_command 无 sandbox 时按明文命令跑(W2 行为不回归)', async () => {
    const ws = new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w3-rc-'))))
    const out = await runCommandTool.execute({ command: 'echo PLAIN' }, { workspace: ws })
    expect(out).toContain('PLAIN')
  })
})

describe('读命令工作区边界(P0:对齐 cc-haha BashTool/pathValidation.ts 的 PATH_EXTRACTORS + checkPathConstraints)', () => {
  // 用不带敏感文件名的外部路径(/etc/hostname 而非 /etc/passwd)——本项目 isSensitivePathToken 里
  // 'passwd' 本身命中敏感名正则,/etc/passwd 早被既有 shellSensitiveReadNeedsApproval 挡住,
  // 不能证明这是"新增的边界判定"在生效;换一个非敏感名的真实外部路径才是本任务要补的缺口。
  test('工作区内正常读命令不误伤(cat/ls/find/grep/head/sort/diff/jq/sed 只读变体)', () => {
    writeFileSync(join(root, 'package.json'), '{}')
    writeFileSync(join(root, 'README.md'), 'hi\n')
    writeFileSync(join(root, 'notes.txt'), 'l1\nl2\nl3\n')
    writeFileSync(join(root, 'data.json'), '{"a":1}')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), '// TODO\n')

    expect(shellExternalReadNeedsApproval('cat package.json', root, ctx)).toBe(false)
    expect(shellExternalReadNeedsApproval('ls .', root, ctx)).toBe(false)
    expect(shellExternalReadNeedsApproval('ls', root, ctx)).toBe(false)
    expect(shellExternalReadNeedsApproval('find . -name "*.ts"', root, ctx)).toBe(false)
    expect(shellExternalReadNeedsApproval('grep TODO src', root, ctx)).toBe(false)
    expect(shellExternalReadNeedsApproval('head -n 5 README.md', root, ctx)).toBe(false)
    expect(shellExternalReadNeedsApproval('sort notes.txt', root, ctx)).toBe(false)
    expect(shellExternalReadNeedsApproval('diff package.json data.json', root, ctx)).toBe(false)
    expect(shellExternalReadNeedsApproval("jq '.' data.json", root, ctx)).toBe(false)
    expect(shellExternalReadNeedsApproval("sed -n '1,2p' notes.txt", root, ctx)).toBe(false)
    // 纯 stdin 管道(无路径参数)不误伤
    expect(shellExternalReadNeedsApproval('printf "abc\\n" | grep zzz', root, ctx)).toBe(false)
    expect(shellExternalReadNeedsApproval('cat -', root, ctx)).toBe(false)
  })

  test('工作区外绝对路径需要审批(cat/head/stat/find -newer/jq)', () => {
    expect(shellExternalReadNeedsApproval('cat /etc/hostname', root, ctx)).toBe(true)
    expect(shellExternalReadNeedsApproval('head -n 3 /etc/hostname', root, ctx)).toBe(true)
    expect(shellExternalReadNeedsApproval('stat /etc/hostname', root, ctx)).toBe(true)
    expect(shellExternalReadNeedsApproval('find . -newer /etc/hostname', root, ctx)).toBe(true)
    expect(shellExternalReadNeedsApproval("jq '.' /etc/hosts", root, ctx)).toBe(true)
  })

  test('任务里点名的 /etc/passwd、../../../etc/passwd 两条例子也被边界判定独立覆盖(不只靠敏感文件名判定)', () => {
    // /etc/passwd 的 basename 'passwd' 本身命中 isSensitivePathToken,shellSensitiveReadNeedsApproval
    // 早已挡它——但这条断言证明就算只看新增的越界判定(不看敏感文件名),它照样会被独立挡下,
    // 不是靠"文件名恰好敏感"侥幸过关。
    expect(shellExternalReadNeedsApproval('cat /etc/passwd', root, ctx)).toBe(true)
    expect(shellExternalReadNeedsApproval('cat ../../../etc/passwd', root, ctx)).toBe(true)
  })

  test('`../../../etc/hostname` 相对穿越逃出工作区需要审批', () => {
    expect(shellExternalReadNeedsApproval('cat ../../../etc/hostname', root, ctx)).toBe(true)
    // 相对路径按命令实际执行的 cwd(工作区子目录)展开,而不是死按 workspace.root 展开
    mkdirSync(join(root, 'packages', 'app'), { recursive: true })
    expect(shellExternalReadNeedsApproval('cat ../../../../etc/hostname', join(root, 'packages', 'app'), ctx)).toBe(true)
    expect(shellExternalReadNeedsApproval('cat ../app', join(root, 'packages', 'app'), ctx)).toBe(false)
  })

  test('`grep -r pattern ~/dir` 命中 -r 时仍能正确提出真实路径(不是把 pattern 误当 -r 的值吃掉)', () => {
    // 回归防呆:grep 的 -r 是布尔(recursive),rg 的 -r/--replace 才吃参数;两者不能共用一张 flag 表,
    // 否则 `grep -r secret ~/other-project` 会把 'secret' 当成 -r 的值跳过、'~/other-project' 误判成 pattern,
    // extractReadCommandPaths 就提不出真实路径、静默漏判。
    expect(extractReadCommandPaths('grep -r secret ~/other-project')).toEqual(['~/other-project'])
    expect(shellExternalReadNeedsApproval('grep -r secret ~/other-project', root, ctx)).toBe(true)
    // 工作区内 -r 递归搜索不误伤
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'ok\n')
    expect(shellExternalReadNeedsApproval('grep -r TODO src', root, ctx)).toBe(false)
  })

  test('~root / ~+ / ~- 波浪号变体一律当越界处理(与 cc validatePath 对齐,不是漏判就是拒识别)', () => {
    expect(shellExternalReadNeedsApproval('cat ~root/.ssh/id_rsa', root, ctx)).toBe(true)
    expect(shellExternalReadNeedsApproval('cat ~+/foo.txt', root, ctx)).toBe(true)
  })

  test('UNC 路径(win 专属,对齐 cc containsVulnerableUncPath 的平台门):随 process.platform 走既有 Workspace 边界', () => {
    // isVulnerableUncPath 只在 win32 生效(与 cc 完全对齐,见 workspace/pathValidation.test.ts);
    // resolvePathWithAdditionalWorkingDirectories → Workspace.resolve → validatePath 这条既有链路
    // 不透传 platform 覆盖,永远读 process.platform——非 win 环境下反斜杠不是分隔符,
    // `\\server\share\x` 被当成字面文件名、落在 cwd 内,和 cc 在非 Windows 平台"UNC 检测恒 false"一致。
    expect(shellExternalReadNeedsApproval('cat \\\\server\\share\\x', root, ctx)).toBe(process.platform === 'win32')
  })

  test('grep -f(模式文件)cc 不校验其路径,原样对齐——不是本次新增的能力', () => {
    mkdirSync(join(root, 'somedir'), { recursive: true })
    // -f 的值被当"模式文件"吃掉、不进入路径列表,和 cc parsePatternCommand 一致;
    // 真正的搜索目标 '.' 仍会被正常提取和校验。
    expect(extractReadCommandPaths('grep -f /etc/hostname .')).toEqual(['.'])
    expect(shellExternalReadNeedsApproval('grep -f /etc/hostname .', root, ctx)).toBe(false)
  })

  test('sed -f(脚本文件)命令本身已经总要审批,不依赖本次新增的边界判定', () => {
    // sedCommandIsReadOnly 对任何 -f 用法都判 false → sed -f 走 'file' 风险(见 classifySedCommand),
    // extractReadCommandPaths 对这类命令直接不提取路径(是 sed 分支自身的只读网关,不是遗漏)——
    // sed -f 本就不会落到 'read' 风险、本就总要审批,不需要靠这里的边界判定补漏。
    expect(extractReadCommandPaths('sed -f /etc/hostname file.txt')).toEqual([])
    expect(classifyCommandRisk('sed -f /etc/hostname file.txt')).toBe('file')
  })

  test('git diff --no-index 读取工作区外目标需要审批', () => {
    writeFileSync(join(root, 'a.txt'), 'x\n')
    expect(shellExternalReadNeedsApproval('git diff --no-index a.txt /etc/hostname', root, ctx)).toBe(true)
  })

  test('已授权的 additionalWorkingDirectories 内读取不误伤', async () => {
    const externalRoot = realpathSync(mkdtempSync(join(tmpdir(), 'run-read-')))
    try {
      writeFileSync(join(externalRoot, 'note.txt'), 'hi\n')
      expect(shellExternalReadNeedsApproval(`cat ${join(externalRoot, 'note.txt')}`, root, ctx)).toBe(true)
      const granted = applyPermissionUpdates(ctx, [
        { type: 'addDirectories', destination: 'session', directories: [externalRoot] },
      ])
      expect(shellExternalReadNeedsApproval(`cat ${join(externalRoot, 'note.txt')}`, root, granted)).toBe(false)
    } finally {
      rmSync(externalRoot, { recursive: true, force: true })
    }
  })

  test('full-disk-access 会话(桌面全盘模式)不再需要审批', () => {
    const fullDiskCtx: ToolContext = { workspace: new Workspace(root, { fullDiskAccess: true }) }
    expect(shellExternalReadNeedsApproval('cat /etc/hostname', root, fullDiskCtx)).toBe(false)
  })

  test('接进 run_command 风险判定:越界读命令在 auto_files 档位下要求审批,区内读命令仍直接放行', () => {
    writeFileSync(join(root, 'package.json'), '{}')
    expect(resolvePermission(runCommandTool, { command: 'cat /etc/hostname' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
      behavior: 'ask',
      approvalClass: 'outreach',
    })
    expect(resolvePermission(runCommandTool, { command: 'cat package.json' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
      behavior: 'allow',
    })
  })

  test('run_command 预览/审批理由体现越界读取信号', async () => {
    const preview = await runCommandTool.previewFor?.({ command: 'cat /etc/hostname' }, ctx)
    expect(preview).toContain('external_read: true')
    const reason = runCommandTool.approvalReasonFor?.({ command: 'cat /etc/hostname' }, ctx)
    expect(reason?.why).toContain('超出了当前工作区')
  })
})
