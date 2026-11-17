import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const FILES = [
  'src/app/work/page.tsx',
  'src/app/components/Board.tsx',
  'src/app/components/Badges.tsx',
  'src/app/components/NewJob.tsx',
  'src/app/lib/format.ts',
]

// The name of the GitHub label, not a word of either language.
const NAMES = new Set(['factory'])

const WORDS = /[A-Za-zÀ-ÿ]{2,}/

/** Visible literals: JSX text, and string values of the attributes a person reads. */
export function literals(source: string): string[] {
  const found: string[] = []
  for (const m of source.matchAll(/(?<![=-])>([^<>{}]+)</g)) {
    // Code between two generics or comparisons has these; visible text does not.
    if (WORDS.test(m[1]) && !/[();=]/.test(m[1]) && !NAMES.has(m[1].trim())) found.push(m[1].trim())
  }
  for (const m of source.matchAll(/\b(?:aria-label|title|placeholder|alt|label)="([^"]+)"/g)) {
    found.push(m[1])
  }
  return found
}

describe('the work page has no visible string of its own', () => {
  it('finds a literal when there is one, so the check cannot pass by finding none', () => {
    expect(literals('<p>Nothing here.</p>')).toEqual(['Nothing here.'])
    expect(literals('<div aria-label="Tasks" />')).toEqual(['Tasks'])
    expect(literals('<p>{t.board.nothingHere}</p>')).toEqual([])
  })

  for (const file of FILES) {
    it(`${file} takes its text from the dictionary`, () => {
      const source = readFileSync(file, 'utf8')
      // format.ts also holds `describeEvent`, which belongs to the task page and moves with it.
      expect(literals(source.split('const text =')[0])).toEqual([])
    })
  }
})
