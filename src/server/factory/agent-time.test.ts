import { describe, expect, it } from 'vitest'

import { agentTimeLeft, MIN_AGENT_MS, NoTimeForAgent } from './agent-time'

const MIN = 60_000
const timeouts = { sandboxMs: 90 * MIN, agentMs: 45 * MIN, checkMs: 10 * MIN, reviewMs: 10 * MIN }

describe('agentTimeLeft', () => {
  it('gives a pass started early the whole agent limit', () => {
    expect(agentTimeLeft(timeouts, 2 * MIN)).toBe(45 * MIN)
  })

  it('cuts a late pass so the checks and the review still fit in the sandbox', () => {
    // 60 minutes gone, 20 kept for one more round of checks and review: 10 left for the agent.
    expect(agentTimeLeft(timeouts, 60 * MIN)).toBe(10 * MIN)
  })

  it('keeps ten minutes each for the checks and the review when the deps do not say', () => {
    const { sandboxMs, agentMs } = timeouts
    expect(agentTimeLeft({ sandboxMs, agentMs }, 60 * MIN)).toBe(10 * MIN)
  })

  it('refuses a pass that would have less than the minimum, naming the time spent', () => {
    expect(() => agentTimeLeft(timeouts, 70 * MIN - MIN_AGENT_MS + 1)).toThrow(NoTimeForAgent)
    expect(() => agentTimeLeft(timeouts, 68 * MIN)).toThrow(/68 of the sandbox's 90 minutes/)
  })

  it('still allows a pass with exactly the minimum', () => {
    expect(agentTimeLeft(timeouts, 70 * MIN - MIN_AGENT_MS)).toBe(MIN_AGENT_MS)
  })
})
