/**
 * A process started with `FACTORY_WORKER_ONLY=1` only runs jobs. The framework's worker runs one job at a
 * time, so more runs at once means more processes, and the crons (the watcher of the default branch, the
 * supervisor, the poller of answers, the catch-up) must run in exactly one of them.
 */
export const isWorkerOnly = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.FACTORY_WORKER_ONLY === '1'

/**
 * A cron handler that runs only in the main process. The check lives here, tested once, instead of as a
 * branch in each handler, where it would raise the complexity of code the tests do not reach.
 */
export const mainProcessOnly =
  <T>(handler: () => Promise<T>, env: NodeJS.ProcessEnv = process.env) =>
  async (): Promise<T | undefined> =>
    isWorkerOnly(env) ? undefined : handler()
