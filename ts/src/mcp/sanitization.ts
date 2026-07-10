// 隐形 Unicode 净化 —— 防 MCP 供应链下毒。
// 对齐 cc(`~/Desktop/cc-haha-ref/src/utils/sanitization.ts`):任何连接的 MCP server 都可能是恶意的或已被攻陷,
// 能在 tool 名/描述、prompt 名/描述、resource 名/描述、工具调用结果文本里塞入不可见的 Unicode 字符
// (零宽字符、双向控制符、Unicode Tag 字符、私用区字符)——这些字符在 UI 上用户完全看不见,但会被模型当成
// 真实指令处理,构成隐藏的 prompt injection。这正是已披露真实漏洞 HackerOne #3086545 的攻击手法
// (https://embracethered.com/blog/posts/2024/hiding-and-finding-text-with-unicode-tags/)。
// 净化点覆盖两类:
//   1. NFKC 规范化:收敛各种 Unicode 组合/兼容字符变体到统一形式;
//   2. 剥离危险类目:Cf(格式控制)/Co(私用区)/Cn(未赋值)Unicode property class,
//      外加一组显式字符范围兜底(部分运行时/正则引擎不完整支持 unicode property class 时仍生效)。
// 净化在任何情况下都无条件启用,不受配置开关影响。
//
// ⚠️ 下面的危险字符范围一律用 codePoint 数值 + String.fromCodePoint 拼出正则,不直接在源码字符串里敲
// 不可见字符本身——那样源文件里会真的含有本模块要清除的东西,编辑器/diff/编码链路也未必保真。

const MAX_ITERATIONS = 10 // 防极端/恶意构造的深层嵌套输入导致净化死循环的安全阀

function codePointRange(startCodePoint: number, endCodePoint: number): RegExp {
  return new RegExp(`[${String.fromCodePoint(startCodePoint)}-${String.fromCodePoint(endCodePoint)}]`, 'g')
}

const ZERO_WIDTH_AND_DIRECTIONAL_MARKS = codePointRange(0x200b, 0x200f) // 零宽字符 / 从左至右-从右至左标记
const DIRECTIONAL_FORMATTING = codePointRange(0x202a, 0x202e) // 双向格式控制符
const DIRECTIONAL_ISOLATES = codePointRange(0x2066, 0x2069) // 双向隔离符
const BYTE_ORDER_MARK = codePointRange(0xfeff, 0xfeff) // 字节顺序标记(BOM)
const PRIVATE_USE_AREA = codePointRange(0xe000, 0xf8ff) // 基本多语言平面私用区(含 Unicode Tag 字符常落地的区间)
const DANGEROUS_UNICODE_CATEGORIES = /[\p{Cf}\p{Co}\p{Cn}]/gu // 格式控制 / 私用区 / 未赋值

/** 对单个字符串做隐形 Unicode 净化;迭代到不再变化为止(NFKC 展开可能产生新的待剥离字符)。 */
export function partiallySanitizeUnicode(text: string): string {
  let current = text
  let previous = ''
  let iterations = 0

  while (current !== previous && iterations < MAX_ITERATIONS) {
    previous = current
    current = current.normalize('NFKC')
    // 方法一:剥离危险 Unicode property class(主防线,多数 OSS 库采用的做法)。
    current = current.replace(DANGEROUS_UNICODE_CATEGORIES, '')
    // 方法二:显式字符范围兜底(个别环境对 unicode property class 正则支持不完整)。
    current = current
      .replace(ZERO_WIDTH_AND_DIRECTIONAL_MARKS, '')
      .replace(DIRECTIONAL_FORMATTING, '')
      .replace(DIRECTIONAL_ISOLATES, '')
      .replace(BYTE_ORDER_MARK, '')
      .replace(PRIVATE_USE_AREA, '')
    iterations++
  }

  if (iterations >= MAX_ITERATIONS) {
    // 正常输入不会触发;只有 bug 或刻意构造的攻击载荷才会一直产生新待剥离字符,此时宁可报错也别放行。
    throw new Error(`Unicode 净化超过最大迭代次数(${MAX_ITERATIONS}),疑似异常/恶意嵌套输入:${text.slice(0, 100)}`)
  }

  return current
}

/** 递归净化任意值(字符串/数组/纯对象含 key)里的隐形 Unicode;非字符串原始值原样返回。 */
export function recursivelySanitizeUnicode<T>(value: T): T {
  return sanitizeDeep(value) as T
}

function sanitizeDeep(value: unknown): unknown {
  if (typeof value === 'string') return partiallySanitizeUnicode(value)
  if (Array.isArray(value)) return value.map(sanitizeDeep)
  if (value !== null && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      sanitized[partiallySanitizeUnicode(key)] = sanitizeDeep(val)
    }
    return sanitized
  }
  return value
}
