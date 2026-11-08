import { AgentStreaming, ChatMessage, ChatThread } from '@theokit/ui'
import { Check, Search, X } from 'lucide-react'
import { Fragment, type ComponentType } from 'react'

import type { ChatMessageView } from '../../../shared/panel'
import { activityOf, withoutTools } from '../../lib/activity'
import { toRenderable } from '../../lib/renderable'

function Line({
  icon: Icon,
  label,
  items,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  items: string[]
}) {
  if (items.length === 0) return null
  return (
    <p className="mb-1 flex items-center gap-1.5 px-1 text-xs text-foreground/50">
      <Icon className="size-3.5 shrink-0" />
      {label}: {items.join(', ')}
    </p>
  )
}

/**
 * A conversation as the owner reads it. A call to a tool is not drawn as a card with its name and its raw
 * data: it becomes a quiet line saying what was looked at or done, and the answer comes after it.
 */
export function Messages({
  messages,
  running,
  model,
}: {
  messages: ChatMessageView[]
  running: boolean
  model: string
}) {
  return (
    <ChatThread>
      {messages.map((m) => {
        const said = withoutTools(m)
        const { looked, did, refused } = activityOf(m)
        return (
          <Fragment key={m.id}>
            <Line icon={Search} label="Consultou" items={looked} />
            <Line icon={Check} label="Fez" items={did} />
            <Line icon={X} label="Você recusou" items={refused} />
            {said.parts.length > 0 ? <ChatMessage message={toRenderable(said as never)} /> : null}
          </Fragment>
        )
      })}
      {running ? <AgentStreaming model={model} /> : null}
    </ChatThread>
  )
}
