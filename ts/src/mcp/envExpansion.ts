// MCP server 配置的环境变量展开(照抄 cc services/mcp/envExpansion.ts:10-46)。
// 官方 .mcp.json 契约:command / args / env / url / headers 五处都支持 ${VAR} 与 ${VAR:-default};
// 引用了未定义且无默认值的变量 = 配置错误,连接前报错指名道姓(否则 "${MY_TOKEN}" 会被当字面量发出去、鉴权静默失效)。

import type { McpServerConfig } from './config'

/**
 * 展开一个字符串里的 ${VAR} / ${VAR:-default}。
 * 与 cc 逐字一致:`varContent.split(':-', 2)`——JS 的 split limit 会截断,默认值本身再含 `:-` 时只取第一段
 * (cc 现实现即如此,行为对齐优先,不自行"修正")。未定义且无默认 → 保留原文并记入 missingVars。
 */
export function expandEnvVarsInString(
  value: string,
  env: Record<string, string | undefined> = process.env,
): { expanded: string; missingVars: string[] } {
  const missingVars: string[] = []
  const expanded = value.replace(/\$\{([^}]+)\}/g, (match, varContent: string) => {
    const [varName, defaultValue] = varContent.split(':-', 2)
    const envValue = env[varName!]
    if (envValue !== undefined) return envValue
    if (defaultValue !== undefined) return defaultValue
    missingVars.push(varName!)
    return match
  })
  return { expanded, missingVars }
}

/**
 * 对整份 server 配置做展开,返回展开后的副本;任一字段引用了未定义变量则抛错(汇总去重列全变量名)。
 * 在 createTransport 起点调用——即"真的要连它"的时刻,配置仅声明不连接时不误报。
 */
export function expandMcpServerConfig(
  config: McpServerConfig,
  env: Record<string, string | undefined> = process.env,
): McpServerConfig {
  const missing: string[] = []
  const expand = (value: string): string => {
    const out = expandEnvVarsInString(value, env)
    missing.push(...out.missingVars)
    return out.expanded
  }
  const expandRecord = (record: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (!record) return record
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(record)) out[k] = expand(v)
    return out
  }
  const expanded: McpServerConfig = {
    ...config,
    ...(config.command !== undefined ? { command: expand(config.command) } : {}),
    ...(config.args !== undefined ? { args: config.args.map(expand) } : {}),
    ...(config.url !== undefined ? { url: expand(config.url) } : {}),
    ...(config.env !== undefined ? { env: expandRecord(config.env) } : {}),
    ...(config.headers !== undefined ? { headers: expandRecord(config.headers) } : {}),
  }
  if (missing.length > 0) {
    throw new Error(`MCP server ${config.name} 配置引用了未定义的环境变量: ${[...new Set(missing)].join(', ')}(可用 \${VAR:-默认值} 提供缺省)`)
  }
  return expanded
}
