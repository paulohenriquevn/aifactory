import { createGithubApi } from '../github/pulls'

import { factoryDeps } from './deps'
import type { PlanDeps } from './plan'

/** What planning needs, from the same environment a run reads. */
export function planDeps(env: NodeJS.ProcessEnv = process.env): PlanDeps {
  const deps = factoryDeps(env)
  const choice = deps.harness
  return {
    db: deps.db,
    github: deps.github,
    api: createGithubApi(),
    sandbox: deps.sandbox,
    harness: typeof choice === 'function' ? choice : () => choice,
  }
}
