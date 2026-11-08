import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../../../db'
import { refusal } from '../../../../panel/deps'
import { saveMessages } from '../../../../panel/chats'
import { ownerOnly } from '../../../../panel/policy'

const message = z.object({
  id: z.string().max(200),
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(z.record(z.string(), z.unknown())).max(200),
})

export const PUT = route()
  .policy(ownerOnly)
  .params(z.object({ chatId: z.string().uuid() }))
  .body(z.object({ messages: z.array(message).max(400) }))
  .handler(async ({ params, body }) => {
    try {
      return await saveMessages(getDb(), params.chatId, body.messages)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
