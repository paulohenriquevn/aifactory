import { tool } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../db'
import { githubAppFromEnv } from '../../factory/deps'
import { repoFile, repoTree } from '../../factory/repo-reader'

const deps = () => ({ db: getDb(), github: githubAppFromEnv() })

export const repoTreeTool = tool('repo_files')
  .describe(
    'List the names of the files in an enabled repository, to see what kind of project it is.',
  )
  .input(z.object({ repository: z.string().describe('owner/name') }))
  .execute(async ({ repository }) => (await repoTree(deps(), repository)).join('\n'))
  .build()

export const repoFileTool = tool('repo_file')
  .describe(
    'Read one file that says how a project is built or tested (package.json, pyproject.toml, requirements.txt, Makefile, README, a CI workflow). Source code is not readable.',
  )
  .input(z.object({ repository: z.string().describe('owner/name'), path: z.string() }))
  .execute(async ({ repository, path }) => repoFile(deps(), repository, path))
  .build()
