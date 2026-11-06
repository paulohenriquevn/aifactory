import { eq, inArray } from 'drizzle-orm'

import type { AgentRole, AgentSettings, EngineOption } from '../../shared/panel'
import type { Database } from '../db'
import { repository, setting } from '../db/schema'

import { EFFORT_ENV, engineModels, isSafeName, MODEL_ENV, tagged, untag } from './engine-models'
import { withClaudeToken } from './claude-token'
import { DEFAULT_HARNESS, harnessRegistry } from './harness-registry'

/** The environment variable each role has always been read from, which is also what a setting overrides. */
export const ROLE_ENV: Record<AgentRole, string> = {
  builder: 'FACTORY_HARNESS',
  planner: 'FACTORY_PLANNER',
  reviewer: 'FACTORY_REVIEWER',
}

const ROLES = Object.keys(ROLE_ENV) as AgentRole[]
const ENGINE_KEY = (role: AgentRole) => `agent.${role}`
const MODEL_KEY = (role: AgentRole) => `agent.${role}.model`
const EFFORT_KEY = (role: AgentRole) => `agent.${role}.effort`

export type Chosen = Record<AgentRole, string | null>
type Stored = { engine: Chosen; model: Chosen; effort: Chosen }

const nobody = (): Chosen => ({ builder: null, planner: null, reviewer: null })

/** What the owner saved, the model and the effort still tagged with the agent they were chosen for. */
async function loadStored(db: Database): Promise<Stored> {
  const keys = ROLES.flatMap((role) => [ENGINE_KEY(role), MODEL_KEY(role), EFFORT_KEY(role)])
  const rows = await db.select().from(setting).where(inArray(setting.key, keys))
  const stored: Stored = { engine: nobody(), model: nobody(), effort: nobody() }
  for (const row of rows) {
    for (const role of ROLES) {
      if (row.key === ENGINE_KEY(role)) stored.engine[role] = row.value
      if (row.key === MODEL_KEY(role)) stored.model[role] = row.value
      if (row.key === EFFORT_KEY(role)) stored.effort[role] = row.value
    }
  }
  return stored
}

/** The agent the owner chose in the panel for each role, a null for each they did not. */
export async function loadChosen(db: Database): Promise<Chosen> {
  return (await loadStored(db)).engine
}

/**
 * The environment a run reads, with what the owner chose in the panel laid over it. Everything that reads
 * `FACTORY_HARNESS`, `FACTORY_PLANNER`, `FACTORY_REVIEWER` or the model and effort of a role through an `env`
 * argument then sees the choice, and nothing else has to know where it came from.
 */
export async function effectiveEnv(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const stored = await loadStored(db)
  const overlay: NodeJS.ProcessEnv = {}
  for (const role of ROLES) {
    if (stored.engine[role]) overlay[ROLE_ENV[role]] = stored.engine[role]
    if (stored.model[role]) overlay[MODEL_ENV[role]] = stored.model[role]
    if (stored.effort[role]) overlay[EFFORT_ENV[role]] = stored.effort[role]
  }
  return { ...withClaudeToken(env), ...overlay }
}

/** The role's agent as the factory resolves it: the choice, else the environment, else the default. */
export function effectiveOf(env: NodeJS.ProcessEnv): Record<AgentRole, string> {
  const builder = env.FACTORY_HARNESS || DEFAULT_HARNESS
  return {
    builder,
    planner: env.FACTORY_PLANNER || builder,
    reviewer: env.FACTORY_REVIEWER || builder,
  }
}

/** Every agent the factory can run, and for each whether it could start now: a missing credential is said. */
export function engineOptions(env: NodeJS.ProcessEnv): EngineOption[] {
  return Object.entries(harnessRegistry(withClaudeToken(env))).map(([id, build]) => {
    try {
      build()
      return { id, ready: true }
    } catch (error) {
      return { id, ready: false, problem: error instanceof Error ? error.message : String(error) }
    }
  })
}

export class SettingRefused extends Error {}

export type AgentSettingsPatch = Partial<Record<AgentRole, string | null>> & {
  /** The model for a role, from the list of the agent that role ends up using; null for the agent's default. */
  models?: Partial<Record<AgentRole, string | null>>
  /** The effort for a role, from the levels of that agent (and model); null for the agent's default. */
  efforts?: Partial<Record<AgentRole, string | null>>
}

const known = (what: 'model' | 'effort', value: string, list: string[], agent: string) => {
  if (!list.includes(value)) {
    throw new SettingRefused(
      `"${value}" is not ${what === 'effort' ? 'an' : 'a'} ${what} ${agent} offers${list.length > 0 ? ` (${list.join(', ')})` : ' (it lists none)'}`,
    )
  }
}

/**
 * Saves the choice of agent, model and effort for one or more roles; a null goes back to the default. An
 * agent the factory does not know, or one that could not start because its credential is missing, is
 * refused, and so is a model or an effort the agent chosen does not offer: a choice that breaks every run is
 * worse than no choice. Nothing is saved unless all of it is valid.
 */
export async function saveChosen(
  db: Database,
  patch: AgentSettingsPatch,
  env: NodeJS.ProcessEnv = process.env,
  read?: (path: string) => string,
): Promise<Chosen> {
  const options = engineOptions(env)
  for (const role of ROLES) {
    const value = patch[role]
    if (value === undefined || value === null) continue
    const option = options.find((o) => o.id === value)
    if (!option) {
      throw new SettingRefused(
        `"${value}" is not an agent the factory knows (known: ${options.map((o) => o.id).join(', ')})`,
      )
    }
    if (!option.ready) throw new SettingRefused(`${value} cannot start: ${option.problem}`)
  }

  // The agent each role will use once this is saved: that is the list a model and an effort come from.
  const stored = await loadStored(db)
  const overlay: NodeJS.ProcessEnv = {}
  for (const role of ROLES) {
    const engine = patch[role] === undefined ? stored.engine[role] : patch[role]
    if (engine) overlay[ROLE_ENV[role]] = engine
  }
  const after = effectiveOf({ ...env, ...overlay })
  const catalog = engineModels(env, read)

  const writes: [string, string | null][] = []
  for (const role of ROLES) {
    const engine = after[role]
    const offered = catalog[engine] ?? { models: [], efforts: [] }
    const model = patch.models?.[role]
    const effort = patch.efforts?.[role]
    if (model) {
      if (!isSafeName(model)) throw new SettingRefused(`"${model}" is not a plain model name`)
      known(
        'model',
        model,
        offered.models.map((m) => m.id),
        engine,
      )
    }
    if (effort) {
      const chosenModel = model ?? untag(stored.model[role] ?? undefined, engine)
      const levels = offered.models.find((m) => m.id === chosenModel)?.efforts ?? offered.efforts
      known('effort', effort, levels, engine)
    }
    if (patch[role] !== undefined) writes.push([ENGINE_KEY(role), patch[role] ?? null])
    if (model !== undefined) writes.push([MODEL_KEY(role), model ? tagged(engine, model) : null])
    if (effort !== undefined)
      writes.push([EFFORT_KEY(role), effort ? tagged(engine, effort) : null])
  }

  for (const [key, value] of writes) {
    if (value === null) await db.delete(setting).where(eq(setting.key, key))
    else {
      await db
        .insert(setting)
        .values({ key, value })
        .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } })
    }
  }
  return loadChosen(db)
}

/** What the page needs to show and change the choice. */
export async function agentSettings(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  read?: (path: string) => string,
): Promise<AgentSettings> {
  const stored = await loadStored(db)
  const effective = effectiveOf(await effectiveEnv(db, env))
  const own = await db.select().from(repository).where(eq(repository.enabled, true))
  const fit = (chosen: Chosen) =>
    Object.fromEntries(
      ROLES.map((role) => [role, untag(chosen[role] ?? undefined, effective[role]) ?? null]),
    ) as Chosen
  return {
    options: engineOptions(env),
    chosen: stored.engine,
    effective,
    chosenModel: fit(stored.model),
    chosenEffort: fit(stored.effort),
    engines: engineModels(env, read),
    repositoriesWithOwn: own
      .filter((r) => r.harness || r.reviewer)
      .map((r) => ({ repository: r.fullName, builder: r.harness, reviewer: r.reviewer })),
  }
}
