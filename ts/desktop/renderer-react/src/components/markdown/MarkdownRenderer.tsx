// Markdown 渲染(marked + dompurify + highlight.js)。owner 2026-07-11:代码块语法高亮 + 复制按钮。
// hljs token 色在 globals.css(用扒到的真实 Codex hljs 配色,靠 CSS 变量明暗自适应)。
// 正文文件名 chip(对齐 Codex markdown.fileReference):行内代码里的文件路径渲成可点 chip
//(表格类=蓝链接+类型色点),点击 → 右面板 openFile;识别规则与边界见 lib/fileReference.ts。
import { useEffect, useMemo, useRef } from 'react'
import { marked, type Tokens } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { useFilePreviewStore } from '../../stores/filePreviewStore'
import { fileRefFromCode } from '../../lib/fileReference'
import { fileColor } from '../workspace/FileTree'
import { authenticatedResourceUrl, getBaseUrl } from '../../api/client'

marked.setOptions({ gfm: true, breaks: true })

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

// codespan 渲染期的旁路标记:本次 parse 是否遇到「要等工作树才能判定」的单文件名(如 package.json)。
// marked.parse 是同步的,parse 前清零、parse 后立刻读,多个 MarkdownRenderer 实例间不会串。
let sawTreePending = false

marked.use({
  renderer: {
    codespan(token: Tokens.Codespan): string | false {
      const ref = fileRefFromCode(token.text, useFilePreviewStore.getState().tree)
      if (ref === 'need-tree') {
        sawTreePending = true
        return false
      }
      if (!ref) return false // 不是文件引用 → 走默认 <code> 渲染
      const dot = ref.sheet ? `<span class="qf-file-chip-dot" style="background:${fileColor(ref.name)}"></span>` : ''
      const cls = ref.sheet ? 'qf-file-chip qf-file-chip--sheet' : 'qf-file-chip'
      return `<button type="button" class="${cls}" data-path="${escapeHtml(ref.path)}" title="在右侧打开 ${escapeHtml(ref.path)}">${dot}${escapeHtml(token.text)}</button>`
    },
  },
})

export function MarkdownRenderer({ content }: { content: string }) {
  const tree = useFilePreviewStore((s) => s.tree) // 树到位后重渲:单文件名 chip 要树背书才能判定
  const { html, wantTree } = useMemo(() => {
    sawTreePending = false
    const raw = marked.parse(content ?? '', { async: false }) as string
    return { html: DOMPurify.sanitize(raw), wantTree: sawTreePending }
  }, [content, tree])
  const ref = useRef<HTMLDivElement>(null)

  // 有单文件名候选但树还没加载:拉一次工作树(loadWorkspace 自带 loading 去重),到位后上面 useMemo 重算。
  useEffect(() => {
    if (wantTree && tree === null) useFilePreviewStore.getState().loadWorkspace()
  }, [wantTree, tree])

  // 文件 chip 点击 → 右面板打开(事件委托绑一次;chip 由 dangerouslySetInnerHTML 生成,React 合成事件挂不上)。
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const onClick = (e: MouseEvent) => {
      const chip = (e.target as HTMLElement | null)?.closest?.('.qf-file-chip') as HTMLElement | null
      if (!chip || !root.contains(chip)) return
      const path = chip.dataset.path
      if (!path) return
      e.preventDefault() // chip 被包进 <a> 时不触发链接跳转
      const store = useFilePreviewStore.getState()
      // 相对路径尽量在前端拼成绝对(和树/工具行打开的 tab 同 key,不开重复 tab);拼不了就原样给后端按 working_dir 解析。
      const base = store.root
      store.openFile(/^[/~]/.test(path) || !base ? path : `${base}/${path}`)
    }
    root.addEventListener('click', onClick)
    return () => root.removeEventListener('click', onClick)
  }, [])

  useEffect(() => {
    const root = ref.current
    if (!root) return
    root.querySelectorAll('img').forEach((image) => {
      const source = image.getAttribute('src') ?? ''
      if (source.startsWith('/')) image.src = authenticatedResourceUrl(`${getBaseUrl()}${source}`)
    })
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
    // 每个代码块包成代码卡(对齐 Codex 真图):块头 = 左「语言名」灰字 + 右常驻「复制」小钮。
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.parentElement?.classList.contains('qf-code-card')) return
      const code = pre.querySelector('code')
      const lang = [...(code?.classList ?? [])].find((c) => c.startsWith('language-'))?.slice('language-'.length) || 'text'
      const card = document.createElement('div')
      card.className = 'qf-code-card'
      const head = document.createElement('div')
      head.className = 'qf-code-head'
      const label = document.createElement('span')
      label.textContent = lang
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'qf-code-copy'
      btn.textContent = '复制'
      btn.addEventListener('click', () => {
        const codeText = code?.textContent ?? pre.textContent ?? ''
        void navigator.clipboard?.writeText(codeText)
        btn.textContent = '已复制'
        window.setTimeout(() => { btn.textContent = '复制' }, 1200)
      })
      head.append(label, btn)
      pre.replaceWith(card)
      card.append(head, pre)
    })
  }, [html])

  return <div ref={ref} className="qf-markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
