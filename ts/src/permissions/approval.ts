import { createHmac, timingSafeEqual } from 'node:crypto'
import { stableStringify } from './canonical'

/** 规范化 (tool,args):复用 canonical.stableStringify(键序排序 + 紧凑),等价 Python approval._canonical。 */
function canonical(tool: string, args: unknown): string {
  return stableStringify({ tool, args: args ?? {} })
}

/** 默认从 env 读密钥(W5 接真 config);缺省空串 = 照 Python `settings.secret_key or ""` 的宽松兜底。 */
function defaultSecret(): string {
  return process.env.SECRET_KEY ?? ''
}

export function signApproval(tool: string, args: unknown, secret: string = defaultSecret()): string {
  let c: string
  try {
    c = canonical(tool, args)
  } catch {
    c = `${tool}:<unserializable>` // 不可序列化 args(循环引用/BigInt)→ 稳定回退,签名不抛;verify 走同一条路故一致
  }
  return createHmac('sha256', secret).update(c, 'utf8').digest('hex')
}

/** token 与 (tool,args) 是否匹配。空 token→false;畸形/长度不符→false(不抛,照 approval.py 的 TypeError 兜底)。 */
export function verifyApproval(
  tool: string,
  args: unknown,
  token: string | null | undefined,
  secret: string = defaultSecret(),
): boolean {
  if (!token || typeof token !== 'string') return false
  try {
    const expected = signApproval(tool, args, secret)
    if (expected.length !== token.length) return false // timingSafeEqual 长度不等会抛,先挡
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(token, 'utf8'))
  } catch {
    return false
  }
}
