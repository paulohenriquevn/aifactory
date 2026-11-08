import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../../db'
import { refusal } from '../../../panel/deps'
import { deleteChat, getChat, updateChat } from '../../../panel/chats'
import { ownerOnly } from '../../../panel/policy'

const params = z.object({ chatId: z.string().uuid() })

export const GET = route()
  .policy(ownerOnly)
  .params(params)
  .handler(async ({ params: p }) => {
    const found = await getChat(getDb(), p.chatId)
    return found ?? Response.json({ error: 'not_found' }, { status: 404 })
  })
  .build()

export const PUT = route()
  .policy(ownerOnly)
  .params(params)
  .body(
    z.object({
      title: z.string().max(200).optional(),
      pinned: z.boolean().optional(),
      model: z.enum(['openrouter', 'codex']).optional(),
    }),
  )
  .handler(async ({ params: p, body }) => {
    try {
      return await updateChat(getDb(), p.chatId, body)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()

export const DELETE = route()
  .policy(ownerOnly)
  .params(params)
  .handler(async ({ params: p }) =>
    (await deleteChat(getDb(), p.chatId))
      ? { removed: true }
      : Response.json({ error: 'not_found' }, { status: 404 }),
  )
  .build()
