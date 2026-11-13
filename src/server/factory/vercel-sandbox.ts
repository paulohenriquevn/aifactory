import { SandboxBackend } from '@theokit/agents/sandbox'
import { Sandbox, Snapshot, type NetworkPolicy } from '@vercel/sandbox'

import type { IsolatedSandbox, IsolatedSandboxProvider, SandboxSpec } from './sandbox'
import { assertIsolated } from './sandbox'

/** The exit code the TheoKit backends report for a command that hit its timeout. */
const TIMED_OUT = 124

/**
 * A `SandboxBackend` over a Vercel Sandbox microVM. The contract has no network policy and no
 * lifecycle, so both live beside it (usetheokit/theokit#1130). `execute` runs the command through `sh -c`
 * and returns the real exit code (the SDK's own backends coarsen it to 0, 124 and 1).
 */
class VercelBackend extends SandboxBackend {
  constructor(private readonly sandbox: Sandbox) {
    super()
  }

  async execute(command: string, opts: { timeoutMs?: number } = {}) {
    const timeoutMs = opts.timeoutMs ?? this.config.timeoutMs ?? 30_000
    const signal = AbortSignal.timeout(timeoutMs)
    try {
      const finished = await this.sandbox.runCommand({ cmd: 'sh', args: ['-c', command], signal })
      return {
        stdout: await finished.stdout(),
        stderr: await finished.stderr(),
        exitCode: finished.exitCode,
        timedOut: false,
      }
    } catch (error) {
      if (signal.aborted) {
        return {
          stdout: '',
          stderr: `timed out after ${timeoutMs} ms`,
          exitCode: TIMED_OUT,
          timedOut: true,
        }
      }
      throw error
    }
  }

  async uploadFile(path: string, content: string | Buffer) {
    await this.sandbox.writeFiles([
      { path, content: typeof content === 'string' ? Buffer.from(content) : content },
    ])
  }
}

/**
 * The firewall policy for a spec. A rule with headers attaches them to every request to that
 * domain outside the sandbox (credential brokering), so the secret never exists inside it. There
 * is no `*` entry: anything not listed, DNS included, is unreachable.
 */
export function networkPolicyFor(spec: SandboxSpec): NetworkPolicy {
  const allow: Record<string, { transform: { headers: Record<string, string> }[] }[]> = {}
  for (const { domain, headers } of spec.egress) {
    allow[domain] = headers ? [{ transform: [{ headers }] }] : []
  }
  return { allow }
}

/**
 * An access token with its team and project outlives the OIDC token, which `vercel env pull`
 * issues for 12 hours. Returns nothing unless all three variables are set.
 */
export function vercelCredentials(env: NodeJS.ProcessEnv = process.env) {
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = env
  return token && teamId && projectId ? { token, teamId, projectId } : undefined
}

/** Vercel keeps a snapshot for at least a day; this is how long an unanswered question waits. */
export const SNAPSHOT_TTL_MS = 7 * 24 * 3_600_000

const wrap = (sandbox: Sandbox, spec: SandboxSpec): IsolatedSandbox => ({
  backend: new VercelBackend(sandbox),
  stop: async () => void (await sandbox.stop()),
  snapshot: async () => (await sandbox.snapshot({ expiration: SNAPSHOT_TTL_MS })).snapshotId,
  updateEgress: async (egress) => {
    const next = { ...spec, egress }
    assertIsolated(next)
    await sandbox.updateNetworkPolicy(networkPolicyFor(next))
  },
})

/** Needs `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`, or else `VERCEL_OIDC_TOKEN`. */
export function vercelSandboxProvider(): IsolatedSandboxProvider {
  return {
    name: 'vercel-sandbox',
    async create(spec): Promise<IsolatedSandbox> {
      return wrap(
        await Sandbox.create({
          ...vercelCredentials(),
          // A persistent sandbox (the SDK default) snapshots its disk, about 1 GB, every time it
          // stops. Twenty runs filled the Hobby plan's snapshot storage and every create then
          // failed with 402. A run is disposable; a run that waits for an answer takes an explicit
          // snapshot instead (`snapshot` above).
          persistent: false,
          timeout: spec.timeoutMs,
          networkPolicy: networkPolicyFor(spec),
        }),
        spec,
      )
    },
    async restore(snapshotId, spec): Promise<IsolatedSandbox> {
      return wrap(
        await Sandbox.create({
          ...vercelCredentials(),
          persistent: false,
          timeout: spec.timeoutMs,
          networkPolicy: networkPolicyFor(spec),
          source: { type: 'snapshot', snapshotId },
        }),
        spec,
      )
    },
    async listSnapshots() {
      const all = await (await Snapshot.list({ ...vercelCredentials() })).toArray()
      return all
        .filter((s) => s.status !== 'deleted')
        .map((s) => ({ id: s.id, createdAt: new Date(s.createdAt), sizeBytes: s.sizeBytes }))
    },
    async deleteSnapshot(snapshotId) {
      await (await Snapshot.get({ snapshotId, ...vercelCredentials() })).delete()
    },
  }
}
