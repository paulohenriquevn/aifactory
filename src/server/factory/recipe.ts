import { z } from 'zod'

import type { RecipeWhy } from '../../shared/doctor-say'
import type { FetchLike } from '../github/app'

import type { CheckSpec } from './evidence'
import { DOMAIN, type RepoConfig } from './repo-config'

/**
 * What a project says it needs to be built and checked, in `.factory/setup.json` on its default branch:
 * the install command, the checks, and the domains its tools reach. The factory reads it from GitHub
 * before any sandbox exists, never from the agent's branch, so an agent cannot widen its own way out by
 * editing the file. Its domains reach the firewall only once the owner approved them in the panel.
 */
export const RECIPE_PATH = '.factory/setup.json'

export type Recipe = { install?: string; checks?: CheckSpec[]; egress: string[] }

const schema = z
  .object({
    install: z.string().trim().min(1).max(600).optional(),
    checks: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(40),
          command: z.string().trim().min(1).max(600),
        }),
      )
      .min(1)
      .max(8)
      .optional(),
    egress: z
      .array(z.string().trim().toLowerCase().regex(DOMAIN, 'is not a hostname'))
      .max(20)
      .default([]),
  })
  .strict()

/** The recipe of a project could not be used. The run stops and says why, so the file gets fixed. */
export class RecipeError extends Error {
  /** The reason as parts, for a reader that says it in another language. */
  readonly why: RecipeWhy

  constructor(repo: string, reason: string, why: Omit<RecipeWhy, 'repo' | 'path'>) {
    super(`${repo}: ${RECIPE_PATH} on the default branch cannot be used: ${reason}`)
    this.name = 'RecipeError'
    this.why = { ...why, repo, path: RECIPE_PATH }
  }
}

/** Where the parser says the text breaks, when it says: `position 1`, and `(line 1 column 2)` on newer Node. */
function jsonPosition(detail: string): Partial<RecipeWhy> {
  const position = /position (\d+)/.exec(detail)?.[1]
  const place = /line (\d+) column (\d+)/.exec(detail)
  return {
    ...(position ? { position } : {}),
    ...(place ? { line: place[1], column: place[2] } : {}),
  }
}

/** The rule a Zod issue says was broken, with the numbers and names the sentence needs. */
function ruleOf(issue: z.core.$ZodIssue): Partial<RecipeWhy> {
  switch (issue.code) {
    case 'invalid_type':
      return { rule: 'type', expected: issue.expected }
    case 'too_small':
      return { rule: 'too_small', limit: String(issue.minimum), origin: issue.origin }
    case 'too_big':
      return { rule: 'too_big', limit: String(issue.maximum), origin: issue.origin }
    case 'unrecognized_keys':
      return { rule: 'unknown_keys', keys: issue.keys.join(', ') }
    case 'invalid_format':
      return { rule: 'hostname' }
    default:
      return {}
  }
}

export function parseRecipe(repo: string, text: string): Recipe {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    const detail = (error as Error).message
    throw new RecipeError(repo, `it is not JSON (${detail})`, {
      kind: 'not_json',
      detail,
      ...jsonPosition(detail),
    })
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue.path.join('.')
    throw new RecipeError(repo, `${at || 'the file'} ${issue.message}`, {
      kind: 'invalid',
      detail: at ? `${at} ${issue.message}` : issue.message,
      at,
      ...ruleOf(issue),
    })
  }
  return parsed.data
}

/** The recipe on the default branch, or nothing when the project has none. */
export async function readRecipe(
  repo: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<Recipe | undefined> {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/contents/${RECIPE_PATH}`, {
    headers: {
      accept: 'application/vnd.github.raw+json',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${token}`,
    },
  })
  if (response.status === 404) return undefined
  if (response.status !== 200) {
    throw new RecipeError(repo, `GitHub answered ${response.status} reading it`, {
      kind: 'status',
      detail: String(response.status),
    })
  }
  return parseRecipe(repo, await response.text())
}

/** The recipe's domains the owner has not approved yet, and that the panel does not already allow. */
export function pendingEgress(config: RepoConfig, recipe: Recipe | undefined): string[] {
  const allowed = new Set([...config.egress, ...(config.approvedRecipeEgress ?? [])])
  return (recipe?.egress ?? []).filter((domain) => !allowed.has(domain))
}

/**
 * The settings a run uses: what the owner set in the panel wins, then the recipe, then the factory's
 * default (which is what an absent field means). The install command runs as the first check.
 */
export function withRecipe(config: RepoConfig, recipe: Recipe | undefined): RepoConfig {
  if (!recipe) return config
  const install = recipe.install ? [{ name: 'install', command: recipe.install }] : []
  const recipeChecks =
    recipe.checks || recipe.install ? [...install, ...(recipe.checks ?? [])] : undefined
  const approved = new Set(config.approvedRecipeEgress ?? [])
  const egress = [
    ...config.egress,
    ...recipe.egress.filter((d) => approved.has(d) && !config.egress.includes(d)),
  ]
  return { ...config, checks: config.checks ?? recipeChecks, egress }
}
