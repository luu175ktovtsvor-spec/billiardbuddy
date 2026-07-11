// Markdown 渲染(marked + dompurify + highlight.js)。owner 2026-07-11:代码块语法高亮 + 复制按钮。
// hljs token 色在 globals.css(用扒到的真实 Codex hljs 配色,靠 CSS 变量明暗自适应)。
import { useEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'

marked.setOptions({ gfm: true, breaks: true })

export function MarkdownRenderer({ content }: { content: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(content ?? '', { async: false }) as string
    return DOMPurify.sanitize(raw)
  }, [content])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = ref.current
    if (!root) return
    // 语法高亮(按 language-xxx class,无则自动识别)。
    root.querySelectorAll('pre code').forEach((code) => {
      const el = code as HTMLElement
      if (el.dataset.highlighted) return
      try {
        hljs.highlightElement(el)
      } catch {
        /* 某语言不支持时忽略,保持纯文本 */
      }
    })
    // 每个代码块加「复制」按钮(hover 显现)。
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.qf-code-copy')) return
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'qf-code-copy'
      btn.textContent = '复制'
      btn.addEventListener('click', () => {
        const codeText = pre.querySelector('code')?.textContent ?? pre.textContent ?? ''
        void navigator.clipboard?.writeText(codeText)
        btn.textContent = '已复制'
        window.setTimeout(() => { btn.textContent = '复制' }, 1200)
      })
      pre.appendChild(btn)
    })
  }, [html])

  return <div ref={ref} className="qf-markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
