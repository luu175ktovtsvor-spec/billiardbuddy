import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * 工作区级 `.mcp.json` 信任闸(对齐 cc `mcpServerApproval` 的防 RCE 考量)。
 *
 * 打开任意用户仓库的 coding agent,若目标仓库提交了恶意 `<workspaceRoot>/.mcp.json`(stdio server =
 * 任意命令),自动连接就等于无感 RCE。cc 对项目级 .mcp.json 有 pending/approved/rejected 首次信任确认。
 * 本模块做后端信任闸:工作区级 .mcp.json 默认**不自动连**,除非该工作区根已被显式批准(持久化)或用户
 * 显式指定了 mcpConfigPath。app 自身的库级/全局配置(DESKTOP_LIBRARY_DIR、~/.billiards-desktop、cwd)
 * 属可信来源,不受此闸约束。审批 UI 待 ts-desktop;当前批准入口是 POST /api/v1/agent/mcp/trust。
 */
export class McpTrustStore {
  private readonly filePath: string
  private roots: Set<string>

  constructor(filePath: string) {
    this.filePath = filePath
    this.roots = new Set(this.read())
  }

  private read(): string[] {
    try {
      if (!existsSync(this.filePath)) return []
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
      return Array.isArray(parsed?.approvedWorkspaceRoots) ? parsed.approvedWorkspaceRoots.filter((r: unknown): r is string => typeof r === 'string') : []
    } catch {
      return []
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify({ approvedWorkspaceRoots: [...this.roots] }, null, 2))
    } catch {
      // 信任落盘失败不阻断主流程(下次仍会当未信任、走安全默认)
    }
  }

  isTrusted(workspaceRoot: string): boolean {
    return this.roots.has(resolve(workspaceRoot))
  }

  trust(workspaceRoot: string): void {
    this.roots.add(resolve(workspaceRoot))
    this.write()
  }

  revoke(workspaceRoot: string): void {
    if (this.roots.delete(resolve(workspaceRoot))) this.write()
  }

  list(): string[] {
    return [...this.roots]
  }
}

export interface TrustedMcpConfigResult {
  /** 实际要加载的配置路径;untrusted 工作区级配置被拦下时为 undefined(不连接)。 */
  path: string | undefined
  /** 命中"工作区级 .mcp.json 未信任被拦"时给出的人话警告(回灌前端/模型)。 */
  warning?: string
}

/**
 * 决定某个 mcpConfigPath 是否可加载。工作区级 `<workspaceRoot>/.mcp.json` 未信任 → 拦下并给警告;
 * 显式指定(explicit)、已信任、或非工作区级(app 库/全局配置)→ 放行。
 */
export function resolveTrustedMcpConfig(input: {
  configPath: string | undefined
  workspaceRoot: string
  explicit: boolean
  store: McpTrustStore
}): TrustedMcpConfigResult {
  const { configPath, workspaceRoot, explicit, store } = input
  if (!configPath) return { path: undefined }
  if (explicit) return { path: configPath }
  const workspaceConfig = resolve(configPath) === resolve(join(workspaceRoot, '.mcp.json'))
  if (!workspaceConfig) return { path: configPath }
  if (store.isTrusted(workspaceRoot)) return { path: configPath }
  return {
    path: undefined,
    warning: `工作区里的 .mcp.json 尚未被信任,已跳过自动连接(防止恶意仓库通过 .mcp.json 自动执行任意命令)。确认可信后可批准该工作区(POST /api/v1/agent/mcp/trust)再连接。`,
  }
}
