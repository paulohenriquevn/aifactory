/** What the setup page shows about the knowledge base, and what saving it returns. */
export type KnowledgeStatus = {
  /** The repository the owner chose, owner/name; null when there is none. */
  repository: string | null
  /** The branch the owner chose for the rules; null means the default branch. */
  branch: string | null
  /** The branch the last pass read the rules from. */
  readBranch: string | null
  /** The branch the factory writes its notes to. */
  memoryBranch: string
  knowledgeSha: string | null
  memorySha: string | null
  /** Why the rules are not read yet (MEMORY.md missing or in another format); null when they are. */
  formatProblem: string | null
  syncedAt: string | null
  /** What the last pass could not do; the agents go on reading the last good commits. */
  error: string | null
  errorAt: string | null
  /** Notes kept from runs that the next pass writes to the memory branch. */
  pendingNotes: number
  writtenNotes: number
}

/** The repository and branch the owner sends; a null repository clears the choice. */
export type KnowledgeChoice = { repository: string | null; branch?: string | null }
