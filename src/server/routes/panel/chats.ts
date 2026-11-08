import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../db'
import { refusal } from '../../panel/deps'
import { createChat, listChats } from '../../panel/chats'
import { ownerOnly } from '../../panel/policy'

export const GET = route()
  .policy(ownerOnly)
  .handler(async () => ({ chats: await listChats(getDb()) }))
  .build()

export const POST = route()
  .policy(ownerOnly)
  .body(z.object({ model: z.enum(['openrouter', 'codex']).optional() }))
  .handler(async ({ body }) => {
    try {
      return await createChat(getDb(), body.model)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
