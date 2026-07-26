import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import { basename } from 'node:path'

export type PublishedUpdateVerificationInput = {
  baseUrl: string
  expectedVersion: string
  metadataPath: string
  artifactPaths: string[]
}

export type PublishedUpdateVerificationResult = {
  version: string
  metadata: string
  artifacts: Array<{ name: string, size: number }>
}

type FetchLike = typeof fetch

function releaseUrl(baseUrl: string, name: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(name)}`
}

function metadataVersion(metadata: string): string | null {
  return metadata.match(/^version:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1] ?? null
}

function readRange(path: string, start: number, end: number): Buffer {
  const length = end - start + 1
  const output = Buffer.alloc(length)
  const descriptor = openSync(path, 'r')
  try {
    const bytesRead = readSync(descriptor, output, 0, length, start)
    if (bytesRead !== length) throw new Error(`无法读取发布文件校验片段: ${basename(path)}`)
    return output
  } finally {
    closeSync(descriptor)
  }
}

async function responseBytes(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer())
}

export async function verifyPublishedUpdate(
  input: PublishedUpdateVerificationInput,
  fetchImpl: FetchLike = fetch,
): Promise<PublishedUpdateVerificationResult> {
  const expectedVersion = input.expectedVersion.trim()
  if (!expectedVersion) throw new Error('正式更新源验收缺少预期版本')
  if (input.artifactPaths.length === 0) throw new Error('正式更新源验收缺少发布文件')

  const localMetadata = readFileSync(input.metadataPath)
  const localMetadataText = localMetadata.toString('utf8')
  const actualVersion = metadataVersion(localMetadataText)
  if (actualVersion !== expectedVersion) {
    throw new Error(`更新清单版本不匹配: 预期 ${expectedVersion}，实际 ${actualVersion ?? '无版本'}`)
  }

  const metadataName = basename(input.metadataPath)
  const remoteMetadataResponse = await fetchImpl(releaseUrl(input.baseUrl, metadataName), {
    headers: { 'cache-control': 'no-cache' },
  })
  if (!remoteMetadataResponse.ok) {
    throw new Error(`正式更新清单不可访问: ${metadataName} HTTP ${remoteMetadataResponse.status}`)
  }
  const remoteMetadata = await responseBytes(remoteMetadataResponse)
  if (!remoteMetadata.equals(localMetadata)) {
    throw new Error(`正式更新清单与本次发布不一致: ${metadataName}`)
  }

  const artifacts: Array<{ name: string, size: number }> = []
  for (const artifactPath of input.artifactPaths) {
    const name = basename(artifactPath)
    const size = statSync(artifactPath).size
    if (size <= 0) throw new Error(`本地发布文件为空: ${name}`)
    if (!name.endsWith('.blockmap') && !localMetadataText.includes(`url: ${name}`)) {
      throw new Error(`更新清单没有引用正式发布文件: ${name}`)
    }
    const url = releaseUrl(input.baseUrl, name)
    const head = await fetchImpl(url, { method: 'HEAD', headers: { 'cache-control': 'no-cache' } })
    if (!head.ok) throw new Error(`正式发布文件不可访问: ${name} HTTP ${head.status}`)
    if (Number(head.headers.get('content-length')) !== size) {
      throw new Error(`正式发布文件大小不匹配: ${name}`)
    }
    if (head.headers.get('accept-ranges')?.toLowerCase() !== 'bytes') {
      throw new Error(`正式发布文件不支持断点续传: ${name}`)
    }

    const sampleSize = Math.min(size, 4096)
    const ranges = [
      { start: 0, end: sampleSize - 1 },
      ...(size > sampleSize ? [{ start: size - sampleSize, end: size - 1 }] : []),
    ]
    for (const range of ranges) {
      const response = await fetchImpl(url, {
        headers: {
          'cache-control': 'no-cache',
          range: `bytes=${range.start}-${range.end}`,
        },
      })
      if (response.status !== 206) {
        throw new Error(`正式发布文件不接受字节范围请求: ${name} HTTP ${response.status}`)
      }
      const remote = await responseBytes(response)
      const local = readRange(artifactPath, range.start, range.end)
      if (!remote.equals(local)) throw new Error(`正式发布文件内容不匹配: ${name}`)
    }
    artifacts.push({ name, size })
  }

  return { version: actualVersion, metadata: metadataName, artifacts }
}

function parseArgs(argv: string[]): PublishedUpdateVerificationInput {
  const values = new Map<string, string>()
  const artifactPaths: string[] = []
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name || !value || !['--base-url', '--expected-version', '--metadata', '--artifact'].includes(name)) {
      throw new Error('用法: verify-published-update.ts --base-url <url> --expected-version <version> --metadata <file> --artifact <file> [...]')
    }
    if (name === '--artifact') artifactPaths.push(value)
    else values.set(name, value)
  }
  const baseUrl = values.get('--base-url')
  const expectedVersion = values.get('--expected-version')
  const metadataPath = values.get('--metadata')
  if (!baseUrl || !expectedVersion || !metadataPath || artifactPaths.length === 0) {
    throw new Error('正式更新源验收参数不完整')
  }
  return { baseUrl, expectedVersion, metadataPath, artifactPaths }
}

if (import.meta.main) {
  const result = await verifyPublishedUpdate(parseArgs(process.argv.slice(2)))
  console.log(JSON.stringify({ accepted: true, ...result }))
}
