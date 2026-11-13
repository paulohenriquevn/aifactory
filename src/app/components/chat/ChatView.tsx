import { ScrollArea } from '@usetheo/ui'
import { MessageSquare } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useAgent } from 'theokit/client'

import type { ChatMessageView, ChatModel } from '../../../shared/panel'
import { AGENT_PATH, chatApi, displayed, promptWith, SUGGESTIONS } from '../../lib/chat'
import { useChatgptConnection } from '../../lib/chatgpt-connection'
import { useChats } from '../../lib/chats'

import { ChatgptConnect } from './ChatgptConnect'
import { ModelPicker } from './ModelPicker'
import { Messages } from './Messages'
import { Pending } from './Pending'
import { PillComposer } from './PillComposer'

/**
 * A conversation with the factory's assistant, or the empty one that starts a new. What was said before
 * comes from the database; what is said now streams from the agent. After every answer the whole thing is
 * kept, and a new conversation is created at that moment and gets its own address.
 */
export function ChatView({ chatId }: { chatId?: string }) {
  const navigate = useNavigate()
  const { reload } = useChats()
  const [model, setModel] = useState<ChatModel>('openrouter')
  const [restored, setRestored] = useState<ChatMessageView[]>([])
  const [loading, setLoading] = useState(chatId !== undefined)
  const [loadError, setLoadError] = useState<string>()
  const [value, setValue] = useState('')
  const { needsConnection, recheck: checkConnection } = useChatgptConnection(model)

  const agent = useAgent<{ message: string }>(AGENT_PATH[model], {
    headers: { 'x-theo-action': '1' },
  })

  const messages = useMemo<ChatMessageView[]>(
    () =>
      [
        ...restored,
        ...agent.thread.map((m) => ({
          id: m.id,
          role: m.role,
          parts: m.parts as Record<string, unknown>[],
        })),
      ].map(displayed),
    [restored, agent.thread],
  )
  const latest = useRef(messages)
  latest.current = messages

  useEffect(() => {
    if (!chatId) return
    let alive = true
    chatApi
      .load(chatId)
      .then((detail) => {
        if (!alive) return
        setRestored(detail.messages)
        setModel(detail.chat.model)
      })
      .catch(() => alive && setLoadError('Não encontrei essa conversa.'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [chatId])

  /** Keeps the conversation: creates it the first time, and sends the owner to its address. */
  const keep = useCallback(async () => {
    let target = chatId
    if (!target) target = (await chatApi.create(model)).id
    await chatApi.save(target, latest.current)
    reload()
    if (!chatId) void navigate(`/chat/${target}`, { replace: true })
  }, [chatId, model, navigate, reload])

  const before = useRef(agent.status)
  useEffect(() => {
    const was = before.current
    before.current = agent.status
    if (
      was === 'streaming' &&
      (agent.status === 'done' || agent.status === 'error') &&
      latest.current.length > 0
    ) {
      void keep()
    }
  }, [agent.status, keep])

  function send(text: string) {
    const trimmed = text.trim()
    if (trimmed === '' || agent.status === 'streaming') return
    agent.send({ message: promptWith(latest.current, trimmed) })
    setValue('')
  }

  /** A new model starts a new live stream, so what was said so far is folded into the kept part first. */
  function changeModel(next: ChatModel) {
    if (next === model) return
    setRestored(latest.current)
    setModel(next)
    if (chatId) void chatApi.patch(chatId, { model: next })
  }

  const empty = messages.length === 0
  const running = agent.status === 'streaming'

  const composer = (
    <div className="w-full">
      <Pending conversation={agent} />
      {needsConnection ? <ChatgptConnect onConnected={checkConnection} /> : null}
      <PillComposer
        value={value}
        onValueChange={setValue}
        onSubmit={send}
        running={running}
        onStop={() => agent.abort()}
        placeholder="Pergunte à fábrica"
        trailing={<ModelPicker model={model} onChange={changeModel} />}
      />
    </div>
  )

  if (loading) return <p className="p-6 text-sm text-foreground/60">Carregando…</p>
  if (loadError) {
    return (
      <p role="alert" className="p-6 text-sm text-destructive">
        {loadError}
      </p>
    )
  }

  if (empty) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 pb-24">
        <h1 className="mb-8 text-[26px] font-normal tracking-tight">Pronto quando você quiser.</h1>
        <div className="w-full max-w-[770px]">{composer}</div>
        <ul className="mt-6 w-full max-w-[770px] space-y-1">
          {SUGGESTIONS.map((text) => (
            <li key={text}>
              <button
                type="button"
                onClick={() => send(text)}
                className="flex w-full items-center gap-3 rounded-xl px-4 py-2 text-left text-[15px] text-foreground/55 transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <MessageSquare className="size-[18px] shrink-0" />
                {text}
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6">
          <Messages
            messages={messages}
            running={running}
            model={model === 'codex' ? 'ChatGPT' : 'OpenRouter'}
          />
        </div>
      </ScrollArea>
      <div className="mx-auto w-full max-w-3xl px-6 pb-5">{composer}</div>
    </div>
  )
}
