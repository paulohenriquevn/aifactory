import type { SandboxBackend } from '@theokit/agents/sandbox'

import { unplannedFiles, type ChangePlan } from './change-plan'
import { changesetPackages, isChangesetFile } from './changesets'
import { diffGuards, parseNameStatus, testScriptOf } from './guards'
import type { Finding } from './review'
import {
  repairedChecks,
  withoutRequired,
  type CheckRun,
  type RequiredByCheck,
} from './required-files'
import { must } from './run-support'
import { TEST_PATHSPECS } from './test-weakening'

export type DiffFacts = {
  guards: Finding[]
  /** The changed files the plan does not name and no repaired check accounts for. */
  unplanned: string[]
  /** The factory checks that failed on an earlier commit of the change and pass on HEAD. */
  required: RequiredByCheck[]
}

/**
 * What the change on HEAD says about itself, without a model: facts an agent could bend, and the files it
 * changed that the plan does not name. The change is measured from the merge base of `baseSha` and HEAD,
 * which is what the reviewer reads (`git diff baseSha...HEAD`) and what GitHub shows on the pull request.
 * On a first run that is `baseSha` itself. On a task sent back, `baseSha` is the integration branch as it
 * is now and HEAD is the branch cut from it earlier, and what the integration branch changed since then is
 * not the agent's (paulohenriquevn/aifactory#38).
 *
 * `checkRuns` is every result of the factory's checks on this task. A file added between the commit a check
 * failed on and the commit it then passed on is what the check asked for, so it is not listed as outside
 * the plan (paulohenriquevn/aifactory#53), unless it is a changeset that names no package. The guards read the whole diff either way.
 */
export async function diffFacts(
  backend: SandboxBackend,
  repoDir: string,
  input: {
    baseSha: string
    plan: ChangePlan | undefined
    issue: { labels: string[]; title: string; body: string }
    checkRuns?: CheckRun[]
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
  const required = await requiredByChecks(backend, git, base, input.checkRuns ?? [])
  const unplanned = input.plan ? unplannedFiles(paths, input.plan) : []
  return { guards, unplanned: withoutRequired(unplanned, required), required }
}

/** The repaired checks of the change on HEAD, each with the files added while it was repaired. */
async function requiredByChecks(
  backend: SandboxBackend,
  git: string,
  base: string,
  runs: CheckRun[],
): Promise<RequiredByCheck[]> {
  if (runs.every((run) => run.passed)) return []
  const commits = (await must(backend, `${git} rev-list ${base}..HEAD`)).stdout
    .split('\n')
    .filter(Boolean)
  const required: RequiredByCheck[] = []
  // Both commits are among those `rev-list` printed, so no stored text reaches the shell.
  for (const check of repairedChecks(runs, commits)) {
    const added = await must(
      backend,
      `${git} diff --name-only --diff-filter=A --no-renames ${check.failedSha} ${check.passedSha}`,
    )
    const files = added.stdout.split('\n').filter(Boolean)
    required.push({ ...check, files: await calledFor(backend, git, check.passedSha, files) })
  }
  return required
}

/** A changeset path with nothing a shell reads as more than a name. */
const PLAIN_CHANGESET = /^\.changeset\/[\w.-]+\.md$/

/**
 * The added files a check can have asked for: all of them but a changeset that names no package. No check
 * asks for one of those (the factory's own fails on it), and it breaks the release of the repository
 * (paulohenriquevn/aifactory#67), so it stays among the files outside the plan and the reviewer is not
 * told it is legitimate. A changeset is read at the commit the check passed on, and only when its path is
 * plain: one with any other character is not handed to a shell, and is not taken as asked for either.
 */
async function calledFor(
  backend: SandboxBackend,
  git: string,
  sha: string,
  files: string[],
): Promise<string[]> {
  const kept: string[] = []
  for (const file of files) {
    if (!isChangesetFile(file)) kept.push(file)
    else if (PLAIN_CHANGESET.test(file)) {
      const shown = await must(backend, `${git} show ${sha}:${file}`)
      if (changesetPackages(shown.stdout).length > 0) kept.push(file)
    }
  }
  return kept
}
