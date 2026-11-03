import { SandboxBackend } from '@theokit/agents/sandbox'
import { Sandbox, type NetworkPolicy } from '@vercel/sandbox'

import type { IsolatedSandbox, IsolatedSandboxProvider, SandboxSpec } from './sandbox'

/** The exit code the TheoKit backends report for a command that hit its timeout. */
const TIMED_OUT = 124

/**
 * A `SandboxBackend` over a Vercel Sandbox microVM. `execute` runs the command through `sh -c`
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

/** Needs `VERCEL_OIDC_TOKEN` (`vercel env pull`) or the team, project and token variables. */
export function vercelSandboxProvider(): IsolatedSandboxProvider {
  return {
    name: 'vercel-sandbox',
    async create(spec): Promise<IsolatedSandbox> {
      const sandbox = await Sandbox.create({
        timeout: spec.timeoutMs,
        networkPolicy: networkPolicyFor(spec),
      })
      return { backend: new VercelBackend(sandbox), stop: async () => void (await sandbox.stop()) }
    },
  }
}
