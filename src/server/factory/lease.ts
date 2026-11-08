/** How long the worker leases a job for, and how often a live run renews that lease. */
export const LOCK_SECONDS = 120
export const HEARTBEAT_MS = 40_000

/**
 * Runs `work` and renews the job's lease every `everyMs` while it runs. A run lasts up to half an
 * hour and the lease two minutes, so without this another worker would take the job. When a renewal
 * fails the lease is gone (another worker holds the job, and the job's `signal` aborts the run), so
 * the renewals stop; the error is not thrown here, because `work` decides what to do about it.
 */
export async function withLeaseHeartbeat<T>(
  extendLease: (seconds: number) => Promise<void>,
  work: () => Promise<T>,
  { everyMs = HEARTBEAT_MS, seconds = LOCK_SECONDS } = {},
): Promise<T> {
  const timer = setInterval(() => {
    extendLease(seconds).catch(() => clearInterval(timer))
  }, everyMs)
  try {
    return await work()
  } finally {
    clearInterval(timer)
  }
}
