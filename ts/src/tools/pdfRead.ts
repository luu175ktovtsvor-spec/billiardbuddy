// PDF 读取辅助 —— 纯代码(不装 npm、不引 poppler)实现 cc-haha FileReadTool 的 PDF 文档通道关键部分:
//  · 从魔数(%PDF-)判断是不是 PDF
//  · 生成 Anthropic document content-block(base64,media_type=application/pdf),让模型"看"PDF 而不是读乱码
//  · 粗估页数(扫 /Type /Page 标记,best-effort)供元信息展示
// 说明:cc 有两条 PDF 路——① 文档块直送(模型支持 PDF 时),② 用 poppler 把每页转成图像块(降级路)。
// 本仓库不装依赖、无 poppler,只能走①文档块直送;超大 PDF 给友好报错(不静默、不吐乱码)。
import type { DocumentBlock } from '../types/message'
import { documentBlock } from '../types/message'

// cc PDF_TARGET_RAW_SIZE = 20MB:base64 编码后仍能塞进单次 API 请求上限的原始 PDF 上限。超过给友好报错。
export const PDF_MAX_BYTES = 20 * 1024 * 1024

const DOCUMENT_EXTENSIONS = new Set(['pdf'])

/** 扩展名是否为 PDF(对齐 cc isPDFExtension;带不带前导点都行)。 */
export function isPdfExtension(ext: string): boolean {
  const normalized = ext.startsWith('.') ? ext.slice(1) : ext
  return DOCUMENT_EXTENSIONS.has(normalized.toLowerCase())
}

/** 从缓冲区魔数判断是不是 PDF(%PDF-,允许极少数前导字节偏移,不靠扩展名,防伪装/无扩展名)。 */
export function detectPdf(buffer: Buffer): boolean {
  if (buffer.length < 5) return false
  // 标准 PDF 以 "%PDF-" 开头;个别文件头部有极少量前导垃圾字节,扫前 1KB 容错。
  const head = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('latin1')
  return head.includes('%PDF-')
}

/** 粗估 PDF 页数:扫 "/Type /Page"(排除 /Pages)标记数,best-effort,失败返回 null。只用于元信息展示,不作硬闸。 */
export function estimatePdfPageCount(buffer: Buffer): number | null {
  try {
    const text = buffer.toString('latin1')
    const matches = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)
    if (matches && matches.length > 0) return matches.length
    return null
  } catch {
    return null
  }
}

export interface PdfReadResult {
  byteSize: number
  pageCountEstimate: number | null
  /** Anthropic document content-block(base64);由 loop 组进随 tool_result 尾随的 user 消息顶层。 */
  documentBlock: DocumentBlock
}

/** 读取 PDF 缓冲 → 文档块 + 元信息。不做分页渲染(无 poppler)。 */
export function readPdfBuffer(buffer: Buffer): PdfReadResult {
  return {
    byteSize: buffer.length,
    pageCountEstimate: estimatePdfPageCount(buffer),
    documentBlock: documentBlock(buffer.toString('base64')),
  }
}
