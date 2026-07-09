// skills/commands 正文里的参数占位符替换。
// 对齐 cc-haha: ~/Desktop/cc-haha-ref/src/utils/argumentSubstitution.ts
//   - parseArguments      (同文件 L24-40)
//   - parseArgumentNames  (同文件 L50-68)
//   - substituteArguments (同文件 L94-145)
// 支持:
//   - $ARGUMENTS           全量参数原文
//   - $ARGUMENTS[0]/[1]... 按位置取切词后的参数
//   - $0/$1...             上面的简写
//   - $foo/$bar...         frontmatter `arguments` 字段声明的具名参数,按声明顺序映射到位置
// cc 用 shell-quote 库分词、并显式保留 $VAR 语法不做变量展开;本项目未引入该依赖,
// 这里用与 src/hooks/hookConfig.ts 里 parseHookArguments 同风格的纯 TS 引号切词
// (支持单/双引号包住的空格、反斜杠转义),不做变量展开,行为等价于 cc 的场景覆盖面。

/**
 * 把参数原文切成词数组,支持单/双引号包裹的空格。
 * "foo bar baz" => ["foo","bar","baz"]
 * 'foo "hello world" baz' => ["foo","hello world","baz"]
 */
export function parseArguments(args: string): string[] {
  if (!args || !args.trim()) return []
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | '' = ''
  let escaped = false
  let hasToken = false
  for (const ch of args) {
    if (escaped) {
      current += ch
      hasToken = true
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? '' : ch
      hasToken = true
      continue
    }
    if (!quote && /\s/.test(ch)) {
      if (hasToken) {
        out.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += ch
    hasToken = true
  }
  if (escaped) current += '\\'
  if (hasToken) out.push(current)
  return out
}

/**
 * 解析 frontmatter `arguments` 字段声明的具名参数名。
 * 接受空格分隔字符串或字符串数组;过滤空名和纯数字名(纯数字会和 $0/$1 简写冲突)。
 */
export function parseArgumentNames(argumentNames: string | string[] | undefined): string[] {
  if (!argumentNames) return []
  const isValidName = (name: string): boolean => typeof name === 'string' && name.trim() !== '' && !/^\d+$/.test(name)
  if (Array.isArray(argumentNames)) return argumentNames.map(String).filter(isValidName)
  if (typeof argumentNames === 'string') return argumentNames.split(/\s+/).filter(isValidName)
  return []
}

/**
 * 把 content 中的 $ARGUMENTS / $ARGUMENTS[n] / $n / 具名参数占位符替换成实际参数值。
 *
 * @param content 待替换正文
 * @param args 原始参数字符串;undefined/null 表示未提供参数,原样返回不替换
 * @param appendIfNoPlaceholder 正文里一个占位符都没命中、且 args 非空时,是否在末尾追加参数原文
 * @param argumentNames frontmatter `arguments` 声明的具名参数,按顺序映射到切词后的位置参数
 * @param fallbackLabel 追加参数原文时用的标签前缀(项目里各处用语不同,如"命令参数"/"用户给这个技能的参数")
 */
export function substituteArguments(
  content: string,
  args: string | undefined,
  appendIfNoPlaceholder = true,
  argumentNames: string[] = [],
  fallbackLabel = 'ARGUMENTS',
): string {
  // undefined/null 表示未提供参数,原样返回;空字符串是合法输入,占位符会被替换成空
  if (args === undefined || args === null) return content

  const parsedArgs = parseArguments(args)
  const originalContent = content

  // 具名参数(如 $foo)先替换,映射到 argumentNames[i] -> parsedArgs[i]
  for (let i = 0; i < argumentNames.length; i++) {
    const name = argumentNames[i]
    if (!name) continue
    // 匹配 $name 但不匹配 $name[...] 或 $nameXxx(词字符延续)
    content = content.replace(new RegExp(`\\$${name}(?![\\[\\w])`, 'g'), parsedArgs[i] ?? '')
  }

  // $ARGUMENTS[0]、$ARGUMENTS[1] 等索引参数
  content = content.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, indexStr: string) => parsedArgs[Number.parseInt(indexStr, 10)] ?? '')

  // $0、$1 等简写索引参数
  content = content.replace(/\$(\d+)(?!\w)/g, (_, indexStr: string) => parsedArgs[Number.parseInt(indexStr, 10)] ?? '')

  // $ARGUMENTS 替换成参数原文
  content = content.replaceAll('$ARGUMENTS', args)

  // 正文里没有任何占位符命中、且 args 非空时,追加参数原文,避免用户传了参数却被正文默默丢弃
  if (content === originalContent && appendIfNoPlaceholder && args) {
    content = `${content}\n\n${fallbackLabel}:\n${args}`
  }

  return content
}
