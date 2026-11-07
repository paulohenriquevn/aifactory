import { serialized, syncKnowledge, type KnowledgeDeps } from './sync'

type Log = (line: string) => void

const describeState = (state: NonNullable<Awaited<ReturnType<typeof syncKnowledge>>>) => ({
  event: 'knowledge_sync',
  repository: state.repository,
  knowledgeSha: state.knowledgeSha,
  memorySha: state.memorySha ?? null,
  okfProblems: state.okf?.problems.length ?? 0,
})

let running = false

/**
 * One pass of the `knowledge-sync` cron, with what it did on one log line. A factory that cannot build its
 * dependencies says so and waits for the next minute; a pass that failed already saved why in the sync
 * state, which the setup page shows, and is logged here.
 */
export async function knowledgePass(
  makeDeps: () => KnowledgeDeps,
  log: { info: Log; error: Log } = { info: console.log, error: console.error },
): Promise<void> {
  // A pass slower than a minute is not joined by the next one: that one is skipped, so they never pile up.
  if (running) {
    log.info(
      JSON.stringify({ event: 'knowledge_sync_skipped', reason: 'the last pass is still running' }),
    )
    return
  }
  running = true
  try {
    await onePass(makeDeps, log)
  } finally {
    running = false
  }
}

async function onePass(makeDeps: () => KnowledgeDeps, log: { info: Log; error: Log }) {
  let deps: KnowledgeDeps
  try {
    deps = makeDeps()
  } catch (error) {
    log.error(JSON.stringify({ event: 'knowledge_sync_not_configured', error: String(error) }))
    return
  }
  try {
    const state = await serialized(() => syncKnowledge(deps))
    if (state) log.info(JSON.stringify(describeState(state)))
  } catch (error) {
    log.error(JSON.stringify({ event: 'knowledge_sync_failed', error: String(error) }))
  }
}
