/**
 * 破坏性命令警告(对齐 cc destructiveCommandWarning.getDestructiveCommandWarning):检测可能破坏性的
 * 命令,返回一句人话警告用于审批卡显示。**纯信息性——不影响权限判定/自动放行逻辑**(那是 dangerousCommand
 * 的职责)。用途:审批卡上给用户一个"这条命令可能会…"的提示,降低误批风险。
 *
 * Windows/cmd 段的起始锚复用 dangerousCommand 的 WIN_STMT_START 单一常量(别再手抄一份,
 * 否则两处漂移就是引号/前导空白转手漏弹卡片的洞)。
 */
import { WIN_STMT_START } from './dangerousCommand'

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
  // Windows / cmd.exe 原生毁灭命令(纯提示;拦截逻辑在 dangerousCommand.ts,起始锚复用其单一常量)。
  { pattern: new RegExp(`${WIN_STMT_START}format(?:\\.com)?\\s+[^|;&\\n]*?(?:["']?[a-z]:|/fs:)`, 'i'), warning: '注意:可能格式化磁盘卷(数据无法恢复)' },
  { pattern: new RegExp(`${WIN_STMT_START}diskpart(?:\\.exe)?\\b`, 'i'), warning: '注意:可能重写磁盘分区表' },
  { pattern: new RegExp(`${WIN_STMT_START}cipher(?:\\.exe)?\\s+[^|;&\\n]*/w`, 'i'), warning: '注意:可能安全擦除磁盘空闲空间(不可恢复)' },
  { pattern: new RegExp(`${WIN_STMT_START}vssadmin(?:\\.exe)?\\s+[^|;&\\n]*delete`, 'i'), warning: '注意:可能删除卷影副本(备份无法恢复)' },
  { pattern: new RegExp(`${WIN_STMT_START}bcdedit(?:\\.exe)?\\s+[^|;&\\n]*/(?:delete|deletevalue|set|import)`, 'i'), warning: '注意:可能篡改启动配置导致系统无法引导' },
  { pattern: new RegExp(`${WIN_STMT_START}(?:del|erase|rd|rmdir)\\b[^|;&\\n]*\\s/s\\b`, 'i'), warning: '注意:可能递归删除整个目录树' },
  { pattern: new RegExp(`${WIN_STMT_START}reg(?:\\.exe)?\\s+delete\\b`, 'i'), warning: '注意:可能删除注册表键' },
  { pattern: new RegExp(`${WIN_STMT_START}sc(?:\\.exe)?\\s+delete\\b`, 'i'), warning: '注意:可能删除 Windows 服务' },
  { pattern: new RegExp(`${WIN_STMT_START}taskkill(?:\\.exe)?\\b`, 'i'), warning: '注意:可能强制结束进程(目标应用可能丢数据)' },
  { pattern: new RegExp(`${WIN_STMT_START}(?:takeown|icacls|cacls)(?:\\.exe)?\\b`, 'i'), warning: '注意:可能夺取文件所有权或批量改写权限' },
  // PowerShell 毁灭 cmdlet(纯提示;起始锚同样复用共享常量,覆盖引号/-Command 转手)。
  { pattern: new RegExp(`${WIN_STMT_START}(?:remove-item|ri|rm|del|rd|rmdir)\\b[^|;&\\n}]*-recurse\\b[^|;&\\n}]*-force\\b`, 'i'), warning: '注意:可能递归强制删除文件' },
  { pattern: new RegExp(`${WIN_STMT_START}(?:remove-item|ri|rm|del|rd|rmdir)\\b[^|;&\\n}]*-force\\b[^|;&\\n}]*-recurse\\b`, 'i'), warning: '注意:可能递归强制删除文件' },
  { pattern: new RegExp(`${WIN_STMT_START}format-volume\\b`, 'i'), warning: '注意:可能格式化磁盘卷(数据无法恢复)' },
  { pattern: new RegExp(`${WIN_STMT_START}clear-disk\\b`, 'i'), warning: '注意:可能清空整块磁盘' },
  { pattern: new RegExp(`${WIN_STMT_START}clear-recyclebin\\b`, 'i'), warning: '注意:可能永久删除回收站文件' },
  { pattern: new RegExp(`${WIN_STMT_START}(?:stop-computer|restart-computer)\\b`, 'i'), warning: '注意:可能关闭或重启计算机' },
]

/** 命中已知破坏性模式则返回人话警告,否则 null。 */
export function getDestructiveCommandWarning(command: string): string | null {
  for (const { pattern, warning } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) return warning
  }
  return null
}
