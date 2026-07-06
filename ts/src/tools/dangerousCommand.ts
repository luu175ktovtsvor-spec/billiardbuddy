/**
 * 危险命令最小种子(红线 4:删根/提权/格式化直接拒)。W2 只挡灾难级;
 * 完整分类器(可逆性/爆炸半径/审批档)是 W4。宁可漏杀(交 W4)不可错放这几条。
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$)/i, // rm -rf / | ~ | $HOME
  /\brm\s+(-[a-z]*\s+)*-[a-z]*f[a-z]*r?[a-z]*\s+(\/|~|\$HOME)(\s|$)/i,
  /\bsudo\b/, // 提权
  /\bmkfs\b/, // 格式化
  /\bdd\s+.*\bof=\/dev\//, // 覆写块设备
  /:\(\)\s*\{.*\}\s*;/, // fork 炸弹 :(){ :|:& };:
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\brm\s+(-[a-z]*\s+)*(\*|\/\*)(\s|$)/i, // rm * | rm /*（通配删大片）
  /\brm\s+(-[a-z]*\s+)*[A-Za-z]:[\\/]?(\s|$)/i, // rm C:\ | rm D:/（盘符根）
]

export type CommandRisk = 'read' | 'file' | 'outreach' | 'destructive'

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some(re => re.test(command))
}

function normalize(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

function splitSegments(command: string): string[] {
  return normalize(command).split(/\s*(?:&&|;)\s*/).map(x => x.trim()).filter(Boolean)
}

function hasWriteRedirection(command: string): boolean {
  return /(^|[^<])>>?[^&]/.test(command) || /\b\d>>?/.test(command)
}

function classifySegment(segment: string): CommandRisk {
  const command = normalize(segment).toLowerCase()
  if (!command) return 'read'
  if (isDangerousCommand(command)) return 'destructive'
  if (hasWriteRedirection(command)) return 'file'

  if (/\bgit\s+clean\s+-/.test(command)) return 'destructive'
  if (/\brm\s+.*-[a-z]*r/.test(command)) return 'destructive'

  if (/^(curl|wget|ssh|scp|sftp|ftp|telnet|nc|netcat|rsync)\b/.test(command)) return 'outreach'
  if (/^(gh|glab)\s+(api|auth|repo|pr|issue|release)\b/.test(command)) return 'outreach'
  if (/^(npm|pnpm|yarn|bun)\s+(install|add|upgrade|update|publish)\b/.test(command)) return 'outreach'
  if (/^(pip|pip3|uv|poetry)\s+(install|add|publish|update)\b/.test(command)) return 'outreach'
  if (/^(brew|apt|apt-get|dnf|yum|pacman|choco|winget)\s+(install|upgrade|update|remove)\b/.test(command)) return 'outreach'

  if (/^(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|tee)\b/.test(command)) return 'file'
  if (/\b(sed|perl)\s+.*\s-i\b/.test(command) || /\b(sed|perl)\s+-i\b/.test(command)) return 'file'
  if (/^git\s+(checkout|switch|restore|reset|merge|rebase|commit|tag|branch\s+(-d|-D)|apply|am|stash|pull|push)\b/.test(command)) return 'file'
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(build|compile|generate|lint\s+--fix|format|test)\b/.test(command)) return 'file'

  if (/^(pwd|ls|cat|head|tail|wc|rg|grep|find|stat|du|df|date|whoami|uname|which|type|printenv|env|echo)\b/.test(command)) {
    if (/^find\b.*\s-(delete|exec|execdir)\b/.test(command)) return 'file'
    return 'read'
  }
  if (/^git\s+(status|diff|log|show|branch|rev-parse|ls-files|grep|remote\s+-v)\b/.test(command)) return 'read'

  return 'file'
}

function maxRisk(a: CommandRisk, b: CommandRisk): CommandRisk {
  const rank: Record<CommandRisk, number> = { read: 0, file: 1, outreach: 2, destructive: 3 }
  return rank[b] > rank[a] ? b : a
}

export function classifyCommandRisk(command: string): CommandRisk {
  if (isDangerousCommand(command)) return 'destructive'
  return splitSegments(command).reduce<CommandRisk>((risk, segment) => maxRisk(risk, classifySegment(segment)), 'read')
}
