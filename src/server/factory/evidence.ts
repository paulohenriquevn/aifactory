import type { SandboxBackend } from '@theokit/agents/sandbox'

export type CheckSpec = { name: string; command: string }

export type CheckResult = {
  name: string
  command: string
  exitCode: number
  timedOut: boolean
  passed: boolean
  /** The tail of stdout and stderr, enough to see why it failed. */
  output: string
  durationMs: number
}

/** What the gate reads from a stored row. */
export type EvidenceRow = { name: string; sha: string; passed: boolean }

export type Verdict = { open: true } | { open: false; reasons: string[] }

const OUTPUT_TAIL = 4_000

/** The checks a task must pass when nothing says otherwise. */
export const DEFAULT_CHECKS: CheckSpec[] = [{ name: 'test', command: 'npm test' }]

/**
 * Runs each check in the repository, one after the other, and keeps every result whether it passed
 * or not. The factory runs the command and reads the exit code: nothing the agent said counts.
 */
export async function runChecks(
  backend: SandboxBackend,
  repoDir: string,
  checks: CheckSpec[],
  timeoutMs: number,
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const check of checks) {
    const first = await runCheck(backend, repoDir, check, timeoutMs)
    results.push(first)
    // A test that fails under load passes when run again, and failing the task for it costs an attempt the
    // agent cannot use: its change did not cause it. Both runs stay in the evidence, and the gate reads the
    // last. A check that ran out of time is not run again, since that would double the wait.
    if (!first.passed && !first.timedOut) {
      results.push(await runCheck(backend, repoDir, check, timeoutMs))
    }
  }
  return results
}

async function runCheck(
  backend: SandboxBackend,
  repoDir: string,
  check: CheckSpec,
  timeoutMs: number,
): Promise<CheckResult> {
  const started = Date.now()
  const run = await backend.execute(`cd ${repoDir} && ${check.command}`, { timeoutMs })
  return {
    name: check.name,
    command: check.command,
    exitCode: run.exitCode,
    timedOut: run.timedOut ?? false,
    passed: run.exitCode === 0 && !run.timedOut,
    output: `${run.stdout}${run.stderr}`.slice(-OUTPUT_TAIL),
    durationMs: Date.now() - started,
  }
}

/** The checks whose last run failed, one result each: what the builder has to fix. */
export function failingChecks(results: CheckResult[]): CheckResult[] {
  const last = new Map<string, CheckResult>()
  for (const result of results) last.set(result.name, result)
  return [...last.values()].filter((r) => !r.passed)
}

/**
 * Decides whether a pull request may open. It does only when every required check has a result for
 * the pushed commit and the latest of those passed. A result for any other SHA says nothing about
 * this one, and no required checks at all means nothing was verified.
 */
export function gate(input: {
  headSha: string
  required: string[]
  evidence: EvidenceRow[]
}): Verdict {
  if (input.required.length === 0) {
    return { open: false, reasons: ['no checks are required, so nothing was verified'] }
  }
  const reasons: string[] = []
  for (const name of input.required) {
    const latest = input.evidence.filter((e) => e.name === name && e.sha === input.headSha).at(-1)
    if (!latest) reasons.push(`no evidence for "${name}" at ${input.headSha.slice(0, 7)}`)
    else if (!latest.passed) reasons.push(`"${name}" failed at ${input.headSha.slice(0, 7)}`)
  }
  return reasons.length === 0 ? { open: true } : { open: false, reasons }
}
