import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inlineImports, miniprogramDir, wxssToCss } from './mp-styles.ts'

describe('wxssToCss', () => {
  it('scopes rules to the preview page', () => {
    expect(wxssToCss('.card, .price:not(.a, .b) { margin: 0 }')).toBe(
      '.mp-page .card,.mp-page .price:not(.a, .b){ margin: 0 }',
    )
  })

  it('maps page selectors to the preview root', () => {
    expect(wxssToCss('page, .page { --x: 1 } page .a { color: red }')).toBe(
      '.mp-page,.mp-page{ --x: 1 }\n.mp-page .a{ color: red }',
    )
  })

  it('applies color scheme blocks under the preview theme class', () => {
    expect(
      wxssToCss('@media (prefers-color-scheme: dark) { page { --x: 2 } .a { color: red } }'),
    ).toBe('.mp-dark{ --x: 2 }\n.mp-dark .a{ color: red }')
  })

  it('converts mini program units for a 375px screen', () => {
    expect(
      wxssToCss(
        '.a { padding: 16rpx 1rpx calc(16rpx + env(safe-area-inset-bottom)); min-height: 70vh }',
      ),
    ).toBe(
      '.mp-page .a{ padding: 8px 0.5px calc(8px + var(--mp-safe-bottom)); min-height: calc(70 * var(--mp-vh)) }',
    )
  })

  it('keeps keyframes and drops font faces', () => {
    expect(wxssToCss('@font-face { font-family: t } @keyframes spin { to { opacity: 0 } }')).toBe(
      '\n@keyframes spin{ to { opacity: 0 } }',
    )
  })
})

describe('inlineImports', () => {
  it('reads the theme from its sources in place of the generated lib/theme.wxss', () => {
    const css = inlineImports(join(miniprogramDir, 'app.wxss'))
    expect(css).not.toContain('@import')
    // TDesign's tokens, the brand and the app's own tokens, in the build's order.
    const tdesign = css.indexOf('--td-bg-color-container')
    const brand = css.indexOf('--rs-hint-color:')
    const app = css.indexOf('--rs-success-text-color')
    expect(tdesign).toBeGreaterThan(-1)
    expect(brand).toBeGreaterThan(tdesign)
    expect(app).toBeGreaterThan(brand)
  })

  it('inlines each file once', () => {
    const css = inlineImports(join(miniprogramDir, 'pages/book/index.wxss'))
    expect(css.split('.section-title {').length).toBe(2)
  })
})

it('uses the same TDesign as the mini program', () => {
  const version = (path: string) =>
    JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')).devDependencies?.[
      'tdesign-miniprogram'
    ] ??
    JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')).dependencies?.[
      'tdesign-miniprogram'
    ]
  expect(version('./package.json')).toBe(version('../miniprogram/package.json'))
})
