import { join } from 'node:path'
import { homedir } from 'node:os'

import { describe, expect, it } from 'vitest'

import {
  assertSafeName,
  byEffort,
  codexModels,
  engineModels,
  highestEffort,
  isSafeName,
  NoPinnedEffort,
  optionsFor,
  pinnedEffort,
  tagged,
  untag,
} from './engine-models'

const cache = (models: object[]) => JSON.stringify({ models })
const entry = (slug: string, over: object = {}) => ({
  slug,
  display_name: slug.toUpperCase(),
  description: `about ${slug}`,
  visibility: 'list',
  supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
  ...over,
})

describe('a plain name', () => {
  it('lets through letters, digits, dots, dashes and underscores, and nothing a shell reads', () => {
    for (const ok of ['opus', 'gpt-6.1-sol', 'a_b', 'X1']) expect(isSafeName(ok), ok).toBe(true)
    for (const bad of [
      '',
      ' ',
      '-x',
      'a b',
      'a;b',
      'a$(b)',
      'a`b`',
      'a&b',
      'a|b',
      "a'b",
      'a"b',
      'a\nb',
      'x'.repeat(70),
    ]) {
      expect(isSafeName(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('throws, naming what it was, for one it does not let through', () => {
    expect(assertSafeName('opus', 'model')).toBe('opus')
    expect(() => assertSafeName('a;rm -rf /', 'model')).toThrow(
      'model "a;rm -rf /" is not a plain name',
    )
  })
})

describe('the models Codex lists', () => {
  const homeOf = (env: NodeJS.ProcessEnv) => join(env.FACTORY_CODEX_HOME ?? '', 'models_cache.json')

  it('reads the ones it shows, with their name, what they are for and the effort they take', () => {
    const models = codexModels({ FACTORY_CODEX_HOME: '/h' }, (path) =>
      path === join('/h', 'models_cache.json')
        ? cache([entry('gpt-6.1-sol'), entry('gpt-6-luna')])
        : '',
    )
    expect(models).toEqual([
      {
        id: 'gpt-6.1-sol',
        label: 'GPT-6.1-SOL',
        note: 'about gpt-6.1-sol',
        efforts: ['low', 'high'],
      },
      { id: 'gpt-6-luna', label: 'GPT-6-LUNA', note: 'about gpt-6-luna', efforts: ['low', 'high'] },
    ])
    expect(homeOf({ FACTORY_CODEX_HOME: '/h' })).toContain('models_cache.json')
  })

  it('leaves out one it hides, and one whose name is not a plain name', () => {
    const models = codexModels({ FACTORY_CODEX_HOME: '/h' }, () =>
      cache([
        entry('shown'),
        entry('secret', { visibility: 'hide' }),
        entry('bad name;'),
        { visibility: 'list' },
      ]),
    )
    expect(models.map((m) => m.id)).toEqual(['shown'])
  })

  it('keeps only effort levels that are plain names, and copes with a model that lists none', () => {
    const [model] = codexModels({ FACTORY_CODEX_HOME: '/h' }, () =>
      cache([
        entry('m', { supported_reasoning_levels: [{ effort: 'ok' }, { effort: 'no way' }, {}] }),
      ]),
    )
    expect(model.efforts).toEqual(['ok'])
    const [bare] = codexModels({ FACTORY_CODEX_HOME: '/h' }, () =>
      cache([{ slug: 'x', visibility: 'list' }]),
    )
    expect(bare).toMatchObject({ id: 'x', label: 'x', note: '', efforts: [] })
  })

  it('looks in the everyday login when the factory one has no list, and gives none when neither does', () => {
    const everyday = join(homedir(), '.codex', 'models_cache.json')
    const fromEveryday = codexModels({ FACTORY_CODEX_HOME: '/h' }, (path) => {
      if (path === everyday) return cache([entry('from-everyday')])
      throw new Error('ENOENT')
    })
    expect(fromEveryday.map((m) => m.id)).toEqual(['from-everyday'])
    expect(
      codexModels({ FACTORY_CODEX_HOME: '/h' }, () => {
        throw new Error('ENOENT')
      }),
    ).toEqual([])
    expect(codexModels({ FACTORY_CODEX_HOME: '/h' }, () => 'not json')).toEqual([])
    expect(
      codexModels({ FACTORY_CODEX_HOME: '/h' }, () =>
        cache([entry('only', { visibility: 'hide' })]),
      ),
    ).toEqual([])
  })
})

describe('the models of each agent', () => {
  it('offers the aliases Claude Code documents, each with the effort levels it takes', () => {
    const { 'claude-code': claude } = engineModels({ FACTORY_CODEX_HOME: '/h' }, () => '')
    expect(claude.models.map((m) => m.id)).toEqual(['sonnet', 'opus', 'fable'])
    expect(claude.models[0]).toMatchObject({ label: 'Sonnet' })
    expect(claude.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(claude.models.every((m) => m.efforts.length === 5)).toBe(true)
  })

  it('offers what Codex lists, with the levels any of them takes, once each', () => {
    const { codex } = engineModels({ FACTORY_CODEX_HOME: '/h' }, () =>
      cache([
        entry('a', { supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }),
        entry('b', { supported_reasoning_levels: [{ effort: 'high' }, { effort: 'max' }] }),
      ]),
    )
    expect(codex.models.map((m) => m.id)).toEqual(['a', 'b'])
    expect(codex.efforts).toEqual(['low', 'high', 'max'])
  })
})

describe('what a choice is kept with', () => {
  it('tags a value with the agent it was chosen for, and reads it back only for that agent', () => {
    expect(tagged('codex', 'gpt-6.1-sol')).toBe('codex:gpt-6.1-sol')
    expect(untag('codex:gpt-6.1-sol', 'codex')).toBe('gpt-6.1-sol')
    expect(untag('codex:gpt-6.1-sol', 'claude-code')).toBeUndefined()
    expect(untag('codex:', 'codex')).toBeUndefined()
    expect(untag(':x', 'codex')).toBeUndefined()
    expect(untag('plain', 'codex')).toBeUndefined()
    expect(untag(undefined, 'codex')).toBeUndefined()
    expect(untag('', 'codex')).toBeUndefined()
  })
})

describe('what a role tells the agent it ends up running', () => {
  it('is what was chosen for that role, for the agent it was chosen for', () => {
    const env = { FACTORY_MODEL_BUILDER: 'codex:gpt-6.1-sol', FACTORY_EFFORT_BUILDER: 'codex:high' }
    expect(optionsFor(env, 'builder', 'codex')).toEqual({ model: 'gpt-6.1-sol', effort: 'high' })
    expect(optionsFor(env, 'builder', 'claude-code')).toEqual({})
    expect(optionsFor({}, 'builder', 'codex')).toEqual({})
  })

  it("makes the planner and the reviewer use the builder's model and effort until given their own", () => {
    const env = { FACTORY_MODEL_BUILDER: 'codex:gpt-6.1-sol', FACTORY_EFFORT_BUILDER: 'codex:high' }
    expect(optionsFor(env, 'planner', 'codex')).toEqual({ model: 'gpt-6.1-sol', effort: 'high' })
    expect(optionsFor(env, 'reviewer', 'codex')).toEqual({ model: 'gpt-6.1-sol', effort: 'high' })
    expect(optionsFor(env, 'reviewer', 'claude-code')).toEqual({})
    const own = { ...env, FACTORY_MODEL_REVIEWER: 'codex:gpt-6-luna' }
    expect(optionsFor(own, 'reviewer', 'codex')).toEqual({ model: 'gpt-6-luna', effort: 'high' })
    expect(
      optionsFor({ ...own, FACTORY_MODEL_PLANNER: 'claude-code:opus' }, 'planner', 'claude-code'),
    ).toEqual({ model: 'opus' })
  })

  it('never hands on a name that is not a plain one', () => {
    expect(
      optionsFor(
        { FACTORY_MODEL_BUILDER: 'codex:a;b', FACTORY_EFFORT_BUILDER: 'codex:x y' },
        'builder',
        'codex',
      ),
    ).toEqual({})
  })
})

describe('the effort of the security agent', () => {
  const codexCache = () =>
    cache([
      entry('gpt-6.1-sol', {
        supported_reasoning_levels: ['low', 'high', 'max', 'ultra'].map((effort) => ({ effort })),
      }),
      entry('gpt-6-luna', {
        supported_reasoning_levels: ['low', 'medium', 'max'].map((effort) => ({ effort })),
      }),
    ])
  const home = { FACTORY_CODEX_HOME: '/h' }

  it("is each agent's highest level, for the model in use when it lists its own", () => {
    const catalog = engineModels(home, codexCache)
    expect(highestEffort(catalog['claude-code'])).toBe('max')
    expect(highestEffort(catalog['claude-code'], 'opus')).toBe('max')
    expect(highestEffort(catalog.codex, 'gpt-6-luna')).toBe('max')
    expect(highestEffort(catalog.codex, 'gpt-6.1-sol')).toBe('ultra')
    expect(highestEffort(catalog.codex)).toBe('ultra')
    expect(highestEffort(undefined)).toBeUndefined()
    expect(highestEffort({ models: [], efforts: [] })).toBeUndefined()
  })

  it('resolves to the maximum of its agent, whatever effort is stored or set for it or the builder', () => {
    const catalog = engineModels(home, codexCache)
    const low = {
      ...home,
      FACTORY_EFFORT_SECURITY: 'claude-code:low',
      FACTORY_EFFORT_BUILDER: 'claude-code:low',
    }
    for (const [engine, model] of [
      ['claude-code', undefined],
      ['claude-code', 'sonnet'],
      ['codex', 'gpt-6.1-sol'],
      ['codex', 'gpt-6-luna'],
    ] as const) {
      const env = model ? { ...low, FACTORY_MODEL_SECURITY: `${engine}:${model}` } : low
      expect(optionsFor(env, 'security', engine, codexCache).effort, `${engine} ${model}`).toBe(
        highestEffort(catalog[engine], model),
      )
    }
  })

  it("uses the builder's model when it has none of its own, and the maximum for that model", () => {
    const env = { ...home, FACTORY_MODEL_BUILDER: 'codex:gpt-6-luna' }
    expect(optionsFor(env, 'security', 'codex', codexCache)).toEqual({
      model: 'gpt-6-luna',
      effort: 'max',
    })
  })

  it('refuses to resolve when its agent lists no effort level, so it never runs at a lower default', () => {
    expect(() => optionsFor(home, 'security', 'codex', () => '')).toThrow(NoPinnedEffort)
    expect(() => pinnedEffort({}, 'unknown')).toThrow(/lists no effort level/)
  })
})

describe('the order of effort levels', () => {
  it('goes from the lowest to the highest, with a level nobody knows below all of them', () => {
    expect(byEffort(['ultra', 'low', 'max', 'odd', 'medium', 'minimal', 'xhigh', 'high'])).toEqual([
      'odd',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ])
  })

  it("puts Codex's levels in that order when they are gathered from models that list different ones", () => {
    const { codex } = engineModels({ FACTORY_CODEX_HOME: '/h' }, () =>
      cache([
        entry('a', { supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }] }),
        entry('b', { supported_reasoning_levels: [{ effort: 'medium' }] }),
      ]),
    )
    expect(codex.efforts).toEqual(['low', 'medium', 'ultra'])
  })
})
