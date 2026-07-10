import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 解析 app 内置资源目录(bundled agents / skills / commands 的 `.md`)。
 *
 * ⚠️ 打包命门(2026-07-11 审计发现,实证过:从 repo 外跑编译二进制→命令/技能/子代理全 0):
 * 编译二进制里 `import.meta.dir` 是虚拟 `/$bunfs`(readdir 读的 .md 不会被 `bun --compile` 嵌入)、
 * 且 electron 把 sidecar cwd 锚到 userData——两条 dev 定位路径在打包态全失效,导致 bundled
 * 子代理 / 技能 / 命令三层能力**静默蒸发**。
 *
 * 修法:优先按**二进制自身位置**(`process.execPath`,Bun 编译态返回二进制绝对路径、与 cwd 无关)
 * 定位随包资源——electron-builder 把三个 bundled 目录发到 `Resources/bundled/<name>`,与
 * `Resources/binaries/<sidecar>` 同级,故从二进制看是 `<execDir>/../bundled/<name>`。
 * dev(`bun run`)下 execPath 是 bun 可执行、对应候选不存在,自然回落到 import.meta.dir / cwd 候选。
 * 另留 env 覆盖 `QF_BUNDLED_DIR`(最高优先,便于自定义部署 / 测试注入),不设不影响。
 *
 * @param name bundled 子目录名:'agents' | 'skills' | 'commands'
 * @param devCandidates dev/测试候选绝对路径(import.meta.dir / cwd 派生),按序兜底
 */
export function resolveBundledDir(name: 'agents' | 'skills' | 'commands', devCandidates: string[]): string {
  const candidates: string[] = []
  const envRoot = process.env.QF_BUNDLED_DIR
  if (envRoot) candidates.push(join(envRoot, name))
  try {
    // execPath 在 Bun 编译二进制里是二进制自身绝对路径;dev 下是 bun 可执行(候选不存在→跳过)。
    candidates.push(join(dirname(process.execPath), '..', 'bundled', name))
  } catch {
    // process.execPath 理论上恒有值;防御性兜底,不因它抛错就崩。
  }
  candidates.push(...devCandidates)
  return candidates.find(existsSync) ?? devCandidates[0] ?? candidates[0]!
}
