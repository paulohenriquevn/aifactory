import { route } from 'theokit/server/define'
import { z } from 'zod'

import { submitClaudeCode } from '../../../../factory/claude-login'
import { ownerOnly } from '../../../../panel/policy'

/** The code the sign-in page showed. The answer says whether the account works now; it never carries the token. */
export const POST = route()
  .policy(ownerOnly)
  .body(z.object({ code: z.string().max(500) }))
  .handler(async ({ body }) => submitClaudeCode(body.code))
  .build()
