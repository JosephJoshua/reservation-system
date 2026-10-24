// The coach profile as the coach page renders it: the API's allowed tags only (see
// apps/api/src/services/rich-text.ts), with the page classes the mini program adds (see
// apps/miniprogram/miniprogram/utils/rich-text.ts). The draft has not been through the API yet,
// so it is cleaned here, building new elements rather than trusting the editor's.
const CLASSES: Record<string, string> = {
  p: 'rt-p',
  h3: 'rt-h3',
  ul: 'rt-ul',
  ol: 'rt-ol',
  li: 'rt-li',
  blockquote: 'rt-quote',
  hr: 'rt-hr',
  img: 'rt-img',
}
const ALLOWED = new Set([...Object.keys(CLASSES), 'br', 'strong', 'em', 'u', 's'])
const UPLOAD = /^\/api\/uploads\/[\w-]+\.(jpg|png|webp)$/

function copy(from: Node, to: Node, doc: Document) {
  for (const node of from.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      to.appendChild(doc.createTextNode(node.textContent ?? ''))
      continue
    }
    if (!(node instanceof Element)) continue
    const tag = node.tagName.toLowerCase()
    if (!ALLOWED.has(tag)) {
      // Unknown wrappers keep their text, as the API's sanitizer does.
      copy(node, to, doc)
      continue
    }
    if (tag === 'img' && !UPLOAD.test(node.getAttribute('src') ?? '')) continue
    const el = doc.createElement(tag)
    const cls = CLASSES[tag]
    if (cls) el.className = cls
    if (tag === 'img') el.setAttribute('src', node.getAttribute('src') ?? '')
    copy(node, el, doc)
    to.appendChild(el)
  }
}

export function profileHtml(html: string): string {
  const source = new DOMParser().parseFromString(html, 'text/html')
  const doc = document.implementation.createHTMLDocument('')
  const root = doc.createElement('div')
  copy(source.body, root, doc)
  // The editor leaves empty paragraphs at the ends, which the API drops.
  const blank = (n: ChildNode | null) =>
    n instanceof HTMLParagraphElement && !n.textContent?.trim() && !n.querySelector('img')
  while (blank(root.firstChild)) root.firstChild?.remove()
  while (blank(root.lastChild)) root.lastChild?.remove()
  const text = root.textContent?.trim()
  return text || root.querySelector('img') ? root.innerHTML : ''
}
