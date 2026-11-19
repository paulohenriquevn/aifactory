import type { ChecksProof, ProofKind, ProvenCheck, StoredProof } from '../../shared/panel'
import type { GithubApp } from '../github/app'
import type { GithubApi } from '../github/pulls'

import { DEFAULT_CHECK_MS, fitToSession } from './agent-time'
import { ensureBranches, integrationBranch } from './branches'
import { cloneRepository } from './clone'
import { prepareDeclaredPackageManager } from './package-manager'
import { githubEgress, renewGithubCredential } from './credential-renewal'
import { DEFAULT_CHECKS, runChecks, type CheckResult, type CheckSpec } from './evidence'
import { withRecipe, type Recipe } from './recipe'
import type { RepoConfig } from './repo-config'
import { must } from './run-support'
import { createIsolatedSandbox, type IsolatedSandboxProvider } from './sandbox'

/**
 * Proving checks: the checks proposed for a repository are run on the head of its integration branch, in
 * a sandbox, before any of them is saved. A wrong command is found here, with its output, and not by the
 * first task, which would fail for a reason that has nothing to do with its issue.
 */

export type ProveDeps = {
  github: Pick<GithubApp, 'installationToken'>
  /** Used to make sure the repository has its integration branch before it is cloned. */
  api: Pick<GithubApi, 'defaultBranch' | 'branchHead' | 'createBranch'>
  sandbox: IsolatedSandboxProvider
  /** Reads the project's `.factory/setup.json`, whose approved domains the sandbox reaches as in a run. */
  fetchRecipe?: (repo: string, token: string) => Promise<Recipe | undefined>
  /** How long one check may take; a run's own limit when absent. */
  checkMs?: number
  /** How long the sandbox may live; as long as a run's when absent. */
  sandboxMs?: number
}

/**
 * What a proof found: the commit the checks ran on, the limit each had, and how each did. `setup` is how
 * the checks run before them did, when some were: they are kept apart, since nothing of them is saved.
 */
export type Proof = { sha: string; limitMs: number; results: ProvenCheck[]; setup?: ProvenCheck[] }

export type ProveOptions = {
  /**
   * The checks to run before the proposed ones, read from the repository's configuration with its recipe
   * in it. Integration checks usually need the project installed, and the repository's checks are what
   * installs it in a run. How they do is reported and decides nothing.
   */
  setup?: (config: RepoConfig) => CheckSpec[]
}

/** What a repository's row says about its proven checks, and the saved checks that are not among them. */
export type ProvenState = {
  checksProven: ProvenCheck[]
  checksProvenSha: string | null
  unprovenChecks: string[]
}

/** The directory the repository is cloned into. */
const PROOF_INSTANCE = 'prove'
/** A proof's sandbox lives as long as a run's, which runs the same checks after an agent. */
export const PROOF_SANDBOX_MS = 90 * 60_000
/** A proof still `proving` after this has no sandbox left to finish in: its job died. */
export const PROOF_STALE_MS = PROOF_SANDBOX_MS + 10 * 60_000

/** A check cut at its limit did not fail: it is too slow for a run, which is another repair. */
export function provenStatus(result: CheckResult): ProvenCheck['status'] {
  if (result.timedOut) return 'too_slow'
  return result.passed ? 'passed' : 'failed'
}

/**
 * One result for each proposed check, in the order proposed. `runChecks` runs a failed check a second
 * time, and the last run is the one that counts, as it is for a task.
 */
export function provenResults(checks: CheckSpec[], results: CheckResult[]): ProvenCheck[] {
  const last = new Map<string, CheckResult>()
  for (const result of results) last.set(result.name, result)
  return checks.flatMap((check) => {
    const result = last.get(check.name)
    if (!result) return []
    const { name, command, exitCode, durationMs, output } = result
    return [{ name, command, status: provenStatus(result), exitCode, durationMs, output }]
  })
}

/** A proof or a `prove-checks` job stored before proofs had a kind is one of the repository's checks. */
export function kindOf(value: { kind?: ProofKind }): ProofKind {
  return value.kind ?? 'checks'
}

/** The checks a run of the repository makes before its changeset check: the owner's, the recipe's or the default. */
export function effectiveChecks(config: RepoConfig): CheckSpec[] {
  return config.checks ?? DEFAULT_CHECKS
}

/** The checks a proof may store: the ones that passed. */
export function passedChecks(results: ProvenCheck[]): ProvenCheck[] {
  return results.filter((result) => result.status === 'passed')
}

const sameCheck = (a: CheckSpec, b: CheckSpec) => a.name === b.name && a.command === b.command

/** The names of the saved checks no proof ran as they are now: same name, same command. */
export function unprovenChecks(checks: CheckSpec[] | null, proven: ProvenCheck[]): string[] {
  return (checks ?? [])
    .filter((check) => !proven.some((known) => sameCheck(known, check)))
    .map((check) => check.name)
}

/**
 * What stays proven when the owner saves `checks` by hand: a check left as it was keeps its proof, and one
 * that was typed or changed has none. The commit is kept only while it still speaks for some check.
 */
export function provenAfter(
  saved: { checksProven: ProvenCheck[]; checksProvenSha: string | null } | undefined,
  checks: CheckSpec[] | null,
): ProvenState {
  const kept = (saved?.checksProven ?? []).filter((known) =>
    (checks ?? []).some((check) => sameCheck(known, check)),
  )
  return {
    checksProven: kept,
    checksProvenSha: kept.length > 0 ? (saved?.checksProvenSha ?? null) : null,
    unprovenChecks: unprovenChecks(checks, kept),
  }
}

/**
 * The stored proof as it is shown: one left `proving` by a job that died is shown as failed, and one stored
 * before proofs had a kind is a proof of checks.
 */
export function proofView(stored: StoredProof | null, now: Date): ChecksProof | null {
  if (!stored) return null
  const proof: ChecksProof = { ...stored, kind: kindOf(stored) }
  if (proof.status !== 'proving') return proof
  if (now.getTime() - new Date(proof.at).getTime() <= PROOF_STALE_MS) return proof
  return {
    ...proof,
    status: 'failed',
    error: 'the proof never finished: the job that ran it stopped. Ask for it again.',
  }
}

/**
 * Runs the proposed checks on the head of the integration branch and says how each did. One sandbox for
 * all of them, in order, so an install the first one makes is there for the next, as in a run. The
 * sandbox reaches what a run's reaches except the agents: GitHub (the token is a firewall rule, never in
 * the sandbox, and renewed while the checks run), the registry, the repository's domains and the recipe's
 * approved ones. It is stopped whatever happens.
 */
export async function proveChecks(
  deps: ProveDeps,
  repository: { fullName: string; config: RepoConfig },
  checks: CheckSpec[],
  options: ProveOptions = {},
): Promise<Proof> {
  const { fullName } = repository
  const { token } = await deps.github.installationToken(fullName)
  const config = withRecipe(repository.config, await deps.fetchRecipe?.(fullName, token))
  const integration = integrationBranch(config)
  await ensureBranches(deps.api, fullName, token, { integration, release: config.releaseBranch })
  const limitMs = deps.checkMs ?? DEFAULT_CHECK_MS
  const egress = [
    githubEgress(token),
    { domain: 'registry.npmjs.org' },
    ...config.egress.map((domain) => ({ domain })),
  ]
  const started = await createIsolatedSandbox(deps.sandbox, {
    owner: { owner: 'prove-checks', repository: fullName },
    timeoutMs: fitToSession(
      { sandboxMs: deps.sandboxMs ?? PROOF_SANDBOX_MS },
      deps.sandbox.maxSessionMs,
    ).sandboxMs,
    cacheKey: fullName,
    egress,
  })
  let sandbox = started
  try {
    // The checks may outlast the hour a token does, and one of them may fetch from GitHub: renew it as a run does.
    sandbox = renewGithubCredential(started, egress, {
      mint: async () => (await deps.github.installationToken(fullName)).token,
      onToken: () => {},
    })
    const { repoDir } = await cloneRepository(sandbox.backend, {
      repoUrl: `https://github.com/${fullName}.git`,
      ref: integration,
      instanceId: PROOF_INSTANCE,
    })
    await prepareDeclaredPackageManager(sandbox.backend, repoDir)
    const sha = (await must(sandbox.backend, `git -C ${repoDir} rev-parse HEAD`)).stdout.trim()
    const run = async (list: CheckSpec[]) =>
      provenResults(list, await runChecks(sandbox.backend, repoDir, list, limitMs))
    const setup = options.setup ? await run(options.setup(config)) : undefined
    const results = await run(checks)
    return { sha, limitMs, results, ...(setup ? { setup } : {}) }
  } finally {
    await sandbox.stop()
  }
}
