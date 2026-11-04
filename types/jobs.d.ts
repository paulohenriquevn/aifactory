/**
 * JobRegistry augmentation: typed `ctx.queue.enqueue`. The registry lives in `theokit/server/jobs`,
 * the module `QueueClient` comes from (usetheokit/theokit#1074).
 *
 * Each job is a file `src/server/jobs/<name>.ts` exporting `defineJob('<name>', ...)`, with its
 * input listed here.
 */
declare module 'theokit/server/jobs' {
  interface JobRegistry {
    /** Runs one task end to end: sandbox, agent, push of `factory/<issue>`. */
    'run-task': { taskId: number; decisionId?: number }
    /** Continues a task whose question was answered, from the snapshot taken when it was asked. */
    'resume-task': { taskId: number; questionId: number }
  }
}

// `ctx.queue` exists on every route because `theo.config.ts` sets `jobs.backend`.
declare module 'theokit/server/define' {
  interface RouteContext {
    queue: import('theokit/server/jobs').QueueClient
  }
}

export {}
