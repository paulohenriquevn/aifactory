import { tool } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../db'
import { KnowledgeReader } from '../../knowledge/reader'

const reader = () => new KnowledgeReader(getDb())

export const knowledgeSearchTool = tool('knowledge_search')
  .describe(
    "Find text in the owner's knowledge base: the rules under knowledge/ and the factory's notes under memory/. Gives each line that has every word, with its file. Name a repository (owner/name) to leave out the other projects.",
  )
  .input(
    z.object({
      query: z.string().min(1).max(200),
      repository: z.string().max(200).optional().describe('owner/name'),
    }),
  )
  .execute(async ({ query, repository }) => reader().search(query, repository))
  .build()

export const knowledgeReadTool = tool('knowledge_read')
  .describe(
    "Read one file of the owner's knowledge base, such as MEMORY.md, knowledge/global/<file>.md or memory/projects/<owner>/<repo>/INDEX.md.",
  )
  .input(z.object({ path: z.string().min(1).max(400) }))
  .execute(async ({ path }) => reader().read(path))
  .build()

/** The tools every assistant of the panel has, whatever else it does. */
export const KNOWLEDGE_TOOLS = {
  knowledge_search: knowledgeSearchTool,
  knowledge_read: knowledgeReadTool,
}
