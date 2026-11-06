/**
 * How long a restart waits for the run in progress before `theokit start` gives up on it
 * (`jobs.worker.shutdownTimeoutMs`, usetheokit/theokit#1292). A run's sandbox stops it after 30 minutes
 * (`DEFAULT_TIMEOUTS.sandboxMs` in run.ts), so 32 minutes lets any run finish and be recorded, and a deploy
 * never cuts an agent's work. The units' `TimeoutStopSec` is set above it; drain.test.ts keeps them in line.
 */
export const JOB_SHUTDOWN_WAIT_MS = 32 * 60_000
