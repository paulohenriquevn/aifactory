import { describe, expect, it } from 'vitest'

import { MAX_ITEMS, parsePlan, planPrompt } from './plan'

const issue = (n: number) => ({ title: `Issue ${n}`, body: `Do ${n}` })
const ending = (plan: object) => `I read the repository.\n\n${JSON.stringify(plan)}`

describe('parsePlan', () => {
  it('reads the summary and the issues from the object the agent ended with', () => {
    const draft = parsePlan(ending({ summary: 'Two steps.', issues: [issue(1), issue(2)] }))
    expect(draft).toEqual({ summary: 'Two steps.', items: [issue(1), issue(2)] })
  })

  it('takes the last object when the agent wrote others before it', () => {
    const text = `${JSON.stringify({ issues: [issue(9)] })}\nOn second thought:\n${JSON.stringify({ summary: 's', issues: [issue(1)] })}`
    expect(parsePlan(text)?.items).toEqual([issue(1)])
  })

  it('drops an item with no title or no body, and trims what it keeps', () => {
    const draft = parsePlan(
      ending({
        issues: [
          { title: '  Padded  ', body: '  text  ' },
          { title: '', body: 'no title' },
          { title: 'no body', body: '   ' },
          { title: 5, body: 'bad type' },
          'not an object',
          null,
        ],
      }),
    )
    expect(draft?.items).toEqual([{ title: 'Padded', body: 'text' }])
  })

  it('keeps at most ten items, and cuts a title, a body and a summary to size', () => {
    const many = Array.from({ length: 14 }, (_, i) => issue(i))
    expect(parsePlan(ending({ issues: many }))?.items).toHaveLength(MAX_ITEMS)

    const long = parsePlan(
      ending({
        summary: 'S'.repeat(900),
        issues: [{ title: 'T'.repeat(300), body: 'B'.repeat(9_000) }],
      }),
    )!
    expect(long.summary).toHaveLength(600)
    expect(long.items[0].title).toHaveLength(120)
    expect(long.items[0].body).toHaveLength(6_000)
  })

  it('leaves the summary empty when there is none, instead of writing the word undefined', () => {
    expect(parsePlan(ending({ issues: [issue(1)] }))?.summary).toBe('')
  })

  it('is no plan when nothing usable came back', () => {
    expect(parsePlan('I could not decide.')).toBeUndefined()
    expect(parsePlan(ending({ issues: [] }))).toBeUndefined()
    expect(parsePlan(ending({ issues: 'one' }))).toBeUndefined()
    expect(parsePlan(ending({ summary: 'x' }))).toBeUndefined()
    expect(parsePlan('{ broken json')).toBeUndefined()
  })
})

describe('planPrompt', () => {
  it('names the repository and the goal, forbids changes, and asks for independent issues', () => {
    const prompt = planPrompt({ repo: 'o/app', goal: 'Add a CLI' })
    expect(prompt).toContain('o/app')
    expect(prompt).toContain('Add a CLI')
    expect(prompt).toContain('Do not change anything')
    expect(prompt).toContain('must not depend on another issue')
    expect(prompt).toContain(`at most ${MAX_ITEMS} GitHub issues`)
  })
})
