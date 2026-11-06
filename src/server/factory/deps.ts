import { readFileSync } from 'node:fs'

import { knowledgeRoot, knowledgeSource } from '../knowledge/source'
import { getDb } from '../db'
import { createGithubApp } from '../github/app'

import type { ReleaseMode } from './deliver'
import { optionsFor } from './engine-models'
import { DEFAULT_HARNESS, harnessRegistry, pickHarness } from './harness-registry'
import type { RunTaskDeps } from './run-task'
import { sandboxProviderFromEnv } from './sandbox-provider'

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

const apps = new Map<string, ReturnType<typeof createGithubApp>>()

/**
 * The App, signed with its own key. One per credential, so what it remembers (a token for a
 * repository, the list of repositories it reaches) is shared by everything that asks.
 */
export function githubAppFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const appId = required(env, 'GITHUB_APP_ID')
  const keyPath = required(env, 'GITHUB_APP_PRIVATE_KEY_PATH')
  const known = apps.get(`${appId}:${keyPath}`)
  if (known) return known
  const created = createGithubApp({ appId, privateKey: readFileSync(keyPath, 'utf8') })
  apps.set(`${appId}:${keyPath}`, created)
  return created
}

export function factoryDeps(env: NodeJS.ProcessEnv = process.env): RunTaskDeps {
  const slug = required(env, 'GITHUB_APP_SLUG')
  const registry = harnessRegistry(env)
  const fallback = env.FACTORY_HARNESS || DEFAULT_HARNESS
  const pick = (labels: string[]) =>
    pickHarness(registry, fallback, labels, 'harness', (engine) =>
      optionsFor(env, 'builder', engine),
    )
  // The reviewer defaults to the builder's own agent in a fresh session. A different agent is a
  // real second opinion, so FACTORY_REVIEWER or a `reviewer:<name>` label can name one.
  const reviewerName = env.FACTORY_REVIEWER
  const pickReviewer = (labels: string[]) =>
    reviewerName || labels.some((l) => /^reviewer:/i.test(l))
      ? pickHarness(registry, reviewerName ?? fallback, labels, 'reviewer', (engine) =>
          optionsFor(env, 'reviewer', engine),
        )
      : undefined
  return {
    db: getDb(),
    github: githubAppFromEnv(env),
    sandbox: sandboxProviderFromEnv(env),
    harness: pick,
    releaseMode: releaseModeFromEnv(env),
    reviewer: pickReviewer,
    author: { name: `${slug}[bot]`, email: `${slug}[bot]@users.noreply.github.com` },
    knowledge: knowledgeSource(getDb(), knowledgeRoot(env)),
  }
}
