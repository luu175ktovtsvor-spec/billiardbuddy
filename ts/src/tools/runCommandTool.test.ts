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
import { classifyCommandRisk, hasShellExpansionRisk, hasShellParserRisk, isDangerousCommand, shellBareGitRepoCwdNeedsApproval, shellCdGitNeedsApproval, shellGitInternalWriteNeedsApproval, shellOutputRedirectionNeedsApproval, shellSandboxedGitCwdNeedsApproval } from './dangerousCommand'
import { resolvePermission } from '../permissions/resolve'

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
  expect(classifyCommandRisk('npm install left-pad')).toBe('outreach')
  expect(classifyCommandRisk('rm -rf build')).toBe('destructive')
  expect(classifyCommandRisk('env rm -rf build')).toBe('destructive')
  expect(classifyCommandRisk('rg TODO | head')).toBe('read')
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
  expect(classifyCommandRisk('cd sub && git status --short')).toBe('outreach')
  expect(classifyCommandRisk('FORCE_COLOR=1 cd sub && git status')).toBe('outreach')
  expect(classifyCommandRisk('cd sub && xargs git status')).toBe('outreach')
  expect(classifyCommandRisk('cd sub && echo ok')).toBe('file')
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
  expect(resolvePermission(runCommandTool, { command: 'git commit -m "---"' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'git commit -m "safe message"' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'allow',
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
