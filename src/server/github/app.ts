import { createSign } from 'node:crypto'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type InstallationToken = { token: string; expiresAt: Date }

/** One try by GitHub to deliver a webhook to us, as the App's delivery log lists it. */
export type HookDelivery = {
  /** A string: GitHub's delivery ids are 64-bit, and a JavaScript number cannot hold them exactly. */
  id: string
  /** The `X-GitHub-Delivery` header: the same for every redelivery of one event. */
  guid: string
  deliveredAt: Date
  statusCode: number
  event: string
}

/** What the App can do with its own key, with no repository involved. */
export type AppHooks = {
  /** The App's recent webhook deliveries, newest first. */
  hookDeliveries(options?: { pages?: number }): Promise<HookDelivery[]>
  /** Asks GitHub to send a delivery again. */
  redeliver(deliveryId: string): Promise<void>
}

export type GithubApp = {
  /**
   * A short-lived token limited to one repository. There is no way to ask for a token without a
   * repository: the app is installed on every repository of the account, so the limit lives here.
   */
  installationToken(repo: string): Promise<InstallationToken>
}

export type GithubAppOptions = {
  appId: string
  /** PEM of the app's private key. */
  privateKey: string
  fetch?: FetchLike
  apiUrl?: string
  now?: () => number
}

const PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  checks: 'write',
} as const

/** A token with less than this left is replaced rather than handed out. */
const REFRESH_MARGIN_MS = 60_000

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

const base64url = (value: unknown) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')

export function createGithubApp(options: GithubAppOptions): GithubApp & AppHooks {
  const { appId, privateKey, apiUrl = 'https://api.github.com' } = options
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init))
  const now = options.now ?? Date.now
  const cache = new Map<string, InstallationToken>()

  function appJwt(): string {
    const seconds = Math.floor(now() / 1000)
    const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({
      iat: seconds - 60,
      exp: seconds + 540,
      iss: appId,
    })}`
    const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')
    return `${unsigned}.${signature}`
  }

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    return fetchImpl(`${apiUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        authorization: `Bearer ${appJwt()}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    })
  }

  return {
    async hookDeliveries({ pages = 3 } = {}) {
      const found: HookDelivery[] = []
      let path: string | undefined = '/app/hook/deliveries?per_page=100'
      for (let page = 0; path && page < pages; page++) {
        const response = await call(path)
        if (!response.ok) throw new Error(`GitHub answered ${response.status} listing deliveries`)
        // The ids go through as text before parsing: past 2^53 a number is rounded, and the rounded id
        // is one GitHub has never heard of.
        const text = (await response.text()).replace(/"id"\s*:\s*(\d+)/g, '"id":"$1"')
        const rows = JSON.parse(text) as {
          id: string
          guid: string
          delivered_at: string
          status_code: number
          event: string
        }[]
        for (const r of rows) {
          found.push({
            id: r.id,
            guid: r.guid,
            deliveredAt: new Date(r.delivered_at),
            statusCode: r.status_code,
            event: r.event,
          })
        }
        const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')
        path = next ? next[1].replace(apiUrl, '') : undefined
      }
      return found
    },
    async redeliver(deliveryId) {
      if (!/^\d+$/.test(deliveryId)) throw new Error(`not a delivery id: ${deliveryId}`)
      const response = await call(`/app/hook/deliveries/${deliveryId}/attempts`, { method: 'POST' })
      if (response.status !== 202) {
        throw new Error(`GitHub answered ${response.status} redelivering ${deliveryId}`)
      }
    },
    async installationToken(repo) {
      if (!REPO.test(repo)) {
        throw new Error(`repository must be written owner/name, got ${JSON.stringify(repo)}`)
      }
      const cached = cache.get(repo)
      if (cached && cached.expiresAt.getTime() - now() > REFRESH_MARGIN_MS) return cached

      const name = repo.split('/')[1]
      const installation = await call(`/repos/${repo}/installation`)
      if (installation.status === 404) {
        throw new Error(`the GitHub App is not installed on ${repo}`)
      }
      if (!installation.ok) {
        throw new Error(
          `GitHub answered ${installation.status} looking up the installation of ${repo}`,
        )
      }
      const { id } = (await installation.json()) as { id: number }

      const minted = await call(`/app/installations/${id}/access_tokens`, {
        method: 'POST',
        body: JSON.stringify({ repositories: [name], permissions: PERMISSIONS }),
      })
      if (minted.status !== 201) {
        throw new Error(`GitHub answered ${minted.status} minting a token for ${repo}`)
      }
      const body = (await minted.json()) as { token: string; expires_at: string }
      const token = { token: body.token, expiresAt: new Date(body.expires_at) }
      cache.set(repo, token)
      return token
    },
  }
}
