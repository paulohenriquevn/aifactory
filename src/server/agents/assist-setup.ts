import { buildAssistant } from '../factory/assistant'
import { assistModel } from '../factory/models'
import { ownerOnly } from '../panel/policy'

import { SETUP_INSTRUCTIONS } from './prompts/assist'
import { proposeTool } from './tools/propose'
import { repoFileTool, repoTreeTool } from './tools/repo'

/** Only the owner, and only for an enabled repository (the tools check that again). */
export const policy = ownerOnly

/**
 * The assistant that sets a repository up. It is separate from `assist` because it is the only one allowed
 * to read a repository, and an agent that can read files will read them whether or not the task needs it.
 * What it may read is limited to the files that say how a project is built and tested
 * (`factory/repo-reader.ts`).
 */
export default buildAssistant(assistModel(), {
  system: SETUP_INSTRUCTIONS,
  tools: { propose: proposeTool, repo_files: repoTreeTool, repo_file: repoFileTool },
  asks: {},
  maxInput: 12_000,
})
