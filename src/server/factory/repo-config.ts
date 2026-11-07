import { sql } from 'drizzle-orm'

import type { Database } from '../db'
import { repository } from '../db/schema'

import type { CheckSpec } from './evidence'
import type { ReleaseMode } from './deliver'

/** What the owner set for one repository. Every field is optional: absent means the factory's default. */
export type RepoConfig = {
  checks?: CheckSpec[]
  /** Domains the sandbox may reach besides GitHub, the agent and the npm registry. */
  egress: string[]
  /** Domains of the project's recipe (`.factory/setup.json`) the owner approved in the panel. */
  approvedRecipeEgress?: string[]
  /** The branch work starts from and pull requests target; absent means the default branch. */
  baseBranch?: string
  /** The branch a release lands on; absent means the repository's default branch. */
  releaseBranch?: string
  /** False means the agent never asks, it decides and says what it assumed. Absent means it may ask. */
  askQuestions?: boolean
  harness?: string
  reviewer?: string
  releaseMode?: ReleaseMode
}

export const NO_CONFIG: RepoConfig = { egress: [] }

/**
 * A branch name the factory will pass to git: no leading dash (it would read as a flag), no `..`, no
 * empty path part, and not ending in `/` or `.lock`.
 */
export function validBranch(name: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(name) &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.endsWith('/') &&
    !name.endsWith('.lock')
  )
}

/** A hostname the firewall can take: letters, digits, hyphens and dots, with at least one dot. */
export const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** The owner's settings for a repository, matched without regard to case as GitHub does. */
export async function loadRepoConfig(db: Database, fullName: string): Promise<RepoConfig> {
  const [row] = await db
    .select()
    .from(repository)
    .where(sql`lower(${repository.fullName}) = lower(${fullName})`)
  if (!row) return NO_CONFIG
  return {
    checks: row.checks && row.checks.length > 0 ? row.checks : undefined,
    egress: row.egress,
    approvedRecipeEgress: row.approvedRecipeEgress,
    baseBranch: row.baseBranch ?? undefined,
    releaseBranch: row.releaseBranch ?? undefined,
    askQuestions: row.askQuestions,
    harness: row.harness ?? undefined,
    reviewer: row.reviewer ?? undefined,
    releaseMode: row.releaseMode ?? undefined,
  }
}

/**
 * The labels the agent choice reads. An explicit `harness:` or `reviewer:` label on the issue wins, so
 * the repository's own choice is added only where the issue says nothing.
 */
export function labelsWithRepoChoice(labels: string[], config: RepoConfig): string[] {
  const has = (kind: string) => labels.some((l) => l.toLowerCase().startsWith(`${kind}:`))
  return [
    ...labels,
    ...(config.harness && !has('harness') ? [`harness:${config.harness}`] : []),
    ...(config.reviewer && !has('reviewer') ? [`reviewer:${config.reviewer}`] : []),
  ]
}
