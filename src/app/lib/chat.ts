import type { ChatDetail, ChatMessageView, ChatModel, ChatSummary } from '../../shared/panel'

import { del, get, post, put } from './api'

/** The agents the owner can talk to, as the picker names them. */
export const MODELS: { id: ChatModel; name: string; blurb: string }[] = [
  { id: 'openrouter', name: 'OpenRouter', blurb: 'Uma chave da OpenRouter, pago por uso' },
  { id: 'codex', name: 'ChatGPT', blurb: 'A sua assinatura do ChatGPT (Codex)' },
]

export const AGENT_PATH: Record<ChatModel, string> = {
  openrouter: '/api/agents/chat',
  codex: '/api/agents/chat-codex',
}

/**
 * The agent is asked one message at a time and keeps nothing between them, so the conversation travels
 * inside the message. This is what separates it from the new message, so the page can show only the latter.
 */
export const NEW_MESSAGE = 'Nova mensagem do dono:\n'

const HISTORY_MESSAGES = 20
const HISTORY_CHARS = 1500

/** The text of a message, whatever else its parts carry. */
export function textOf(message: Pick<ChatMessageView, 'parts'>): string {
  return message.parts
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

/** What to send to the agent: the end of the conversation so far, then what the owner just wrote. */
export function promptWith(history: ChatMessageView[], text: string): string {
  const lines = history
    .filter((m) => m.role !== 'system')
    .map((m) => ({ who: m.role === 'user' ? 'dono' : 'assistente', text: textOf(m).trim() }))
    .filter((m) => m.text !== '')
    .slice(-HISTORY_MESSAGES)
    .map((m) => `[${m.who}]: ${m.text.slice(0, HISTORY_CHARS)}`)
  if (lines.length === 0) return text
  return `Conversa até aqui, a mais antiga primeiro:\n${lines.join('\n')}\n\n${NEW_MESSAGE}${text}`
}

/** A message as the owner should see it: a user message loses the history that rode along with it. */
export function displayed<M extends { role: string; parts: Record<string, unknown>[] }>(
  message: M,
): M {
  if (message.role !== 'user') return message
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== 'text' || typeof part.text !== 'string') return part
      const at = part.text.lastIndexOf(NEW_MESSAGE)
      return at === -1 ? part : { ...part, text: part.text.slice(at + NEW_MESSAGE.length) }
    }),
  }
}

/** The pinned conversations and the others, each the one touched last first. */
export function groupChats(chats: ChatSummary[], filter = '') {
  const needle = filter.trim().toLowerCase()
  const shown = chats.filter(
    (c) => needle === '' || (c.title || 'novo chat').toLowerCase().includes(needle),
  )
  return { pinned: shown.filter((c) => c.pinned), recent: shown.filter((c) => !c.pinned) }
}

export const chatApi = {
  create: (model: ChatModel) => post<ChatSummary>('/api/panel/chats', { model }),
  load: (id: string) => get<ChatDetail>(`/api/panel/chats/${id}`),
  save: (id: string, messages: ChatMessageView[]) =>
    put<ChatSummary>(`/api/panel/chats/${id}/messages`, { messages }),
  patch: (id: string, patch: { title?: string; pinned?: boolean; model?: ChatModel }) =>
    put<ChatSummary>(`/api/panel/chats/${id}`, patch),
  remove: (id: string) => del<{ removed: boolean }>(`/api/panel/chats/${id}`),
}

export type Connection = {
  connected: boolean
  login:
    | { status: 'idle' }
    | { status: 'waiting'; userCode: string; verificationUri: string }
    | { status: 'error'; message: string }
}

/** What the owner is asked to approve, in words, for the tools that change something. */
export function describeApproval(
  toolName: string | undefined,
  input: unknown,
): { title: string; request: string } {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  switch (toolName) {
    case 'retry_task':
      return {
        title: 'Repetir uma tarefa',
        request: `Começar de novo a tarefa ${String(args.id)}. A branch e o PR dela são apagados antes.`,
      }
    case 'request_changes':
      return {
        title: 'Pedir mudanças',
        request: `Devolver a tarefa ${String(args.id)} ao agente com esta nota:\n${String(args.note ?? '')}`,
      }
    case 'start_job':
      return {
        title: 'Abrir uma issue e começar',
        request: `Em ${String(args.repository)}: ${String(args.title)}\n\n${String(args.body ?? '').slice(0, 600)}`,
      }
    default:
      return { title: toolName ?? 'Ação', request: JSON.stringify(input, null, 2) ?? '' }
  }
}

/** The suggestions under an empty conversation. */
export const SUGGESTIONS = [
  'Como está a fábrica agora?',
  'O que precisa de mim?',
  'Como anda o backlog?',
]
