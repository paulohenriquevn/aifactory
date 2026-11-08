import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { contrastRatio, violetForge } from '@theokit/ui'
import { describe, expect, it } from 'vitest'

type Scale = Record<string, string>
const scales: Record<'light' | 'dark', Scale> = {
  light: violetForge.light as unknown as Scale,
  dark: violetForge.dark as unknown as Scale,
}

// The text the panel writes by hand, on the surfaces it writes it on. Body text needs 4.5.
const TEXT: [string, string][] = [
  ['foreground', 'background'],
  ['foreground', 'card'],
  ['foreground', 'muted'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['destructive', 'background'],
  ['destructive', 'card'],
]
// Text on a filled control (a primary button, a nav tab) needs 3, as the library's own audit says.
const FILLED: [string, string][] = [['primary-foreground', 'primary']]

describe.each(['light', 'dark'] as const)('the panel palette in %s mode', (mode) => {
  const ratio = (a: string, b: string) => contrastRatio(scales[mode][a], scales[mode][b])!

  it.each(TEXT)('reads %s on %s at 4.5 or better', (foreground, background) => {
    expect(ratio(foreground, background)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(FILLED)('reads %s on %s at 3 or better', (foreground, background) => {
    expect(ratio(foreground, background)).toBeGreaterThanOrEqual(3)
  })
})

describe('what the panel writes in colour', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return files(path)
      return /\.tsx$/.test(name) && !name.endsWith('.test.tsx') ? [path] : []
    })

  it('does not use as text a colour that is under 4.5 in one of the modes', () => {
    // primary is 2.9 on a card in dark mode, and success and warning are 3.5 and 3.1 in light mode.
    const offenders = files('src/app').filter((f) =>
      /\btext-(primary|success|warning|info|accent)\b(?!-)/.test(readFileSync(f, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
