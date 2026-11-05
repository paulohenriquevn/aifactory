import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import type { ChatMessageView } from '../../shared/panel'

import { ActionRefused } from './actions'
import { createChat, deleteChat, getChat, listChats, saveMessages, updateChat } from './chats'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query('truncate table chat_message, chat restart identity cascade')
})
afterAll(() => getStorageManager().dispose())

const talk = (...lines: [ChatMessageView['role'], string][]): ChatMessageView[] =>
  lines.map(([role, text], i) => ({ id: `m${i}`, role, parts: [{ type: 'text', text }] }))

describe('conversations', () => {
  it('starts empty, with the model the owner chose, and no title yet', async () => {
    const made = await createChat(getDb())
    expect(made).toMatchObject({ title: '', pinned: false, model: 'openrouter' })
    expect(made.id).toMatch(/^[0-9a-f-]{36}$/)
    expect((await createChat(getDb(), 'codex')).model).toBe('codex')
    await expect(createChat(getDb(), 'gpt' as never)).rejects.toThrow(ActionRefused)
    expect(await getChat(getDb(), made.id)).toEqual({ chat: made, messages: [] })
  })

  it('keeps the messages in order, with the parts the page renders, and names the chat from the first one', async () => {
    const { id } = await createChat(getDb())
    const messages: ChatMessageView[] = [
      ...talk(['user', 'Quais tarefas estão travadas?']),
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-list_tasks',
            state: 'output-available',
            input: { stage: 'failed' },
            output: [1, 2],
          },
          { type: 'text', text: 'São duas.' },
        ],
      },
    ]

    const saved = await saveMessages(getDb(), id, messages)

    expect(saved.title).toBe('Quais tarefas estão travadas?')
    const read = await getChat(getDb(), id)
    expect(read?.messages).toEqual(messages)
  })

  it('replaces what was kept, and leaves a title the owner chose alone', async () => {
    const { id } = await createChat(getDb())
    await saveMessages(getDb(), id, talk(['user', 'primeira']))
    await updateChat(getDb(), id, { title: '  Meu   título  ' })

    await saveMessages(
      getDb(),
      id,
      talk(['user', 'primeira'], ['assistant', 'resposta'], ['user', 'segunda']),
    )

    const read = await getChat(getDb(), id)
    expect(read?.messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2'])
    expect(read?.chat.title).toBe('Meu título')
  })

  it('can empty a conversation, and refuses one that does not exist or is too long', async () => {
    const { id } = await createChat(getDb())
    await saveMessages(getDb(), id, talk(['user', 'oi']))
    await saveMessages(getDb(), id, [])
    expect((await getChat(getDb(), id))?.messages).toEqual([])

    await expect(
      saveMessages(getDb(), '00000000-0000-4000-8000-000000000000', talk(['user', 'x'])),
    ).rejects.toThrow('no such conversation')
    await expect(
      saveMessages(
        getDb(),
        id,
        Array.from(
          { length: 401 },
          (_, i) => talk(['user', 'x'])[0] && { ...talk(['user', 'x'])[0], id: `m${i}` },
        ),
      ),
    ).rejects.toThrow('at most 400')
    await expect(
      saveMessages(getDb(), id, [
        { id: 'big', role: 'user', parts: [{ type: 'text', text: 'x'.repeat(4_100_000) }] },
      ]),
    ).rejects.toThrow('too long')
  })

  it('pins, renames and changes the model, and refuses what it cannot take', async () => {
    const { id } = await createChat(getDb())
    const updated = await updateChat(getDb(), id, { pinned: true, model: 'codex', title: 'Fixa' })
    expect(updated).toMatchObject({ pinned: true, model: 'codex', title: 'Fixa' })
    expect(await updateChat(getDb(), id, {})).toMatchObject({ pinned: true, model: 'codex' })
    await expect(updateChat(getDb(), id, { model: 'x' as never })).rejects.toThrow('unknown model')
    await expect(updateChat(getDb(), id, { title: 'x'.repeat(121) })).rejects.toThrow('at most 120')
    await expect(
      updateChat(getDb(), '00000000-0000-4000-8000-000000000000', { pinned: true }),
    ).rejects.toThrow('no such conversation')
  })

  it('lists the one touched last first, and deletes one with its messages', async () => {
    const older = await createChat(getDb())
    const newer = await createChat(getDb())
    await saveMessages(getDb(), older.id, talk(['user', 'mexi nela agora']))

    expect((await listChats(getDb())).map((c) => c.id)).toEqual([older.id, newer.id])

    expect(await deleteChat(getDb(), older.id)).toBe(true)
    expect(await deleteChat(getDb(), older.id)).toBe(false)
    expect(await getChat(getDb(), older.id)).toBeUndefined()
    const { rows } = await getPool().query('select count(*)::int as n from chat_message')
    expect(rows[0].n).toBe(0)
  })
})
