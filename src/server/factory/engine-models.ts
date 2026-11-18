import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { AgentRole, EngineModels, ModelOption } from '../../shared/panel'

import { defaultCodexHome } from './harness-codex'

/** What a coding agent is told besides the prompt: which model, and how hard to think. Both are optional. */
export type HarnessOptions = { model?: string; effort?: string }

/**
 * A model or an effort goes into a command line, so only a plain name is let through: letters, digits, dots,
 * dashes and underscores. The lists below are what the owner can pick; this is the last line of defence.
 */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/
export const isSafeName = (value: string) => SAFE.test(value)
export function assertSafeName(value: string, what: string): string {
  if (!isSafeName(value)) throw new Error(`${what} "${value}" is not a plain name`)
  return value
}

/** The aliases the Claude Code CLI documents for `--model`, and the levels it takes for `--effort`. */
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CLAUDE_MODELS: ModelOption[] = ['sonnet', 'opus', 'fable'].map((id) => ({
  id,
  label: id[0].toUpperCase() + id.slice(1),
  note: 'Apelido do Claude Code: sempre o modelo mais recente desta família.',
  efforts: CLAUDE_EFFORTS,
}))

type CacheEntry = {
  slug?: string
  display_name?: string
  description?: string
  visibility?: string
  supported_reasoning_levels?: { effort?: string }[]
}

/**
 * The models Codex lists for this login, read from the cache the CLI keeps. A model it hides is not offered.
 * Where the file is not there the list is empty and the agent uses its own default, which always works.
 */
export function codexModels(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): ModelOption[] {
  const homes = [env.FACTORY_CODEX_HOME || defaultCodexHome(), join(homedir(), '.codex')]
  for (const home of homes) {
    try {
      const parsed = JSON.parse(read(join(home, 'models_cache.json'))) as { models?: CacheEntry[] }
      const models = (parsed.models ?? [])
        .filter((m) => m.visibility === 'list' && m.slug && isSafeName(m.slug))
        .map((m) => ({
          id: m.slug as string,
          label: m.display_name ?? (m.slug as string),
          note: m.description ?? '',
          efforts: (m.supported_reasoning_levels ?? []).flatMap((l) =>
            l.effort && isSafeName(l.effort) ? [l.effort] : [],
          ),
        }))
      if (models.length > 0) return models
    } catch {
      // No cache here: try the next home, then give up on a list.
    }
  }
  return []
}

/** The models and the effort levels of each agent the factory can run. */
export function engineModels(
  env: NodeJS.ProcessEnv = process.env,
  read?: (path: string) => string,
): Record<string, EngineModels> {
  const codex = codexModels(env, read)
  return {
    'claude-code': { models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS },
    codex: { models: codex, efforts: byEffort([...new Set(codex.flatMap((m) => m.efforts))]) },
  }
}

/** The names of the settings that carry a role's model and effort, which an environment can also set. */
export const MODEL_ENV: Record<AgentRole, string> = {
  builder: 'FACTORY_MODEL_BUILDER',
  planner: 'FACTORY_MODEL_PLANNER',
  reviewer: 'FACTORY_MODEL_REVIEWER',
  security: 'FACTORY_MODEL_SECURITY',
}
export const EFFORT_ENV: Record<AgentRole, string> = {
  builder: 'FACTORY_EFFORT_BUILDER',
  planner: 'FACTORY_EFFORT_PLANNER',
  reviewer: 'FACTORY_EFFORT_REVIEWER',
  // Never read for the security agent: its effort is pinned (`pinnedEffort`). It is here so a stored value has a name.
  security: 'FACTORY_EFFORT_SECURITY',
}

/**
 * A model or effort is kept with the agent it was chosen for ("codex:gpt-6.1-sol"), so a choice made for one
 * agent is never handed to the other when the agent changes, or when an issue's label names the other.
 */
export const tagged = (engine: string, value: string) => `${engine}:${value}`

export function untag(value: string | undefined, engine: string): string | undefined {
  if (!value) return undefined
  const at = value.indexOf(':')
  return at > 0 && value.slice(0, at) === engine && value.length > at + 1
    ? value.slice(at + 1)
    : undefined
}

/** The role whose effort nobody chooses: it always runs at the highest level its agent offers (#241). */
export const PINNED_ROLE = 'security' satisfies AgentRole

/** Thrown when the security agent's effort cannot be pinned, because its agent lists no effort level. */
export class NoPinnedEffort extends Error {}

/**
 * The effort levels the agents use, from the lowest to the highest. A level not here sorts below all of them,
 * so a name nobody knows is never taken for the highest while a known one is offered.
 */
const EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const rank = (level: string) => EFFORT_LADDER.indexOf(level)

/** The levels from the lowest to the highest; levels of the same rank keep their order. */
export const byEffort = (levels: string[]) => [...levels].sort((a, b) => rank(a) - rank(b))

/**
 * The highest effort an agent offers, for the model when it lists its own levels, else among every level the
 * agent offers. The levels are put in order first: the agent's own list is gathered from several models, and
 * an order the agent happens to print is not taken on trust. Undefined when nothing is listed.
 */
export function highestEffort(
  offered: EngineModels | undefined,
  model?: string,
): string | undefined {
  const levels = offered?.models.find((m) => m.id === model)?.efforts ?? offered?.efforts ?? []
  return byEffort(levels).at(-1)
}

/**
 * The effort the security agent runs at with this agent and model: the highest one offered, whatever is
 * stored or set in the environment. Throws `NoPinnedEffort` when the agent lists none, so it never runs at a
 * default that may be lower.
 */
export function pinnedEffort(
  catalog: Record<string, EngineModels>,
  engine: string,
  model?: string,
): string {
  const effort = highestEffort(catalog[engine], model)
  if (!effort || !isSafeName(effort)) {
    throw new NoPinnedEffort(
      `the security agent runs only at the highest effort of its agent, and ${engine} lists no effort level`,
    )
  }
  return effort
}

/**
 * What a role tells the agent it ends up running. The planner, the reviewer and the security agent use the
 * builder's model and effort until given their own, as they use its agent, but only when it is the same agent.
 * The security agent's effort is never chosen: it is the highest its agent offers (`pinnedEffort`).
 */
export function optionsFor(
  env: NodeJS.ProcessEnv,
  role: AgentRole,
  engine: string,
  read?: (path: string) => string,
): HarnessOptions {
  const pick = (names: Record<AgentRole, string>) =>
    untag(env[names[role]], engine) ??
    (role === 'builder' ? undefined : untag(env[names.builder], engine))
  const model = pick(MODEL_ENV)
  const safeModel = model && isSafeName(model) ? model : undefined
  const effort =
    role === PINNED_ROLE
      ? pinnedEffort(engineModels(env, read), engine, safeModel)
      : pick(EFFORT_ENV)
  return {
    ...(safeModel ? { model: safeModel } : {}),
    ...(effort && isSafeName(effort) ? { effort } : {}),
  }
}
