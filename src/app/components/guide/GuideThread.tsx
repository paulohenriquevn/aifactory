import { ScrollArea } from '@usetheo/ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAgent } from 'theokit/client'

import { guidePath } from '../../../shared/guides'
import type { ChatMessageView, ChatModel } from '../../../shared/panel'
import { displayed, promptWith } from '../../lib/chat'
import { useChatgptConnection } from '../../lib/chatgpt-connection'
import { useGuideState } from '../../lib/guide-state'
import {
  finishedChanges,
  startersFor,
  whereIs,
  focusOf,
  type Guide,
  type Starter,
} from '../../lib/guides'
import { announceChange } from '../../lib/live'
import { ChatgptConnect } from '../chat/ChatgptConnect'
import { ModelPicker } from '../chat/ModelPicker'
import { Messages } from '../chat/Messages'
import { Pending } from '../chat/Pending'
import { PillComposer } from '../chat/PillComposer'

function Chips({
  title,
  items,
  onPick,
}: {
  title: string
  items: Starter[]
  onPick: (s: Starter) => void
}) {
  return (
    <section aria-label={title} className="mt-5">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-foreground/45">
        {title}
      </h3>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <button
            key={item.text}
            type="button"
            onClick={() => onPick(item)}
            className="rounded-full border border-border px-3 py-1.5 text-left text-[13px] text-foreground/85 transition-colors hover:bg-muted/60"
          >
            {item.text}
          </button>
        ))}
      </div>
    </section>
  )
}

/**
 * The conversation with the guide of one page. It stays mounted while the owner goes to other pages, so
 * coming back finds what was said; it is not kept anywhere else. Every message carries where the owner is,
 * so "this task" means the one they have open.
 */
export function GuideThread({
  guide,
  active,
  pathname,
  search,
}: {
  guide: Guide
  active: boolean
  pathname: string
  search: string
}) {
  const { model: preferred, setModel: prefer } = useGuideState()
  const [model, setModel] = useState<ChatModel>(preferred)
  const [restored, setRestored] = useState<ChatMessageView[]>([])
  const agent = useAgent<{ message: string }>(guidePath(guide.id, model), {
    headers: { 'x-theo-action': '1' },
  })
  const { needsConnection, recheck } = useChatgptConnection(model)
  const [value, setValue] = useState('')
  const told = useRef(new Set<string>())

  const messages = useMemo<ChatMessageView[]>(
    () => [
      ...restored,
      ...agent.thread
        .map((m) => ({ id: m.id, role: m.role, parts: m.parts as Record<string, unknown>[] }))
        .map(displayed),
    ],
    [restored, agent.thread],
  )

  // A change made through the guide is shown on the page behind it at once, not at its next reading.
  useEffect(() => {
    const fresh = finishedChanges(messages).filter((id) => !told.current.has(id))
    for (const id of fresh) told.current.add(id)
    if (fresh.length > 0) announceChange()
  }, [messages])

  const focus = focusOf(pathname, search)
  const starters = startersFor(guide, focus)
  const running = agent.status === 'streaming'

  function send(text: string) {
    const trimmed = text.trim()
    if (trimmed === '' || running) return
    agent.send({ message: promptWith(messages, trimmed, whereIs(guide, pathname, search)) })
    setValue('')
  }

  /** A new model starts a new live stream, so what was said so far is folded into the kept part first. */
  function changeModel(next: ChatModel) {
    if (next === model) return
    setRestored(messages)
    setModel(next)
    prefer(next)
  }

  function pick(starter: Starter) {
    if (starter.fill) setValue(starter.text)
    else send(starter.text)
  }

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-5 py-5">
          {messages.length === 0 ? (
            <div>
              <p className="text-[15px] leading-relaxed text-foreground/90">{guide.about}</p>
              <p className="mt-2 text-[13px] text-foreground/55">
                Pergunte o que quiser sobre esta página. Eu só mudo algo depois do seu OK.
              </p>
              <Chips title="Entender" items={starters.understand} onPick={pick} />
              <Chips title="Fazer" items={starters.act} onPick={pick} />
            </div>
          ) : (
            <Messages messages={messages} running={running} model={guide.name} />
          )}
        </div>
      </ScrollArea>
      <div className="px-4 pb-4">
        <Pending conversation={agent} />
        {needsConnection ? <ChatgptConnect onConnected={recheck} /> : null}
        <PillComposer
          starts={[]}
          value={value}
          onValueChange={setValue}
          onSubmit={send}
          running={running}
          onStop={() => agent.abort()}
          placeholder="Pergunte ao guia"
          trailing={<ModelPicker model={model} onChange={changeModel} />}
        />
        {guide.note ? <p className="mt-2 px-3 text-xs text-foreground/50">{guide.note}</p> : null}
      </div>
    </div>
  )
}
