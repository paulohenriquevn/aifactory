import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : []
  })

describe('the assistant is under every text box', () => {
  it('has an Assist in each file of the panel that has a text area, so no one is left to write alone', () => {
    const alone = files('src/app')
      // The chat composer is the assistant itself: a box to talk to it needs no other one under it.
      .filter((f) => !f.endsWith('Assist.tsx') && !f.endsWith('PillComposer.tsx'))
      .filter((f) => /<Textarea|<textarea/.test(readFileSync(f, 'utf8')))
      .filter((f) => !readFileSync(f, 'utf8').includes('<Assist'))
    expect(alone).toEqual([])
  })

  it('finds the text areas it is guarding, so the check cannot pass by finding none', () => {
    const boxes = files('src/app').filter((f) =>
      /<Textarea|<textarea/.test(readFileSync(f, 'utf8')),
    )
    expect(boxes.length).toBeGreaterThanOrEqual(5)
  })
})
