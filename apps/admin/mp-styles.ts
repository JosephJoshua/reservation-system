// Turns mini program wxss into CSS the admin can use for its previews (src/preview). Importing a
// .wxss file gives its CSS as a string: @imports inlined, rpx in px for a 375px-wide screen, and
// every rule scoped to the preview's `.mp-page` element, so the real page styles render the
// preview without touching the admin. Color scheme blocks apply under `.mp-light` / `.mp-dark`,
// classes the preview sets beside `.mp-page`, at the same specificity so source order still wins.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const require = createRequire(import.meta.url)

export const miniprogramDir = fileURLToPath(new URL('../miniprogram/miniprogram/', import.meta.url))

/**
 * The files the mini program build puts in lib/theme.wxss (see apps/miniprogram/scripts/
 * prepare.mjs), read from their sources since lib/ is generated.
 */
function themeSources(): string[] {
  const tdesign = dirname(require.resolve('tdesign-miniprogram/package.json'))
  return [
    join(tdesign, 'miniprogram_dist/common/style/theme/_index.wxss'),
    require.resolve('@rs/theme/brand.wxss'),
    join(miniprogramDir, 'styles/tokens.wxss'),
  ]
}

/** The file with its @imports inlined, each file once, as the mini program would apply them. */
export function inlineImports(
  file: string,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
  seen = new Set<string>(),
): string {
  if (seen.has(file)) return ''
  seen.add(file)
  const css = stripComments(read(file))
  return css.replace(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/g, (_, spec: string) => {
    const target = resolve(dirname(file), spec)
    if (target === join(miniprogramDir, 'lib/theme.wxss')) {
      return themeSources()
        .map((source) => inlineImports(source, read, seen))
        .join('\n')
    }
    return inlineImports(target, read, seen)
  })
}

function stripComments(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Splits CSS into [prelude, body] pairs, matching braces one level deep. */
function blocks(css: string): [string, string][] {
  const list: [string, string][] = []
  let at = 0
  while (at < css.length) {
    const open = css.indexOf('{', at)
    if (open === -1) break
    let depth = 1
    let close = open + 1
    for (; close < css.length && depth > 0; close++) {
      if (css[close] === '{') depth++
      else if (css[close] === '}') depth--
    }
    list.push([css.slice(at, open).trim(), css.slice(open + 1, close - 1)])
    at = close
  }
  return list
}

/** Splits a selector list on its top-level commas, leaving those inside :not() and such. */
function selectorParts(selector: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(selector.slice(start, i))
      start = i + 1
    }
  }
  parts.push(selector.slice(start))
  return parts.map((p) => p.trim()).filter(Boolean)
}

function scopeSelector(selector: string, root: string): string {
  return selectorParts(selector)
    .map((part) => {
      const page = part.match(/^\.?page(?=$|[\s:.[>+~])/)
      return page ? `${root}${part.slice(page[0].length)}` : `${root} ${part}`
    })
    .join(',')
}

function scopeRules(css: string, root: string): string {
  return blocks(css)
    .map(([prelude, body]) => {
      if (prelude.startsWith('@font-face')) return ''
      if (prelude.startsWith('@keyframes') || prelude.startsWith('@-webkit-keyframes')) {
        return `${prelude}{${body}}`
      }
      if (prelude.startsWith('@media')) {
        const scheme = prelude.match(/prefers-color-scheme\s*:\s*(light|dark)/)?.[1]
        if (scheme) return scopeRules(body, `.mp-${scheme}`)
        return `${prelude}{${scopeRules(body, root)}}`
      }
      if (prelude.startsWith('@')) return `${prelude}{${scopeRules(body, root)}}`
      return `${scopeSelector(prelude, root)}{${body}}`
    })
    .join('\n')
}

const number = (n: number) => String(Math.round(n * 1000) / 1000)

/** Mini program units in terms of the preview screen: 750rpx is its 375px width. */
export function convertUnits(css: string): string {
  return css
    .replace(/(-?\d*\.?\d+)rpx\b/g, (_, n: string) => `${number(Number(n) / 2)}px`)
    .replace(/(\d*\.?\d+)vh\b/g, (_, n: string) => `calc(${n} * var(--mp-vh))`)
    .replace(/env\(\s*safe-area-inset-bottom\s*\)/g, 'var(--mp-safe-bottom)')
}

export function wxssToCss(css: string): string {
  return scopeRules(convertUnits(stripComments(css)), '.mp-page')
}

/** Lets admin code import a .wxss file as a string of scoped CSS. */
export function miniprogramStyles(): Plugin {
  return {
    name: 'rs-miniprogram-styles',
    load(id) {
      const [file] = id.split('?')
      if (!file?.endsWith('.wxss')) return null
      const seen = new Set<string>()
      const css = wxssToCss(
        inlineImports(
          file,
          (p) => {
            this.addWatchFile(p)
            return readFileSync(p, 'utf8')
          },
          seen,
        ),
      )
      return `export default ${JSON.stringify(css)}`
    },
  }
}
