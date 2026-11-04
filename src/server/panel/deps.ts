import { getDb } from '../db'
import { inTransactionForRun } from '../factory/resume-queue'
import { createGithubApp } from '../github/app'
import { createGithubApi } from '../github/pulls'

import { ActionRefused, type ActionDeps } from './actions'
import { readFileSync } from 'node:fs'

/** What a panel action needs, read when it runs, like the factory's own dependencies. */
export function actionDeps(env: NodeJS.ProcessEnv = process.env): ActionDeps {
  const required = (name: string) => {
    const value = env[name]
    if (!value) throw new Error(`${name} is not set`)
    return value
  }
  return {
    db: getDb(),
    github: createGithubApp({
      appId: required('GITHUB_APP_ID'),
      privateKey: readFileSync(required('GITHUB_APP_PRIVATE_KEY_PATH'), 'utf8'),
    }),
    api: createGithubApi(),
    inTransaction: inTransactionForRun,
  }
}

/** A refused action is the person's to fix (409); anything else is a fault (it is rethrown). */
export function refusal(error: unknown): Response {
  if (error instanceof ActionRefused) {
    return Response.json({ error: 'refused', message: error.message }, { status: 409 })
  }
  throw error
}
