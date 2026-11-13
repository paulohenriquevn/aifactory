import type { EgressRule, IsolatedSandbox } from './sandbox'

/**
 * How often a running sandbox gets a new GitHub token. GitHub's installation tokens last an hour, and
 * `installationToken` hands one out until it has 55 minutes left, so a token the run holds is never older
 * than this plus five minutes. That leaves a call that starts with it more than half an hour to finish.
 */
export const CREDENTIAL_RENEWAL_MS = 15 * 60_000

/** The firewall rule that lets the sandbox's git reach github.com as the factory's installation. */
export function githubEgress(token: string): EgressRule {
  return {
    domain: 'github.com',
    headers: {
      authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    },
  }
}

export type CredentialRenewal = {
  /** A new token for the task's repository. */
  mint: () => Promise<string>
  /** The run's own calls to GitHub use the token from here on. */
  onToken: (token: string) => void
  /** A renewal that failed. The run keeps the token it has and the next interval tries again. */
  onFailure?: (error: unknown) => void
}

/**
 * Renews the GitHub token of a running sandbox every `CREDENTIAL_RENEWAL_MS`: the firewall first, then the
 * run, so the run never holds a token the sandbox's git does not. This is what lets a run last longer than
 * the hour a token does (paulohenriquevn/aifactory#4). Stopping the returned sandbox, or saving it to a
 * snapshot, stops the renewals.
 */
export function renewGithubCredential(
  sandbox: IsolatedSandbox,
  egress: EgressRule[],
  renewal: CredentialRenewal,
): IsolatedSandbox {
  const update = sandbox.updateEgress?.bind(sandbox)
  if (!update) {
    throw new Error(
      'this sandbox provider cannot renew the credentials of a running sandbox, so a run would outlive its GitHub token',
    )
  }
  const onFailure =
    renewal.onFailure ??
    ((error: unknown) =>
      console.warn(JSON.stringify({ event: 'credential_renewal_failed', error: String(error) })))
  let renewing = false
  const renew = async () => {
    if (renewing) return
    renewing = true
    try {
      const token = await renewal.mint()
      await update(
        egress.map((rule) => (rule.domain === 'github.com' ? githubEgress(token) : rule)),
      )
      renewal.onToken(token)
    } catch (error) {
      onFailure(error)
    } finally {
      renewing = false
    }
  }
  const timer = setInterval(() => void renew(), CREDENTIAL_RENEWAL_MS)
  timer.unref?.()
  const snapshot = sandbox.snapshot?.bind(sandbox)
  return {
    ...sandbox,
    stop: async () => {
      clearInterval(timer)
      await sandbox.stop()
    },
    // Saving the disk stops the sandbox too, so nothing is left to renew.
    ...(snapshot && {
      snapshot: async () => {
        clearInterval(timer)
        return snapshot()
      },
    }),
  }
}
