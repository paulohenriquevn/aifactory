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
    codex: { models: codex, efforts: [...new Set(codex.flatMap((m) => m.efforts))] },
  }
}

/** The names of the settings that carry a role's model and effort, which an environment can also set. */
export const MODEL_ENV: Record<AgentRole, string> = {
  builder: 'FACTORY_MODEL_BUILDER',
  planner: 'FACTORY_MODEL_PLANNER',
  reviewer: 'FACTORY_MODEL_REVIEWER',
}
export const EFFORT_ENV: Record<AgentRole, string> = {
  builder: 'FACTORY_EFFORT_BUILDER',
  planner: 'FACTORY_EFFORT_PLANNER',
  reviewer: 'FACTORY_EFFORT_REVIEWER',
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

/**
 * What a role tells the agent it ends up running. The planner and the reviewer use the builder's model and
 * effort until given their own, as they use its agent, but only when it is the same agent.
 */
export function optionsFor(
  env: NodeJS.ProcessEnv,
  role: AgentRole,
  engine: string,
): HarnessOptions {
  const pick = (names: Record<AgentRole, string>) =>
    untag(env[names[role]], engine) ??
    (role === 'builder' ? undefined : untag(env[names.builder], engine))
  const model = pick(MODEL_ENV)
  const effort = pick(EFFORT_ENV)
  return {
    ...(model && isSafeName(model) ? { model } : {}),
    ...(effort && isSafeName(effort) ? { effort } : {}),
  }
}
