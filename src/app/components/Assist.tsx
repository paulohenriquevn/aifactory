import { Button, Input } from '@usetheo/ui'
import { useAgent } from 'theokit/client'
import { useState } from 'react'

import {
  agentFor,
  assistProblem,
  buildMessage,
  proposalOf,
  type AssistKind,
  type Proposal,
} from '../lib/assist'

const LABEL: Record<AssistKind, string> = {
  goal: 'Help me say it',
  job: 'Help me say it',
  issue: 'Improve this',
  changes: 'Help me say it',
  setup: 'Set this up for me',
}

/** A text box with nothing in it is only worth helping with when the assistant can look at the project. */
const NEEDS_WORDS: Record<AssistKind, boolean> = {
  goal: true,
  job: true,
  issue: true,
  changes: true,
  setup: false,
}

/**
 * The assistant under a text box. The owner says what they want in their own words, the assistant
 * writes what the factory needs, and nothing changes until the owner presses "Use this". It is the same
 * under every box, so a person who is not a programmer learns it once.
 */
export function Assist({
  kind,
  text,
  repository,
  context,
  onUse,
}: {
  kind: AssistKind
  /** What the owner has typed so far. */
  text: string
  repository?: string
  /** What the assistant should know about where the text goes (for example the pull request). */
  context?: string
  onUse: (proposal: Proposal) => void
}) {
  const agent = useAgent<{ message: string }>(agentFor(kind), {
    headers: { 'x-theo-action': '1' },
  })
  const [instruction, setInstruction] = useState('')
  const proposal = proposalOf(agent.thread)
  const working = agent.status === 'streaming'
  const problem = assistProblem(agent.error)
  const ready = !NEEDS_WORDS[kind] || text.trim().length >= 3

  const ask = (change?: string) =>
    agent.send({ message: buildMessage({ kind, repository, context, text, instruction: change }) })

  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={working || !ready}
          onClick={() => {
            agent.reset()
            ask()
          }}
        >
          {LABEL[kind]}
        </Button>
        {working ? (
          <span role="status" className="text-muted-foreground">
            Working on it…
          </span>
        ) : null}
        {!working && !proposal && !problem && NEEDS_WORDS[kind] && !ready ? (
          <span className="text-muted-foreground">Write a few words first.</span>
        ) : null}
      </div>
      {problem && !working ? (
        <p role="alert" className="text-destructive">
          {problem}
        </p>
      ) : null}
      {proposal && !working ? (
        <section
          aria-label="Suggestion"
          className="space-y-2 rounded-lg border border-border bg-muted p-3"
        >
          {proposal.title ? <p className="font-medium text-foreground">{proposal.title}</p> : null}
          <p className="whitespace-pre-wrap text-foreground">{proposal.text}</p>
          {proposal.domains && proposal.domains.length > 0 ? (
            <p className="text-muted-foreground">Extra domains: {proposal.domains.join(', ')}</p>
          ) : null}
          {proposal.notes ? <p className="text-muted-foreground">{proposal.notes}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                onUse(proposal)
                agent.reset()
                setInstruction('')
              }}
            >
              Use this
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                agent.reset()
                setInstruction('')
              }}
            >
              Dismiss
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Input
              aria-label="Ask for a change"
              value={instruction}
              placeholder="Something different? Say what, in your words"
              onChange={(e) => setInstruction(e.target.value)}
              className="flex-1"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={instruction.trim() === ''}
              onClick={() => {
                ask(instruction.trim())
                setInstruction('')
              }}
            >
              Change it
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  )
}
