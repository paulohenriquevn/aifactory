import {
  provisionRepo,
  RepoProvisionError,
  shellEscapePosix,
  type ProvisionRepoOptions,
  type SandboxBackend,
} from '@theokit/agents/sandbox'

/** A clone of these repositories takes seconds; one that takes minutes has stalled. */
export const CLONE_TIMEOUT_MS = 3 * 60_000
export const CLONE_ATTEMPTS = 3

/**
 * `provisionRepo` with a timeout of its own and another try after a failed clone. The SDK's provisioner
 * runs every command with the backend's default timeout (ten minutes here, which agent commands need)
 * and never tries again, so a clone that stalls holds the sandbox for ten minutes and fails the task
 * (usetheokit/theokit-sdk#884). A failure after the clone (the branch is missing) is not retried.
 */
export async function cloneRepository(
  backend: SandboxBackend,
  options: ProvisionRepoOptions,
): Promise<{ repoDir: string }> {
  const bounded = withTimeout(backend, CLONE_TIMEOUT_MS)
  for (let attempt = 1; ; attempt++) {
    try {
      return await provisionRepo(bounded, options)
    } catch (error) {
      if (attempt === CLONE_ATTEMPTS || !failedToClone(error)) throw error
      await bounded.execute(`rm -rf -- ${shellEscapePosix(options.instanceId)}`)
    }
  }
}

function failedToClone(error: unknown): boolean {
  return error instanceof RepoProvisionError && error.message.includes('clone failed')
}

/** The same backend, with `timeoutMs` as the default for every command it runs. */
export function withTimeout(backend: SandboxBackend, timeoutMs: number): SandboxBackend {
  return new Proxy(backend, {
    get(target, property) {
      if (property === 'execute') {
        return (command: string, opts: { timeoutMs?: number } = {}) =>
          target.execute(command, { timeoutMs, ...opts })
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
