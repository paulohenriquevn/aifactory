import { drizzle } from 'drizzle-orm/node-postgres'
import type { QueueClient } from 'theokit/server/jobs'

import { getDb, getPool } from '../db'
import * as schema from '../db/schema'
import { jobBackend } from '../factory/job-backend'
import { githubAppFromEnv } from '../factory/deps'
import { harnessRegistry } from '../factory/harness-registry'
import { readRecipe } from '../factory/recipe'
import { inTransactionForPlan, inTransactionForRun } from '../factory/resume-queue'
import { sandboxProviderFromEnv } from '../factory/sandbox-provider'
import { createGithubApp } from '../github/app'
import { createIssuesApi } from '../github/issues-api'
import { createGithubApi } from '../github/pulls'

import { ActionRefused, type ActionDeps } from './actions'
import { repositoryDoctor, type DoctorDeps } from './doctor'
import type { RunProofDeps, StartProofDeps } from './prove'
import type { WorkDeps } from './work'
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
    enqueueResume: async (input, key) => {
      await jobBackend().enqueue({ name: 'resume-task', input, idempotencyKey: key })
    },
    deleteSnapshot: async (snapshotId) => {
      await sandboxProviderFromEnv(env).deleteSnapshot?.(snapshotId)
    },
  }
}

/** What the doctor of a repository reads with, and repairs with. */
export function doctorDeps(env: NodeJS.ProcessEnv = process.env): DoctorDeps {
  return {
    db: getDb(),
    github: githubAppFromEnv(env),
    api: createGithubApi(),
    issues: createIssuesApi(),
  }
}

/** What the repositories, jobs and plans pages need, read when they run. */
export function workDeps(env: NodeJS.ProcessEnv = process.env): WorkDeps {
  const slug = env.GITHUB_APP_SLUG
  return {
    db: getDb(),
    github: githubAppFromEnv(env),
    issues: createIssuesApi(),
    api: createGithubApi(),
    diagnose: (fullName) => repositoryDoctor(doctorDeps(env), fullName),
    installUrl: slug ? `https://github.com/apps/${slug}/installations/new` : undefined,
    agents: Object.keys(harnessRegistry(env)),
    inTransaction: inTransactionForPlan,
  }
}

/** What asking for a proof of checks needs: the row and its `prove-checks` job commit together. */
export function proofStartDeps(queue: QueueClient): StartProofDeps {
  return {
    db: getDb(),
    inTransaction: async (work) => {
      const client = await getPool().connect()
      try {
        return await drizzle(client, { schema }).transaction((tx) =>
          work(tx as never, async (job) => {
            await queue.enqueueInTransaction(client, 'prove-checks', job, {
              idempotencyKey: `prove-checks-${job.repository.toLowerCase()}-${job.at}`,
            })
          }),
        )
      } finally {
        client.release()
      }
    },
  }
}

/** What the `prove-checks` job runs with: the sandbox a run would get, and the doctor for afterwards. */
export function proofDeps(env: NodeJS.ProcessEnv = process.env): RunProofDeps {
  return {
    db: getDb(),
    github: githubAppFromEnv(env),
    api: createGithubApi(),
    sandbox: sandboxProviderFromEnv(env),
    fetchRecipe: (repo, token) => readRecipe(repo, token),
    diagnose: (fullName) => repositoryDoctor(doctorDeps(env), fullName),
  }
}

/** A refused action is the person's to fix (409); anything else is a fault (it is rethrown). */
export function refusal(error: unknown): Response {
  if (error instanceof ActionRefused) {
    return Response.json({ error: 'refused', message: error.message }, { status: 409 })
  }
  throw error
}
