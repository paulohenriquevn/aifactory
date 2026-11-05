import { describe, expect, it } from 'vitest'

import type { AppHooks, AppRepos, HookDelivery } from '../github/app'

import { chatItem, sandboxItem, setupReport } from './setup'
import { openrouterCredit } from './setup-probes'

const full = {
  GITHUB_APP_SLUG: 'my-app',
  GITHUB_WEBHOOK_SECRET: 's',
  VERCEL_TOKEN: 't',
  VERCEL_TEAM_ID: 'team',
  VERCEL_PROJECT_ID: 'prj',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
  FACTORY_CODEX_HOME: '/nonexistent',
}

const delivery = (statusCode: number): HookDelivery => ({
  id: '1',
  guid: 'g',
  deliveredAt: new Date(),
  statusCode,
  event: 'issues',
})

const app = (over: Partial<AppHooks & AppRepos> = {}): AppHooks & AppRepos => ({
  installations: async () => [
    {
      id: 1,
      account: 'paulo',
      type: 'User',
      selection: 'all',
      url: 'https://github.com/settings/installations/1',
    },
  ],
  owner: async () => 'paulo',
  installationRepositories: async () => [{ fullName: 'o/a', private: true, defaultBranch: 'main' }],
  hookDeliveries: async () => [delivery(200)],
  redeliver: async () => {},
  ...over,
})

const item = (report: Awaited<ReturnType<typeof setupReport>>, id: string) =>
  report.items.find((i) => i.id === id)!

describe('the setup report', () => {
  it('is ready when GitHub, the webhook, the sandbox, an agent and a repository are all there', async () => {
    const report = await setupReport({ env: full, github: app(), enabledRepositories: 2 })
    expect(report.ready).toBe(true)
    expect(report.items.map((i) => [i.id, i.status])).toEqual([
      ['github', 'ok'],
      ['webhook', 'ok'],
      ['secret', 'ok'],
      ['sandbox', 'ok'],
      ['claude', 'ok'],
      ['codex', 'warn'],
      ['assistant', 'warn'],
      ['chat', 'warn'],
      ['repositories', 'ok'],
    ])
    expect(item(report, 'github').detail).toBe('It reaches 1 repository.')
    expect(item(report, 'github').link?.href).toBe('https://github.com/settings/installations/1')
    expect(item(report, 'claude').detail).toBe('Paid by your subscription.')
    expect(item(report, 'repositories').detail).toBe('2 enabled.')
  })

  it('says the App is missing when its credentials are not there, and what to run', async () => {
    const report = await setupReport({ env: full, github: undefined, enabledRepositories: 1 })
    expect(report.ready).toBe(false)
    expect(item(report, 'github')).toMatchObject({ status: 'missing' })
    expect(item(report, 'github').detail).toContain('github-app-setup')
    expect(report.items.some((i) => i.id === 'webhook')).toBe(false)
  })

  it('sends the owner to the install page when the App reaches no repository', async () => {
    const report = await setupReport({
      env: full,
      github: app({ installationRepositories: async () => [], installations: async () => [] }),
      enabledRepositories: 0,
    })
    expect(item(report, 'github')).toMatchObject({
      status: 'missing',
      detail: expect.stringContaining('The App is not installed on any repository yet.'),
      link: { href: 'https://github.com/apps/my-app/installations/new' },
    })
    expect(item(report, 'repositories')).toMatchObject({
      status: 'missing',
      link: { href: '/repositories' },
    })
  })

  it('reports what GitHub answered when the App cannot be used, and keeps going', async () => {
    const report = await setupReport({
      env: full,
      github: app({
        installationRepositories: async () => {
          throw new Error('GitHub answered 401 listing installations')
        },
        hookDeliveries: async () => {
          throw new Error('GitHub answered 401 listing deliveries')
        },
      }),
      enabledRepositories: 1,
    })
    expect(item(report, 'github')).toMatchObject({
      status: 'missing',
      detail: 'GitHub answered 401 listing installations',
    })
    expect(item(report, 'webhook')).toMatchObject({
      status: 'warn',
      detail: 'GitHub answered 401 listing deliveries',
    })
    expect(item(report, 'sandbox').status).toBe('ok')
  })

  it('warns, and does not block, when no delivery came yet or the last one was refused', async () => {
    const none = await setupReport({
      env: full,
      github: app({ hookDeliveries: async () => [] }),
      enabledRepositories: 1,
    })
    expect(item(none, 'webhook')).toMatchObject({
      status: 'warn',
      detail: 'GitHub has not delivered anything yet.',
    })
    expect(none.ready).toBe(true)

    const refused = await setupReport({
      env: full,
      github: app({ hookDeliveries: async () => [delivery(502)] }),
      enabledRepositories: 1,
    })
    expect(item(refused, 'webhook').detail).toBe('The last delivery got 502. Is the tunnel up?')
  })

  it('blocks on a missing webhook secret and a missing sandbox, and names the variables', async () => {
    const report = await setupReport({
      env: { ...full, GITHUB_WEBHOOK_SECRET: '', VERCEL_TOKEN: '' },
      github: app(),
      enabledRepositories: 1,
    })
    expect(report.ready).toBe(false)
    expect(item(report, 'secret')).toMatchObject({ status: 'missing' })
    expect(item(report, 'sandbox').detail).toContain('VERCEL_TOKEN')
  })

  it('needs one agent that works, and treats having both as a choice', async () => {
    const none = await setupReport({
      env: { ...full, CLAUDE_CODE_OAUTH_TOKEN: '' },
      github: app(),
      enabledRepositories: 1,
    })
    expect(none.ready).toBe(false)
    expect(item(none, 'claude').status).toBe('missing')
    expect(item(none, 'codex').status).toBe('missing')

    const key = await setupReport({
      env: { ...full, CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: 'k' },
      github: app(),
      enabledRepositories: 1,
    })
    expect(item(key, 'claude').detail).toBe('Paid by an API key.')
  })

  it('never carries a secret in what it says', async () => {
    const report = await setupReport({
      env: {
        ...full,
        ANTHROPIC_API_KEY: 'sk-ant-SECRET-VALUE',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-SECRET',
      },
      github: app(),
      enabledRepositories: 1,
    })
    expect(JSON.stringify(report)).not.toMatch(/SECRET|VERCEL_TOKEN=|prj|team/)
  })
})

describe('the link to choose repositories', () => {
  it('opens the installation page of the account the App is on, not the install page a private App refuses', async () => {
    const report = await setupReport({ env: full, github: app(), enabledRepositories: 1 })
    expect(item(report, 'github').link).toEqual({
      label: 'Choose which repositories it reaches',
      href: 'https://github.com/settings/installations/1',
    })
  })

  it('falls back to the install page when the installations cannot be read', async () => {
    const report = await setupReport({
      env: full,
      github: app({
        installations: async () => {
          throw new Error('no')
        },
      }),
      enabledRepositories: 1,
    })
    expect(item(report, 'github').link?.href).toBe(
      'https://github.com/apps/my-app/installations/new',
    )
  })

  it('tells who must sign in to install a private App that is not installed yet', async () => {
    const report = await setupReport({
      env: full,
      github: app({ installationRepositories: async () => [], installations: async () => [] }),
      enabledRepositories: 0,
    })
    expect(item(report, 'github').detail).toContain('only paulo can install it')
    expect(item(report, 'github').link?.href).toBe(
      'https://github.com/apps/my-app/installations/new',
    )

    const unknown = await setupReport({
      env: full,
      github: app({
        installationRepositories: async () => [],
        installations: async () => [],
        owner: async () => {
          throw new Error('no')
        },
      }),
      enabledRepositories: 0,
    })
    expect(item(unknown, 'github').detail).toContain('only its owner can install it')
  })
})

describe('the writing assistant', () => {
  const assistant = async (env: NodeJS.ProcessEnv) =>
    item(
      await setupReport({ env: { ...full, ...env }, github: app(), enabledRepositories: 1 }),
      'assistant',
    )

  it('is on when the key of its provider is set, and does not block when it is not', async () => {
    expect(await assistant({ ANTHROPIC_API_KEY: 'k' })).toMatchObject({ status: 'ok' })
    const off = await assistant({ ANTHROPIC_API_KEY: '' })
    expect(off).toMatchObject({ status: 'warn' })
    expect(off.detail).toContain('ANTHROPIC_API_KEY')
    const report = await setupReport({
      env: { ...full, ANTHROPIC_API_KEY: '' },
      github: app(),
      enabledRepositories: 1,
    })
    expect(report.ready).toBe(true)
  })

  it('follows the model the owner chose, and says when it cannot tell', async () => {
    expect(
      (await assistant({ FACTORY_ASSIST_MODEL: 'openrouter/x/y', OPENROUTER_API_KEY: 'k' })).status,
    ).toBe('ok')
    const missing = await assistant({ FACTORY_ASSIST_MODEL: 'openai/gpt', ANTHROPIC_API_KEY: 'k' })
    expect(missing.detail).toContain('OPENAI_API_KEY')
    expect((await assistant({ FACTORY_ASSIST_MODEL: 'mystery/model' })).detail).toContain(
      '"mystery"',
    )
  })

  it('never carries the key', async () => {
    const shown = await assistant({ ANTHROPIC_API_KEY: 'sk-ant-VERY-SECRET' })
    expect(JSON.stringify(shown)).not.toContain('VERY-SECRET')
  })
})

describe('the sandbox line', () => {
  it('judges Docker, not Vercel, when the factory runs on Docker, and says how many are running', async () => {
    const env = { FACTORY_SANDBOX: 'docker' }
    expect(await sandboxItem(env, { docker: async () => ({ running: 3 }) })).toMatchObject({
      status: 'ok',
      detail: 'Docker sandboxes on this machine (3 running now).',
    })
    expect(await sandboxItem(env, {})).toMatchObject({
      status: 'ok',
      detail: 'Docker sandboxes on this machine.',
    })
  })

  it('blocks when the Docker daemon does not answer, and says what to do', async () => {
    const item = await sandboxItem({ FACTORY_SANDBOX: 'docker' }, { docker: async () => undefined })
    expect(item.status).toBe('missing')
    expect(item.detail).toContain('start Docker')
  })

  it('does not call Vercel credentials a ready sandbox when Docker is the one in use', async () => {
    const item = await sandboxItem(
      { FACTORY_SANDBOX: 'docker', VERCEL_TOKEN: 't', VERCEL_TEAM_ID: 't', VERCEL_PROJECT_ID: 'p' },
      { docker: async () => undefined },
    )
    expect(item.status).toBe('missing')
  })
})

describe('the chat and guides line', () => {
  it('warns, and points at ChatGPT, when there is no OpenRouter key', async () => {
    const item = await chatItem({}, {})
    expect(item.status).toBe('warn')
    expect(item.detail).toContain('ChatGPT')
  })

  it('warns, with the page to add credit, when the key has none left', async () => {
    for (const left of [0, 0.01, -1]) {
      const item = await chatItem(
        { OPENROUTER_API_KEY: 'k' },
        { openrouterCredit: async () => left },
      )
      expect(item.status, String(left)).toBe('warn')
      expect(item.link?.href).toBe('https://openrouter.ai/settings/credits')
    }
  })

  it('is ready with credit, saying how much, and still ready when OpenRouter could not be asked', async () => {
    expect(
      await chatItem({ OPENROUTER_API_KEY: 'k' }, { openrouterCredit: async () => 12.345 }),
    ).toMatchObject({
      status: 'ok',
      detail: 'The OpenRouter key has $12.35 left.',
    })
    expect(
      await chatItem({ OPENROUTER_API_KEY: 'k' }, { openrouterCredit: async () => undefined }),
    ).toMatchObject({
      status: 'ok',
      detail: 'The OpenRouter key is set.',
    })
    expect((await chatItem({ OPENROUTER_API_KEY: 'k' }, {})).status).toBe('ok')
  })

  it('never keeps the factory from being ready: it is a warning, not a blocker', async () => {
    const report = await setupReport({
      env: { ...full, OPENROUTER_API_KEY: 'k' },
      github: app(),
      enabledRepositories: 1,
      probes: { openrouterCredit: async () => 0 },
    })
    expect(item(report, 'chat').status).toBe('warn')
    expect(report.ready).toBe(true)
  })
})

describe('asking OpenRouter for the credit left', () => {
  const answer = (body: unknown, ok = true) =>
    (async () => ({ ok, json: async () => body })) as unknown as typeof fetch

  it('is what was bought minus what was used', async () => {
    expect(
      await openrouterCredit('k', answer({ data: { total_credits: 65, total_usage: 12.5 } })),
    ).toBe(52.5)
  })

  it('says nothing when it was refused, malformed or unreachable, and sends the key only as a header', async () => {
    expect(await openrouterCredit('k', answer({}, false))).toBeUndefined()
    expect(await openrouterCredit('k', answer({ data: { total_credits: 1 } }))).toBeUndefined()
    expect(await openrouterCredit('k', answer({}))).toBeUndefined()
    expect(
      await openrouterCredit('k', (async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch),
    ).toBeUndefined()
    let seen: RequestInit | undefined
    let url = ''
    await openrouterCredit('secret', (async (u: string, init: RequestInit) => {
      url = u
      seen = init
      return { ok: false }
    }) as unknown as typeof fetch)
    expect(url).not.toContain('secret')
    expect((seen?.headers as Record<string, string>).authorization).toBe('Bearer secret')
  })
})
