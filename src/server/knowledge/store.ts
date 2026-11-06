import { and, asc, count, eq, inArray, isNotNull, isNull } from 'drizzle-orm'

import type { Database } from '../db'
import { knowledgeDelivery, knowledgeNote, setting } from '../db/schema'

import { noteHash, type Note, type NoteKind } from './format'

const REPOSITORY_KEY = 'knowledge.repository'
const BRANCH_KEY = 'knowledge.branch'
const STATE_KEY = 'knowledge.sync'

/** What the owner set: the repository that is the knowledge base, and the branch its rules are on. */
export type KnowledgeConfig = { repository: string; branch: string | null }

/** Where the mirror is, written by each pass of the sync and read by every agent that takes a slice. */
export type SyncState = {
  repository: string
  /** The branch the rules were read from: the one the owner set, or the default branch. */
  branch: string
  knowledgeSha?: string
  memorySha?: string
  format?: { ok: true } | { ok: false; reason: string }
  syncedAt?: string
  /** What the last pass could not do. The commits above are still the last good ones. */
  error?: string
  errorAt?: string
}

/** The commits an agent receives: what is delivered and recorded as one. */
export type Pin = { repository: string; knowledgeSha: string; memorySha?: string }

async function readSetting(db: Database, key: string): Promise<string | undefined> {
  const [row] = await db.select().from(setting).where(eq(setting.key, key))
  return row?.value
}

async function writeSetting(db: Database, key: string, value: string | null): Promise<void> {
  if (value === null) {
    await db.delete(setting).where(eq(setting.key, key))
    return
  }
  await db
    .insert(setting)
    .values({ key, value })
    .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } })
}

export async function loadKnowledgeConfig(db: Database): Promise<KnowledgeConfig | undefined> {
  const repository = await readSetting(db, REPOSITORY_KEY)
  if (!repository) return undefined
  return { repository, branch: (await readSetting(db, BRANCH_KEY)) ?? null }
}

/** Saves the choice, or clears it with null. A new repository starts with no sync state. */
export async function writeKnowledgeConfig(db: Database, config: KnowledgeConfig | null) {
  await db.transaction(async (tx) => {
    const t = tx as unknown as Database
    await writeSetting(t, REPOSITORY_KEY, config?.repository ?? null)
    await writeSetting(t, BRANCH_KEY, config?.branch ?? null)
    await writeSetting(t, STATE_KEY, null)
  })
}

export async function loadSyncState(db: Database): Promise<SyncState | undefined> {
  const raw = await readSetting(db, STATE_KEY)
  return raw ? (JSON.parse(raw) as SyncState) : undefined
}

export async function saveSyncState(db: Database, state: SyncState): Promise<void> {
  await writeSetting(db, STATE_KEY, JSON.stringify(state))
}

/** The commits to give an agent now, or nothing while no base is set, synced and in the format. */
export async function currentPin(db: Database): Promise<Pin | undefined> {
  const [config, state] = await Promise.all([loadKnowledgeConfig(db), loadSyncState(db)])
  if (!config || !state || state.repository !== config.repository) return undefined
  if (!state.knowledgeSha || !state.format?.ok) return undefined
  return {
    repository: state.repository,
    knowledgeSha: state.knowledgeSha,
    memorySha: state.memorySha,
  }
}

export type NewNote = {
  repository: string
  kind: NoteKind
  body: string
  taskId: number
  issueNumber: number
  baseSha: string | null
}

/** Keeps notes to be written. A text already kept for the project is not kept again. */
export async function recordNotes(db: Database, notes: NewNote[]): Promise<number> {
  if (notes.length === 0) return 0
  const rows = await db
    .insert(knowledgeNote)
    .values(notes.map((n) => ({ ...n, bodyHash: noteHash(n.repository, n.body) })))
    .onConflictDoNothing()
    .returning({ id: knowledgeNote.id })
  return rows.length
}

/** The notes not written yet, oldest first. */
export async function pendingNotes(db: Database, limit: number): Promise<Note[]> {
  const rows = await db
    .select()
    .from(knowledgeNote)
    .where(isNull(knowledgeNote.committedSha))
    .orderBy(asc(knowledgeNote.id))
    .limit(limit)
  return rows.map((r) => ({
    id: r.id,
    repository: r.repository,
    kind: r.kind,
    body: r.body,
    taskId: r.taskId,
    issueNumber: r.issueNumber,
    baseSha: r.baseSha,
    createdAt: r.createdAt,
  }))
}

export async function markCommitted(db: Database, ids: number[], sha: string, at: Date) {
  if (ids.length === 0) return
  await db
    .update(knowledgeNote)
    .set({ committedSha: sha, committedAt: at })
    .where(and(inArray(knowledgeNote.id, ids), isNull(knowledgeNote.committedSha)))
}

export async function noteCounts(db: Database): Promise<{ pending: number; written: number }> {
  const [[pending], [written]] = await Promise.all([
    db.select({ n: count() }).from(knowledgeNote).where(isNull(knowledgeNote.committedSha)),
    db.select({ n: count() }).from(knowledgeNote).where(isNotNull(knowledgeNote.committedSha)),
  ])
  return { pending: pending.n, written: written.n }
}

export type Recipient = { taskId?: number; planId?: number }

export async function recordDelivery(
  db: Database,
  input: { recipient: Recipient; project: string; pin: Pin; files: number },
): Promise<void> {
  await db.insert(knowledgeDelivery).values({
    taskId: input.recipient.taskId ?? null,
    planId: input.recipient.planId ?? null,
    project: input.project,
    knowledgeRepository: input.pin.repository,
    knowledgeSha: input.pin.knowledgeSha,
    memorySha: input.pin.memorySha ?? null,
    files: input.files,
  })
}
