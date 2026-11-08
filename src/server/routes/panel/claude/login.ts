import { route } from 'theokit/server/define'

import {
  cancelClaudeLogin,
  claudeLoginState,
  startClaudeLogin,
} from '../../../factory/claude-login'
import { ownerOnly } from '../../../panel/policy'

/** Where the change of Claude Code account is: nothing started, waiting for the code, or how it ended. */
export const GET = route()
  .policy(ownerOnly)
  .handler(async () => claudeLoginState())
  .build()

/** Starts signing in to another account and answers with the link to open. */
export const POST = route()
  .policy(ownerOnly)
  .handler(async () => startClaudeLogin())
  .build()

/** Gives the sign-in up. */
export const DELETE = route()
  .policy(ownerOnly)
  .handler(async () => cancelClaudeLogin())
  .build()
