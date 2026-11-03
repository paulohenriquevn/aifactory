/** The slice of `pg.Pool` the probe needs, so tests can pass a real pool or a stand-in. */
export interface Queryable {
  query(sql: string): Promise<unknown>
}

export type DatabaseHealth = { status: 'up'; latencyMs: number } | { status: 'down'; error: string }

/**
 * Runs `select 1` against the database. A failure or a timeout is reported as `down` with the
 * reason, so the readiness route can answer 503 instead of crashing.
 */
export async function checkDatabase(db: Queryable, timeoutMs = 2_000): Promise<DatabaseHealth> {
  const started = performance.now()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`database did not answer within ${timeoutMs} ms`)),
      timeoutMs,
    )
  })
  try {
    await Promise.race([db.query('select 1'), timeout])
    return { status: 'up', latencyMs: Math.round(performance.now() - started) }
  } catch (error) {
    return { status: 'down', error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}
