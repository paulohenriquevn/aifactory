import { getDb } from '../db'
import { githubAppFromEnv } from '../factory/deps'
import { createGithubApi } from '../github/pulls'

import { knowledgeRoot } from './source'
import type { KnowledgeDeps } from './sync'

/** What the sync and the panel need, read when they run, like the factory's other dependencies. */
export function knowledgeDeps(env: NodeJS.ProcessEnv = process.env): KnowledgeDeps {
  const slug = env.GITHUB_APP_SLUG
  if (!slug) throw new Error('GITHUB_APP_SLUG is not set')
  return {
    db: getDb(),
    github: githubAppFromEnv(env),
    api: createGithubApi(),
    root: knowledgeRoot(env),
    author: { name: `${slug}[bot]`, email: `${slug}[bot]@users.noreply.github.com` },
  }
}
