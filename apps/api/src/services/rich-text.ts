import sanitizeHtml from 'sanitize-html'

/** Only images uploaded through the admin, named as the upload route names them. */
const UPLOAD = /^\/api\/uploads\/[\w-]+\.(jpg|png|webp)$/

/**
 * Cleans HTML from the admin's editor down to what the coach page renders: text formatting,
 * lists and uploaded images, with no attributes beyond an image's source. Empty documents
 * come back as ''.
 */
export function cleanRichText(html: string): string {
  const clean = sanitizeHtml(html, {
    allowedTags: [
      'p',
      'br',
      'strong',
      'em',
      'u',
      's',
      'h3',
      'ul',
      'ol',
      'li',
      'blockquote',
      'hr',
      'img',
    ],
    allowedAttributes: { img: ['src', 'alt'] },
    allowProtocolRelative: false,
    exclusiveFilter: (frame) => frame.tag === 'img' && !UPLOAD.test(frame.attribs.src ?? ''),
  })
    // The editor leaves empty paragraphs at the ends, which would show as blank space.
    .replace(/^(\s|<p>\s*(<br \/>)?\s*<\/p>)+|(\s|<p>\s*(<br \/>)?\s*<\/p>)+$/g, '')
  const text = sanitizeHtml(clean, { allowedTags: [], allowedAttributes: {} }).trim()
  return text || clean.includes('<img') ? clean : ''
}
