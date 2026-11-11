import type { SandboxBackend } from '@theokit/agents/sandbox'

import { unplannedFiles, type ChangePlan } from './change-plan'
import { diffGuards, parseNameStatus, testScriptOf } from './guards'
import type { Finding } from './review'
import { must } from './run-support'
import { TEST_PATHSPECS } from './test-weakening'

export type DiffFacts = { guards: Finding[]; unplanned: string[] }

/**
 * What the change on HEAD says about itself, without a model: facts an agent could bend, and the files it
 * changed that the plan does not name. The change is measured from the merge base of `baseSha` and HEAD,
 * which is what the reviewer reads (`git diff baseSha...HEAD`) and what GitHub shows on the pull request.
 * On a first run that is `baseSha` itself. On a task sent back, `baseSha` is the integration branch as it
 * is now and HEAD is the branch cut from it earlier, and what the integration branch changed since then is
 * not the agent's (paulohenriquevn/aifactory#38).
 */
export async function diffFacts(
  backend: SandboxBackend,
  repoDir: string,
  input: {
    baseSha: string
    plan: ChangePlan | undefined
    issue: { labels: string[]; title: string; body: string }
  },
): Promise<DiffFacts> {
  const git = `git -C ${repoDir}`
  const base = (await must(backend, `${git} merge-base ${input.baseSha} HEAD`)).stdout.trim()
  const changes = parseNameStatus(
    (await must(backend, `${git} diff --name-status ${base} HEAD`)).stdout,
  )
  const showScript = async (rev: string) => {
    const shown = await backend.execute(`${git} show ${rev}:package.json`)
    return shown.exitCode === 0 ? testScriptOf(shown.stdout) : undefined
  }
  // Fixed pathspecs only: no path the agent wrote reaches the shell.
  const tests = await must(
    backend,
    `${git} diff -U0 --no-color --no-renames ${base} HEAD -- ${TEST_PATHSPECS.join(' ')}`,
  )
  const guards = diffGuards({
    changes,
    baseTestScript: await showScript(base),
    headTestScript: await showScript('HEAD'),
    tests: { patch: tests.stdout, issue: input.issue },
  })
  const paths = changes.map((change) => change.path)
  return { guards, unplanned: input.plan ? unplannedFiles(paths, input.plan) : [] }
}
