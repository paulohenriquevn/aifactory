import type { AppEvents, AppHooks, AppRepos } from '../github/app'
import type { KnowledgeStatus } from '../../shared/knowledge'
import type { SetupItem, SetupReport } from '../../shared/panel'

import { claudeCredentialFromEnv } from '../factory/harness-claude'
import { codexCredentialFromEnv } from '../factory/harness-codex'
import { assistModel } from '../factory/models'
import { e2bMaxSessionMs } from '../factory/e2b-sandbox'
import { missingRoutedEvents } from '../ingest/decide'
import { vercelCredentials } from '../factory/vercel-sandbox'

/** Questions the report cannot answer from the environment: they ask the machine or another service. */
export type Probes = {
  /** The Docker sandboxes running now, or nothing when the daemon does not answer. */
  docker?: () => Promise<{ running: number } | undefined>
  /** What an OpenRouter key can still spend, in dollars; nothing when it could not be asked. */
  openrouterCredit?: (key: string) => Promise<number | undefined>
}

export type SetupInput = {
  env: NodeJS.ProcessEnv
  probes?: Probes
  /** The App, when its credentials are there to build it. */
  github: (AppHooks & AppRepos & AppEvents) | undefined
  enabledRepositories: number
  /** The knowledge base, when the database could say. */
  knowledge?: KnowledgeStatus
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const PROVIDER_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
}

/**
 * The knowledge base every agent reads. It is optional, so it never stops the factory from being ready: a
 * line that needs a look says what to do, and the form under the line does it.
 */
export function knowledgeItem(status: KnowledgeStatus): SetupItem {
  const base = { id: 'knowledge', label: 'Knowledge base' }
  if (!status.repository) {
    return {
      ...base,
      status: 'warn',
      detail:
        'Optional. No knowledge repository is chosen, so the agents work from the code and the issue alone.',
    }
  }
  if (status.error) {
    return {
      ...base,
      status: 'warn',
      detail: `${status.repository}: the last sync failed: ${status.error}`,
    }
  }
  if (!status.knowledgeSha) {
    return { ...base, status: 'warn', detail: `${status.repository}: waiting for the first sync.` }
  }
  if (status.okfProblems.length > 0) {
    const [first] = status.okfProblems
    const more = status.okfProblems.length - 1
    return {
      ...base,
      status: 'warn',
      detail: `${status.repository}: the agents read it, but it is not an OKF bundle in everything: ${first}${more > 0 ? ` (and ${more} more)` : ''}.`,
    }
  }
  return {
    ...base,
    status: 'ok',
    detail: `${status.repository} at ${status.knowledgeSha.slice(0, 7)} (${status.readBranch}), synced ${status.syncedAt}. ${status.writtenNotes} note(s) written, ${status.pendingNotes} waiting.`,
  }
}

/** The helper under every text box calls a model with the factory's own key, which a subscription cannot be. */
export function assistantItem(env: NodeJS.ProcessEnv): SetupItem {
  const model = assistModel(env)
  const provider = model.split('/')[0]
  const key = PROVIDER_KEYS[provider]
  if (!key) {
    return {
      id: 'assistant',
      label: 'Writing assistant',
      status: 'warn',
      detail: `FACTORY_ASSIST_MODEL names a provider this page does not know ("${provider}"), so it cannot say whether the key is set.`,
    }
  }
  return env[key]
    ? {
        id: 'assistant',
        label: 'Writing assistant',
        status: 'ok',
        detail: 'The helper under each text box is on.',
      }
    : {
        id: 'assistant',
        label: 'Writing assistant',
        status: 'warn',
        detail: `The helper under each text box needs ${key} on the server. Everything else works without it, but you would have to write the requests yourself.`,
      }
}

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
 * Where agents run, as it is configured: on this machine in Docker, or on Vercel. Only the one in use is
 * judged, because the credentials of the other say nothing about whether a run can start.
 */
export async function sandboxItem(env: NodeJS.ProcessEnv, probes: Probes): Promise<SetupItem> {
  if (env.FACTORY_SANDBOX === 'docker') {
    const docker = await probes.docker?.()
    if (probes.docker && !docker) {
      return {
        id: 'sandbox',
        label: 'Sandbox',
        status: 'missing',
        detail:
          'FACTORY_SANDBOX is docker, but the Docker daemon does not answer. No agent runs without a sandbox: start Docker.',
      }
    }
    return {
      id: 'sandbox',
      label: 'Sandbox',
      status: 'ok',
      detail: docker
        ? `Docker sandboxes on this machine (${docker.running} running now).`
        : 'Docker sandboxes on this machine.',
    }
  }
  if (env.FACTORY_SANDBOX?.trim() === 'e2b') {
    return env.E2B_API_KEY
      ? {
          id: 'sandbox',
          label: 'Sandbox',
          status: 'ok',
          detail: `E2B sandboxes, ${Math.round(e2bMaxSessionMs(env) / 60_000)} minutes each at most.`,
        }
      : {
          id: 'sandbox',
          label: 'Sandbox',
          status: 'missing',
          detail:
            'FACTORY_SANDBOX is e2b, but E2B_API_KEY is not set. No agent runs without a sandbox.',
        }
  }
  return vercelCredentials(env)
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
      }
}

/**
 * The events the App is subscribed to, against the ones the factory reads. An event that is not
 * subscribed is never delivered, and nothing else says so: the webhook just stays quiet about it.
 */
export async function eventsItem(github: AppEvents): Promise<SetupItem> {
  const base = { id: 'events', label: 'Webhook events' }
  try {
    const { events, settingsUrl } = await github.subscriptions()
    const missing = missingRoutedEvents(events)
    if (missing.length === 0) {
      return {
        ...base,
        status: 'ok',
        detail: 'The App subscribes to every event the factory reads.',
      }
    }
    return {
      ...base,
      status: 'warn',
      detail: `The App does not subscribe to ${missing.join(', ')}, so GitHub never tells the factory about them. Turn them on under "Subscribe to events".`,
      link: { label: 'Open the App settings', href: settingsUrl },
    }
  } catch (error) {
    return { ...base, status: 'warn', detail: message(error) }
  }
}

const CREDITS_PAGE = { label: 'Add credit', href: 'https://openrouter.ai/settings/credits' }

/**
 * The assistant of the chat and the page guides. It runs on OpenRouter or on the owner's ChatGPT, so it
 * never blocks the factory, but a key with no credit left is the kind of thing that is found out by a chat
 * that does not answer, and this is where to see it first.
 */
export async function chatItem(env: NodeJS.ProcessEnv, probes: Probes): Promise<SetupItem> {
  const key = env.OPENROUTER_API_KEY
  if (!key) {
    return {
      id: 'chat',
      label: 'Chat and guides',
      status: 'warn',
      detail:
        'OPENROUTER_API_KEY is not set. The chat and the guides can still use your ChatGPT subscription: choose it in the model picker.',
    }
  }
  const left = await probes.openrouterCredit?.(key)
  if (left !== undefined && left < 0.05) {
    return {
      id: 'chat',
      label: 'Chat and guides',
      status: 'warn',
      detail:
        'The OpenRouter key has no credit left, so the chat and the guides cannot answer. Add credit, or choose ChatGPT in the model picker.',
      link: CREDITS_PAGE,
    }
  }
  return {
    id: 'chat',
    label: 'Chat and guides',
    status: 'ok',
    detail:
      left === undefined
        ? 'The OpenRouter key is set.'
        : `The OpenRouter key has $${left.toFixed(2)} left.`,
  }
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
  probes = {},
  knowledge,
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
      const where = await github.installations().catch(() => [])
      const owner = await github.owner().catch(() => undefined)
      items.push(
        reached.length > 0
          ? {
              id: 'github',
              label: 'GitHub App',
              status: 'ok',
              detail: `It reaches ${reached.length} repositor${reached.length === 1 ? 'y' : 'ies'}.`,
              // The page of the account it is installed on, which a private App's owner can always open.
              ...(where[0] || install
                ? {
                    link: {
                      label: 'Choose which repositories it reaches',
                      href: where[0]?.url ?? install!,
                    },
                  }
                : {}),
            }
          : {
              id: 'github',
              label: 'GitHub App',
              status: 'missing',
              detail: `The App is not installed on any repository yet. It is private, so only ${owner ?? 'its owner'} can install it: sign in to GitHub as that account first.`,
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
    items.push(await eventsItem(github))
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
  items.push(await sandboxItem(env, probes))
  const agents = agentItems(env)
  // One working agent is enough to start: the other is a choice, not a blocker.
  if (!agents.some((a) => a.status === 'ok')) {
    for (const a of agents) a.status = 'missing'
  }
  items.push(...agents)
  items.push(assistantItem(env))
  items.push(await chatItem(env, probes))
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
  if (knowledge) items.push(knowledgeItem(knowledge))
  return { ready: items.every((i) => i.status !== 'missing'), items }
}
