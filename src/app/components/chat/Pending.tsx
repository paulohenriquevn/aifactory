import { AgentErrorCard, ApprovalCard } from '@theokit/ui'
import { Button } from '@usetheo/ui'

import type { RepositoriesView } from '../../../shared/panel'
import { describeApproval } from '../../lib/chat'
import { useResource } from '../../lib/live'

type Pending = { approvalId: string; toolName?: string; input?: unknown }

export type Conversation = {
  status: 'idle' | 'streaming' | 'done' | 'error'
  error?: Error
  pendingApprovals: Pending[]
  approve: (approvalId: string, decision: { approved: boolean }) => Promise<unknown> | void
}

function Card({
  call,
  conversation,
  repository,
}: {
  call: Pending
  conversation: Conversation
  repository?: RepositoriesView['repositories'][number]
}) {
  const text = describeApproval(call.toolName, call.input, repository)
  return (
    <div className="mb-3">
      <ApprovalCard
        title={text.title}
        request={
          <span className="block">
            <span className="block whitespace-pre-wrap">{text.request}</span>
            <span className="mt-3 flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void conversation.approve(call.approvalId, { approved: false })}
              >
                Recusar
              </Button>
              <Button
                size="sm"
                onClick={() => void conversation.approve(call.approvalId, { approved: true })}
              >
                Aprovar
              </Button>
            </span>
          </span>
        }
      />
    </div>
  )
}

/** A change to a repository shows what it replaces, so the settings are read when the card is asked for. */
function RepositoryCard({ call, conversation }: { call: Pending; conversation: Conversation }) {
  const { data } = useResource<RepositoriesView>('/api/panel/repositories', {
    stream: false,
    everyMs: 300_000,
  })
  const name = String((call.input as { repository?: string } | undefined)?.repository ?? '')
  const current = data?.repositories.find((r) => r.fullName.toLowerCase() === name.toLowerCase())
  return <Card call={call} conversation={conversation} repository={current} />
}

/**
 * The server hides why a model call failed behind a generic message, so what the owner is told is what
 * usually causes it and where to look, not the message itself.
 */
function explain(error: Error | undefined): string {
  const message = error?.message ?? ''
  const generic = message === '' || /^an error occurred\.?$/i.test(message)
  return generic
    ? 'O modelo não respondeu. O mais comum é a chave do OpenRouter estar sem crédito ou sem permissão para este modelo. A página "Configuração" mostra o que está pronto. Tente de novo em instantes.'
    : message
}

/** What stands between the owner and the next answer: an error to read, or changes to approve. */
export function Pending({ conversation }: { conversation: Conversation }) {
  return (
    <>
      {conversation.status === 'error' ? (
        <div className="mb-3">
          <AgentErrorCard
            kind="network"
            title="Não consegui responder"
            detail={explain(conversation.error)}
          />
        </div>
      ) : null}
      {conversation.pendingApprovals.map((call) =>
        call.toolName === 'update_repository' ? (
          <RepositoryCard key={call.approvalId} call={call} conversation={conversation} />
        ) : (
          <Card key={call.approvalId} call={call} conversation={conversation} />
        ),
      )}
    </>
  )
}
