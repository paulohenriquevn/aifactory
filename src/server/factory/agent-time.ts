/** The least an agent pass is worth starting with. Under it, the pass would be cut before it got anywhere. */
export const MIN_AGENT_MS = 5 * 60_000

/**
 * How long one check may take when the deps do not say. theokit-sdk's tests take 8 to 10 minutes on a busy
 * machine and were cut at 10 three times on 2026-11-11 (paulohenriquevn/aifactory#24).
 */
export const DEFAULT_CHECK_MS = 15 * 60_000
/** How long a review may take when the deps do not say. */
export const DEFAULT_REVIEW_MS = 10 * 60_000

type Limits = { sandboxMs: number; agentMs: number; checkMs?: number; reviewMs?: number }

/** A run whose sandbox has too little time left for another agent pass and the checks and review after it. */
export class NoTimeForAgent extends Error {
  constructor(elapsedMs: number, sandboxMs: number) {
    super(
      `no time left for another agent pass: ${Math.floor(elapsedMs / 60_000)} of the sandbox's ` +
        `${Math.floor(sandboxMs / 60_000)} minutes are gone, and the checks and the review need the rest`,
    )
    this.name = 'NoTimeForAgent'
  }
}

/**
 * How long the next agent pass may take, `elapsedMs` after the sandbox started: the agent limit, cut so one
 * more round of checks and review still fits before the sandbox stops. A first build that needs most of the
 * limit gets it, and a rework after a long build gets what is left instead of being stopped with the
 * sandbox, which would throw away the work.
 */
export function agentTimeLeft(limits: Limits, elapsedMs: number): number {
  const kept = (limits.checkMs ?? DEFAULT_CHECK_MS) + (limits.reviewMs ?? DEFAULT_REVIEW_MS)
  const left = Math.min(limits.agentMs, limits.sandboxMs - elapsedMs - kept)
  if (left < MIN_AGENT_MS) throw new NoTimeForAgent(elapsedMs, limits.sandboxMs)
  return left
}

/**
 * The limits cut to what the sandbox provider allows: a plan whose sandboxes live an hour (E2B's free one)
 * gets a run planned for an hour, not one stopped halfway through its checks.
 */
export function fitToSession<T extends { sandboxMs: number }>(limits: T, maxSessionMs?: number): T {
  return maxSessionMs !== undefined && maxSessionMs < limits.sandboxMs
    ? { ...limits, sandboxMs: maxSessionMs }
    : limits
}
