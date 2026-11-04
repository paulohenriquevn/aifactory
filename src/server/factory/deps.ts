import { readFileSync } from 'node:fs'

import { getDb } from '../db'
import { createGithubApp } from '../github/app'

import type { ReleaseMode } from './deliver'
import { DEFAULT_HARNESS, harnessRegistry, pickHarness } from './harness-registry'
import type { RunTaskDeps } from './run-task'
import { vercelSandboxProvider } from './vercel-sandbox'

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

/**
 * What a run needs, from the environment. It is read when a job starts, not at boot, so the
 * server can come up (and answer liveness and readiness) before every credential is in place.
 */
/** `manual` unless the environment says otherwise, and an unknown word is an error, not a default. */
export function releaseModeFromEnv(env: NodeJS.ProcessEnv): ReleaseMode {
  const mode = env.FACTORY_RELEASE_MODE || 'manual'
  if (mode !== 'manual' && mode !== 'trial' && mode !== 'auto') {
    throw new Error(`FACTORY_RELEASE_MODE must be manual, trial or auto, got ${mode}`)
  }
  return mode
}

export function factoryDeps(env: NodeJS.ProcessEnv = process.env): RunTaskDeps {
  const slug = required(env, 'GITHUB_APP_SLUG')
  const registry = harnessRegistry(env)
  const fallback = env.FACTORY_HARNESS || DEFAULT_HARNESS
  const pick = (labels: string[]) => pickHarness(registry, fallback, labels)
  // The reviewer defaults to the builder's own agent in a fresh session. A different agent is a
  // real second opinion, so FACTORY_REVIEWER or a `reviewer:<name>` label can name one.
  const reviewerName = env.FACTORY_REVIEWER
  const pickReviewer = (labels: string[]) =>
    reviewerName || labels.some((l) => /^reviewer:/i.test(l))
      ? pickHarness(registry, reviewerName ?? fallback, labels, 'reviewer')
      : undefined
  return {
    db: getDb(),
    github: createGithubApp({
      appId: required(env, 'GITHUB_APP_ID'),
      privateKey: readFileSync(required(env, 'GITHUB_APP_PRIVATE_KEY_PATH'), 'utf8'),
    }),
    sandbox: vercelSandboxProvider(),
    harness: pick,
    releaseMode: releaseModeFromEnv(env),
    reviewer: pickReviewer,
    author: { name: `${slug}[bot]`, email: `${slug}[bot]@users.noreply.github.com` },
  }
}
