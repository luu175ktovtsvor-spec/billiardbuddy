// 测试全局隔离(bun test preload):把「显式全局默认工作区」env 指向系统临时目录并建好。
// 目的:① 不选 working_dir 的 run_command 用默认工作区当 spawn cwd —— 需真实存在的目录,否则 posix_spawn 报 ENOENT;
//      ② 绝不在单测里污染真实的 ~/Documents/球房管家/。
// 只在未显式设置时兜底,单个测试仍可自行覆盖 BILLIARDBUDDY_WORKSPACE_DIR。
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.BILLIARDBUDDY_WORKSPACE_DIR) {
  const dir = join(tmpdir(), 'billiardbuddy-test-workspace')
  mkdirSync(dir, { recursive: true })
  process.env.BILLIARDBUDDY_WORKSPACE_DIR = dir
}

// 回合末后台记忆抽取(extractMemories)默认全局关掉:它是 fire-and-forget、会额外 fork 调 model.step,
// 会打乱按精确步数断言的 loop/server 测试并跨测试泄漏。生产在 sidecar 里默认开(见 backend-sidecar.ts);
// 专门测抽取的 src/memory/extractMemories.test.ts 会在 beforeEach 自行重开。
if (!process.env.BILLIARDBUDDY_DISABLE_MEMORY_EXTRACT) {
  process.env.BILLIARDBUDDY_DISABLE_MEMORY_EXTRACT = '1'
}
