import { describe, expect, it } from 'vitest'

import {
  changePlanPrompt,
  implementPlanPrompt,
  parseChangePlan,
  planAgainPrompt,
  renderChangePlan,
  unplannedFiles,
  type ChangePlan,
} from './change-plan'

const plan: ChangePlan = {
  files: [
    { path: 'src/truncate.ts', why: 'the function' },
    { path: 'src/truncate.test.ts', why: 'the tests' },
  ],
  order: ['write the failing test', 'make it pass'],
  risks: ['callers that pass a negative max'],
  proof: ['src/truncate.test.ts covers max=0 and a negative max'],
  outOfScope: ['the CLI flag'],
}

describe('parseChangePlan', () => {
  it('reads the plan the agent ended with', () => {
    expect(parseChangePlan(`I read the code.\n${JSON.stringify(plan)}`)).toEqual(plan)
  })

  it('takes the last plan when the answer holds more than one JSON object', () => {
    const early = { ...plan, files: [{ path: 'old.ts', why: 'x' }] }
    expect(parseChangePlan(`${JSON.stringify(early)}\nthen\n${JSON.stringify(plan)}`)).toEqual(plan)
  })

  it('accepts a plan that changes no file, since the code may already do it', () => {
    const empty = { ...plan, files: [] }
    expect(parseChangePlan(JSON.stringify(empty))?.files).toEqual([])
  })

  it('reads plain strings as files and fills the lists the agent left out', () => {
    expect(parseChangePlan('{"files":["src/a.ts"]}')).toEqual({
      files: [{ path: 'src/a.ts', why: '' }],
      order: [],
      risks: [],
      proof: [],
      outOfScope: [],
    })
  })

  it('drops entries that are not text, and paths that try to leave the repository', () => {
    const read = parseChangePlan(
      JSON.stringify({
        files: [{ path: '../etc/passwd' }, { path: '/abs' }, { path: 3 }, { path: 'ok.ts' }],
        order: [1, 'a'],
      }),
    )
    expect(read?.files).toEqual([{ path: 'ok.ts', why: '' }])
    expect(read?.order).toEqual(['a'])
  })

  it('drops a file that is null or has an empty path, and blank items', () => {
    const read = parseChangePlan(
      JSON.stringify({ files: [null, { path: '' }, { path: 'a.ts' }], risks: ['  ', 'r'] }),
    )
    expect(read?.files).toEqual([{ path: 'a.ts', why: '' }])
    expect(read?.risks).toEqual(['r'])
  })

  it('keeps thirty items of a list and cuts a long reason', () => {
    const read = parseChangePlan(
      JSON.stringify({
        files: [{ path: 'a.ts', why: 'w'.repeat(900) }],
        order: Array.from({ length: 40 }, (_, i) => `step ${i}`),
      }),
    )
    expect(read?.order).toHaveLength(30)
    expect(read?.files[0].why).toHaveLength(500)
  })

  it('cuts what is too long to read', () => {
    const many = {
      files: Array.from({ length: 300 }, (_, i) => `f${i}.ts`),
      risks: ['r'.repeat(2_000)],
    }
    const read = parseChangePlan(JSON.stringify(many))
    expect(read?.files).toHaveLength(200)
    expect(read?.risks[0]).toHaveLength(500)
  })

  it('says there is no plan when the answer has none', () => {
    expect(parseChangePlan('I could not decide.')).toBeUndefined()
    expect(parseChangePlan('{"verdict":"approve"}')).toBeUndefined()
    expect(parseChangePlan('{"files":"src/a.ts"}')).toBeUndefined()
  })
})

describe('unplannedFiles', () => {
  it('lists the changed files the plan does not name', () => {
    expect(unplannedFiles(['src/truncate.ts', 'src/other.ts'], plan)).toEqual(['src/other.ts'])
  })

  it('takes a path that ends in a slash as a directory', () => {
    const dir = { ...plan, files: [{ path: 'src/cli/', why: '' }] }
    expect(unplannedFiles(['src/cli/a.ts', 'src/cli/deep/b.ts', 'src/clix.ts'], dir)).toEqual([
      'src/clix.ts',
    ])
  })

  it('reads * as any name within a folder and ** as any depth', () => {
    const globs = {
      ...plan,
      files: [
        { path: 'tests/*.test.ts', why: '' },
        { path: 'docs/**', why: '' },
      ],
    }
    expect(
      unplannedFiles(
        ['tests/a.test.ts', 'tests/deep/b.test.ts', 'docs/x/y.md', 'docsx/z.md'],
        globs,
      ),
    ).toEqual(['tests/deep/b.test.ts', 'docsx/z.md'])
  })

  it('takes a dot in a path as a dot', () => {
    const dotted = { ...plan, files: [{ path: 'a.ts', why: '' }] }
    expect(unplannedFiles(['abts'], dotted)).toEqual(['abts'])
  })

  it('does not take a file that only starts like a lockfile for one', () => {
    expect(unplannedFiles(['pnpm-lock.yaml.orig'], plan)).toEqual(['pnpm-lock.yaml.orig'])
  })

  it('leaves out lockfiles, which follow from the manifest', () => {
    expect(
      unplannedFiles(
        [
          'pnpm-lock.yaml',
          'pkg/package-lock.json',
          'yarn.lock',
          'go.sum',
          'Cargo.lock',
          'uv.lock',
          'poetry.lock',
        ],
        plan,
      ),
    ).toEqual([])
  })

  it('is empty when every change is planned', () => {
    expect(unplannedFiles(['src/truncate.test.ts'], plan)).toEqual([])
  })
})

describe('the prompts', () => {
  const input = {
    repo: 'paulo/app',
    issueNumber: 7,
    title: 'Add truncate',
    body: 'Write truncate(text, max).',
    branch: 'factory/7',
  }

  it('asks for a plan before any change, with the issue and the shape of the answer', () => {
    const prompt = changePlanPrompt(input)
    expect(prompt).toContain('# Add truncate (#7)')
    expect(prompt).toContain('Do not create, edit or delete any file')
    expect(prompt).toContain('"outOfScope"')
  })

  it('keeps the questions for the implementation turn', () => {
    expect(changePlanPrompt(input)).toContain('Do not ask a question in this turn')
  })

  it('says, when it asks again, that no plan was read', () => {
    expect(planAgainPrompt()).toContain('one JSON object')
  })

  it('tells the builder to hold to the plan and to say why it left it', () => {
    const prompt = implementPlanPrompt({ discarded: false })
    expect(prompt).toContain('Implement the plan')
    expect(prompt).toContain('say why')
    expect(prompt.split('\n\n')).toHaveLength(3)
  })

  it('says so when the edits made while planning were thrown away', () => {
    expect(implementPlanPrompt({ discarded: true })).toContain('discarded')
  })
})

describe('renderChangePlan', () => {
  it('shows each part of the plan', () => {
    expect(renderChangePlan(plan)).toBe(
      [
        '**Files**',
        '',
        '- `src/truncate.ts`: the function',
        '- `src/truncate.test.ts`: the tests',
        '',
        '**Order**',
        '',
        '1. write the failing test',
        '2. make it pass',
        '',
        '**Risks**',
        '',
        '- callers that pass a negative max',
        '',
        '**Proof**',
        '',
        '- src/truncate.test.ts covers max=0 and a negative max',
        '',
        '**Out of scope**',
        '',
        '- the CLI flag',
      ].join('\n'),
    )
  })

  it('says when the plan changes no file, and leaves out the empty parts', () => {
    expect(
      renderChangePlan({
        files: [{ path: 'a.ts', why: '' }],
        order: [],
        risks: [],
        proof: [],
        outOfScope: [],
      }),
    ).toBe('**Files**\n\n- `a.ts`')
    expect(
      renderChangePlan({ files: [], order: [], risks: [], proof: [], outOfScope: [] }),
    ).toContain('No file')
  })
})
