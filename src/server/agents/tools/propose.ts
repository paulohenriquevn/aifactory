import { tool } from 'theokit/server/define'
import { z } from 'zod'

/**
 * How the assistant hands its answer to the page. The page reads the arguments of this call, so what
 * the model writes here is exactly what the owner is shown and can accept, and a model that only
 * chats leaves the owner with nothing to accept.
 */
export const proposeTool = tool('propose')
  .describe(
    'Show the owner your suggestion. Call this exactly once, with the final text. It does not change anything: the owner decides whether to use it.',
  )
  .input(
    z.object({
      title: z.string().max(200).optional().describe('A short title, only when the field has one'),
      text: z.string().max(10_000).describe('The suggested text for the field, ready to use'),
      domains: z
        .array(z.string().max(253))
        .max(20)
        .optional()
        .describe('Extra internet domains the project needs, only when setting a project up'),
      notes: z
        .string()
        .max(1_000)
        .describe('One or two plain sentences: what you did and anything you had to guess'),
    }),
  )
  .execute(async () => 'Shown to the owner. Now say, in one short sentence, what you suggest.')
  .build()
