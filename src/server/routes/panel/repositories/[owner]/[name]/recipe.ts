import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../../../../db'
import { readRecipe } from '../../../../../factory/recipe'
import { githubAppFromEnv } from '../../../../../factory/deps'
import { refusal } from '../../../../../panel/deps'
import { ownerOnly } from '../../../../../panel/policy'
import { approveRecipeEgress, repositoryRecipe, type RecipeDeps } from '../../../../../panel/recipe'

const params = z.object({ owner: z.string().max(100), name: z.string().max(100) })

const deps = (): RecipeDeps => ({
  db: getDb(),
  github: githubAppFromEnv(),
  readRecipe: (repo, token) => readRecipe(repo, token),
})

/** The recipe of a repository and what of it waits for the owner. */
export const GET = route()
  .policy(ownerOnly)
  .params(params)
  .handler(async ({ params: p }) => {
    try {
      return await repositoryRecipe(deps(), `${p.owner}/${p.name}`)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()

/** Approves domains the recipe asks for. */
export const POST = route()
  .policy(ownerOnly)
  .params(params)
  .body(z.object({ approve: z.array(z.string().max(253)).min(1).max(20) }))
  .handler(async ({ params: p, body }) => {
    try {
      return await approveRecipeEgress(deps(), `${p.owner}/${p.name}`, body.approve)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
