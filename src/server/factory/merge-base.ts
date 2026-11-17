import type { SandboxBackend } from '@theokit/agents/sandbox'

import { must } from './run-support'

/** What merging the integration branch into the work branch left: a merge, nothing to merge, or a conflict. */
export type BaseMerge = { merged: true } | { upToDate: true } | { conflicts: string[] }

/**
 * Merges `baseSha` (the head of the integration branch the run cloned) into the branch checked out, the
 * factory's own git step: no agent runs it. `git` is the command prefix that carries the commit identity. A
 * conflict is aborted, so the branch stays as it was, and its files are named; any other refusal throws
 * what git said.
 */
export async function mergeIntegration(
  backend: SandboxBackend,
  git: string,
  baseSha: string,
): Promise<BaseMerge> {
  const before = (await must(backend, `${git} rev-parse HEAD`)).stdout.trim()
  const merged = await backend.execute(`${git} merge --no-edit ${baseSha}`)
  if (merged.exitCode !== 0) {
    const unmerged = await must(backend, `${git} diff --name-only --diff-filter=U`)
    const conflicts = unmerged.stdout.split('\n').filter((file) => file !== '')
    if (conflicts.length === 0) {
      const said = (merged.stderr || merged.stdout).trim().slice(-500)
      throw new Error(`git merge of ${baseSha} exited ${merged.exitCode}: ${said}`)
    }
    await must(backend, `${git} merge --abort`)
    return { conflicts }
  }
  const after = (await must(backend, `${git} rev-parse HEAD`)).stdout.trim()
  return after === before ? { upToDate: true } : { merged: true }
}
