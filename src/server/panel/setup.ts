import type { AppHooks, AppRepos } from '../github/app'
import type { SetupItem, SetupReport } from '../../shared/panel'

import { claudeCredentialFromEnv } from '../factory/harness-claude'
import { codexCredentialFromEnv } from '../factory/harness-codex'
import { vercelCredentials } from '../factory/vercel-sandbox'

export type SetupInput = {
  env: NodeJS.ProcessEnv
  /** The App, when its credentials are there to build it. */
  github: (AppHooks & AppRepos) | undefined
  enabledRepositories: number
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function agentItems(env: NodeJS.ProcessEnv): SetupItem[] {
  const items: SetupItem[] = []
  try {
    const { kind } = claudeCredentialFromEnv(env)
    items.push({
      id: 'claude',
      label: 'Claude Code',
      status: 'ok',
      detail: kind === 'subscription' ? 'Paid by your subscription.' : 'Paid by an API key.',
    })
  } catch (error) {
    items.push({ id: 'claude', label: 'Claude Code', status: 'warn', detail: message(error) })
  }
  try {
    const { kind } = codexCredentialFromEnv(env)
    items.push({
      id: 'codex',
      label: 'Codex',
      status: 'ok',
      detail: kind === 'subscription' ? 'Paid by your subscription.' : 'Paid by an API key.',
    })
  } catch (error) {
    items.push({ id: 'codex', label: 'Codex', status: 'warn', detail: message(error) })
  }
  return items
}

/**
 * What stands between a fresh install and a first pull request, one line each, with the page that fixes
 * it where there is one. It reads configuration and asks GitHub; it never prints a secret, only whether
 * one is there and what pays for it.
 */
export async function setupReport({
  env,
  github,
  enabledRepositories,
}: SetupInput): Promise<SetupReport> {
  const items: SetupItem[] = []
  const slug = env.GITHUB_APP_SLUG
  const install = slug ? `https://github.com/apps/${slug}/installations/new` : undefined

  if (!github) {
    items.push({
      id: 'github',
      label: 'GitHub App',
      status: 'missing',
      detail:
        'GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH are not set. Run scripts/github-app-setup.mjs once.',
    })
  } else {
    try {
      const reached = await github.installationRepositories()
      items.push(
        reached.length > 0
          ? {
              id: 'github',
              label: 'GitHub App',
              status: 'ok',
              detail: `It reaches ${reached.length} repositor${reached.length === 1 ? 'y' : 'ies'}.`,
              ...(install
                ? { link: { label: 'Change which repositories it reaches', href: install } }
                : {}),
            }
          : {
              id: 'github',
              label: 'GitHub App',
              status: 'missing',
              detail: 'The App is not installed on any repository yet.',
              ...(install
                ? { link: { label: 'Install it and choose repositories', href: install } }
                : {}),
            },
      )
    } catch (error) {
      items.push({ id: 'github', label: 'GitHub App', status: 'missing', detail: message(error) })
    }

    try {
      const [latest] = await github.hookDeliveries({ pages: 1 })
      items.push(
        !latest
          ? {
              id: 'webhook',
              label: 'Webhook',
              status: 'warn',
              detail: 'GitHub has not delivered anything yet.',
            }
          : latest.statusCode >= 200 && latest.statusCode < 300
            ? {
                id: 'webhook',
                label: 'Webhook',
                status: 'ok',
                detail: 'The last delivery was accepted.',
              }
            : {
                id: 'webhook',
                label: 'Webhook',
                status: 'warn',
                detail: `The last delivery got ${latest.statusCode}. Is the tunnel up?`,
              },
      )
    } catch (error) {
      items.push({ id: 'webhook', label: 'Webhook', status: 'warn', detail: message(error) })
    }
  }

  items.push(
    env.GITHUB_WEBHOOK_SECRET
      ? { id: 'secret', label: 'Webhook secret', status: 'ok', detail: 'Set.' }
      : {
          id: 'secret',
          label: 'Webhook secret',
          status: 'missing',
          detail: 'GITHUB_WEBHOOK_SECRET is not set, so every delivery is refused.',
        },
  )
  items.push(
    vercelCredentials(env)
      ? {
          id: 'sandbox',
          label: 'Sandbox',
          status: 'ok',
          detail: 'Vercel Sandbox credentials are set.',
        }
      : {
          id: 'sandbox',
          label: 'Sandbox',
          status: 'missing',
          detail:
            'VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID are not all set. No agent runs without a sandbox.',
        },
  )
  const agents = agentItems(env)
  // One working agent is enough to start: the other is a choice, not a blocker.
  if (!agents.some((a) => a.status === 'ok')) {
    for (const a of agents) a.status = 'missing'
  }
  items.push(...agents)
  items.push(
    enabledRepositories > 0
      ? {
          id: 'repositories',
          label: 'Repositories',
          status: 'ok',
          detail: `${enabledRepositories} enabled.`,
        }
      : {
          id: 'repositories',
          label: 'Repositories',
          status: 'missing',
          detail: 'No repository is enabled, so a labelled issue does nothing.',
          link: { label: 'Enable one', href: '/repositories' },
        },
  )
  return { ready: items.every((i) => i.status !== 'missing'), items }
}
