import { sql } from 'drizzle-orm'

import type { Database } from '../db'
import { repository } from '../db/schema'
import { pendingEgress, RecipeError, type Recipe } from '../factory/recipe'
import { loadRepoConfig } from '../factory/repo-config'
import type { GithubApp } from '../github/app'
import type { RecipeView } from '../../shared/panel'

import { ActionRefused } from './actions'

export type RecipeDeps = {
  db: Database
  github: Pick<GithubApp, 'installationToken'>
  readRecipe: (repo: string, token: string) => Promise<Recipe | undefined>
}

async function savedName(db: Database, fullName: string): Promise<string> {
  const [row] = await db
    .select({ fullName: repository.fullName })
    .from(repository)
    .where(sql`lower(${repository.fullName}) = lower(${fullName})`)
  if (!row)
    throw new ActionRefused(`${fullName} is not a repository the factory knows: enable it first`)
  return row.fullName
}

/**
 * The recipe on the repository's default branch and what of it the owner still has to approve. A recipe
 * that cannot be used is shown with the reason, which is the same one a run would fail with.
 */
export async function repositoryRecipe(deps: RecipeDeps, fullName: string): Promise<RecipeView> {
  const name = await savedName(deps.db, fullName)
  const config = await loadRepoConfig(deps.db, name)
  const approved = config.approvedRecipeEgress ?? []
  const { token } = await deps.github.installationToken(name)
  try {
    const recipe = await deps.readRecipe(name, token)
    return {
      fullName: name,
      recipe: recipe ?? null,
      pending: pendingEgress(config, recipe),
      approved,
      problem: null,
    }
  } catch (error) {
    if (!(error instanceof RecipeError)) throw error
    return { fullName: name, recipe: null, pending: [], approved, problem: error.message }
  }
}

/**
 * Approves domains the recipe asks for, so the next run's sandbox reaches them. Only a domain the recipe
 * on the default branch asks for right now may be approved: the page could be old, and this is what
 * widens the sandbox's way out.
 */
export async function approveRecipeEgress(
  deps: RecipeDeps,
  fullName: string,
  domains: string[],
): Promise<RecipeView> {
  const current = await repositoryRecipe(deps, fullName)
  if (current.problem) throw new ActionRefused(current.problem)
  const asked = new Set(current.recipe?.egress ?? [])
  const wanted = [...new Set(domains.map((d) => d.trim().toLowerCase()))]
  const unknown = wanted.filter((d) => !asked.has(d))
  if (unknown.length > 0) {
    throw new ActionRefused(
      `the recipe of ${current.fullName} does not ask for ${unknown.join(', ')}, so it cannot be approved`,
    )
  }
  const approved = [...new Set([...current.approved, ...wanted])]
  await deps.db
    .update(repository)
    .set({ approvedRecipeEgress: approved, updatedAt: new Date() })
    .where(sql`lower(${repository.fullName}) = lower(${current.fullName})`)
  return repositoryRecipe(deps, current.fullName)
}
