/**
 * A process started with `FACTORY_WORKER_ONLY=1` only runs jobs. The framework's worker runs one job at a
 * time, so more runs at once means more processes, and the crons (the watcher of the default branch, the
 * supervisor, the poller of answers, the catch-up) must run in exactly one of them.
 */
export const isWorkerOnly = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.FACTORY_WORKER_ONLY === '1'
