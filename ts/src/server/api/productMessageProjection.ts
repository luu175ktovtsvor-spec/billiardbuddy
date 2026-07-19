type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export type ProductMemorySavedData = {
  writtenCount: number
}

export function projectMemorySavedData(value: unknown): ProductMemorySavedData {
  if (!isRecord(value)) return { writtenCount: 0 }

  const writtenCount = value.writtenCount
  if (typeof writtenCount === 'number' && Number.isSafeInteger(writtenCount)) {
    return { writtenCount: Math.max(0, writtenCount) }
  }

  const writtenPaths = value.writtenPaths
  if (!Array.isArray(writtenPaths)) return { writtenCount: 0 }

  return {
    writtenCount: writtenPaths.filter((path) => typeof path === 'string' && path.trim().length > 0).length,
  }
}
