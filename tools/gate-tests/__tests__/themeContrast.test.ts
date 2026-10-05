/**
 * The contrast promises in packages/theme/src/tokens.ts, checked for both
 * themes: a palette edit that breaks WCAG AA fails here, not in an audit.
 */
import { describe, it, expect } from 'vitest'
import { colors, charts } from '../../../packages/theme/src/tokens'

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

const SURFACES = ['bg-primary', 'bg-secondary', 'bg-tertiary', 'bg-elevated', 'bg-input', 'bg-hover', 'bg-active']
const TEXT = ['text-primary', 'text-secondary', 'text-tertiary', 'text-link', 'accent-text', 'success', 'warning', 'error', 'info']
const FILLS: [fill: string, text: string][] = [
  ['accent', 'text-on-accent'],
  ['accent-hover', 'text-on-accent'],
  ['error-fill', 'text-on-accent'],
  ['error-fill-hover', 'text-on-accent'],
  ['success-fill', 'text-on-accent'],
  ['success-fill-hover', 'text-on-accent'],
]

describe.each(['light', 'dark'] as const)('%s theme', (theme) => {
  const c = colors[theme]

  it('defines the same roles as the other theme', () => {
    const other = colors[theme === 'light' ? 'dark' : 'light']
    expect(Object.keys(c).sort()).toEqual(Object.keys(other).sort())
  })

  it.each(TEXT)('%s reads at 4.5:1 on every surface', (role) => {
    for (const surface of SURFACES) {
      expect(contrast(c[role]!, c[surface]!), `${role} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(['success', 'warning', 'error', 'info'])('%s text reads on its own background', (status) => {
    expect(contrast(c[`${status}-text`]!, c[`${status}-bg`]!)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(FILLS)('text on %s reads at 4.5:1', (fill, text) => {
    expect(contrast(c[text]!, c[fill]!)).toBeGreaterThanOrEqual(4.5)
  })

  it('form-control borders meet 3:1 on every surface (WCAG 1.4.11)', () => {
    for (const surface of SURFACES) {
      expect(contrast(c['border-control']!, c[surface]!), surface).toBeGreaterThanOrEqual(3)
    }
  })

  it('chart series meet 3:1 against the card', () => {
    for (const series of charts[theme]) {
      expect(contrast(series, c['bg-elevated']!), series).toBeGreaterThanOrEqual(3)
    }
  })
})
