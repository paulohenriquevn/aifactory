/** The least an agent pass is worth starting with. Under it, the pass would be cut before it got anywhere. */
export const MIN_AGENT_MS = 5 * 60_000

const DEFAULT_CHECK_MS = 10 * 60_000
const DEFAULT_REVIEW_MS = 10 * 60_000

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
