/**
 * 破坏性命令警告(对齐 cc destructiveCommandWarning.getDestructiveCommandWarning):检测可能破坏性的
 * 命令,返回一句人话警告用于审批卡显示。**纯信息性——不影响权限判定/自动放行逻辑**(那是 dangerousCommand
 * 的职责)。用途:审批卡上给用户一个"这条命令可能会…"的提示,降低误批风险。
 */

interface DestructivePattern {
  pattern: RegExp
  warning: string
}

const DESTRUCTIVE_PATTERNS: DestructivePattern[] = [
  { pattern: /\bgit\s+reset\s+--hard\b/, warning: '注意:可能丢弃未提交的改动' },
  { pattern: /\bgit\s+push\b[^;&|\n]*[ \t](--force|--force-with-lease|-f)\b/, warning: '注意:可能覆盖远端历史' },
  { pattern: /\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/, warning: '注意:可能永久删除未跟踪文件' },
  { pattern: /\bgit\s+checkout\s+(--\s+)?\.[ \t]*($|[;&|\n])/, warning: '注意:可能丢弃所有工作区改动' },
  { pattern: /\bgit\s+restore\s+(--\s+)?\.[ \t]*($|[;&|\n])/, warning: '注意:可能丢弃所有工作区改动' },
  { pattern: /\bgit\s+stash[ \t]+(drop|clear)\b/, warning: '注意:可能永久移除 stash 的改动' },
  { pattern: /\bgit\s+branch\s+(-D[ \t]|--delete\s+--force|--force\s+--delete)\b/, warning: '注意:可能强制删除分支' },
  { pattern: /\bgit\s+(commit|push|merge)\b[^;&|\n]*--no-verify\b/, warning: '注意:可能跳过安全钩子' },
  { pattern: /\bgit\s+commit\b[^;&|\n]*--amend\b/, warning: '注意:可能改写上一次提交' },
  { pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/, warning: '注意:可能递归强制删除文件' },
  { pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR]/, warning: '注意:可能递归删除文件' },
  { pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f/, warning: '注意:可能强制删除文件' },
  { pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, warning: '注意:可能删除或清空数据库对象' },
  { pattern: /\bDELETE\s+FROM\s+\w+[ \t]*(;|"|'|\n|$)/i, warning: '注意:可能删除数据库表的所有行' },
  { pattern: /\bkubectl\s+delete\b/, warning: '注意:可能删除 Kubernetes 资源' },
  { pattern: /\bterraform\s+destroy\b/, warning: '注意:可能销毁 Terraform 基础设施' },
]

/** 命中已知破坏性模式则返回人话警告,否则 null。 */
export function getDestructiveCommandWarning(command: string): string | null {
  for (const { pattern, warning } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) return warning
  }
  return null
}
