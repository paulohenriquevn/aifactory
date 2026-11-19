import { UNBLOCKER_INSTRUCTIONS } from '../agents/prompts/unblocker'
import { oneShotAssistant, type AssistantSpec, type OneShot } from '../factory/assistant'
import { unblockerModel } from '../factory/models'

import type { Decision, RecordedAction } from './decide'
import type { TaskException } from './exceptions'
import { MESSAGE_MAX, unblockerDecision, unblockerGate, unblockerMessage } from './unblocker'
import { readUnblockerFacts, type UnblockerFactsDeps } from './unblocker-facts'

/**
 * The step between `decide` and `apply` for an escalation of a task: it reads what the unblocker needs, asks the
 * model and reads its answer (`unblocker.ts`). The model picks an action from a closed set and code checks it; an
 * answer that does not parse leaves the escalation as it was, with the parse error.
 */

/** A model that reads one escalation and answers one action, with what the answer cost. */
export type Unblocker = OneShot

/** The unblocker as an assistant: no tools of its own, so only the knowledge base's two read tools. */
export const UNBLOCKER_SPEC: AssistantSpec = {
  system: UNBLOCKER_INSTRUCTIONS,
  tools: {},
  asks: {},
  maxInput: MESSAGE_MAX,
}

/** The most one investigation may spend. */
const UNBLOCK_BUDGET_USD = 1

/**
 * The unblocker on a model, built by `buildAssistant` and run once per call. `FACTORY_UNBLOCKER_MODEL` changes the
 * model; unset, it is the coordinator's.
 */
export function modelUnblocker(model: string = unblockerModel()): Unblocker {
  return oneShotAssistant('unblocker', model, UNBLOCKER_SPEC, UNBLOCK_BUDGET_USD)
}

export type UnblockDeps = UnblockerFactsDeps & { unblocker?: Unblocker }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Hands an escalation to the unblocker when its gate lets it, and answers what it decided instead. A read or a
 * model call that throws leaves the escalation with a person, its reason saying what failed, and is logged.
 */
export async function unblock(
  deps: UnblockDeps,
  exception: TaskException,
  decision: Decision,
  recorded: RecordedAction[],
): Promise<Decision> {
  if (!deps.unblocker) return decision
  const gate = unblockerGate(exception, decision, recorded)
  if (gate === 'skip') return decision
  if (gate !== 'run') return gate
  try {
    const facts = await readUnblockerFacts(deps, exception, decision)
    const answer = await deps.unblocker(unblockerMessage(facts))
    return unblockerDecision(exception, decision, answer, facts)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'coordinator_unblocker_failed',
        taskId: exception.taskId,
        exception: exception.kind,
        head: exception.head,
        error: message(error),
      }),
    )
    return { ...decision, reason: `${decision.reason}; the unblocker failed: ${message(error)}` }
  }
}
