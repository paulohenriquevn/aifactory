import { and, sql } from 'drizzle-orm'

import type { ChecksProof } from '../../shared/panel'
import type { Database } from '../db'
import { repository } from '../db/schema'
import { DEFAULT_CHECK_MS } from '../factory/agent-time'
import type { CheckSpec } from '../factory/evidence'
import {
  passedChecks,
  proofView,
  proveChecks,
  type Proof,
  type ProveDeps,
} from '../factory/prove-checks'
import { loadRepoConfig } from '../factory/repo-config'

import { ActionRefused } from './actions'
import { savedName } from './recipe'
import { patchProblem } from './work'

/** What the `prove-checks` job is given: the repository and the proof it is for, named by its time. */
export type ProofJob = { repository: string; at: string }

export type StartProofDeps = {
  db: Database
  now?: () => Date
  /** Runs `work` in a transaction, with `prove-checks` queued through that transaction. */
  inTransaction: <T>(
    work: (tx: Database, enqueue: (job: ProofJob) => Promise<void>) => Promise<T>,
  ) => Promise<T>
}

export type RunProofDeps = ProveDeps & {
  db: Database
  /** Examines the repository again after its checks changed: the doctor, whose report names them. */
  diagnose?: (fullName: string) => Promise<unknown>
}

const named = (fullName: string) => sql`lower(${repository.fullName}) = lower(${fullName})`

/**
 * Asks for the proposed checks to be proven. The proposal is kept on the repository as a proof that is
 * `proving`, and the job that runs it is queued in the same transaction; nothing is saved as the
 * repository's checks until a check has passed. A proof asked for while another runs replaces it.
 */
export async function startProof(
  deps: StartProofDeps,
  fullName: string,
  checks: CheckSpec[],
): Promise<ChecksProof> {
  const name = await savedName(deps.db, fullName)
  if (checks.length === 0) throw new ActionRefused('propose at least one check to prove')
  const problem = patchProblem({ checks }, [])
  if (problem) throw new ActionRefused(problem)
  const proof: ChecksProof = {
    fullName: name,
    status: 'proving',
    at: (deps.now?.() ?? new Date()).toISOString(),
    checks: checks.map((check) => ({ name: check.name, command: check.command.trim() })),
    sha: null,
    limitMs: DEFAULT_CHECK_MS,
    results: [],
    saved: [],
    error: null,
  }
  return deps.inTransaction(async (tx, enqueue) => {
    await tx.update(repository).set({ checksProof: proof }).where(named(name))
    await enqueue({ repository: name, at: proof.at })
    return proof
  })
}

/** The last proof of a repository the factory knows, as it is shown; null when none was asked for. */
export async function readProof(
  db: Database,
  fullName: string,
  now: Date,
): Promise<ChecksProof | null> {
  const name = await savedName(db, fullName)
  const [row] = await db
    .select({ checksProof: repository.checksProof })
    .from(repository)
    .where(named(name))
  return proofView(row.checksProof, now)
}

/** The finished proof and what of it becomes the repository's checks: only what passed. */
function settled(proof: ChecksProof, found: Proof) {
  const passed = passedChecks(found.results)
  const done: ChecksProof = {
    ...proof,
    status: 'done',
    sha: found.sha,
    limitMs: found.limitMs,
    results: found.results,
    saved: passed.map((check) => check.name),
  }
  if (passed.length === 0) return { checksProof: done }
  return {
    checksProof: done,
    checks: passed.map(({ name, command }) => ({ name, command })),
    checksProven: passed,
    checksProvenSha: found.sha,
    updatedAt: new Date(),
  }
}

/**
 * Runs a proof that was asked for and keeps what it found. The checks that passed become the
 * repository's checks, with the commit they passed on; one that failed or was too slow is kept only in
 * the proof, with its output, and when none passed the repository's checks stay as they were. A proof
 * that could not run is recorded as failed with the reason, as a plan is: nobody retries it from a queue.
 * Whatever is written is written only while this proof is still the repository's last.
 */
export async function runProof(deps: RunProofDeps, job: ProofJob): Promise<void> {
  const { db } = deps
  const [row] = await db.select().from(repository).where(named(job.repository))
  const proof = row?.checksProof
  if (!proof || proof.status !== 'proving' || proof.at !== job.at) return

  let values: ReturnType<typeof settled>
  try {
    const config = await loadRepoConfig(db, row.fullName)
    values = settled(
      proof,
      await proveChecks(deps, { fullName: row.fullName, config }, proof.checks),
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    values = { checksProof: { ...proof, status: 'failed', error: reason.slice(0, 600) } }
  }
  const written = await db
    .update(repository)
    .set(values)
    .where(and(named(row.fullName), sql`${repository.checksProof}->>'at' = ${job.at}`))
    .returning({ id: repository.id })
  if (written.length > 0 && 'checks' in values) await deps.diagnose?.(row.fullName)
}
