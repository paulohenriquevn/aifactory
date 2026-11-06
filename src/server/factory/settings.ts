import { eq, inArray } from 'drizzle-orm'

import type { AgentRole, AgentSettings, EngineOption } from '../../shared/panel'
import type { Database } from '../db'
import { repository, setting } from '../db/schema'

import { DEFAULT_HARNESS, harnessRegistry } from './harness-registry'

/** The environment variable each role has always been read from, which is also what a setting overrides. */
export const ROLE_ENV: Record<AgentRole, string> = {
  builder: 'FACTORY_HARNESS',
  planner: 'FACTORY_PLANNER',
  reviewer: 'FACTORY_REVIEWER',
}

const ROLES = Object.keys(ROLE_ENV) as AgentRole[]
const KEY = (role: AgentRole) => `agent.${role}`

export type Chosen = Record<AgentRole, string | null>

/** What the owner chose in the panel, a null for each role they did not. */
export async function loadChosen(db: Database): Promise<Chosen> {
  const rows = await db
    .select()
    .from(setting)
    .where(inArray(setting.key, ROLES.map(KEY)))
  const chosen = Object.fromEntries(ROLES.map((role) => [role, null])) as Chosen
  for (const row of rows) {
    const role = ROLES.find((r) => KEY(r) === row.key)
    if (role) chosen[role] = row.value
  }
  return chosen
}

/**
 * The environment a run reads, with what the owner chose in the panel laid over it. Everything that reads
 * `FACTORY_HARNESS`, `FACTORY_PLANNER` or `FACTORY_REVIEWER` through an `env` argument then sees the choice,
 * and nothing else has to know where it came from.
 */
export async function effectiveEnv(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const chosen = await loadChosen(db)
  const overlay: NodeJS.ProcessEnv = {}
  for (const role of ROLES) if (chosen[role]) overlay[ROLE_ENV[role]] = chosen[role]
  return { ...env, ...overlay }
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
  return Object.entries(harnessRegistry(env)).map(([id, build]) => {
    try {
      build()
      return { id, ready: true }
    } catch (error) {
      return { id, ready: false, problem: error instanceof Error ? error.message : String(error) }
    }
  })
}

export class SettingRefused extends Error {}

export type AgentSettingsPatch = Partial<Record<AgentRole, string | null>>

/**
 * Saves the choice of agent for one or more roles; a null goes back to what the environment says. An agent
 * the factory does not know, or one that could not start because its credential is missing, is refused: a
 * choice that breaks every run is worse than no choice.
 */
export async function saveChosen(
  db: Database,
  patch: AgentSettingsPatch,
  env: NodeJS.ProcessEnv = process.env,
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
  for (const role of ROLES) {
    const value = patch[role]
    if (value === undefined) continue
    if (value === null) await db.delete(setting).where(eq(setting.key, KEY(role)))
    else {
      await db
        .insert(setting)
        .values({ key: KEY(role), value })
        .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } })
    }
  }
  return loadChosen(db)
}

/** What the page needs to show and change the choice. */
export async function agentSettings(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentSettings> {
  const chosen = await loadChosen(db)
  const effective = effectiveOf(await effectiveEnv(db, env))
  const own = await db.select().from(repository).where(eq(repository.enabled, true))
  return {
    options: engineOptions(env),
    chosen,
    effective,
    repositoriesWithOwn: own
      .filter((r) => r.harness || r.reviewer)
      .map((r) => ({ repository: r.fullName, builder: r.harness, reviewer: r.reviewer })),
  }
}
