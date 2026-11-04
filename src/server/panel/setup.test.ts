import { describe, expect, it } from 'vitest'

import type { AppHooks, AppRepos, HookDelivery } from '../github/app'

import { setupReport } from './setup'

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
