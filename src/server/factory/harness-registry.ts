import { claudeCodeHarness, claudeCredentialFromEnv } from './harness-claude'
import { codexCredentialFromEnv, codexHarness } from './harness-codex'
import type { HarnessOptions } from './engine-models'
import type { CodingHarness } from './harness'

/**
 * Every agent the factory can run, by name. Each is built on demand, so a missing credential only
 * matters to a task that asks for that agent. Adding an agent is one entry here and one file.
 */
export type HarnessRegistry = Record<string, (options?: HarnessOptions) => CodingHarness>

export const DEFAULT_HARNESS = 'claude-code'

export function harnessRegistry(env: NodeJS.ProcessEnv = process.env): HarnessRegistry {
  return {
    'claude-code': (options) => claudeCodeHarness(claudeCredentialFromEnv(env), options),
    codex: (options) => codexHarness(codexCredentialFromEnv(env), {}, options),
  }
}

/**
 * The agent for an issue: the one its `harness:<name>` label names (`reviewer:<name>` for the
 * reviewer), or the default. Two such labels
 * or an unknown name are refused, because running the wrong agent silently costs real money.
 */
export function pickHarness(
  registry: HarnessRegistry,
  fallback: string,
  labels: string[],
  role: 'harness' | 'reviewer' = 'harness',
  /** What to tell the agent that ends up chosen, which depends on which one it is. */
  optionsFor: (engine: string) => HarnessOptions | undefined = () => undefined,
): CodingHarness {
  const label = new RegExp(`^${role}:(.+)$`, 'i')
  const named = [...new Set(labels.flatMap((l) => label.exec(l)?.[1].trim().toLowerCase() ?? []))]
  if (named.length > 1) {
    throw new Error(`the issue names more than one ${role}: ${named.join(', ')}`)
  }
  const name = named[0] ?? fallback
  const build = registry[name]
  if (!build) {
    throw new Error(`unknown agent "${name}" (known: ${Object.keys(registry).join(', ')})`)
  }
  return build(optionsFor(name))
}
