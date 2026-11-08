import { dockerSandboxProvider } from './docker-sandbox'
import type { IsolatedSandboxProvider } from './sandbox'
import { vercelSandboxProvider } from './vercel-sandbox'

/**
 * Where sandboxes run: Vercel Sandbox by default, or containers on this machine with
 * `FACTORY_SANDBOX=docker` (for when the Vercel plan has no capacity left, or to keep a run off the cloud).
 * Any other value is refused rather than ignored: running somewhere the owner did not choose is the
 * mistake that costs money or leaks work.
 */
export function sandboxProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): IsolatedSandboxProvider {
  const choice = env.FACTORY_SANDBOX?.trim() || 'vercel'
  if (choice === 'vercel') return vercelSandboxProvider()
  if (choice === 'docker') return dockerSandboxProvider({ env })
  throw new Error(`FACTORY_SANDBOX is "${choice}": use vercel or docker`)
}
