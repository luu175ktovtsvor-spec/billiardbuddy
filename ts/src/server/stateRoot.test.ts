/**
 * P0 · 状态根锚定回归:确保 resolveStateRoot 永远解析到「稳定可写」的 home 锚定路径,
 * 绝不再回退到 process.cwd()(打包后从 Finder/开始菜单启动 cwd=`/`,写不下 → 会话全丢)。
 */
import { afterEach, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveStateRoot } from './index'
import { getUserConfigHomeDir } from '../harness/memoryNames'

const realCwd = process.cwd
const savedConfigDir = process.env.BILLIARDBUDDY_CONFIG_DIR
const savedStateDir = process.env.BILLIARDBUDDY_STATE_DIR

afterEach(() => {
  process.cwd = realCwd
  if (savedConfigDir === undefined) delete process.env.BILLIARDBUDDY_CONFIG_DIR
  else process.env.BILLIARDBUDDY_CONFIG_DIR = savedConfigDir
  if (savedStateDir === undefined) delete process.env.BILLIARDBUDDY_STATE_DIR
  else process.env.BILLIARDBUDDY_STATE_DIR = savedStateDir
})

test('cwd 为根/不可写时,stateRoot 仍锚到 home 下可写路径,绝不用 cwd', () => {
  // 构造「打包后启动」的坏 cwd = `/`(不真去写 /,只 mock 返回值)
  process.cwd = () => '/'
  delete process.env.BILLIARDBUDDY_CONFIG_DIR
  delete process.env.BILLIARDBUDDY_STATE_DIR

  const root = resolveStateRoot({ env: { QF_DESKTOP: '1' } })

  // 默认锚到 ~/.billiardbuddy/state,而不是坏 cwd 下的 /.agent-state
  expect(root).toBe(join(homedir(), '.billiardbuddy', 'state'))
  expect(root).toBe(join(getUserConfigHomeDir(), 'state'))
  expect(root.startsWith(homedir())).toBe(true)
  expect(root).not.toBe('/.agent-state')
  expect(root.startsWith('/.agent-state')).toBe(false)
})

test('env BILLIARDBUDDY_STATE_DIR 显式覆盖整个 state 根', () => {
  process.cwd = () => '/'
  const root = resolveStateRoot({ env: { BILLIARDBUDDY_STATE_DIR: '/var/data/bb-state' } })
  expect(root).toBe('/var/data/bb-state')
})

test('env BILLIARDBUDDY_CONFIG_DIR 改配置根 → state 落到其下', () => {
  process.cwd = () => '/'
  process.env.BILLIARDBUDDY_CONFIG_DIR = '/custom/cfg'
  delete process.env.BILLIARDBUDDY_STATE_DIR
  const root = resolveStateRoot({ env: {} })
  expect(root).toBe(join('/custom/cfg', 'state'))
})

test('显式 transcriptRoot 优先级最高(测试注入路径)', () => {
  const root = resolveStateRoot({ transcriptRoot: '/tmp/explicit-root', env: { BILLIARDBUDDY_STATE_DIR: '/should/be/ignored' } })
  expect(root).toBe('/tmp/explicit-root')
})
