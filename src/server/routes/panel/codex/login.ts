import { route } from 'theokit/server/define'

import type { CodexConnection } from '../../../../shared/panel'
import { codexAccount } from '../../../factory/codex-auth'
import { cancelCodexLogin, codexLoginState, startCodexLogin } from '../../../factory/codex-login'
import { ownerOnly } from '../../../panel/policy'

const connection = (): CodexConnection => ({ account: codexAccount(), login: codexLoginState() })

/** Who the factory's Codex login belongs to, and where a change of account is. */
export const GET = route()
  .policy(ownerOnly)
  .handler(async () => connection())
  .build()

/** Starts signing in to another account and answers with the code to type and the address to open. */
export const POST = route()
  .policy(ownerOnly)
  .handler(async () => {
    await startCodexLogin()
    return connection()
  })
  .build()

/** Gives the sign-in up. */
export const DELETE = route()
  .policy(ownerOnly)
  .handler(async () => {
    cancelCodexLogin()
    return connection()
  })
  .build()
