// 把 vendor 的工具 schema(buildComputerUseTools)+ 派发器(bindSessionContext)
// 组装成本内核的 Tool[]。这是 in-process 直连路径(等价于 cc 的 wrapper.tsx 内联
// 派发,但省掉 MCP transport):
//   buildComputerUseTools → 工具描述/schema(照 cc,已白标)
//   bindSessionContext    → dispatch(name, args) → CuCallToolResult
//   本文件                 → 每个 schema 包成 Tool,execute 调 dispatch,截图走
//                           ctx.imageResultSink 真 vision 回灌。

import type { Tool, JSONSchema, ToolContext } from '../Tool'
import type { ImageBlock } from '../../types/message'
import type { CuCallToolResult } from './vendor/toolCalls'
import { bindSessionContext, buildComputerUseTools } from './vendor/index'
import { getComputerUseHostAdapter } from './hostAdapter'
import { getComputerUseCoordinateMode } from './gates'
import { isComputerUseSupportedPlatform } from './common'
import { createComputerUseSession, type ComputerUseSessionOptions } from './sessionContext'

/** 只读工具(不动系统、可进 plan 模式/并发只读批)。
 *  screenshot / zoom 会产图 → 必须串行(imageResultSink 一一对应),故标非只读。 */
const READ_ONLY_TOOLS = new Set(['cursor_position', 'list_granted_applications', 'read_clipboard', 'wait'])

const CU_IMAGE_MEDIA_TYPE = 'image/jpeg' as const

export interface ComputerUseToolsOptions extends ComputerUseSessionOptions {
  /** 预先枚举的已安装 app 名字(拼进 request_access 描述给模型提示)。可选。 */
  installedAppNames?: string[]
}

interface MutableSignalRef {
  signal: AbortSignal | undefined
}

function toImageBlock(data: string): ImageBlock {
  return { type: 'image', source: { type: 'base64', media_type: CU_IMAGE_MEDIA_TYPE, data } }
}

/** 把 vendor 的 CuCallToolResult 转成本内核约定:文本汇成字符串,图像推进 imageResultSink。 */
function renderResult(result: CuCallToolResult, ctx: ToolContext): string {
  const texts: string[] = []
  let imageCount = 0
  for (const block of result.content) {
    if (block.type === 'text') {
      texts.push(block.text)
    } else if (block.type === 'image' && typeof (block as { data?: unknown }).data === 'string') {
      ctx.imageResultSink?.push(toImageBlock((block as { data: string }).data))
      imageCount += 1
    }
  }
  if (texts.length === 0 && imageCount > 0) {
    texts.push(imageCount === 1 ? '已截图(见附图)。' : `已生成 ${imageCount} 张图(见附图)。`)
  }
  const text = texts.join('\n').trim()
  if (result.isError) {
    return text || '本机控制动作失败(无附加信息)。'
  }
  return text || '完成。'
}

/**
 * 构建"本机控制"工具集。平台不支持(非 mac/win)→ 返回空数组(不注册任何工具)。
 * 不会在构建时起 Python 子进程 —— bootstrap 惰性发生在首个 execute 里。
 */
export function createComputerUseTools(opts: ComputerUseToolsOptions = {}): Tool[] {
  if (!isComputerUseSupportedPlatform()) return []

  const adapter = getComputerUseHostAdapter()
  const coordinateMode = getComputerUseCoordinateMode()
  const signalRef: MutableSignalRef = { signal: undefined }

  const session = createComputerUseSession({
    ...opts,
    isAborted: opts.isAborted ?? (() => signalRef.signal?.aborted === true),
  })

  const dispatch = bindSessionContext(adapter, coordinateMode, session.context)

  const schemas = buildComputerUseTools(
    { ...adapter.executor.capabilities, teachMode: false },
    coordinateMode,
    opts.installedAppNames,
  )

  return schemas.map((schema): Tool => ({
    name: schema.name,
    description: schema.description ?? '',
    inputSchema: schema.inputSchema as JSONSchema,
    isReadOnly: READ_ONLY_TOOLS.has(schema.name),
    async execute(input, ctx) {
      signalRef.signal = ctx.signal
      const result = await dispatch(schema.name, input ?? {})
      return renderResult(result, ctx)
    },
  }))
}
