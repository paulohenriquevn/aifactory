import { and, eq, gt, lt, max } from 'drizzle-orm'

import type { Database } from '../db'
import { agentEvent } from '../db/schema'
import type { TranscriptEvent } from '../../shared/panel'

import { toStored, type AgentEvent } from './transcript'

export type Role = 'builder' | 'reviewer'

/** The transcript of a task could not be written. The run's own work is not what failed. */
export class TranscriptWriteError extends Error {
  constructor(taskId: number, cause: unknown) {
    super(
      `the transcript of task ${taskId} could not be written: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.name = 'TranscriptWriteError'
  }
}

/**
 * Writes what the agents of one task do, in order. A harness hands steps over from a stream callback
 * that cannot wait, so each write is chained after the one before: the order in the table is the order
 * the agent did things, and `seq` keeps counting across the runs of the task (builder, reviewer, rework).
 * The first write that fails is kept and thrown by `flush`, so a broken transcript is never silent.
 */
export class Transcript {
  private chain: Promise<void> = Promise.resolve()
  private failure: unknown

  private constructor(
    private readonly db: Database,
    private readonly taskId: number,
    private next: number,
  ) {}

  static async open(db: Database, taskId: number): Promise<Transcript> {
    const [row] = await db
      .select({ last: max(agentEvent.seq) })
      .from(agentEvent)
      .where(eq(agentEvent.taskId, taskId))
    return new Transcript(db, taskId, (row?.last ?? 0) + 1)
  }

  /** The callback for one agent run: each event it gets is stored, redacted and cut, in order. */
  sink(role: Role, attempt: number): (event: AgentEvent) => void {
    return (event) => {
      const row = { ...toStored(event), taskId: this.taskId, role, attempt, seq: this.next }
      this.next += 1
      this.chain = this.chain
        .then(async () => {
          if (this.failure === undefined) await this.db.insert(agentEvent).values(row)
        })
        .catch((error: unknown) => {
          this.failure ??= error
        })
    }
  }

  /** Waits for every write so far, without judging them: for a run that is already failing. */
  async drain(): Promise<void> {
    await this.chain
  }

  /** Waits for every write so far, and throws if one of them failed. */
  async flush(): Promise<void> {
    await this.chain
    if (this.failure !== undefined) throw new TranscriptWriteError(this.taskId, this.failure)
  }
}

export type StoredEvent = TranscriptEvent

type Row = typeof agentEvent.$inferSelect

export const toTranscriptEvent = (r: Row): TranscriptEvent => ({
  seq: r.seq,
  role: r.role,
  attempt: r.attempt,
  kind: r.kind,
  tool: r.tool,
  content: r.content,
  at: r.at.toISOString(),
})

/** The steps of a task after `afterSeq`, oldest first, at most `limit` of them. */
export async function eventsOf(
  db: Database,
  taskId: number,
  { afterSeq = 0, limit = 1_000 }: { afterSeq?: number; limit?: number } = {},
): Promise<StoredEvent[]> {
  const rows = await db
    .select()
    .from(agentEvent)
    .where(and(eq(agentEvent.taskId, taskId), gt(agentEvent.seq, afterSeq)))
    .orderBy(agentEvent.seq)
    .limit(limit)
  return rows.map(toTranscriptEvent)
}

export const TRANSCRIPT_RETENTION_DAYS = 30

/** Deletes the steps older than the retention, and says how many went. */
export async function pruneTranscripts(db: Database, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - TRANSCRIPT_RETENTION_DAYS * 86_400_000)
  const gone = await db
    .delete(agentEvent)
    .where(lt(agentEvent.at, before))
    .returning({ id: agentEvent.id })
  return gone.length
}
