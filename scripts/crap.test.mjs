import { describe, expect, it } from 'vitest'

import { complexityOf, coverageOf, crap, functionsIn, judge } from './crap.mjs'

const complexities = (code) =>
  Object.fromEntries(functionsIn('x.ts', code).map((f) => [f.name, f.complexity]))

describe('crap', () => {
  it('is the complexity alone when everything is covered, and grows with what is not', () => {
    expect(crap(10, 1)).toBe(10)
    expect(crap(10, 0)).toBe(110)
    expect(crap(5, 0.5)).toBeCloseTo(25 * 0.125 + 5)
    expect(crap(1, 0)).toBe(2)
  })
})

describe('complexity', () => {
  it('is one for a function with no branch', () => {
    expect(complexities('function f() { return 1 }')).toEqual({ f: 1 })
  })

  it('adds a point for each way the flow can split', () => {
    const code = `function f(a, b) {
      if (a) {}
      for (const x of a) {}
      for (const k in a) {}
      for (let i = 0; i < 1; i++) {}
      while (a) {}
      do {} while (a)
      try {} catch {}
      const y = a ? 1 : 2
      switch (a) { case 1: break; case 2: break; default: break }
      return a && b || a ?? b
    }`
    // 1 + if + 3 loops + while + do + catch + ternary + 2 cases + (&&, ||, ??)
    expect(complexities(code)).toEqual({ f: 1 + 1 + 3 + 1 + 1 + 1 + 1 + 2 + 3 })
  })

  it('counts a nested function on its own, not in the one around it', () => {
    const found = complexities(`function outer(a) {
      if (a) {}
      const inner = (b) => { if (b) { if (a) {} } }
      return inner
    }`)
    expect(found.outer).toBe(2)
    expect(found['outer > inner']).toBe(3)
  })

  it('names methods, arrows and callbacks so a score has an address', () => {
    const found = complexities(`class C { run(a) { if (a) {} } }
    const arrow = (a) => a || 1
    export default function () {}
    [1].map((x) => x ? 1 : 2)`)
    expect(found['run']).toBe(2)
    expect(found.arrow).toBe(2)
    expect(Object.keys(found).some((k) => k.startsWith('(anonymous'))).toBe(true)
  })

  it('reads TSX', () => {
    const f = functionsIn('x.tsx', 'export function A({ a }) { return a ? <p>{a && 1}</p> : null }')
    expect(f[0].complexity).toBe(3)
  })
})

describe('coverageOf', () => {
  const entry = {
    statementMap: {
      0: { start: { line: 1 } },
      1: { start: { line: 2 } },
      2: { start: { line: 3 } },
      3: { start: { line: 10 } },
    },
    s: { 0: 1, 1: 0, 2: 2, 3: 0 },
  }

  it('is the share of the statements inside the function that ran', () => {
    expect(coverageOf(entry, 1, 3)).toBeCloseTo(2 / 3)
    expect(coverageOf(entry, 2, 2)).toBe(0)
    expect(coverageOf(entry, 1, 10)).toBe(0.5)
  })

  it('is zero for a file the tests never loaded, and full for a function with no statements', () => {
    expect(coverageOf(undefined, 1, 9)).toBe(0)
    expect(coverageOf(entry, 20, 30)).toBe(1)
  })
})

describe('judge', () => {
  const s = (crapScore) => ({ crap: crapScore, complexity: 9, coverage: 50 })

  it('lets code under the line through, and fails a new offender', () => {
    expect(judge({ a: s(30) }, {})).toEqual([])
    const failures = judge({ a: s(30.1) }, {})
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ key: 'a', why: 'new, over 30' })
  })

  it('lets a known offender stay as it is, or improve, and fails one that got worse', () => {
    const baseline = { a: 66 }
    expect(judge({ a: s(66) }, baseline)).toEqual([])
    expect(judge({ a: s(66.5) }, baseline)).toEqual([])
    expect(judge({ a: s(40) }, baseline)).toEqual([])
    expect(judge({ a: s(67) }, baseline)).toMatchObject([{ key: 'a', why: 'worse than 66' }])
  })

  it('does not care about a baseline function that is gone', () => {
    expect(judge({}, { gone: 99 })).toEqual([])
  })
})
