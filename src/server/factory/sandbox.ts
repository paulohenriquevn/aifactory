import type { SandboxBackend } from '@theokit/agents/sandbox'

/** A destination the sandbox may reach, optionally with headers the firewall attaches to it. */
export type EgressRule = {
  domain: string
  /** Attached outside the sandbox, so code running in it never sees the values. */
  headers?: Record<string, string>
}

export type SandboxSpec = {
  /** The only destinations the sandbox can reach. */
  egress: EgressRule[]
  timeoutMs: number
  /**
   * What to keep between the sandboxes of one repository (the repository's name): a package manager's
   * downloads, so the next sandbox does not fetch them again. A provider that cannot keeps nothing.
   */
  cacheKey?: string
}

export type ExecuteResult = Awaited<ReturnType<SandboxBackend['execute']>>

export type StreamingOptions = { timeoutMs?: number; onStdoutLine: (line: string) => void }

/**
 * A backend that can also hand over a command's output line by line while it runs. `SandboxBackend`
 * only returns it at the end (usetheokit/theokit-sdk#883), so a provider that can adds this, and a
 * caller asks `streams` before using it.
 */
export type StreamingBackend = SandboxBackend & {
  executeStreaming(command: string, opts: StreamingOptions): Promise<ExecuteResult>
}

export const streams = (backend: SandboxBackend): backend is StreamingBackend =>
  typeof (backend as Partial<StreamingBackend>).executeStreaming === 'function'

/**
 * A running sandbox: the TheoKit `SandboxBackend` the agent tools and the factory talk to, plus the
 * way to stop it. `SandboxBackend` has no lifecycle and no network policy, so both live here.
 */
export type IsolatedSandbox = {
  backend: SandboxBackend
  stop(): Promise<void>
  /**
   * Saves the disk and stops the sandbox, and returns what `restore` needs. The sandbox is gone
   * afterwards. A provider that cannot do this leaves it out, and a task that asks a question
   * then fails instead of waiting.
   */
  snapshot?(): Promise<string>
  /**
   * Replaces the egress rules while the sandbox runs, so a credential the firewall attaches can be renewed
   * before it expires. The new rules pass the same isolation check as the first ones. A provider that
   * cannot leaves it out, and its runs end before the credentials they started with.
   */
  updateEgress?(egress: EgressRule[]): Promise<void>
}

export interface IsolatedSandboxProvider {
  readonly name: string
  create(spec: SandboxSpec): Promise<IsolatedSandbox>
  /** A new sandbox with the disk of a snapshot, under the same network rules as any other. */
  restore?(snapshotId: string, spec: SandboxSpec): Promise<IsolatedSandbox>
  /** Frees a snapshot, which costs storage until it is deleted or expires. */
  deleteSnapshot?(snapshotId: string): Promise<void>
  /** The snapshots that still exist, so the supervisor can find ones nothing needs. */
  listSnapshots?(): Promise<{ id: string; createdAt: Date; sizeBytes: number }[]>
}

/** Thrown when a run is asked for without the isolation the factory requires. */
export class IsolationRefused extends Error {
  constructor(reason: string) {
    super(`refusing to run without isolation: ${reason}`)
    this.name = 'IsolationRefused'
  }
}

/** Digits and dots look like valid labels, so an address has to be refused on its own. */
const IP_LITERAL = /^[0-9.]+$/

const DOMAIN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

/**
 * The factory runs an agent only inside a sandbox whose egress is an explicit list of domains.
 * An empty list, a catch-all, or anything that is not a domain is refused: a catch-all lets
 * traffic without a detectable domain through, and an empty list would mean no policy at all.
 */
export function assertIsolated(spec: SandboxSpec): void {
  if (spec.egress.length === 0) {
    throw new IsolationRefused('the egress allowlist is empty')
  }
  if (!(spec.timeoutMs > 0)) {
    throw new IsolationRefused('the sandbox has no timeout')
  }
  for (const { domain } of spec.egress) {
    if (domain === '*' || IP_LITERAL.test(domain) || !DOMAIN.test(domain)) {
      throw new IsolationRefused(`${JSON.stringify(domain)} is not an allowed destination`)
    }
  }
}

/** Creates a sandbox, after checking the spec. Every run goes through here. */
export async function createIsolatedSandbox(
  provider: IsolatedSandboxProvider,
  spec: SandboxSpec,
): Promise<IsolatedSandbox> {
  assertIsolated(spec)
  return provider.create(spec)
}

/** Restores a sandbox from a snapshot, after the same check as a new one. */
export async function restoreIsolatedSandbox(
  provider: IsolatedSandboxProvider,
  snapshotId: string,
  spec: SandboxSpec,
): Promise<IsolatedSandbox> {
  assertIsolated(spec)
  if (!provider.restore) {
    throw new IsolationRefused(`${provider.name} cannot restore a snapshot`)
  }
  return provider.restore(snapshotId, spec)
}
