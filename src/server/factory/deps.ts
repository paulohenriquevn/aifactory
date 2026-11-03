import { readFileSync } from 'node:fs'

import { getDb } from '../db'
import { createGithubApp } from '../github/app'

import { claudeCodeHarness } from './harness'
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
export function factoryDeps(env: NodeJS.ProcessEnv = process.env): RunTaskDeps {
  const slug = required(env, 'GITHUB_APP_SLUG')
  return {
    db: getDb(),
    github: createGithubApp({
      appId: required(env, 'GITHUB_APP_ID'),
      privateKey: readFileSync(required(env, 'GITHUB_APP_PRIVATE_KEY_PATH'), 'utf8'),
    }),
    sandbox: vercelSandboxProvider(),
    harness: claudeCodeHarness(),
    anthropicApiKey: required(env, 'ANTHROPIC_API_KEY'),
    author: { name: `${slug}[bot]`, email: `${slug}[bot]@users.noreply.github.com` },
  }
}
