import { assetUrl } from './api'

const CLASSES: Record<string, string> = {
  p: 'rt-p',
  h3: 'rt-h3',
  ul: 'rt-ul',
  ol: 'rt-ol',
  li: 'rt-li',
  blockquote: 'rt-quote',
  hr: 'rt-hr',
}

/**
 * Prepares a coach profile for `rich-text`: page classes on each tag and absolute image URLs.
 * The API has already cleaned the HTML, so tags carry no attributes except an image's source.
 */
export function richTextNodes(html: string): string {
  return html
    .replace(
      /<(p|h3|ul|ol|li|blockquote)>/g,
      (_, tag: string) => `<${tag} class="${CLASSES[tag]}">`,
    )
    .replace(/<hr \/>/g, `<hr class="${CLASSES.hr}" />`)
    .replace(/<img ([^>]*)src="([^"]+)"/g, (_, before: string, src: string) => {
      return `<img class="rt-img" ${before}src="${assetUrl(src)}"`
    })
}
