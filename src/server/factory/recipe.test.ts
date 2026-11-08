import { describe, expect, it } from 'vitest'

import { parseRecipe, pendingEgress, readRecipe, RecipeError, withRecipe } from './recipe'

const REPO = 'paulo/app'

describe('parseRecipe', () => {
  it('reads the install command, the checks and the domains, in lower case', () => {
    expect(
      parseRecipe(
        REPO,
        JSON.stringify({
          install: ' pnpm install ',
          checks: [{ name: 'test', command: 'pnpm test' }],
          egress: ['Files.Pythonhosted.org'],
        }),
      ),
    ).toEqual({
      install: 'pnpm install',
      checks: [{ name: 'test', command: 'pnpm test' }],
      egress: ['files.pythonhosted.org'],
    })
  })

  it('takes a recipe with only domains, and one that is empty', () => {
    expect(parseRecipe(REPO, '{"egress":["pypi.org"]}')).toEqual({ egress: ['pypi.org'] })
    expect(parseRecipe(REPO, '{}')).toEqual({ egress: [] })
  })

  it('refuses what is not JSON, and names the file and the repository', () => {
    expect(() => parseRecipe(REPO, '{ nope')).toThrow(RecipeError)
    expect(() => parseRecipe(REPO, '{ nope')).toThrow(
      /^paulo\/app: \.factory\/setup\.json on the default branch cannot be used: it is not JSON/,
    )
  })

  it('refuses a field it does not know, a domain that is not one, and too much of anything', () => {
    const refused = (value: object) => () => parseRecipe(REPO, JSON.stringify(value))
    expect(refused({ egress: ['*'] })).toThrow('egress.0 is not a hostname')
    expect(refused({ egress: ['https://x.org'] })).toThrow('is not a hostname')
    expect(refused({ network: 'all' })).toThrow(RecipeError)
    expect(refused({ checks: [] })).toThrow('checks')
    expect(refused({ checks: [{ name: ' ', command: 'x' }] })).toThrow('checks.0.name')
    expect(
      refused({ checks: Array.from({ length: 9 }, (_, i) => ({ name: `c${i}`, command: 'x' })) }),
    ).toThrow('checks')
    expect(refused({ egress: Array.from({ length: 21 }, (_, i) => `a${i}.org`) })).toThrow('egress')
    expect(refused({ install: '' })).toThrow('install')
    expect(refused([])).toThrow('the file')
  })
})

describe('readRecipe', () => {
  const answering = (status: number, body = '') => {
    const asked: { url: string; headers: Record<string, string> }[] = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      asked.push({ url, headers: init?.headers as Record<string, string> })
      return new Response(body, { status })
    }
    return { asked, fetchImpl }
  }

  it('reads the file of the default branch, raw, with the repository token', async () => {
    const { asked, fetchImpl } = answering(200, '{"egress":["pypi.org"]}')
    expect(await readRecipe(REPO, 'tok', fetchImpl)).toEqual({ egress: ['pypi.org'] })
    expect(asked[0].url).toBe('https://api.github.com/repos/paulo/app/contents/.factory/setup.json')
    expect(asked[0].url).not.toContain('ref=')
    expect(asked[0].headers.authorization).toBe('Bearer tok')
    expect(asked[0].headers.accept).toBe('application/vnd.github.raw+json')
  })

  it('is nothing when the project has no recipe', async () => {
    expect(await readRecipe(REPO, 'tok', answering(404).fetchImpl)).toBeUndefined()
  })

  it('stops the run when GitHub cannot say, instead of running without it', async () => {
    await expect(readRecipe(REPO, 'tok', answering(502).fetchImpl)).rejects.toThrow(
      'GitHub answered 502 reading it',
    )
  })
})

describe('withRecipe', () => {
  const recipe = {
    install: 'pnpm install',
    checks: [{ name: 'test', command: 'pnpm test' }],
    egress: ['pypi.org', 'files.pythonhosted.org'],
  }

  it('changes nothing without a recipe', () => {
    const config = { egress: ['a.org'] }
    expect(withRecipe(config, undefined)).toBe(config)
  })

  it('runs the install first, then the recipe checks, when the panel sets none', () => {
    expect(withRecipe({ egress: [] }, recipe).checks).toEqual([
      { name: 'install', command: 'pnpm install' },
      { name: 'test', command: 'pnpm test' },
    ])
    expect(withRecipe({ egress: [] }, { install: 'make', egress: [] }).checks).toEqual([
      { name: 'install', command: 'make' },
    ])
    expect(withRecipe({ egress: [] }, { egress: [] }).checks).toBeUndefined()
  })

  it('keeps the checks the owner set in the panel over the recipe', () => {
    const mine = [{ name: 'mine', command: 'make check' }]
    expect(withRecipe({ egress: [], checks: mine }, recipe).checks).toBe(mine)
  })

  it('opens only the domains the owner approved, each once', () => {
    expect(withRecipe({ egress: ['a.org'] }, recipe).egress).toEqual(['a.org'])
    expect(
      withRecipe(
        { egress: ['pypi.org'], approvedRecipeEgress: ['pypi.org', 'files.pythonhosted.org'] },
        recipe,
      ).egress,
    ).toEqual(['pypi.org', 'files.pythonhosted.org'])
  })
})

describe('pendingEgress', () => {
  it('lists the recipe domains the panel neither allows nor approved', () => {
    const recipe = { egress: ['pypi.org', 'a.org', 'b.org'] }
    expect(pendingEgress({ egress: ['a.org'], approvedRecipeEgress: ['b.org'] }, recipe)).toEqual([
      'pypi.org',
    ])
    expect(pendingEgress({ egress: [] }, undefined)).toEqual([])
  })
})

describe('the edges of a recipe', () => {
  it('runs only the recipe checks when it has no install command', () => {
    const checks = [{ name: 'test', command: 'make test' }]
    expect(withRecipe({ egress: [] }, { checks, egress: [] }).checks).toEqual(checks)
  })

  it('trims what a person typed around a command and a domain', () => {
    expect(
      parseRecipe(
        REPO,
        JSON.stringify({
          checks: [{ name: 'test', command: ' make test ' }],
          egress: [' pypi.org '],
        }),
      ),
    ).toEqual({ checks: [{ name: 'test', command: 'make test' }], egress: ['pypi.org'] })
  })
})
