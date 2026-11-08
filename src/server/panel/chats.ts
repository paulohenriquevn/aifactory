import { randomUUID } from 'node:crypto'

import { asc, desc, eq } from 'drizzle-orm'

import type { Database } from '../db'
import { chat, chatMessage } from '../db/schema'
import type { ChatDetail, ChatMessageView, ChatModel, ChatSummary } from '../../shared/panel'

import { ActionRefused } from './actions'

export const MODELS: readonly ChatModel[] = ['openrouter', 'codex']

const MAX_MESSAGES = 400
const MAX_BYTES = 4_000_000
const TITLE_MAX = 60

const iso = (date: Date) => date.toISOString()

const summary = (row: typeof chat.$inferSelect): ChatSummary => ({
  id: row.id,
  title: row.title,
  pinned: row.pinned,
  model: row.model as ChatModel,
  updatedAt: iso(row.updatedAt),
})

/** The text of a message, whatever else its parts carry. */
function textOf(message: ChatMessageView): string {
  return message.parts
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join(' ')
}

/**
 * What a conversation is called in the menu until the owner renames it: the start of what they first
 * wrote, on one line. A conversation with no user text yet has no title.
 */
export function titleFrom(messages: ChatMessageView[]): string {
  const first = messages.find((m) => m.role === 'user' && textOf(m).trim() !== '')
  if (!first) return ''
  const line = textOf(first).replace(/\s+/g, ' ').trim()
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line
}

/** The conversations, the one touched last first. The page splits pinned from recent. */
export async function listChats(db: Database): Promise<ChatSummary[]> {
  const rows = await db.select().from(chat).orderBy(desc(chat.updatedAt))
  return rows.map(summary)
}

export async function createChat(
  db: Database,
  model: ChatModel = 'openrouter',
): Promise<ChatSummary> {
  if (!MODELS.includes(model)) throw new ActionRefused(`unknown model "${model}"`)
  const [row] = await db.insert(chat).values({ id: randomUUID(), model }).returning()
  return summary(row)
}

export async function getChat(db: Database, id: string): Promise<ChatDetail | undefined> {
  const [row] = await db.select().from(chat).where(eq(chat.id, id))
  if (!row) return undefined
  const messages = await db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.chatId, id))
    .orderBy(asc(chatMessage.position))
  return {
    chat: summary(row),
    messages: messages.map((m) => ({ id: m.id, role: m.role, parts: m.parts })),
  }
}

export type ChatPatch = { title?: string; pinned?: boolean; model?: ChatModel }

export async function updateChat(db: Database, id: string, patch: ChatPatch): Promise<ChatSummary> {
  if (patch.model !== undefined && !MODELS.includes(patch.model)) {
    throw new ActionRefused(`unknown model "${patch.model}"`)
  }
  const title = patch.title === undefined ? undefined : patch.title.replace(/\s+/g, ' ').trim()
  if (title !== undefined && title.length > 120)
    throw new ActionRefused('a title has at most 120 characters')
  const values = {
    ...(title === undefined ? {} : { title }),
    ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
    ...(patch.model === undefined ? {} : { model: patch.model }),
  }
  // A patch that changes nothing is a read: the database refuses an update with no values to set.
  const [row] =
    Object.keys(values).length === 0
      ? await db.select().from(chat).where(eq(chat.id, id))
      : await db.update(chat).set(values).where(eq(chat.id, id)).returning()
  if (!row) throw new ActionRefused('there is no such conversation')
  return summary(row)
}

export async function deleteChat(db: Database, id: string): Promise<boolean> {
  const removed = await db.delete(chat).where(eq(chat.id, id)).returning({ id: chat.id })
  return removed.length > 0
}

/**
 * Replaces what is kept of a conversation with what the page shows after an answer. The title is made from
 * the first thing the owner wrote, only while the conversation has none, so a rename is never undone.
 */
export async function saveMessages(
  db: Database,
  id: string,
  messages: ChatMessageView[],
): Promise<ChatSummary> {
  if (messages.length > MAX_MESSAGES)
    throw new ActionRefused(`a conversation keeps at most ${MAX_MESSAGES} messages`)
  if (JSON.stringify(messages).length > MAX_BYTES)
    throw new ActionRefused('the conversation is too long to keep')
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(chat).where(eq(chat.id, id))
    if (!row) throw new ActionRefused('there is no such conversation')
    await tx.delete(chatMessage).where(eq(chatMessage.chatId, id))
    if (messages.length > 0) {
      await tx.insert(chatMessage).values(
        messages.map((m, position) => ({
          chatId: id,
          position,
          id: m.id,
          role: m.role,
          parts: m.parts,
        })),
      )
    }
    const [updated] = await tx
      .update(chat)
      .set({ title: row.title || titleFrom(messages), updatedAt: new Date() })
      .where(eq(chat.id, id))
      .returning()
    return summary(updated)
  })
}
