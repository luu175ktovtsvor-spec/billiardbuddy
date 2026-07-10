import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { stableStringify } from './canonical'

/** 规范化 (tool,args):复用 canonical.stableStringify(键序排序 + 紧凑),等价 Python approval._canonical。 */
function canonical(tool: string, args: unknown): string {
  return stableStringify({ tool, args: args ?? {} })
}

/**
 * 审批签名密钥:优先 env SECRET_KEY;未设置时**进程内随机生成一次**(不再退空串——空串密钥等于
 * 印章没刻字,任何知道格式的一方都能伪造"已批准"令牌)。随机密钥不落盘:sidecar 重启后旧审批
 * 令牌自然失效 → 审批卡重新弹一次,是安全的失败方向(比持久化一把本地私钥更简单也更稳)。
 */
let generatedSecret: string | null = null

function defaultSecret(): string {
  const fromEnv = process.env.SECRET_KEY
  if (fromEnv) return fromEnv
  generatedSecret ??= randomBytes(32).toString('hex')
  return generatedSecret
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
