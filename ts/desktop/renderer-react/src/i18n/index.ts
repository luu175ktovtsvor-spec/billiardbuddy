// 极简 i18n(对齐 cc 的 useTranslation() + locale 表,起步只做 zh-CN)。
// 用法:t('chat.send')。cc 组件抄来后文案已是 t('key'),往 locales/zh-CN.ts 填 key 即可。
import { zhCN } from './locales/zh-CN'

const locales = { 'zh-CN': zhCN }
type LocaleKey = keyof typeof locales
let current: LocaleKey = 'zh-CN'

export function setLocale(key: LocaleKey) {
  current = key
}

/** 点分路径取值:t('chat.send')。缺失时回退 key 本身(便于发现漏翻)。 */
export function t(path: string): string {
  const parts = path.split('.')
  let node: unknown = locales[current]
  for (const p of parts) {
    if (node && typeof node === 'object' && p in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[p]
    } else {
      return path
    }
  }
  return typeof node === 'string' ? node : path
}

/** hook 形态(对齐 cc useTranslation),方便后续抄组件。 */
export function useTranslation() {
  return { t }
}
