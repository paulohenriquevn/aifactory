import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// `theokit build` treats every file in this directory as a job and fails the build on one that is
// not (a helper once broke it, and no test ran the build). Helpers live in `factory/`.
describe('src/server/jobs', () => {
  const dir = join(__dirname, '..', 'jobs')
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))

  it('holds only jobs', () => {
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      expect(readFileSync(join(dir, file), 'utf8'), file).toMatch(/export default defineJob\(/)
    }
  })

  it('names each job after its file', () => {
    for (const file of files) {
      const name = file.replace(/\.ts$/, '')
      expect(readFileSync(join(dir, file), 'utf8'), file).toContain(`defineJob('${name}'`)
    }
  })
})
