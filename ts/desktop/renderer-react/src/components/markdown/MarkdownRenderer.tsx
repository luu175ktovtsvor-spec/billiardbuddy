// Markdown 渲染(marked + dompurify,和 cc 一致的库选型)。
// ⚠️ Block A 会用 cc 完整版 MarkdownRenderer 替换(加 shiki 代码高亮 / mermaid / katex / diff),
//    本文件是地基期最小可用版:安全地把 markdown 渲成富文本。留同名接口方便替换。
import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

export function MarkdownRenderer({ content }: { content: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(content ?? '', { async: false }) as string
    return DOMPurify.sanitize(raw)
  }, [content])
  return <div className="qf-markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
