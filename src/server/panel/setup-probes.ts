import { execFile } from 'node:child_process'

import type { Probes } from './setup'

const ASK_MS = 4_000

/** Sandboxes are labelled when they are made, which is how they are told from any other container. */
const dockerRunning = () =>
  new Promise<{ running: number } | undefined>((resolve) => {
    execFile(
      'docker',
      ['ps', '--filter', 'label=aifactory.sandbox', '--format', '{{.Names}}'],
      { timeout: ASK_MS },
      (error, stdout) =>
        resolve(
          error
            ? undefined
            : { running: stdout.split('\n').filter((n) => n.startsWith('factory-sbx-')).length },
        ),
    )
  })

/** What the key can still spend: the credit bought minus what was used. Nothing when OpenRouter does not say. */
export async function openrouterCredit(
  key: string,
  ask: typeof fetch = fetch,
): Promise<number | undefined> {
  try {
    const res = await ask('https://openrouter.ai/api/v1/credits', {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(ASK_MS),
    })
    if (!res.ok) return undefined
    const { data } = (await res.json()) as {
      data?: { total_credits?: number; total_usage?: number }
    }
    if (typeof data?.total_credits !== 'number' || typeof data.total_usage !== 'number')
      return undefined
    return data.total_credits - data.total_usage
  } catch {
    return undefined
  }
}

export const realProbes: Probes = {
  docker: dockerRunning,
  openrouterCredit: (key) => openrouterCredit(key),
}
