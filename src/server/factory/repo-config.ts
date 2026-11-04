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
  harness?: string
  reviewer?: string
  releaseMode?: ReleaseMode
}

export const NO_CONFIG: RepoConfig = { egress: [] }

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
