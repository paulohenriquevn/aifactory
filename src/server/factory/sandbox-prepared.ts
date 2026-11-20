/** The steps between a run's `sandbox` stage and its first agent, in the order they run. */
export type PrepareStep =
  | 'inputs'
  | 'branches'
  | 'credentials'
  | 'sandbox'
  | 'clone'
  | 'harness'
  | 'knowledge'
  | 'repository_facts'
  | 'install'

/**
 * How long a run spent preparing its sandbox, step by step, logged once as `sandbox_prepared`. Before it the
 * stage events said only that preparation took about half of a run, not what it was made of. A preparation
 * that failed is logged too, with the step it failed in (`failedAt`).
 */
export class Preparation {
  private readonly steps: Partial<Record<PrepareStep, number>> = {}
  private readonly startedAt: number
  private failedAt: PrepareStep | undefined
  private logged = false

  constructor(
    private readonly taskId: number,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now()
  }

  /** Runs `work` as `name`, adding its time to that step's, and records the step it failed in. */
  async step<T>(name: PrepareStep, work: () => Promise<T>): Promise<T> {
    const at = this.now()
    try {
      return await work()
    } catch (error) {
      this.failedAt ??= name
      throw error
    } finally {
      this.steps[name] = (this.steps[name] ?? 0) + (this.now() - at)
    }
  }

  /** Logs the preparation; a second call logs nothing, so a run that fails later is not logged again. */
  log(): void {
    if (this.logged) return
    this.logged = true
    console.log(
      JSON.stringify({
        event: 'sandbox_prepared',
        taskId: this.taskId,
        steps: this.steps,
        totalMs: this.now() - this.startedAt,
        ...(this.failedAt ? { failedAt: this.failedAt } : {}),
      }),
    )
  }
}
