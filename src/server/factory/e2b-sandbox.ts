import { SandboxBackend } from '@theokit/agents/sandbox'
import {
  ALL_TRAFFIC,
  CommandExitError,
  Sandbox,
  SandboxNotRunningError,
  SandboxUnreachableError,
  TimeoutError,
  type SandboxNetworkOpts,
  type SandboxNetworkRule,
} from 'e2b'

import { lineSplitter } from './docker-sandbox'
import { E2B_TEMPLATE } from './e2b-template'
import type {
  ExecuteResult,
  IsolatedSandbox,
  IsolatedSandboxProvider,
  SandboxSpec,
  StreamingOptions,
} from './sandbox'
import { assertIsolated } from './sandbox'

/** The exit code the TheoKit backends report for a command that hit its timeout. */
const TIMED_OUT = 124
/** The user and directory the image is built for (ops/sandbox/Dockerfile). */
const USER = 'node'
const WORKDIR = '/work'
const DEFAULT_COMMAND_MS = 10 * 60_000

/**
 * The longest a sandbox may live on E2B's free plan. A run asks for more (`DEFAULT_TIMEOUTS.sandboxMs`), so
 * the provider says so and the run plans its agent passes against this instead. `E2B_MAX_SESSION_MS`
 * raises it on a plan that allows more (Pro allows 24 hours).
 */
export const E2B_FREE_SESSION_MS = 60 * 60_000

/**
 * E2B does not apply the `ENV` lines of the Dockerfile a template is built from, so the sandbox gets them
 * here. `NODE_EXTRA_CA_CERTS` makes Node trust the egress proxy that attaches the credentials: E2B adds its
 * certificate to the system store, which curl and git read and Node does not.
 */
export const SANDBOX_ENV: Record<string, string> = {
  HOME: `/home/${USER}`,
  CI: 'true',
  COREPACK_HOME: '/cache/corepack',
  NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
}

/**
 * The egress policy for a spec: only the listed domains, everything else denied, and the headers of a rule
 * attached by E2B's egress proxy outside the sandbox (credential brokering), so the secret never exists in
 * it. E2B also lets the sandbox reach its DNS server (8.8.8.8) whenever a domain is listed; a name resolves,
 * but a connection to anything unlisted is refused.
 */
export function networkFor(spec: SandboxSpec): SandboxNetworkOpts {
  const rules: Record<string, SandboxNetworkRule[]> = {}
  for (const { domain, headers } of spec.egress) {
    if (headers) rules[domain] = [{ transform: { headers } }]
  }
  return { allowOut: spec.egress.map((rule) => rule.domain), denyOut: [ALL_TRAFFIC], rules }
}

/**
 * A `SandboxBackend` over an E2B sandbox, here because the SDK ships none (usetheokit/theokit-sdk#985). The contract can state an egress policy (usetheokit/theokit#1130)
 * but not enforce one, attach credentials outside, renew them or snapshot a disk, so those live beside it. A command that fails comes back with its exit
 * code; E2B throws for it, and for a timeout, which becomes exit 124.
 */
export class E2BBackend extends SandboxBackend {
  constructor(private readonly sandbox: Pick<Sandbox, 'commands' | 'files'>) {
    super()
  }

  async execute(command: string, opts: { timeoutMs?: number } = {}) {
    return this.run(command, opts.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_COMMAND_MS)
  }

  async executeStreaming(command: string, opts: StreamingOptions): Promise<ExecuteResult> {
    const split = lineSplitter(opts.onStdoutLine)
    try {
      return await this.run(command, opts.timeoutMs ?? DEFAULT_COMMAND_MS, (chunk) =>
        split.push(chunk),
      )
    } finally {
      split.end()
    }
  }

  async uploadFile(path: string, content: string | Buffer) {
    const data = typeof content === 'string' ? content : new Uint8Array(content).buffer
    await this.sandbox.files.write(path, data, { user: USER })
  }

  private async run(
    command: string,
    timeoutMs: number,
    onStdout?: (chunk: string) => void,
  ): Promise<ExecuteResult> {
    try {
      const done = await this.sandbox.commands.run(command, {
        user: USER,
        cwd: WORKDIR,
        timeoutMs,
        ...(onStdout ? { onStdout } : {}),
      })
      return { stdout: done.stdout, stderr: done.stderr, exitCode: done.exitCode, timedOut: false }
    } catch (error) {
      if (error instanceof CommandExitError) {
        return {
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.exitCode,
          timedOut: false,
        }
      }
      // A sandbox that stopped or cannot be reached is not a slow command: it fails the run, loudly.
      const gone =
        error instanceof SandboxNotRunningError || error instanceof SandboxUnreachableError
      if (error instanceof TimeoutError && !gone) {
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
}

/**
 * Wraps a running sandbox. `gone` runs once, after the sandbox stops for good (stopped, or saved to a snapshot
 * and stopped), so a sandbox restored from a snapshot can free it: E2B refuses to delete a snapshot while a
 * sandbox started from it runs.
 */
const wrap = (
  sandbox: Sandbox,
  spec: SandboxSpec,
  gone: () => Promise<void> = async () => {},
): IsolatedSandbox => {
  let after: Promise<void> | undefined
  const end = async () => {
    await sandbox.kill()
    await (after ??= gone())
  }
  return {
    backend: new E2BBackend(sandbox),
    stop: end,
    snapshot: async () => {
      const { snapshotId } = await sandbox.createSnapshot()
      await end()
      return snapshotId
    },
    updateEgress: async (egress) => {
      const next = { ...spec, egress }
      assertIsolated(next)
      // Replaces every rule, so the update carries the whole policy, the deny included.
      await sandbox.updateNetwork(networkFor(next))
    },
  }
}

/** How long a sandbox may live on this account: the free plan's hour unless `E2B_MAX_SESSION_MS` says more. */
export function e2bMaxSessionMs(env: NodeJS.ProcessEnv = process.env): number {
  const set = Number(env.E2B_MAX_SESSION_MS)
  return Number.isFinite(set) && set > 0 ? set : E2B_FREE_SESSION_MS
}

/** Needs `E2B_API_KEY`, and the template built by scripts/build-e2b-template.mts. */
export function e2bSandboxProvider(env: NodeJS.ProcessEnv = process.env): IsolatedSandboxProvider {
  const maxSessionMs = e2bMaxSessionMs(env)
  const options = (spec: SandboxSpec) => ({
    apiKey: env.E2B_API_KEY,
    timeoutMs: Math.min(spec.timeoutMs, maxSessionMs),
    envs: SANDBOX_ENV,
    network: networkFor(spec),
  })
  const remove = (snapshotId: string) =>
    Sandbox.deleteSnapshot(snapshotId, { apiKey: env.E2B_API_KEY }).then(() => {})
  // Snapshots a sandbox of this process was restored from. Deleting one now would fail; the sandbox deletes
  // it when it stops, which is what a caller asking for the deletion wants.
  const restoredFrom = new Set<string>()
  return {
    name: 'e2b',
    maxSessionMs,
    async create(spec) {
      return wrap(await Sandbox.create(E2B_TEMPLATE, options(spec)), spec)
    },
    async restore(snapshotId, spec) {
      const sandbox = await Sandbox.create(snapshotId, options(spec))
      restoredFrom.add(snapshotId)
      return wrap(sandbox, spec, async () => {
        restoredFrom.delete(snapshotId)
        await remove(snapshotId)
      })
    },
    async deleteSnapshot(snapshotId) {
      if (!restoredFrom.has(snapshotId)) await remove(snapshotId)
    },
  }
}
