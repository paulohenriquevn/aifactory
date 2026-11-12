import type { CheckResult } from './evidence'
import { logEvidence } from './promotion'

/** One result of a factory check, with the commit it ran on. */
export type CheckRun = Pick<CheckResult, 'name' | 'command' | 'passed' | 'output'> & { sha: string }

/** A check that failed on a commit of the task and passed on the next commit it ran on. */
export type RepairedCheck = {
  name: string
  command: string
  /** The line of the failing output that says why. */
  error: string
  failedSha: string
  passedSha: string
}

/** A repaired check with the files added between its failing commit and its passing one. */
export type RequiredByCheck = RepairedCheck & { files: string[] }

const MAX_LINE = 300

/**
 * The line of a failed check's output that says why it failed: what a test runner or a compiler fails
 * with, else the first line that says `error`, else the last line.
 */
export function errorLine(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const line =
    logEvidence(output)[0] ??
    lines.find((l) => /\berror\b/i.test(l)) ??
    lines.at(-1) ??
    '(no output)'
  return line.slice(0, MAX_LINE)
}

/**
 * The checks that failed on an earlier commit of the change and pass on the commit under review, each
 * with the commit it failed on and the first later commit it passed on. `commits` is the change, newest
 * first, as `git rev-list` prints it: the first is the commit under review, and a result on any other
 * commit says nothing. A commit is read by its last result, as the gate reads it. A check that failed
 * more than once is read at its last repair.
 */
export function repairedChecks(runs: CheckRun[], commits: string[]): RepairedCheck[] {
  const head = commits[0]
  const oldestFirst = [...commits].reverse()
  const repaired: RepairedCheck[] = []
  for (const name of new Set(runs.map((run) => run.name))) {
    const lastOn = new Map<string, CheckRun>()
    for (const run of runs) if (run.name === name) lastOn.set(run.sha, run)
    const history = oldestFirst.flatMap((sha) => lastOn.get(sha) ?? [])
    const last = history.at(-1)
    if (!last?.passed || last.sha !== head) continue
    let fixedAt = -1
    history.forEach((run, i) => {
      if (run.passed && history[i - 1]?.passed === false) fixedAt = i
    })
    if (fixedAt === -1) continue
    const failed = history[fixedAt - 1]
    repaired.push({
      name,
      command: failed.command,
      error: errorLine(failed.output),
      failedSha: failed.sha,
      passedSha: history[fixedAt].sha,
    })
  }
  return repaired
}

/** The files outside the plan that no repaired check accounts for. */
export function withoutRequired(unplanned: string[], required: { files: string[] }[]): string[] {
  const added = new Set(required.flatMap((check) => check.files))
  return unplanned.filter((file) => !added.has(file))
}
