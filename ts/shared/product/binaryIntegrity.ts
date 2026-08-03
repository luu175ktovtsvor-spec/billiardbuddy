import { createHash } from 'node:crypto'

export type BinaryHashMode = 'sha256' | 'mach-o-code-signature-neutral-sha256'

export function isThinMachO64(bytes: Buffer): boolean {
  return bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf
}

function machOCodeSignatureNeutralSha256(bytes: Buffer): string {
  if (!isThinMachO64(bytes)) throw new Error('不是受支持的 64 位小端 Mach-O 文件')

  const commandCount = bytes.readUInt32LE(16)
  const commandsSize = bytes.readUInt32LE(20)
  const commandsEnd = 32 + commandsSize
  if (commandsEnd > bytes.length) throw new Error('Mach-O load commands 越界')

  const normalized = Buffer.from(bytes)
  let commandOffset = 32
  let signatureOffset: number | undefined
  let signatureSize: number | undefined
  let linkEditFound = false
  for (let index = 0; index < commandCount; index += 1) {
    if (commandOffset + 8 > commandsEnd) throw new Error('Mach-O load command 不完整')
    const command = bytes.readUInt32LE(commandOffset)
    const commandSize = bytes.readUInt32LE(commandOffset + 4)
    if (commandSize < 8 || commandOffset + commandSize > commandsEnd) {
      throw new Error('Mach-O load command 大小无效')
    }
    if (command === 0x1d) {
      if (commandSize < 16 || signatureOffset !== undefined) {
        throw new Error('Mach-O code signature command 无效')
      }
      signatureOffset = bytes.readUInt32LE(commandOffset + 8)
      signatureSize = bytes.readUInt32LE(commandOffset + 12)
      normalized.writeUInt32LE(0, commandOffset + 8)
      normalized.writeUInt32LE(0, commandOffset + 12)
    }
    if (command === 0x19 && commandSize >= 72) {
      const segmentName = bytes.subarray(commandOffset + 8, commandOffset + 24)
        .toString('utf8')
        .replace(/\0+$/, '')
      if (segmentName === '__LINKEDIT') {
        if (linkEditFound) throw new Error('Mach-O 包含重复的 __LINKEDIT segment')
        linkEditFound = true
        normalized.writeBigUInt64LE(0n, commandOffset + 32)
        normalized.writeBigUInt64LE(0n, commandOffset + 48)
      }
    }
    commandOffset += commandSize
  }
  if (commandOffset !== commandsEnd) throw new Error('Mach-O load commands 长度不一致')
  if (signatureOffset === undefined || signatureSize === undefined) throw new Error('Mach-O 缺少 code signature command')
  if (!linkEditFound) throw new Error('Mach-O 缺少 __LINKEDIT segment')
  if (signatureOffset < commandsEnd || signatureOffset + signatureSize > bytes.length) {
    throw new Error('Mach-O code signature 区域越界')
  }

  return createHash('sha256')
    .update(normalized.subarray(0, signatureOffset))
    .update(normalized.subarray(signatureOffset + signatureSize))
    .digest('hex')
}

export function binaryIntegritySha256(bytes: Buffer, mode: BinaryHashMode): string {
  return mode === 'mach-o-code-signature-neutral-sha256'
    ? machOCodeSignatureNeutralSha256(bytes)
    : createHash('sha256').update(bytes).digest('hex')
}
