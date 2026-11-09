import { getDb } from '../db'
import { githubAppFromEnv } from '../factory/deps'
import { botAuthor } from '../github/bot-author'
import { createGithubApi } from '../github/pulls'

import { knowledgeRoot } from './source'
import type { KnowledgeDeps } from './sync'

/** What the sync and the panel need, read when they run, like the factory's other dependencies. */
export function knowledgeDeps(env: NodeJS.ProcessEnv = process.env): KnowledgeDeps {
  const author = botAuthor(env)
  return {
    db: getDb(),
    github: githubAppFromEnv(env),
    api: createGithubApi(),
    root: knowledgeRoot(env),
    author,
  }
}
